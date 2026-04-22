<script lang="ts">
  /**
   * Sticky mood indicator for samskara-formation events.
   *
   * Listens on `window` for `SAMSKARA_MINT_EVENT` (dispatched by
   * SamskaraManager when the worker reports a mint commit). Renders
   * a single emoji that reflects the most recent mint's valence and
   * stays visible for the duration of the current conversation.
   * Swaps to the newer emoji when another mint fires; clears when
   * the user switches threads (tracked via `route.cid`).
   *
   * Earlier revision auto-dismissed each toast after 4s and stacked
   * up to six at once. User feedback: the emoji was vanishing before
   * they could connect it to whatever it was reacting to. Keeping
   * the latest one in place until the next mint (or a thread
   * switch) turns it into a persistent "current mood" glance rather
   * than a fleeting alert.
   *
   * Rendered as a fixed-position pill in the top-right corner, below
   * where the UpdateBanner sits so both can coexist on a rare
   * version-deploy overlap. Safe-area insets clear the iOS notch on
   * installed PWA.
   *
   * Deliberately minimal chrome - one emoji, no text, no border.
   * The predictive-model formation is opaque to the user beyond this
   * glance; anything more would either leak the raw prediction text
   * (privacy-unfriendly) or invite the user to reason about their
   * own bias model (see the "opaque to the user" gotcha in
   * docs/dev/samskara.md).
   */
  import { onMount } from 'svelte';
  import { fly } from 'svelte/transition';
  import { cubicOut } from 'svelte/easing';
  import {
    SAMSKARA_MINT_EVENT,
    valenceToEmoji,
    type SamskaraMintEventDetail,
  } from '$lib/samskara/events';
  import { route } from '$lib/routing.svelte';

  interface Mood {
    /** Stable key for Svelte's keyed each. Monotonic counter beats
     *  Date.now() because back-to-back mints in the same ms still
     *  get distinct ids, and the key drives the fly transition so a
     *  new mint visibly replaces the old one. */
    id: number;
    emoji: string;
    /** Tier is carried for future styling differentiation (tier-2
     *  could get a subtle halo, for instance). Not used visually
     *  today. */
    tier: 1 | 2;
  }

  const FLY_IN_MS = 220;
  const FLY_OUT_MS = 320;

  let current = $state<Mood | null>(null);
  let nextId = 0;

  function adopt(detail: SamskaraMintEventDetail): void {
    current = {
      id: ++nextId,
      emoji: valenceToEmoji(detail.valence),
      tier: detail.tier,
    };
  }

  onMount(() => {
    const handler = (evt: Event): void => {
      const ce = evt as CustomEvent<SamskaraMintEventDetail>;
      if (!ce.detail) return;
      adopt(ce.detail);
    };
    window.addEventListener(SAMSKARA_MINT_EVENT, handler);
    return () => {
      window.removeEventListener(SAMSKARA_MINT_EVENT, handler);
    };
  });

  // Clear on thread switch. The "current mood" belongs to the
  // conversation the user is currently reading; carrying a mood
  // across threads reads as incoherent because a samskara that
  // fired in thread A has no narrative relationship to thread B.
  // Reads route.cid reactively so the effect re-runs whenever the
  // active thread id changes; also fires once on mount (current is
  // already null at that point, so the assignment is a no-op).
  $effect(() => {
    const _ = route.cid;
    void _;
    current = null;
  });
</script>

<div
  class="samskara-mood"
  aria-live="polite"
  aria-atomic="true"
  aria-label="Samskara formation activity"
>
  {#if current}
    {#key current.id}
      <div
        class="mood-pill"
        class:tier-2={current.tier === 2}
        aria-label={`Samskara formed (tier ${current.tier})`}
        in:fly={{ x: 24, duration: FLY_IN_MS, easing: cubicOut }}
        out:fly={{ x: 24, duration: FLY_OUT_MS, easing: cubicOut }}
      >
        <span class="emoji" aria-hidden="true">{current.emoji}</span>
      </div>
    {/key}
  {/if}
</div>

<style>
  /* Fixed pill in the top-right. Offset just below the UpdateBanner
     slot (3rem gives clearance for the banner pill + a breath of
     space) so both coexist on the rare overlap. z-index 90 sits
     above the drawer (20) and modals (30) but below the update
     banner (100). pointer-events:none on the container so the
     indicator never blocks clicks on message-pane content beneath
     it - this is a glance cue, not a control. */
  .samskara-mood {
    position: fixed;
    top: calc(env(safe-area-inset-top, 0px) + 3rem);
    right: calc(env(safe-area-inset-right, 0px) + 0.75rem);
    z-index: 90;
    pointer-events: none;
  }

  .mood-pill {
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
    /* Glance cue, not interactive. No cursor, no hover scale, no
       click handler. Keeps it understated. */
    backdrop-filter: blur(6px);
    -webkit-backdrop-filter: blur(6px);
  }

  /* Tier-2 reserved hook - lands when compound-of-compounds minting
     ships (see runMintTier2Phase in loop.ts). Currently identical to
     tier-1 because no tier-2 mints fire; the class is here so the
     visual differentiation can happen without another worker/UI
     round trip when the phase wakes up. */
  .mood-pill.tier-2 {
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
