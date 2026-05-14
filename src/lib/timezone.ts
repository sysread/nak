/**
 * Timezone helpers. The user's preferred IANA zone lives in
 * `profiles.settings.displayTimezone`; the helpers fall back to whatever
 * the browser / worker's JS runtime reports when no preference is set.
 *
 * The setting is named for what it does: it's the display timezone the
 * model sees when it reasons about "what time is it for the user" in
 * the per-turn metadata system message. The wiki agent also reads it
 * when bucketing day-eligible threads.
 *
 * Self-contained on purpose so background Web Workers can import these
 * without dragging in main-thread modules.
 */

/**
 * Best-effort detection of the browser / worker's own timezone for use
 * as a seed when the user hasn't set `displayTimezone` explicitly.
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
 * settings writes so a typo'd zone doesn't poison every subsequent
 * datetime paragraph.
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
