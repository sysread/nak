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
   * distinct content. The chapter-opener light-bulb glyph is a
   * float-dropped initial at the start of each injection's prose,
   * marking the "internal monologue" voice visually distinct from
   * the user prompt above it.
   *
   * The notes render through the shared Markdown component, the same
   * pipeline a chat reply uses, so any light formatting the stitch
   * emits (emphasis, lists, the occasional inline code) lands the way
   * it does in the conversation. The first-person voice ("I
   * remember...", "Last time we talked about this...") is already in
   * the right register; italic styling reinforces the internal-
   * monologue framing.
   */
  import { route } from '$lib/routing.svelte';
  import Markdown from '../components/Markdown.svelte';
  import {
    coerceContextRecallPayload,
    type ContextRecallPayload,
  } from '$lib/context-recall';
  import {
    buildRecallEntries,
    formatRecallTimestamp,
    formatRecallTrigger,
  } from '$lib/ui/recall';
  import {
    formatRelativeAge,
    isStaleForDisplay,
  } from '$lib/ui/payload-freshness';
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
          {@const userMsg = userMessageByRound.get(entry.computed_at_round)}
          <section class="entry">
            <h2 class="turn-heading">Turn {entry.computed_at_round}</h2>

            <h3 class="sub-heading">User</h3>
            {#if userMsg && userMsg.content.trim().length > 0}
              <p class="user-prompt">{userMsg.content}</p>
            {:else}
              <!-- A round number with no matching user message in
                   the loaded transcript - the row may have been
                   edited or deleted since the injection fired.
                   Keep the diagnostic visible rather than dropping
                   the entry entirely; the injection still tells
                   the user what Nak was thinking about. -->
              <p class="user-prompt subtle missing">
                (user message no longer available)
              </p>
            {/if}

            <h3 class="sub-heading">Internal context</h3>
            <!-- A div, not a p: the Markdown component emits block
                 content (paragraphs, lists) which is invalid nested
                 inside a <p>. The floated bulb is a sibling preceding
                 the .md block, and .md is a plain block (not a BFC),
                 so the note's first line still wraps around the drop
                 cap exactly as verbatim text did. -->
            <div class="recall-prose">
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
              <Markdown content={entry.note} />
            </div>

            <p class="entry-meta subtle">
              {formatRecallTrigger(entry.trigger)} · {formatRecallTimestamp(entry.computed_at_at)}
              ({formatRelativeAge(entry.computed_at_at, now)})
              {#if i === 0 && payload !== null && isStaleForDisplay(entry.computed_at_at, now)}
                <span class="stale-badge">stale</span>
              {/if}
            </p>
          </section>
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

  .entry {
    /* Each turn-entry stands on its own; the hr rule between entries
       (rendered conditionally above) carries the visual separation,
       so the section itself just needs internal rhythm. */
    margin: 0;
  }

  .entry-sep {
    border: 0;
    border-top: 1px solid var(--border);
    margin: 1.5rem 0;
  }

  .turn-heading {
    font-size: 1rem;
    margin: 0 0 0.5rem;
    color: var(--text);
  }

  .sub-heading {
    font-size: 0.8rem;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: color-mix(in srgb, var(--text) 70%, transparent);
    margin: 0.85rem 0 0.3rem;
    font-weight: 600;
  }

  .user-prompt {
    margin: 0;
    padding: 0.5rem 0.75rem;
    border-left: 2px solid color-mix(in srgb, var(--accent) 35%, var(--border));
    background: color-mix(in srgb, var(--bg-2) 70%, transparent);
    border-radius: 0 6px 6px 0;
    /* white-space:pre-wrap so the user's paragraphing and line
       breaks survive verbatim into the rendered block. */
    white-space: pre-wrap;
    line-height: 1.45;
    color: var(--text);
    font-size: 0.9rem;
    /* Keep an enormous prompt from dominating the modal; the user
       can still scroll within the block if they need to read the
       whole thing. */
    max-height: 12rem;
    overflow-y: auto;
  }

  .user-prompt.missing {
    border-left-style: dashed;
    font-style: italic;
  }

  /* Italic prose with a floated-left light bulb acting as a drop
     cap. The float pulls subsequent lines to wrap around the bulb's
     right edge - the printed-chapter effect from the brief. The
     surrounding box (padding + tinted background + accent left
     border) mirrors the .user-prompt blockquote above so the two
     halves of an entry read as parallel artifacts: your input on
     one side, the assistant's prior thought on the other. Without
     the container, the italic prose read as a wall of text against
     the modal background; the box gives the eye somewhere to land
     and matches the visual weight of the user-prompt block. The
     line-height is bumped well past body copy so the wrapped
     italic lines have room to breathe. */
  .recall-prose {
    margin: 0;
    padding: 0.65rem 0.85rem;
    border-left: 2px solid color-mix(in srgb, var(--accent) 55%, var(--border));
    background: color-mix(in srgb, var(--accent) 7%, transparent);
    border-radius: 0 6px 6px 0;
    font-style: italic;
    line-height: 1.7;
    color: var(--text);
    /* No white-space:pre-wrap here - the Markdown component owns block
       structure now, so paragraph breaks arrive as real <p> tags.
       Leaving pre-wrap on would render the newlines between those tags
       as visible whitespace and open extra vertical gaps. */
    /* Contain the floated bulb so it can't hang out the bottom of
       the colored box on a short note. flow-root establishes a
       block formatting context without overflow:hidden's clipping
       side-effects, which matters because a very long URL inside
       the note shouldn't get cut off at the box edge. */
    display: flow-root;
  }

  .recall-bulb {
    float: left;
    width: 2.4rem;
    height: 2.4rem;
    margin: 0.1rem 0.6rem 0 0;
    color: color-mix(in srgb, var(--accent) 75%, var(--text));
    /* Soft glow so the bulb reads as illuminated rather than just a
       large icon. The shadow uses currentColor via the same accent
       blend so it tints with the user's accent setting. */
    filter: drop-shadow(0 0 6px color-mix(in srgb, var(--accent) 35%, transparent));
  }

  .entry-meta {
    margin: 0.6rem 0 0;
    font-size: 0.78rem;
  }

  /* "stale" chip on the live cache entry: old enough that the chat-loop
     would suppress it at injection time. Warm hue = soft warning. */
  .stale-badge {
    display: inline-block;
    margin-left: 0.4rem;
    padding: 0 0.35rem;
    border-radius: 0.4rem;
    font-size: 0.7rem;
    text-transform: uppercase;
    letter-spacing: 0.03em;
    color: var(--bg);
    background: var(--warning, #b8860b);
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
