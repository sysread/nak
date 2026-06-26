<script lang="ts">
  /**
   * Headless single owner of the samskara "current mood" data. Renders
   * nothing - it exists to run the mood pipeline exactly once, writing
   * into the shared `moodState` store that both DiagnosticPills mounts
   * (desktop column + mobile wharf) read passively.
   *
   * Why headless + single-mount: the pill is shown on two surfaces, so
   * the pill component is mounted twice. The seed/mint logic must NOT
   * live in it or it would run twice (double mint adoption, double seed
   * fetch, double clear). This component is mounted once in Chat.svelte
   * and is the store's only writer.
   *
   * What it does (unchanged from the prior SamskaraToasts.svelte pill):
   * listens on `window` for `SAMSKARA_MINT_EVENT` (dispatched by
   * Chat.svelte's realtime relay when the formation pipeline INSERTs a
   * fresh samskara) and adopts the new valence; on thread open, seeds
   * from the most recent fire's joined valence via
   * `samskaraGetLatestFireMood(cid)` so reopening a conversation reads
   * as the model's current take rather than forcing a wait for a fresh
   * mint. While the seed is in flight, on threads that never fired, and
   * when the query fails, the store carries the U+1F4A4 placeholder.
   * On the brand-new-chat screen (`route.cid === null`) there's no
   * conversation to scope a mood to, so the store is cleared and the
   * pill suppresses itself.
   */
  import { onMount } from 'svelte';
  import {
    SAMSKARA_MINT_EVENT,
    type SamskaraMintEventDetail,
  } from '$lib/samskara/events';
  import { moodState } from '$lib/samskara/mood.svelte';
  import {
    defaultMood,
    nextMoodFromMint,
    nextMoodFromSeed,
  } from '$lib/ui/samskara-toasts';
  import { route } from '$lib/routing.svelte';
  import { app } from '$lib/state.svelte';

  // Monotonic id that keys the pill's fly transition; bumped on every
  // visual change. Back-to-back mints in the same ms still get distinct
  // ids, so the transition re-plays.
  let nextId = 0;
  // Generation counter for the seed-from-history fetch. Bumped on every
  // thread switch; the in-flight async checks the captured generation
  // against the current value before applying, so a slow query for
  // thread A can't clobber a fresh seed (or a real mint) for thread B.
  let seedGeneration = 0;

  function adopt(detail: SamskaraMintEventDetail): void {
    const transition = nextMoodFromMint(moodState.visual, detail);
    // storeUpdate is unconditional: the shared `current` triple tracks
    // every mint even when the pill's dedup skips the visual swap. The
    // diagnostics-modal "you are here" dot reads `current` directly so
    // it follows raw mints rather than the de-duplicated pill animation.
    moodState.set(transition.storeUpdate);
    // visual is null when dedup applies (same band, same tier).
    if (transition.visual !== null) {
      moodState.setVisual({ id: ++nextId, ...transition.visual });
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

  // Best-effort: pull the most recent fire's valence for this thread and
  // use it to replace the placeholder. Bails when the user switched
  // threads mid-fetch (gen no longer current), when the query fails, or
  // when a real mint landed first (placeholder no longer showing). The
  // placeholder is the right fallback for "we don't know."
  async function seedFromHistory(cid: string, gen: number): Promise<void> {
    const sb = app.supabase;
    if (!sb) return;
    try {
      const result = await sb.samskaraGetLatestFireMood(cid);
      // Cross-thread race guard: discard if the user navigated away
      // while this query was in flight. Stays here because it reads
      // this owner's generation counter; the within-thread races (real
      // mint already replaced the placeholder; RPC returned no seed)
      // are folded into `nextMoodFromSeed`'s null return.
      if (gen !== seedGeneration) return;
      const transition = nextMoodFromSeed(moodState.visual, result);
      if (transition === null) return;
      moodState.setVisual({ id: ++nextId, ...transition.visual });
      // Mirror the seed into `current` so the diagnostics-modal dot can
      // render on a freshly-reopened thread that hasn't seen a new mint.
      moodState.set(transition.storeUpdate);
    } catch {
      // best-effort; staying on the placeholder is the correct fallback.
    }
  }

  // Reset on thread switch. The "current mood" belongs to the
  // conversation the user is currently reading; carrying a mood across
  // threads reads as incoherent. Initial render is always the placeholder
  // (so the pill never pops in late); seedFromHistory then asynchronously
  // upgrades it to the most recent fire's valence if the thread has any.
  // On the brand-new-chat screen (route.cid === null) the store is
  // cleared so the pill is suppressed - no conversation context. Reads
  // route.cid reactively so the effect re-runs on every thread change;
  // also fires once on mount to seed the initial state.
  $effect(() => {
    const cid = route.cid;
    seedGeneration += 1;
    const gen = seedGeneration;
    moodState.clear();
    if (cid !== null) {
      moodState.setVisual({ id: ++nextId, ...defaultMood() });
      void seedFromHistory(cid, gen);
    }
  });
</script>
