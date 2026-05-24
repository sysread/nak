/**
 * UI-behavior primitive for the per-message timestamp shown at the
 * left edge of every message card's action row. Pure function only -
 * no runes, no Svelte imports, no DOM. The companions
 * `src/components/AssistantBody.svelte` (assistant rows) and
 * `src/screens/Chat.svelte` (user rows) both render the output in a
 * `.msg-time` span.
 *
 * The format is a fixed `yyyy-mm-dd HH:mm` rather than the
 * locale-aware `dateStyle`/`timeStyle` shape ContextRing uses for its
 * "Received X" detail line: this stamp sits inline in the action bar
 * where a compact, sortable, fixed-width form reads better than a
 * locale string whose length varies by region. The two surfaces serve
 * different jobs, so the divergence is intentional.
 */

/**
 * Format an ISO timestamp as `yyyy-mm-dd HH:mm` in the user's
 * preferred timezone. Returns null when the input is missing or
 * unparseable so the caller can suppress the stamp entirely.
 *
 * Bad zone strings fall back to the browser default rather than
 * blanking the stamp - a stale or hand-edited setting shouldn't hide
 * metadata the user can otherwise see.
 *
 * `hourCycle: 'h23'` pins midnight to `00:00`; the older `hour12:
 * false` shape rendered it as `24:00` on some engines, which reads as
 * an invalid clock time.
 */
export function formatMessageStamp(
  iso: string | null | undefined,
  timezone: string | undefined
): string | null {
  if (!iso) return null;
  const ts = new Date(iso);
  if (Number.isNaN(ts.getTime())) return null;

  const opts: Intl.DateTimeFormatOptions = {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  };

  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = new Intl.DateTimeFormat('en-CA', {
      ...opts,
      timeZone: timezone,
    }).formatToParts(ts);
  } catch {
    parts = new Intl.DateTimeFormat('en-CA', opts).formatToParts(ts);
  }

  const get = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((p) => p.type === type)?.value ?? '';

  return `${get('year')}-${get('month')}-${get('day')} ${get('hour')}:${get('minute')}`;
}
