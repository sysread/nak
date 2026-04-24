/**
 * Docs-research entrypoint. When the user asks "how do I X in Nak",
 * "what does setting Y do", "is there a shortcut for Z", etc., the main
 * chat model calls this to hand the question off to a one-shot sub-
 * completion on the fast tier whose system prompt contains every user-
 * facing doc under `docs/user/` concatenated with path delimiters. The
 * sub-call answers from that context alone and hands back a short
 * synthesis plus the doc paths it leaned on.
 *
 * Why a tool rather than baking the docs into the main system prompt:
 * the docs are ~55 KB total - affordable on the fast tier's 256k window
 * but not something we want riding every single main-chat turn. Tool-
 * gating means docs context lands only on turns that asked for it, and
 * the sub-completion's answer synthesis keeps the main model from
 * having to sift through raw markdown.
 *
 * Why a one-shot rather than a multi-round agent with list/read tools:
 * the full doc set fits in one prompt, so navigation rounds would be
 * pure latency with no benefit. If the corpus ever grows past the
 * fast-tier window, revisit the design - for now, simpler beats
 * sophisticated.
 *
 * Toolbox scoping: lives in the gated `research` toolbox, not
 * `alwaysOnToolbox`. "How do I X in Nak?" is a real but infrequent
 * question - most turns are about the user's actual work, not meta-
 * questions about the app - so paying a tool-schema tax on every
 * request is the wrong tradeoff. Users who are actively exploring
 * the app can flip the toolbox on via the composer popover; the
 * model can flip it on via `toggle_toolbox` when the user asks a
 * meta-question and keep it on for the remainder of a research-
 * oriented thread. Deliberately excluded from `memoryToolbox`,
 * `recallToolbox`, and `conversationRecallToolbox`: background
 * agents have no business asking about app features.
 */
import type { ToolDef } from './types';
import type { VeniceMessage } from '../venice';
import { MODELS } from '../models';
import { listDocs, loadDoc } from '../docs';
import { createLogger } from '../logger.svelte';

const log = createLogger('research-docs-tool');

/**
 * Model the docs sub-completion runs against. Tracks the fast tier
 * because the task is "read the bundled docs, write a 2-5 sentence
 * synthesis" - bounded output on bounded input, no reasoning
 * required. Kept as a distinct constant so a future decision to pin
 * doc research to a different tier doesn't require editing this
 * file's internals.
 */
export const VENICE_RESEARCH_DOCS_MODEL = MODELS.fast.id;

/**
 * System prompt for the sub-call. Exported so tests can assert the
 * framing without re-declaring the literal. Terse on purpose - the
 * sub-call is a one-shot synthesis over bundled markdown, not a
 * conversational agent.
 */
export const RESEARCH_DOCS_SYSTEM_PROMPT_HEADER =
  'You are a documentation assistant for Nak, a personal AI assistant ' +
  'app that runs in the user\'s browser. Answer the caller\'s question ' +
  'using only the bundled user-facing docs below. Keep replies to ' +
  '2-5 sentences of plain prose. If the docs do not cover the topic, ' +
  'say so directly rather than guessing. Do not describe what you are ' +
  'doing or preamble - just answer. At the end, on a separate line, ' +
  'write "Sources: " followed by a comma-separated list of the doc ' +
  'paths (relative to docs/user/) you relied on; write "Sources: none" ' +
  'if you did not need any.';

/**
 * Format the bundled docs as one flat blob. Each doc is delimited by a
 * path marker so the sub-model can cite paths back verbatim, and the
 * boundary survives markdown that contains its own headings. Loads
 * every doc in parallel; `loadDoc` is backed by Vite's lazy glob
 * chunks so first-call cost is whatever the browser does to fetch the
 * shards, and subsequent calls hit the module cache.
 */
async function buildDocsBlob(): Promise<string> {
  const paths = listDocs();
  const bodies = await Promise.all(paths.map((p) => loadDoc(p)));
  const parts: string[] = [];
  for (let i = 0; i < paths.length; i++) {
    parts.push(`===== docs/user/${paths[i]} =====\n${bodies[i].trim()}`);
  }
  return parts.join('\n\n');
}

