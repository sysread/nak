<!--
  Second-thoughts panel - the per-message "doubt reflex" verdict.

  Sits as a coda BELOW an assistant message's answer (unlike the
  ReasoningPanel, which sits above): reasoning happens before the
  reply, second thoughts happen after it. Presents as a self-contained
  collapsible - a compact header (disposition glyph + "Second thoughts"
  + a short disposition label + chevron) that expands into the
  reviewer's first-person note in italics.

  The verdict is written server-side by the reviewer agent
  (supabase/functions/venice/agents/second_thoughts.ts) and arrives on
  the messages UPDATE realtime echo a beat after the reply commits, so
  this panel typically materializes shortly AFTER the answer settles -
  the model visibly having an afterthought. Parent (AssistantBody)
  coerces the jsonb and only mounts this when the verdict is non-null.

  Tone keys off the disposition (see src/lib/ui/second-thoughts.ts):
  calm for conviction (the common "no misgivings" case), a soft accent
  for the hedges/reframes, and danger-red for a suspected factual error
  - the loudest because it is the one a reader most wants to catch.

  v1 is display-only: this never alters the answer. A raised doubt just
  shows here, unresolved - the correction round that would adjudicate it
  is phase 2 (docs/dev/in-progress/second-thoughts.md).
-->
<script lang="ts">
  import { cubicOut } from 'svelte/easing';
  import { safeSlide } from '$lib/ui/safe-slide';
  import {
    dispositionAction,
    dispositionHeadline,
    dispositionIcon,
    dispositionLabel,
    dispositionTone,
    displayNote,
    type SecondThoughtsVerdict,
  } from '$lib/ui/second-thoughts';

  interface Props {
    verdict: SecondThoughtsVerdict;
    /**
     * Fired when the user clicks the refinement button ("Let me temper
     * that", etc.). Passed by the parent ONLY for the actionable row -
     * the thread's latest assistant answer. When omitted, no button
     * shows and the panel does not auto-expand (older rows and
     * conviction verdicts just display). See Chat.svelte.
     */
    onRefine?: () => void;
    /** Disables the refinement button while a send is in flight. */
    disabled?: boolean;
  }

  const { verdict, onRefine, disabled = false }: Props = $props();

  const tone = $derived(dispositionTone(verdict.disposition));
  const icon = $derived(dispositionIcon(verdict.disposition));
  const label = $derived(dispositionLabel(verdict.disposition));
  const headline = $derived(dispositionHeadline(verdict.disposition));
  const note = $derived(displayNote(verdict));
  // Button label; null for conviction (and thus no button). The
  // refinement affordance is live only when the parent supplied a
  // handler (the actionable latest row) AND the verdict is a doubt.
  const actionLabel = $derived(dispositionAction(verdict.disposition));
  const refinable = $derived(onRefine != null && actionLabel != null);

  // Expansion: auto-open an actionable doubt (surfacing it is the whole
  // point of inviting the click), collapsed otherwise - UNTIL the user
  // clicks the header, after which their choice latches for the panel's
  // life. Same "manual control wins" shape the reasoning panel uses.
  // Reactive (not a one-time $state from props) so a row that stops
  // being the latest - `refinable` flips false - collapses on its own.
  let userToggled = $state(false);
  let userOpen = $state(false);
  const open = $derived(userToggled ? userOpen : refinable);
</script>

