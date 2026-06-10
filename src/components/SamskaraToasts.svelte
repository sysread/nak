<script lang="ts">
  /**
   * Sticky mood indicator for samskara-formation events.
   *
   * Listens on `window` for `SAMSKARA_MINT_EVENT` (dispatched by
   * SamskaraManager when the worker reports a mint commit). Renders
   * a single emoji that reflects the most recent mint's valence and
   * stays visible for the duration of the current conversation.
   * Swaps to the newer emoji when another mint fires.
   *
   * Whenever a thread is active (`route.cid` is set) the pill is
   * visible. On thread open, the pill seeds from the most recent
   * fire's joined samskara valence via
   * `samskaraGetLatestFireMood(cid)` - reopening an existing
   * conversation reads as the model's current take rather than
   * forcing the user to wait for a fresh mint. While the seed query
   * is in flight, and on threads that have never fired (or where the
   * query fails), the pill renders U+1F4A4 SLEEPING SYMBOL (💤) as a
   * "nothing to report" placeholder. Click always opens the Samskara
   * diagnostics modal regardless of state, so the user has a
   * consistent affordance for "what is this thing predicting about
   * me right now". The pill is only suppressed on the brand-new-chat
   * screen where `route.cid === null` - there's no conversation
   * context to predict against, so the indicator would be lying.
   *
   * Earlier revision auto-dismissed each toast after 4s and stacked
   * up to six at once. User feedback: the emoji was vanishing before
   * they could connect it to whatever it was reacting to. Keeping
   * the latest one in place until the next mint (or a thread
   * switch) turns it into a persistent "current mood" glance rather
   * than a fleeting alert.
   *
   * Rendered as an absolutely-positioned pill anchored inside
   * .messages-wrap (Chat.svelte). Stacks in a vertical column between
   * the IntuitionPill above and the .scroll-to-bottom arrow below,
   * all pinned to the bottom-right of the messages pane. Mounting
   * inside .messages-wrap (rather than as a viewport-fixed pill) is
   * what keeps the column aligned with the scroll arrow regardless of
   * composer height.
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
    type SamskaraMintEventDetail,
  } from '$lib/samskara/events';
  import { moodState } from '$lib/samskara/mood.svelte';
  import { samskaraView } from '$lib/samskara-browse-store.svelte';
  import {
    DEFAULT_EMOJI,
    defaultMood,
    nextMoodFromMint,
    nextMoodFromSeed,
    type MoodShape,
  } from '$lib/ui/samskara-toasts';
  import { navigate, route } from '$lib/routing.svelte';
  import { app } from '$lib/state.svelte';

  /**
   * Component-local view of a mood: the primitive's `MoodShape`
   * plus a stable id that keys the `{#key current.id}` block and
   * drives the fly transition. Monotonic counter beats Date.now()
   * because back-to-back mints in the same ms still get distinct
   * ids, and the key drives the transition so a new mint visibly
   * replaces the old one.
   */
  interface Mood extends MoodShape {
    id: number;
  }

  const FLY_IN_MS = 220;
  const FLY_OUT_MS = 320;

  let current = $state<Mood | null>(null);
  let nextId = 0;
  // Monotonic generation counter for the seed-from-history fetch.
  // Bumped on every thread switch; the in-flight async checks the
  // captured generation against the current value before applying its
  // result, so a slow query for thread A can't clobber a fresh seed
  // (or a real mint) for thread B if the user switches mid-fetch.
  let seedGeneration = 0;

  function adopt(detail: SamskaraMintEventDetail): void {
    const transition = nextMoodFromMint(current, detail);
    // storeUpdate is unconditional: the shared store tracks every
    // mint event even when the local pill's dedup decision (below)
    // skips the visual swap. The diagnostics-modal "you are here"
    // dot reads the store directly so it follows raw mints rather
    // than the de-duplicated pill animation.
    moodState.set(transition.storeUpdate);
    // visual is null when dedup applies (same band, same tier).
    if (transition.visual !== null) {
      current = { id: ++nextId, ...transition.visual };
    }
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

  // Best-effort: pull the most recent fire's valence for this thread
  // and use it to replace the 💤 placeholder. Bails when the user has
  // switched threads mid-fetch (gen no longer current), when the query
  // fails (network blip / Supabase not ready), or when a real mint
  // landed first (the placeholder is no longer showing). Falls through
  // silently in all those cases - the 💤 default is the right
  // fallback for "we don't know."
  async function seedFromHistory(cid: string, gen: number): Promise<void> {
    const sb = app.supabase;
    if (!sb) return;
    try {
      const result = await sb.samskaraGetLatestFireMood(cid);
      // Cross-thread race guard: discard if the user navigated to
      // a different thread while this query was in flight. Stays
      // at the call site because it reads the component's own
      // generation counter; both within-thread races (real mint
      // already replaced the placeholder; RPC returned no seed)
      // are folded into `nextMoodFromSeed`'s null return.
      if (gen !== seedGeneration) return;
      const transition = nextMoodFromSeed(current, result);
      if (transition === null) return;
      current = { id: ++nextId, ...transition.visual };
      // The store update mirrors the seed value so the
      // diagnostics-modal dot can render on a freshly-reopened
      // thread that hasn't seen a new mint yet. Always paired with
      // the visual update - `nextMoodFromSeed` returns either both
      // or neither.
      moodState.set(transition.storeUpdate);
    } catch {
      // best-effort; staying on 💤 is the correct fallback shape.
    }
  }

  // Reset on thread switch. The "current mood" belongs to the
  // conversation the user is currently reading; carrying a mood
  // across threads reads as incoherent because a samskara that
  // fired in thread A has no narrative relationship to thread B.
  // Initial render is always the 💤 placeholder so the pill never
  // pops in late; the seed-from-history fetch then asynchronously
  // upgrades it to the most recent fire's valence if the thread has
  // any. On the brand-new-chat screen (route.cid === null) the pill
  // is suppressed entirely because there's no conversation context.
  // Reads route.cid reactively so the effect re-runs whenever the
  // active thread id changes; also fires once on mount, which seeds
  // the initial state.
  $effect(() => {
    const cid = route.cid;
    seedGeneration += 1;
    const gen = seedGeneration;
    // The shared store always clears on a thread switch. seedFromHistory
    // re-populates it when (and if) a real mood lands; until then the
    // diagnostics-modal dot stays hidden. Mirrors the same "moods belong
    // to a thread" semantics the local pill uses for its 💤 placeholder.
    moodState.clear();
    if (cid !== null) {
      current = { id: ++nextId, ...defaultMood() };
      void seedFromHistory(cid, gen);
    } else {
      current = null;
    }
  });
</script>

<div
  class="samskara-mood"
  aria-live="polite"
  aria-atomic="true"
  aria-label="Samskara formation activity"
>
  <!-- Always-rendered. On the brand-new-chat screen (route.cid is
       null) there's no conversation context to predict against, so
       there's no mood to show; the pill renders disabled / grayed
       with the 💤 placeholder emoji. As soon as a thread is active
       the pill enables and seeds from history; the {#key} block
       drives the fly transition when the emoji swaps to a fresh
       mint. -->
  {#if current === null}
    <button
      type="button"
      class="mood-pill is-disabled"
      disabled
      title="Samskara diagnostics - no conversation selected"
      aria-label="Samskara diagnostics (no conversation selected)"
    >
      <span class="emoji" aria-hidden="true">{DEFAULT_EMOJI}</span>
    </button>
  {:else}
    {#key current.id}
      <button
        type="button"
        class="mood-pill"
        class:tier-2={current.tier === 2}
        title={current.isDefault
          ? 'Samskara diagnostics - no mood data yet'
          : `feelin' ${current.label} - open Samskara diagnostics`}
        aria-label={current.isDefault
          ? 'Open Samskara diagnostics. No mood data yet for this conversation.'
          : `Samskara mood: ${current.label} (tier ${current.tier}). Open diagnostics.`}
        onclick={() => {
          // Deep-link to the Summary & mood sub-view of the Samskara tab
          // so the legend explaining this emoji is what opens.
          samskaraView.sub = 'summary';
          navigate({ drawer: 'samskara' });
        }}
        in:fly={{ x: 24, duration: FLY_IN_MS, easing: cubicOut }}
        out:fly={{ x: 24, duration: FLY_OUT_MS, easing: cubicOut }}
      >
        <span class="emoji" aria-hidden="true">{current.emoji}</span>
      </button>
    {/key}
  {/if}
</div>

<style>
  /* Middle slot of the bottom-right pill column. The scroll-to-bottom
     arrow sits at bottom: 1rem with a 2.2rem footprint; this pill
     stacks directly above it at bottom: 1rem + 2.2rem + 0.4rem gap =
     3.6rem (2.1rem height), and the IntuitionPill stacks above this
     one at 6.1rem. All three are right-anchored at 1rem; the 0.05rem
     horizontal offset between the 2.1rem pills and the 2.2rem arrow
     is below perceptual threshold. z-index 25 sits above the chat
     surface but below modals (30), drawers (40), Cookbook (40),
     Samskara (50), and the update banner (100) - this is a passive
     glance cue and should never float over interactive surfaces.
     pointer-events:none on the container so the indicator never
     blocks clicks on content beneath it. */
  .samskara-mood {
    position: absolute;
    bottom: 3.6rem;
    right: 1rem;
    z-index: 25;
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
    /* Re-enable pointer events for the pill itself (the container
       is pointer-events:none so it doesn't block the message pane
       beneath). Required for both the native tooltip on `title` and
       the click handler that opens the Samskara diagnostics modal. */
    pointer-events: auto;
    cursor: pointer;
    backdrop-filter: blur(6px);
    -webkit-backdrop-filter: blur(6px);
  }

  .mood-pill:hover {
    border-color: color-mix(in srgb, var(--accent) 60%, var(--border));
  }

  .mood-pill:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 2px;
  }

  /* Disabled state. Same shape as IntuitionPill / BiasPill's disabled
     style - faded contents, cursor signaling non-interactivity. The
     pill still shows so the user knows the feature exists; clicks
     are blocked by the disabled attribute. */
  .mood-pill:disabled,
  .mood-pill.is-disabled {
    opacity: 0.35;
    cursor: not-allowed;
  }

  .mood-pill:disabled:hover,
  .mood-pill.is-disabled:hover {
    border-color: color-mix(in srgb, var(--border) 80%, transparent);
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
