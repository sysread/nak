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
 * One dated record linked to a wiki article. Records document the
 * topic's journey (discrete events, experiments, observations) while
 * the article body owns the consolidated "current state". `date` is the
 * calendar day the event occurred (distinct from `created_at`, when the
 * row was written); `tags` is a freeform keyword array used for
 * filtering; `source_conversation_id` carries extraction provenance and
 * is null for manually-added records. See the matching table + RLS in
 * `supabase/schema.sql:wiki_records`.
 */
export interface WikiRecord {
  id: string;
  article_id: string;
  date: string;
  content: string;
  tags: string[];
  source_conversation_id: string | null;
  created_at: string;
  updated_at: string;
  /** Populated only by `searchWikiRecordsByEmbedding`. */
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
// Article writes use create/update/delete; record writes reuse the same
// changelog (scoped to the parent article) with the record_* kinds so
// the audit surface tells "added a record to X" apart from "edited
// article X". See supabase/schema.sql:wiki_changelog.
export type WikiChangelogKind =
  | 'create'
  | 'update'
  | 'delete'
  | 'record_create'
  | 'record_update'
  | 'record_delete';
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

/**
 * A proposed change to one of an article's dated records, returned by
 * the manual wiki agent (/wiki-manual-update) for the preview the user
 * accepts or rejects. Discriminated by `op`; `update`/`delete` carry an
 * `id` the function-side parser has already confirmed belongs to a
 * record the model was shown (a hallucinated id never reaches here).
 * Mirror of the RecordOp in
 * supabase/functions/venice/agents/wiki_manual.ts.
 */
export type RecordOp =
  | { op: 'create'; date: string; content: string; tags: string[] }
  | { op: 'update'; id: string; date?: string; content?: string; tags?: string[] }
  | { op: 'delete'; id: string };

/**
 * Success outcome of a server-side manual wiki update (the venice
 * function's /wiki-manual-update route; see runWikiManualUpdate below).
 * `preview` carries the would-be final title/content (equal to the
 * current article on a records-only edit), the proposed record ops, and
 * the agent's one-line `reason` (rendered next to the preview AND used
 * as the changelog message on Accept). `noop` means nothing changed:
 * body identical AND no record ops. The function's own union also has a
 * kind:'error' for parse/read/transport failures; runWikiManualUpdate
 * converts that into a thrown Error so the panel shows a retry banner,
 * so it is intentionally absent from this consumed type.
 */
export type WikiManualUpdateResult =
  | {
      kind: 'preview';
      title: string;
      content: string;
      reason: string;
      recordOps: RecordOp[];
    }
  | { kind: 'noop'; reason: string };


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

/**
 * Defensive coercion of a wiki_records row (or a search hit). `tags`
 * may arrive as a JSONB array, a JSON string (older clients), or be
 * absent; normalize to a string array. `source_conversation_id` and
 * `similarity` are optional.
 */
export function coerceWikiRecord(raw: Record<string, unknown>): WikiRecord {
  let tags: string[] = [];
  const rawTags = raw.tags;
  if (Array.isArray(rawTags)) {
    tags = rawTags.filter((t): t is string => typeof t === 'string');
  } else if (typeof rawTags === 'string' && rawTags.length > 0) {
    try {
      const parsed = JSON.parse(rawTags);
      if (Array.isArray(parsed)) {
        tags = parsed.filter((t): t is string => typeof t === 'string');
      }
    } catch {
      // Malformed tag payload from a legacy row - treat as untagged
      // rather than throwing in a read path.
    }
  }
  const srcRaw = raw.source_conversation_id;
  return {
    id: String(raw.id),
    article_id: String(raw.article_id ?? ''),
    date: typeof raw.date === 'string' ? raw.date : '',
    content: typeof raw.content === 'string' ? raw.content : '',
    tags,
    source_conversation_id:
      typeof srcRaw === 'string' && srcRaw.length > 0 ? srcRaw : null,
    created_at: String(raw.created_at ?? raw.updated_at ?? ''),
    updated_at: String(raw.updated_at ?? raw.created_at ?? ''),
    similarity:
      typeof raw.similarity === 'number' ? (raw.similarity as number) : undefined,
  };
}

const WIKI_CHANGELOG_KINDS: readonly WikiChangelogKind[] = [
  'create',
  'update',
  'delete',
  'record_create',
  'record_update',
  'record_delete',
];

export function coerceWikiChangelogKind(raw: unknown): WikiChangelogKind | null {
  return WIKI_CHANGELOG_KINDS.includes(raw as WikiChangelogKind)
    ? (raw as WikiChangelogKind)
    : null;
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
