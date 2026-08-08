/**
 * Cookbook domain slice of the Supabase data layer: recipe listing /
 * paging / search, recipe CRUD (create and update run through the
 * version-snapshotting RPCs), the version-history reads and revert,
 * and - under their own banner below - the recipe photo library
 * (content-addressed image upsert, storage upload, and signed-URL
 * resolution for the current photo set).
 *
 * Same RLS posture as memories: every query is scoped to the
 * signed-in user automatically; only inserts need an explicit user_id
 * because the with_check policy has no default to fall back on.
 *
 * Embedding pipeline: the cookbook stays small enough that the LLM
 * tool path (`recipe_list`, `recipe_search`) gets by on ILIKE alone,
 * but the human-facing drawer search (`RecipeList.svelte`) wires
 * through the shared embeddings worker so a fuzzy query ("fluffy
 * potato side") can find a recipe by meaning rather than title
 * substring. Same claim/save/search RPC trio as the wiki source.
 *
 * Plain async functions taking the shared SupabaseClient as their
 * first argument - no class, no state - so each can be unit-tested
 * against a stubbed client without constructing SupabaseService. The
 * SupabaseService facade (../supabase.ts) delegates its cookbook
 * methods here one-for-one under the same names; UI code calls
 * `app.supabase.<method>()` and should not import this module
 * directly. Row types live in ./types; the topic-filter and ILIKE
 * helpers shared with the thread / memory paths live in ./query-utils.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { SupabaseError } from './error';
import { getSession } from './session';
import {
  base64ToBytes,
  ilikeFilterPattern,
  topicsFilterClause,
} from './query-utils';
import type {
  Recipe,
  RecipeVersion,
  RecipePhoto,
  RecipePhotoInput,
  OffsetPage,
} from './types';

/**
 * Mirror of the facade's getSession: unwrap client.auth.getSession(),
 * throwing SupabaseError on failure. Private to this slice so the
 * storage upload path keeps its exact error behavior without reaching
 * back into SupabaseService.
 */
// TTL for recipe-image display signed URLs. Generous (6h) so a recipe
// detail / lightbox kept open through a session keeps rendering; a
// longer-open pane re-resolves on reload.
const RECIPE_IMAGE_SIGNED_URL_TTL_SECONDS = 60 * 60 * 6;

/**
 * Flatten `RecipePhotoInput[]` into the parallel arrays the
 * versioned recipe RPCs accept on the wire. Empty/whitespace labels
 * round-trip as null (the DB also normalises them server-side; we
 * mirror the rule here so the wire payload is honest about which
 * photos have a caption and which don't). Returns `null` for the
 * label array when no photo carries a label - lets the RPC skip the
 * label parameter path entirely on the common "no captions yet"
 * shape rather than threading a vector of nulls.
 */
function splitPhotoInputs(photos: RecipePhotoInput[]): {
  imageIds: string[];
  imageLabels: (string | null)[] | null;
} {
  const imageIds = photos.map((p) => p.id);
  const labels = photos.map((p) => {
    if (p.label === null || p.label === undefined) return null;
    const trimmed = p.label.trim();
    return trimmed.length === 0 ? null : trimmed;
  });
  const imageLabels = labels.some((l) => l !== null) ? labels : null;
  return { imageIds, imageLabels };
}

// Recipes ------------------------------------------------------------------

/**
 * List recipes, optionally filtered by a case-insensitive `title`
 * substring. Capped at `limit` to keep the recipe_list tool result
 * small (one recipe's cooklang can be several kilobytes; a runaway
 * list would blow the context budget).
 *
 * `sort` defaults to 'updated' (most-recently-edited first). 'rating'
 * orders by stars descending with `nulls last`, then falls back to
 * `updated_at desc` so unrated rows still show in a stable order at
 * the bottom and ties among same-rated rows resolve to the most
 * recently touched.
 */
export async function listRecipes(
  client: SupabaseClient,
  query: string,
  limit: number,
  sort: 'updated' | 'rating' = 'updated'
): Promise<Recipe[]> {
  let q = client
    .from('recipes')
    .select(
      'id, title, source, source_url, cooklang, rating, upcoming, favorite, topics, created_at, updated_at'
    )
    .limit(limit);
  if (sort === 'rating') {
    q = q
      .order('rating', { ascending: false, nullsFirst: false })
      .order('updated_at', { ascending: false });
  } else {
    q = q.order('updated_at', { ascending: false });
  }
  if (query && query.length > 0) {
    q = q.ilike('title', ilikeFilterPattern(query));
  }
  const { data, error } = await q;
  if (error) throw new SupabaseError(error.message);
  return (data ?? []) as Recipe[];
}

