/**
 * Grocery domain slice of the Supabase data layer: store sections
 * (list / create / rename / delete / reorder / first-run seed) and
 * list items (list / create / update / delete / needed-flag toggle /
 * acquired-history search), plus the item product-photo upload and
 * signed-URL resolution against the `grocery-item-images` bucket.
 *
 * Same RLS posture as the cookbook slice: every query is scoped to
 * the signed-in user automatically; only inserts need an explicit
 * user_id because the with_check policy has no default to fall back
 * on.
 *
 * Plain async functions taking the shared SupabaseClient as their
 * first argument - no class, no state - so each can be unit-tested
 * against a stubbed client without constructing SupabaseService. The
 * SupabaseService facade (../supabase.ts) delegates its grocery
 * methods here one-for-one under the same names. Row types live in
 * ./types/grocery.
 */
import type { SupabaseClient, Session } from '@supabase/supabase-js';
import { SupabaseError } from './error';
import { base64ToBytes, ilikeFilterPattern } from './query-utils';
import type {
  GroceryItem,
  GroceryItemPatch,
  GroceryItemView,
  GrocerySection,
} from './types';

/**
 * Mirror of the facade's getSession - unwrap client.auth.getSession(),
 * throwing SupabaseError on failure. Private to this slice so the
 * storage upload path keeps its exact error behavior without reaching
 * back into SupabaseService.
 */
async function getSession(client: SupabaseClient): Promise<Session | null> {
  const { data, error } = await client.auth.getSession();
  if (error) throw new SupabaseError(error.message);
  return data.session;
}

// TTL for product-photo display signed URLs. Generous (6h, same as
// recipe images) so a list kept open through a shopping trip keeps
// rendering; a longer-open view re-resolves on reload.
const GROCERY_IMAGE_SIGNED_URL_TTL_SECONDS = 60 * 60 * 6;

/**
 * Starter sections seeded into an empty account the first time the
 * grocery store loads. Ordinary rows once seeded - the user can
 * rename, reorder, or delete every one of them. "Other" is absent on
 * purpose: it is the null-section pseudo-bucket, not a row.
 */
export const DEFAULT_GROCERY_SECTIONS: readonly string[] = [
  'Produce',
  'Bread',
  'Deli',
  'Meats',
  'Dairy',
  'Frozen',
  'Snacks',
  'Pantry',
  'Beverages',
  'Household',
];

// Sections -------------------------------------------------------------------

/** All of the user's sections in display order. */
export async function listGrocerySections(
  client: SupabaseClient
): Promise<GrocerySection[]> {
  const { data, error } = await client
    .from('grocery_sections')
    .select('id, name, position, created_at')
    .order('position', { ascending: true });
  if (error) throw new SupabaseError(error.message);
  return (data ?? []) as GrocerySection[];
}

/**
 * Seed the canned starter sections when the user has none. Client-side
 * (not schema.sql) because per-user rows need an auth context the sync
 * script doesn't have. The count re-check narrows the two-tabs race to
 * a window of one round trip; a double-seed is cosmetic (duplicate
 * names the user can delete), not corrupting, so we don't pay for a
 * server-side lock.
 */
export async function seedGrocerySectionsIfEmpty(
  client: SupabaseClient
): Promise<void> {
  const session = await getSession(client);
  if (!session) throw new SupabaseError('Not authenticated.');
  const { count, error } = await client
    .from('grocery_sections')
    .select('id', { count: 'exact', head: true });
  if (error) throw new SupabaseError(error.message);
  if ((count ?? 0) > 0) return;
  const rows = DEFAULT_GROCERY_SECTIONS.map((name, i) => ({
    user_id: session.user.id,
    name,
    position: i,
  }));
  const { error: insertError } = await client
    .from('grocery_sections')
    .insert(rows);
  if (insertError) throw new SupabaseError(insertError.message);
}

/** Create a section at the end of the current order. */
export async function createGrocerySection(
  client: SupabaseClient,
  name: string
): Promise<GrocerySection> {
  const session = await getSession(client);
  if (!session) throw new SupabaseError('Not authenticated.');
  const trimmed = name.trim();
  if (trimmed.length === 0) throw new SupabaseError('section name is required');
  // Append: next position = current row count. Positions are dense by
  // construction (seed + reorder both renumber from 0), so count is
  // the next free slot. A concurrent insert could collide; the
  // reorder RPC renumbers densely, so a duplicate position is only a
  // transient tie broken by id, never data corruption.
  const { count, error: countError } = await client
    .from('grocery_sections')
    .select('id', { count: 'exact', head: true });
  if (countError) throw new SupabaseError(countError.message);
  const { data, error } = await client
    .from('grocery_sections')
    .insert({ user_id: session.user.id, name: trimmed, position: count ?? 0 })
    .select('id, name, position, created_at')
    .single();
  if (error) throw new SupabaseError(error.message);
  return data as GrocerySection;
}

