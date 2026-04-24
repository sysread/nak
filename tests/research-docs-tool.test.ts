/**
 * Unit coverage for the `research_docs` tool. The tool bundles every
 * user-facing doc under `docs/user/` into a system prompt for a one-
 * shot sub-completion on the fast tier; the sub-model returns a short
 * prose answer followed by a "Sources: ..." trailer that we parse back
 * into a structured tool result. When the caller passes
 * `include_internal_dev_docs: true`, the corpus expands to also cover
 * `docs/dev/` so the same tool can field architecture / planning
 * questions. This file exercises the tool surface directly: registry
 * placement, request shape, dev-docs opt-in, answer/sources parse,
 * and cancellation wiring.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  TOOLS,
  alwaysOnToolbox,
  researchToolbox,
  memoryToolbox,
  recallToolbox,
  conversationRecallToolbox,
  buildToolList,
  type ToolContext,
  type ToolDef,
} from '../src/lib/tools';
import {
  researchDocs,
  parseResearchResult,
  VENICE_RESEARCH_DOCS_MODEL,
  RESEARCH_DOCS_SYSTEM_PROMPT_HEADER,
  RESEARCH_DOCS_DEV_SYSTEM_PROMPT_HEADER,
} from '../src/lib/tools/research_docs';
import { MODELS } from '../src/lib/models';
import type { SupabaseService } from '../src/lib/supabase';
import type { ChatRequest, StreamEvent, VeniceClient } from '../src/lib/venice';

function ctxFor(venice: VeniceClient): ToolContext {
  return {
    supabase: {} as SupabaseService,
    venice,
    userId: 'u-1',
    threadId: 't-1',
    signal: new AbortController().signal,
  };
}

function mkVenice(handler: (req: ChatRequest) => StreamEvent[]): {
  venice: VeniceClient;
  seen: ChatRequest[];
} {
  const seen: ChatRequest[] = [];
  const streamChat = vi.fn(async function* (req: ChatRequest): AsyncGenerator<
    StreamEvent,
    void,
    void
  > {
    seen.push(req);
    for (const ev of handler(req)) yield ev;
  });
  return {
    venice: { streamChat, embed: vi.fn() } as unknown as VeniceClient,
    seen,
  };
}

describe('research_docs - registry scoping', () => {
  it('is present in the main chat TOOLS list', () => {
    expect(TOOLS.map((t: ToolDef) => t.name)).toContain('research_docs');
  });

  it('lives in the gated research toolbox, not alwaysOnToolbox', () => {
    // Meta-questions about the app are infrequent relative to actual
    // work turns; paying a tool-schema tax on every request would be
    // wasteful. Gating means the LLM (or the user via the composer
    // popover) flips the toolbox on only for research-oriented
    // threads.
    expect(researchToolbox.tools.map((t) => t.name)).toContain('research_docs');
    expect(alwaysOnToolbox.tools.map((t) => t.name)).not.toContain('research_docs');
  });

  it('is absent from the wire catalog until the research toolbox is enabled', () => {
    // Tripwire: a future edit that accidentally re-promotes
    // research_docs to always-on would regress the "default request
    // payload stays small" property. buildToolList is the authoritative
    // wire builder; assert on its output.
    expect(buildToolList([]).map((t) => t.function.name)).not.toContain(
      'research_docs'
    );
    expect(buildToolList(['research']).map((t) => t.function.name)).toContain(
      'research_docs'
    );
  });

  it('is absent from memoryToolbox - reflection agent must not reach into app docs', () => {
    // Reflection operates on conversation-internal state; querying
    // user-facing docs would be off-scope and waste a sub-completion.
    expect(memoryToolbox.tools.map((t) => t.name)).not.toContain('research_docs');
  });

  it('is absent from recallToolbox - recall agent must not reach into app docs', () => {
    expect(recallToolbox.tools.map((t) => t.name)).not.toContain('research_docs');
  });

  it('is absent from conversationRecallToolbox', () => {
    expect(conversationRecallToolbox.tools.map((t) => t.name)).not.toContain(
      'research_docs'
    );
  });

  it('requires a `query` parameter, treats `context_hint` and `include_internal_dev_docs` as optional', () => {
    // Lock additionalProperties=false so a hallucinated extra field
    // from the main model can't smuggle unchecked data into the
    // sub-call.
    expect(researchDocs.parameters).toEqual({
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: expect.stringMatching(/plain prose|question/i),
        },
        context_hint: {
          type: 'string',
          description: expect.stringMatching(/caller context|sub-agent/i),
        },
        include_internal_dev_docs: {
          type: 'boolean',
          description: expect.stringMatching(/developer|docs\/dev|internal/i),
        },
      },
      required: ['query'],
      additionalProperties: false,
    });
  });

  it('pins the sub-call to the fast tier', () => {
    // The tool advertises itself as a fast-tier research agent; if the
    // constant drifts off MODELS.fast.id, that contract breaks.
    expect(VENICE_RESEARCH_DOCS_MODEL).toBe(MODELS.fast.id);
  });
});

describe('research_docs - execute() shape', () => {
  it('throws on an empty or missing query', async () => {
    const { venice } = mkVenice(() => []);
    await expect(
      researchDocs.execute({} as Record<string, unknown>, ctxFor(venice))
    ).rejects.toThrow(/non-empty.*query/i);
    await expect(
      researchDocs.execute({ query: '' }, ctxFor(venice))
    ).rejects.toThrow(/non-empty.*query/i);
    await expect(
      researchDocs.execute({ query: '   ' }, ctxFor(venice))
    ).rejects.toThrow(/non-empty.*query/i);
  });

  it('fires a sub-completion with fast-tier model, bundled docs in system prompt, capped tokens', async () => {
    const { venice, seen } = mkVenice(() => [
      { type: 'text', delta: 'Nak stores memories in IndexedDB. ' },
      { type: 'text', delta: '\n\nSources: memory.md' },
    ]);
    await researchDocs.execute(
      { query: 'where does Nak store memories?' },
      ctxFor(venice)
    );
    expect(seen).toHaveLength(1);
    const req = seen[0];
    expect(req.model).toBe(VENICE_RESEARCH_DOCS_MODEL);
    // Docs ride in the system prompt - the tool bundles them via the
    // delimiter marker so the sub-model can cite paths back verbatim.
    const sys = req.messages.find((m) => m.role === 'system');
    const sysContent = typeof sys?.content === 'string' ? sys.content : '';
    expect(sysContent).toContain(RESEARCH_DOCS_SYSTEM_PROMPT_HEADER);
    expect(sysContent).toMatch(/===== docs\/user\/README\.md =====/);
    expect(sysContent).toMatch(/===== docs\/user\/memory\.md =====/);
    // Dev-docs opt-in defaults to false. Tripwire against a future
    // edit that flips the default and silently balloons every
    // research_docs call by 4x.
    expect(sysContent).not.toContain('===== docs/dev/');
    expect(sysContent).not.toContain(RESEARCH_DOCS_DEV_SYSTEM_PROMPT_HEADER);
    // Output cap is a soft contract - just ensure some bound is set so
    // a runaway completion doesn't blow out the tool budget.
    expect(typeof req.maxTokens).toBe('number');
    // The sub-call offers no tools - the tool list should be absent.
    expect(req.tools).toBeUndefined();
    // No web search; the docs are the whole source of truth.
    expect(req.webSearch).toBeUndefined();
  });

  it('returns { answer, sources } by parsing the trailing Sources line', async () => {
    const { venice } = mkVenice(() => [
      { type: 'text', delta: 'Yes. Nak supports PWA install on iOS. ' },
      { type: 'text', delta: 'See the install guide for details.' },
      { type: 'text', delta: '\n\nSources: install-pwa.md, getting-started.md' },
    ]);
    const result = await researchDocs.execute(
      { query: 'can I install Nak as a PWA?' },
      ctxFor(venice)
    );
    expect(result).toEqual({
      answer:
        'Yes. Nak supports PWA install on iOS. See the install guide for details.',
      sources: ['install-pwa.md', 'getting-started.md'],
    });
  });

  it('returns an empty sources array when the sub-model writes "Sources: none"', async () => {
    const { venice } = mkVenice(() => [
      { type: 'text', delta: 'The docs do not cover that.\n\nSources: none' },
    ]);
    const result = (await researchDocs.execute(
      { query: 'does Nak support voice input?' },
      ctxFor(venice)
    )) as { answer: string; sources: string[] };
    expect(result.sources).toEqual([]);
    expect(result.answer).toBe('The docs do not cover that.');
  });

  it('forwards context_hint into the user turn when provided', async () => {
    const { venice, seen } = mkVenice(() => [{ type: 'text', delta: 'ok\n\nSources: none' }]);
    await researchDocs.execute(
      {
        query: 'how do I change the model?',
        context_hint: 'User is asking mid-thread about switching tiers.',
      },
      ctxFor(venice)
    );
    const userMsg = seen[0].messages.find((m) => m.role === 'user');
    const content = typeof userMsg?.content === 'string' ? userMsg.content : '';
    expect(content).toContain('User is asking mid-thread about switching tiers.');
    expect(content).toContain('Question: how do I change the model?');
  });

  it('omits the context_hint preamble when absent', async () => {
    const { venice, seen } = mkVenice(() => [{ type: 'text', delta: 'ok\n\nSources: none' }]);
    await researchDocs.execute({ query: 'q' }, ctxFor(venice));
    const userMsg = seen[0].messages.find((m) => m.role === 'user');
    expect(userMsg?.content).toBe('Question: q');
  });

  it('propagates ctx.signal into the sub-call so cancellation cascades', async () => {
    const { venice, seen } = mkVenice(() => [{ type: 'text', delta: 'ok\n\nSources: none' }]);
    const ctl = new AbortController();
    const ctx: ToolContext = {
      supabase: {} as SupabaseService,
      venice,
      userId: 'u-1',
      threadId: 't-1',
      signal: ctl.signal,
    };
    await researchDocs.execute({ query: 'q' }, ctx);
    expect(seen[0].signal).toBe(ctl.signal);
  });
});

describe('research_docs - include_internal_dev_docs', () => {
  it('swaps in the dev-aware system prompt header when the flag is true', async () => {
    const { venice, seen } = mkVenice(() => [
      { type: 'text', delta: 'arch answer\n\nSources: none' },
    ]);
    await researchDocs.execute(
      { query: 'how is memory wired internally?', include_internal_dev_docs: true },
      ctxFor(venice)
    );
    const sys = seen[0].messages.find((m) => m.role === 'system');
    const sysContent = typeof sys?.content === 'string' ? sys.content : '';
    expect(sysContent).toContain(RESEARCH_DOCS_DEV_SYSTEM_PROMPT_HEADER);
    // The default user-docs header should NOT also be present - the
    // two headers are mutually exclusive.
    expect(sysContent).not.toContain(RESEARCH_DOCS_SYSTEM_PROMPT_HEADER);
  });

  it('bundles both user and dev docs into the system prompt when the flag is true', async () => {
    const { venice, seen } = mkVenice(() => [
      { type: 'text', delta: 'arch answer\n\nSources: none' },
    ]);
    await researchDocs.execute(
      { query: 'q', include_internal_dev_docs: true },
      ctxFor(venice)
    );
    const sys = seen[0].messages.find((m) => m.role === 'system');
    const sysContent = typeof sys?.content === 'string' ? sys.content : '';
    // Spot-check a doc from each tree. README.md exists in both; test
    // both delimiters explicitly so a regression that e.g. accidentally
    // replaced the user blob with the dev blob would fail loudly.
    expect(sysContent).toMatch(/===== docs\/user\/README\.md =====/);
    expect(sysContent).toMatch(/===== docs\/dev\/README\.md =====/);
    expect(sysContent).toMatch(/===== docs\/dev\/architecture\.md =====/);
    expect(sysContent).toMatch(/===== docs\/dev\/tools\.md =====/);
  });

  it('does not bundle dev docs when the flag is explicitly false', async () => {
    const { venice, seen } = mkVenice(() => [
      { type: 'text', delta: 'answer\n\nSources: none' },
    ]);
    await researchDocs.execute(
      { query: 'q', include_internal_dev_docs: false },
      ctxFor(venice)
    );
    const sys = seen[0].messages.find((m) => m.role === 'system');
    const sysContent = typeof sys?.content === 'string' ? sys.content : '';
    expect(sysContent).not.toContain('===== docs/dev/');
  });

  it('preserves tree prefixes on parsed sources when dev docs are in scope', async () => {
    // Several filenames (README, memory, settings, attachments, chat,
    // cookbook) exist in both trees. In dev-docs mode the caller needs
    // the prefix to disambiguate - stripping it would turn
    // "docs/dev/memory.md" into "memory.md" and make the source
    // ambiguous with "docs/user/memory.md". This test locks the
    // preservation behavior.
    const { venice } = mkVenice(() => [
      {
        type: 'text',
        delta:
          'Memories live in IndexedDB locally, synced via Supabase.\n\n' +
          'Sources: docs/user/memory.md, docs/dev/memory.md',
      },
    ]);
    const result = (await researchDocs.execute(
      { query: 'where do memories live?', include_internal_dev_docs: true },
      ctxFor(venice)
    )) as { answer: string; sources: string[] };
    expect(result.sources).toEqual(['docs/user/memory.md', 'docs/dev/memory.md']);
  });

  it('raises the output token cap in dev mode to fit architecture answers', async () => {
    // Dev-mode prompts explicitly allow longer answers (the 2-5
    // sentence cap fits user-help questions but cramps architecture
    // explanations). Assert that the cap is at least strictly larger
    // than the default, without pinning an exact number - future
    // tuning can lift either bound without churning this test.
    const { venice: veniceDefault, seen: seenDefault } = mkVenice(() => [
      { type: 'text', delta: 'x\n\nSources: none' },
    ]);
    await researchDocs.execute({ query: 'q' }, ctxFor(veniceDefault));

    const { venice: veniceDev, seen: seenDev } = mkVenice(() => [
      { type: 'text', delta: 'x\n\nSources: none' },
    ]);
    await researchDocs.execute(
      { query: 'q', include_internal_dev_docs: true },
      ctxFor(veniceDev)
    );

    expect(seenDev[0].maxTokens).toBeGreaterThan(seenDefault[0].maxTokens ?? 0);
  });
});

describe('parseResearchResult', () => {
  it('returns empty fields on empty input', () => {
    expect(parseResearchResult('')).toEqual({ answer: '', sources: [] });
    expect(parseResearchResult('   \n\n  ')).toEqual({ answer: '', sources: [] });
  });

  it('treats missing trailer as "answer only, no sources"', () => {
    // Not every sub-call output will include the trailer (models
    // drift); the parse has to tolerate that rather than blow up and
    // lose the answer entirely.
    expect(parseResearchResult('just an answer with no sources line')).toEqual({
      answer: 'just an answer with no sources line',
      sources: [],
    });
  });

  it('parses a comma-separated Sources trailer into an array', () => {
    const raw = 'Answer prose here.\n\nSources: settings.md, shortcuts.md';
    expect(parseResearchResult(raw)).toEqual({
      answer: 'Answer prose here.',
      sources: ['settings.md', 'shortcuts.md'],
    });
  });

  it('handles "Sources: none" as an empty array', () => {
    expect(parseResearchResult('Answer.\nSources: none')).toEqual({
      answer: 'Answer.',
      sources: [],
    });
    expect(parseResearchResult('Answer.\nSources: NONE')).toEqual({
      answer: 'Answer.',
      sources: [],
    });
  });

  it('strips a leading docs/user/ prefix if the model includes it', () => {
    // The prompt asks for relative paths, but models sometimes inline
    // the full path. Normalize so the caller always gets the same
    // form `listDocs()` returns.
    const raw = 'Answer.\nSources: docs/user/memory.md, docs/user/settings.md';
    expect(parseResearchResult(raw)).toEqual({
      answer: 'Answer.',
      sources: ['memory.md', 'settings.md'],
    });
  });

  it('keeps docs/user/ and docs/dev/ prefixes when keepPrefixes is true', () => {
    // Dev-mode call path: multiple filenames collide across trees
    // (memory.md, settings.md, README.md, etc.), so the prefix is the
    // only signal telling them apart. Stripping it would make sources
    // ambiguous.
    const raw =
      'Answer.\nSources: docs/user/memory.md, docs/dev/memory.md, docs/dev/architecture.md';
    expect(parseResearchResult(raw, { keepPrefixes: true })).toEqual({
      answer: 'Answer.',
      sources: ['docs/user/memory.md', 'docs/dev/memory.md', 'docs/dev/architecture.md'],
    });
  });

  it('does not eat an inline "Sources:" inside the prose', () => {
    // The anchor is a line boundary near the end of the output -
    // otherwise a prose mention like "Sources: various" would be
    // parsed as the trailer and the rest of the answer would be lost.
    const raw =
      'The docs list several Sources: chapters under settings.md.\n\nSources: settings.md';
    expect(parseResearchResult(raw)).toEqual({
      answer: 'The docs list several Sources: chapters under settings.md.',
      sources: ['settings.md'],
    });
  });

  it('drops empty entries from a trailing-comma list', () => {
    const raw = 'Answer.\nSources: chat.md, , memory.md,';
    expect(parseResearchResult(raw)).toEqual({
      answer: 'Answer.',
      sources: ['chat.md', 'memory.md'],
    });
  });
});
