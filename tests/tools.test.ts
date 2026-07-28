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
  GATED_TOOLBOX_NAMES,
  GATED_TOOLBOX_META,
  alwaysOnToolbox,
  cookingToolbox,
  memoriesToolbox,
  wikiToolbox,
  buildToolList,
  toOpenAIToolDef,
  toggleToolbox,
  type ToolDef,
} from '../src/lib/tools';
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
    // convenience, the two vision sub-calls (analyze_image for pictures,
    // analyze_pdf_page for a rasterized PDF page), and the toggle_toolbox
    // meta-tool itself. This test is the tripwire for someone accidentally
    // moving a write tool into the always-on set or dropping a read
    // tool out of it.
    const list = buildToolList([]);
    expect(list.map((t) => t.function.name).sort()).toEqual(
      [
        'analyze_image',
        'analyze_pdf_page',
        'ask_user',
        'context',
        'conversation_get',
        'conversation_recall',
        'conversation_search',
        'doc_get',
        'doc_grep',
        'doc_list',
        'doc_read',
        'followup_list',
        'memory_get',
        'memory_recall',
        'memory_search',
        'recipe_get',
        'recipe_list',
        'record_get',
        'record_list',
        'record_search',
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
      'wiki_create',
      'wiki_update',
      'wiki_delete',
      'wiki_librarian',
      'record_create',
      'record_update',
      'record_delete',
      'record_file_attach',
      'record_file_remove',
      'record_link_create',
      'record_link_delete',
      'doc_create',
      'doc_update',
      'doc_delete',
      'followup_create',
      'followup_update',
      'followup_close',
      'followup_dismiss',
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
      'followups',
      'library',
      'images',
    ]);
  });

  it('GATED_TOOLBOX_NAMES lists every gated toolbox and omits always_on', () => {
    expect(GATED_TOOLBOX_NAMES).toEqual([
      'cooking',
      'memories',
      'wiki',
      'followups',
      'library',
      'images',
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
      'followups',
      'library',
      'images',
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
    // The wiki toolbox is the single gate for every chat-driven wiki
    // write: direct article CRUD, the librarian delegation, and the
    // full record write surface (records + files + links). Reads stay
    // always-on.
    expect(wikiToolbox.tools.map((t: ToolDef) => t.name)).toEqual([
      'wiki_create',
      'wiki_update',
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

  it('buildToolList(["wiki"]) exposes every wiki write; reads stay always-on', () => {
    // The wiki toolbox gates the whole chat-driven wiki write surface in
    // one toggle: direct article CRUD, the librarian delegation, and the
    // record writes (records + files + links). The matching reads stay
    // always-on like every other read surface.
    const names = buildToolList(['wiki']).map((t) => t.function.name);
    // Article CRUD - direct, no longer librarian-only.
    expect(names).toContain('wiki_create');
    expect(names).toContain('wiki_update');
    expect(names).toContain('wiki_delete');
    // The librarian rides alongside the direct tools for multi-article
    // consolidations.
    expect(names).toContain('wiki_librarian');
    // Record writes + file/link writes share the same gate.
    expect(names).toContain('record_create');
    expect(names).toContain('record_update');
    expect(names).toContain('record_delete');
    expect(names).toContain('record_file_attach');
    expect(names).toContain('record_file_remove');
    expect(names).toContain('record_link_create');
    expect(names).toContain('record_link_delete');
    // Reads are always-on, not in the gated toolbox.
    expect(names).toContain('wiki_search');
    expect(names).toContain('wiki_list');
    expect(names).toContain('wiki_get');
    expect(names).toContain('record_list');
    expect(names).toContain('record_get');
    expect(names).toContain('record_search');
    // Unrelated write boxes stay closed.
    expect(names).not.toContain('recipe_save');
    expect(names).not.toContain('memory_create');
  });

  it('wiki writes stay hidden until the wiki toolbox is enabled', () => {
    // The whole wiki write surface gates - a chat turn with no toolbox
    // on can read the wiki but never mutate it.
    const off = buildToolList([]).map((t) => t.function.name);
    for (const write of [
      'wiki_create',
      'wiki_update',
      'wiki_delete',
      'record_create',
      'record_update',
      'record_delete',
      'record_file_attach',
      'record_file_remove',
      'record_link_create',
      'record_link_delete',
    ]) {
      expect(off).not.toContain(write);
    }
    // The dropped `wiki_records` name no longer enables anything: it is
    // an unknown toolbox now, silently ignored.
    const stale = buildToolList(['wiki_records']).map((t) => t.function.name);
    expect(stale).not.toContain('record_create');
    expect(stale).not.toContain('wiki_create');
  });

  it('buildToolList(["images"]) exposes generate_image only when enabled', () => {
    // generate_image is gated, not always-on: it spends Venice credits
    // and writes a persistent attachment, so it must not appear in the
    // wire list until the images toolbox is on.
    const offNames = buildToolList([]).map((t) => t.function.name);
    expect(offNames).not.toContain('generate_image');
    const onNames = buildToolList(['images']).map((t) => t.function.name);
    expect(onNames).toContain('generate_image');
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
      'analyze_pdf_page',
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
});

// The agent-only memory toolboxes' composition (soft-decay set,
// memory_invalidate in place of memory_delete, the librarian's
// no-create/no-update rules) and every tool impl's behavior are
// enforced server-side - see supabase/functions/tests/
// {reflection,memory_librarian,memory_consolidate}.test.ts. The
// browser registry is schema-only; nothing dispatches here.
