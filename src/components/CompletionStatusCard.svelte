<script lang="ts">
  /*
   * CompletionStatusCard - the single "what went wrong / how to fix
   * it" card for the chat transcript tail. The DECISION lives in
   * src/lib/ui/completion-status.ts (which surface wins, what the
   * retry intent is); this component is presentation glue only.
   *
   * Shape (the design contract, in order):
   *   - low-detail title (the card always has one, even when nothing
   *     more specific than "Something went wrong" is knowable)
   *   - by-default-collapsed detail section for backend-provided raw
   *     text (provider envelopes, JSON, thrown messages)
   *   - italicized advice line: what happened, whose fault it is,
   *     what to do next
   *   - retry / discard affordances per the descriptor
   *
   * Mounted by Chat.svelte in the same DOM slot the transcript uses
   * for tail surfaces, so scroll anchoring and follow-bottom behavior
   * are unchanged.
   */
  import type { CompletionStatus } from '$lib/ui/completion-status';

  interface Props {
    status: CompletionStatus;
    /** Retry disabled while a local turn is sending. */
    busy?: boolean;
    onretry: (intent: CompletionStatus['retry']) => void;
    ondismiss?: () => void;
  }

  let { status, busy = false, onretry, ondismiss }: Props = $props();

  let detailOpen = $state(false);
  // Collapse the detail section when a different failure replaces the
  // card (e.g. a retried turn fails with a different error) - stale
  // raw text never lingers expanded.
  $effect(() => {
    void status;
    detailOpen = false;
  });

  function dismiss(): void {
    ondismiss?.();
  }
</script>


<div
  class="msg assistant status-card"
  class:is-error={status.severity === 'error'}
  class:is-note={status.severity !== 'error'}
  role={status.severity === 'error' ? 'alert' : 'note'}
>
  <div class="cs-row">
    {#if status.severity === 'error'}
      <span class="status-icon" aria-hidden="true">!</span>
    {/if}
    <div class="body">
      <div class="title">{status.title}</div>
      <p class="advice">{status.advice}</p>
      {#if status.detail}
        <button
          type="button"
          class="detail-toggle"
          onclick={() => (detailOpen = !detailOpen)}
          aria-expanded={detailOpen}
        >
          {detailOpen ? 'Hide details' : 'Show details'}
        </button>
        {#if detailOpen}
          <pre class="detail-body">{status.detail}</pre>
        {/if}
      {/if}
    </div>
    {#if status.retry}
      <button
        type="button"
        class="secondary icon-btn status-retry"
        class:is-error={status.severity === 'error'}
        onclick={() => onretry(status.retry)}
        disabled={busy}
        aria-label="Retry"
        title="Retry"
      >
        <!-- Feather "refresh-cw", matching the regenerate + composer
             retry buttons. -->
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none"
             stroke="currentColor" stroke-width="2" stroke-linecap="round"
             stroke-linejoin="round" aria-hidden="true">
          <polyline points="23 4 23 10 17 10" />
          <polyline points="1 20 1 14 7 14" />
          <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10" />
          <path d="M20.49 15a9 9 0 0 1-14.85 3.36L1 14" />
        </svg>
      </button>
    {/if}
    {#if status.discard && ondismiss}
      <button
        type="button"
        class="secondary icon-btn status-dismiss"
        onclick={dismiss}
        aria-label="Dismiss"
        title="Dismiss"
      >×</button>
    {/if}
  </div>
</div>

<style>
  /* Visual families shared with the transcript's message cards: the
     error variant keeps the danger tint; the note variant is the
     muted italic family the old msg-incomplete banner used. */
  .status-card.is-error {
    background: color-mix(in srgb, var(--danger) 12%, var(--surface));
    border-color: var(--danger);
    color: var(--danger);
  }
  .status-card.is-note {
    background: var(--surface);
    border-color: var(--border);
    color: var(--muted);
    font-style: italic;
  }
  .cs-row {
    display: flex;
    align-items: flex-start;
    gap: 0.6rem;
  }
  .status-icon {
    flex: 0 0 auto;
    width: 1.25rem;
    height: 1.25rem;
    border-radius: var(--radius-round);
    background: var(--danger);
    color: var(--on-accent);
    display: inline-flex;
    align-items: center;
    justify-content: center;
    font-weight: 700;
    font-size: 0.9rem;
    line-height: 1;
  }
  .body {
    flex: 1;
    min-width: 0;
  }
  .title {
    font-weight: 600;
  }
  .is-note .title {
    font-weight: 600;
  }
  .advice {
    margin: 0.15rem 0 0;
    font-size: 0.9rem;
  }
  .detail-toggle {
    margin-top: 0.35rem;
    font-size: 0.8rem;
    color: inherit;
    opacity: 0.75;
    background: none;
    border: none;
    padding: 0;
    cursor: pointer;
    text-decoration: underline;
    text-underline-offset: 2px;
  }
  .detail-body {
    margin: 0.4rem 0 0;
    padding: 0.5rem 0.7rem;
    font-size: 0.8rem;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    background: color-mix(in srgb, var(--surface) 60%, transparent);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    max-height: 12rem;
    overflow-y: auto;
    color: var(--text);
  }
  .status-retry,
  .status-card .icon-btn {
    flex: 0 0 auto;
  }
  .status-retry.is-error {
    color: var(--danger);
  }
  .status-card.is-note .status-retry {
    color: var(--muted);
  }
</style>
