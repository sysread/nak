<script lang="ts">
  /*
   * Inline card rendered when the model calls `ask_user`. Three states,
   * all driven off the persisted tool-result row content (see
   * src/lib/tools/ask_user.ts for the sentinel/answered shapes):
   *
   *   - pending  : full question card with chip-style options + an
   *                "Other" chip that expands to an inline textarea.
   *                The user picks one and the chat-loop resumes.
   *   - answered : dimmer static card showing Q + the chosen A so the
   *                conversation history reads cleanly on re-read.
   *   - abandoned: muted card with a "(skipped)" tag for refresh /
   *                new-send / sibling-cancel paths.
   *
   * Mobile-first wrap rules - the recurring failure mode in similar
   * UIs is clipping option descriptions behind ellipsis. Every text
   * node here uses `overflow-wrap: anywhere; word-break: break-word;
   * white-space: normal;` and every flex/grid cell carries
   * `min-width: 0` so long descriptions wrap to as many lines as they
   * need rather than truncating. Test at 360px viewport with a
   * deliberately verbose option to verify no horizontal scroll
   * appears.
   *
   * Owns no DB writes. The submit handler delegates to a parent-
   * supplied `onSubmit(answer, via, optionIndex?)` callback so the
   * Chat.svelte layer can manage the persist + resume sequencing.
   */
  import type {
    AskUserOption,
    AskUserAnsweredContent,
    AskUserVia,
  } from '$lib/tools/ask_user';

  interface Props {
    /**
     * Card render state derived from the persisted tool-result row
     * content. Named `mode` rather than `state` to avoid colliding
     * with Svelte 5's `$state` rune name lookup inside this module.
     */
    mode: 'pending' | 'answered' | 'abandoned';
    /** The question text. Always present even in answered/abandoned states. */
    question: string;
    /** Options as the model originally posed them. */
    options: AskUserOption[];
    /** The recorded answer payload; present in answered/abandoned states. */
    answer: AskUserAnsweredContent | null;
    /**
     * Submit handler. Fires when the user picks a chip or submits the
     * "Other" textarea. The parent owns the persist + resume sequence;
     * this component just emits the choice.
     */
    onSubmit: (
      answer: string,
      via: AskUserVia,
      optionIndex?: number
    ) => void | Promise<void>;
    /**
     * True when the parent is processing a submit (writing the row,
     * starting the resume runChatLoop). Disables the chip + textarea
     * affordances and shows a busy state on the submit button.
     */
    busy?: boolean;
  }
  let { mode, question, options, answer, onSubmit, busy = false }: Props = $props();

  /** True iff the user has chosen the "Other" chip and the textarea is showing. */
  let otherActive = $state(false);
  let otherText = $state('');
  let textareaEl: HTMLTextAreaElement | null = $state(null);

  function chooseOption(idx: number, opt: AskUserOption): void {
    if (busy || mode !== 'pending') return;
    void onSubmit(opt.label, 'option', idx);
  }

  function activateOther(): void {
    if (busy || mode !== 'pending') return;
    otherActive = true;
    // Focus on next tick so the textarea exists in the DOM. `tick` isn't
    // imported here; queueMicrotask is enough since Svelte 5 commits
    // before the microtask queue drains for state changes inside event
    // handlers.
    queueMicrotask(() => textareaEl?.focus());
  }

  function submitOther(): void {
    if (busy || mode !== 'pending') return;
    const text = otherText.trim();
    if (!text) return;
    void onSubmit(text, 'free_form');
  }

  function onOtherKeydown(ev: KeyboardEvent): void {
    // Enter submits; Shift+Enter inserts a newline. Matches the main
    // composer's keybindings so the muscle-memory carries over - users
    // type into the textarea and hit Enter as they would in the
    // primary input.
    if (ev.key === 'Enter' && !ev.shiftKey) {
      ev.preventDefault();
      submitOther();
    }
  }

  /**
   * Render the chosen-answer line for the answered state. Prefers the
   * persisted answer text; falls back to the option label looked up by
   * option_index when answer.answer is null but option_index is set
   * (defensive - the live path always writes answer.answer).
   */
  function answeredText(): string {
    if (!answer) return '';
    if (typeof answer.answer === 'string' && answer.answer.length > 0) {
      return answer.answer;
    }
    if (typeof answer.option_index === 'number' && options[answer.option_index]) {
      return options[answer.option_index].label;
    }
    return '';
  }

  function abandonedLabel(via: AskUserVia | undefined): string {
    switch (via) {
      case 'abandoned_on_refresh':
        return '(skipped on reload)';
      case 'abandoned_on_new_send':
        return '(skipped - sent a new message instead)';
      case 'cancelled_by_sibling_ask_user':
        return '(cancelled - another question was asked at the same time)';
      default:
        return '(skipped)';
    }
  }
