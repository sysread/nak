/**
 * Wiki-satellite domain slice of the Supabase data layer: the tables
 * that orbit a wiki article without being the article itself. Covers
 * the bibliography (`wiki_article_sources` - which conversations fed
 * an article), the See-Also suggestions (the
 * `find_related_wiki_articles` RPC), and the wiki changelog
 * (`wiki_changelog` append + paged listing).
 *
 * The changelog append is the one deliberate extra export consumed by
 * a sibling slice: ./wiki-records.ts lands a best-effort changelog row
 * against the parent article on every record / file / link mutation,
 * so it imports createWikiChangelogEntry from here rather than
 * duplicating the insert.
 *
 * Plain async functions taking the shared SupabaseClient as their
 * first argument - no class, no state - so each can be unit-tested
 * against a stubbed client without constructing SupabaseService. The
 * SupabaseService facade (../supabase.ts) delegates its wiki-satellite
 * methods here one-for-one under the same names; UI code calls
 * `app.supabase.<method>()` and should not import this module
 * directly. Row types and coercers live in ./types; the article table
 * itself is ./wiki.ts; the background agent-run routes are
 * ./agent-runs.ts.
 */
import type { SupabaseClient, Session } from '@supabase/supabase-js';
import { SupabaseError } from './error';
import type {
  WikiArticleSource,
  WikiArticleRelated,
  WikiChangelogKind,
  WikiChangelogEntry,
} from './types';
import { coerceWikiChangelogEntry } from './types';

/**
 * Mirror of the facade's getSession: unwrap client.auth.getSession(),
 * throwing SupabaseError on failure. Private to this slice so the
 * changelog insert keeps its exact error behavior without reaching
 * back into SupabaseService.
 */
async function getSession(client: SupabaseClient): Promise<Session | null> {
  const { data, error } = await client.auth.getSession();
  if (error) throw new SupabaseError(error.message);
  return data.session;
}

/**
 * Return the bibliography for one article: every thread that has
 * been attributed, joined with the thread's title, ordered by
 * `last_processed_at` ascending so the reader sees the article's
 * narrative of growth (oldest contributing conversation first).
 *
 * Threads hard-deleted out from under their attribution rows show
 * up with a null title until the cascade catches up; the UI handles
 * that with a placeholder.
 */
export async function listWikiArticleSources(
  client: SupabaseClient,
  articleId: string
): Promise<WikiArticleSource[]> {
  const { data, error } = await client
    .from('wiki_article_sources')
    .select('thread_id, first_processed_at, last_processed_at, threads(title)')
    .eq('article_id', articleId)
    .order('last_processed_at', { ascending: true });
  if (error) throw new SupabaseError(error.message);
  const out: WikiArticleSource[] = [];
  for (const row of (data ?? []) as Array<Record<string, unknown>>) {
    const threadId = row.thread_id;
    if (typeof threadId !== 'string') continue;
    const thread = row.threads as { title?: unknown } | null;
    const title =
      thread && typeof thread.title === 'string' ? thread.title : null;
    out.push({
      thread_id: threadId,
      thread_title: title,
      first_processed_at: String(row.first_processed_at ?? ''),
      last_processed_at: String(row.last_processed_at ?? ''),
    });
  }
  return out;
}

/**
 * Batched source-thread lookup for a candidate set of article ids.
 * Returns a Map keyed by article id whose value is the set of thread
 * ids that fed that article. Articles with no rows in
 * `wiki_article_sources` are absent from the map (orphan articles -
 * never written from a recorded conversation).
 *
 * Powers the sole-source exclusion in `searchWikiArticlesSemantic`
 * (src/lib/wiki.ts, the `excludeSoleSourceThreadId` option; the
 * venice function's wiki_search carries the same filter on its tool
 * context): the recall path needs to know
 * "is the current thread the ONLY source of this article?", which is
 * cheaper to answer against an in-memory map of all sources for the
 * returned candidates than as a per-article round-trip. Empty input
 * returns an empty Map without a round-trip.
 */
