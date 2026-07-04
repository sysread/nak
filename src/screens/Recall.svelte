<script lang="ts">
  /**
   * Recall diagnostics modal. Read-only view of the context-recall
   * injections that have ridden into this thread's chat-loop turns -
   * the stitched first-person notes the chat-loop hands to the model
   * as synthetic assistant `<think>` blocks.
   *
   * Each entry is per-turn and ephemeral: the chat-loop computes a
   * fresh injection, drops it into the next round's history, and
   * never persists it as a message row. Only the most recent payload
   * survives across page reloads (it lives on the thread row's
   * `context_recall_payload` jsonb cache so the trigger evaluator
   * can debounce); earlier payloads accumulate in-memory for the
   * lifetime of this tab via Chat.svelte's contextRecallHistory map.
   *
   * The display structure (most-recent on top, earlier turns in
   * descending order separated by hr rules) makes the per-turn
   * cadence obvious: each section pairs the triggering user prompt
   * with the note that was injected before the assistant replied,
   * so the user can audit "what was Nak holding in mind when I
   * said X."
   *
   * Reached from the light-bulb pill in the bottom-right pill column
   * (sibling to the intuition brain, samskara mood, bias chart).
   * Opens via `navigate({ modal: 'recall' })` and reads the active
   * thread's payload + history + user-message map from Chat.svelte
   * props. Non-thread states (cold start, deleted thread) and threads
   * where recall has never fired render an explanatory empty-state
   * rather than a blank panel.
   *
   * Sibling to Intuition.svelte and Samskara.svelte - same chrome,
   * distinct content. This file owns the modal chrome and the
   * most-recent-first list; each turn-entry (the user prompt, the
   * injected note, and its cited sources) is rendered by the companion
   * RecallEntry.svelte, which owns the note markup, the chapter-opener
   * light-bulb drop cap, and the per-entry citations panel + click
   * interaction.
   */
  import { route } from '$lib/routing.svelte';
  import RecallEntry from '../components/RecallEntry.svelte';
  import {
    coerceContextRecallPayload,
    type ContextRecallPayload,
  } from '$lib/context-recall';
  import { buildRecallEntries } from '$lib/ui/recall';
  import { isStaleForDisplay } from '$lib/ui/payload-freshness';
  import type { Message, Thread } from '$lib/supabase';

  interface Props {
    onClose: () => void;
    /** Active threads passed in by the parent so the modal can find
     *  the row matching `route.cid`. Same posture as Intuition.svelte
     *  - we read from the parent rather than from app.state because
     *  the threads list is owned by Chat.svelte's local state. */
    threads: readonly Thread[];
    /** Earlier context-recall payloads for the active thread, in
     *  landing order (oldest first). The current (most recent)
     *  payload still lives on the thread row, not in this array. */
    history: readonly ContextRecallPayload[];
    /** Round number -> user Message row, derived in Chat.svelte from
     *  the active thread's messages. Lets each entry render the user
     *  prompt that triggered the injection. A round whose user
     *  message has since been edited or deleted will be absent from
     *  the map; we render a graceful fallback in that case. */
    userMessageByRound: Map<number, Message>;
  }
  let { onClose, threads, history, userMessageByRound }: Props = $props();

  const payload = $derived.by<ContextRecallPayload | null>(() => {
    const cid = route.cid;
    if (cid === null) return null;
    const t = threads.find((th) => th.id === cid);
    if (!t) return null;
    const p = coerceContextRecallPayload(t.context_recall_payload);
    // A zero-length note is a valid cached state ("both children
    // returned empty this round") but there's nothing to display, so
    // treat it as "no payload" for the modal's purposes.
    if (!p || p.note.trim().length === 0) return null;
    return p;
  });

  // Decision logic for assembling the entries list lives in
  // src/lib/ui/recall.ts as buildRecallEntries() - the rune call
  // here is just the framework wire-up.
  const entries = $derived<readonly ContextRecallPayload[]>(
    buildRecallEntries(payload, history)
  );

  // Snapshot at modal-open for the per-entry relative-age line. The modal
  // is short-lived, so a static "now" is fine - no live clock. The stale
  // badge only applies to the live cache (entries[0] when `payload` is
  // non-null); history entries are past payloads, so staleness is moot.
  const now = Date.now();
