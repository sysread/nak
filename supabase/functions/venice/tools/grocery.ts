// grocery (function-side combination tool)
//
// One tool behind an `op` enum discriminator: list / add / remove /
// update over the user's grocery list. Mirrors the recipes combo
// envelope (see the browser schema's header,
// src/lib/tools/grocery.schema.ts). The design contract and its
// rationale live in docs/dev/in-progress/grocery-tool-plan.md until
// the plan graduates.
//
// Auth: b-strict throughout. Every read filters
// .eq('user_id', userId) and every write stamps user_id - the
// service-role client bypasses RLS, and a foreign or unknown id
// matches zero rows and reports the miss honestly
// (indistinguishable from "never existed", matching what RLS would
// show the browser path).
//
// The un-plan contract: `remove` deletes the product's OPEN entry
// only and never stamps acquired_at. Purchase history records what
// the user actually bought, and every existing stamp of it is the
// panel row tap - a model stamp would fabricate history and pollute
// the shopping-trip "In cart" split. There is deliberately no
// purchase op (docs/dev/planned-changes.md carries the deferral).
//
// No RPCs: the recipe combo's write path rides RPCs that take an
// explicit p_user_id, but no user-facing grocery CRUD RPC takes one
// - the grocery RPCs resolve the caller from auth.uid(), which is
// null under the service key. Every op here is direct table writes
// plus the view read.
//
// Per-op required fields (id XOR name on remove/update, per-item
// name on add) are enforced in the per-op bodies below with
// ArgErrors - the flat wire schema cannot express them. add's
// unconditional `items` required rides x-per-op-required through the
// central validator; nested item-level caps (name/count/unit/note
// lengths, maxItems) are handler-enforced because the central
// validator checks top-level properties only.

import { registerTool, type ToolContext, type ToolDef } from '../performToolCall.ts';
import { ArgErrors } from './_validate.ts';

// Mirrors of src/lib/tools/grocery.schema.ts - the caps the wire
// schema advertises. Divergent copies here rejected schema-legal
// input.
const GROCERY_LIST_DEFAULT_LIMIT = 100;
const GROCERY_LIST_MAX_LIMIT = 500;
const MAX_GROCERY_ADD_ITEMS = 30;
const MAX_GROCERY_NAME_CHARS = 200;
const MAX_GROCERY_COUNT_CHARS = 100;
const MAX_GROCERY_UNIT_CHARS = 100;
const MAX_GROCERY_NOTE_CHARS = 500;

// Mirror of normalizeGroceryName in src/lib/ui/grocery-list.ts -
// trimmed lowercase is the only ingredient identity across every
// grocery surface (revival matching, the recipe checkbox bridge,
// the browse pager's ordering key).
function normalizeGroceryName(raw: string): string {
  return raw.trim().toLowerCase();
}

