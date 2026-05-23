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
  wikiToolbox,
  buildToolList,
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
import { sanitizeTitle } from '../src/lib/tools/update_title';
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
    getMemoryById: ReturnType<typeof vi.fn>;
    createMemoryChangelogEntry: ReturnType<typeof vi.fn>;
    decayMemoryConfidence: ReturnType<typeof vi.fn>;
    renameThread: ReturnType<typeof vi.fn>;
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
    getMemoryById: vi.fn(async (id: string) => ({
      id,
      label: 'snapshot',
      data: 'body',
      confidence: 1.0,
      topics: [],
      created_at: 't',
      updated_at: 't',
    })),
    createMemoryChangelogEntry: vi.fn(async () => undefined),
    // Reflection-agent soft delete: server returns the post-decay
    // confidence. Default mock returns 0.5 — one halving from the 1.0
    // seed value.
    decayMemoryConfidence: vi.fn(async () => 0.5),
    renameThread: vi.fn(async () => undefined),
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

  it('buildToolList with no enabled toolboxes returns the full read-only set plus the meta-tools', () => {
    // Always-on now carries every read surface in addition to the
    // reflex-level meta-tools. The "no toolbox is on" payload includes
    // the umbrella `context` recall, the three per-layer recall tools
    // (memory / conversation / wiki), the search/list/read tools
    // across memories / conversations / wiki / cookbook, the
    // research_docs sub-agent, web search, the title-rename
    // convenience, the vision sub-call, and the toggle_toolbox meta-
    // tool itself. This test is the tripwire for someone accidentally
    // moving a write tool into the always-on set or dropping a read
    // tool out of it.
    const list = buildToolList([]);
    expect(list.map((t) => t.function.name).sort()).toEqual(
      [
        'analyze_image',
        'ask_user',
        'context',
        'conversation_recall',
        'conversation_search',
        'memory_recall',
        'memory_search',
        'recipe_get',
        'recipe_list',
        'research_docs',
        'toggle_toolbox',
        'update_title',
        'web_search',
        'wiki_get',
        'wiki_list',
        'wiki_recall',
        'wiki_search',
      ]
    );
  });

  it('buildToolList hides write tools until their toolbox is enabled', () => {
    // Writes still gate. Reads are always-on. Name every tool that
    // MUST be gated here so an accidental promotion to always-on
    // trips the test.
    const disabled = buildToolList([]).map((t) => t.function.name);
    for (const gated of [
      'memory_create',
      'memory_update',
      'memory_delete',
      'memory_reaffirm',
      'memory_doubt',
      'memory_relate',
      'memory_unrelate',
      'recipe_save',
      'recipe_update',
      'recipe_delete',
      'recipe_photos_attach',
      'recipe_photos_remove',
      'recipe_photos_reorder',
      'recipe_photo_label_set',
      'wiki_librarian',
    ]) {
      expect(disabled).not.toContain(gated);
    }
  });

  it('buildToolList(["cooking"]) exposes cooking writes and no memory writes', () => {
    const names = buildToolList(['cooking']).map((t) => t.function.name);
    expect(names).toContain('recipe_save');
    expect(names).toContain('recipe_update');
    expect(names).toContain('recipe_delete');
    expect(names).toContain('recipe_photos_attach');
    // Read paths are always-on, regardless of which gated toolbox is on.
    expect(names).toContain('recipe_list');
    expect(names).toContain('recipe_get');
    // Memory writes stay gated behind their own toolbox.
    expect(names).not.toContain('memory_create');
    // Always-on meta-tools ride along.
    expect(names).toContain('toggle_toolbox');
    expect(names).toContain('memory_recall');
  });

  it('buildToolList(["memories"]) exposes memory writes; reads stay always-on', () => {
    const names = buildToolList(['memories']).map((t) => t.function.name);
    expect(names).toContain('memory_create');
    expect(names).toContain('memory_update');
    expect(names).toContain('memory_delete');
    expect(names).toContain('memory_reaffirm');
    // memory_search is always-on, not in the memories toolbox.
    expect(names).toContain('memory_search');
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
    expect(names).toContain('recipe_save');
    // memory_create is the load-bearing "would only be present if
    // 'memories' were enabled" tripwire - it stays absent when only
    // 'cooking' is on, even though the silently-dropped 'nonsense'
    // shares its toolbox slot with us.
    expect(names).not.toContain('memory_create');
  });

  it('buildToolList always includes always-on tools even when always_on is named explicitly', () => {
    // `always_on` is implicit - listing it in the enabled array does
    // nothing (we already include it) and does not enable any gated
    // toolbox.
    const names = buildToolList(['always_on']).map((t) => t.function.name);
    expect(names).toContain('toggle_toolbox');
    expect(names).toContain('web_search');
    // Read paths now always-on regardless of toolbox state.
    expect(names).toContain('memory_search');
    expect(names).toContain('recipe_list');
    // Writes still gate.
    expect(names).not.toContain('recipe_save');
    expect(names).not.toContain('memory_create');
  });

  it('TOOLBOXES exposes the canonical ordered list with always_on first', () => {
    // Order is visible to the model (system-prompt catalog) and to the
    // user (popover list). always_on first so the reflex-level
    // surfaces are read before the gated catalog. The
    // `conversations` and `research` toolboxes were dropped when their
    // only members (conversation_search, research_docs) moved into
    // the always-on set - empty gated toolboxes have no purpose.
    expect(TOOLBOXES[0]).toBe(alwaysOnToolbox);
    expect(TOOLBOXES.map((tb) => tb.name)).toEqual([
      'always_on',
      'cooking',
      'memories',
      'wiki',
    ]);
  });

  it('GATED_TOOLBOX_NAMES lists every gated toolbox and omits always_on', () => {
    expect(GATED_TOOLBOX_NAMES).toEqual([
      'cooking',
      'memories',
      'wiki',
    ]);
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
      'wiki',
    ]);
    for (const m of GATED_TOOLBOX_META) {
      expect(typeof m.description).toBe('string');
      expect(m.description.length).toBeGreaterThan(0);
    }
  });

  it('cookingToolbox, memoriesToolbox, and wikiToolbox are write-only subsets', () => {
    // Reads (recipe_list, recipe_get, memory_search, wiki_search,
    // wiki_list, wiki_get) live in alwaysOnToolbox. The gated boxes
    // carry only the writes a user-or-model gate has to authorise.
    expect(cookingToolbox.tools.map((t: ToolDef) => t.name)).toEqual([
      'recipe_save',
      'recipe_update',
      'recipe_delete',
      'recipe_photos_attach',
      'recipe_photos_remove',
      'recipe_photos_reorder',
      'recipe_photo_label_set',
    ]);
    expect(memoriesToolbox.tools.map((t: ToolDef) => t.name)).toEqual([
      'memory_create',
      'memory_update',
      'memory_delete',
      'memory_reaffirm',
      'memory_doubt',
      'memory_relate',
      'memory_unrelate',
    ]);
    // The wiki toolbox carries the librarian-delegation tool only;
    // direct wiki_create / wiki_update / wiki_delete are agent-only
    // (the autonomous wiki agent and the librarian itself) and are
    // deliberately NOT exposed to the main chat at any toggle state.
    expect(wikiToolbox.tools.map((t: ToolDef) => t.name)).toEqual([
      'wiki_librarian',
    ]);
  });

  it('buildToolList(["wiki"]) exposes the librarian; reads stay always-on', () => {
    const names = buildToolList(['wiki']).map((t) => t.function.name);
    expect(names).toContain('wiki_librarian');
    // Wiki reads are always-on, not in the wiki toolbox.
    expect(names).toContain('wiki_search');
    expect(names).toContain('wiki_list');
    expect(names).toContain('wiki_get');
    // Direct wiki writes never reach the main chat - they are agent-
    // only. If one of these ever leaks into the main catalog the
    // librarian-only mutation policy has been bypassed.
    expect(names).not.toContain('wiki_create');
    expect(names).not.toContain('wiki_update');
    expect(names).not.toContain('wiki_delete');
    expect(names).not.toContain('recipe_save');
    expect(names).not.toContain('memory_create');
  });

  it('alwaysOnToolbox carries every read-only surface', () => {
    // Tripwire for the read-tools-always-on contract. If a read tool
    // gets demoted out of the always-on set, this test names which.
    const names = alwaysOnToolbox.tools.map((t: ToolDef) => t.name);
    for (const expected of [
      'toggle_toolbox',
      'memory_recall',
      'conversation_recall',
      'wiki_recall',
      'memory_search',
      'conversation_search',
      'wiki_search',
      'wiki_list',
      'wiki_get',
      'recipe_list',
      'recipe_get',
      'research_docs',
      'web_search',
      'update_title',
      'analyze_image',
    ]) {
      expect(names).toContain(expected);
    }
    // And no writes leak into always-on.
    for (const write of [
      'memory_create',
      'memory_delete',
      'recipe_save',
      'recipe_update',
      'recipe_delete',
      'wiki_librarian',
    ]) {
      expect(names).not.toContain(write);
    }
  });

  it('toOpenAIToolDef projects to the function-calling wire shape', () => {
    const wire = toOpenAIToolDef(toggleToolbox);
    expect(wire.type).toBe('function');
    expect(wire.function.name).toBe(toggleToolbox.name);
    expect(wire.function.description).toBe(toggleToolbox.description);
    // The tool's own properties survive intact...
    const params = wire.function.parameters as {
      type: string;
      properties: Record<string, unknown>;
      required: string[];
    };
    expect(params.type).toBe('object');
    expect(params.properties.enabled).toEqual(
      (toggleToolbox.parameters as { properties: { enabled: unknown } }).properties.enabled
    );
    // ...plus the injected `activity` string everybody gets.
    expect(params.properties.activity).toMatchObject({ type: 'string' });
    expect(params.required).toContain('activity');
  });

  it('toOpenAIToolDef injects the activity param into every tool without mutating the source', () => {
    // Every tool in the registry gets the injected `activity` string
    // at the wire-projection seam (see src/lib/tools/dispatch.ts).
    // The source ToolDef.parameters must NOT be mutated - otherwise
    // successive calls would accumulate duplicates, and tests that
    // read `.parameters` off the tool expecting pristine data would
    // see a shifting shape.
    for (const tool of TOOLS) {
      const wire = toOpenAIToolDef(tool);
      const params = wire.function.parameters as {
        type?: string;
        properties: Record<string, unknown>;
        required: string[];
      };
      expect(params.properties.activity).toMatchObject({ type: 'string' });
      expect(params.required).toContain('activity');
      // Source untouched.
      const source = tool.parameters as {
        properties?: Record<string, unknown>;
        required?: string[];
      };
      expect(source.properties?.activity).toBeUndefined();
      expect(source.required ?? []).not.toContain('activity');
    }
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
    expect(spies.searchUnembeddedMemoriesByText).toHaveBeenCalledWith('foo', 20, []);
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
    // The third argument is the empty selectedTopics filter -
    // searchMemoriesSemantic always threads it through (defaults to
    // [] when the caller doesn't supply one, which the tool path
    // doesn't because the model has no topic-selection UI).
    expect(spies.searchMemories).toHaveBeenCalledWith('', 20, []);
    expect(spies.searchMemoriesByEmbedding).not.toHaveBeenCalled();
  });

  it('clamps limit to the max', async () => {
    const { svc, spies } = mockSupabase();
    await tool.execute({ limit: 9999 }, ctxFor(svc));
    expect(spies.searchMemories).toHaveBeenCalledWith('', 100, []);
  });

  it('clamps limit to at least 1', async () => {
    const { svc, spies } = mockSupabase();
    await tool.execute({ limit: 0 }, ctxFor(svc));
    expect(spies.searchMemories).toHaveBeenCalledWith('', 1, []);
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
    expect(spies.searchMemories).toHaveBeenCalledWith('foo', 20, []);
    expect(spies.searchMemoriesByEmbedding).not.toHaveBeenCalled();
  });
});

