/**
 * Frame data for the text spinner that marks an in-flight row in the
 * manual librarian-run strips (`src/components/AsciiSpinner.svelte`,
 * rendered by `src/screens/Memories.svelte`). The sequence and the
 * wrap arithmetic live here so they can be tested without mounting a
 * component or running timers.
 */

/**
 * The classic terminal bar spinner. Order matters - the bar sweeps
 * through a half turn per cycle, so a shuffled sequence reads as
 * jitter rather than rotation.
 *
 * Equal-width frames are a hard requirement: an uneven advance would
 * shove the label beside the spinner left and right four times a
 * second. The app body font is Lekton (`--font-mono`, styles.css), so
 * all four frames occupy one character cell.
 */
const SPINNER_FRAMES = ['-', '\\', '|', '/'] as const;

/**
 * Milliseconds per frame. 100ms is the conventional terminal-spinner
 * cadence - fast enough to read unambiguously as motion, slow enough
 * that each frame is a distinct glyph rather than a blur.
 */
export const SPINNER_FRAME_MS = 100;

/**
 * Shown instead of the animation when the user has asked for reduced
 * motion. An ellipsis is the honest in-flight cue for a row that is
 * not allowed to move: it says "still working" without implying the
 * frozen bar glyph is a rendering bug.
 */
export const SPINNER_STATIC_FRAME = '…';

/**
 * Frame for a monotonically increasing tick counter. Wraps at the end
 * of the sequence. The double modulo keeps a negative tick in range so
 * the function is total - callers never have to reason about the
 * counter's origin to avoid an `undefined` frame.
 */
export function spinnerFrame(tick: number): string {
  const n = SPINNER_FRAMES.length;
  return SPINNER_FRAMES[((Math.trunc(tick) % n) + n) % n];
}