// ILIKE pattern helper, ported from ./recipes.ts (which mirrors the
// browser's ilikeFilterPattern with escaping) - escape ILIKE
// metacharacters in the model-supplied query, then wrap in %...%.
// The escaped variant is the one this tool ports: the browser's
// src/lib/supabase/query-utils.ts copy is unescaped.
function ilikeFilterPattern(raw: string): string {
  return `%${raw.replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
}

// View projection for list/update reads. Subset of the browser's
// VIEW_SELECT (src/lib/supabase/grocery.ts) - the photo columns are
// dropped because the model cannot use signed Storage URLs, and
// section_id is resolved to a section name before returning.
const ITEM_SELECT =
  'id, name, note, section_id, recipe_id, recipe_title, ' +
  'entry_id, count, unit, acquired_at, on_list, updated_at';

// Lightweight probe projection for the add/remove/update name
// matching - one fetch of the personal-scale catalog, matched in JS.
const CATALOG_SELECT = 'id, name, recipe_id, section_id, on_list, updated_at';

interface SectionRow {
  id: string;
  name: string;
  position: number;
}

interface CatalogRow {
  id: string;
  name: string;
  recipe_id: string | null;
  section_id: string | null;
  on_list: boolean;
  updated_at: string;
}

interface ItemRow {
  id: string;
  name: string;
  note: string | null;
  section_id: string | null;
  recipe_id: string | null;
  recipe_title: string | null;
  entry_id: string | null;
  count: string | null;
  unit: string | null;
  acquired_at: string | null;
  on_list: boolean;
  updated_at: string;
}

// RLS OFF: filter by userId. grocery_sections.user_id is the direct
// ownership column.
async function fetchSections(ctx: ToolContext): Promise<SectionRow[]> {
  const { data, error } = await ctx.adminClient
    .from('grocery_sections')
    .select('id, name, position')
    .eq('user_id', ctx.userId)
    .order('position', { ascending: true });
  if (error) throw new Error(`listGrocerySections failed: ${error.message}`);
  return (data ?? []) as SectionRow[];
}

function sectionNamesForError(sections: SectionRow[]): string {
  const names = sections.map((s) => s.name);
  names.push('Other');
  return names.join(', ');
}

/**
 * Resolve a section name to its row id. Case-insensitive on the
 * trimmed name. Returns null for "Other" (the unfiled intake bucket
 * - not a row; section_id null), undefined when no section matches.
 */
function matchSection(
  sections: SectionRow[],
  raw: string,
): string | null | undefined {
  const wanted = raw.trim().toLowerCase();
  if (wanted === 'other') return null;
  const hit = sections.find((s) => s.name.trim().toLowerCase() === wanted);
  return hit ? hit.id : undefined;
}

function sectionNameOf(sections: SectionRow[], id: string | null): string | null {
  if (id === null) return null;
  return sections.find((s) => s.id === id)?.name ?? null;
}

function toItem(row: ItemRow, sections: SectionRow[]) {
  return {
    id: row.id,
    name: row.name,
    note: row.note,
    section: sectionNameOf(sections, row.section_id),
    count: row.count,
    unit: row.unit,
    on_list: row.on_list,
    acquired_at: row.acquired_at,
    recipe_id: row.recipe_id,
    recipe_title: row.recipe_title,
  };
}

/**
 * Open (or re-open) the product's list entry. Mirror of openEntry in
 * src/lib/supabase/grocery.ts: 23505 = unique_violation on the
 * one-open-entry-per-product partial index, meaning the product is
 * already on the list from a concurrent surface - which is the state
 * the caller wanted, not an error.
 */
async function openEntry(
  ctx: ToolContext,
  productId: string,
  qty: { count: string | null; unit: string | null },
): Promise<void> {
  const { error } = await ctx.adminClient.from('grocery_list_entries').insert({
    user_id: ctx.userId,
    product_id: productId,
    count: qty.count,
    unit: qty.unit,
  });
  if (error && error.code !== '23505') {
    throw new Error(`openGroceryEntry failed: ${error.message}`);
  }
}

// One fetch of the user's catalog for name-based matching. The
// catalog is personal-scale (the browser fetches the whole on-list
// set the same way), so a single round trip beats per-name probes.
// RLS OFF: filter by userId.
async function fetchCatalog(ctx: ToolContext): Promise<CatalogRow[]> {
  const { data, error } = await ctx.adminClient
    .from('grocery_products_view')
    .select(CATALOG_SELECT)
    .eq('user_id', ctx.userId);
  if (error) throw new Error(`groceryCatalogFetch failed: ${error.message}`);
  return (data ?? []) as CatalogRow[];
}

type Locator =
  | { kind: 'found'; productId: string }
  | { kind: 'miss' }
  | { kind: 'ambiguous'; matches: Array<{ id: string; name: string }> };

/**
 * Resolve remove/update's id-or-name locator. id matches at most one
 * product (primary key, user-scoped); a name match is normalized and
 * refuses on multiples by listing the candidates, because these ops
 * EDIT - a guess would act on the wrong product (add's probe instead
 * picks deterministically, see addOp).
 */
async function resolveLocator(
  ctx: ToolContext,
  args: Record<string, unknown>,
): Promise<Locator> {
  const id = typeof args.id === 'string' ? args.id.trim() : '';
  const name = typeof args.name === 'string' ? args.name.trim() : '';

  if (id && !name) {
    // RLS OFF: filter by userId. A foreign id matches zero rows and
    // reads as a miss.
    const { data, error } = await ctx.adminClient
      .from('grocery_products')
      .select('id')
      .eq('user_id', ctx.userId)
      .eq('id', id)
      .maybeSingle();
    if (error) throw new Error(`groceryProductLookup failed: ${error.message}`);
    return data ? { kind: 'found', productId: data.id as string } : { kind: 'miss' };
  }

  const catalog = await fetchCatalog(ctx);
  const norm = normalizeGroceryName(name);
  const matches = catalog.filter((r) => normalizeGroceryName(r.name) === norm);
  if (matches.length === 0) return { kind: 'miss' };
  if (matches.length > 1) {
    return {
      kind: 'ambiguous',
      matches: matches.map((m) => ({ id: m.id, name: m.name })),
    };
  }
  return { kind: 'found', productId: matches[0]!.id };
}

// The honest-miss wording for remove: one combined reason that names
// the possibilities without distinguishing them (the repo-wide
// delete-honesty contract, docs/dev/tools.md).
const REMOVE_MISS_REASON =
  'Nothing matched an on-list item with that id or name - no such ' +
  'product, or it is not on the list.';

// ---------------------------------------------------------------------------
// list
// ---------------------------------------------------------------------------

async function listOp(args: Record<string, unknown>, ctx: ToolContext) {
  const query = typeof args.query === 'string' ? args.query.trim() : '';
  const status: 'on_list' | 'acquired' | 'all' =
    args.status === 'acquired' || args.status === 'all' ? args.status : 'on_list';
  const rawLimit =
    typeof args.limit === 'number' ? args.limit : GROCERY_LIST_DEFAULT_LIMIT;
  const limit = Math.max(
    1,
    Math.min(GROCERY_LIST_MAX_LIMIT, Math.floor(rawLimit)),
  );

  const sections = await fetchSections(ctx);

  // Optional section filter, resolved against the user's rows so the
  // model can use display names. 'Other' is the unfiled bucket.
  let sectionId: string | null | undefined;
  if (typeof args.section === 'string' && args.section.trim().length > 0) {
    const matched = matchSection(sections, args.section);
    if (matched === undefined) {
      throw new Error(
        `section "${args.section}" does not match one of your sections - ` +
          `valid sections: ${sectionNamesForError(sections)}`,
      );
    }
    sectionId = matched;
  }

  // RLS OFF: filter by userId. The view carries user_id (the join
  // root is the user's product row).
  let q = ctx.adminClient
    .from('grocery_products_view')
    .select(ITEM_SELECT)
    .eq('user_id', ctx.userId);
  if (status === 'on_list') {
    // The browser's on-list ordering: most recently updated first.
    q = q.eq('on_list', true).order('updated_at', { ascending: false });
  } else if (status === 'acquired') {
    // "Acquired" means bought before, not merely absent - a
    // never-bought un-planned product is catalog-only. Recency
    // window bounded by limit; the history grows forever and is
    // never fetched whole (the domain's standing rule).
    q = q
      .eq('on_list', false)
      .not('acquired_at', 'is', null)
      .order('acquired_at', { ascending: false })
      .order('id', { ascending: false });
  } else {
    // The browse pager's ordering: alphabetical with an id tiebreak.
    q = q.order('name', { ascending: true }).order('id', { ascending: true });
  }
  if (sectionId !== undefined) {
    q = sectionId === null ? q.is('section_id', null) : q.eq('section_id', sectionId);
  }
  if (query.length > 0) {
    q = q.ilike('name', ilikeFilterPattern(query));
  }
  q = q.limit(limit);

  const { data, error } = await q;
  if (error) throw new Error(`groceryList failed: ${error.message}`);
  const rows = (data ?? []) as unknown as ItemRow[];

  return {
    sections: sections.map((s) => ({ id: s.id, name: s.name })),
    items: rows.map((r) => toItem(r, sections)),
  };
}

// ---------------------------------------------------------------------------
// add
// ---------------------------------------------------------------------------

interface AddItem {
  name: string;
  count: string | null;
  unit: string | null;
  note: string | null;
  sectionId: string | null | undefined;
}

async function addOp(args: Record<string, unknown>, ctx: ToolContext) {
  const errs = new ArgErrors();
  const sections = await fetchSections(ctx);

  const rawItems = args.items;
  if (!Array.isArray(rawItems) || rawItems.length === 0) {
    errs.add('items is required and must be a non-empty array');
  } else if (rawItems.length > MAX_GROCERY_ADD_ITEMS) {
    errs.add(`items exceeds the ${MAX_GROCERY_ADD_ITEMS}-item limit (got ${rawItems.length})`);
  }

  const items: AddItem[] = [];
  if (Array.isArray(rawItems)) {
    rawItems.forEach((raw, i) => {
      if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
        errs.add(`items[${i}] must be an object`);
        return;
      }
      const obj = raw as Record<string, unknown>;
      for (const key of Object.keys(obj)) {
        if (!['name', 'count', 'unit', 'note', 'section'].includes(key)) {
          errs.add(`items[${i}]: unrecognized parameter: ${key}`);
        }
      }
      const name = typeof obj.name === 'string' ? obj.name.trim() : '';
      if (!name) errs.add(`items[${i}].name is required`);
      else if (name.length > MAX_GROCERY_NAME_CHARS) {
        errs.add(`items[${i}].name exceeds ${MAX_GROCERY_NAME_CHARS}-char limit (got ${name.length})`);
      }
      const readText = (
        field: 'count' | 'unit' | 'note',
        cap: number,
      ): string | null => {
        const v = obj[field];
        if (v === undefined || v === null) return null;
        if (typeof v !== 'string') {
          errs.add(`type error: items[${i}].${field} expects a string`);
          return null;
        }
        if (v.length > cap) {
          errs.add(`items[${i}].${field} exceeds ${cap}-char limit (got ${v.length})`);
          return null;
        }
        return v;
      };
      // Section resolves here rather than in a second indexed pass -
      // a malformed earlier item would shift the second loop's
      // indexes against the raw array.
      let sectionId: string | null | undefined = undefined;
      if (obj.section !== undefined && obj.section !== null) {
        if (typeof obj.section !== 'string') {
          errs.add(`type error: items[${i}].section expects a string`);
        } else {
          const matched = matchSection(sections, obj.section);
          if (matched === undefined) {
            errs.add(
              `items[${i}].section "${obj.section}" does not match one of your ` +
                `sections - valid sections: ${sectionNamesForError(sections)}`,
            );
          } else {
            sectionId = matched;
          }
        }
      }
      items.push({
        name,
        count: readText('count', MAX_GROCERY_COUNT_CHARS),
        unit: readText('unit', MAX_GROCERY_UNIT_CHARS),
        note: readText('note', MAX_GROCERY_NOTE_CHARS),
        sectionId,
      });
    });
  }

  // Optional recipe linkage: validated up front so a bad id costs one
  // round trip, not a per-item one.
  let recipe: { id: string; title: string } | null = null;
  const recipeId = typeof args.recipe_id === 'string' ? args.recipe_id.trim() : '';
  if (recipeId) {
    // RLS OFF: filter by userId.
    const { data, error } = await ctx.adminClient
      .from('recipes')
      .select('id, title')
      .eq('user_id', ctx.userId)
      .eq('id', recipeId)
      .maybeSingle();
    if (error) throw new Error(`recipeLookup failed: ${error.message}`);
    if (!data) errs.add('recipe_id does not match one of your recipes');
    else recipe = { id: data.id as string, title: data.title as string };
  }
  errs.throwIfAny();

  // One fetch of the catalog; the probe matches in JS below.
  const catalog = await fetchCatalog(ctx);

  // Tiered name probe, revive-before-create. The tiers are
  // asymmetric ON PURPOSE, mirroring the browser surfaces each
  // context parallels:
  //   - adding for a recipe probes that recipe's products first (the
  //     checkbox bridge's scope) then standalone staples - but never
  //     another recipe's product, because recipe products live and
  //     die with their recipe's cooklang (the invalidation trigger),
  //     and reviving a foreign recipe's row would silently cross
  //     that cleanup boundary;
  //   - a standalone add probes standalone products first, then any
  //     product catalog-wide (the sidebar checkbox revives whatever
  //     row it shows).
  // Within the winning tier, multiple name matches resolve to the
  // most recently updated row, reported as matched_name - add just
  // needs an item on the list, unlike remove/update which edit and
  // therefore refuse ambiguity.
  const results: Array<{
    name: string;
    status: 'created' | 'revived' | 'already_on_list';
    product_id: string;
    matched_name?: string;
  }> = [];

  for (const item of items) {
    const norm = normalizeGroceryName(item.name);
    const byName = (rows: CatalogRow[]) =>
      rows.filter((r) => normalizeGroceryName(r.name) === norm);
    const tier1 = recipe
      ? byName(catalog.filter((r) => r.recipe_id === recipe!.id))
      : byName(catalog.filter((r) => r.recipe_id === null));
    const tier2 = recipe
      ? byName(catalog.filter((r) => r.recipe_id === null))
      : byName(catalog.filter((r) => r.recipe_id !== null));
    const pool = tier1.length > 0 ? tier1 : tier2;

    if (pool.length > 0) {
      const match = [...pool].sort((a, b) =>
        b.updated_at.localeCompare(a.updated_at),
      )[0]!;
      if (match.on_list) {
        results.push({
          name: item.name,
          status: 'already_on_list',
          product_id: match.id,
          matched_name: match.name,
        });
        continue;
      }
      // Revival: the learned section and purchase history stay with
      // the product; a section on the item is deliberately ignored
      // (browser parity - the add-all path never refiles).
      await openEntry(ctx, match.id, { count: item.count, unit: item.unit });
      results.push({
        name: item.name,
        status: 'revived',
        product_id: match.id,
        matched_name: match.name,
      });
      continue;
    }

    // No match anywhere: create the product, then open its entry.
    // A machine-chosen section stamps section_source 'auto' - the
    // same provenance the browser's auto-sectioning agent gets; the
    // classifier only ever touches null-source rows, so a user
    // refiling later still wins.
    // RLS OFF: stamp user_id explicitly.
    const { data: created, error: insertErr } = await ctx.adminClient
      .from('grocery_products')
      .insert({
        user_id: ctx.userId,
        name: item.name,
        note: item.note ?? (recipe ? `For ${recipe.title}` : null),
        section_id: item.sectionId ?? null,
        section_source: item.sectionId ? 'auto' : null,
        recipe_id: recipe ? recipe.id : null,
      })
      .select('id');
    if (insertErr) {
      throw new Error(`createGroceryProduct failed: ${insertErr.message}`);
    }
    const createdRows = (created ?? []) as Array<{ id: string }>;
    const newId = createdRows[0]?.id;
    if (!newId) throw new Error('createGroceryProduct returned no row');
    await openEntry(ctx, newId, { count: item.count, unit: item.unit });
    results.push({
      name: item.name,
      status: 'created',
      product_id: newId,
    });
  }

  return { results };
}

// ---------------------------------------------------------------------------
// remove
// ---------------------------------------------------------------------------

async function removeOp(args: Record<string, unknown>, ctx: ToolContext) {
  const errs = new ArgErrors();
  const id = typeof args.id === 'string' ? args.id.trim() : '';
  const name = typeof args.name === 'string' ? args.name.trim() : '';
  if (!id && !name) errs.add('provide exactly one of id or name');
  if (id && name) errs.add('provide exactly one of id or name - not both');
  errs.throwIfAny();

  const locator = await resolveLocator(ctx, args);
  if (locator.kind === 'miss') return { removed: false, reason: REMOVE_MISS_REASON };
  if (locator.kind === 'ambiguous') {
    throw new Error(
      `name "${name}" matches ${locator.matches.length} products - pass the id of the right one: ` +
        locator.matches.map((m) => `${m.name} (${m.id})`).join('; '),
    );
  }

  // Un-plan: delete the OPEN entry only. The .is('acquired_at', null)
  // predicate is load-bearing - a purchase racing between the read
  // and this write makes the delete match zero rows instead of
  // destroying a purchase-history row. RLS OFF: filter by userId.
  const { data: deleted, error } = await ctx.adminClient
    .from('grocery_list_entries')
    .delete()
    .eq('user_id', ctx.userId)
    .eq('product_id', locator.productId)
    .is('acquired_at', null)
    .select('id');
  if (error) throw new Error(`removeGroceryItem failed: ${error.message}`);
  if (!deleted || deleted.length === 0) {
    return { removed: false, reason: REMOVE_MISS_REASON };
  }
  return { removed: true };
}

// ---------------------------------------------------------------------------
// update
// ---------------------------------------------------------------------------

async function updateOp(args: Record<string, unknown>, ctx: ToolContext) {
  const errs = new ArgErrors();
  const id = typeof args.id === 'string' ? args.id.trim() : '';
  const name = typeof args.name === 'string' ? args.name.trim() : '';
  if (!id && !name) errs.add('provide exactly one of id or name');
  if (id && name) errs.add('provide exactly one of id or name - not both');
  errs.throwIfAny();

  const locator = await resolveLocator(ctx, args);
  if (locator.kind === 'miss') {
    throw new Error('no product matched that id or name');
  }
  if (locator.kind === 'ambiguous') {
    throw new Error(
      `name "${name}" matches ${locator.matches.length} products - pass the id of the right one: ` +
        locator.matches.map((m) => `${m.name} (${m.id})`).join('; '),
    );
  }
  const productId = locator.productId;

  // RLS OFF: filter by userId.
  const { data: row, error: rowErr } = await ctx.adminClient
    .from('grocery_products_view')
    .select(ITEM_SELECT)
    .eq('user_id', ctx.userId)
    .eq('id', productId)
    .maybeSingle();
  if (rowErr) throw new Error(`groceryItemLookup failed: ${rowErr.message}`);
  if (!row) throw new Error('no product matched that id or name');
  const current = row as unknown as ItemRow;

  const sections = await fetchSections(ctx);

  // Patch parse: absent = leave alone, explicit null = clear (rename
  // excepted - a name can only be replaced).
  let rename: string | undefined;
  let note: string | null | undefined;
  let sectionId: string | null | undefined;
  let count: string | null | undefined;
  let unit: string | null | undefined;

  if ('rename' in args) {
    if (typeof args.rename !== 'string' || args.rename.trim().length === 0) {
      errs.add('rename must be a non-empty string');
    } else if (args.rename.trim().length > MAX_GROCERY_NAME_CHARS) {
      errs.add(`rename exceeds ${MAX_GROCERY_NAME_CHARS}-char limit (got ${args.rename.trim().length})`);
    } else {
      rename = args.rename.trim();
    }
  }
  if ('note' in args) {
    if (args.note === null) note = null;
    else if (typeof args.note !== 'string') {
      errs.add('type error: note expects a string, or null to clear');
    } else if (args.note.length > MAX_GROCERY_NOTE_CHARS) {
      errs.add(`note exceeds ${MAX_GROCERY_NOTE_CHARS}-char limit (got ${args.note.length})`);
    } else {
      note = args.note;
    }
  }
  if ('section' in args) {
    if (args.section === null) sectionId = null;
    else if (typeof args.section !== 'string' || args.section.trim().length === 0) {
      errs.add('type error: section expects a section name, or null to unfile');
    } else {
      const matched = matchSection(sections, args.section);
      if (matched === undefined) {
        errs.add(
          `section "${args.section}" does not match one of your sections - ` +
            `valid sections: ${sectionNamesForError(sections)}`,
        );
      } else {
        sectionId = matched;
      }
    }
  }
  const readEntryText = (
    field: 'count' | 'unit',
    cap: number,
  ): string | null | undefined => {
    if (!(field in args)) return undefined;
    const v = args[field];
    if (v === null) return null;
    if (typeof v !== 'string') {
      errs.add(`type error: ${field} expects a string, or null to clear`);
      return undefined;
    }
    if (v.length > cap) {
      errs.add(`${field} exceeds ${cap}-char limit (got ${v.length})`);
      return undefined;
    }
    return v;
  };
  count = readEntryText('count', MAX_GROCERY_COUNT_CHARS);
  unit = readEntryText('unit', MAX_GROCERY_UNIT_CHARS);

  // Renaming a recipe-linked product breaks the recipe's ingredient
  // checkbox match and the invalidation trigger deletes the product
  // on the next cooklang edit (docs/dev/grocery-list.md "Name
  // normalization is the only ingredient identity"). The browser
  // editor allows it because the user sees that trade; the model
  // gets a refusal naming it.
  if (rename !== undefined && current.recipe_id !== null) {
    errs.add(
      `rename is refused for recipe-linked items - "${current.name}" is linked ` +
        'to a recipe whose checkbox match and cleanup key on the name; ' +
        'rename it from the app, where the trade is visible',
    );
  }

  if (
    rename === undefined &&
    note === undefined &&
    sectionId === undefined &&
    count === undefined &&
    unit === undefined &&
    !errs.any
  ) {
    errs.add('provide at least one of rename, note, section, count, or unit');
  }
  errs.throwIfAny();

  // Product-level fields. A machine-chosen section stamps
  // section_source 'auto' (same provenance as the auto-sectioning
  // agent); null unfiles back to intake, where the classifier may
  // file it later. RLS OFF: filter by userId.
  if (rename !== undefined || note !== undefined || sectionId !== undefined) {
    const patch: Record<string, unknown> = {
      updated_at: new Date().toISOString(),
    };
    if (rename !== undefined) patch.name = rename;
    if (note !== undefined) patch.note = note;
    if (sectionId !== undefined) {
      patch.section_id = sectionId;
      patch.section_source = sectionId === null ? null : 'auto';
    }
    const { error: updateErr } = await ctx.adminClient
      .from('grocery_products')
      .update(patch)
      .eq('user_id', ctx.userId)
      .eq('id', productId);
    if (updateErr) {
      throw new Error(`updateGroceryProduct failed: ${updateErr.message}`);
    }
  }

  // Entry-level fields (the planned quantity). The view's entry_id
  // for an off-list product points at the LATEST PURCHASE, not an
  // open entry, so this is gated on on_list AND the write carries
  // the open-entry predicate - a raced purchase makes the update
  // match zero rows instead of stamping a purchase-history row.
  if (count !== undefined || unit !== undefined) {
    if (!current.on_list) {
      throw new Error(
        `"${current.name}" is not on the list - count/unit edit the planned ` +
          'quantity on its open list entry',
      );
    }
    const entryPatch: Record<string, unknown> = {};
    if (count !== undefined) entryPatch.count = count;
    if (unit !== undefined) entryPatch.unit = unit;
    // RLS OFF: filter by userId.
    const { data: entryRows, error: entryErr } = await ctx.adminClient
      .from('grocery_list_entries')
      .update(entryPatch)
      .eq('user_id', ctx.userId)
      .eq('id', current.entry_id)
      .is('acquired_at', null)
      .select('id');
    if (entryErr) {
      throw new Error(`updateGroceryEntry failed: ${entryErr.message}`);
    }
    if (!entryRows || entryRows.length === 0) {
      throw new Error(
        `"${current.name}" is not on the list - count/unit edit the planned ` +
          'quantity on its open list entry',
      );
    }
  }

  // Read the row back so the result reflects the write (and the
  // section renders as a name). RLS OFF: filter by userId.
  const { data: fresh, error: freshErr } = await ctx.adminClient
    .from('grocery_products_view')
    .select(ITEM_SELECT)
    .eq('user_id', ctx.userId)
    .eq('id', productId)
    .maybeSingle();
  if (freshErr) throw new Error(`groceryItemLookup failed: ${freshErr.message}`);
  if (!fresh) throw new Error('updateGroceryProduct returned no row');

  return { updated: true, item: toItem(fresh as unknown as ItemRow, sections) };
}

// ---------------------------------------------------------------------------
// combination-tool envelope
// ---------------------------------------------------------------------------

export const grocery: ToolDef = {
  name: 'grocery',
  async execute(args: Record<string, unknown>, ctx: ToolContext) {
    const op = typeof args.op === 'string' ? args.op.trim() : '';
    if (!op) {
      throw new Error('op is required (list | add | remove | update)');
    }
    switch (op) {
      case 'list':
        return listOp(args, ctx);
      case 'add':
        return addOp(args, ctx);
      case 'remove':
        return removeOp(args, ctx);
      case 'update':
        return updateOp(args, ctx);
      default:
        throw new Error(
          `unknown op "${op}" - expected list, add, remove, or update`,
        );
    }
  },
};

registerTool(grocery);
