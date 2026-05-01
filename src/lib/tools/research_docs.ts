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
 * the user docs are ~55 KB total - affordable on the fast tier's 256k
 * window but not something we want riding every single main-chat turn.
 * Tool-gating means docs context lands only on turns that asked for
 * it, and the sub-completion's answer synthesis keeps the main model
 * from having to sift through raw markdown.
 *
 * Dev-doc mode: when the caller passes
 * `include_internal_dev_docs: true`, the sub-call's system prompt also
 * carries every doc under `docs/dev/` (architecture + per-feature
 * notes, ~200 KB). This is the "help me plan a Nak feature" path - a
 * user or model asking about Nak's internals, subsystem boundaries,
 * or how an existing feature is wired can reach the dev corpus in the
 * same synthesis round. Dev docs are opt-in per call rather than
 * always-on so the common case (user-help questions) stays cheap:
 * 200 KB is still comfortably under the fast-tier window but it's 4x
 * the default payload, and most research questions don't need it.
 * Both corpuses ride in one prompt when the flag is on so the sub-
 * model can cross-reference user-facing behavior against internal
 * design notes in a single pass.
 *
 * Why a one-shot rather than a multi-round agent with list/read tools:
 * even the combined ~255 KB fits in the fast-tier prompt, so
 * navigation rounds would be pure latency with no benefit. If the
 * corpus ever grows past the window, revisit the design - for now,
 * simpler beats sophisticated.
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
import { listDocs, loadDoc, listDevDocs, loadDevDoc } from '../docs';
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
 * System prompt for the user-docs-only sub-call. Exported so tests
 * can assert the framing without re-declaring the literal. Terse on
 * purpose - the sub-call is a one-shot synthesis over bundled
 * markdown, not a conversational agent.
 */
export const RESEARCH_DOCS_SYSTEM_PROMPT_HEADER =
  'You are a documentation assistant for Nak, a personal AI assistant ' +
  'app that runs in the user\'s browser. Answer the caller\'s question ' +
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

/**
 * System prompt when `include_internal_dev_docs` is true. The corpus
 * spans both trees, so several filenames collide (README.md,
 * memory.md, settings.md, attachments.md, chat.md, cookbook.md). The
 * prompt therefore asks for the full path including the tree prefix,
 * and `parseResearchResult` keeps the prefix intact in that mode.
 */
export const RESEARCH_DOCS_DEV_SYSTEM_PROMPT_HEADER =
  'You are a documentation assistant for Nak, a personal AI assistant ' +
  'app that runs in the user\'s browser. Two doc trees are bundled ' +
  'below: `docs/user/` is the end-user manual (same corpus the in-app ' +
  'Help button renders), and `docs/dev/` is the internal architecture ' +
  'and per-feature engineering notes. Answer the caller\'s question ' +
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

/**
 * Format the bundled docs as one flat blob. Each doc is delimited by a
 * path marker so the sub-model can cite paths back verbatim, and the
 * boundary survives markdown that contains its own headings. Loads
 * every doc in parallel; `loadDoc` / `loadDevDoc` are backed by
 * Vite's lazy glob chunks so first-call cost is whatever the browser
 * does to fetch the shards, and subsequent calls hit the module cache.
 *
 * `includeDev=true` appends the `docs/dev/` tree after the user docs.
 * Order matters: user docs first means the sub-model reads the
 * user-visible contract before the internal design note, which
 * matches how a human would reason about "how does this feature
 * behave, and how is it wired?"
 */
