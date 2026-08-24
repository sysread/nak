// Pure decision logic for the on-screen-keyboard inset. The DOM glue
// that feeds it live viewport numbers lives in src/lib/keyboard-inset.ts.

/*
 * Minimum height difference (px) treated as "the keyboard is open".
 *
 * The visual viewport also shrinks transiently for reasons that are not
 * a keyboard - the iOS URL bar collapsing/expanding, pinch-zoom
 * settling - and those deltas are small. Real on-screen keyboards are
 * 200px+ on every phone. 100px cleanly separates the two populations
 * without needing to detect the platform.
 */
const KEYBOARD_THRESHOLD_PX = 100;

/*
 * How many pixels of the layout viewport the keyboard covers.
 *
 * `windowInnerHeight` is the layout viewport height; `visualHeight` is
 * the visible portion. On browsers where the keyboard resizes the
 * layout viewport (Android w/ interactive-widget=resizes-content) the
 * two shrink together and this returns 0 - no double compensation. On
 * browsers where the keyboard only shrinks the visual viewport (iOS
 * Safari) the gap between them is the keyboard.
 */
export function keyboardInsetPx(windowInnerHeight: number, visualHeight: number): number {
  const gap = windowInnerHeight - visualHeight;
  return gap >= KEYBOARD_THRESHOLD_PX ? Math.round(gap) : 0;
}
