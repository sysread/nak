// research_docs (function-side port)
//
// Docs-research entrypoint. The main chat model calls this to hand off
// "how do I X in Nak", "what does Y do", "is there a shortcut for Z"
// questions to a one-shot sub-completion (RESEARCH_DOCS_MODEL) whose
// system prompt carries every doc under docs/user/ concatenated with
// path delimiters. The sub-call answers from that context alone and
// hands back a short synthesis plus the doc paths it leaned on.
//
// Dev-doc mode: when args.include_internal_dev_docs is true, the sub-
// call's system prompt also carries every doc under docs/dev/ - the
// "help me plan a Nak feature" path so a meta-question can cross-
// reference user-visible behavior against internal design notes in a
// single pass. Dev docs are opt-in per call because the corpus is
// substantially larger; only meta-engineering questions need it.
//
// The corpora come from supabase/functions/venice/_generated/
// research-docs-corpus.ts, an auto-generated bundle of every .md file
// under docs/user/ and docs/dev/. The generator runs as part of
// dev-start, functions-serve, and the CI deploy step (see
// scripts/bundle-research-docs.mjs).
//
// Auth: no DB access; the tool composes a system prompt + user turn
// and runs them through toolComplete, which uses the shared Venice key
// from app_config via _venice_key.ts. The ctx.userId / threadId aren't
// involved - this tool is a pure docs lookup.

import { registerTool, type ToolContext, type ToolDef } from '../performToolCall.ts';
import { readVeniceKey } from './_venice_key.ts';
import { toolComplete } from './_venice_complete.ts';
import {
  DEV_DOCS,
  USER_DOCS,
  type BundledDoc,
} from '../_generated/research-docs-corpus.ts';

// Mirror of src/lib/models/index.ts's agentModel('researchDocs').id.
// Keep in sync with the browser model registry; the model is the same
// across paths because the prompt is identical.
const RESEARCH_DOCS_MODEL = 'deepseek-v4-flash';

const SYSTEM_PROMPT_HEADER =
  'You are a documentation assistant for Nak, a personal AI assistant ' +
  "app that runs in the user's browser. Answer the caller's question " +
  'using only the bundled user-facing docs below. Keep replies to ' +
  '2-5 sentences of plain prose. If the docs do not cover the topic, ' +
  'write a brief 1-2 sentence note naming what you looked for and ' +
  'stating that no matching content was found - never return only the ' +
  'Sources line, the prose is what tells the caller you searched and ' +
  'came up empty. Do not describe what you are doing or preamble - ' +
  'just answer. At the end, on a separate line, write "Sources: " ' +
  'followed by a comma-separated list of the doc paths (relative to ' +
  'docs/user/) you relied on; write "Sources: none" if you did not ' +
  'need any.';

const DEV_SYSTEM_PROMPT_HEADER =
  'You are a documentation assistant for Nak, a personal AI assistant ' +
  "app that runs in the user's browser. Two doc trees are bundled " +
  'below: `docs/user/` is the end-user manual (same corpus the in-app ' +
  'Help button renders), and `docs/dev/` is the internal architecture ' +
  "and per-feature engineering notes. Answer the caller's question " +
  'using only these docs. Cross-reference across the two trees when it ' +
  'helps (e.g. user-visible behavior in docs/user/ plus the internal ' +
  'design note in docs/dev/). Keep replies to 2-5 sentences of plain ' +
  'prose unless the question is about internal architecture, in which ' +
  'case longer is fine. If the docs do not cover the topic, write a ' +
  'brief 1-2 sentence note naming what you looked for across both ' +
  'trees and stating that no matching content was found - never return ' +
  'only the Sources line, the prose is what tells the caller you ' +
  'searched and came up empty. Do not preamble - just answer. At the ' +
  'end, on a separate line, write "Sources: " followed by a comma- ' +
  'separated list of paths including the tree prefix (e.g. ' +
  '`docs/user/memory.md`, `docs/dev/memory.md`) so the caller can tell ' +
  'which tree each cite came from; write "Sources: none" if you did ' +
  'not need any.';