<div class="second-thoughts tone-{tone}" class:open>
  <button
    type="button"
    class="st-header"
    onclick={() => {
      userOpen = !open;
      userToggled = true;
    }}
    aria-expanded={open}
    aria-label={open ? 'Hide second thoughts' : headline}
    title={headline}
  >
    <!-- Disposition glyph. Feather-style; the shape is picked by
         dispositionIcon so the choice stays out of the template. -->
    <svg
      class="st-icon"
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="2"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
    >
      {#if icon === 'check'}
        <polyline points="20 6 9 17 4 12" />
      {:else if icon === 'hedge'}
        <!-- info circle: "a caveat is missing" -->
        <circle cx="12" cy="12" r="10" />
        <line x1="12" y1="16" x2="12" y2="12" />
        <line x1="12" y1="8" x2="12.01" y2="8" />
      {:else if icon === 'reframe'}
        <!-- rotate-ccw: "let me reconsider how I read this" -->
        <polyline points="1 4 1 10 7 10" />
        <path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10" />
      {:else}
        <!-- alert triangle: a suspected mistake -->
        <path
          d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"
        />
        <line x1="12" y1="9" x2="12" y2="13" />
        <line x1="12" y1="17" x2="12.01" y2="17" />
      {/if}
    </svg>
    <span class="st-label">Second thoughts</span>
    <span class="st-disposition">{label}</span>
    <svg
      class="st-chevron"
      width="12"
      height="12"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="2.5"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
    >
      <polyline points="9 6 15 12 9 18" />
    </svg>
  </button>
  {#if open}
    <div
      class="st-expanded"
      transition:safeSlide={{ duration: 200, easing: cubicOut }}
    >
      <blockquote class="st-body">{note}</blockquote>
      {#if refinable}
        <!-- The model owning the goof and asking permission: a click
             runs a refinement turn that APPENDS a fresh answer below.
             Label is the model's own "let me ..." voice, disposition-
             specific (dispositionAction). -->
        <button
          type="button"
          class="st-refine"
          {disabled}
          onclick={() => onRefine?.()}
        >
          {actionLabel}
        </button>
      {/if}
    </div>
  {/if}
</div>

<style>
  /* Coda below the answer body. Top margin only - the answer's own
     spacing sits above. */
  .second-thoughts {
    margin-top: 0.6rem;
  }

  /* The header IS the toggle. Borderless + muted at rest; the tone
     color surfaces on the glyph so a collapsed panel still signals its
     disposition at a glance. */
  .st-header {
    display: inline-flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 0.4rem;
    padding: 0.25rem 0.5rem;
    margin-left: -0.5rem; /* align glyph with the body's left edge */
    background: transparent;
    border: none;
    border-radius: var(--radius);
    color: var(--muted);
    font: inherit;
    font-size: 0.85rem;
    font-weight: 500;
    cursor: pointer;
  }

  .st-header:hover,
  .st-header:focus-visible {
    background: var(--bg-2);
    color: var(--text);
  }

  .st-label {
    flex: 0 0 auto;
    white-space: nowrap;
  }

  /* The disposition word rides in the tone color so "Possible error"
     reads red even when collapsed. */
  .st-disposition {
    flex: 0 0 auto;
    white-space: nowrap;
    font-size: 0.78rem;
    font-weight: 600;
    color: var(--st-tone);
  }

  .st-icon {
    flex: 0 0 auto;
    color: var(--st-tone);
  }

  .st-chevron {
    flex: 0 0 auto;
    transition: transform 200ms var(--ease, ease-out);
  }

  .second-thoughts.open .st-chevron {
    transform: rotate(90deg);
  }

  /* Expanded region: the note, then (on the actionable latest row) the
     refinement button under it. */
  .st-expanded {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 0.5rem;
    margin-top: 0.25rem;
  }

  /* Note body: block-quote treatment with a tone-colored left border,
     italic prose - the assistant's private afterthought voice. */
  .st-body {
    margin: 0;
    padding: 0.35rem 0 0.35rem 0.75rem;
    border-left: 3px solid var(--st-tone);
    color: var(--muted);
    font-style: italic;
    font-size: 0.92rem;
    line-height: 1.45;
    white-space: pre-wrap;
    word-break: break-word;
  }

  /* Refinement button. Tone-colored outline so it reads as the same
     thought's call-to-action; fills on hover. Matches the tone the
     glyph/disposition already carry. */
  .st-refine {
    align-self: flex-start;
    padding: 0.3rem 0.7rem;
    font: inherit;
    font-size: 0.85rem;
    font-weight: 500;
    color: var(--st-tone);
    background: transparent;
    border: 1px solid var(--st-tone);
    border-radius: var(--radius);
    cursor: pointer;
  }

  .st-refine:hover:not(:disabled),
  .st-refine:focus-visible:not(:disabled) {
    color: var(--st-ink);
    background: var(--st-tone);
  }

  .st-refine:disabled {
    opacity: 0.5;
    cursor: default;
  }

  /* Tone -> color. calm folds into the muted body color (an
     unremarkable "reviewed, fine"); unease borrows the theme accent (a
     gentle "worth a look"); alert is danger-red for a suspected
     mistake - the one a reader most wants to notice. */
  .tone-calm {
    --st-tone: var(--muted);
    --st-ink: var(--ink-on-accent);
  }
  .tone-unease {
    --st-tone: var(--accent);
    --st-ink: var(--ink-on-accent);
  }
  .tone-alert {
    --st-tone: var(--danger);
    --st-ink: var(--ink-on-danger);
  }
</style>
