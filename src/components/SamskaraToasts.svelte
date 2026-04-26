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
    valenceToMoodLabel,
    type SamskaraMintEventDetail,
  } from '$lib/samskara/events';
  import { moodState } from '$lib/samskara/mood.svelte';
  import { navigate, route } from '$lib/routing.svelte';
  import { app } from '$lib/state.svelte';

  interface Mood {
    /** Stable key for Svelte's keyed each. Monotonic counter beats
     *  Date.now() because back-to-back mints in the same ms still
     *  get distinct ids, and the key drives the fly transition so a
     *  new mint visibly replaces the old one. */
    id: number;
    emoji: string;
    /** Short label (cheerful / content / neutral / uneasy / pensive,
     *  or `idle` for the default sleeping state) that drives the
     *  tooltip. Derived at capture time from the same valence the
     *  emoji came from, so the two stay consistent even if
     *  valenceToEmoji's bands later shift. */
    label: string;
    /** Tier is carried for future styling differentiation (tier-2
     *  could get a subtle halo, for instance). Not used visually
     *  today. */
    tier: 1 | 2;
    /** True for the 💤 placeholder shown on threads with no fire
     *  history yet (or while the seed fetch is in flight). Flips to
     *  false once a real mood lands - either via a fresh mint event
     *  through `adopt`, or via `seedFromHistory` upgrading the
     *  placeholder with the most recent stored fire's valence.
     *  Drives the tooltip and aria-label so screen readers can tell
     *  "no mood data" from a real reading instead of just hearing
     *  "samskara mood: idle" and not knowing what idle means. */
    isDefault: boolean;
  }

  /** U+1F4A4 SLEEPING SYMBOL. The "nothing has fired yet" placeholder.
   *  Picked deliberately because it isn't in valenceToEmoji's output
   *  set - any real mint produces a different glyph, so the swap from
   *  default to mood is always visible. */
  const DEFAULT_EMOJI = '\u{1F4A4}';
  const DEFAULT_LABEL = 'idle';

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

  function makeDefault(): Mood {
    return {
      id: ++nextId,
      emoji: DEFAULT_EMOJI,
      label: DEFAULT_LABEL,
      tier: 1,
      isDefault: true,
    };
  }

  function adopt(detail: SamskaraMintEventDetail): void {
    const emoji = valenceToEmoji(detail.valence, detail.confidence);
    const label = valenceToMoodLabel(detail.valence, detail.confidence);
    // The shared store always reflects the most recent raw triple,
    // even when the local pill skips its visual update below. The
    // diagnostics-modal "you are here" dot reads this directly, so
    // it tracks the actual mint event rather than the de-duplicated
    // pill animation - if two consecutive mints land in the same
    // band, the dot still updates to the second mint's exact
    // (valence, confidence) coordinate.
    moodState.set({
      valence: detail.valence,
      confidence: detail.confidence,
      tier: detail.tier,
    });
    // Skip the swap when the incoming mint lands in the same
    // valence band as what's already showing AND the tier hasn't
    // changed. Without this, every mint bumps `id`, which keys the
    // fly transition and re-plays the slide even when the emoji
    // and the styling are identical - reads as visual noise when
    // the model has been steady-state for a few mints in a row.
    // tier is part of the comparison because tier-2 carries a halo
    // (.mood-pill.tier-2) so a tier change IS visually meaningful
    // even at the same valence.
    if (
      current !== null &&
      current.emoji === emoji &&
      current.label === label &&
      current.tier === detail.tier
    ) {
      return;
    }
    current = {
      id: ++nextId,
      emoji,
      label,
      tier: detail.tier,
      isDefault: false,
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
      if (gen !== seedGeneration) return;
      if (!result) return;
      if (!current || !current.isDefault) return;
      current = {
        id: ++nextId,
        emoji: valenceToEmoji(result.valence, result.confidence),
        label: valenceToMoodLabel(result.valence, result.confidence),
        tier: result.tier,
        isDefault: false,
      };
      // Mirror the seed into the shared store so the diagnostics-
      // modal dot can render even on a freshly-reopened thread that
      // hasn't seen a new mint yet. Stays inside the
      // `current.isDefault` guard above so a real mint that landed
      // first won't get clobbered by a slow seed query.
      moodState.set({
        valence: result.valence,
        confidence: result.confidence,
        tier: result.tier,
      });
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
      current = makeDefault();
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
  {#if current && route.cid !== null}
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
        onclick={() => navigate({ modal: 'samskara' })}
        in:fly={{ x: 24, duration: FLY_IN_MS, easing: cubicOut }}
        out:fly={{ x: 24, duration: FLY_OUT_MS, easing: cubicOut }}
      >
        <span class="emoji" aria-hidden="true">{current.emoji}</span>
      </button>
    {/key}
  {/if}
</div>

<style>
  /* Fixed pill in the top-right. Offset just below the UpdateBanner
     slot (3rem gives clearance for the banner pill + a breath of
     space) so both coexist on the rare overlap. z-index 25 sits
     above the nav layer (20) but below drawers (40), modals (30),
     and the update banner (100) - this is a passive glance cue and
     should never float over interactive surfaces. pointer-events:none
     on the container so the indicator never blocks clicks on content
     beneath it. */
  .samskara-mood {
    position: fixed;
    top: calc(env(safe-area-inset-top, 0px) + 3rem);
    right: calc(env(safe-area-inset-right, 0px) + 0.75rem);
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
