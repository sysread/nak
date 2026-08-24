/*
 * Keeps the app shell above the mobile on-screen keyboard.
 *
 * Two-part fix, one per platform family:
 *
 *   - Android/Chrome: `interactive-widget=resizes-content` in the
 *     viewport meta tag (index.html) makes the keyboard shrink the
 *     layout viewport, so plain CSS reflows the shell. This module
 *     then measures a zero gap and stays inert.
 *   - iOS Safari: ignores that meta key. The keyboard only shrinks
 *     the *visual* viewport and paints over the page, and `dvh` units
 *     deliberately do not react to it. This module mirrors the gap
 *     between the layout and visual viewports into the
 *     `--keyboard-inset` CSS variable; styles.css subtracts it from
 *     the <html> height so the composer rides up above the keyboard.
 *
 * The listener also covers the "return to the app with the keyboard
 * already open" case: no focus event fires then (focus never left the
 * textarea), but the visual viewport still emits a resize when the
 * keyboard re-attaches, so the shell reflows anyway.
 *
 * NOTE: the author has no iOS device to test on. If there is a bug
 * where the keyboard draws over the app without the app reacting,
 * this module is the likely spot.
 *
 * Interacts with: styles.css (the html height rule consuming
 * --keyboard-inset), index.html (the viewport meta tag),
 * src/lib/ui/keyboard-inset.ts (the pure inset computation).
 */

import { keyboardInsetPx } from '$lib/ui/keyboard-inset';

// Idempotent: safe to call from every App mount cycle; only the first
// call installs the listeners. Matches the initUpdateWatcher pattern.
let installed = false;

export function initKeyboardInset(): void {
  if (installed) return;
  // Older browsers (and jsdom in tests) have no visualViewport; there
  // the meta-tag behavior or desktop layout applies and we do nothing.
  const vv = window.visualViewport;
  if (!vv) return;
  installed = true;

  const root = document.documentElement;
  const update = (): void => {
    const inset = keyboardInsetPx(window.innerHeight, vv.height);
    root.style.setProperty('--keyboard-inset', `${inset}px`);
    // iOS scrolls the layout viewport to reveal a focused input even
    // though the document has overflow:hidden, which leaves the whole
    // shell shifted up under the top of the screen. Pin it back; with
    // the shell shrunk by the inset there is nothing to reveal.
    if (inset > 0 && window.scrollY !== 0) window.scrollTo(0, 0);
  };

  // resize fires when the keyboard opens/closes; scroll fires when the
  // browser pans the visual viewport (the focused-input reveal above).
  vv.addEventListener('resize', update);
  vv.addEventListener('scroll', update);
  update();
}