</script>

<svelte:window onkeydown={(e) => { if (e.key === 'Escape') onClose(); }} />

<!-- svelte-ignore a11y_no_static_element_interactions -->
<!-- svelte-ignore a11y_click_events_have_key_events -->
<div
  class="center recall-backdrop"
  onclick={(e) => { if (e.target === e.currentTarget) onClose(); }}
>
  <div class="recall-shell" role="dialog" aria-modal="true" aria-label="Recall diagnostics">
    <button
      type="button"
      class="recall-close"
      onclick={onClose}
      aria-label="Close diagnostics"
      title="Close"
    >&times;</button>

    <header class="recall-header">
      <h1 class="recall-title">Recall</h1>
      <p class="subtle recall-blurb">
        Before some replies, Nak stitches a first-person note from
        your memories, prior conversations, and wiki articles and
        injects it as its own prior thought - for that turn only.
        The pipeline refires when the topic or your mood shifts.
        Most recent at the top; earlier injections from this
        session follow below when present.
      </p>
    </header>

    <div class="recall-body">
      {#if entries.length === 0}
        <p class="empty">
          {#if route.cid === null}
            No conversation selected. The recall layer reads from
            the active thread.
          {:else}
            No recall has fired for this thread yet. The first
            pass usually lands during the opening turn; subsequent
            refreshes follow topic shifts, mood shifts, or a long
            stretch without an update.
          {/if}
        </p>
      {:else}
        {#each entries as entry, i (entry.computed_at_at)}
          {#if i > 0}
            <hr class="entry-sep" />
          {/if}
          <!-- The stale badge applies only to the live cache entry
               (entries[0] when `payload` is non-null); history entries
               are past payloads, so staleness is moot for them. -->
          <RecallEntry
            {entry}
            userMsg={userMessageByRound.get(entry.computed_at_round)}
            stale={i === 0 &&
              payload !== null &&
              isStaleForDisplay(entry.computed_at_at, now)}
            {now}
          />
        {/each}
      {/if}
    </div>
  </div>
</div>

<style>
  .recall-backdrop {
    position: fixed;
    inset: 0;
    background: color-mix(in srgb, #000 50%, transparent);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 50;
    padding: 1rem;
  }

  .recall-shell {
    position: relative;
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius-lg);
    box-shadow: var(--shadow-modal);
    width: 100%;
    max-width: 48rem;
    display: grid;
    grid-template-rows: auto 1fr;
    height: min(44rem, 88vh);
    overflow: hidden;
  }

  .recall-close {
    position: absolute;
    top: 0.5rem;
    right: 0.5rem;
    z-index: 2;
    width: 2rem;
    height: 2rem;
    padding: 0;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    font-size: 1.4rem;
    line-height: 1;
    background: var(--surface);
    color: var(--text);
    border: 1px solid var(--border);
    border-radius: var(--radius-round);
    cursor: pointer;
  }

  .recall-close:hover {
    background: var(--bg-2);
  }

  .recall-header {
    padding: 1rem 1.25rem 0.75rem;
    border-bottom: 1px solid var(--border);
    background: var(--bg-2);
    min-width: 0;
  }

  .recall-title {
    font-size: 1.1rem;
    margin: 0 0 0.25rem;
    padding-right: 3rem;
  }

  .recall-blurb {
    margin: 0;
    font-size: 0.85rem;
  }

  .recall-body {
    padding: 1rem 1.25rem;
    overflow-y: auto;
    min-width: 0;
  }

  .entry-sep {
    border: 0;
    border-top: 1px solid var(--border);
    margin: 1.5rem 0;
  }

  .empty {
    margin: 0;
    color: var(--text);
    line-height: 1.5;
  }

  .subtle {
    color: color-mix(in srgb, var(--text) 65%, transparent);
  }
</style>
