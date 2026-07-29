/**
 * Frame data for the text spinner that marks an in-flight row in the
 * manual librarian-run strips (`src/components/AsciiSpinner.svelte`,
 * rendered by `src/screens/Memories.svelte` and
 * `src/screens/Wiki.svelte`). The sequences, their cadences, and the
 * cell width they need live here so they can be tested without
 * mounting a component or running timers.
 */

/**
 * Which sequence a spinner cycles.
 *
 * `sleep` exists for the memory librarian, whose two passes are both
 * named after sleep stages - deep-sleep for slow-wave, rem for REM -
 * so a drowsing "zzz" says which subsystem is working as well as that
 * it is working. The wiki librarian has no such conceit and stays on
 * `bar`.
 */
export type SpinnerVariant = 'bar' | 'sleep';

interface SpinnerSpec {
  /**
   * Equal-meaning frames cycled in order. They need NOT be equal
   * length - the caller reserves spinnerWidthCh() and left-aligns, so
   * a growing sequence stays put instead of nudging its label.
   */
  readonly frames: readonly string[];
  /** Milliseconds per frame. */
  readonly frameMs: number;
  /**
   * Shown instead of the animation under prefers-reduced-motion. An
   * honest in-flight cue for a row that is not allowed to move.
   */
  readonly staticFrame: string;
}

const SPECS: Record<SpinnerVariant, SpinnerSpec> = {
  /**
   * The classic terminal bar. Order matters - the bar sweeps through a
   * half turn per cycle, so a shuffled sequence reads as jitter rather
   * than rotation. 100ms is the conventional terminal cadence: fast
   * enough to read as motion, slow enough that each frame is a
   * distinct glyph rather than a blur.
   */
  bar: {
    frames: ['-', '\\', '|', '/'],
    frameMs: 100,
    staticFrame: '…',
  },
  /**
   * A drowsing "zzz" that grows and restarts. Deliberately far slower
   * than the bar: at the bar's 100ms this reads as frantic, which is
   * the opposite of what a sleep pass should look like. Slow is safe
   * here because the SHAPE changes between frames - the visibility
   * problem that killed the old pulsing ellipsis was opacity-only
   * motion, not slowness.
   */
  sleep: {
    frames: ['z', 'zZ', 'zZZ'],
    frameMs: 320,
    staticFrame: 'zZZ',
  },
};

/**
 * Frame for a monotonically increasing tick counter. Wraps. The double
 * modulo keeps a negative tick in range so the function is total -
 * callers never have to reason about the counter's origin to avoid an
 * `undefined` frame.
 */
export function spinnerFrame(tick: number, variant: SpinnerVariant = 'bar'): string {
  const { frames } = SPECS[variant];
  const n = frames.length;
  return frames[((Math.trunc(tick) % n) + n) % n];
}

/** Milliseconds each frame of this variant holds for. */
export function spinnerFrameMs(variant: SpinnerVariant = 'bar'): number {
  return SPECS[variant].frameMs;
}

/** Reduced-motion stand-in for this variant. */
export function spinnerStaticFrame(variant: SpinnerVariant = 'bar'): string {
  return SPECS[variant].staticFrame;
}

/**
 * Character cells the caller must reserve so the sequence never
 * reflows its neighbour. Derived from the widest frame rather than
 * written down separately, so editing a sequence cannot leave a stale
 * width behind.
 */
export function spinnerWidthCh(variant: SpinnerVariant = 'bar'): number {
  const { frames, staticFrame } = SPECS[variant];
  return Math.max(...frames.map((f) => f.length), staticFrame.length);
}
