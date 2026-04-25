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
