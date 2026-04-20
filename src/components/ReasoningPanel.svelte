<!--
  Reasoning / chain-of-thought panel.

  Sits at the top of an assistant message bubble whenever the turn
  produced `reasoning_content` (OpenAI-compat field; Venice streams it
  on `delta.reasoning_content` for reasoning-capable models). Starts
  collapsed on replay; the parent component can pin it open during
  streaming and flip it closed once the visible answer starts to
  arrive so the user sees the model "think out loud" and then watches
  the thinking tuck away.

  Rendering: dark-grey italic plain text, not markdown. The thinking
  stream is prose the model didn't intend for a user — rendering it
  as markdown tends to produce ugly half-parsed artifacts (a single
  `#` in the middle of a sentence becomes an H1, stray backticks eat
  the tail of the thought). Treating it as a pre-wrap string keeps it
  legible without letting the model accidentally style the transcript.

  Placement contract: the actual toggle button ISN'T here — it lives
  in `.msg-actions` alongside CopyButton. The parent owns `open` and
  the button; this component only renders the header summary + slide-
  down body.
-->
<script lang="ts">
  import { slide } from 'svelte/transition';
  import { cubicOut } from 'svelte/easing';

  interface Props {
    reasoning: string;
    open: boolean;
    /**
     * Transition duration for the slide animation. The parent stream
     * path passes a slightly longer value so the "close after first
     * content delta" moment reads as a deliberate gesture rather than
     * a snap.
     */
    duration?: number;
  }

  const { reasoning, open, duration = 220 }: Props = $props();
</script>

{#if open && reasoning.length > 0}
  <div
    class="reasoning-panel"
    role="region"
    aria-label="Model reasoning"
    transition:slide={{ duration, easing: cubicOut }}
  >
    <div class="reasoning-body">{reasoning}</div>
  </div>
{/if}

<style>
  /* Dark-grey italic treatment per product direction — reasoning
     should read as "what the model was thinking before it answered"
     without competing visually with the final answer below. `muted`
     already carries the dark-grey ramp across both themes. */
  .reasoning-panel {
    margin-bottom: 0.75rem;
    padding: 0.65rem 0.85rem;
    color: var(--muted);
    font-style: italic;
    font-size: 0.92rem;
    line-height: 1.45;
    background: var(--bg-2);
    border: 1px solid var(--border);
    border-radius: var(--radius);
  }

  /* pre-wrap so the streamed linebreaks survive; word-break guards
     against a long un-broken identifier overflowing the bubble on
     narrow viewports (reasoning streams sometimes contain raw
     literals the model is pondering). */
  .reasoning-body {
    white-space: pre-wrap;
    word-break: break-word;
  }
</style>