function buildDocsBlob(includeDev: boolean): string {
  const parts: string[] = [];
  const formatTree = (root: string, docs: readonly BundledDoc[]): void => {
    for (const doc of docs) {
      parts.push(`===== ${root}${doc.path} =====\n${doc.body.trim()}`);
    }
  };
  formatTree('docs/user/', USER_DOCS);
  if (includeDev) formatTree('docs/dev/', DEV_DOCS);
  return parts.join('\n\n');
}

interface ParsedResearchResult {
  answer: string;
  sources: string[];
}

/**
 * Split the sub-model's output into the prose answer and the trailing
 * "Sources: ..." line. Tolerant of casing, missing trailer, and the
 * "none" sentinel. When the dev corpus is in scope (keepPrefixes=true)
 * the path prefix is preserved so callers can tell `docs/user/foo.md`
 * apart from `docs/dev/foo.md`; otherwise a leading `docs/user/` is
 * stripped so the caller gets the same relative form the browser-side
 * listDocs() returns.
 */
function parseResearchResult(
  raw: string,
  opts: { keepPrefixes: boolean },
): ParsedResearchResult {
  const text = raw.trim();
  if (text.length === 0) return { answer: '', sources: [] };

  const match = text.match(/(^|\n)\s*Sources:\s*(.*)\s*$/i);
  if (!match) return { answer: text, sources: [] };

  const answer = text.slice(0, match.index).trim();
  const tail = match[2].trim();
  if (tail.length === 0 || tail.toLowerCase() === 'none') {
    return { answer, sources: [] };
  }

  const sources = tail
    .split(',')
    .map((s) => s.trim())
    .map((s) =>
      opts.keepPrefixes || !s.startsWith('docs/user/')
        ? s
        : s.slice('docs/user/'.length),
    )
    .filter((s) => s.length > 0);

  return { answer, sources };
}

export const researchDocs: ToolDef = {
  name: 'research_docs',
  async execute(args: Record<string, unknown>, ctx: ToolContext) {
    const query = typeof args.query === 'string' ? args.query.trim() : '';
    if (query.length === 0) {
      throw new Error('research_docs requires a non-empty `query` argument');
    }
    const contextHint =
      typeof args.context_hint === 'string' ? args.context_hint.trim() : '';
    const includeDev = args.include_internal_dev_docs === true;

    const docsBlob = buildDocsBlob(includeDev);
    const header = includeDev ? DEV_SYSTEM_PROMPT_HEADER : SYSTEM_PROMPT_HEADER;
    const systemPrompt = `${header}\n\n${docsBlob}`;
    const userTurn = contextHint.length > 0
      ? `${contextHint}\n\nQuestion: ${query}`
      : `Question: ${query}`;

    const apiKey = await readVeniceKey(ctx.adminClient);
    if (!apiKey) throw new Error('no Venice key configured (app_config unseeded)');

    // 2048 is the project-wide floor on agent sub-call caps. Dev
    // architecture explanations earn the extra headroom of 4096 since
    // they pull in cross-module context; the prompt is what controls
    // answer length, the cap is the safety net.
    const result = await toolComplete({
      apiKey,
      model: RESEARCH_DOCS_MODEL,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userTurn },
      ],
      maxTokens: includeDev ? 4096 : 2048,
    });

    const raw = result.text;
    if (raw.trim().length === 0) {
      throw new Error(
        'research_docs: sub-agent completion produced no text content. ' +
          'This usually indicates a transient fast-tier failure, a ' +
          'content-filter rejection, or the model exhausting its output ' +
          'budget before producing any prose. Retry the call; if it keeps ' +
          'happening, rephrase the query or surface the failure to the user.',
      );
    }

    const { answer, sources } = parseResearchResult(raw, {
      keepPrefixes: includeDev,
    });

    if (answer.length === 0) {
      throw new Error(
        'research_docs: sub-agent emitted only a "Sources" trailer with no ' +
          'prose answer. This is a sub-model misbehavior (the prompt ' +
          'instructs it to always write at least a brief note about what ' +
          'was searched). Retry the call, optionally with a rephrased ' +
          'query or `include_internal_dev_docs: true` if the topic is ' +
          "about Nak's internals.",
      );
    }

    return { answer, sources };
  },
};

registerTool(researchDocs);
