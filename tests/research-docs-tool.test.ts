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
  RESEARCH_DOCS_SYSTEM_PROMPT_HEADER,
  RESEARCH_DOCS_DEV_SYSTEM_PROMPT_HEADER,
} from '../src/lib/tools/research_docs';
import { AGENT_MODELS, agentModel } from '../src/lib/models';
import type { SupabaseService } from '../src/lib/supabase';
import type { ChatCompletion, ChatRequest, VeniceClient } from '../src/lib/venice';

// research_docs talks to the venice edge function via SupabaseService.complete
// (milestone 6) - the leftover `venice: VeniceClient` field on ToolContext is
// still there because background-agent workers (samskara, summary, bias, ...)
// haven't migrated yet. ctxFor stubs both: a stub VeniceClient that the tool
// no longer reads, and a SupabaseService whose `complete` is the actual
// fixture point.
function ctxFor(supabase: SupabaseService): ToolContext {
  return {
    supabase,
    venice: { completeChat: vi.fn(), embed: vi.fn() } as unknown as VeniceClient,
    userId: 'u-1',
    threadId: 't-1',
    signal: new AbortController().signal,
  };
}

function makeCompletion(text: string): ChatCompletion {
  return {
    text,
    reasoning: '',
    toolCalls: [],
    usage: null,
    citations: [],
    finishReason: 'stop',
  };
}

function mkSupabase(handler: (req: ChatRequest) => string): {
  supabase: SupabaseService;
  seen: ChatRequest[];
} {
  const seen: ChatRequest[] = [];
  const complete = vi.fn(async (req: ChatRequest): Promise<ChatCompletion> => {
    seen.push(req);
    return makeCompletion(handler(req));
  });
  return {
    supabase: { complete } as unknown as SupabaseService,
    seen,
  };
}

