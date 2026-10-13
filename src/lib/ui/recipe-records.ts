/**
 * Framework-free UI primitives for the recipe Records section
 * (src/components/RecipeRecords.svelte). Everything here is a pure
 * function a React/Solid/Vue port would keep verbatim: the per-recipe
 * retention map reducer behind the offline degradation, the browse
 * filter mapping, outcome chip labels/classes, date formatting,
 * content previews, tag parse/serialize, cross-recipe search-hit
 * labels, and export filename slugs. The Svelte file holds only the
 * reactive wiring and markup. Mirrors src/lib/ui/wiki-records.ts (the
 * wiki Records section's twin). Tested via vitest in
 * tests/recipe-records.test.ts.
 */

import type { RecipeRecord } from '../supabase';
import {
  MAX_RECIPE_RECORD_CONTENT_CHARS,
  MAX_RECIPE_RECORD_TAGS,
  MAX_RECIPE_RECORD_TAG_CHARS,
} from '$shared/recipe-record-limits';

// ---------------------------------------------------------------
// Retention map (the offline degradation's core state)
// ---------------------------------------------------------------

/**
 * One recipe id's entry in the session retention map: either the rows
 * from that recipe's most recent log fetch, or a marker that the fetch
 * failed cold (no prior rows to keep rendering). Listed `date` desc
 * with the `created_at` tie-break
 * fetches land here keyed by the id they were FOR, never the id that
 * happened to be open when the response arrived - the late-response
 * race dies by construction because the view always reads
 * `map[openId]`.
 */
export type RecipeRecordRetentionEntry =
  | { kind: 'rows'; rows: RecipeRecord[] }
  | { kind: 'error' };

export type RecipeRecordRetentionMap = ReadonlyMap<string, RecipeRecordRetentionEntry>;

/**
 * The reducer's event vocabulary. `open-id-changed` carries no map
 * change by design - the map is keyed per recipe id precisely so a
 * navigation (including one mid-fetch) never drops or misfiles rows;
 * the event exists so the contract is explicit and testable rather
 * than implicit in the caller not dispatching anything.
 */

export type RecipeRecordRetentionEvent =
  | { type: 'fetch-landed'; recipeId: string; rows: RecipeRecord[] }
  | { type: 'fetch-failed'; recipeId: string }
  | { type: 'open-id-changed' };

/**
 * Fold a retention event into the map, returning a NEW map (the
 * caller reassigns so reactivity sees the change).
 *
 * - `fetch-landed` lands the rows under the id the fetch was for,
 *   replacing any prior entry: online revalidations must be able to
 *   replace a filter-scoped entry with the unfiltered view.
 * - `fetch-failed` keeps an existing entry (a failed revalidation
 *   must not vanish rows the user is reading) and lands `'error'`
 *   only when there was nothing to keep - a cold fetch failing is
 *   the one case that renders the keyed load-error banner.
 */
export function reduceRecipeRecordRetention(
  current: RecipeRecordRetentionMap,
  event: RecipeRecordRetentionEvent
): RecipeRecordRetentionMap {
  if (event.type === 'open-id-changed') return current;
  const next = new Map(current);
  if (event.type === 'fetch-landed') {
    next.set(event.recipeId, { kind: 'rows', rows: event.rows });
    return next;
  }
  if (next.has(event.recipeId)) return next;
  next.set(event.recipeId, { kind: 'error' });
  return next;
}

/** The map entry for an id, or null when nothing was fetched for it yet. */
export function retentionEntryFor(
  map: RecipeRecordRetentionMap,
  recipeId: string
): RecipeRecordRetentionEntry | null {
  return map.get(recipeId) ?? null;
}

// ---------------------------------------------------------------
// Browse filters
// ---------------------------------------------------------------

/** The add form's / filter row's raw string state, one field per control. */
export interface RecipeRecordBrowseFilterState {
  fromDate: string;
  toDate: string;
  tag: string;
  outcome: string;
}

/**
 * Map the raw filter-row state onto `listRecipeRecords`' filter shape:
 * empty strings drop out (an unset control sends no constraint). Tags
 * arrive as a single dropdown selection and pass through as a
 * one-element array (AND semantics degenerate to equality).
 */