export async function renameGrocerySection(
  client: SupabaseClient,
  id: string,
  name: string
): Promise<void> {
  const trimmed = name.trim();
  if (trimmed.length === 0) throw new SupabaseError('section name is required');
  const { error } = await client
    .from('grocery_sections')
    .update({ name: trimmed })
    .eq('id', id);
  if (error) throw new SupabaseError(error.message);
}

/**
 * Delete a section. Its items fall back to the "Other" pseudo-section
 * via the FK's `on delete set null` - nothing is lost.
 */
export async function deleteGrocerySection(
  client: SupabaseClient,
  id: string
): Promise<void> {
  const { error } = await client.from('grocery_sections').delete().eq('id', id);
  if (error) throw new SupabaseError(error.message);
}

/**
 * Persist a drag-and-drop reorder: `sectionIds` is the complete new
 * order (a permutation of every section the user has - the RPC
 * hard-errors on a mismatch so a stale drag can't silently drop one).
 */
export async function reorderGrocerySections(
  client: SupabaseClient,
  sectionIds: string[]
): Promise<void> {
  const { error } = await client.rpc('grocery_sections_reorder', {
    p_section_ids: sectionIds,
  });
  if (error) throw new SupabaseError(error.message);
}

// Items ----------------------------------------------------------------------

// The embedded-select projection every item read uses. PostgREST
// resolves the two FK embeds (recipes via recipe_id, images via
// image_id) as single objects or single-element arrays depending on
// serialisation mode; toItemView copes with both.
const ITEM_SELECT =
  'id, name, count, unit, note, section_id, needed, recipe_id, image_id, ' +
  'created_at, updated_at, recipes(title), grocery_item_images(storage_path)';

type RecipeEmbed = { title: string } | Array<{ title: string }> | null;
type ImageEmbed =
  | { storage_path: string }
  | Array<{ storage_path: string }>
  | null;
type ItemRow = GroceryItem & {
  recipes?: RecipeEmbed;
  grocery_item_images?: ImageEmbed;
};

function embedded<T>(embed: T | T[] | null | undefined): T | null {
  if (embed === null || embed === undefined) return null;
  return Array.isArray(embed) ? (embed[0] ?? null) : embed;
}

/**
 * Map raw embedded rows into GroceryItemView, batch-resolving signed
 * URLs for every photo in one Storage call. Items whose signing fails
 * degrade to no photo rather than failing the list read.
 */
async function toItemViews(
  client: SupabaseClient,
  rows: ItemRow[]
): Promise<GroceryItemView[]> {
  const paths = rows
    .map((r) => embedded(r.grocery_item_images)?.storage_path)
    .filter((p): p is string => typeof p === 'string');
  const signed = new Map<string, string>();
  if (paths.length > 0) {
    const { data, error } = await client.storage
      .from('grocery-item-images')
      .createSignedUrls(paths, GROCERY_IMAGE_SIGNED_URL_TTL_SECONDS);
    if (!error) {
      for (const entry of data ?? []) {
        if (entry.signedUrl && typeof entry.path === 'string') {
          signed.set(entry.path, entry.signedUrl);
        }
      }
    }
  }
  return rows.map((r) => {
    const { recipes, grocery_item_images, ...item } = r;
    const path = embedded(grocery_item_images)?.storage_path ?? null;
    return {
      ...item,
      recipe_title: embedded(recipes)?.title ?? null,
      image_url: (path && signed.get(path)) || null,
    };
  });
}

/**
 * The active shopping list: every `needed` item, newest first. Fetched
 * whole - an active trip's list is small by nature (the unbounded set
 * is the acquired history, which is windowed below).
 */
export async function listNeededGroceryItems(
  client: SupabaseClient
): Promise<GroceryItemView[]> {
  const { data, error } = await client
    .from('grocery_items')
    .select(ITEM_SELECT)
    .eq('needed', true)
    .order('updated_at', { ascending: false });
  if (error) throw new SupabaseError(error.message);
  return toItemViews(client, (data ?? []) as unknown as ItemRow[]);
}

/**
 * One recency window of the acquired history (needed = false), newest
 * first. Windowed, never fetched whole - this set grows unboundedly
 * over shopping trips. `hasMore` is derived from the +1 overfetch,
 * same shape as listRecipesPage.
 */