describe('research_docs - registry scoping', () => {
  it('is present in the main chat TOOLS list', () => {
    expect(TOOLS.map((t: ToolDef) => t.name)).toContain('research_docs');
  });

  it('lives in alwaysOnToolbox so it rides without a toolbox toggle', () => {
    // research_docs is read-only (a sub-completion against bundled
    // help docs - no DB writes, no network fetch beyond the model
    // call) and joined the always-on set when read tools were
    // promoted out of gating. Meta-questions about the app are
    // infrequent, but the model was passing over the tool when it
    // had to flip a toolbox to reach it. Always-on means a "how do I
    // do X in Nak" turn fires research_docs without a prefatory
    // round-trip.
    expect(alwaysOnToolbox.tools.map((t) => t.name)).toContain('research_docs');
  });

  it('is in the wire catalog on every turn', () => {
    // Tripwire: a future edit that pushes research_docs back behind
    // a gate would re-introduce the "model skipped over it" failure
    // mode. buildToolList with no enabled toolboxes is the cold-start
    // wire shape; research_docs has to be in it.
    expect(buildToolList([]).map((t) => t.function.name)).toContain(
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

  it('pins the sub-call to the registry researchDocs slot', () => {
    // The tool advertises itself as a bounded-synthesis agent; the
    // registry slot is the single swap point for retargeting it.
    expect(AGENT_MODELS.researchDocs).toBe(agentModel('researchDocs').id);
  });
});

describe('research_docs - execute() shape', () => {
  it('throws on an empty or missing query', async () => {
    const { supabase } = mkSupabase(() => '');
    await expect(
      researchDocs.execute({} as Record<string, unknown>, ctxFor(supabase))
    ).rejects.toThrow(/non-empty.*query/i);
    await expect(
      researchDocs.execute({ query: '' }, ctxFor(supabase))
    ).rejects.toThrow(/non-empty.*query/i);
    await expect(
      researchDocs.execute({ query: '   ' }, ctxFor(supabase))
    ).rejects.toThrow(/non-empty.*query/i);
  });

  it('fires a sub-completion with the researchDocs model, bundled docs in system prompt, capped tokens', async () => {
    const { supabase, seen } = mkSupabase(
      () => 'Nak stores memories in IndexedDB. \n\nSources: memory.md'
    );
    await researchDocs.execute(
      { query: 'where does Nak store memories?' },
      ctxFor(supabase)
    );
    expect(seen).toHaveLength(1);
    const req = seen[0];
    expect(req.model).toBe(agentModel('researchDocs').id);
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
    const { supabase } = mkSupabase(
      () =>
        'Yes. Nak supports PWA install on iOS. See the install guide for details.\n\n' +
        'Sources: install-pwa.md, getting-started.md'
    );
    const result = await researchDocs.execute(
      { query: 'can I install Nak as a PWA?' },
      ctxFor(supabase)
    );
    expect(result).toEqual({
      answer:
        'Yes. Nak supports PWA install on iOS. See the install guide for details.',
      sources: ['install-pwa.md', 'getting-started.md'],
    });
  });

  it('returns an empty sources array when the sub-model writes "Sources: none"', async () => {
    const { supabase } = mkSupabase(
      () => 'The docs do not cover that.\n\nSources: none'
    );
    const result = (await researchDocs.execute(
      { query: 'does Nak support voice input?' },
      ctxFor(supabase)
    )) as { answer: string; sources: string[] };
    expect(result.sources).toEqual([]);
    expect(result.answer).toBe('The docs do not cover that.');
  });

  it('throws a descriptive error when the sub-agent completion produces no text', async () => {
    // Empty-completion failure mode: the sub-call returned but its
    // text was empty. Without this throw, the tool would silently
    // return `{answer: '', sources: []}` - indistinguishable from a
    // successful "no results" answer, leaving the calling LLM no way
    // to tell whether to retry, rephrase, or surface the failure to
    // the user. The throw routes through chat-loop's
    // encodeToolContent into `{error: "..."}` on the tool-result row.
    const { supabase } = mkSupabase(() => '');
    await expect(
      researchDocs.execute({ query: 'q' }, ctxFor(supabase))
    ).rejects.toThrow(/completion produced no text content/i);
  });

  it('throws when the sub-agent emits only the Sources trailer with no prose', async () => {
    // Degenerate-parse failure mode: the sub-model ignored the prompt's
    // instruction to always write at least a brief no-results note and
    // emitted only the trailer. Without this throw, the tool would
    // silently return `{answer: '', sources: []}` - same problem as the
    // empty-completion case. Sources can be empty (Sources: none) or
    // non-empty; either way an empty answer is the misbehavior we surface.
    const { supabase } = mkSupabase(() => 'Sources: none');
    await expect(
      researchDocs.execute({ query: 'q' }, ctxFor(supabase))
    ).rejects.toThrow(/Sources.*trailer.*no prose/i);
  });

  it('throws even when the trailer-only output cites real docs', async () => {
    // Tripwire on the second branch of the empty-answer check. A trailer
    // that names sources is no more useful than `Sources: none` if the
    // answer is empty - the calling LLM has no synthesis to act on.
    const { supabase } = mkSupabase(() => '\n\nSources: memory.md');
    await expect(
      researchDocs.execute({ query: 'q' }, ctxFor(supabase))
    ).rejects.toThrow(/Sources.*trailer.*no prose/i);
  });

  it('throws on whitespace-only completion output', async () => {
    // `raw.trim().length === 0` catches the case where the sub-model
    // produced only whitespace. Same failure-shape as a fully empty
    // completion from the calling LLM's perspective.
    const { supabase } = mkSupabase(() => '   \n\n');
    await expect(
      researchDocs.execute({ query: 'q' }, ctxFor(supabase))
    ).rejects.toThrow(/completion produced no text content/i);
  });

  it('forwards context_hint into the user turn when provided', async () => {
    const { supabase, seen } = mkSupabase(() => 'ok\n\nSources: none');
    await researchDocs.execute(
      {
        query: 'how do I change the model?',
        context_hint: 'User is asking mid-thread about switching tiers.',
      },
      ctxFor(supabase)
    );
    const userMsg = seen[0].messages.find((m) => m.role === 'user');
    const content = typeof userMsg?.content === 'string' ? userMsg.content : '';
    expect(content).toContain('User is asking mid-thread about switching tiers.');
    expect(content).toContain('Question: how do I change the model?');
  });

  it('omits the context_hint preamble when absent', async () => {
    const { supabase, seen } = mkSupabase(() => 'ok\n\nSources: none');
    await researchDocs.execute({ query: 'q' }, ctxFor(supabase));
    const userMsg = seen[0].messages.find((m) => m.role === 'user');
    expect(userMsg?.content).toBe('Question: q');
  });

  it('propagates ctx.signal into the sub-call so cancellation cascades', async () => {
    const { supabase, seen } = mkSupabase(() => 'ok\n\nSources: none');
    const ctl = new AbortController();
    // Build the ToolContext inline (rather than reusing ctxFor) because the
    // assertion targets ctx.signal specifically - we need to pin the
    // controller we constructed, not the default ctxFor wires up.
    const ctx: ToolContext = {
      supabase,
      venice: { completeChat: vi.fn(), embed: vi.fn() } as unknown as VeniceClient,
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
    const { supabase, seen } = mkSupabase(() => 'arch answer\n\nSources: none');
    await researchDocs.execute(
      { query: 'how is memory wired internally?', include_internal_dev_docs: true },
      ctxFor(supabase)
    );
    const sys = seen[0].messages.find((m) => m.role === 'system');
    const sysContent = typeof sys?.content === 'string' ? sys.content : '';
    expect(sysContent).toContain(RESEARCH_DOCS_DEV_SYSTEM_PROMPT_HEADER);
    // The default user-docs header should NOT also be present - the
    // two headers are mutually exclusive.
    expect(sysContent).not.toContain(RESEARCH_DOCS_SYSTEM_PROMPT_HEADER);
  });

  it('bundles both user and dev docs into the system prompt when the flag is true', async () => {
    const { supabase, seen } = mkSupabase(() => 'arch answer\n\nSources: none');
    await researchDocs.execute(
      { query: 'q', include_internal_dev_docs: true },
      ctxFor(supabase)
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
    const { supabase, seen } = mkSupabase(() => 'answer\n\nSources: none');
    await researchDocs.execute(
      { query: 'q', include_internal_dev_docs: false },
      ctxFor(supabase)
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
    const { supabase } = mkSupabase(
      () =>
        'Memories live in IndexedDB locally, synced via Supabase.\n\n' +
        'Sources: docs/user/memory.md, docs/dev/memory.md'
    );
    const result = (await researchDocs.execute(
      { query: 'where do memories live?', include_internal_dev_docs: true },
      ctxFor(supabase)
    )) as { answer: string; sources: string[] };
    expect(result.sources).toEqual(['docs/user/memory.md', 'docs/dev/memory.md']);
  });

  it('raises the output token cap in dev mode to fit architecture answers', async () => {
    // Dev-mode prompts explicitly allow longer answers (the 2-5
    // sentence cap fits user-help questions but cramps architecture
    // explanations). Assert that the cap is at least strictly larger
    // than the default, without pinning an exact number - future
    // tuning can lift either bound without churning this test.
    const { supabase: supabaseDefault, seen: seenDefault } = mkSupabase(
      () => 'x\n\nSources: none'
    );
    await researchDocs.execute({ query: 'q' }, ctxFor(supabaseDefault));

    const { supabase: supabaseDev, seen: seenDev } = mkSupabase(
      () => 'x\n\nSources: none'
    );
    await researchDocs.execute(
      { query: 'q', include_internal_dev_docs: true },
      ctxFor(supabaseDev)
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
