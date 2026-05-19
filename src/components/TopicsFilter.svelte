<script lang="ts">
  /*
   * Topic-filter UI for the conversation drawer. Lives between the
   * tab nav and the conversation list in `Chat.svelte`'s chats tab.
   *
   * Two-piece layout:
   *
   *   1. A `[Topics ▾]` button. Clicking it pops a checkbox popover
   *      anchored below the button - the user picks zero or more
   *      topics from the per-account vocabulary the background
   *      topics agent has assembled. Multi-select with OR semantics:
   *      checking `baking` and `bread` shows threads tagged with
   *      either. A reserved `(untagged)` row at the top filters to
   *      threads the agent hasn't tagged yet OR threads where the
   *      model chose to emit no topics.
   *
   *   2. A pill row below the row showing the active selection.
   *      Each pill carries an X to clear that topic without
   *      reopening the popover. When 2+ are active, a trailing
   *      "Clear all" link appears. The row collapses entirely when
   *      nothing is selected so the drawer doesn't leave dead
   *      whitespace.
   *
   * Closed-state button label stays terse - `Topics ▾` always. The
   * pill row below carries the "what's active" payload so we don't
   * cram a label that has to truncate. A small accent-coloured dot
   * on the button when a filter is active gives the affordance some
   * "I'm engaged" weight at a glance even without scanning the
   * pills.
   *
   * Vocabulary loading: the parent passes the current topics list +
   * a refresh function. We don't fetch from here - the vocabulary
   * lives at the page level in Chat.svelte because it's also needed
   * for query-time validation when the user navigates back from a
   * shared filter URL (a future capability; today the selection is
   * in-memory only).
   *
   * The "(untagged)" sentinel is imported from supabase.ts so the
   * single source of truth lives next to the query builder that
   * special-cases it.
   */
  import { onMount, onDestroy } from 'svelte';
  import { UNTAGGED_TOPIC_SENTINEL } from '$lib/supabase';

  interface Props {
    /**
     * Distinct topic vocabulary - typically `await listUserTopics()`
     * from the parent. Empty array on accounts where the agent
     * hasn't run yet; the dropdown still works (only the
     * "(untagged)" sentinel is offered) so the user can experiment
     * before the worker catches up.
     */
    topics: readonly string[];
    /**
     * Selected topic names - including the `(untagged)` sentinel
     * when active. Two-way bound from the parent so a URL-restore
     * path (future) can seed this without going through the
     * component's mutators.
     */
    selected: string[];
    /**
     * Called when the selection changes. The parent uses this to
     * refetch the three conversation buckets. We don't reach into
     * the data layer ourselves - this stays a presentation
     * component.
     */
    onChange: (next: string[]) => void;
  }
  const { topics, selected, onChange }: Props = $props();

  let open = $state(false);
  let buttonEl: HTMLButtonElement | undefined = $state();
  let popoverEl: HTMLDivElement | undefined = $state();

  const selectedSet = $derived(new Set(selected));
  const hasActive = $derived(selected.length > 0);

  /**
   * Effective option list. The (untagged) sentinel is always
   * offered, even on accounts with zero tagged threads - it lets the
   * user see the "the agent hasn't reached me yet" subset
   * explicitly. Real topics come from the per-user vocabulary,
   * alphabetised at the supabase layer.
   */
  const options = $derived([UNTAGGED_TOPIC_SENTINEL, ...topics]);

  /**
   * Display label for a topic. The sentinel renders as plain
   * "untagged" without the parens - the parens are an internal-only
   * marker that keeps it from colliding with any real topic the
   * model could emit.
   */
  function labelFor(t: string): string {
    return t === UNTAGGED_TOPIC_SENTINEL ? 'untagged' : t;
  }

  function toggle(name: string): void {
    const next = selectedSet.has(name)
      ? selected.filter((t) => t !== name)
      : [...selected, name];
    onChange(next);
  }

  function clearOne(name: string): void {
    onChange(selected.filter((t) => t !== name));
  }

  function clearAll(): void {
    onChange([]);
  }

  /**
   * Click-outside-to-close. Listens at document level only when the
   * popover is open so the listener doesn't sit live for the
   * whole session.
   */
  function onDocClick(e: MouseEvent): void {
    if (!open) return;
    const tgt = e.target;
    if (!(tgt instanceof Node)) return;
    if (popoverEl?.contains(tgt)) return;
    if (buttonEl?.contains(tgt)) return;
    open = false;
  }

  function onKey(e: KeyboardEvent): void {
    if (open && e.key === 'Escape') {
      e.preventDefault();
      open = false;
      buttonEl?.focus();
    }
  }

  onMount(() => {
    document.addEventListener('click', onDocClick);
    document.addEventListener('keydown', onKey);
  });
  onDestroy(() => {
    document.removeEventListener('click', onDocClick);
    document.removeEventListener('keydown', onKey);
  });