async function buildDocsBlob(includeDev: boolean): Promise<string> {
  const userPaths = listDocs();
  const userBodies = await Promise.all(userPaths.map((p) => loadDoc(p)));
  const parts: string[] = [];
  for (let i = 0; i < userPaths.length; i++) {
    parts.push(`===== docs/user/${userPaths[i]} =====\n${userBodies[i].trim()}`);
  }
  if (includeDev) {
    const devPaths = listDevDocs();
    const devBodies = await Promise.all(devPaths.map((p) => loadDevDoc(p)));
    for (let i = 0; i < devPaths.length; i++) {
      parts.push(`===== docs/dev/${devPaths[i]} =====\n${devBodies[i].trim()}`);
    }
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
    'For internal / engineering questions - architecture, subsystem ' +
    'boundaries, how an existing feature is wired, "how would we add ' +
    'X to Nak" planning questions - pass ' +
    '`include_internal_dev_docs: true`. That expands the sub-agent\'s ' +
    'corpus to also cover `docs/dev/` (architecture + per-feature dev ' +
    'notes), so it can cross-reference user-facing behavior against ' +
    'internal design notes in a single pass. Leave the flag off (the ' +
    'default) for ordinary user-help questions; the dev corpus is ' +
    'roughly 4x the size of the user manual and loading it on every ' +
    'call is wasteful.\n\n' +
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
    'Takes `query` (the question to research, phrased in plain prose), ' +
    'optional `context_hint` (1-2 sentences on why the caller is ' +
    'asking, to keep the sub-agent on task), and optional ' +
    '`include_internal_dev_docs` (boolean, default false). Returns ' +
    '`{answer, sources}`. In the default mode `sources` entries are ' +
    'filenames like `"settings.md"`; when dev docs are included they ' +
    'carry the tree prefix like `"docs/user/memory.md"` or ' +
    '`"docs/dev/memory.md"` so the two corpuses can be told apart ' +
    '(several filenames collide across the trees).',
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
      include_internal_dev_docs: {
        type: 'boolean',
        description:
          'Opt in to the developer-docs corpus (`docs/dev/`) on top of ' +
          'the default user-manual corpus. Set true only for questions ' +
          'about Nak\'s internals, architecture, or planning changes to ' +
          'the app itself - the dev tree is ~4x the size of the user ' +
          'tree and loading it on every call is wasteful. Defaults to ' +
          'false.',
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
    const includeDev = args.include_internal_dev_docs === true;

    log.info(
      `query: ${query.slice(0, 80)}${query.length > 80 ? '...' : ''}` +
        (includeDev ? ' (+dev docs)' : '')
    );

    const docsBlob = await buildDocsBlob(includeDev);
    const header = includeDev
      ? RESEARCH_DOCS_DEV_SYSTEM_PROMPT_HEADER
      : RESEARCH_DOCS_SYSTEM_PROMPT_HEADER;
    const systemPrompt = `${header}\n\n${docsBlob}`;

    const userTurn = contextHint.length > 0
      ? `${contextHint}\n\nQuestion: ${query}`
      : `Question: ${query}`;

    const messages: VeniceMessage[] = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userTurn },
    ];

    // Dev-mode answers can run longer - architecture questions aren't
    // well-served by the 2-5 sentence cap that fits user-help questions.
    const stream = ctx.venice.streamChat({
      model: VENICE_RESEARCH_DOCS_MODEL,
      messages,
      signal: ctx.signal,
      maxTokens: includeDev ? 1500 : 600,
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

    // Empty stream: the sub-completion finished but emitted no text
    // events at all. Common causes: fast-tier transient failure,
    // content-filter rejection, the model hitting maxTokens before the
    // first text token, or a model that emitted only reasoning tokens
    // and gave up. Throw rather than silently returning `{answer: '',
    // sources: []}` - that empty shape is indistinguishable from a
    // successful "no results" response and gives the calling model no
    // signal about whether to retry, rephrase, or surface the failure
    // to the user. The throw routes through chat-loop's
    // encodeToolContent into `{error: "..."}` on the tool-result row,
    // which the main model can read and act on.
    if (raw.trim().length === 0) {
      log.warn('sub-agent stream completed with no text content');
      throw new Error(
        'research_docs: sub-agent stream completed with no text content. ' +
          'This usually indicates a transient fast-tier failure, a ' +
          'content-filter rejection, or the model exhausting its output ' +
          'budget before producing any prose. Retry the call; if it keeps ' +
          'happening, rephrase the query or surface the failure to the user.'
      );
    }

    const { answer, sources } = parseResearchResult(raw, { keepPrefixes: includeDev });

    // Degenerate parse: the stream produced text but the only thing it
    // produced was the trailing "Sources: ..." line, leaving the answer
    // empty. The system prompt explicitly tells the sub-model to write
    // 1-2 sentences of prose even when the docs don't cover the topic,
    // so an empty answer means the sub-model ignored that instruction.
    // Same rationale as the empty-stream case above: throw rather than
    // hand back `{answer: '', sources: [...]}` and force the calling
    // model to guess what happened.
    if (answer.length === 0) {
      log.warn('sub-agent emitted only the Sources trailer with no prose');
      throw new Error(
        'research_docs: sub-agent emitted only a "Sources" trailer with no ' +
          'prose answer. This is a sub-model misbehavior (the prompt ' +
          'instructs it to always write at least a brief note about what ' +
          'was searched). Retry the call, optionally with a rephrased ' +
          'query or `include_internal_dev_docs: true` if the topic is ' +
          'about Nak\'s internals.'
      );
    }

    log.info(`done: ${sources.length} source(s)`);
    return { answer, sources };
  },
};

export interface ParsedResearchResult {
  answer: string;
  sources: string[];
}

export interface ParseResearchOptions {
  /**
   * When true, preserve `docs/user/` and `docs/dev/` prefixes on
   * source paths. Set by the dev-docs call path where both trees are
   * in scope and several filenames collide (README.md, memory.md,
   * settings.md, attachments.md, chat.md, cookbook.md) - the prefix
   * is the only signal telling them apart. When false (the default,
   * matching the user-docs-only call path), a leading `docs/user/` is
   * stripped so the caller gets the same relative form `listDocs()`
   * returns.
   */
  keepPrefixes?: boolean;
}

/**
 * Split the sub-model's output into the prose answer and the trailing
 * "Sources: ..." line. Tolerant of casing, missing trailer, and the
 * "none" sentinel. Exported for direct test coverage - the parse is
 * where the sub-agent's freeform output meets a structured tool
 * result, so an unexpected shape here would quietly mis-cite.
 */
export function parseResearchResult(
  raw: string,
  opts: ParseResearchOptions = {}
): ParsedResearchResult {
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

  const keepPrefixes = opts.keepPrefixes === true;
  const sources = tail
    .split(',')
    .map((s) => s.trim())
    .map((s) => {
      if (keepPrefixes) return s;
      // User-docs-only mode: strip a leading `docs/user/` so the
      // caller sees the same relative form `listDocs()` returns.
      // Leave `docs/dev/` alone; the model should not emit those in
      // this mode, but if it somehow does, preserving the prefix
      // makes the mismatch visible rather than masking it.
      return s.startsWith('docs/user/') ? s.slice('docs/user/'.length) : s;
    })
    .filter((s) => s.length > 0);

  return { answer, sources };
}