/**
 * One offset page of the "All recipes" browse list. Powers the
 * sidebar's infinite scroll: the empty-query listing pages through
 * the whole cookbook instead of truncating at a fixed cap.
 *
 * `sort` matches the sidebar picker. Each mode ends with `id` as a
 * final tiebreak so rows that collide on the primary key (two
 * recipes with the same rating + updated_at) keep a stable order
 * across page boundaries - without it an offset window could drop or
 * repeat a colliding row.
 *
 * `selectedTopics` is applied server-side (the older client-side
 * filter only worked because the whole cookbook was in memory; a
 * partial page has to be filtered before it's sliced or the page
 * count would be wrong).
 */
export async function listRecipesPage(
  client: SupabaseClient,
  opts: {
    offset: number;
    pageSize: number;
    sort: 'updated' | 'rating' | 'alphabetical';
    selectedTopics?: readonly string[];
  }
): Promise<OffsetPage<Recipe>> {
  let q = client
    .from('recipes')
    .select(
      'id, title, source, source_url, cooklang, rating, upcoming, favorite, topics, created_at, updated_at'
    );
  if (opts.sort === 'rating') {
    q = q
      .order('rating', { ascending: false, nullsFirst: false })
      .order('updated_at', { ascending: false })
      .order('id', { ascending: false });
  } else if (opts.sort === 'alphabetical') {
    // Ordered by the column's collation rather than a JS
    // localeCompare so the server's page boundaries match what the
    // client renders - paginating an arbitrary client-side sort would
    // shuffle rows across the seam.
    // TODO: untitled drafts (empty title) sort to the head under a
    // raw `title ASC`, where the user expects them at the tail of an
    // A-Z list, and the collation's case/accent handling may diverge
    // from the dictionary order users expect. Both want a sort key
    // the offset window can page deterministically.
    q = q.order('title', { ascending: true }).order('id', { ascending: true });
  } else {
    q = q
      .order('updated_at', { ascending: false })
      .order('id', { ascending: false });
  }
  const topicsClause = topicsFilterClause(opts.selectedTopics ?? []);
  if (topicsClause) q = q.or(topicsClause);
  // Inclusive range: ask for pageSize + 1 rows so a full extra row
  // signals "another page exists" without a separate count query.
  q = q.range(opts.offset, opts.offset + opts.pageSize);
  const { data, error } = await q;
  if (error) throw new SupabaseError(error.message);
  const rows = (data ?? []) as Recipe[];
  const hasMore = rows.length > opts.pageSize;
  return { rows: hasMore ? rows.slice(0, opts.pageSize) : rows, hasMore };
}

/**
 * Every recipe flagged `upcoming` (the current grocery cycle).
 * Fetched whole rather than paged - the flagged subset is small and
 * the sidebar renders it as a complete bucket above the paginated
 * "All recipes" list, so a partial page would misrepresent it. The
 * topic filter stays client-side over this complete set.
 */
export async function listUpcomingRecipes(client: SupabaseClient): Promise<Recipe[]> {
  const { data, error } = await client
    .from('recipes')
    .select(
      'id, title, source, source_url, cooklang, rating, upcoming, favorite, topics, created_at, updated_at'
    )
    .eq('upcoming', true)
    .order('updated_at', { ascending: false });
  if (error) throw new SupabaseError(error.message);
  return (data ?? []) as Recipe[];
}

/** Every recipe flagged `favorite`. Same complete-bucket rationale as listUpcomingRecipes. */
export async function listFavoriteRecipes(client: SupabaseClient): Promise<Recipe[]> {
  const { data, error } = await client
    .from('recipes')
    .select(
      'id, title, source, source_url, cooklang, rating, upcoming, favorite, topics, created_at, updated_at'
    )
    .eq('favorite', true)
    .order('updated_at', { ascending: false });
  if (error) throw new SupabaseError(error.message);
  return (data ?? []) as Recipe[];
}

