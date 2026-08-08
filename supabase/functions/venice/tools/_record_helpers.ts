// Shared helpers for the wiki-record tools (function-side ports).
//
// Records are dated entries linked to a wiki article: the topic's
// journey, distinct from the article body's current state. These tools
// run with a service-role admin client (RLS OFF), so every query MUST
// filter by ctx.userId, and every write MUST verify the target article
// (for create) or record (for update/delete/get) belongs to the caller.
//
// Char caps mirror src/lib/wiki.ts (MAX_WIKI_RECORD_*) and
// supabase/functions/_shared/embed-input.ts so a write can't land a row
// the backfill loop then chokes on.

import type { SupabaseClient } from '@supabase/supabase-js';
import { appendWikiChangelog } from './_wiki_helpers.ts';
import {
  MAX_WIKI_CHANGELOG_MESSAGE_CHARS,
  MAX_WIKI_RECORD_CONTENT_CHARS,
} from '../../_shared/wiki-limits.ts';

// Re-export so record_create.ts / record_update.ts keep their
// existing import path.
export { MAX_WIKI_RECORD_CONTENT_CHARS };

export const MAX_WIKI_RECORD_TAGS = 24;
export const MAX_WIKI_RECORD_TAG_CHARS = 40;
// Mirror of MAX_RECORD_LINK_LABEL_CHARS in src/lib/wiki.ts.
export const MAX_RECORD_LINK_LABEL_CHARS = 120;

// Columns every record tool selects, kept in one place so the returned
// shape stays identical across create / update / get / list.
export const RECORD_COLUMNS =
  'id, article_id, date, content, tags, source_conversation_id, created_at, updated_at';

/**
 * Normalize a tags argument into a deduped string array, enforcing the
 * count + per-tag length caps. Non-array / non-string entries are
 * dropped rather than thrown - tags are a soft facet, and a malformed
 * entry shouldn't fail an otherwise-valid record write.
 */
export function normalizeRecordTags(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const entry of raw) {
    if (typeof entry !== 'string') continue;
    const tag = entry.trim().slice(0, MAX_WIKI_RECORD_TAG_CHARS);
    if (!tag || seen.has(tag)) continue;
    seen.add(tag);
    out.push(tag);
    if (out.length >= MAX_WIKI_RECORD_TAGS) break;
  }
  return out;
}

// Accepts 'YYYY-MM-DD'. Postgres `date` is forgiving, but pinning the
// shape here gives the model a clear error instead of a silent coercion.
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Validate + normalize an ISO date argument, or return null when it is
 * absent/blank (callers decide whether absence is an error).
 */
export function normalizeRecordDate(raw: unknown): { date: string | null; error: string | null } {
  if (typeof raw !== 'string' || raw.trim().length === 0) {
    return { date: null, error: null };
  }
  const date = raw.trim();
  if (!ISO_DATE_RE.test(date)) {
    return { date: null, error: `date must be ISO 8601 "YYYY-MM-DD" (got "${date}")` };
  }
  return { date, error: null };
}

/**
 * Confirm an article id belongs to the caller, returning its title (or
 * null when the article doesn't exist / isn't owned). Used by
 * record_create before inserting a child row against an article the
 * service-role client could otherwise write under any owner, and as the
 * title source for the record's changelog entry.
 */
export async function getOwnedArticleTitle(
  adminClient: SupabaseClient,
  userId: string,
  articleId: string,
): Promise<string | null> {
  const { data, error } = await adminClient
    .from('wiki_articles')
    .select('title')
    .eq('user_id', userId)
    .eq('id', articleId)
    .maybeSingle();
  if (error) throw new Error(`article ownership check failed: ${error.message}`);
  return data && typeof data.title === 'string' ? data.title : null;
}

/**
 * One-line changelog message for a record write. Mirror of
 * buildRecordChangelogMessage in src/lib/wiki.ts - keep the wording in
 * sync so the chat/agent path and the in-app compose path read
 * identically in the changelog.
 */
export function buildRecordChangelogMessage(
  kind: 'record_create' | 'record_update' | 'record_delete',
  date: string,
  content?: string,
): string {
  const verb =
    kind === 'record_create' ? 'Added' : kind === 'record_update' ? 'Edited' : 'Removed';
  const base = `${verb} record (${date})`;
  const preview =
    typeof content === 'string' ? content.replace(/\s+/g, ' ').trim().slice(0, 120) : '';
  const full = preview ? `${base}: ${preview}` : base;
  return full.slice(0, MAX_WIKI_CHANGELOG_MESSAGE_CHARS);
}