export async function listAcquiredGroceryItemsPage(
  client: SupabaseClient,
  opts: { offset: number; pageSize: number }
): Promise<{ rows: GroceryItemView[]; hasMore: boolean }> {
  const { data, error } = await client
    .from('grocery_items')
    .select(ITEM_SELECT)
    .eq('needed', false)
    .order('updated_at', { ascending: false })
    .order('id', { ascending: false })
    .range(opts.offset, opts.offset + opts.pageSize);
  if (error) throw new SupabaseError(error.message);
  const rows = (data ?? []) as unknown as ItemRow[];
  const hasMore = rows.length > opts.pageSize;
  const windowRows = hasMore ? rows.slice(0, opts.pageSize) : rows;
  return { rows: await toItemViews(client, windowRows), hasMore };
}

/**
 * One recency window of the full item corpus for the sidebar's
 * all-items browse: optional ILIKE name search, optional status
 * filter (`needed`), and optional section filter (`sectionId`;
 * `'other'` matches the null-section pseudo-bucket). Windowed like
 * the acquired page - the corpus grows every shopping trip, forever.
 * `hasMore` derives from the +1 overfetch, same shape as
 * listRecipesPage.
 */
export async function listGroceryItemsPage(
  client: SupabaseClient,
  opts: {
    offset: number;
    pageSize: number;
    query?: string;
    needed?: boolean;
    sectionId?: string | 'other';
  }
): Promise<{ rows: GroceryItemView[]; hasMore: boolean }> {
  let q = client.from('grocery_items').select(ITEM_SELECT);
  const query = opts.query?.trim() ?? '';
  if (query.length > 0) q = q.ilike('name', ilikeFilterPattern(query));
  if (opts.needed !== undefined) q = q.eq('needed', opts.needed);
  if (opts.sectionId === 'other') q = q.is('section_id', null);
  else if (opts.sectionId !== undefined) q = q.eq('section_id', opts.sectionId);
  q = q
    .order('updated_at', { ascending: false })
    .order('id', { ascending: false })
    .range(opts.offset, opts.offset + opts.pageSize);
  const { data, error } = await q;
  if (error) throw new SupabaseError(error.message);
  const rows = (data ?? []) as unknown as ItemRow[];
  const hasMore = rows.length > opts.pageSize;
  const windowRows = hasMore ? rows.slice(0, opts.pageSize) : rows;
  return { rows: await toItemViews(client, windowRows), hasMore };
}

/**
 * Suggestion source for the add-to-list input: acquired items
 * (needed = false) whose name matches the query, newest first,
 * deduped by normalized name so "eggs" bought on ten trips is one
 * suggestion. Picking a suggestion flips that row back to needed
 * (see setGroceryItemNeeded) rather than inserting a duplicate.
 */
export async function searchAcquiredGroceryItems(
  client: SupabaseClient,
  query: string,
  limit: number
): Promise<GroceryItemView[]> {
  const trimmed = query.trim();
  if (trimmed.length === 0) return [];
  // Overfetch beyond `limit` so the name-dedup below still fills the
  // suggestion list when the same item dominates the recent history.
  const { data, error } = await client
    .from('grocery_items')
    .select(ITEM_SELECT)
    .eq('needed', false)
    .ilike('name', ilikeFilterPattern(trimmed))
    .order('updated_at', { ascending: false })
    .limit(limit * 5);
  if (error) throw new SupabaseError(error.message);
  const rows = (data ?? []) as unknown as ItemRow[];
  const seen = new Set<string>();
  const deduped: ItemRow[] = [];
  for (const r of rows) {
    const key = r.name.trim().toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(r);
    if (deduped.length >= limit) break;
  }
  return toItemViews(client, deduped);
}

/**
 * Plain item rows linked to a recipe, any needed state. Drives the
 * recipe detail pane's ingredient checkbox sync - a checkbox reads as
 * checked when a row EXISTS for the recipe with a matching name,
 * regardless of `needed`, so buying the item at the store doesn't
 * visually re-open it on the recipe.
 */
export async function listGroceryItemsForRecipe(
  client: SupabaseClient,
  recipeId: string
): Promise<GroceryItem[]> {
  const { data, error } = await client
    .from('grocery_items')
    .select(
      'id, name, count, unit, note, section_id, needed, recipe_id, image_id, created_at, updated_at'
    )
    .eq('recipe_id', recipeId);
  if (error) throw new SupabaseError(error.message);
  // Through `unknown` because supabase-js special-cases a selected
  // column literally named `count` (its aggregate helper) and infers
  // it as number; ours is the free-form quantity text column.
  return (data ?? []) as unknown as GroceryItem[];
}

