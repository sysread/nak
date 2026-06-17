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

export const MAX_WIKI_RECORD_CONTENT_CHARS = 8000;
export const MAX_WIKI_RECORD_TAGS = 24;
export const MAX_WIKI_RECORD_TAG_CHARS = 40;

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
 * Confirm an article id belongs to the caller. Returns true when the
 * row exists under ctx.userId. Used by record_create before inserting a
 * child row against an article the service-role client could otherwise
 * write under any owner.
 */
export async function userOwnsArticle(
  adminClient: SupabaseClient,
  userId: string,
  articleId: string,
): Promise<boolean> {
  const { data, error } = await adminClient
    .from('wiki_articles')
    .select('id')
    .eq('user_id', userId)
    .eq('id', articleId)
    .maybeSingle();
  if (error) throw new Error(`article ownership check failed: ${error.message}`);
  return !!data;
}
