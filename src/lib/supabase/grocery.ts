/**
 * Grocery domain slice of the Supabase data layer: store sections
 * (list / create / rename / delete / reorder / first-run seed),
 * catalog products (create / update / delete), list entries (open /
 * acquire / remove), the read paths over the flattened
 * `grocery_products_view`, and the product-photo upload + signed-URL
 * resolution against the `grocery-item-images` bucket.
 *
 * The write vocabulary mirrors the two-table model:
 *   - products are the durable catalog (name / note / section /
 *     photo / source recipe); deleting one is the only destructive
 *     verb and cascades its entries;
 *   - "on the list" is an OPEN entry; setProductOnList flips it by
 *     inserting an open entry (revival) or stamping acquired_at
 *     (a purchase); removeProductFromList deletes the open entry
 *     without recording a purchase (un-planning).
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
  GroceryProduct,
  GroceryProductPatch,
  GroceryProductView,
  GroceryEntryPatch,
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
 * Delete a section. Its products fall back to the "Other"
 * pseudo-section via the FK's `on delete set null` - nothing is lost.
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

// Products (read paths over grocery_products_view) ---------------------------

// The flat projection every read uses. The view (see schema.sql)
// already joins the recipe title, the photo's storage path, and the
// product's CURRENT entry (open when on the list, else the latest
// purchase), so no PostgREST embeds are involved.
const VIEW_SELECT =
  'id, name, note, section_id, section_source, recipe_id, image_id, ' +
  'created_at, updated_at, recipe_title, image_storage_path, ' +
  'entry_id, count, unit, acquired_at, on_list';

type ViewRow = Omit<GroceryProductView, 'image_url'> & {
  image_storage_path: string | null;
};

/**
 * Map raw view rows into GroceryProductView, batch-resolving signed
 * URLs for every photo in one Storage call. Rows whose signing fails
 * degrade to no photo rather than failing the list read.
 */
async function toProductViews(
  client: SupabaseClient,
  rows: ViewRow[]
): Promise<GroceryProductView[]> {
  const paths = rows
    .map((r) => r.image_storage_path)
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
    const { image_storage_path, ...product } = r;
    return {
      ...product,
      image_url:
        (image_storage_path && signed.get(image_storage_path)) || null,
    };
  });
}

/**
 * The active shopping list: every product with an open entry, most
 * recently updated first. Fetched whole - the current list is small
 * by nature (the unbounded set is the purchase history, windowed
 * below).
 */
export async function listOnListGroceryProducts(
  client: SupabaseClient
): Promise<GroceryProductView[]> {
  const { data, error } = await client
    .from('grocery_products_view')
    .select(VIEW_SELECT)
    .eq('on_list', true)
    .order('updated_at', { ascending: false });
  if (error) throw new SupabaseError(error.message);
  return toProductViews(client, (data ?? []) as unknown as ViewRow[]);
}

/**
 * One recency window of the purchase history: products NOT on the
 * list, most recently acquired first. Windowed, never fetched whole -
 * this set grows over shopping trips forever. `hasMore` is derived
 * from the +1 overfetch, same shape as listRecipesPage. Products with
 * no entries at all (un-planned recipe ingredients) are excluded:
 * they were never bought, so they are catalog-only until revived.
 */
export async function listAcquiredGroceryProductsPage(
  client: SupabaseClient,
  opts: { offset: number; pageSize: number }
): Promise<{ rows: GroceryProductView[]; hasMore: boolean }> {
  const { data, error } = await client
    .from('grocery_products_view')
    .select(VIEW_SELECT)
    .eq('on_list', false)
    .not('acquired_at', 'is', null)
    .order('acquired_at', { ascending: false })
    .order('id', { ascending: false })
    .range(opts.offset, opts.offset + opts.pageSize);
  if (error) throw new SupabaseError(error.message);
  const rows = (data ?? []) as unknown as ViewRow[];
  const hasMore = rows.length > opts.pageSize;
  const windowRows = hasMore ? rows.slice(0, opts.pageSize) : rows;
  return { rows: await toProductViews(client, windowRows), hasMore };
}

/**
 * One window of the full catalog for the sidebar's all-items browse:
 * optional ILIKE name search, optional status filter (`onList`;
 * false = "acquired", i.e. off the list but bought at least once),
 * optional section filter (`sectionId`; `'other'` matches the
 * null-section pseudo-bucket), and `manualOnly` to restrict to
 * standalone products (recipe_id is null - the sidebar's "Staples",
 * shown by default with the recipe-sourced rows behind a toggle).
 * Server-side filters so the page window stays honest. `hasMore`
 * derives from the +1 overfetch, same shape as listRecipesPage.
 */