export async function getRecipe(
  client: SupabaseClient,
  id: string
): Promise<Recipe | null> {
  const { data, error } = await client
    .from('recipes')
    .select(
      'id, title, source, source_url, cooklang, rating, upcoming, favorite, topics, created_at, updated_at'
    )
    .eq('id', id)
    .maybeSingle();
  if (error) throw new SupabaseError(error.message);
  return (data as Recipe | null) ?? null;
}

/**
 * Semantic + substring search over recipes. Same merge contract as
 * `searchWikiArticles`: vector hits first (RPC, ordered by cosine
 * similarity), then ILIKE hits the vector
 * pass missed, deduped by id and capped at `limit`. Empty `query`
 * falls back to `listRecipes` (most-recently-updated first) so
 * callers don't need to special-case the no-query branch.
 * `queryEmbedding` may be null - callers without Venice get ILIKE-
 * only results.
 *
 * The ILIKE side runs on title only; the semantic side has the
 * full `title + source + cooklang` blob folded into the embedding
 * by the worker, so a meaning match can reach ingredient or
 * technique text the title alone misses.
 */
export async function searchRecipes(
  client: SupabaseClient,
  opts: {
    query: string;
    queryEmbedding: number[] | null;
    limit?: number;
  }
): Promise<Recipe[]> {
  const query = opts.query.trim();
  const limit = opts.limit ?? 50;
  if (query.length === 0) return listRecipes(client, '', limit);

  const pattern = ilikeFilterPattern(query);

  const ilikePromise = client
    .from('recipes')
    .select(
      'id, title, source, source_url, cooklang, rating, upcoming, favorite, topics, created_at, updated_at'
    )
    .ilike('title', pattern)
    .order('updated_at', { ascending: false })
    .limit(limit);

  const semanticPromise = opts.queryEmbedding
    ? client.rpc('search_recipes_by_embedding', {
        query_embedding: opts.queryEmbedding,
        match_limit: limit,
      })
    : Promise.resolve({ data: [] as unknown[], error: null });

  const [ilikeRes, semRes] = await Promise.all([ilikePromise, semanticPromise]);
  if (ilikeRes.error) throw new SupabaseError(ilikeRes.error.message);
  const ilikeRows = ((ilikeRes.data ?? []) as unknown[]) as Recipe[];
  const semanticRows: Recipe[] =
    semRes.error !== null ? [] : (((semRes.data ?? []) as unknown[]) as Recipe[]);

  const out: Recipe[] = [];
  const seen = new Set<string>();
  for (const r of semanticRows) {
    if (seen.has(r.id)) continue;
    seen.add(r.id);
    out.push(r);
    if (out.length >= limit) return out;
  }
  for (const r of ilikeRows) {
    if (seen.has(r.id)) continue;
    seen.add(r.id);
    out.push(r);
    if (out.length >= limit) return out;
  }
  return out;
}

/**
 * Create a recipe and snapshot the initial state into
 * `recipe_versions` atomically via the
 * `recipe_create_with_version` RPC. `changeMessage` is required —
 * it appears in the History panel as the description of the
 * initial save (e.g. "Imported from NYT Cooking", "Created by
 * hand"). `photos` is the ordered list of `(image_id, label)`
 * pairs to link to the new version (empty by default for a
 * recipe with no photos). A null/blank label means "no caption".
 */
export async function createRecipe(
  client: SupabaseClient,
  title: string,
  cooklang: string,
  source: string | null,
  sourceUrl: string | null,
  rating: number | null,
  changeMessage: string,
  photos: RecipePhotoInput[] = []
): Promise<Recipe> {
  if (!changeMessage || changeMessage.trim().length === 0) {
    throw new SupabaseError('changeMessage is required');
  }
  if (rating !== null && (rating < 1 || rating > 5 || !Number.isInteger(rating))) {
    throw new SupabaseError('rating must be an integer between 1 and 5');
  }
  const { imageIds, imageLabels } = splitPhotoInputs(photos);
  const { data, error } = await client.rpc(
    'recipe_create_with_version',
    {
      p_title: title,
      p_cooklang: cooklang,
      p_source: source,
      p_source_url: sourceUrl,
      p_rating: rating,
      p_image_ids: imageIds,
      p_image_labels: imageLabels,
      p_change_message: changeMessage.trim(),
    }
  );
  if (error) throw new SupabaseError(error.message);
  const rows = (data ?? []) as Recipe[];
  if (rows.length === 0) {
    throw new SupabaseError('create returned no row');
  }
  return rows[0]!;
}