</script>

<div
  class="ask-user-card"
  class:pending={mode === 'pending'}
  class:answered={mode === 'answered'}
  class:abandoned={mode === 'abandoned'}
>
  <div class="ask-user-question">{question}</div>

  {#if mode === 'pending'}
    <div class="ask-user-options">
      {#each options as opt, idx (idx)}
        <button
          type="button"
          class="ask-user-option"
          disabled={busy}
          onclick={() => chooseOption(idx, opt)}
        >
          <span class="ask-user-option-label">{opt.label}</span>
          <span class="ask-user-option-description">{opt.description}</span>
        </button>
      {/each}
      <button
        type="button"
        class="ask-user-option ask-user-option-other"
        class:active={otherActive}
        disabled={busy}
        onclick={activateOther}
      >
        <span class="ask-user-option-label">Other</span>
        <span class="ask-user-option-description">Type a free-form answer.</span>
      </button>
    </div>

    {#if otherActive}
      <div class="ask-user-other-form">
        <textarea
          bind:this={textareaEl}
          bind:value={otherText}
          class="ask-user-other-textarea"
          rows="3"
          placeholder="Type your answer..."
          disabled={busy}
          onkeydown={onOtherKeydown}
        ></textarea>
        <div class="ask-user-other-actions">
          <button
            type="button"
            class="ask-user-other-cancel"
            disabled={busy}
            onclick={() => {
              otherActive = false;
              otherText = '';
            }}
          >
            Cancel
          </button>
          <button
            type="button"
            class="ask-user-other-submit"
            disabled={busy || otherText.trim().length === 0}
            onclick={submitOther}
          >
            {busy ? 'Sending...' : 'Send'}
          </button>
        </div>
      </div>
    {/if}
  {:else if mode === 'answered'}
    <div class="ask-user-answer-line">
      <span class="ask-user-answer-prefix">Answered:</span>
      <span class="ask-user-answer-text">{answeredText()}</span>
      {#if answer?.via === 'free_form'}
        <span class="ask-user-answer-tag">(free-form)</span>
      {/if}
    </div>
  {:else}
    <div class="ask-user-abandoned-line">
      <span class="ask-user-abandoned-tag">{abandonedLabel(answer?.via)}</span>
    </div>
  {/if}
</div>

<style>
  .ask-user-card {
    /* Lives inside `.msg` already (the parent assistant bubble). The
       `min-width: 0` here mirrors `.msg`'s rule so the card can shrink
       to the bubble's inner width on narrow viewports - without it, a
       wide option chip would push the card past the bubble edge and
       trigger the body-level horizontal-scroll clip. */
    min-width: 0;
    margin-top: 0.5rem;
    padding: 0.75rem;
    border: 1px solid var(--border);
    border-radius: var(--radius);
    background: var(--bg-2);
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }
  .ask-user-card.answered,
  .ask-user-card.abandoned {
    /* De-emphasized history view. Faded background + muted border so
       the eye reads it as past-tense without the active visual weight
       of a live affordance. */
    opacity: 0.7;
  }

  .ask-user-question {
    font-weight: 600;
    line-height: 1.4;
    overflow-wrap: anywhere;
    word-break: break-word;
    white-space: normal;
    min-width: 0;
  }

  .ask-user-options {
    /* Single column on narrow viewports so long descriptions get the
       full card width to wrap into. Grid with auto-fit kicks in on
       wider surfaces but caps each cell at a readable max - past that
       we let the cell breathe rather than stretching into a paragraph.
       `min-width: 0` on the implicit grid-track lets cells shrink to
       fit content (grid's default is `min-content`, which would push
       past the parent on a long word). */
    display: grid;
    grid-template-columns: 1fr;
    gap: 0.4rem;
    min-width: 0;
  }
  @media (min-width: 481px) {
    .ask-user-options {
      grid-template-columns: repeat(auto-fit, minmax(14rem, 1fr));
    }
  }

  .ask-user-option {
    /* Stack label + description vertically so the description can wrap
       to as many lines as it needs without competing with chip
       chrome. Touch-target floor of 44px (Apple HIG) - the chip can
       grow past that when content wraps; this is just the minimum. */
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 0.2rem;
    width: 100%;
    min-width: 0;
    min-height: 44px;
    padding: 0.55rem 0.7rem;
    border: 1px solid var(--border);
    border-radius: var(--radius);
    background: var(--bg);
    color: inherit;
    cursor: pointer;
    text-align: left;
    font: inherit;
    transition: background 100ms ease, border-color 100ms ease;
  }
  .ask-user-option:hover:not(:disabled),
  .ask-user-option:focus-visible:not(:disabled) {
    border-color: var(--accent);
    background: var(--accent-weak);
  }
  .ask-user-option:disabled {
    cursor: not-allowed;
    opacity: 0.6;
  }
  .ask-user-option-other.active {
    border-color: var(--accent);
    background: var(--accent-weak);
  }

  .ask-user-option-label {
    font-weight: 600;
    line-height: 1.3;
    overflow-wrap: anywhere;
    word-break: break-word;
    white-space: normal;
    min-width: 0;
  }
  .ask-user-option-description {
    /* Crucial: NO `text-overflow: ellipsis`, NO `-webkit-line-clamp`.
       The whole point of this card vs. the AskUserQuestion harness
       UI is that descriptions get the full vertical space they need
       on mobile. */
    font-size: 0.9em;
    color: var(--muted);
    line-height: 1.4;
    overflow-wrap: anywhere;
    word-break: break-word;
    white-space: normal;
    min-width: 0;
  }

  .ask-user-other-form {
    display: flex;
    flex-direction: column;
    gap: 0.4rem;
  }
  .ask-user-other-textarea {
    width: 100%;
    min-width: 0;
    box-sizing: border-box;
    padding: 0.5rem 0.6rem;
    border: 1px solid var(--border);
    border-radius: var(--radius);
    background: var(--bg);
    color: inherit;
    font: inherit;
    line-height: 1.4;
    resize: vertical;
  }
  .ask-user-other-textarea:focus-visible {
    outline: none;
    border-color: var(--accent);
  }
  .ask-user-other-actions {
    display: flex;
    justify-content: flex-end;
    gap: 0.4rem;
    flex-wrap: wrap;
  }
  .ask-user-other-cancel,
  .ask-user-other-submit {
    min-height: 36px;
    padding: 0.35rem 0.8rem;
    border-radius: var(--radius);
    border: 1px solid var(--border);
    cursor: pointer;
    font: inherit;
  }
  .ask-user-other-cancel {
    background: transparent;
    color: var(--muted);
  }
  .ask-user-other-submit {
    background: var(--accent);
    color: var(--on-accent, white);
    border-color: var(--accent);
    font-weight: 600;
  }
  .ask-user-other-submit:disabled,
  .ask-user-other-cancel:disabled {
    cursor: not-allowed;
    opacity: 0.5;
  }

  .ask-user-answer-line,
  .ask-user-abandoned-line {
    display: flex;
    flex-wrap: wrap;
    gap: 0.4em;
    align-items: baseline;
    overflow-wrap: anywhere;
    word-break: break-word;
    white-space: normal;
    min-width: 0;
  }
  .ask-user-answer-prefix,
  .ask-user-abandoned-tag {
    color: var(--muted);
    font-size: 0.9em;
  }
  .ask-user-answer-text {
    font-weight: 500;
  }
  .ask-user-answer-tag {
    color: var(--muted);
    font-size: 0.85em;
    font-style: italic;
  }
</style>
