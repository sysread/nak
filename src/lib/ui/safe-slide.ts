// A drop-in replacement for Svelte's `slide` transition that no-ops when
// the node has no layout box.
//
// Svelte's built-in slide sizes the animation by reading
// getComputedStyle(node).height (svelte/src/transition/index.js does
// `parseFloat(style.height)`). For a node inside a display:none subtree
// that resolves to "auto", parseFloat returns NaN, and the resulting Web
// Animations API keyframe is rejected with the console warning
// "Invalid keyframe value for property height: NaNpx".
//
// The chat shell goes display:none (.shell-behind-modal in Chat.svelte)
// whenever a modal is open, while any in-flight completion keeps streaming.
// The streaming reasoning panel auto-closes on a ~600ms timer once the
// answer's first text byte arrives, so its outro transition fires while the
// shell is unpainted - producing a burst of these warnings if the user
// opens Settings (or Help, etc.) mid-completion.
//
// getClientRects() is empty for a node with no layout box (display:none or
// detached). When there's nothing painted there's nothing to animate, so we
// fall back to an instant transition and let Svelte add/remove the node
// without a slide.
import { slide, type SlideParams } from 'svelte/transition';
import type { TransitionConfig } from 'svelte/transition';

export function safeSlide(node: Element, params?: SlideParams): TransitionConfig {
  if (node.getClientRects().length === 0) {
    return { duration: 0 };
  }
  return slide(node, params);
}