export function listFiltersFromBrowse(state: RecipeRecordBrowseFilterState): {
  fromDate?: string;
  toDate?: string;
  tags?: string[];
  outcome?: string;
} {
  return {
    fromDate: state.fromDate || undefined,
    toDate: state.toDate || undefined,
    tags: state.tag ? [state.tag] : undefined,
    outcome: state.outcome || undefined,
  };
}

/**
 * Whether any browse filter is set. Picks the empty-state copy
 * ("no records yet" vs "no records match the current filters") - a
 * filtered zero must not read as an empty log.
 */
export function browseFiltersActive(state: RecipeRecordBrowseFilterState): boolean {
  return !!(state.fromDate || state.toDate || state.tag || state.outcome);
}

// ---------------------------------------------------------------
// Outcome chips
// ---------------------------------------------------------------

/** The outcome enum values the schema's check constraint admits. */
export const RECIPE_RECORD_OUTCOMES = ['success', 'mixed', 'failure'] as const;

export type RecipeRecordOutcome = (typeof RECIPE_RECORD_OUTCOMES)[number];

/**
 * Chip label for a record's outcome. Null (the "unclassified" state,
 * and defensively any value outside the enum) renders no chip at all -
 * an "Unclassified" chip on every unclassified row would be noise.
 */
export function outcomeChipLabel(outcome: string | null): string | null {
  if (outcome === 'success') return 'Success';
  if (outcome === 'mixed') return 'Mixed';
  if (outcome === 'failure') return 'Failure';
  return null;
}

/**
 * CSS class for the outcome chip (the component owns the color rules;
 * success/mixed/failure map to the theme's ok/warn/danger accents).
 * Null when the record renders no chip.
 */
export function outcomeChipClass(outcome: string | null): string | null {
  if (outcome === 'success') return 'recipe-record-outcome-success';
  if (outcome === 'mixed') return 'recipe-record-outcome-mixed';
  if (outcome === 'failure') return 'recipe-record-outcome-failure';
  return null;
}

/**
 * Options for the add/edit form's outcome selector. The empty value
 * means "unclassified" (stored as SQL NULL) - the explicit option is
 * how an edit clears a classification, matching the M3 update tool's
 * `outcome: null` patch semantics.
 */
export function outcomeFormOptions(): Array<{ value: string; label: string }> {
  return [
    { value: '', label: 'Unclassified' },
    ...RECIPE_RECORD_OUTCOMES.map((o) => ({
      value: o,
      label: o.charAt(0).toUpperCase() + o.slice(1),
    })),
  ];
}

/**
 * Options for the browse filter's outcome dropdown. Unlike the form
 * selector there is no "unclassified" mode: the filter enumerates only
 * the three classified values (an IS NULL filter is not a promised
 * surface - see the plan's Scoped out).
 */
export function outcomeFilterOptions(): Array<{ value: string; label: string }> {
  return [
    { value: '', label: 'All' },
    ...RECIPE_RECORD_OUTCOMES.map((o) => ({
      value: o,
      label: o.charAt(0).toUpperCase() + o.slice(1),
    })),
  ];
}

// ---------------------------------------------------------------
// Row presentation
// ---------------------------------------------------------------

/**
 * Format a record's ISO date ("2026-10-04") as "Oct 4, 2026". Local
 * copy of the wiki twin's formatter (ui/wiki-records.ts) - kept local
 * so the two features' UI modules stay independently consumable.
 * Parses as a local date (not `new Date(iso)`, which treats a bare
 * "YYYY-MM-DD" as UTC midnight and can render the prior day in
 * negative-offset timezones); falls back to the raw string.
 */
export function formatRecordDate(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  if (!m) return iso;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}

/**
 * Today's date as a local "YYYY-MM-DD" string, the add form's default.
 * Built from local calendar parts (not toISOString, which is UTC and
 * rolls near midnight in offset timezones).
 */
export function todayIso(): string {
  const d = new Date();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${m}-${day}`;
}

/**
 * First ~n characters of a record body for the collapsed list row,
 * Markdown stripped to visible text and whitespace collapsed. Same
 * token strip as the wiki twin's preview.
 */
export function contentPreview(content: string, n = 100): string {
  const flat = content
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/^\s{0,3}(?:#{1,6}\s+|>\s?|[-*+]\s+|\d+\.\s+)/gm, '')
    .replace(/\*\*/g, '')
    .replace(/\*/g, '')
    .replace(/`+/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (flat.length <= n) return flat;
  return flat.slice(0, n).trimEnd() + '…';
}