/**
 * Append a wiki_changelog row for a record write, scoped to the parent
 * article. Best-effort: the caller wraps this so a changelog failure
 * never fails the record mutation itself. Looks up the article title
 * (snapshot for title_at_change) under the caller's user_id.
 */
export async function appendRecordChangelog(
  adminClient: SupabaseClient,
  userId: string,
  articleId: string,
  kind: 'record_create' | 'record_update' | 'record_delete',
  date: string,
  content?: string,
  /**
   * Record content length either side of the change. Same semantics as
   * the article size pair: 0 means known-empty, omitted means unknown.
   * File/link writes (which reuse record_update without touching
   * content) omit both - the noise floor would suppress a zero delta,
   * but null is the honest answer.
   */
  charsBefore?: number,
  charsAfter?: number,
): Promise<void> {
  await appendRecordChangelogMessage(
    adminClient,
    userId,
    articleId,
    kind,
    buildRecordChangelogMessage(kind, date, content),
    charsBefore,
    charsAfter,
  );
}

/**
 * Lower-level changelog append taking a pre-built message, so the
 * file/link tools (which reuse the record_update kind but need different
 * wording than a content edit) land a history row through the same path.
 * Mirror of SupabaseService.appendRecordChangelogMessage on the browser.
 */
export async function appendRecordChangelogMessage(
  adminClient: SupabaseClient,
  userId: string,
  articleId: string,
  kind: 'record_create' | 'record_update' | 'record_delete',
  message: string,
  charsBefore?: number,
  charsAfter?: number,
): Promise<void> {
  const title = (await getOwnedArticleTitle(adminClient, userId, articleId)) ?? '(record)';
  await appendWikiChangelog(adminClient, userId, {
    article_id: articleId,
    kind,
    title_at_change: title,
    message,
    chars_before: charsBefore,
    chars_after: charsAfter,
  });
}

/**
 * Changelog message for a file attach/remove on a record. Mirror of
 * buildRecordFileChangelogMessage in src/lib/wiki.ts. File/link changes
 * reuse the record_update kind, so the panel renders them under "Edited".
 */
export function buildRecordFileChangelogMessage(
  action: 'attach' | 'remove',
  recordDate: string,
  filename: string,
  isImage: boolean,
): string {
  const noun = isImage ? 'image' : 'file';
  const verb = action === 'attach' ? 'Attached' : 'Removed';
  const name = filename.replace(/\s+/g, ' ').trim().slice(0, 120);
  const msg = `${verb} ${noun} (${recordDate})${name ? `: ${name}` : ''}`;
  return msg.slice(0, MAX_WIKI_CHANGELOG_MESSAGE_CHARS);
}

/**
 * Changelog message for a cross-link create/delete. Mirror of
 * buildRecordLinkChangelogMessage in src/lib/wiki.ts.
 */
export function buildRecordLinkChangelogMessage(
  action: 'create' | 'delete',
  targetDate: string,
  targetContent: string,
  label?: string | null,
): string {
  const verb = action === 'create' ? 'Linked to' : 'Removed link to';
  const snippet = targetContent.replace(/\s+/g, ' ').trim().slice(0, 80);
  const labelText = action === 'create' && label ? ` - ${label}` : '';
  const msg = `${verb} (${targetDate})${snippet ? ` ${snippet}` : ''}${labelText}`;
  return msg.slice(0, MAX_WIKI_CHANGELOG_MESSAGE_CHARS);
}

/**
 * Fetch a record the caller owns, returning the fields the file/link
 * tools need for ownership checks + changelog wording (or null when the
 * record doesn't exist / isn't owned).
 */
export async function getOwnedRecord(
  adminClient: SupabaseClient,
  userId: string,
  recordId: string,
): Promise<{ id: string; article_id: string; date: string; content: string } | null> {
  const { data, error } = await adminClient
    .from('wiki_records')
    .select('id, article_id, date, content')
    .eq('user_id', userId)
    .eq('id', recordId)
    .maybeSingle();
  if (error) throw new Error(`record ownership check failed: ${error.message}`);
  if (!data) return null;
  return {
    id: String(data.id),
    article_id: String((data as { article_id?: unknown }).article_id ?? ''),
    date: typeof (data as { date?: unknown }).date === 'string' ? (data as { date: string }).date : '',
    content:
      typeof (data as { content?: unknown }).content === 'string'
        ? (data as { content: string }).content
        : '',
  };
}