export async function listSourceThreadIdsForArticles(
  client: SupabaseClient,
  articleIds: readonly string[]
): Promise<Map<string, Set<string>>> {
  const out = new Map<string, Set<string>>();
  if (articleIds.length === 0) return out;
  const { data, error } = await client
    .from('wiki_article_sources')
    .select('article_id, thread_id')
    .in('article_id', [...articleIds]);
  if (error) throw new SupabaseError(error.message);
  for (const row of (data ?? []) as Array<Record<string, unknown>>) {
    const articleId = row.article_id;
    const threadId = row.thread_id;
    if (typeof articleId !== 'string' || typeof threadId !== 'string') continue;
    const set = out.get(articleId);
    if (set) set.add(threadId);
    else out.set(articleId, new Set([threadId]));
  }
  return out;
}

/**
 * See Also for an article. Single RPC call; the floor calculation
 * (minimum cosine similarity between the article and its source
 * conversations) lives server-side so the client never has to fetch
 * raw embeddings.
 *
 * Returns an empty array when the article has no embedding yet (the
 * embeddings worker hasn't caught up after a content change),
 * when no other articles clear the floor, or when there are simply
 * no other articles. All three are honest "nothing to suggest".
 */
export async function findRelatedWikiArticles(
  client: SupabaseClient,
  articleId: string,
  limit = 5
): Promise<WikiArticleRelated[]> {
  const { data, error } = await client.rpc('find_related_wiki_articles', {
    p_article_id: articleId,
    p_limit: limit,
  });
  if (error) throw new SupabaseError(error.message);
  const out: WikiArticleRelated[] = [];
  for (const row of (data ?? []) as Array<Record<string, unknown>>) {
    const id = row.id;
    const title = row.title;
    const similarity = row.similarity;
    if (typeof id !== 'string' || typeof title !== 'string') continue;
    out.push({
      id,
      title,
      similarity: typeof similarity === 'number' ? similarity : 0,
    });
  }
  return out;
}

/**
 * Append a wiki-changelog row. Called by every wiki write path: the
 * three tools (`wiki_create`/`wiki_update`/`wiki_delete`), the
 * librarian's same three tools, and the user's direct edits in
 * Wiki.svelte. Throws on a failed insert so callers can decide
 * whether to surface the error or swallow it - the tool path
 * currently swallows (the mutation already landed; a missed
 * changelog row is a smaller harm than a confusing post-success
 * error).
 *
 * `article_id` is null for deletes (the article is already gone by
 * the time this lands). For create/update it points at the live
 * article; if the article is later deleted the FK cascades to null
 * but `title_at_change` keeps the row meaningful.
 */
export async function createWikiChangelogEntry(
  client: SupabaseClient,
  args: {
    article_id: string | null;
    kind: WikiChangelogKind;
    title_at_change: string;
    message: string;
  }
): Promise<void> {
  const session = await getSession(client);
  if (!session) throw new SupabaseError('Not authenticated.');
  const title = args.title_at_change.trim();
  const message = args.message.trim();
  if (title.length === 0 || message.length === 0) return;
  const { error } = await client.from('wiki_changelog').insert({
    user_id: session.user.id,
    article_id: args.article_id,
    kind: args.kind,
    title_at_change: title,
    message,
  });
  if (error) throw new SupabaseError(error.message);
}

/**
 * Paged listing of the wiki changelog, newest first. `before` is the
 * exclusive cursor in `created_at desc` order - pass the last entry's
 * `created_at` from the prior page to fetch the next one. The
 * (user_id, created_at desc) index makes this a one-row-per-page
 * range scan rather than a sort, so the modal can lazy-load deep
 * history cheaply.
 */
export async function listWikiChangelog(
  client: SupabaseClient,
  opts: {
    limit?: number;
    before?: string | null;
  } = {}
): Promise<WikiChangelogEntry[]> {
  const limit = Math.max(1, Math.min(opts.limit ?? 50, 200));
  let q = client
    .from('wiki_changelog')
    .select('id, article_id, kind, title_at_change, message, created_at')
    .order('created_at', { ascending: false })
    .limit(limit);
  if (opts.before) q = q.lt('created_at', opts.before);
  const { data, error } = await q;
  if (error) throw new SupabaseError(error.message);
  const out: WikiChangelogEntry[] = [];
  for (const row of (data ?? []) as Array<Record<string, unknown>>) {
    const entry = coerceWikiChangelogEntry(row);
    if (entry) out.push(entry);
  }
  return out;
}