/**
 * Parse a comma-separated tag input into a normalized, deduped array,
 * enforcing the recipe-record caps shared with the edge tools (count +
 * per-tag length, from $shared/recipe-record-limits).
 */
export function parseTags(input: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of input.split(',')) {
    const tag = raw.trim().slice(0, MAX_RECIPE_RECORD_TAG_CHARS);
    if (!tag) continue;
    const key = tag.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(tag);
    if (out.length >= MAX_RECIPE_RECORD_TAGS) break;
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
 * Empty-state copy for the records list. Distinguishes "this recipe
 * has no records yet" from "your filters matched nothing" and from
 * "your search matched nothing", since the remedy differs.
 */
export function recordsEmptyMessage(opts: { filtered: boolean; searching: boolean }): string {
  if (opts.searching) return 'No records match your search.';
  if (opts.filtered) return 'No records match the current filters.';
  return "No records yet. Add one to start this recipe's cooking log.";
}

/**
 * The offline-no-data line: shown when offline and the open recipe's
 * log was never fetched this session (no retention entry). Must never
 * be replaced by the "no records yet" empty state, which would lie
 * about the log being empty.
 */
export function offlineNoDataMessage(): string {
  return "You're offline. This recipe's records haven't been loaded yet - reconnect to view them.";
}

/**
 * Hover title for the write controls (add / edit / delete) while
 * offline. Mirrors the bookmark controls' degradation copy: the title
 * explains the greyed-out button instead of letting the click fail.
 */
export function recordActionTitle(
  online: boolean,
  action: 'add' | 'edit' | 'delete'
): string {
  const onlineTitle = { add: 'Add record', edit: 'Edit record', delete: 'Delete record' }[action];
  return online ? onlineTitle : `Reconnect to ${action} records`;
}

/**
 * Collect the distinct tags present across a record set, sorted, for
 * the filter dropdown. Pure projection so the dropdown options derive
 * from the data rather than being hand-maintained.
 */
export function collectTags(records: readonly RecipeRecord[]): string[] {
  const set = new Set<string>();
  for (const r of records) {
    for (const t of r.tags) set.add(t);
  }
  return Array.from(set).sort((a, b) => a.localeCompare(b));
}

/**
 * Validate the compose/edit form's content + date. The caller passes
 * content already trimmed. The date check is shape-only
 * ("YYYY-MM-DD") because the value comes from a native date input,
 * which yields either that shape or an empty string - calendar
 * validity is the browser's job. Returns an error string or null.
 */
export function validateRecordForm(content: string, date: string): string | null {
  if (!content) return 'Content is required.';
  if (content.length > MAX_RECIPE_RECORD_CONTENT_CHARS) {
    return `Content must be ${MAX_RECIPE_RECORD_CONTENT_CHARS} chars or fewer.`;
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return 'Pick a valid date.';
  return null;
}

// ---------------------------------------------------------------
// Cross-recipe search-hit labels
// ---------------------------------------------------------------

/** Row annotation for a hit whose recipe was confirmed deleted. */
export const DELETED_RECIPE_LABEL = '(deleted recipe)';

/** Row annotation for a hit whose title batch failed as a whole. */
export const HIT_TITLE_UNAVAILABLE_LABEL = "couldn't load";

/**
 * Per-result-set state of the batched title lookup. One
 * `fetchRecipeTitles` query runs per result set; its outcome is
 * sticky for the life of that result set - a later navigation or a
 * resolved row never rewrites the labels (no observable distinguishes
 * a re-derived label, and a network blip must not read as deletion).
 */
export type HitTitleState =
  /** Titles landed; an id absent from the map is a confirmed deletion. */
  | { status: 'ok'; titles: ReadonlyMap<string, string> }
  /** The batch query failed as a whole. */
  | { status: 'failed' }
  /** Results rendered, batch still in flight - no deletion verdict yet. */
  | { status: 'pending' };

/** Fold a batch result (null = the query threw) into the label state. */
export function hitTitleStateFromBatch(
  titles: ReadonlyMap<string, string> | null
): HitTitleState {
  return titles ? { status: 'ok', titles } : { status: 'failed' };
}

/**
 * The row annotation for a search hit: null for rows on the open
 * recipe (they are this recipe's records - no annotation) and while
 * the title batch is still in flight (no deletion verdict exists
 * yet), the resolved title for a foreign hit, "(deleted recipe)"
 * when the batch succeeded and the id is absent (a saved result set
 * can outlive a recipe), or "couldn't load" when the batch failed as
 * a whole (every foreign row degrades together).
 */
export function hitLabel(
  state: HitTitleState,
  hitRecipeId: string,
  openRecipeId: string
): string | null {
  if (hitRecipeId === openRecipeId) return null;
  if (state.status === 'pending') return null;
  if (state.status === 'failed') return HIT_TITLE_UNAVAILABLE_LABEL;
  return state.titles.get(hitRecipeId) ?? DELETED_RECIPE_LABEL;
}

/**
 * Whether a search-hit row may navigate on click. Rows are clickable
 * while the batch is pending or failed (the blip may be transient and
 * cached recipes still open); only a CONFIRMED deletion (batch
 * succeeded, id absent) is a no-op.
 */
export function hitClickable(state: HitTitleState, hitRecipeId: string): boolean {
  if (state.status !== 'ok') return true;
  return state.titles.has(hitRecipeId);
}

// ---------------------------------------------------------------
// Expanded-row affordances + search-clear pruning
// ---------------------------------------------------------------

/**
 * Which actions an expanded row renders. Export is always available
 * (it reads the row's own data). Edit/Delete belong to the OPEN
 * recipe's records: a kept-expanded search hit whose recipe stopped
 * matching the open recipe loses them, so the form can never write a
 * foreign recipe's record from the new pane.
 */
export function expandedRowActions(
  recordRecipeId: string,
  openRecipeId: string
): { edit: boolean; export: boolean; delete: boolean } {
  const owns = recordRecipeId === openRecipeId;
  return { edit: owns, export: true, delete: owns };
}

/**
 * Drop an expanded-row id that is no longer in the rendered set. Runs
 * when a search clears (a search-result expansion dies with the
 * search) and whenever the rendered rows change while browsing; on
 * search START the expansion state is kept even when the row is not
 * among the results, so clearing restores it.
 */
export function pruneExpandedId(
  expandedId: string | null,
  visible: readonly RecipeRecord[]
): string | null {
  if (!expandedId) return null;
  return visible.some((r) => r.id === expandedId) ? expandedId : null;
}

// ---------------------------------------------------------------
// Search tunables
// ---------------------------------------------------------------

/**
 * Upper bound on the Records search response, named next to
 * RecipeList's RECIPE_SEARCH_LIMIT rather than hardcoded at the call
 * site. Matches the data-layer merge's default.
 */
export const RECIPE_RECORD_SEARCH_LIMIT = 20;

// ---------------------------------------------------------------
// Reset rules (the state matrix)
// ---------------------------------------------------------------

/**
 * Which pieces of section state reset when the open recipe id changes,
 * per the plan's state matrix. Date/tag filters and the compose/edit
 * draft reset on EVERY path (unconditionally - no helper). The outcome
 * dropdown and the expanded row reset only in browse mode: while a
 * search is live the outcome filters the search (resetting it would
 * desync the dropdown from the displayed results) and a search-result
 * expansion survives until the search clears (the collapse would fight
 * the scroll-highlight that is supposed to mark it).
 */
export function resetsOnRecipeChange(searchLive: boolean): {
  outcome: boolean;
  expandedRow: boolean;
} {
  return { outcome: !searchLive, expandedRow: !searchLive };
}

// ---------------------------------------------------------------
// Export filename slugs
// ---------------------------------------------------------------

/**
 * Filename slug for a record's export file. Lowercase, alphanumerics +
 * hyphens, derived from the content so the file is recognizable in the
 * ZIP without opening it. Always non-empty (falls back to the id tail)
 * so two records on the same date don't collide on an empty slug.
 */
export function recordSlug(record: Pick<RecipeRecord, 'id' | 'content'>): string {
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
 * the layout the recipe ZIP uses under records/.
 */
export function recordExportFilename(
  record: Pick<RecipeRecord, 'id' | 'date' | 'content'>
): string {
  const date = /^\d{4}-\d{2}-\d{2}/.exec(record.date)?.[0] ?? 'undated';
  return `${date}-${recordSlug(record)}.md`;
}