/**
 * Partial update. Caller guarantees at least one field in `patch`
 * is set - enforced by the recipe_update tool and the Cookbook
 * Edit pane before this method runs. Goes through
 * `recipe_update_with_version` so the prior state is snapshotted
 * into `recipe_versions` in the same transaction. `changeMessage`
 * is required and lands on the new version row.
 *
 * The boolean-flag pairs (`p_set_*` + value) preserve the
 * "absent leaves field unchanged; explicit null clears" semantics
 * across the wire: TypeScript's `'field' in patch` distinguishes
 * the two cases, but the Postgres parameter list cannot.
 *
 * `photos` follows the same pattern: omit to inherit the previous
 * version's photo set (and labels) unchanged; pass an array
 * (possibly empty) to set the new version's photo set explicitly.
 * Each entry is `{id, label}`; a null/blank label is "no caption".
 * Bulk editor saves include it; tool-driven scalar edits omit it.
 */
export async function updateRecipe(
  client: SupabaseClient,
  id: string,
  patch: {
    title?: string;
    cooklang?: string;
    source?: string | null;
    source_url?: string | null;
    rating?: number | null;
    photos?: RecipePhotoInput[];
  },
  changeMessage: string
): Promise<Recipe> {
  if (!changeMessage || changeMessage.trim().length === 0) {
    throw new SupabaseError('changeMessage is required');
  }
  if (
    'rating' in patch &&
    patch.rating !== null &&
    patch.rating !== undefined &&
    (patch.rating < 1 || patch.rating > 5 || !Number.isInteger(patch.rating))
  ) {
    throw new SupabaseError('rating must be an integer between 1 and 5');
  }
  const photoSplit =
    'photos' in patch ? splitPhotoInputs(patch.photos ?? []) : null;
  const { data, error } = await client.rpc(
    'recipe_update_with_version',
    {
      p_id: id,
      p_set_title: 'title' in patch,
      p_title: patch.title ?? null,
      p_set_cooklang: 'cooklang' in patch,
      p_cooklang: patch.cooklang ?? null,
      p_set_source: 'source' in patch,
      p_source: patch.source ?? null,
      p_set_source_url: 'source_url' in patch,
      p_source_url: patch.source_url ?? null,
      p_set_rating: 'rating' in patch,
      p_rating: patch.rating ?? null,
      p_set_image_ids: photoSplit !== null,
      p_image_ids: photoSplit?.imageIds ?? null,
      p_image_labels: photoSplit?.imageLabels ?? null,
      p_change_message: changeMessage.trim(),
    }
  );
  if (error) throw new SupabaseError(error.message);
  const rows = (data ?? []) as Recipe[];
  if (rows.length === 0) {
    throw new SupabaseError('update returned no row');
  }
  return rows[0]!;
}

/**
 * Toggle the workflow `upcoming` flag. Direct table update on
 * purpose - upcoming is not recipe content, so it bypasses the
 * version-writing RPC. We intentionally do not touch `updated_at`
 * either: marking a recipe as upcoming should not bump it to the
 * top of the recency sort, because the user is bookmarking it for
 * a near-future cook, not editing it.
 */
export async function setRecipeUpcoming(
  client: SupabaseClient,
  id: string,
  upcoming: boolean
): Promise<void> {
  const { error } = await client
    .from('recipes')
    .update({ upcoming })
    .eq('id', id);
  if (error) throw new SupabaseError(error.message);
}

/**
 * Toggle the `favorite` flag. Same non-versioned, non-`updated_at`-
 * bumping semantics as `setRecipeUpcoming` - favorite is a personal
 * bookmark, not recipe content, so it skips `recipe_versions` and
 * does not reshuffle the recency sort.
 */
export async function setRecipeFavorite(
  client: SupabaseClient,
  id: string,
  favorite: boolean
): Promise<void> {
  const { error } = await client
    .from('recipes')
    .update({ favorite })
    .eq('id', id);
  if (error) throw new SupabaseError(error.message);
}

export async function deleteRecipe(client: SupabaseClient, id: string): Promise<void> {
  const { error } = await client.from('recipes').delete().eq('id', id);
  if (error) throw new SupabaseError(error.message);
}

