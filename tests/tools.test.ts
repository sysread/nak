/**
 * Unit coverage for the tool registry and the individual tool handlers.
 *
 * These tests exercise the dispatch and argument-validation paths. They
 * don't drive a live Supabase — the handlers delegate every side effect
 * to a SupabaseService method, so we stub a fake service and assert the
 * right method was called with the right shape. Actual CRUD round-trips
 * against the live DB belong in an integration test layer (out of scope
 * for unit coverage here).
 */
import { describe, it, expect, vi } from 'vitest';
import {
  TOOLS,
  TOOLBOXES,
  GATED_TOOLBOX_NAMES,
  GATED_TOOLBOX_META,
  alwaysOnToolbox,
  cookingToolbox,
  memoriesToolbox,
  conversationsToolbox,
  buildToolList,
  buildSystemPrompt,
  buildToolboxWireList,
  executeToolboxCall,
  memoryToolbox,
  recallToolbox,
  conversationRecallToolbox,
  toOpenAIToolDef,
  executeToolCall,
  toggleToolbox,
  type ToolContext,
  type Toolbox,
  type ToolDef,
} from '../src/lib/tools';
import type { SupabaseService } from '../src/lib/supabase';
import type { VeniceClient } from '../src/lib/venice';

/**
 * Build a SupabaseService mock with just the methods the tool handlers
 * touch. Each spy captures its calls so tests can assert on them.
 */
function mockSupabase(): {
  svc: SupabaseService;
  spies: {
    setThreadToolboxesEnabled: ReturnType<typeof vi.fn>;
    searchMemories: ReturnType<typeof vi.fn>;
    searchMemoriesByEmbedding: ReturnType<typeof vi.fn>;
    searchUnembeddedMemoriesByText: ReturnType<typeof vi.fn>;
    createMemory: ReturnType<typeof vi.fn>;
    updateMemory: ReturnType<typeof vi.fn>;
    deleteMemory: ReturnType<typeof vi.fn>;
    decayMemoryConfidence: ReturnType<typeof vi.fn>;
  };
} {
  const spies = {
    setThreadToolboxesEnabled: vi.fn(async () => undefined),
    searchMemories: vi.fn(async () => [
      { id: 'm1', label: 'foo', data: 'bar', created_at: 't', updated_at: 't' },
    ]),
    searchMemoriesByEmbedding: vi.fn(async () => [
      { id: 'm1', label: 'foo', data: 'bar', created_at: 't', updated_at: 't' },
    ]),
    searchUnembeddedMemoriesByText: vi.fn(async () => []),
    createMemory: vi.fn(async (label: string, data: string) => ({
      id: 'new-id',
      label,
      data,
      created_at: 't',
      updated_at: 't',
    })),
    updateMemory: vi.fn(async (id: string, patch: { label?: string; data?: string }) => ({
      id,
      label: patch.label ?? 'keep',
      data: patch.data ?? 'keep',
      created_at: 't',
      updated_at: 't',
    })),
    deleteMemory: vi.fn(async () => undefined),
    // Reflection-agent soft delete: server returns the post-decay
    // confidence. Default mock returns 0.5 — one halving from the 1.0
    // seed value.
    decayMemoryConfidence: vi.fn(async () => 0.5),
  };
  // Cast is fine — the handlers only touch the methods we've implemented.
  const svc = spies as unknown as SupabaseService;
  return { svc, spies };
}

/**
 * Stand-in VeniceClient for the tool tests. Only `memory_search` calls into
 * Venice (to embed the query), so we only stub `.embed()`. The embedding
 * shape matches the real response so the tool's index-0 unwrap works.
 */
function mockVenice(): VeniceClient {
  return {
    embed: vi.fn(async () => ({
      data: [{ index: 0, embedding: new Array(1024).fill(0) }],
    })),
  } as unknown as VeniceClient;
}

function ctxFor(svc: SupabaseService, venice: VeniceClient = mockVenice()): ToolContext {
  return {
    supabase: svc,
    venice,
    userId: 'u-1',
    threadId: 't-1',
    signal: new AbortController().signal,
  };
}