export async function createGroceryItem(
  client: SupabaseClient,
  input: {
    name: string;
    count?: string | null;
    unit?: string | null;
    note?: string | null;
    section_id?: string | null;
    recipe_id?: string | null;
    image_id?: string | null;
  }
): Promise<GroceryItem> {
  const session = await getSession(client);
  if (!session) throw new SupabaseError('Not authenticated.');
  const name = input.name.trim();
  if (name.length === 0) throw new SupabaseError('item name is required');
  const { data, error } = await client
    .from('grocery_items')
    .insert({
      user_id: session.user.id,
      name,
      count: input.count ?? null,
      unit: input.unit ?? null,
      note: input.note ?? null,
      section_id: input.section_id ?? null,
      recipe_id: input.recipe_id ?? null,
      image_id: input.image_id ?? null,
      needed: true,
    })
    .select(
      'id, name, count, unit, note, section_id, needed, recipe_id, image_id, created_at, updated_at'
    )
    .single();
  if (error) throw new SupabaseError(error.message);
  // Same `count`-column inference quirk as listGroceryItemsForRecipe.
  return data as unknown as GroceryItem;
}

/**
 * Partial update. Absent field = leave unchanged; explicit null =
 * clear (name excepted - it can only be replaced). Bumps updated_at
 * so an edited item floats to the top of its recency-ordered pane.
 */
export async function updateGroceryItem(
  client: SupabaseClient,
  id: string,
  patch: GroceryItemPatch
): Promise<void> {
  const update: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if ('name' in patch) {
    const name = (patch.name ?? '').trim();
    if (name.length === 0) throw new SupabaseError('item name is required');
    update.name = name;
  }
  if ('count' in patch) update.count = patch.count ?? null;
  if ('unit' in patch) update.unit = patch.unit ?? null;
  if ('note' in patch) update.note = patch.note ?? null;
  if ('section_id' in patch) update.section_id = patch.section_id ?? null;
  if ('image_id' in patch) update.image_id = patch.image_id ?? null;
  const { error } = await client.from('grocery_items').update(update).eq('id', id);
  if (error) throw new SupabaseError(error.message);
}

/**
 * Flip the shopping flag. Unchecking at the store (needed -> false)
 * moves the row into the acquired history; re-checking (or picking it
 * from the add-input suggestions) brings it back onto the list with
 * its section / note / photo intact. Bumps updated_at so both panes'
 * recency ordering reflects the flip.
 */
export async function setGroceryItemNeeded(
  client: SupabaseClient,
  id: string,
  needed: boolean
): Promise<void> {
  const { error } = await client
    .from('grocery_items')
    .update({ needed, updated_at: new Date().toISOString() })
    .eq('id', id);
  if (error) throw new SupabaseError(error.message);
}

export async function deleteGroceryItem(
  client: SupabaseClient,
  id: string
): Promise<void> {
  const { error } = await client.from('grocery_items').delete().eq('id', id);
  if (error) throw new SupabaseError(error.message);
}

// Item photos ----------------------------------------------------------------

/**
 * Upload photo bytes to the `grocery-item-images` bucket at the
 * content-addressed key `<user_id>/<sha256>`. Idempotent
 * (upsert:true) - re-uploading the same image is a harmless
 * overwrite. Returns the object key.
 */
export async function uploadGroceryItemImageObject(
  client: SupabaseClient,
  sha256: string,
  dataBase64: string,
  mimeType: string
): Promise<string> {
  const session = await getSession(client);
  if (!session) throw new SupabaseError('Not authenticated.');
  const path = `${session.user.id}/${sha256}`;
  const { error } = await client.storage
    .from('grocery-item-images')
    .upload(path, base64ToBytes(dataBase64), {
      contentType: mimeType,
      upsert: true,
    });
  if (error) throw new SupabaseError(error.message);
  return path;
}

/**
 * Insert a product photo into the user's grocery-image library, or
 * return the existing row's id when the bytes hash matches one
 * already present. Upload-then-record ordering means a reader never
 * sees a row pointing at a missing object.
 */
export async function upsertGroceryItemImage(
  client: SupabaseClient,
  sha256: string,
  mimeType: string,
  sizeBytes: number,
  dataBase64: string
): Promise<string> {
  const storagePath = await uploadGroceryItemImageObject(
    client,
    sha256,
    dataBase64,
    mimeType
  );
  const { data, error } = await client.rpc('grocery_item_image_upsert', {
    p_sha256: sha256,
    p_mime_type: mimeType,
    p_size_bytes: sizeBytes,
    p_storage_path: storagePath,
  });
  if (error) throw new SupabaseError(error.message);
  if (typeof data !== 'string') {
    throw new SupabaseError('image upsert returned no id');
  }
  return data;
}