export async function listGroceryProductsPage(
  client: SupabaseClient,
  opts: {
    offset: number;
    pageSize: number;
    query?: string;
    onList?: boolean;
    sectionId?: string | 'other';
    manualOnly?: boolean;
  }
): Promise<{ rows: GroceryProductView[]; hasMore: boolean }> {
  let q = client.from('grocery_products_view').select(VIEW_SELECT);
  const query = opts.query?.trim() ?? '';
  if (query.length > 0) q = q.ilike('name', ilikeFilterPattern(query));
  if (opts.onList === true) q = q.eq('on_list', true);
  else if (opts.onList === false) {
    // "Acquired" means bought before, not merely absent from the
    // list - a never-bought, un-planned recipe product is neither.
    q = q.eq('on_list', false).not('acquired_at', 'is', null);
  }
  if (opts.sectionId === 'other') q = q.is('section_id', null);
  else if (opts.sectionId !== undefined) q = q.eq('section_id', opts.sectionId);
  if (opts.manualOnly === true) q = q.is('recipe_id', null);
  // Alphabetical by name (id tiebreak so the offset window can't drop
  // or repeat a colliding row across page boundaries). Ordered by the
  // column's collation server-side - a client re-sort of a paged
  // window would disagree with the server's page seams, same
  // rationale as the recipe sidebar's A-Z sort.
  q = q
    .order('name', { ascending: true })
    .order('id', { ascending: true })
    .range(opts.offset, opts.offset + opts.pageSize);
  const { data, error } = await q;
  if (error) throw new SupabaseError(error.message);
  const rows = (data ?? []) as unknown as ViewRow[];
  const hasMore = rows.length > opts.pageSize;
  const windowRows = hasMore ? rows.slice(0, opts.pageSize) : rows;
  return { rows: await toProductViews(client, windowRows), hasMore };
}

/**
 * Suggestion source for the add-to-list input: standalone products
 * NOT currently on the list whose name matches the query. Every
 * variant is its own suggestion (identity is label plus details, so
 * "corn, canned" and "corn, fresh" both offer themselves); picking
 * one revives that exact product via setProductOnList. Recipe
 * products are excluded - they are managed from their recipe, and
 * their names are poor evidence without the recipe's context.
 */
export async function searchGrocerySuggestions(
  client: SupabaseClient,
  query: string,
  limit: number
): Promise<GroceryProductView[]> {
  const trimmed = query.trim();
  if (trimmed.length === 0) return [];
  const { data, error } = await client
    .from('grocery_products_view')
    .select(VIEW_SELECT)
    .eq('on_list', false)
    .is('recipe_id', null)
    .ilike('name', ilikeFilterPattern(trimmed))
    // Most recently bought first; never-bought variants trail.
    .order('acquired_at', { ascending: false, nullsFirst: false })
    .limit(limit);
  if (error) throw new SupabaseError(error.message);
  return toProductViews(client, (data ?? []) as unknown as ViewRow[]);
}

/**
 * Every product linked to a recipe, with its current entry state.
 * Drives the recipe detail pane's ingredient checkbox sync - the
 * checkbox mirrors `on_list`, and off-list products are fetched too
 * so a re-check can revive the existing product (keeping its learned
 * section) instead of inserting a duplicate.
 */
export async function listGroceryProductsForRecipe(
  client: SupabaseClient,
  recipeId: string
): Promise<GroceryProductView[]> {
  const { data, error } = await client
    .from('grocery_products_view')
    .select(VIEW_SELECT)
    .eq('recipe_id', recipeId);
  if (error) throw new SupabaseError(error.message);
  return toProductViews(client, (data ?? []) as unknown as ViewRow[]);
}

// Product + entry writes -----------------------------------------------------

/**
 * Create a catalog product and put it on the list (an open entry).
 * The quantity rides the entry, not the product - amounts are
 * per-add and not part of a variant's identity.
 */
export async function createGroceryProduct(
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
): Promise<GroceryProduct> {
  const session = await getSession(client);
  if (!session) throw new SupabaseError('Not authenticated.');
  const name = input.name.trim();
  if (name.length === 0) throw new SupabaseError('product name is required');
  const { data, error } = await client
    .from('grocery_products')
    .insert({
      user_id: session.user.id,
      name,
      note: input.note ?? null,
      section_id: input.section_id ?? null,
      // A caller-provided section is a user choice; otherwise the
      // product starts unfiled (renders in Other until filed by the
      // user or, later, the auto-sectioning agent).
      section_source: input.section_id != null ? 'user' : null,
      recipe_id: input.recipe_id ?? null,
      image_id: input.image_id ?? null,
    })
    .select(
      'id, name, note, section_id, section_source, recipe_id, image_id, created_at, updated_at'
    )
    .single();
  if (error) throw new SupabaseError(error.message);
  const product = data as GroceryProduct;
  await openEntry(client, session.user.id, product.id, {
    count: input.count ?? null,
    unit: input.unit ?? null,
  });
  return product;
}

