/**
 * UI-behavior primitives for the right-edge logs panel. Pure
 * functions only - no runes, no Svelte imports, no DOM. The
 * companion `src/components/LogsDrawer.svelte` composes these
 * with its own framework-native reactivity (the filter / search /
 * expand-set runes, the three `$effect`s, the `bodyEl` DOM ref,
 * the clipboard orchestration), and the markup.
 *
 * Type imports from `$lib/logger.svelte` carry the `LogEntry` /
 * `LogLevel` shapes; both are domain types that a port to another
 * framework would consume identically.
 */
import type { LogEntry, LogLevel } from '../logger.svelte';

/**
 * Numeric ranking of the log levels so the threshold filter can do
 * a single `>=` comparison. `trace` sits below `debug` so picking
 * the Trace+ tier widens the filter to include the per-cycle
 * worker breadcrumbs. Kept private to the module - the only caller
 * is `entryMatches` below.
 */
const LEVEL_RANK: Record<LogLevel, number> = {
  trace: -1,
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

/**
 * Filter shape consumed by `entryMatches`. The component owns each
 * field as a separate rune; bundling them into a filter object
 * keeps the primitive's signature stable when new filter axes
 * land.
 */
export interface LogFilter {
  levelFilter: LogLevel;
  matchMode: 'or' | 'and';
  /** Exact-match against `entry.source`; empty string is the
   *  "All sources" sentinel that disables the predicate. */
  sourceFilter: string;
  /** Pre-tokenised search needles. The component splits the
   *  search string via `splitNeedles` and feeds the result. */
  needles: readonly string[];
}

/**
 * Whitespace-tokenised search needles. The user types
 * `error rate-limit` and gets two needles; trailing or double
 * spaces drop empty tokens so the user does not accidentally
 * match every entry just by hitting space. Case folding happens
 * at match time (see `entryMatches`).
 */
export function splitNeedles(search: string): string[] {
  return search
    .trim()
    .split(/\s+/)
    .filter((s) => s.length > 0);
}

/**
 * Flatten log details into one searchable string. Errors
 * contribute their message + stack; strings pass through; other
 * objects contribute their JSON. Best-effort - any throw inside
 * JSON.stringify falls back to `String()`.
 */
export function detailsHaystack(details: readonly unknown[]): string {
  const parts: string[] = [];
  for (const d of details) {
    if (d instanceof Error) {
      parts.push(d.message);
      if (d.stack) parts.push(d.stack);
      continue;
    }
    if (typeof d === 'string') {
      parts.push(d);
      continue;
    }
    try {
      parts.push(JSON.stringify(d));
    } catch {
      parts.push(String(d));
    }
  }
  return parts.join(' ');
}

/**
 * The full filter predicate. An entry passes when:
 *   - its level rank is at or above the threshold,
 *   - the source filter is empty OR its source matches exactly,
 *   - the needle list is empty OR (mode==='or' && some needle
 *     appears in the searchable text) OR (mode==='and' && every
 *     needle appears).
 *
 * Search is case-insensitive; the searchable text is the source
 * tag + message + flattened details (see `detailsHaystack`).
 */
export function entryMatches(entry: LogEntry, filter: LogFilter): boolean {
  if (LEVEL_RANK[entry.level] < LEVEL_RANK[filter.levelFilter]) return false;
  if (filter.sourceFilter !== '' && entry.source !== filter.sourceFilter) {
    return false;
  }
  if (filter.needles.length === 0) return true;
  const hay = (
    (entry.source ?? '') +
    ' ' +
    entry.message +
    ' ' +
    detailsHaystack(entry.details)
  ).toLowerCase();
  if (filter.matchMode === 'and') {
    return filter.needles.every((n) => hay.includes(n.toLowerCase()));
  }
  return filter.needles.some((n) => hay.includes(n.toLowerCase()));
}

/**
 * Unique non-null source tags present in the buffer, alphabetised
 * so the dropdown order is stable as new entries stream in. Tags
 * with a null source are skipped - they would surface as an
 * empty option and are not selectable anyway.
 */
export function availableSources(entries: readonly LogEntry[]): string[] {
  const set = new Set<string>();
  for (const e of entries) {
    if (e.source) set.add(e.source);
  }
  return [...set].sort();
}

/**
 * True when at least one detail is something other than a string.
 * Plain-string details render inline under the message; anything
 * else (Error, object, array, ...) gets the expander caret.
 */
export function hasStructuredDetails(details: readonly unknown[]): boolean {
  return details.some((d) => typeof d !== 'string');
}

/** Counterpart partition: the string details rendered inline. */
export function inlineStringDetails(details: readonly unknown[]): string[] {
  return details.filter((d): d is string => typeof d === 'string');
}

/** Counterpart partition: the non-string details rendered in
 *  expander blocks. */
export function structuredDetails(details: readonly unknown[]): unknown[] {
  return details.filter((d) => typeof d !== 'string');
}

/**
 * Render a structured detail for display. Errors fall back to
 * `name: message` when no stack is available; everything else
 * goes through pretty-printed JSON. Final-resort `String()` for
 * values JSON.stringify rejects.
 */
export function formatStructured(d: unknown): string {
  if (d instanceof Error) {
    return d.stack && d.stack.length > 0 ? d.stack : `${d.name}: ${d.message}`;
  }
  try {
    return JSON.stringify(d, null, 2);
  } catch {
    return String(d);
  }
}

/**
 * Clone-safe normalisation of a detail for inclusion in the
 * JSON snapshot. Errors lose their prototype but keep their
 * shape; plain objects round-trip through JSON to strip
 * functions / symbols / non-enumerable props and catch circular
 * refs early.
 */
export function normalizeDetail(d: unknown): unknown {
  if (d instanceof Error) {
    return { name: d.name, message: d.message, stack: d.stack ?? null };
  }
  if (d === null || typeof d !== 'object') return d;
  try {
    return JSON.parse(JSON.stringify(d));
  } catch {
    try {
      return String(d);
    } catch {
      return '[unserializable]';
    }
  }
}

/**
 * A run of text emitted by `highlightSegments`. The component
 * walks the returned array and wraps `match: true` runs in
 * `<mark>`; `match: false` runs render as plain text.
 */
export interface HighlightSegment {
  text: string;
  match: boolean;
}

/**
 * Split `text` into runs of unmatched / matched substrings
 * against the supplied needles. Highlighting is mode-agnostic -
 * in OR mode any single needle hit produces a band; in AND mode
 * every needle is by definition present, so the same logic
 * renders correctly.
 *
 * Implementation: collect every needle's match ranges across the
 * text, sort by start, merge overlaps, then walk the merged
 * ranges to emit segments. Empty needle list short-circuits to
 * one unmatched run.
 */
export function highlightSegments(
  text: string,
  needles: readonly string[]
): HighlightSegment[] {
  if (needles.length === 0 || text.length === 0) {
    return [{ text, match: false }];
  }
  const hay = text.toLowerCase();
  const ranges: Array<[number, number]> = [];
  for (const n of needles) {
    if (n.length === 0) continue;
    const find = n.toLowerCase();
    let i = 0;
    while (i < text.length) {
      const at = hay.indexOf(find, i);
      if (at === -1) break;
      ranges.push([at, at + n.length]);
      i = at + n.length;
    }
  }
  if (ranges.length === 0) return [{ text, match: false }];
  ranges.sort((a, b) => a[0] - b[0]);
  const merged: Array<[number, number]> = [];
  for (const r of ranges) {
    const last = merged[merged.length - 1];
    if (last && r[0] <= last[1]) {
      last[1] = Math.max(last[1], r[1]);
    } else {
      merged.push([r[0], r[1]]);
    }
  }
  const out: HighlightSegment[] = [];
  let cursor = 0;
  for (const [s, e] of merged) {
    if (s > cursor) out.push({ text: text.slice(cursor, s), match: false });
    out.push({ text: text.slice(s, e), match: true });
    cursor = e;
  }
  if (cursor < text.length) out.push({ text: text.slice(cursor), match: false });
  return out;
}

/**
 * Wall-clock formatter for log timestamps. HH:MM:SS.mss in the
 * local timezone; padded so columns line up across rows. Useful
 * for log diffing where the difference between two adjacent
 * entries is sub-second.
 */
export function formatTimestamp(ms: number): string {
  const d = new Date(ms);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  const ss = String(d.getSeconds()).padStart(2, '0');
  const mss = String(d.getMilliseconds()).padStart(3, '0');
  return `${hh}:${mm}:${ss}.${mss}`;
}

/**
 * Tail-follow predicate. True when the scroll position is within
 * `tolerance` pixels of the bottom of the container - close
 * enough that the user is "reading the tail" and new entries
 * should keep the view pinned to the latest. The 16px default is
 * a friction threshold; below it the user-pinned vs auto-tailing
 * distinction is below perceptual noise.
 */
export function nearBottom(
  scrollTop: number,
  clientHeight: number,
  scrollHeight: number,
  tolerance: number = 16
): boolean {
  return scrollTop + clientHeight >= scrollHeight - tolerance;
}

/**
 * Empty-state message for the listing area. Two reasons share
 * the same "the list is empty" rendering but communicate very
 * different things: "this is a fresh buffer, nothing has logged
 * yet" versus "entries exist but your filter excluded every one
 * of them" (typically a user mis-step the message should
 * suggest).
 */
export function emptyMessage(
  totalEntries: number,
  visibleEntries: number
): string {
  void visibleEntries;
  return totalEntries === 0
    ? 'No log entries yet.'
    : 'No entries match the current filter.';
}

/**
 * Build the JSON-snapshot payload the Copy button writes to the
 * clipboard. The shape feeds the "paste a JSON blob into chat /
 * a bug report" workflow - the user wants what they were
 * looking at (filtered view), not the raw buffer, but with the
 * filter state included so the reader can reconstruct the
 * narrowing.
 *
 * Returns a plain object; the component is responsible for
 * `JSON.stringify` so the indentation choice stays a Svelte-side
 * decision (and so the primitive does not have to know about
 * the indent width).
 */
export interface LogSnapshotArgs {
  capturedAt: string;
  buildCommit: string;
  buildTime: string;
  levelFilter: LogLevel;
  matchMode: 'or' | 'and';
  sourceFilter: string;
  search: string;
  visibleEntries: readonly LogEntry[];
}

export function buildLogSnapshot(args: LogSnapshotArgs): {
  capturedAt: string;
  buildCommit: string;
  buildTime: string;
  levelFilter: LogLevel;
  sourceFilter: string | null;
  searchFilter: string;
  searchMode: 'or' | 'and';
  shownEntries: number;
  entries: Array<{
    id: number;
    timestamp: string;
    level: LogLevel;
    source: string | null;
    message: string;
    details: unknown[];
  }>;
} {
  return {
    capturedAt: args.capturedAt,
    buildCommit: args.buildCommit,
    buildTime: args.buildTime,
    levelFilter: args.levelFilter,
    sourceFilter: args.sourceFilter === '' ? null : args.sourceFilter,
    searchFilter: args.search,
    searchMode: args.matchMode,
    shownEntries: args.visibleEntries.length,
    entries: args.visibleEntries.map((e) => ({
      id: e.id,
      timestamp: new Date(e.timestamp).toISOString(),
      level: e.level,
      source: e.source,
      message: e.message,
      details: e.details.map(normalizeDetail),
    })),
  };
}
