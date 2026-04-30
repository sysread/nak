/**
 * Timezone-aware date-key helpers for the Journal feature.
 *
 * Journal entries are bucketed by a plain YYYY-MM-DD key (stored in
 * `journal_entries.entry_date` as a `date` column). "Today" depends on
 * where the user actually is, not where the Supabase server is - a user
 * writing at 10pm EDT should land on the day they experience as today,
 * not UTC's tomorrow. The user's IANA timezone lives in
 * `profiles.settings.journalTimezone`; when absent we fall back to
 * whatever the browser / worker's JS runtime reports.
 *
 * Both helpers are self-contained on purpose so the journaling Web
 * Worker can import them without dragging in main-thread modules.
 */

/**
 * Compute today's YYYY-MM-DD in the given IANA timezone. Falls back to
 * the browser's local calendar day if the zone is null / unknown / the
 * runtime rejects the name (Safari on older iOS has historically been
 * stricter about unrecognised zones).
 */
export function todayInZone(tz: string | null | undefined): string {
  const now = new Date();
  const options: Intl.DateTimeFormatOptions = {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  };
  if (typeof tz === 'string' && tz.length > 0) {
    options.timeZone = tz;
  }
  try {
    // 'en-CA' formats as YYYY-MM-DD natively, which saves us stitching
    // the parts back together when the runtime honors the locale.
    const parts = new Intl.DateTimeFormat('en-CA', options).formatToParts(now);
    const y = parts.find((p) => p.type === 'year')?.value ?? '';
    const m = parts.find((p) => p.type === 'month')?.value ?? '';
    const d = parts.find((p) => p.type === 'day')?.value ?? '';
    if (y.length === 4 && m.length === 2 && d.length === 2) {
      return `${y}-${m}-${d}`;
    }
  } catch {
    // fall through to local-calendar fallback
  }
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/**
 * Compute the YYYY-MM-DD calendar key for an arbitrary instant in the
 * given IANA timezone. Same shape as `todayInZone` but for any
 * timestamp - used by the journaling worker to bucket an automatic
 * entry on the day the source conversation started, NOT the day the
 * worker happens to be processing it. Without this distinction a
 * worker that runs idle past midnight or chews through a backlog
 * would stamp every entry with the current run-day.
 *
 * `instant` may be a Date or an ISO 8601 timestamp string (PostgREST
 * returns timestamps as strings). Returns null on an unparseable
 * input rather than throwing - the caller is expected to fall back to
 * `todayInZone(tz)` when the conversation timestamp couldn't be read.
 */
export function dateInZone(
  instant: Date | string,
  tz: string | null | undefined
): string | null {
  const d = instant instanceof Date ? instant : new Date(instant);
  if (Number.isNaN(d.getTime())) return null;
  const options: Intl.DateTimeFormatOptions = {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  };
  if (typeof tz === 'string' && tz.length > 0) {
    options.timeZone = tz;
  }
  try {
    const parts = new Intl.DateTimeFormat('en-CA', options).formatToParts(d);
    const y = parts.find((p) => p.type === 'year')?.value ?? '';
    const m = parts.find((p) => p.type === 'month')?.value ?? '';
    const day = parts.find((p) => p.type === 'day')?.value ?? '';
    if (y.length === 4 && m.length === 2 && day.length === 2) {
      return `${y}-${m}-${day}`;
    }
  } catch {
    // fall through
  }
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/**
 * Best-effort detection of the browser / worker's own timezone for use
 * as a seed when the user hasn't set `journalTimezone` explicitly.
 * Returns 'UTC' when the runtime refuses to vend a zone.
 */
export function detectTimezone(): string {
  try {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (typeof tz === 'string' && tz.length > 0) return tz;
  } catch {
    // fall through
  }
  return 'UTC';
}

/**
 * Add or subtract `delta` calendar days from a YYYY-MM-DD key. Uses
 * UTC math - we're shifting an already-bucketed date key, not
 * translating a wall-clock moment, so zone-agnostic stepping is correct.
 */
export function shiftDay(ymd: string, delta: number): string {
  const [y, m, d] = ymd.split('-').map((n) => Number.parseInt(n, 10));
  if (!Number.isFinite(y) || !Number.isFinite(m) || !Number.isFinite(d)) {
    return ymd;
  }
  const utc = new Date(Date.UTC(y, m - 1, d));
  utc.setUTCDate(utc.getUTCDate() + delta);
  const yy = utc.getUTCFullYear();
  const mm = String(utc.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(utc.getUTCDate()).padStart(2, '0');
  return `${yy}-${mm}-${dd}`;
}

/**
 * Full human-readable date for a YYYY-MM-DD key ("Tuesday, April 28, 2026").
 * Used as the day heading inside the journal panel body where there is
 * enough horizontal space for a complete label. Uses UTC interpretation
 * because the key is a zone-agnostic day bucket.
 */
export function formatDateFull(ymd: string): string {
  const [y, m, d] = ymd.split('-').map((n) => Number.parseInt(n, 10));
  if (!Number.isFinite(y)) return ymd;
  const dt = new Date(Date.UTC(y, m - 1, d));
  try {
    return new Intl.DateTimeFormat(undefined, {
      weekday: 'long',
      year: 'numeric',
      month: 'long',
      day: 'numeric',
      timeZone: 'UTC',
    }).format(dt);
  } catch {
    return ymd;
  }
}

/**
 * Compact human-readable label for a YYYY-MM-DD key ("SUN 2026-04-19").
 * Short weekday + ISO date stays to a single line at any reasonable
 * phone width. Uses UTC interpretation because the key is a
 * zone-agnostic day bucket.
 */
export function formatDateCompact(ymd: string): string {
  const [y, m, d] = ymd.split('-').map((n) => Number.parseInt(n, 10));
  if (!Number.isFinite(y)) return ymd;
  const dt = new Date(Date.UTC(y, m - 1, d));
  try {
    const weekday = new Intl.DateTimeFormat(undefined, {
      weekday: 'short',
      timeZone: 'UTC',
    }).format(dt);
    return `${weekday.toUpperCase()} ${ymd}`;
  } catch {
    return ymd;
  }
}

/**
 * Validate an IANA zone name by round-tripping it through
 * `Intl.DateTimeFormat`. Returns the original string when the runtime
 * accepts it; null when the zone is unknown. Callers use this to guard
 * settings writes so a typo'd zone doesn't poison `entry_date`
 * computation for every subsequent turn.
 */
export function normalizeTimezone(tz: string): string | null {
  if (typeof tz !== 'string' || tz.length === 0 || tz.length > 128) return null;
  try {
    new Intl.DateTimeFormat('en-CA', { timeZone: tz });
    return tz;
  } catch {
    return null;
  }
}