describe('memory_create', () => {
  const tool = TOOLS.find((t: ToolDef) => t.name === 'memory_create')!;

  it('trims label and forwards data', async () => {
    const { svc, spies } = mockSupabase();
    await tool.execute({ label: '  note  ', data: 'body', message: 'note it' }, ctxFor(svc));
    // Third arg is `confidence`, optional; omitting passes undefined
    // through so the DB default (1.0) applies.
    expect(spies.createMemory).toHaveBeenCalledWith('note', 'body', undefined);
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
    await tool.execute({ id: 'm1', label: 'new', message: 'rename' }, ctxFor(svc));
    expect(spies.updateMemory).toHaveBeenCalledWith('m1', { label: 'new' });
  });

  it('forwards a data-only patch', async () => {
    const { svc, spies } = mockSupabase();
    await tool.execute({ id: 'm1', data: 'new', message: 'reword' }, ctxFor(svc));
    expect(spies.updateMemory).toHaveBeenCalledWith('m1', { data: 'new' });
  });

  it('forwards both fields when given both', async () => {
    const { svc, spies } = mockSupabase();
    await tool.execute({ id: 'm1', label: 'a', data: 'b', message: 'edit' }, ctxFor(svc));
    expect(spies.updateMemory).toHaveBeenCalledWith('m1', { label: 'a', data: 'b' });
  });

  it('rejects an empty patch', async () => {
    const { svc } = mockSupabase();
    await expect(tool.execute({ id: 'm1', message: 'm' }, ctxFor(svc))).rejects.toThrow(
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
    const result = await tool.execute({ id: 'm1', message: 'remove it' }, ctxFor(svc));
    expect(spies.deleteMemory).toHaveBeenCalledWith('m1');
    expect(result).toEqual({ deleted: true });
  });

  it('rejects a missing id', async () => {
    const { svc } = mockSupabase();
    await expect(tool.execute({}, ctxFor(svc))).rejects.toThrow(/id/);
  });
});

describe('sanitizeTitle', () => {
  // Observed failure: the model occasionally ignores the "concise 3-6
  // word title" instruction and stuffs its full response into the
  // title argument ("Holy Spirit Origins in Christianity\n\nThe
  // concept of..."). Without the first-line collapse, the embedded
  // newline survives and an 80-char slice stores a multi-line title
  // whose second line is a truncated paragraph - the sidebar then
  // renders it as wrapped garbage.
  it('takes only the first non-empty line when the model embeds the response', () => {
    const raw = 'Holy Spirit Origins in Christianity\n\nThe concept of the "Holy Spirit" (Greek: *P';
    expect(sanitizeTitle(raw)).toBe('Holy Spirit Origins in Christianity');
  });

  it('skips leading blank lines and uses the first content line', () => {
    expect(sanitizeTitle('\n\n  Lateral Thinking Definition  \n\nbody...')).toBe(
      'Lateral Thinking Definition'
    );
  });

  it('CRLF line endings split the same as LF', () => {
    expect(sanitizeTitle('Pancake Recipe Tool Test\r\n\r\nSure, testing tool calls...')).toBe(
      'Pancake Recipe Tool Test'
    );
  });

  it('still trims and strips wrapping quotes on a single-line title', () => {
    expect(sanitizeTitle('  "Casual Howdy Greeting."  ')).toBe('Casual Howdy Greeting');
  });

  it('caps a long single line at 80 chars (response-as-title fallback)', () => {
    const raw =
      'Hafa adai is a Chamorro greeting from Guam meaning "hello." It is not a band, common';
    const out = sanitizeTitle(raw);
    expect(out.length).toBeLessThanOrEqual(80);
    expect(out).toBe(raw.slice(0, 80));
  });

  it('returns empty string when the input is only whitespace / newlines', () => {
    expect(sanitizeTitle('\n\n   \r\n  ')).toBe('');
  });

  // Smaller / instruction-loose models routinely emit lowercase titles
  // despite the "title-case is fine" prompt. Without normalization, the
  // sidebar renders an inconsistent mix of capitalized (manual,
  // tool-driven) and lowercase (worker-titled by a weaker model)
  // entries that reads as half-done. Force first-character uppercase so
  // every model-generated title lands looking the same.
  it('uppercases the first character on a lowercase title', () => {
    expect(sanitizeTitle('troubleshooting the refrigerator')).toBe(
      'Troubleshooting the refrigerator'
    );
  });

  it('leaves an already-capitalized title alone', () => {
    expect(sanitizeTitle('Holy Spirit Origins in Christianity')).toBe(
      'Holy Spirit Origins in Christianity'
    );
  });

  it('only touches the first character - mid-word casing survives', () => {
    // The model deliberately picked the iOS casing; only char 0 is ours
    // to normalize.
    expect(sanitizeTitle('iOS upgrade walkthrough')).toBe('IOS upgrade walkthrough');
  });

  it('uppercases after stripping a wrapping quote', () => {
    // Quote stripping runs before capitalization, so the post-strip
    // first character is what gets normalized - not the quote.
    expect(sanitizeTitle('"casual howdy greeting"')).toBe('Casual howdy greeting');
  });

  it('is a no-op on a leading non-letter character', () => {
    // toLocaleUpperCase on a digit / symbol returns it unchanged, so a
    // title that opens with "5 reasons ..." stays "5 reasons ...".
    expect(sanitizeTitle('5 reasons to refactor')).toBe('5 reasons to refactor');
  });

  it('uppercases unicode letters via toLocaleUpperCase', () => {
    expect(sanitizeTitle('édition spéciale du livre')).toBe('Édition spéciale du livre');
  });
});

describe('update_title', () => {
  const tool = TOOLS.find((t: ToolDef) => t.name === 'update_title')!;

  it('passes the sanitised first line through to renameThread', async () => {
    const { svc, spies } = mockSupabase();
    const result = await tool.execute(
      { title: 'Holy Spirit Origins in Christianity\n\nThe concept of the Holy Spirit...' },
      ctxFor(svc)
    );
    expect(spies.renameThread).toHaveBeenCalledWith(
      't-1',
      'Holy Spirit Origins in Christianity'
    );
    expect(result).toEqual({ title: 'Holy Spirit Origins in Christianity' });
  });

  it('rejects a title that sanitises to empty', async () => {
    const { svc } = mockSupabase();
    await expect(
      tool.execute({ title: '\n\n   \r\n  ' }, ctxFor(svc))
    ).rejects.toThrow(/title/);
  });
});

describe('memoryToolbox', () => {
  it('swaps memory_delete for memory_invalidate — agents get soft-delete only', () => {
    // Soft-delete by design: an autonomous agent shouldn't be hard-
    // erasing user data based on its own reading of the conversation.
    // memory_delete stays available to the main chat (user-directed
    // "forget X"). memory_invalidate halves confidence; recoverable.
    // The volitional-memory additions (reaffirm/doubt/relate/unrelate)
    // ride alongside - finer-grained nudges plus the graph layer.
    const names = memoryToolbox.tools.map((t) => t.name);
    expect(names).toEqual([
      'memory_search',
      'memory_create',
      'memory_update',
      'memory_invalidate',
      'memory_reaffirm',
      'memory_doubt',
      'memory_relate',
      'memory_unrelate',
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
    await executeToolboxCall(memoryToolbox, 'memory_create', { label: 'x', data: 'y', message: 'note' }, ctxFor(svc));
    // createMemory now takes an optional third `confidence` arg; the
    // tool passes `undefined` when the caller doesn't supply one.
    expect(spies.createMemory).toHaveBeenCalledWith('x', 'y', undefined);
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
