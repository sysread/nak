/**
 * UI-behavior primitives for the second-thoughts per-message panel.
 *
 * Owns the jsonb coercion + every disposition-to-display transform
 * (label, tone, icon, collapsed headline, note fallback) so the
 * companion `SecondThoughtsPanel.svelte` holds only composition. See
 * docs/dev/in-progress/second-thoughts.md for the feature and
 * docs/dev/frontend-organization.md for why these live here.
 *
 * The verdict is written server-side by the reviewer agent
 * (supabase/functions/venice/agents/second_thoughts.ts); this is the
 * read side. Coercion is defensive: a row predating the column, a
 * drifting shape, or a disabled/errored reviewer all read as null and
 * the panel renders nothing.
 */

export type SecondThoughtsDisposition =
  | 'conviction'
  | 'hedge'
  | 'reframe'
  | 'correct';

export interface SecondThoughtsVerdict {
  disposition: SecondThoughtsDisposition;
  note: string;
}

export const SECOND_THOUGHTS_DISPOSITIONS: readonly SecondThoughtsDisposition[] =
  ['conviction', 'hedge', 'reframe', 'correct'];

/**
 * Coerce the raw `messages.second_thoughts` jsonb into a verdict, or
 * null when it is absent / the wrong shape / an unknown schema
 * version. Mirror of the server-side SecondThoughtsVerdict shape
 * (only `v: 1` today). Null is the "render nothing" signal.
 */
export function coerceSecondThoughts(raw: unknown): SecondThoughtsVerdict | null {
  if (!raw || typeof raw !== 'object') return null;
  const obj = raw as Record<string, unknown>;
  if (obj.v !== 1) return null;
  const disposition = obj.disposition;
  if (
    typeof disposition !== 'string' ||
    !SECOND_THOUGHTS_DISPOSITIONS.includes(
      disposition as SecondThoughtsDisposition,
    )
  ) {
    return null;
  }
  const note = typeof obj.note === 'string' ? obj.note.trim() : '';
  return { disposition: disposition as SecondThoughtsDisposition, note };
}

/**
 * Visual tone for the collapsed glyph + border tint. 'calm' for
 * conviction, 'unease' for the soft doubts (hedge / reframe), 'alert'
 * for a suspected factual error (correct) - the loudest because it is
 * the one a reader most wants to catch.
 */
export function dispositionTone(
  d: SecondThoughtsDisposition,
): 'calm' | 'unease' | 'alert' {
  switch (d) {
    case 'conviction':
      return 'calm';
    case 'hedge':
    case 'reframe':
      return 'unease';
    case 'correct':
      return 'alert';
  }
}

/**
 * Icon key for the collapsed glyph. The panel renders the matching SVG
 * - keeping the disposition-to-icon decision here (not as a template
 * cascade) per the frontend-org rule.
 */
export function dispositionIcon(
  d: SecondThoughtsDisposition,
): 'check' | 'hedge' | 'reframe' | 'alert' {
  switch (d) {
    case 'conviction':
      return 'check';
    case 'hedge':
      return 'hedge';
    case 'reframe':
      return 'reframe';
    case 'correct':
      return 'alert';
  }
}

/** Short label for the disposition, used in the expanded panel header. */
export function dispositionLabel(d: SecondThoughtsDisposition): string {
  switch (d) {
    case 'conviction':
      return 'Stands by it';
    case 'hedge':
      return 'Overconfident';
    case 'reframe':
      return 'May have misread';
    case 'correct':
      return 'Possible error';
  }
}

/**
 * Collapsed-affordance tooltip / aria text. Reads as the assistant
 * having a private afterthought about the message it is attached to.
 */
export function dispositionHeadline(d: SecondThoughtsDisposition): string {
  switch (d) {
    case 'conviction':
      return 'Second thoughts: no misgivings';
    case 'hedge':
      return 'Second thoughts: a missing caveat';
    case 'reframe':
      return 'Second thoughts: may have read this wrong';
    case 'correct':
      return 'Second thoughts: a possible mistake';
  }
}

/**
 * Note body to show when expanded. The reviewer leaves the note empty
 * for conviction (nothing nagged); fall back to a plain statement so
 * the expanded panel is never blank.
 */
export function displayNote(verdict: SecondThoughtsVerdict): string {
  if (verdict.note.length > 0) return verdict.note;
  return verdict.disposition === 'conviction'
    ? 'On reflection, no misgivings about this one.'
    : 'Something felt off, but no detail was recorded.';
}
