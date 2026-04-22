<script lang="ts">
  /**
   * Subtle top-right toast stack for samskara-formation events.
   *
   * Listens on `window` for `SAMSKARA_MINT_EVENT` (dispatched by
   * SamskaraManager when the worker reports a mint commit). Each
   * event pushes a new toast onto the stack; the stack renders
   * newest-first (top) and each toast auto-dismisses after
   * `DISMISS_MS`. Tap / click dismisses early.
   *
   * Rendered as a fixed-position column in the top-right corner, below
   * where the UpdateBanner sits so both can coexist on a rare version-
   * deploy overlap. Safe-area insets clear the iOS notch on installed
   * PWA.
   *
   * Deliberately minimal chrome - one emoji per toast, no text, no
   * border. The predictive-model formation is opaque to the user
   * beyond this glance; anything more would either leak the raw
   * prediction text (privacy-unfriendly) or invite the user to reason
   * about their own bias model (see the "opaque to the user" gotcha
   * in docs/dev/samskara.md).
   */
  import { onMount } from 'svelte';
  import { fly } from 'svelte/transition';
  import { cubicOut } from 'svelte/easing';
  import {
    SAMSKARA_MINT_EVENT,
    valenceToEmoji,
    type SamskaraMintEventDetail,
  } from '$lib/samskara/events';

  interface Toast {
    /** Stable key for Svelte's keyed each. Monotonic counter beats
     *  Date.now() because back-to-back mints in the same ms still get
     *  distinct ids. */
    id: number;
    emoji: string;
    /** Tier is carried for future styling differentiation (tier-2 could
     *  get a subtle halo, for instance). Not used visually in v1. */
    tier: 1 | 2;
  }

  /** Visible lifetime before the toast fades out. Long enough for a
   *  glance, short enough not to linger when several fire in quick
   *  succession. */
  const DISMISS_MS = 4_000;
  /** Transition durations - intro slightly shorter than outro so the
   *  outgoing toast doesn't clip while the next one slides in. */
  const FLY_IN_MS = 220;
  const FLY_OUT_MS = 320;

  let toasts = $state<Toast[]>([]);
  let nextId = 0;

  function dismiss(id: number): void {
    toasts = toasts.filter((t) => t.id !== id);
  }

  function push(detail: SamskaraMintEventDetail): void {
    const id = ++nextId;
    const toast: Toast = {
      id,
      emoji: valenceToEmoji(detail.valence),
      tier: detail.tier,
    };
    // Newest on top - prepend so the stack reads top-down as "most
    // recent first". A cap prevents a flurry of mints from piling up
    // off-screen on a small viewport.
    toasts = [toast, ...toasts].slice(0, 6);
    window.setTimeout(() => dismiss(id), DISMISS_MS);
  }

  onMount(() => {
    const handler = (evt: Event): void => {
      const ce = evt as CustomEvent<SamskaraMintEventDetail>;
      if (!ce.detail) return;
      push(ce.detail);
    };
    window.addEventListener(SAMSKARA_MINT_EVENT, handler);
    return () => {
      window.removeEventListener(SAMSKARA_MINT_EVENT, handler);
    };
  });
</script>

<div
  class="samskara-toasts"
  aria-live="polite"
  aria-atomic="false"
  aria-label="Samskara formation activity"
>
  {#each toasts as toast (toast.id)}
    <button
      type="button"
      class="toast"
      class:tier-2={toast.tier === 2}
      onclick={() => dismiss(toast.id)}
      aria-label={`Samskara formed (tier ${toast.tier})`}
      in:fly={{ x: 24, duration: FLY_IN_MS, easing: cubicOut }}
      out:fly={{ x: 24, duration: FLY_OUT_MS, easing: cubicOut }}
    >
      <span class="emoji" aria-hidden="true">{toast.emoji}</span>
    </button>
  {/each}
</div>

<style>
  /* Fixed column in the top-right. Offset just below the UpdateBanner
     slot (3rem gives clearance for the banner pill + a breath of space)
     so both coexist on the rare overlap. z-index 90 sits above the
     drawer (20) and modals (30) but below the update banner (100). */
  .samskara-toasts {
    position: fixed;
    top: calc(env(safe-area-inset-top, 0px) + 3rem);
    right: calc(env(safe-area-inset-right, 0px) + 0.75rem);
    z-index: 90;
    display: flex;
    flex-direction: column;
    gap: 0.4rem;
    pointer-events: none;
  }

  .toast {
    pointer-events: auto;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 2.1rem;
    height: 2.1rem;
    padding: 0;
    background: color-mix(in srgb, var(--surface) 92%, transparent);
    color: var(--text);
    border: 1px solid color-mix(in srgb, var(--border) 80%, transparent);
    border-radius: 50%;
    box-shadow: 0 4px 12px rgba(0, 0, 0, 0.22);
    cursor: pointer;
    transition: transform 120ms var(--ease, ease-out);
    /* Keep it understated - this is a glance cue, not a call to
       action. Pointer feedback is the only affordance we lean on. */
    backdrop-filter: blur(6px);
    -webkit-backdrop-filter: blur(6px);
  }

  .toast:hover,
  .toast:focus-visible {
    transform: scale(1.06);
    outline: none;
  }

  .toast:active {
    transform: scale(0.96);
  }

  /* Tier-2 reserved hook - lands when compound-of-compounds minting
     ships (see runMintTier2Phase in loop.ts). Currently identical to
     tier-1 because no tier-2 mints fire; the class is here so the
     visual differentiation can happen without another worker/ UI
     round trip when the phase wakes up. */
  .toast.tier-2 {
    box-shadow:
      0 4px 12px rgba(0, 0, 0, 0.22),
      0 0 0 2px color-mix(in srgb, var(--accent) 30%, transparent);
  }

  .emoji {
    font-size: 1.1rem;
    line-height: 1;
    /* Face emojis in events.ts already carry Emoji_Presentation=Yes
       by default (U+1F60A etc. are classified as emoji, not text) so
       no U+FE0F needed. The font-family hint still helps on older
       Android WebView where the system emoji font isn't reached by
       the default cascade. */
    font-family: 'Apple Color Emoji', 'Segoe UI Emoji', 'Noto Color Emoji', sans-serif;
  }
</style>