/**
 * List a recipe's full version history, newest first. Cold path —
 * called only when the History panel opens, never as part of the
 * recipe-list bulk fetch.
 */
export async function listRecipeVersions(
  client: SupabaseClient,
  recipeId: string
): Promise<RecipeVersion[]> {
  const { data, error } = await client
    .from('recipe_versions')
    .select(
      'id, recipe_id, title, source, source_url, cooklang, rating, change_message, created_at'
    )
    .eq('recipe_id', recipeId)
    .order('created_at', { ascending: false });
  if (error) throw new SupabaseError(error.message);
  return (data ?? []) as RecipeVersion[];
}

export async function getRecipeVersion(
  client: SupabaseClient,
  versionId: string
): Promise<RecipeVersion | null> {
  const { data, error } = await client
    .from('recipe_versions')
    .select(
      'id, recipe_id, title, source, source_url, cooklang, rating, change_message, created_at'
    )
    .eq('id', versionId)
    .maybeSingle();
  if (error) throw new SupabaseError(error.message);
  return (data as RecipeVersion | null) ?? null;
}

/**
 * Roll a recipe back to the content of an earlier version. Implemented
 * as a normal update whose patch is the chosen version's snapshot —
 * the revert itself becomes a new version row, so a misclick is
 * recoverable too. Throws if the version belongs to a different
 * recipe (defense against stale UI state passing the wrong id).
 *
 * Photos round-trip through the snapshot too: we read the version's
 * link rows (image ids + labels in display order) and pass them
 * into `photos` on the update patch. Revert restores the exact
 * photo set, order, and captions that were on the recipe at the
 * moment that version was saved.
 */
export async function revertRecipe(
  client: SupabaseClient,
  recipeId: string,
  versionId: string,
  changeMessage: string
): Promise<Recipe> {
  const v = await getRecipeVersion(client, versionId);
  if (!v) throw new SupabaseError('version not found');
  if (v.recipe_id !== recipeId) {
    throw new SupabaseError('version belongs to a different recipe');
  }
  const photos = await listRecipeVersionPhotoInputs(client, versionId);
  return updateRecipe(
    client,
    recipeId,
    {
      title: v.title,
      cooklang: v.cooklang,
      source: v.source,
      source_url: v.source_url,
      rating: v.rating,
      photos,
    },
    changeMessage
  );
}

// recipe photos --------------------------------------------------------
//
// Photos live in two tables: `recipe_images` holds the deduped bytes
// (one row per (user_id, sha256)), `recipe_version_images` links them
// to recipe versions. The "current" photo set for a recipe is the
// links on the recipe's most-recent version. See `supabase/schema.sql`
// for the full design rationale.

/**
 * Insert an image into the user's photo library, or return the id of
 * an existing row when the bytes hash matches one already present.
 * Server-side dedup is per-user via the `(user_id, sha256)` unique
 * constraint, so two users uploading the same image each get their
 * own row; the same user uploading the same image twice gets the
 * existing id.
 *
 * Both upload paths converge on this method: the editor's file picker
 * runs after `maybeDownscaleImage`, and the LLM's
 * `recipe_photos_attach` tool runs after copying bytes out of a
 * conversation attachment. Two callers, one dedup contract.
 */
