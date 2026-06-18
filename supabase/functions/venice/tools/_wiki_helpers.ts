// Shared write-path helpers for the wiki tools (wiki_create /
// wiki_update / wiki_delete). Mirrors the SupabaseService methods the
// browser impls called: same input shapes, same silent-no-op-on-empty
// contracts, same throw-on-DB-error behavior. The tools call the
// changelog/attach helpers in a try/catch and swallow the error so a
// missed secondary row cannot fail a successful article mutation.
//
// Auth: b-strict throughout. The service-role client bypasses RLS, so
// every query here either stamps user_id on insert or filters by it
// explicitly.

import type { SupabaseClient } from '@supabase/supabase-js';

// Article writes use create/update/delete; record writes reuse the same
// changelog (scoped to the parent article) with the record_* kinds.
// Mirror of src/lib/supabase/types/wiki.ts.
export type WikiChangelogKind =
  | 'create'
  | 'update'
  | 'delete'
  | 'record_create'
  | 'record_update'
  | 'record_delete';

export interface WikiChangelogEntry {
  /** Null for deletes - the article row is already gone. */
  article_id: string | null;
  kind: WikiChangelogKind;
  title_at_change: string;
  message: string;
}

export async function appendWikiChangelog(
  adminClient: SupabaseClient,
  userId: string,
  entry: WikiChangelogEntry,
): Promise<void> {
  const title = entry.title_at_change.trim();
  const message = entry.message.trim();
  if (title.length === 0 || message.length === 0) return;
  const { error } = await adminClient.from('wiki_changelog').insert({
    user_id: userId,
    article_id: entry.article_id,
    kind: entry.kind,
    title_at_change: title,
    message,
  });
  if (error) throw new Error(`createWikiChangelogEntry failed: ${error.message}`);
}

/**
 * Attribute one or more source conversations to a wiki article.
 * Upsert on the (article_id, thread_id) composite key: a thread
 * already attributed gets its last_processed_at bumped rather than
 * producing a duplicate row. Empty input is a silent no-op.
 *
 * No user_id filter here on purpose: wiki_article_sources has no
 * user_id column (ownership rides on the article + thread FKs), and
 * callers only pass thread ids that are either the agent's own
 * claimed thread or have been validated via findExistingThreadIds.
 */
export async function attachWikiArticleSources(
  adminClient: SupabaseClient,
  articleId: string,
  threadIds: readonly string[],
): Promise<void> {
  if (threadIds.length === 0) return;
  const seen = new Set<string>();
  const now = new Date().toISOString();
  const rows: Array<{
    article_id: string;
    thread_id: string;
    last_processed_at: string;
  }> = [];
  for (const id of threadIds) {
    if (typeof id !== 'string' || id.length === 0) continue;
    if (seen.has(id)) continue;
    seen.add(id);
    rows.push({ article_id: articleId, thread_id: id, last_processed_at: now });
  }
  if (rows.length === 0) return;
  const { error } = await adminClient
    .from('wiki_article_sources')
    .upsert(rows, { onConflict: 'article_id,thread_id' });
  if (error) throw new Error(`attachWikiArticleSources failed: ${error.message}`);
}

/**
 * Filter a list of candidate thread ids down to ones that exist AND
 * belong to the given user. The librarian's source_thread_ids
 * parameter is model-supplied and copy fidelity drifts, so the ids
 * are advisory - unknown or foreign ids are dropped silently rather
 * than rejecting the call. The explicit user_id filter is what the
 * browser version got for free from RLS.
 */
export async function findExistingThreadIds(
  adminClient: SupabaseClient,
  userId: string,
  ids: readonly string[],
): Promise<Set<string>> {
  if (ids.length === 0) return new Set();
  const { data, error } = await adminClient
    .from('threads')
    .select('id')
    .eq('user_id', userId)
    .in('id', [...ids]);
  if (error) throw new Error(`findExistingThreadIds failed: ${error.message}`);
  const out = new Set<string>();
  for (const row of (data ?? []) as Array<{ id?: unknown }>) {
    if (typeof row.id === 'string') out.add(row.id);
  }
  return out;
}
