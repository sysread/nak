/**
 * Wiki-articles domain slice of the Supabase data layer: the
 * alphabetical listing and its offset-paged variant, the single-row
 * fetch, the favorites bucket and its toggle, article CRUD, and the
 * semantic + substring article search.
 *
 * The bibliography/See-Also reads and the changelog live in the
 * sibling ./wiki-sources.ts (article satellite tables); the
 * background agent-run routes live in ./agent-runs.ts. Dated records
 * attached to an article live in the sibling ./wiki-records.ts.
 *
 * RLS on wiki_articles scopes every query to the signed-in user's
 * own rows, so these functions don't filter by user_id on
 * select/update/delete. Inserts do need to set user_id explicitly
 * (RLS checks with_check against the row, and there's no default).
 *
 * Plain async functions taking the shared SupabaseClient as their
 * first argument - no class, no state - so each can be unit-tested
 * against a stubbed client without constructing SupabaseService. The
 * SupabaseService facade (../supabase.ts) delegates its wiki-article
 * methods here one-for-one under the same names; UI code calls
 * `app.supabase.<method>()` and should not import this module
 * directly. Row types and coercers live in ./types.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { SupabaseError } from './error';
import { getSession } from './session';
import { ilikeLogicTreePattern } from './query-utils';
import type { WikiArticle, OffsetPage } from './types';
import { coerceWikiArticle } from './types';

/**
 * Mirror of the facade's getSession: unwrap client.auth.getSession(),
 * throwing SupabaseError on failure. Private to this slice so the
 * article insert keeps its exact error behavior without reaching back
 * into SupabaseService.
 */
/**
 * Alphabetical listing of every wiki article for the current user.
 * Sort key is `lower(title)` so case differences ("Apple" vs
 * "apple") fold together. Limit defaults to 500, matching memories
 * - a single user is unlikely to author thousands of
 * encyclopedic articles, and pagination would complicate the
 * client-side store filtering pattern.
 */
export async function listWikiArticles(
  client: SupabaseClient,
  opts: { limit?: number } = {}
): Promise<WikiArticle[]> {
  const { data, error } = await client
    .from('wiki_articles')
    .select('id, title, content, favorite, created_at, updated_at')
    .order('title', { ascending: true })
    .limit(opts.limit ?? 500);
  if (error) throw new SupabaseError(error.message);
  return (data ?? []).map((row) => coerceWikiArticle(row as Record<string, unknown>));
}

/**
 * Semantic + substring search over wiki articles. Vector hits first
 * (RPC), then unembedded ILIKE hits, deduped by id. Empty `query`
 * returns the alphabetical listing without embedding.
 * `queryEmbedding` may be null - callers without Venice get
 * ILIKE-only results.
 */
export async function searchWikiArticles(
  client: SupabaseClient,
  opts: {
    query: string;
    queryEmbedding: number[] | null;
    limit?: number;
  }
): Promise<WikiArticle[]> {
  const query = opts.query.trim();
  const limit = opts.limit ?? 20;
  if (query.length === 0) return listWikiArticles(client, { limit });

  const pattern = ilikeLogicTreePattern(query);

  const ilikePromise = client
    .from('wiki_articles')
    .select('id, title, content, favorite, created_at, updated_at')
    .or(`title.ilike.${pattern},content.ilike.${pattern}`)
    .order('title', { ascending: true })
    .limit(limit);

  const semanticPromise = opts.queryEmbedding
    ? client.rpc('search_wiki_articles_by_embedding', {
        query_embedding: opts.queryEmbedding,
        match_limit: limit,
      })
    : Promise.resolve({ data: [] as unknown[], error: null });

  const [ilikeRes, semRes] = await Promise.all([ilikePromise, semanticPromise]);
  if (ilikeRes.error) throw new SupabaseError(ilikeRes.error.message);
  const ilikeRows = (ilikeRes.data ?? []).map((row) =>
    coerceWikiArticle(row as Record<string, unknown>)
  );
  const semanticRows =
    semRes.error !== null
      ? []
      : ((semRes.data ?? []) as unknown[]).map((row) =>
          coerceWikiArticle(row as Record<string, unknown>)
        );

  const out: WikiArticle[] = [];
  const seen = new Set<string>();
  // Semantic first - meaning matches outrank substring matches.
  for (const a of semanticRows) {
    if (seen.has(a.id)) continue;
    seen.add(a.id);
    out.push(a);
    if (out.length >= limit) return out;
  }
  for (const a of ilikeRows) {
    if (seen.has(a.id)) continue;
    seen.add(a.id);
    out.push(a);
    if (out.length >= limit) return out;
  }
  return out;
}

