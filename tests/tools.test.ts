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
import { describe, it, expect } from 'vitest';
import {
  TOOLS,
  TOOLBOXES,
  alwaysOnToolbox,
  cookingToolbox,
  memoriesToolbox,
  wikiToolbox,
  buildToolList,
  toOpenAIToolDef,
  type ToolDef,
} from '../src/lib/tools';

describe('tool registry', () => {
  it('exposes every memory + conversation tool', () => {
    const names = TOOLS.map((t: ToolDef) => t.name);
    expect(names).toContain('memory_recall');
    expect(names).toContain('memory_search');
    expect(names).toContain('memory_save');
    expect(names).toContain('memory_delete');
    expect(names).toContain('conversation_recall');
    expect(names).toContain('conversation_search');
  });

  it('declares every tool on every request', () => {
    // No gating: buildToolList([]) is the full catalog the chat-loop
    // ships. The serving backend holds the model to the declared list
    // and silently drops a call to an undeclared tool, so withholding
    // a tool here would be a silent failure the model cannot see.
    const names = buildToolList([]).map((t) => t.function.name).sort();
    expect(names).toEqual(TOOLS.map((t: ToolDef) => t.name).sort());
    expect(names).toContain('recipe_update');
    expect(names).toContain('memory_save');
  });

  it('declares every MCP toolbox too', () => {
    const mcp: Parameters<typeof buildToolList>[0] = [
      {
        name: 'mcp:fake',
        description: 'Fake',
        tools: [
          {
            name: 'mcp:fake:ping',
            description: 'Ping',
            shortDescription: 'ping',
            parameters: { type: 'object', properties: {}, additionalProperties: false },
            execute: async () => ({}),
          },
        ],
      },
    ];
    const names = buildToolList(mcp).map((t) => t.function.name);
    expect(names).toContain('mcp:fake:ping');
    // Static + dynamic compose under one dedup-by-name pass.
    expect(names).toContain('memory_recall');
  });

  it('TOOLBOXES exposes the canonical ordered list with always_on first', () => {
    // Order is visible to the model (system-prompt catalog). always_on
    // first so the read-only surfaces are read before the write
    // catalog. The `conversations` and `research` toolboxes were
    // dropped when their only members (conversation_search,
    // research_docs) moved into the always-on set.
    expect(TOOLBOXES[0]).toBe(alwaysOnToolbox);
    expect(TOOLBOXES.map((tb) => tb.name)).toEqual([
      'always_on',
      'cooking',
      'memories',
      'wiki',
      'followups',
      'library',
      'images',
    ]);
  });

  it('cookingToolbox, memoriesToolbox, and wikiToolbox are write-only subsets', () => {
    // Reads (recipe_list, recipe_get, memory_search, wiki_search,
    // wiki_list, wiki_get) live in alwaysOnToolbox. The write boxes
    // carry only the tools that mutate user data.
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
      'memory_save',
      'memory_delete',
      'memory_reaffirm',
      'memory_doubt',
      'memory_relate',
      'memory_unrelate',
    ]);
    // The wiki toolbox carries the whole chat-driven wiki write
    // surface: direct article CRUD, the librarian delegation, and the
    // record writes (records + files + links). Reads stay in
    // always-on.
    expect(wikiToolbox.tools.map((t: ToolDef) => t.name)).toEqual([
      'wiki_save',
      'wiki_delete',
      'wiki_librarian',
      'record_create',
      'record_update',
      'record_delete',
      'record_file_attach',
      'record_file_remove',
      'record_link_create',
      'record_link_delete',
    ]);
  });

  it('alwaysOnToolbox carries every read-only surface and no writes', () => {
    // Tripwire for the read-tools-always-on contract. If a read tool
    // gets demoted out of the always-on set, this test names which.
    const names = alwaysOnToolbox.tools.map((t: ToolDef) => t.name);
    for (const expected of [
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
      'analyze_pdf_page',
    ]) {
      expect(names).toContain(expected);
    }
    // And no writes leak into always-on.
    for (const write of [
      'memory_save',
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
    const tool = cookingToolbox.tools[0];
    const wire = toOpenAIToolDef(tool);
    expect(wire.type).toBe('function');
    expect(wire.function.name).toBe(tool.name);
    expect(wire.function.description).toBe(tool.description);
    // ...plus the injected `activity` string everybody gets.
    const params = wire.function.parameters as {
      type: string;
      properties: Record<string, unknown>;
      required: string[];
    };
    expect(params.type).toBe('object');
    expect(params.properties.activity).toMatchObject({ type: 'string' });
    expect(params.required).toContain('activity');
  });

  it('toOpenAIToolDef injects the activity param into every tool without mutating the source', () => {
    // Every tool in the registry gets the injected `activity` string
    // at the wire-projection seam (see src/lib/tools/wire.ts).
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
});

// The agent-only memory toolboxes' composition (soft-decay set,
// memory_invalidate in place of memory_delete, the librarian's
// no-create/no-update rules) and every tool impl's behavior are
// enforced server-side - see supabase/functions/tests/
// {reflection,memory_librarian,memory_consolidate}.test.ts. The
// browser registry is schema-only; nothing dispatches here.
