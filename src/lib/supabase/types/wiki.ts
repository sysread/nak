/**
 * Wiki-domain row types: articles, their bibliography sources, See-Also
 * related rows, the changelog, and the wiki retry / librarian-run result
 * unions. Re-exported through `../../supabase.ts` so consumers keep
 * importing from `$lib/supabase`.
 */

// --- appended verbatim from the original supabase.ts type block ---
/**
 * One topical article in the user's wiki. Flat list (no nesting), one
 * article per `(user_id, title)` (the schema enforces uniqueness so the
 * autonomous agent's `wiki_create` can fall through to `wiki_update` on
 * conflict). Articles are written in encyclopedic third-person prose
 * and are never auto-injected into the chat - the main LLM reaches
 * them only through the always-on `wiki_search` tool.
 */
export interface WikiArticle {
  id: string;
  title: string;
  content: string;
  created_at: string;
  updated_at: string;
  /** Populated only by `searchWikiArticlesByEmbedding`. */
  similarity?: number;
}

/**
 * One row of the bibliography shown beneath a wiki article: a thread
 * that contributed to the article, with the thread's title and the
 * timestamp this attribution was last refreshed (re-processing the
 * same thread bumps this rather than inserting a duplicate row).
 *
 * Surfaced via `listWikiArticleSources`; populated by the wiki tools
 * themselves when an article is created or updated (autonomous agent
 * attaches the current thread; librarian passes `source_thread_ids`
 * explicitly through the tool boundary).
 */
export interface WikiArticleSource {
  thread_id: string;
  /** May be null when the thread has been hard-deleted but the
   *  attribution row hasn't been cascade-cleaned yet. The UI renders
   *  a placeholder title in that window. */
  thread_title: string | null;
  first_processed_at: string;
  last_processed_at: string;
}

/**
 * One row of the See Also section beneath a wiki article. Returned
 * by the `find_related_wiki_articles` RPC, which uses the dynamic
 * similarity floor (the minimum cosine similarity between the target
 * article and its source conversations) to decide which candidates
 * clear the bar.
 */
export interface WikiArticleRelated {
  id: string;
  title: string;
  similarity: number;
}

/**
 * One row of the wiki changelog: a single create / update / delete
 * recorded at the time of the mutation. `article_id` is null when the
 * underlying article has since been deleted (the FK uses ON DELETE SET
 * NULL); `title_at_change` is the snapshot taken at write time so the
 * row still reads meaningfully without a join. See the matching table
 * + RLS in `supabase/schema.sql:wiki_changelog`.
 */
export type WikiChangelogKind = 'create' | 'update' | 'delete';
export interface WikiChangelogEntry {
  id: string;
  article_id: string | null;
  kind: WikiChangelogKind;
  title_at_change: string;
  message: string;
  created_at: string;
}

/**
 * Outcome of a server-side wiki retry (the venice function's
 * /wiki-retry route; see retryWikiThread below). Mirror of the
 * function's WikiRetryResult union. `toolCalls` can legitimately be
 * zero - the agent is prompted to skip rather than fabricate edits -
 * so the Skipped panel surfaces the count instead of assuming a
 * cleared skip means new changelog rows.
 */
export type WikiRetryResult =
  | { kind: 'ok'; terminalMsgId: string; toolCalls: number; reasoning: string }
  | { kind: 'no-op'; reason: string }
  | { kind: 'error'; error: string };

/**
 * Outcome of a server-side manual librarian run (the venice
 * function's /wiki-librarian-run route; see runWikiLibrarian below).
 * `busy` means another librarian run (scheduled, manual, or
 * chat-dispatched) holds the in-flight guard - the UI surfaces a
 * "try again in a moment" rather than racing two passes.
 */
export type WikiLibrarianRunResult =
  | { kind: 'ok'; finalText: string; toolCalls: number; articleCount: number }
  | { kind: 'busy' }
  | { kind: 'error'; error: string };


export function coerceWikiArticle(raw: Record<string, unknown>): WikiArticle {
  return {
    id: String(raw.id),
    title: typeof raw.title === 'string' ? raw.title : '',
    content: typeof raw.content === 'string' ? raw.content : '',
    created_at: String(raw.created_at ?? raw.updated_at ?? ''),
    updated_at: String(raw.updated_at ?? raw.created_at ?? ''),
    similarity:
      typeof raw.similarity === 'number' ? (raw.similarity as number) : undefined,
  };
}

export function coerceWikiChangelogKind(raw: unknown): WikiChangelogKind | null {
  if (raw === 'create' || raw === 'update' || raw === 'delete') return raw;
  return null;
}

export function coerceWikiChangelogEntry(
  raw: Record<string, unknown>
): WikiChangelogEntry | null {
  const id = raw.id;
  const kind = coerceWikiChangelogKind(raw.kind);
  if (typeof id !== 'string' || !kind) return null;
  const articleIdRaw = raw.article_id;
  return {
    id,
    article_id:
      typeof articleIdRaw === 'string' && articleIdRaw.length > 0
        ? articleIdRaw
        : null,
    kind,
    title_at_change:
      typeof raw.title_at_change === 'string' ? raw.title_at_change : '',
    message: typeof raw.message === 'string' ? raw.message : '',
    created_at: String(raw.created_at ?? ''),
  };
}
