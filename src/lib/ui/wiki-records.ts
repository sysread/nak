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
  MAX_RECORD_LINK_LABEL_CHARS,
} from '../wiki';
import { formatBytes } from '../attachments';
import type { WikiRecord, WikiRecordFile, WikiRecordLinkView } from '../supabase';

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
 * Reduce Markdown to its visible text for a single-line preview. The
 * collapsed record row renders as plain text (no Markdown -> HTML pass,
 * unlike the expanded body), so without this a record whose content opens
 * with `**bold**` or a `# heading` shows the literal syntax characters.
 *
 * This is a lightweight token strip, not a parser - it targets the inline
 * marks that actually appear in record prose (emphasis, code, links,
 * images) plus line-leading block markers (headings, blockquotes, list
 * bullets). It runs BEFORE the whitespace collapse so the `^`-anchored
 * block-marker pass still sees real line starts. Underscores are left
 * alone on purpose: stripping them would mangle snake_case identifiers,
 * and `**`/`*` cover the emphasis case we actually see.
 */
function stripMarkdown(content: string): string {
  return content
    // images ![alt](url) -> alt, then links [text](url) -> text
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    // line-leading block markers: heading hashes, blockquote, list bullets
    .replace(/^\s{0,3}(?:#{1,6}\s+|>\s?|[-*+]\s+|\d+\.\s+)/gm, '')
    // inline emphasis (** and *) and code backticks
    .replace(/\*\*/g, '')
    .replace(/\*/g, '')
    .replace(/`+/g, '');
}

/**
 * First ~n characters of a record body for the collapsed list row.
 * Strips Markdown to visible text and collapses whitespace/newlines to
 * single spaces so neither syntax characters nor structure leak into the
 * one-line preview. Appends an ellipsis when truncated.
 */
export function contentPreview(content: string, n = 100): string {
  const flat = stripMarkdown(content).replace(/\s+/g, ' ').trim();
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

// --- record files ------------------------------------------------------

/** True when a record file is an image (renders as a thumbnail). */
export function recordFileIsImage(file: Pick<WikiRecordFile, 'mime_type'>): boolean {
  return (file.mime_type ?? '').startsWith('image/');
}

/**
 * One-line metadata for a record file row: "crumb.jpg - 1.2 MB". The size
 * suffix is dropped when unknown so a row never reads "... - " with a
 * dangling separator.
 */
export function formatRecordFileMeta(
  file: Pick<WikiRecordFile, 'filename' | 'size_bytes'>
): string {
  const size = typeof file.size_bytes === 'number' ? formatBytes(file.size_bytes) : '';
  return size ? `${file.filename} - ${size}` : file.filename;
}

export interface RecordFileView {
  file: WikiRecordFile;
  /** Signed URL when resolved (live object), else null (still resolving or reclaimed). */
  url: string | null;
}

/**
 * Split a record's files into images (thumbnail strip) and documents
 * (download chips), pairing each with its resolved signed URL from
 * `urlById`. Render order is the list order (already position-sorted by
 * the query). A file with no URL yet still renders - the image shows a
 * placeholder, the doc a non-link chip - rather than vanishing mid-resolve.
 */
export function partitionRecordFiles(
  files: readonly WikiRecordFile[],
  urlById: Map<string, string>
): { images: RecordFileView[]; docs: RecordFileView[] } {
  const images: RecordFileView[] = [];
  const docs: RecordFileView[] = [];
  for (const file of files) {
    const view: RecordFileView = { file, url: urlById.get(file.id) ?? null };
    if (recordFileIsImage(file)) images.push(view);
    else docs.push(view);
  }
  return { images, docs };
}

// --- record cross-links ------------------------------------------------

/**
 * Display projection of a record link from the current record's point of
 * view. `arrow` shows edge direction ("->" outgoing, "<-" incoming),
 * `label` is the relationship (or a neutral "linked" when unlabelled),
 * `preview` is the other record's dated snippet for the clickable row.
 */
export function describeLink(view: WikiRecordLinkView): {
  arrow: string;
  label: string;
  preview: string;
} {
  return {
    arrow: view.direction === 'outgoing' ? '->' : '<-',
    label: view.label && view.label.trim() ? view.label.trim() : 'linked',
    preview: `${formatRecordDate(view.record.date)} - ${contentPreview(view.record.content, 60)}`,
  };
}

/**
 * Candidate target records for a new link: every record except the
 * current one and any already linked to it (in either direction).
 * Pure filter so the picker's option list derives from the data. The
 * caller passes the records it has loaded (this article's, plus any
 * cross-article search hits).
 */
export function linkCandidates(
  records: readonly WikiRecord[],
  currentRecordId: string,
  existingLinks: readonly WikiRecordLinkView[]
): WikiRecord[] {
  const excluded = new Set<string>([currentRecordId]);
  for (const l of existingLinks) excluded.add(l.record.id);
  return records.filter((r) => !excluded.has(r.id));
}

/**
 * Validate a link label. Empty is allowed (an unlabelled edge is valid);
 * only over-length is an error. Returns an error string or null.
 */
export function validateLinkLabel(label: string): string | null {
  if (label.length > MAX_RECORD_LINK_LABEL_CHARS) {
    return `Label must be ${MAX_RECORD_LINK_LABEL_CHARS} characters or fewer.`;
  }
  return null;
}