export async function upsertRecipeImage(
  client: SupabaseClient,
  sha256: string,
  mimeType: string,
  sizeBytes: number,
  dataBase64: string
): Promise<string> {
  // Upload the bytes to the content-addressed key first (idempotent:
  // same sha -> same object, upsert:true), then record the row. The
  // object existing before the row means a reader never sees a row
  // pointing at a missing object.
  const storagePath = await uploadRecipeImageObject(client, sha256, dataBase64, mimeType);
  const { data, error } = await client.rpc('recipe_image_upsert', {
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

/**
 * Upload image bytes to the `recipe-images` bucket at the content-
 * addressed key `<user_id>/<sha256>`. Idempotent (upsert:true), so a
 * re-upload of the same image is a harmless overwrite. Returns the
 * object key. Shared by upsertRecipeImage and the one-time migrate.
 */
export async function uploadRecipeImageObject(
  client: SupabaseClient,
  sha256: string,
  dataBase64: string,
  mimeType: string
): Promise<string> {
  const session = await getSession(client);
  if (!session) throw new SupabaseError('Not authenticated.');
  const path = `${session.user.id}/${sha256}`;
  const { error } = await client.storage
    .from('recipe-images')
    .upload(path, base64ToBytes(dataBase64), { contentType: mimeType, upsert: true });
  if (error) throw new SupabaseError(error.message);
  return path;
}

/**
 * Fetch the photos currently linked to a recipe, with bytes, in
 * display order. "Currently linked" = on the latest version row.
 * Used by the detail pane and the edit form for thumb rendering.
 *
 * Implemented as a single embedded-select query: pull the latest
 * version row and dive into its link table and the image table in
 * one round-trip. Returns an empty array when the recipe has no
 * photos (or when the recipe has no version row, which shouldn't
 * happen post-versioning rollout but degrades gracefully).
 */
export async function listRecipePhotos(
  client: SupabaseClient,
  recipeId: string
): Promise<RecipePhoto[]> {
  const { data, error } = await client
    .from('recipe_versions')
    .select(
      'id, recipe_version_images(position, label, recipe_images(id, mime_type, size_bytes, storage_path))'
    )
    .eq('recipe_id', recipeId)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw new SupabaseError(error.message);
  if (!data) return [];
  // PostgREST returns embedded relations as arrays at the type
  // level, even for many-to-one FKs that are guaranteed-single at
  // runtime. The cast through `unknown` is the documented escape
  // hatch for "we know the shape better than the generic types
  // do." Runtime branches below cope with both shapes (single
  // object or single-element array) so we're not making a
  // brittle bet on PostgREST's serialisation mode.
  type ImageEmbed = {
    id: string;
    mime_type: string;
    size_bytes: number;
    storage_path: string | null;
  };
  type LinkRow = {
    position: number;
    label: string | null;
    recipe_images: ImageEmbed | ImageEmbed[] | null;
  };
  const links = (data as unknown as { recipe_version_images?: LinkRow[] | null })
    .recipe_version_images;
  if (!Array.isArray(links)) return [];

  // Collect the rows first, then batch-resolve signed URLs for the
  // bucket objects in a single Storage call.
  const rows: Array<{ img: ImageEmbed; position: number; label: string | null }> = [];
  for (const l of links) {
    const img = Array.isArray(l.recipe_images) ? l.recipe_images[0] : l.recipe_images;
    if (!img) continue;
    rows.push({ img, position: l.position, label: l.label ?? null });
  }

  const paths = rows
    .map((r) => r.img.storage_path)
    .filter((p): p is string => typeof p === 'string');
  const signed = new Map<string, string>();
  if (paths.length > 0) {
    const { data: signedData, error: signErr } = await client.storage
      .from('recipe-images')
      .createSignedUrls(paths, RECIPE_IMAGE_SIGNED_URL_TTL_SECONDS);
    if (signErr) throw new SupabaseError(signErr.message);
    for (const entry of signedData ?? []) {
      if (entry.signedUrl && typeof entry.path === 'string') {
        signed.set(entry.path, entry.signedUrl);
      }
    }
  }

  const photos: RecipePhoto[] = [];
  for (const { img, position, label } of rows) {
    const url = (img.storage_path && signed.get(img.storage_path)) || '';
    if (!url) continue; // no bucket object (or signing failed) - skip
    photos.push({
      id: img.id,
      position,
      mime_type: img.mime_type,
      size_bytes: img.size_bytes,
      url,
      label,
    });
  }
  photos.sort((a, b) => a.position - b.position);
  return photos;
}

/**
 * Fetch just the image IDs and labels (in order) on a given
 * version. Used by `revertRecipe` to round-trip the photo set
 * without paying for the bytes - the bytes already exist in
 * `recipe_images`, all we need for the revert is the ordered list
 * of `(id, label)` pairs to link onto the new version.
 */
export async function listRecipeVersionPhotoInputs(
  client: SupabaseClient,
  versionId: string
): Promise<RecipePhotoInput[]> {
  const { data, error } = await client
    .from('recipe_version_images')
    .select('image_id, position, label')
    .eq('recipe_version_id', versionId)
    .order('position', { ascending: true });
  if (error) throw new SupabaseError(error.message);
  return (
    (data ?? []) as Array<{ image_id: string; label: string | null }>
  ).map((r) => ({ id: r.image_id, label: r.label ?? null }));
}
