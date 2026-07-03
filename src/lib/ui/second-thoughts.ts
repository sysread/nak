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
  /**
   * True once the user clicked the refinement button and a refinement
   * turn was launched off this doubt. Set by Chat.svelte `refineFrom`,
   * not the reviewer. Its job is twofold: mark the panel as acted-on
   * for the human, and - the load-bearing half - flip the doubt from
   * invisible to model-VISIBLE, so `toVeniceMessage` projects the
   * `<think>` connective into replay. Without it the model would later
   * see two answers in a row with no logical link and could waffle
   * over which is authoritative. Absent / false on an un-acted doubt.
   */
  acted: boolean;
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
  return {
    disposition: disposition as SecondThoughtsDisposition,
    note,
    acted: obj.acted === true,
  };
}

/**
 * Whether a verdict represents actual doubt (anything but conviction).
 * The per-message panel renders ONLY for a doubt: conviction is the
 * common "nothing to see here" outcome and showing a calm row on every
 * fine answer is just chrome. A doubt is a meaningful, trustworthy
 * signal (it tracks answer quality - it fires on sloppy models and
 * stays quiet on good ones), so it earns the visible panel; conviction
 * stays silent. The reviewer still runs on every turn and the verdict
 * still persists - this is purely a display gate.
 */
export function isDoubt(d: SecondThoughtsDisposition): boolean {
  return d !== 'conviction';
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

/**
 * Label for the refinement button, in the model's own "let me ..."
 * voice - short, because the note carries the specifics. Returns null
 * for `conviction`, which gets no button (and whose panel does not
 * auto-expand). The null return is the single gate for both "which
 * dispositions get a button" and "which auto-expand" - the
 * doubt-vs-conviction split.
 */
export function dispositionAction(
  d: SecondThoughtsDisposition,
): string | null {
  switch (d) {
    case 'conviction':
      return null;
    case 'hedge':
      return 'Let me temper that';
    case 'reframe':
      return 'Let me re-read your question';
    case 'correct':
      return 'Let me double-check that';
  }
}

/**
 * Build the ephemeral `<think>` self-doubt block that seeds a
 * refinement turn (Chat.svelte `refineFrom`). The model reads it as
 * its own prior thought and takes another shot.
 *
 * The framing is ADVISORY, never imperative - the most load-bearing
 * prompt constraint in the feature. The reviewer is a cheap,
 * low-context model second-guessing a smart, full-context one; if the
 * doubt read as "fix these errors" the strong model would dutifully
 * "fix" things that were never broken. Phrased as a misgiving to
 * weigh, with explicit permission to stand by the original, the
 * full-context author stays free to overrule the low-context reflex.
 */
export function buildRefinementThink(note: string): string {
  const misgiving = note.trim().length > 0
    ? note.trim()
    : 'Something about my answer feels off, though I cannot name it precisely.';
  return [
    '<think>',
    "I'm having second thoughts about my previous answer. Let me think",
    'through this misgiving and double-check that it is legitimate before',
    'I change anything. If it does not hold up, I should restate my',
    'position and stand by it plainly rather than inventing a change for',
    'its own sake. Either way, the reply that follows is my current,',
    'considered answer - where it differs from the one above, prefer it.',
    '',
    `Misgiving: ${misgiving}`,
    '</think>',
  ].join('\n');
}
