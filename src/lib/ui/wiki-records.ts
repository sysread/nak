/**
 * Framework-free UI primitives for the wiki Records section
 * (src/components/WikiRecords.svelte). Everything here is a pure
 * function a React/Solid/Vue port would keep verbatim: date formatting,
 * content previews, tag parse/serialize, headline pluralization, export
 * filename slugs, and the filter predicate. The Svelte file holds only
 * the reactive wiring and markup. Tested via vitest in
 * tests/wiki-records.test.ts.
 */

import {
  MAX_WIKI_RECORD_TAGS,
  MAX_WIKI_RECORD_TAG_CHARS,
} from '../wiki';
import type { WikiRecord } from '../supabase';

/**
 * Format a record's ISO date ("2026-06-17") as "Jun 17, 2026". Date-only
 * variant of formatChangelogStamp in wiki-changelog-panel.ts - records
 * carry a calendar date, not a timestamp, so no time component.
 *
 * Parses as a local date (not `new Date(iso)`, which treats a bare
 * "YYYY-MM-DD" as UTC midnight and can render the prior day in
 * negative-offset timezones). Falls back to the raw string when the
 * input doesn't parse.
 */
export function formatRecordDate(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  if (!m) return iso;
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  const d = new Date(year, month - 1, day);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}

/**
 * Today's date as a local "YYYY-MM-DD" string, the default for a new
 * record's date picker. Built from local calendar parts (not
 * toISOString, which is UTC and can roll to tomorrow/yesterday near
 * midnight in offset timezones).
 */
export function todayIso(): string {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/**
 * First ~n characters of a record body for the collapsed list row,
 * collapsing whitespace/newlines to single spaces so Markdown structure
 * doesn't leak into the one-line preview. Appends an ellipsis when
 * truncated.
 */
export function contentPreview(content: string, n = 100): string {
  const flat = content.replace(/\s+/g, ' ').trim();
  if (flat.length <= n) return flat;
  return flat.slice(0, n).trimEnd() + '…';
}

/**
 * Parse a comma-separated tag input into a normalized, deduped array,
 * enforcing the same caps the write tools do (count + per-tag length).
 * Used by the compose form's chip/comma input.
 */
export function parseTags(input: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of input.split(',')) {
    const tag = raw.trim().slice(0, MAX_WIKI_RECORD_TAG_CHARS);
    if (!tag) continue;
    const key = tag.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(tag);
    if (out.length >= MAX_WIKI_RECORD_TAGS) break;
  }
  return out;
}

/** Render a tag array back into the comma-separated input form. */
export function serializeTags(tags: string[]): string {
  return tags.join(', ');
}

/**
 * Section headline with count: "Records", "Records (1)", "Records (12)".
 * The bare noun when empty reads better than "Records (0)" for a section
 * the user may not have populated yet.
 */
export function recordsHeadline(count: number): string {
  if (count <= 0) return 'Records';
  return `Records (${count})`;
}

/**
 * Filename slug for a record's export file. Lowercase, alphanumerics +
 * hyphens, derived from the content preview so the file is recognizable
 * in the ZIP without opening it. Always non-empty (falls back to the id
 * tail) so two records on the same date don't collide on an empty slug.
 */
export function recordSlug(record: Pick<WikiRecord, 'id' | 'content'>): string {
  const base = record.content
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 50)
    .replace(/-+$/g, '');
  if (base) return base;
  // Fall back to the id tail so empty/non-latin bodies still get a
  // unique, valid filename component.
  return record.id.slice(0, 8);
}

/**
 * Export filename for a single record: "yyyy-mm-dd-<slug>.md". Matches
 * the layout the article+records ZIP uses under records/.
 */
export function recordExportFilename(record: Pick<WikiRecord, 'id' | 'date' | 'content'>): string {
  const date = /^\d{4}-\d{2}-\d{2}/.exec(record.date)?.[0] ?? 'undated';
  return `${date}-${recordSlug(record)}.md`;
}

/**
 * Empty-state copy for the records list. Distinguishes "this article has
 * no records yet" from "your filters matched nothing", since the remedy
 * differs (add one vs widen the filter).
 */
export function recordsEmptyMessage(opts: { filtered: boolean; searching: boolean }): string {
  if (opts.searching) return 'No records match your search.';
  if (opts.filtered) return 'No records match the current filters.';
  return 'No records yet. Add one to start documenting this topic’s journey.';
}

/**
 * Collect the distinct tags present across a record set, sorted, for the
 * filter dropdown. Pure projection so the dropdown options derive from
 * the data rather than being hand-maintained.
 */
export function collectTags(records: readonly WikiRecord[]): string[] {
  const set = new Set<string>();
  for (const r of records) {
    for (const t of r.tags) set.add(t);
  }
  return Array.from(set).sort((a, b) => a.localeCompare(b));
}
