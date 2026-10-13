// Shared helpers for the recipe-record tools (function-side ports).
//
// Naming caution: this is NOT _recipe_helpers.ts. That file is photo
// metadata for the recipe_* tools (readRecipePhotoMeta); this file owns
// the cooking-log records - dated entries in a recipe's records table,
// distinct from the recipe's cooklang source.
//
// Records are the journey (what happened when the user cooked it); the
// recipe row is the current state. These tools run with a service-role
// admin client (RLS OFF), so every query MUST filter by ctx.userId, and
// every write MUST verify the target recipe (for create) belongs to the
// caller.
//
// Char caps live in ../../_shared/recipe-record-limits.ts (canonical;
// the browser imports the same file through the $shared alias) so a
// write can't land a row the embed backfill then chokes on.

import type { SupabaseClient } from '@supabase/supabase-js';
import {
  MAX_RECIPE_RECORD_CONTENT_CHARS,
  MAX_RECIPE_RECORD_TAGS,
  MAX_RECIPE_RECORD_TAG_CHARS,
} from '../../_shared/recipe-record-limits.ts';

// Re-export so recipe_record_create.ts keeps a single import site.
export { MAX_RECIPE_RECORD_CONTENT_CHARS };

// Columns every record tool selects, kept in one place so the returned
// shape stays identical across create / update / get / list.
export const RECIPE_RECORD_COLUMNS =
  'id, recipe_id, date, content, tags, outcome, source_conversation_id, created_at, updated_at';

// Content preview cap for the create tool's dedup payload - the
// changelog-builder cap from the wiki twin's _record_helpers.ts (120),
// deliberately NOT the UI preview's 100 (contentPreview in
// src/lib/ui/recipe-records.ts defaults to 100).
export const RECIPE_RECORD_PREVIEW_CHARS = 120;

// The outcome check constraint bounds the column to these values;
// "not classified" is null. The tools reach the enum through
// isRecipeRecordOutcome below - the array/type stay file-local so the
// shapes don't invite direct enum imports.
const RECIPE_RECORD_OUTCOMES = ['success', 'mixed', 'failure'] as const;
type RecipeRecordOutcome = (typeof RECIPE_RECORD_OUTCOMES)[number];

export function isRecipeRecordOutcome(value: unknown): value is RecipeRecordOutcome {
  return (
    typeof value === 'string' &&
    (RECIPE_RECORD_OUTCOMES as readonly string[]).includes(value)
  );
}

/**
 * Normalize a tags argument into a deduped string array, enforcing the
 * count + per-tag length caps. Non-array / non-string entries are
 * dropped rather than thrown - tags are a soft facet, and a malformed
 * entry shouldn't fail an otherwise-valid record write. Same shape as
 * the wiki twin's normalizeRecordTags in _record_helpers.ts.
 */
export function normalizeRecipeRecordTags(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const entry of raw) {
    if (typeof entry !== 'string') continue;
    const tag = entry.trim().slice(0, MAX_RECIPE_RECORD_TAG_CHARS);
    if (!tag || seen.has(tag)) continue;
    seen.add(tag);
    out.push(tag);
    if (out.length >= MAX_RECIPE_RECORD_TAGS) break;
  }
  return out;
}

// Accepts 'YYYY-MM-DD'. Postgres `date` is forgiving, but pinning the
// shape here gives the model a clear error instead of a silent coercion.
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Validate + normalize an ISO date argument, or return null when it is
 * absent/blank (callers decide whether absence is an error). Same
 * contract as the wiki twin's normalizeRecordDate.
 */
export function normalizeRecipeRecordDate(
  raw: unknown,
): { date: string | null; error: string | null } {
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
 * One-line content preview for the create tool's dedup payload. Same
 * whitespace collapse as the wiki changelog builder, so the two
 * previews read identically.
 */
export function recipeRecordPreview(content: string): string {
  return content.replace(/\s+/g, ' ').trim().slice(0, RECIPE_RECORD_PREVIEW_CHARS);
}

/**
 * Confirm a recipe id belongs to the caller, returning its title (or
 * null when the recipe doesn't exist / isn't owned). Used by
 * recipe_record_create before inserting a child row against a recipe
 * the service-role client could otherwise write under any owner.
 */
export async function getOwnedRecipeTitle(
  adminClient: SupabaseClient,
  userId: string,
  recipeId: string,
): Promise<string | null> {
  const { data, error } = await adminClient
    .from('recipes')
    .select('title')
    .eq('user_id', userId)
    .eq('id', recipeId)
    .maybeSingle();
  if (error) throw new Error(`recipe ownership check failed: ${error.message}`);
  return data && typeof (data as { title?: unknown }).title === 'string'
    ? (data as { title: string }).title
    : null;
}
