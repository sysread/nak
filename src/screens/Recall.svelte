<script lang="ts">
  /**
   * Recall diagnostics modal. Read-only view of the cached context-
   * recall payload for the active thread - the stitched first-person
   * note the chat-loop injects as an assistant `<think>` block before
   * the next response.
   *
   * Reached from the light-bulb pill in the bottom-right pill column
   * (sibling to the intuition brain, samskara mood, bias chart).
   * Opens via `navigate({ modal: 'recall' })` and reads the active
   * thread's payload from the route + threads list. Non-thread states
   * (cold start, deleted thread) and threads where recall has never
   * fired render an explanatory empty-state rather than a blank panel.
   *
   * Sibling to Intuition.svelte and Samskara.svelte - same chrome,
   * distinct content. The user asked specifically for a chapter-
   * opener visual: a large light-bulb glyph float-dropped into the
   * first line of italic prose, like the illuminated initial that
   * opens a chapter in a printed book. That's the .recall-prose +
   * .recall-bulb pair below.
   *
   * The note itself is what the model actually saw on the most recent
   * injection - we render it verbatim, no paraphrasing, no markdown
   * pass. The first-person voice ("I remember...", "Last time we
   * talked about this...") is already in the right register; italic
   * styling reinforces the "internal monologue" framing without
   * trying to dress it up.
   */
  import { route } from '$lib/routing.svelte';
  import {
    coerceContextRecallPayload,
    type ContextRecallPayload,
  } from '$lib/context-recall';
  import type { Thread } from '$lib/supabase';

  interface Props {
    onClose: () => void;
    /** Active threads passed in by the parent so the modal can find
     *  the row matching `route.cid`. Same posture as Intuition.svelte
     *  - we read from the parent rather than from app.state because
     *  the threads list is owned by Chat.svelte's local state. */
    threads: readonly Thread[];
  }
  let { onClose, threads }: Props = $props();

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

  function formatTimestamp(ms: number): string {
    try {
      return new Date(ms).toLocaleString();
    } catch {
      return String(ms);
    }
  }

  function formatTrigger(t: ContextRecallPayload['trigger']): string {
    switch (t) {
      case 'title':
        return 'topic shift (title changed)';
      case 'mood':
        return 'mood shift';
      case 'stale':
        return 'staleness fuse';
      case 'cold':
        return 'first read on this thread';
    }
  }
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
        What Nak quietly remembered for this conversation before
        the next reply. Stitched from your memories, prior
        conversations, and wiki articles; injected as the
        assistant's own prior thought so the next response can
        factor it in.
      </p>
    </header>

    <div class="recall-body">
      {#if !payload}
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
        <section class="block">
          <p class="recall-prose">
            <!-- Drop-capped light bulb at the start of the first
                 line - the chapter-opener metaphor from the brief.
                 SVG (not emoji) so we get crisp rendering at the
                 large drop-cap size across platforms; emoji
                 presentation varies wildly between fonts at this
                 scale. -->
            <svg
              class="recall-bulb"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="1.6"
              stroke-linecap="round"
              stroke-linejoin="round"
              aria-hidden="true"
            >
              <path d="M9 18h6" />
              <path d="M10 22h4" />
              <path d="M12 2a7 7 0 0 0-4 12.7c.7.7 1 1.7 1 2.7V18h6v-.6c0-1 .3-2 1-2.7A7 7 0 0 0 12 2z" />
            </svg>
            {payload.note}
          </p>
        </section>

        <footer class="recall-footer subtle">
          <p>Computed {formatTimestamp(payload.computed_at_at)}</p>
          <p>Trigger: {formatTrigger(payload.trigger)}</p>
          <p>User round: {payload.computed_at_round}</p>
        </footer>
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
    border-radius: 12px;
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
    border-radius: 50%;
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

  .block {
    margin: 0 0 1.25rem;
  }

  .block:last-of-type {
    margin-bottom: 0.5rem;
  }

  /* Italic prose with a floated-left light bulb acting as a drop
     cap. The float pulls subsequent lines to wrap around the bulb's
     right edge, exactly the printed-chapter effect requested. The
     line-height is bumped slightly so the wrapped lines don't crowd
     the bulb on the left. */
  .recall-prose {
    margin: 0;
    font-style: italic;
    line-height: 1.55;
    color: var(--text);
    /* white-space:pre-wrap so paragraph breaks in the stitched note
       survive into the rendered card. The stitch is single-paragraph
       in practice but we don't want to lose the seam between layers
       if the agents emit one. */
    white-space: pre-wrap;
  }

  .recall-bulb {
    float: left;
    width: 3.5rem;
    height: 3.5rem;
    margin: 0.15rem 0.75rem 0 0;
    color: color-mix(in srgb, var(--accent) 75%, var(--text));
    /* Soft glow so the bulb reads as illuminated rather than just a
       large icon. The shadow uses currentColor via the same accent
       blend so it tints with the user's accent setting. */
    filter: drop-shadow(0 0 6px color-mix(in srgb, var(--accent) 35%, transparent));
  }

  .recall-footer {
    margin-top: 1rem;
    padding-top: 0.75rem;
    border-top: 1px solid var(--border);
    /* Clear the floated bulb so the metadata sits below the prose
       block rather than wrapping around it. */
    clear: both;
  }

  .recall-footer p {
    margin: 0 0 0.2rem;
    font-size: 0.8rem;
  }

  .recall-footer p:last-child {
    margin-bottom: 0;
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