</script>

<div class="topics-filter">
  <button
    type="button"
    class="topics-filter-trigger"
    class:active={hasActive}
    aria-haspopup="listbox"
    aria-expanded={open}
    bind:this={buttonEl}
    onclick={() => (open = !open)}
  >
    <span class="topics-filter-label">Topics</span>
    {#if hasActive}
      <span class="topics-filter-dot" aria-hidden="true"></span>
    {/if}
    <span class="topics-filter-caret" aria-hidden="true">
      <!-- 8px chevron, same shape as the archive-toggle chevron but
           pointing down. ASCII-friendly inline SVG so the glyph stays
           crisp across the platform set. -->
      <svg
        width="10"
        height="10"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="2.5"
        stroke-linecap="round"
        stroke-linejoin="round"
        class:flipped={open}
      >
        <polyline points="6 9 12 15 18 9" />
      </svg>
    </span>
  </button>

  {#if open}
    <div
      class="topics-filter-popover"
      role="listbox"
      aria-label="Filter conversations by topic"
      bind:this={popoverEl}
    >
      {#each options as opt (opt)}
        <!-- Whole row is clickable. Hidden input keeps keyboard /
             screen-reader semantics; visible checkbox glyph is the
             label's `::before` so focus rings land cleanly on the
             interactive surface. -->
        <label class="topics-filter-row">
          <input
            type="checkbox"
            checked={selectedSet.has(opt)}
            onchange={() => toggle(opt)}
          />
          <span class="topics-filter-row-text" class:sentinel={opt === UNTAGGED_TOPIC_SENTINEL}>
            {labelFor(opt)}
          </span>
        </label>
      {/each}
      {#if topics.length === 0}
        <!-- Account hasn't accumulated any tags yet. Surface the
             explanation so the empty state doesn't read as broken.
             The (untagged) row above this message is still
             functional - it filters to "the worker hasn't reached
             me yet" which is exactly the state we're describing. -->
        <p class="topics-filter-empty">
          No topics yet - the background agent will start tagging
          conversations shortly.
        </p>
      {/if}
    </div>
  {/if}

  {#if hasActive}
    <div class="topics-filter-pills" role="group" aria-label="Active topic filters">
      {#each selected as t (t)}
        <span class="topics-filter-pill" class:sentinel={t === UNTAGGED_TOPIC_SENTINEL}>
          <span class="topics-filter-pill-text">{labelFor(t)}</span>
          <button
            type="button"
            class="topics-filter-pill-x"
            aria-label="Remove {labelFor(t)} filter"
            title="Remove"
            onclick={() => clearOne(t)}
          >×</button>
        </span>
      {/each}
      {#if selected.length > 1}
        <button
          type="button"
          class="topics-filter-clear-all"
          onclick={clearAll}
        >clear</button>
      {/if}
    </div>
  {/if}
</div>

<style>
  /* The wrapper carries no layout - the parent decides whether the
     button row and pill row share a margin block or sit flush. The
     popover is absolutely positioned against this wrapper so a
     `position: relative` is the only structural commitment here. */
  .topics-filter {
    position: relative;
    display: flex;
    flex-direction: column;
    gap: 0.3rem;
  }

  /* Trigger button shares vibe with the sidebar search input so the
     drawer reads as one calibrated control strip rather than two
     mismatched widgets. `appearance: none` strips Safari's default
     button chrome which otherwise overrides the bg/border. */
  .topics-filter-trigger {
    appearance: none;
    display: flex;
    align-items: center;
    gap: 0.4rem;
    padding: 0.35rem 0.55rem;
    background: var(--bg-2);
    color: var(--text);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    font: inherit;
    font-size: 0.85rem;
    cursor: pointer;
  }
  .topics-filter-trigger:hover {
    background: var(--surface);
  }
  .topics-filter-trigger:focus-visible {
    outline: none;
    border-color: var(--accent);
    box-shadow: 0 0 0 2px var(--accent-weak);
  }
  .topics-filter-trigger.active {
    border-color: var(--accent);
  }
  .topics-filter-label {
    flex: 1;
    text-align: left;
  }
  /* Small accent dot indicating "filter is active." Tucked next to
     the caret so the trigger reads "Topics •▾" at a glance. */
  .topics-filter-dot {
    width: 0.4rem;
    height: 0.4rem;
    border-radius: 50%;
    background: var(--accent);
    flex-shrink: 0;
  }
  .topics-filter-caret {
    display: inline-flex;
    align-items: center;
    color: var(--muted);
  }
  .topics-filter-caret svg {
    transition: transform 0.12s ease;
  }
  .topics-filter-caret svg.flipped {
    transform: rotate(180deg);
  }

  /* Popover anchored below the trigger. Absolute positioning here
     and not a portal because the drawer already establishes a
     stacking context and the popover doesn't need to escape it -
     keeping it in-flow means it scrolls with the drawer if the
     drawer ever grows tall enough to need it (unlikely with the
     current options-count, but the option list is unbounded so
     hedge here). */
  .topics-filter-popover {
    position: absolute;
    top: calc(100% + 0.2rem);
    left: 0;
    right: 0;
    z-index: 5;
    max-height: 16rem;
    overflow-y: auto;
    background: var(--bg);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    box-shadow: 0 2px 8px rgb(0 0 0 / 0.12);
    padding: 0.25rem 0;
  }

  /* One row per option. Whole row is the click target via the
     wrapping <label>. `margin-bottom: 0` undoes the global `label`
     rule (src/styles.css) that adds 0.3rem of bottom margin to every
     label - here that would just spread the rows out for no reason
     since the popover is a tight checkbox list, not a form. */
  .topics-filter-row {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.35rem 0.6rem;
    margin-bottom: 0;
    cursor: pointer;
    font-size: 0.85rem;
    color: var(--text);
  }
  .topics-filter-row:hover {
    background: var(--surface);
  }
  /* Inputs sit native rather than custom-painted - the platform
     checkbox renders correctly across the mobile + desktop targets
     and matches the user's OS-level a11y settings (high contrast,
     etc.). The width / padding / background / border resets undo
     the global `input, textarea, select` rule in src/styles.css
     (which is calibrated for text inputs - width: 100%, generous
     padding, a visible border): on a native checkbox those rules
     stretch the input to fill the row, leave zero space for the
     flex-1 text span, and collapse the label to invisible via
     overflow: hidden. The OS-painted checkbox glyph then sits
     somewhere inside that 100%-wide invisible box, reading as a
     centered checkbox with no text next to it. */
  .topics-filter-row input {
    flex-shrink: 0;
    cursor: pointer;
    width: auto;
    padding: 0;
    background: transparent;
    border: none;
    border-radius: 0;
  }
  .topics-filter-row-text {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    /* Explicit left-align rather than relying on inherited default.
       Without this the italicised (untagged) row was rendering
       centered in the flex slot - the bare label looked out of step
       with the left-aligned real-topic rows above and below it. */
    text-align: left;
  }
  /* The (untagged) sentinel renders with muted styling so it reads
     as a meta-option distinct from the real topic list. The
     `text-align` repetition here is belt-and-suspenders against
     any future rule that lands `text-align` on a competing
     selector at higher specificity - the value matches the base
     row-text rule above. */
  .topics-filter-row-text.sentinel {
    color: var(--muted);
    font-style: italic;
    text-align: left;
  }

  .topics-filter-empty {
    margin: 0.3rem 0.6rem;
    color: var(--muted);
    font-size: 0.8rem;
  }

  /* Pill row. Flex-wraps so long selections push the conversation
     list down rather than overflowing horizontally - the drawer is
     narrow on mobile and an unbounded horizontal row would clip
     the rightmost pills off-screen. */
  .topics-filter-pills {
    display: flex;
    flex-wrap: wrap;
    gap: 0.3rem;
    align-items: center;
  }
  .topics-filter-pill {
    display: inline-flex;
    align-items: center;
    gap: 0.2rem;
    padding: 0.15rem 0.2rem 0.15rem 0.5rem;
    background: var(--accent-weak);
    color: var(--text);
    border-radius: 999px;
    font-size: 0.8rem;
    max-width: 100%;
  }
  .topics-filter-pill.sentinel {
    background: var(--surface);
    color: var(--muted);
    font-style: italic;
  }
  .topics-filter-pill-text {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    min-width: 0;
  }
  /* The X button inside a pill. Slightly larger than the visual
     glyph for a comfortable tap target without inflating the pill
     itself - the surrounding padding absorbs the extra hit area. */
  .topics-filter-pill-x {
    appearance: none;
    background: transparent;
    border: none;
    color: inherit;
    cursor: pointer;
    padding: 0 0.3rem;
    font-size: 1rem;
    line-height: 1;
    border-radius: 999px;
  }
  .topics-filter-pill-x:hover {
    background: rgb(0 0 0 / 0.08);
  }
  /* Match the pill-x hover treatment in dark mode where a plain
     rgba-black overlay would disappear into the bg. */
  :global(:root[data-theme='dark']) .topics-filter-pill-x:hover {
    background: rgb(255 255 255 / 0.1);
  }

  .topics-filter-clear-all {
    appearance: none;
    background: transparent;
    border: none;
    color: var(--muted);
    cursor: pointer;
    font: inherit;
    font-size: 0.78rem;
    padding: 0.1rem 0.3rem;
    text-decoration: underline;
  }
  .topics-filter-clear-all:hover {
    color: var(--text);
  }
</style>