/** Insert an open entry, tolerating one already being open. */
async function openEntry(
  client: SupabaseClient,
  userId: string,
  productId: string,
  qty: { count: string | null; unit: string | null }
): Promise<void> {
  const { error } = await client.from('grocery_list_entries').insert({
    user_id: userId,
    product_id: productId,
    count: qty.count,
    unit: qty.unit,
  });
  // 23505 = unique_violation on the one-open-entry-per-product index:
  // the product is already on the list (a concurrent add from another
  // surface), which is the state the caller wanted - not an error.
  if (error && error.code !== '23505') throw new SupabaseError(error.message);
}

/**
 * Flip a product's list membership.
 *
 *   on = true    open an entry (revival). The optional quantity is
 *                for the new entry; a product already on the list is
 *                a no-op.
 *   on = false   stamp the open entry's acquired_at - a PURCHASE.
 *                For un-planning without recording a purchase, use
 *                removeProductFromList instead.
 */
export async function setProductOnList(
  client: SupabaseClient,
  productId: string,
  on: boolean,
  qty?: { count?: string | null; unit?: string | null }
): Promise<void> {
  if (on) {
    const session = await getSession(client);
    if (!session) throw new SupabaseError('Not authenticated.');
    await openEntry(client, session.user.id, productId, {
      count: qty?.count ?? null,
      unit: qty?.unit ?? null,
    });
    return;
  }
  const { error } = await client
    .from('grocery_list_entries')
    .update({ acquired_at: new Date().toISOString() })
    .eq('product_id', productId)
    .is('acquired_at', null);
  if (error) throw new SupabaseError(error.message);
}

/**
 * Un-plan: delete the product's open entry WITHOUT recording a
 * purchase. The product row - and with it the learned section, note,
 * and photo - survives. This is the recipe checkbox's uncheck verb;
 * nothing fake enters the purchase history.
 */
export async function removeProductFromList(
  client: SupabaseClient,
  productId: string
): Promise<void> {
  const { error } = await client
    .from('grocery_list_entries')
    .delete()
    .eq('product_id', productId)
    .is('acquired_at', null);
  if (error) throw new SupabaseError(error.message);
}

/**
 * Partial product update. Absent field = leave unchanged; explicit
 * null = clear (name excepted - it can only be replaced). Setting
 * `section_id` (including to null = Other) stamps
 * `section_source = 'user'`: a user edit is authoritative and the
 * auto-sectioning agent never overwrites it. Bumps updated_at.
 */
export async function updateGroceryProduct(
  client: SupabaseClient,
  id: string,
  patch: GroceryProductPatch
): Promise<void> {
  const update: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if ('name' in patch) {
    const name = (patch.name ?? '').trim();
    if (name.length === 0) throw new SupabaseError('product name is required');
    update.name = name;
  }
  if ('note' in patch) update.note = patch.note ?? null;
  if ('section_id' in patch) {
    update.section_id = patch.section_id ?? null;
    update.section_source = 'user';
  }
  if ('image_id' in patch) update.image_id = patch.image_id ?? null;
  const { error } = await client
    .from('grocery_products')
    .update(update)
    .eq('id', id);
  if (error) throw new SupabaseError(error.message);
}

/**
 * Update the quantity on a specific entry (the editor's count/unit
 * fields). Timestamps are owned by the open/acquire verbs.
 */
export async function updateGroceryListEntry(
  client: SupabaseClient,
  entryId: string,
  patch: GroceryEntryPatch
): Promise<void> {
  const update: Record<string, unknown> = {};
  if ('count' in patch) update.count = patch.count ?? null;
  if ('unit' in patch) update.unit = patch.unit ?? null;
  if (Object.keys(update).length === 0) return;
  const { error } = await client
    .from('grocery_list_entries')
    .update(update)
    .eq('id', entryId);
  if (error) throw new SupabaseError(error.message);
}

/**
 * Delete a product outright - the editor's Delete button. Entries
 * cascade, so its purchase history goes with it; this is the one
 * verb that forgets a variant.
 */
export async function deleteGroceryProduct(
  client: SupabaseClient,
  id: string
): Promise<void> {
  const { error } = await client.from('grocery_products').delete().eq('id', id);
  if (error) throw new SupabaseError(error.message);
}

// Product photos -------------------------------------------------------------

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