/**
 * One offset page of the wiki browse list, alphabetical by title.
 * Powers the sidebar's infinite scroll for the empty-query case; an
 * active search still goes through `searchWikiArticles` (capped, not
 * paged). `id` is the final tiebreak so articles colliding on title
 * keep a stable cross-page order.
 *
 * Ordering is the DB collation's `title ASC`, so the sidebar renders
 * server order verbatim rather than re-sorting with a JS
 * `localeCompare` - a client re-sort over a partial page would
 * disagree with the server's page boundaries and shuffle rows across
 * the seam mid-scroll.
 */
export async function listWikiArticlesPage(
  client: SupabaseClient,
  opts: {
    offset: number;
    pageSize: number;
  }
): Promise<OffsetPage<WikiArticle>> {
  const { data, error } = await client
    .from('wiki_articles')
    .select('id, title, content, favorite, created_at, updated_at')
    .order('title', { ascending: true })
    .order('id', { ascending: true })
    .range(opts.offset, opts.offset + opts.pageSize);
  if (error) throw new SupabaseError(error.message);
  const all = (data ?? []).map((row) =>
    coerceWikiArticle(row as Record<string, unknown>)
  );
  const hasMore = all.length > opts.pageSize;
  return { rows: hasMore ? all.slice(0, opts.pageSize) : all, hasMore };
}

/**
 * Fetch one article by id, or null if it isn't there. The wiki
 * sidebar normally keeps the open article in `wikiStore.results`, so
 * this exists for the cases the list doesn't cover: a deep link to an
 * article that was never paged in, and the offline read-through
 * (`getArticleCached`) that needs an authoritative single-row fetch.
 * Clone of `getRecipe`.
 */
export async function getWikiArticleById(
  client: SupabaseClient,
  id: string
): Promise<WikiArticle | null> {
  const { data, error } = await client
    .from('wiki_articles')
    .select('id, title, content, favorite, created_at, updated_at')
    .eq('id', id)
    .maybeSingle();
  if (error) throw new SupabaseError(error.message);
  return data ? coerceWikiArticle(data as Record<string, unknown>) : null;
}

/**
 * Every article flagged `favorite`. Fetched whole (the flagged subset
 * is small and the partial index keeps it cheap) so the sidebar's
 * Favorites bucket and the offline-sync reconcile both see the
 * complete set rather than a page window. Twin of
 * `listFavoriteRecipes`.
 */
export async function listFavoriteWikiArticles(
  client: SupabaseClient
): Promise<WikiArticle[]> {
  const { data, error } = await client
    .from('wiki_articles')
    .select('id, title, content, favorite, created_at, updated_at')
    .eq('favorite', true)
    .order('title', { ascending: true });
  if (error) throw new SupabaseError(error.message);
  return (data ?? []).map((row) =>
    coerceWikiArticle(row as Record<string, unknown>)
  );
}

/**
 * Toggle the `favorite` bookmark. Direct update, no version row and
 * no `updated_at` bump - favorite is a personal bookmark, not article
 * content. Mirrors `setRecipeFavorite`. The schema trigger
 * `clear_wiki_embedding_on_change` only fires on title/content, so
 * this leaves the embedding intact too.
 */
export async function setWikiArticleFavorite(
  client: SupabaseClient,
  id: string,
  favorite: boolean
): Promise<void> {
  const { error } = await client
    .from('wiki_articles')
    .update({ favorite })
    .eq('id', id);
  if (error) throw new SupabaseError(error.message);
}

export async function createWikiArticle(
  client: SupabaseClient,
  args: {
    title: string;
    content: string;
  }
): Promise<WikiArticle> {
  const session = await getSession(client);
  if (!session) throw new SupabaseError('Not authenticated.');
  const { data, error } = await client
    .from('wiki_articles')
    .insert({
      user_id: session.user.id,
      title: args.title,
      content: args.content,
    })
    .select('id, title, content, favorite, created_at, updated_at')
    .single();
  if (error) throw new SupabaseError(error.message);
  return coerceWikiArticle(data as Record<string, unknown>);
}

/**
 * Patch an article's title or content. RLS owner-scopes the update.
 * The schema trigger `clear_wiki_embedding_on_change` nulls the
 * embedding + claim columns when title or content changes so the
 * worker re-embeds on its next poll.
 */
export async function updateWikiArticle(
  client: SupabaseClient,
  id: string,
  patch: { title?: string; content?: string }
): Promise<WikiArticle> {
  const { data, error } = await client
    .from('wiki_articles')
    .update({ ...patch, updated_at: new Date().toISOString() })
    .eq('id', id)
    .select('id, title, content, favorite, created_at, updated_at')
    .single();
  if (error) throw new SupabaseError(error.message);
  return coerceWikiArticle(data as Record<string, unknown>);
}

export async function deleteWikiArticle(
  client: SupabaseClient,
  id: string
): Promise<void> {
  const { error } = await client.from('wiki_articles').delete().eq('id', id);
  if (error) throw new SupabaseError(error.message);
}