describe('tool registry', () => {
  it('exposes toggle_toolbox plus every memory + conversation tool', () => {
    const names = TOOLS.map((t: ToolDef) => t.name);
    expect(names).toContain('toggle_toolbox');
    expect(names).toContain('memory_recall');
    expect(names).toContain('memory_search');
    expect(names).toContain('memory_create');
    expect(names).toContain('memory_update');
    expect(names).toContain('memory_delete');
    expect(names).toContain('conversation_recall');
    expect(names).toContain('conversation_search');
  });

  it('buildToolList with no enabled toolboxes returns only the always-on set', () => {
    // Always-on: toggle_toolbox + the recall pair + web_search +
    // update_title + analyze_image. The recall tools are reflex-level
    // - the system prompt tells the model to call them at the top of a
    // new topic, so they can't sit behind a prefatory toggle round-trip.
    // web_search joins them for the same reason: time-sensitive
    // questions should fire a search without the user first enabling a
    // toolbox. update_title has to fire on the very first turn of a
    // fresh thread (toolboxes_enabled=[] by default), so gating it
    // would mean a toggle round-trip before the model could name the
    // conversation. analyze_image must be always-on so the model can
    // reach it on any tier when the user sends an image.
    const list = buildToolList([]);
    expect(list.map((t) => t.function.name).sort()).toEqual(
      [
        'analyze_image',
        'conversation_recall',
        'memory_recall',
        'toggle_toolbox',
        'update_title',
        'web_search',
      ]
    );
  });

  it('buildToolList hides gated tools until their toolbox is enabled', () => {
    // Tripwire: if someone adds a gated tool to the always-on toolbox
    // by accident, the "no toolboxes => small wire payload" invariant
    // breaks. Name every tool that MUST be gated here.
    const disabled = buildToolList([]).map((t) => t.function.name);
    for (const gated of [
      'memory_search',
      'memory_create',
      'memory_update',
      'memory_delete',
      'conversation_search',
      'recipe_list',
      'recipe_save',
    ]) {
      expect(disabled).not.toContain(gated);
    }
  });

  it('buildToolList(["cooking"]) exposes cooking tools and no other gated tools', () => {
    const names = buildToolList(['cooking']).map((t) => t.function.name);
    expect(names).toContain('recipe_list');
    expect(names).toContain('recipe_save');
    expect(names).toContain('recipe_get');
    expect(names).toContain('recipe_update');
    expect(names).toContain('recipe_delete');
    // Memory + conversation CRUD stays gated behind their own
    // toolboxes.
    expect(names).not.toContain('memory_search');
    expect(names).not.toContain('memory_create');
    expect(names).not.toContain('conversation_search');
    // Always-on tools ride along regardless of which toolbox is on.
    expect(names).toContain('toggle_toolbox');
    expect(names).toContain('memory_recall');
  });

  it('buildToolList(["memories", "conversations"]) exposes only those plus always-on', () => {
    const names = buildToolList(['memories', 'conversations']).map((t) => t.function.name);
    expect(names).toContain('memory_search');
    expect(names).toContain('memory_create');
    expect(names).toContain('memory_update');
    expect(names).toContain('memory_delete');
    expect(names).toContain('conversation_search');
    expect(names).not.toContain('recipe_list');
    expect(names).not.toContain('recipe_save');
  });

  it('buildToolList with every gated toolbox enabled returns the full catalog', () => {
    const list = buildToolList(GATED_TOOLBOX_NAMES);
    expect(list.map((t) => t.function.name).sort()).toEqual(
      TOOLS.map((t: ToolDef) => t.name).sort()
    );
  });

  it('buildToolList ignores unknown toolbox names silently', () => {
    // A renamed or deleted toolbox should not break mid-flight. The
    // wire builder drops unknowns and returns whatever else it
    // recognised.
    const names = buildToolList(['nonsense', 'cooking']).map((t) => t.function.name);
    expect(names).toContain('recipe_list');
    expect(names).not.toContain('memory_search');
  });

  it('buildToolList always includes always-on tools even when always_on is named explicitly', () => {
    // `always_on` is implicit - listing it in the enabled array does
    // nothing (we already include it) and does not enable any gated
    // toolbox.
    const names = buildToolList(['always_on']).map((t) => t.function.name);
    expect(names).toContain('toggle_toolbox');
    expect(names).toContain('web_search');
    expect(names).not.toContain('recipe_list');
    expect(names).not.toContain('memory_search');
  });

  it('TOOLBOXES exposes the canonical ordered list with always_on first', () => {
    // Order is visible to the model (system-prompt catalog) and to the
    // user (popover list). always_on first so the reflex-level
    // surfaces are read before the gated catalog.
    expect(TOOLBOXES[0]).toBe(alwaysOnToolbox);
    expect(TOOLBOXES.map((tb) => tb.name)).toEqual([
      'always_on',
      'cooking',
      'memories',
      'conversations',
    ]);
  });

  it('GATED_TOOLBOX_NAMES lists every gated toolbox and omits always_on', () => {
    expect(GATED_TOOLBOX_NAMES).toEqual(['cooking', 'memories', 'conversations']);
    expect(GATED_TOOLBOX_NAMES).not.toContain('always_on');
  });

  it('GATED_TOOLBOX_META mirrors names and descriptions, nothing else', () => {
    // The UI popover reads this projection so Chat.svelte does not
    // import tool definitions just to render a list. If the shape
    // drifts from {name, description} the popover stops rendering
    // descriptions and this catches it.
    expect(GATED_TOOLBOX_META.map((m) => m.name)).toEqual([
      'cooking',
      'memories',
      'conversations',
    ]);
    for (const m of GATED_TOOLBOX_META) {
      expect(typeof m.description).toBe('string');
      expect(m.description.length).toBeGreaterThan(0);
    }
  });

  it('cookingToolbox, memoriesToolbox, conversationsToolbox are pure CRUD subsets', () => {
    expect(cookingToolbox.tools.map((t) => t.name)).toEqual([
      'recipe_list',
      'recipe_get',
      'recipe_save',
      'recipe_update',
      'recipe_delete',
    ]);
    expect(memoriesToolbox.tools.map((t) => t.name)).toEqual([
      'memory_search',
      'memory_create',
      'memory_update',
      'memory_delete',
    ]);
    expect(conversationsToolbox.tools.map((t) => t.name)).toEqual([
      'conversation_search',
    ]);
  });

  it('toOpenAIToolDef projects to the function-calling wire shape', () => {
    const wire = toOpenAIToolDef(toggleToolbox);
    expect(wire).toEqual({
      type: 'function',
      function: {
        name: toggleToolbox.name,
        description: toggleToolbox.description,
        parameters: toggleToolbox.parameters,
      },
    });
  });

  it('buildSystemPrompt opens with the Nak identity line', () => {
    // The first sentence frames the model. It has to be present every
    // turn, even when the user has custom system prompts stacked after
    // it, because user prompts are allowed to reshape voice but shouldn't
    // have to re-establish what the product is.
    const prompt = buildSystemPrompt();
    expect(prompt).toMatch(/^You are Nak/);
  });

  it('buildSystemPrompt mentions long-term memory and nudges memory_recall', () => {
    // The memory loop is the interesting behavior. If this copy rots,
    // the model stops reaching for memory_recall and recall becomes a
    // dead tool. Fail loudly on a regression rather than silently.
    const prompt = buildSystemPrompt();
    expect(prompt).toMatch(/long-term memory/i);
    expect(prompt).toContain('memory_recall');
  });

  it('buildSystemPrompt carries the anti-sycophancy voice block', () => {
    // Push back against the post-training tendency toward diplomatic
    // smoothing, comfort-first phrasing, and unearned validation.
    // Grep-style assertions on the semantic beats rather than exact
    // copy so phrasing tweaks don't churn the test — but the three
    // load-bearing ideas (correctness over comfort, direct
    // corrections over rationalising, earned agreement only) must
    // survive any future edit to the block.
    const prompt = buildSystemPrompt();
    expect(prompt).toMatch(/correctness\s+over\s+comfort/i);
    expect(prompt).toMatch(/(rationalis|rationaliz)ing/i);
    expect(prompt).toMatch(/(unearned|earned)/i);
    // And the explicit non-goal: plain-spoken, not cold. Drop this
    // line and the block slides toward "robotic" — which is a
    // different failure mode than the one we're fixing.
    expect(prompt).toMatch(/not\s+cold|not\s+robotic|plain-spoken/i);
  });

  it('buildSystemPrompt lists every tool (always-on + gated) but omits toggle_toolbox itself', () => {
    const prompt = buildSystemPrompt();
    expect(prompt).toContain('memory_recall');
    expect(prompt).toContain('conversation_recall');
    expect(prompt).toContain('memory_search');
    expect(prompt).toContain('memory_create');
    expect(prompt).toContain('memory_update');
    expect(prompt).toContain('memory_delete');
    expect(prompt).toContain('conversation_search');
    // toggle_toolbox is the switch itself, not something to advertise
    // in either catalog section - the prompt block that explains the
    // toggle rule already names it.
    expect(prompt).not.toMatch(/^- toggle_toolbox/m);
  });

  it('buildSystemPrompt catalog lines are dynamically derived from the registry', () => {
    // Every tool other than `toggle_toolbox` appears as a catalog line
    // with its name + shortDescription, across the always-on section
    // and per-toolbox blocks. If a tool is added to a toolbox but
    // forgotten in the prompt code, this test catches the drift - the
    // prompt is always the live view.
    const prompt = buildSystemPrompt();
    const cataloged = TOOLS.filter((t: ToolDef) => t.name !== toggleToolbox.name);
    for (const tool of cataloged) {
      expect(prompt).toContain(`- ${tool.name} : ${tool.shortDescription}`);
    }
  });

  it('buildSystemPrompt groups gated tools under their toolbox with [x]/[ ] marks', () => {
    // Unchecked first - default state. `always_on` header should not
    // appear as a toolbox row; it has its own "Always available"
    // section above.
    const disabled = buildSystemPrompt({ enabledToolboxes: [] });
    const alwaysIdx = disabled.indexOf('Always available');
    const gatedIdx = disabled.indexOf('Toolboxes');
    expect(alwaysIdx).toBeGreaterThanOrEqual(0);
    expect(gatedIdx).toBeGreaterThan(alwaysIdx);

    // Recall pair lives under Always available; conversation_search
    // lives under the conversations toolbox.
    const alwaysSection = disabled.slice(alwaysIdx, gatedIdx);
    const gatedSection = disabled.slice(gatedIdx);
    expect(alwaysSection).toMatch(/- memory_recall /);
    expect(alwaysSection).toMatch(/- conversation_recall /);
    expect(alwaysSection).not.toMatch(/- conversation_search /);
    expect(gatedSection).toMatch(/- conversation_search /);
    expect(gatedSection).toMatch(/- memory_search /);
    expect(gatedSection).not.toMatch(/- memory_recall /);

    // Every gated toolbox gets a "[ ] name : description" line with
    // its tools indented below.
    expect(gatedSection).toMatch(/\[ \] cooking : /);
    expect(gatedSection).toMatch(/\[ \] memories : /);
    expect(gatedSection).toMatch(/\[ \] conversations : /);
  });

  it('buildSystemPrompt shows [x] marks for enabled toolboxes and [ ] for disabled ones', () => {
    // The marks give the model visible current state without a second
    // prompt section. A model reading "[x] cooking" knows it can
    // invoke the cooking tools this turn without a toolbox flip.
    const prompt = buildSystemPrompt({ enabledToolboxes: ['cooking'] });
    expect(prompt).toMatch(/\[x\] cooking : /);
    expect(prompt).toMatch(/\[ \] memories : /);
    expect(prompt).toMatch(/\[ \] conversations : /);
  });

  it('buildSystemPrompt carries recall cadence rules', () => {
    // The conversation-opens case is covered by the chat loop's
    // opening-recall pre-injection (see src/lib/opening-recall.ts),
    // NOT by the prompt - so the cadence block intentionally starts
    // at "topic clarifies / new info / new topic." The three
    // mid-conversation triggers here are what move the model from
    // "recall exists" to "recall gets used on every turn it should."
    // Grep-style assertions rather than exact-string so phrasing
    // tweaks don't break the test - but the semantics must survive.
    const prompt = buildSystemPrompt();
    expect(prompt).toMatch(/memory_recall/i);
    expect(prompt).toMatch(/land(s|ed)?\s+on\s+a\s+clear\s+topic/i);
    expect(prompt).toMatch(/new\s+information/i);
    expect(prompt).toMatch(/opens?\s+a\s+new\s+topic/i);
    expect(prompt).toMatch(/conversation_recall/);
    expect(prompt).toMatch(/(don\u2019t|don't)\s+make\s+the\s+user\s+repeat/i);
  });

  it('buildSystemPrompt explains the toggle_toolbox gating rule', () => {
    // The policy used to live on the toggle tool's own description;
    // it now belongs here so the model sees it before any gated
    // schemas are on the wire (empty toolboxes_enabled => only the
    // always-on set is sent). A drop here would let a model that
    // doesn't already know about toggle_toolbox try to call
    // memory_search directly.
    const prompt = buildSystemPrompt();
    expect(prompt).toMatch(/toggle_toolbox\(/);
    expect(prompt).toMatch(/enabled:\s*\[/);
  });

  it('buildSystemPrompt carries the user-message boundary rule and Venice-injection warning', () => {
    // Venice can inject content into what arrives as the user turn —
    // URL scraping (enable_web_scraping) is always on in venice.ts,
    // so any request where the user pasted a URL gets the full
    // scraped page inlined after their text. chat-loop.ts wraps the
    // current user turn unconditionally in <user_message>…</user_message>
    // as the structural boundary; this prompt block is the paired
    // instruction telling the model what to do with the tags.
    const prompt = buildSystemPrompt();
    expect(prompt).toContain('<user_message>');
    expect(prompt).toContain('</user_message>');
    // Behavior beats we don't want to lose on a future phrasing edit:
    // the explicit "not a human-authored instruction" frame, the
    // don't-thank-the-user guidance, and the "instructions come from
    // this system message" anchor that tells the model which source
    // of framing actually binds it.
    expect(prompt).toMatch(/not a human-authored/i);
    expect(prompt).toMatch(/do not thank/i);
    expect(prompt).toMatch(/instructions come from this system message/i);
  });

  it('buildSystemPrompt mentions URL scraping capability unconditionally', () => {
    // URL scraping is always on in venice.ts: any user turn with a
    // pasted link arrives with the page contents inlined. If the
    // prompt didn't say so, the model would refuse "what does this
    // page say?" with a generic "I cannot browse the web" even
    // though the scraped content is already sitting in the user
    // turn waiting to be read.
    const prompt = buildSystemPrompt();
    expect(prompt).toMatch(/paste[sd]?\s+a\s+url/i);
    expect(prompt).toMatch(/full\s+page\s+content/i);
  });

  it('web_search is always-on - rides with every request, listed in the always-available catalog', () => {
    // Web search is a reflex-level capability, same rationale as the
    // *_recall tools: the model should be able to reach for it on any
    // time-sensitive question without needing a toolbox toggle first.
    // This test is the tripwire for anyone moving it into a gated
    // toolbox.
    expect(buildToolList([]).map((t) => t.function.name)).toContain('web_search');
    expect(buildToolList(GATED_TOOLBOX_NAMES).map((t) => t.function.name)).toContain(
      'web_search'
    );
    // Catalog advertisement - the system prompt's "Always available"
    // section must mention web_search by name + shortDescription so
    // the model knows the tool exists. A gated placement would put
    // it inside one of the toolbox blocks further down.
    const prompt = buildSystemPrompt();
    expect(prompt).toMatch(
      /Always available \(no toggle needed\):[\s\S]*- web_search : search the live web/
    );
  });

  it('executeToolCall dispatches by name', async () => {
    const { svc, spies } = mockSupabase();
    await executeToolCall(
      'toggle_toolbox',
      { enabled: ['cooking'] },
      ctxFor(svc)
    );
    expect(spies.setThreadToolboxesEnabled).toHaveBeenCalledWith('t-1', ['cooking']);
  });

  it('executeToolCall throws on an unknown tool', async () => {
    const { svc } = mockSupabase();
    await expect(executeToolCall('bogus', {}, ctxFor(svc))).rejects.toThrow(
      /unknown tool/i
    );
  });
});

describe('toggle_toolbox', () => {
  it('writes the accepted name set through to Supabase', async () => {
    const { svc, spies } = mockSupabase();
    const result = await toggleToolbox.execute(
      { enabled: ['cooking', 'memories'] },
      ctxFor(svc)
    );
    expect(spies.setThreadToolboxesEnabled).toHaveBeenCalledWith('t-1', [
      'cooking',
      'memories',
    ]);
    expect(result).toEqual({ enabled: ['cooking', 'memories'] });
  });

  it('writes an empty array when passed {enabled: []}', async () => {
    // Explicit "turn everything off" path. The model is supposed to
    // call this when the current task is done with gated tools - we
    // must not silently reject it as a no-op.
    const { svc, spies } = mockSupabase();
    const result = await toggleToolbox.execute({ enabled: [] }, ctxFor(svc));
    expect(spies.setThreadToolboxesEnabled).toHaveBeenCalledWith('t-1', []);
    expect(result).toEqual({ enabled: [] });
  });

  it('silently drops unknown toolbox names', async () => {
    // A typo or rename should not abort the chat turn; the tool
    // return value tells the model what took effect so it can self-
    // correct.
    const { svc, spies } = mockSupabase();
    const result = await toggleToolbox.execute(
      { enabled: ['cooking', 'bogus', 'not_a_toolbox'] },
      ctxFor(svc)
    );
    expect(spies.setThreadToolboxesEnabled).toHaveBeenCalledWith('t-1', ['cooking']);
    expect(result).toEqual({ enabled: ['cooking'] });
  });

  it('drops the always_on toolbox if the model tries to list it', async () => {
    // always_on is implicit - listing it must not round-trip it into
    // the persisted array, where it would be an unrecognised name on
    // the next read.
    const { svc, spies } = mockSupabase();
    const result = await toggleToolbox.execute(
      { enabled: ['always_on', 'cooking'] },
      ctxFor(svc)
    );
    expect(spies.setThreadToolboxesEnabled).toHaveBeenCalledWith('t-1', ['cooking']);
    expect(result).toEqual({ enabled: ['cooking'] });
  });

  it('deduplicates repeated names while preserving first-seen order', async () => {
    const { svc, spies } = mockSupabase();
    const result = await toggleToolbox.execute(
      { enabled: ['cooking', 'memories', 'cooking'] },
      ctxFor(svc)
    );
    expect(spies.setThreadToolboxesEnabled).toHaveBeenCalledWith('t-1', [
      'cooking',
      'memories',
    ]);
    expect(result).toEqual({ enabled: ['cooking', 'memories'] });
  });

  it('treats non-array and non-string input as empty', async () => {
    // Defensive: the model might emit {enabled: null} or {enabled:
    // "cooking"} on a bad schema pass. Drop silently rather than
    // throwing - the turn keeps running and the model sees an empty
    // accepted set.
    const { svc, spies } = mockSupabase();
    const result = await toggleToolbox.execute(
      { enabled: 'cooking' as unknown as string[] },
      ctxFor(svc)
    );
    expect(spies.setThreadToolboxesEnabled).toHaveBeenCalledWith('t-1', []);
    expect(result).toEqual({ enabled: [] });
  });
});

describe('memory_search', () => {
  const tool = TOOLS.find((t: ToolDef) => t.name === 'memory_search')!;

  it('embeds the trimmed query and runs vector + ILIKE-fallback in parallel', async () => {
    const { svc, spies } = mockSupabase();
    const venice = mockVenice();
    await tool.execute({ query: '  foo  ' }, ctxFor(svc, venice));
    expect(venice.embed).toHaveBeenCalledWith(
      expect.objectContaining({ input: 'foo' })
    );
    // Vector path runs against the embedded rows; the ILIKE probe
    // covers just-written rows the worker hasn't embedded yet.
    expect(spies.searchMemoriesByEmbedding).toHaveBeenCalledOnce();
    expect(spies.searchUnembeddedMemoriesByText).toHaveBeenCalledWith('foo', 20);
    // The legacy ILIKE-everything path is only used for list-all (empty
    // query) now.
    expect(spies.searchMemories).not.toHaveBeenCalled();
  });

  it('pads the Venice query embedding to the storage dim before the similarity RPC', async () => {
    const { svc, spies } = mockSupabase();
    const venice = mockVenice();
    await tool.execute({ query: 'anything' }, ctxFor(svc, venice));
    // Venice's mock returns 1024 floats; the tool must pad to 2048 or
    // the RPC errors at pgvector's dimension check.
    const [embedding, limit] = spies.searchMemoriesByEmbedding.mock.calls[0];
    expect(embedding).toHaveLength(2048);
    // Prefix preserved, suffix zero-padded.
    expect(embedding.slice(1024).every((v: number) => v === 0)).toBe(true);
    expect(limit).toBe(20);
  });

  it('empty query lists everything via the legacy path', async () => {
    const { svc, spies } = mockSupabase();
    await tool.execute({}, ctxFor(svc));
    expect(spies.searchMemories).toHaveBeenCalledWith('', 20);
    expect(spies.searchMemoriesByEmbedding).not.toHaveBeenCalled();
  });

  it('clamps limit to the max', async () => {
    const { svc, spies } = mockSupabase();
    await tool.execute({ limit: 9999 }, ctxFor(svc));
    expect(spies.searchMemories).toHaveBeenCalledWith('', 100);
  });

  it('clamps limit to at least 1', async () => {
    const { svc, spies } = mockSupabase();
    await tool.execute({ limit: 0 }, ctxFor(svc));
    expect(spies.searchMemories).toHaveBeenCalledWith('', 1);
  });

  it('merges vector hits ahead of ILIKE fallback hits without duplicates', async () => {
    const { svc, spies } = mockSupabase();
    spies.searchMemoriesByEmbedding.mockResolvedValueOnce([
      { id: 'm1', label: 'a', data: 'a', created_at: 't', updated_at: 't' },
      { id: 'm2', label: 'b', data: 'b', created_at: 't', updated_at: 't' },
    ]);
    spies.searchUnembeddedMemoriesByText.mockResolvedValueOnce([
      // Overlap with a vector hit — should be deduped.
      { id: 'm2', label: 'b', data: 'b', created_at: 't', updated_at: 't' },
      // New row the worker hasn't caught up to yet.
      { id: 'm3', label: 'c', data: 'c', created_at: 't', updated_at: 't' },
    ]);
    const result = (await tool.execute({ query: 'q' }, ctxFor(svc))) as {
      id: string;
    }[];
    expect(result.map((r) => r.id)).toEqual(['m1', 'm2', 'm3']);
  });

  it('falls back to ILIKE when Venice returns no embedding', async () => {
    const { svc, spies } = mockSupabase();
    const venice = {
      embed: vi.fn(async () => ({ data: [] })),
    } as unknown as VeniceClient;
    await tool.execute({ query: 'foo' }, ctxFor(svc, venice));
    expect(spies.searchMemories).toHaveBeenCalledWith('foo', 20);
    expect(spies.searchMemoriesByEmbedding).not.toHaveBeenCalled();
  });
});

describe('memory_create', () => {
  const tool = TOOLS.find((t: ToolDef) => t.name === 'memory_create')!;

  it('trims label and forwards data', async () => {
    const { svc, spies } = mockSupabase();
    await tool.execute({ label: '  note  ', data: 'body' }, ctxFor(svc));
    expect(spies.createMemory).toHaveBeenCalledWith('note', 'body');
  });

  it('rejects a missing label', async () => {
    const { svc } = mockSupabase();
    await expect(tool.execute({ data: 'body' }, ctxFor(svc))).rejects.toThrow(
      /label/
    );
  });

  it('rejects a missing data', async () => {
    const { svc } = mockSupabase();
    await expect(tool.execute({ label: 'x' }, ctxFor(svc))).rejects.toThrow(
      /data/
    );
  });
});

describe('memory_update', () => {
  const tool = TOOLS.find((t: ToolDef) => t.name === 'memory_update')!;

  it('forwards a label-only patch', async () => {
    const { svc, spies } = mockSupabase();
    await tool.execute({ id: 'm1', label: 'new' }, ctxFor(svc));
    expect(spies.updateMemory).toHaveBeenCalledWith('m1', { label: 'new' });
  });

  it('forwards a data-only patch', async () => {
    const { svc, spies } = mockSupabase();
    await tool.execute({ id: 'm1', data: 'new' }, ctxFor(svc));
    expect(spies.updateMemory).toHaveBeenCalledWith('m1', { data: 'new' });
  });

  it('forwards both fields when given both', async () => {
    const { svc, spies } = mockSupabase();
    await tool.execute({ id: 'm1', label: 'a', data: 'b' }, ctxFor(svc));
    expect(spies.updateMemory).toHaveBeenCalledWith('m1', { label: 'a', data: 'b' });
  });

  it('rejects an empty patch', async () => {
    const { svc } = mockSupabase();
    await expect(tool.execute({ id: 'm1' }, ctxFor(svc))).rejects.toThrow(
      /at least one/
    );
  });

  it('rejects a missing id', async () => {
    const { svc } = mockSupabase();
    await expect(tool.execute({ label: 'x' }, ctxFor(svc))).rejects.toThrow(
      /id/
    );
  });
});

describe('memory_delete', () => {
  const tool = TOOLS.find((t: ToolDef) => t.name === 'memory_delete')!;

  it('forwards the id', async () => {
    const { svc, spies } = mockSupabase();
    const result = await tool.execute({ id: 'm1' }, ctxFor(svc));
    expect(spies.deleteMemory).toHaveBeenCalledWith('m1');
    expect(result).toEqual({ deleted: true });
  });

  it('rejects a missing id', async () => {
    const { svc } = mockSupabase();
    await expect(tool.execute({}, ctxFor(svc))).rejects.toThrow(/id/);
  });
});

describe('memoryToolbox', () => {
  it('swaps memory_delete for memory_invalidate — agents get soft-delete only', () => {
    // Soft-delete by design: an autonomous agent shouldn't be hard-
    // erasing user data based on its own reading of the conversation.
    // memory_delete stays available to the main chat (user-directed
    // "forget X"). memory_invalidate halves confidence; recoverable.
    const names = memoryToolbox.tools.map((t) => t.name);
    expect(names).toEqual([
      'memory_search',
      'memory_create',
      'memory_update',
      'memory_invalidate',
    ]);
    expect(names).not.toContain('memory_delete');
    expect(names).not.toContain('toggle_tools');
  });

  it('carries a stable name and a non-empty description for downstream prompts', () => {
    expect(memoryToolbox.name).toBe('memory');
    expect(memoryToolbox.description.length).toBeGreaterThan(0);
  });
});

describe('memory_invalidate', () => {
  const tool = memoryToolbox.tools.find((t) => t.name === 'memory_invalidate')!;

  it('calls decayMemoryConfidence and returns the new confidence', async () => {
    const { svc, spies } = mockSupabase();
    const result = await tool.execute({ id: 'm1' }, ctxFor(svc));
    expect(spies.decayMemoryConfidence).toHaveBeenCalledWith('m1');
    expect(result).toEqual({ id: 'm1', confidence: 0.5 });
  });

  it('propagates a smaller post-decay confidence from the server', async () => {
    // A memory that's been decayed multiple times comes back from the
    // server below the search floor; the tool must reflect that value
    // untouched so the agent can see how close to invisibility it is.
    const { svc, spies } = mockSupabase();
    spies.decayMemoryConfidence.mockResolvedValueOnce(0.03125);
    const result = await tool.execute({ id: 'm9' }, ctxFor(svc));
    expect(result).toEqual({ id: 'm9', confidence: 0.03125 });
  });

  it('rejects a missing id', async () => {
    const { svc } = mockSupabase();
    await expect(tool.execute({}, ctxFor(svc))).rejects.toThrow(/id/);
  });

  it('surfaces a not-found as an error rather than silently no-op', async () => {
    // If the RPC returns null (row missing or RLS blocked), the tool
    // must throw so the agent sees a failure on its next turn — a
    // silent success would let the agent think it had soft-deleted
    // something it hadn't and skip the memory_update path that would
    // have fixed the root cause.
    const { svc, spies } = mockSupabase();
    spies.decayMemoryConfidence.mockResolvedValueOnce(null);
    await expect(tool.execute({ id: 'gone' }, ctxFor(svc))).rejects.toThrow(/not found/);
  });
});

describe('conversationRecallToolbox', () => {
  it('exposes only conversation_search — no write tools, no recall recursion', () => {
    // Sibling of recallToolbox but against threads. A bug in the
    // conversation-recall prompt that routed into a write or a
    // nested recall call would be a fresh class of mistake; the
    // registry shape is the tripwire. If someone adds
    // conversation_recall or a thread-mutation tool here, this test
    // points at the drift.
    const names = conversationRecallToolbox.tools.map((t) => t.name);
    expect(names).toEqual(['conversation_search']);
    expect(names).not.toContain('conversation_recall');
    expect(names).not.toContain('memory_search');
    expect(names).not.toContain('toggle_tools');
  });

  it('carries a stable name and a non-empty description for downstream prompts', () => {
    expect(conversationRecallToolbox.name).toBe('conversation-recall');
    expect(conversationRecallToolbox.description.length).toBeGreaterThan(0);
  });
});

describe('recall surface scoping — cross-toolbox', () => {
  it('memory_recall is absent from every non-main toolbox', () => {
    for (const tb of [memoryToolbox, recallToolbox, conversationRecallToolbox]) {
      expect(tb.tools.map((t) => t.name)).not.toContain('memory_recall');
    }
  });

  it('conversation_recall is absent from every non-main toolbox', () => {
    for (const tb of [memoryToolbox, recallToolbox, conversationRecallToolbox]) {
      expect(tb.tools.map((t) => t.name)).not.toContain('conversation_recall');
    }
  });
});

describe('buildToolboxWireList', () => {
  it('projects every tool in the toolbox to the OpenAI wire shape, in declared order', () => {
    const wire = buildToolboxWireList(memoryToolbox);
    expect(wire.map((t) => t.function.name)).toEqual(
      memoryToolbox.tools.map((t) => t.name)
    );
    for (const item of wire) {
      expect(item.type).toBe('function');
      expect(typeof item.function.description).toBe('string');
      expect(typeof item.function.parameters).toBe('object');
    }
  });

  it('returns an empty array for an empty toolbox — no implicit fallback', () => {
    const empty: Toolbox = { name: 'empty', description: 'nothing', tools: [] };
    expect(buildToolboxWireList(empty)).toEqual([]);
  });
});

describe('executeToolboxCall', () => {
  it('dispatches to the named tool within the given toolbox', async () => {
    const { svc, spies } = mockSupabase();
    await executeToolboxCall(memoryToolbox, 'memory_create', { label: 'x', data: 'y' }, ctxFor(svc));
    expect(spies.createMemory).toHaveBeenCalledWith('x', 'y');
  });

  it("throws with the toolbox name in the message when the tool isn't in this toolbox", async () => {
    // `toggle_tools` IS a real ToolDef in the global registry, but it's
    // deliberately absent from memoryToolbox — so a dispatch against
    // this toolbox must refuse it. The error names the toolbox so
    // memory-agent errors don't read identically to main-chat errors.
    const { svc } = mockSupabase();
    await expect(
      executeToolboxCall(memoryToolbox, 'toggle_tools', { enable: true }, ctxFor(svc))
    ).rejects.toThrow(/toolbox 'memory'/);
  });

  it('throws on an entirely unknown tool name', async () => {
    const { svc } = mockSupabase();
    await expect(
      executeToolboxCall(memoryToolbox, 'no_such_tool', {}, ctxFor(svc))
    ).rejects.toThrow(/no_such_tool/);
  });

  it('honors a caller-supplied toolbox over the global registry (isolation)', async () => {
    // Regression guard: a toolbox must only reach its declared tools,
    // never fall through to TOOLS. A custom toolbox with a single
    // stub handler should run the stub — not the real memory_create.
    const { svc, spies } = mockSupabase();
    const stub = vi.fn(async () => ({ stubbed: true }));
    const custom: Toolbox = {
      name: 'custom',
      description: 'one fake tool',
      tools: [
        {
          name: 'memory_create',
          description: 'stub',
          shortDescription: 'stub',
          parameters: {},
          execute: stub,
        } satisfies ToolDef,
      ],
    };
    const result = await executeToolboxCall(custom, 'memory_create', {}, ctxFor(svc));
    expect(stub).toHaveBeenCalledOnce();
    expect(result).toEqual({ stubbed: true });
    expect(spies.createMemory).not.toHaveBeenCalled();
  });
});