export const researchDocs: ToolDef = {
  name: 'research_docs',
  description:
    'Research a question about Nak itself - its features, settings, ' +
    'keyboard shortcuts, privacy posture, model tiers, memory system, ' +
    'cookbook, attachments, or any other user-facing behavior - by ' +
    'delegating to a sub-agent that reads the bundled in-app help ' +
    'documentation (the same corpus the Help button in the drawer ' +
    'footer renders). Use this whenever the user asks how to do ' +
    'something in Nak, what a setting does, whether a feature exists, ' +
    'or what a UI element means. The docs are authoritative; prefer ' +
    'this over answering from memory whenever the question is about ' +
    'Nak itself, because training-data drift makes answers about app ' +
    'behavior unreliable.\n\n' +
    'This tool lives in the gated `research` toolbox rather than ' +
    'always-on - most conversations are about the user\'s actual ' +
    'work, not meta-questions about the app, and paying a tool- ' +
    'schema tax on every request would be wasteful. If a user turn ' +
    'is clearly a meta-question about Nak and the `research` toolbox ' +
    'is off, call `toggle_toolbox({enabled: ["research", ...]})` to ' +
    'enable it (preserving any other toolboxes the user had on), then ' +
    'call `research_docs` on the next round. Keep it on for the rest ' +
    'of a research-oriented thread; turn it off again once the ' +
    'conversation shifts back to regular work.\n\n' +
    'Takes `query` (the question to research, phrased in plain prose) ' +
    'and optional `context_hint` (1-2 sentences on why the caller is ' +
    'asking, to keep the sub-agent on task). Returns `{answer, ' +
    'sources}` where `sources` is an array of doc paths like ' +
    '"settings.md".',
  shortDescription: 'research a question in the in-app help docs',
  parameters: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description:
          'The question to research about Nak, phrased in plain prose ' +
          '(a direct question works fine).',
      },
      context_hint: {
        type: 'string',
        description:
          'Optional 1-2 sentences of caller context so the sub-agent ' +
          'knows why it is looking. Helps keep the synthesis focused ' +
          'when the query alone is ambiguous.',
      },
    },
    required: ['query'],
    additionalProperties: false,
  },
  async execute(args, ctx) {
    const query = typeof args.query === 'string' ? args.query.trim() : '';
    if (query.length === 0) {
      // Throwing here lets chat-loop's encodeToolContent fold the
      // message into `{error: "..."}` on the tool-result row, which
      // the main model reads on the next round and can adapt to
      // (e.g. retry with a non-empty query). Matches web_search's
      // error-surfacing convention.
      throw new Error('research_docs requires a non-empty `query` argument');
    }
    const contextHint =
      typeof args.context_hint === 'string' ? args.context_hint.trim() : '';

    log.info(`query: ${query.slice(0, 80)}${query.length > 80 ? '...' : ''}`);

    const docsBlob = await buildDocsBlob();
    const systemPrompt = `${RESEARCH_DOCS_SYSTEM_PROMPT_HEADER}\n\n${docsBlob}`;

    const userTurn = contextHint.length > 0
      ? `${contextHint}\n\nQuestion: ${query}`
      : `Question: ${query}`;

    const messages: VeniceMessage[] = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userTurn },
    ];

    const stream = ctx.venice.streamChat({
      model: VENICE_RESEARCH_DOCS_MODEL,
      messages,
      signal: ctx.signal,
      maxTokens: 600,
    });

    let raw = '';
    for await (const ev of stream) {
      if (ev.type === 'text') {
        raw += ev.delta;
      }
      // Drop reasoning / usage / tool_call / citations. The sub-call
      // offers no tools and should emit no citations (no web search);
      // drop defensively rather than recursing or erroring.
    }

    const { answer, sources } = parseResearchResult(raw);
    log.info(`done: ${sources.length} source(s)`);
    return { answer, sources };
  },
};

export interface ParsedResearchResult {
  answer: string;
  sources: string[];
}

/**
 * Split the sub-model's output into the prose answer and the trailing
 * "Sources: ..." line. Tolerant of casing, missing trailer, and the
 * "none" sentinel. Exported for direct test coverage - the parse is
 * where the sub-agent's freeform output meets a structured tool
 * result, so an unexpected shape here would quietly mis-cite.
 */
export function parseResearchResult(raw: string): ParsedResearchResult {
  const text = raw.trim();
  if (text.length === 0) return { answer: '', sources: [] };

  // Match "Sources:" on its own line near the end. Anchor at a line
  // boundary so we don't eat an inline "Sources:" inside the prose.
  const match = text.match(/(^|\n)\s*Sources:\s*(.*)\s*$/i);
  if (!match) return { answer: text, sources: [] };

  const answer = text.slice(0, match.index).trim();
  const tail = match[2].trim();

  // "none" (case-insensitive) is the sentinel the prompt asks the
  // model to emit when it did not need to cite anything. Any other
  // value is parsed as a comma-separated list of doc paths.
  if (tail.length === 0 || tail.toLowerCase() === 'none') {
    return { answer, sources: [] };
  }

  const sources = tail
    .split(',')
    .map((s) => s.trim())
    // Strip a leading "docs/user/" if the model included it, so the
    // caller gets the same relative form `listDocs()` returns.
    .map((s) => (s.startsWith('docs/user/') ? s.slice('docs/user/'.length) : s))
    .filter((s) => s.length > 0);

  return { answer, sources };
}
