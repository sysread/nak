<script module lang="ts">
  // Per-instance id base so multiple comboboxes on one pane (one per
  // tier) don't collide on the option ids aria-activedescendant points at.
  let comboboxSeq = 0;
</script>

<script lang="ts">
  /*
   * Rich model picker - a search-and-select combobox that replaces the
   * native <select> in Settings -> AI -> Models. Each row aligns the
   * model name on the left, capability badges in a centered middle
   * column, and right-aligned pills for context window and input/output
   * price; the columns line up across every row via CSS subgrid. A fuzzy
   * search box filters the list as the user types.
   *
   * Why custom and not <select>: a native option can only hold a single
   * text run, so the capability/context/price columns and the type-to-
   * filter behaviour aren't expressible there. The trade-off is that we
   * own the keyboard model and the a11y wiring (combobox + listbox roles,
   * aria-activedescendant, arrow/enter/escape) by hand.
   *
   * Conventions mirror TopicsFilter.svelte: open state, button + popover
   * binds, document-level click-outside listener attached only while
   * mounted, component-scoped styles. Decision logic (fuzzy filtering,
   * the row view data) lives in $lib/ui/model-picker as plain functions;
   * this file is the Svelte glue.
   */
  import { onMount, onDestroy, tick } from 'svelte';
  import {
    filterModelOptions,
    capabilityChips,
    formatContextWindow,
    formatPricing,
    type ModelOption,
  } from '$lib/ui/model-picker';

  interface Props {
    /** Full option list (from tierRowView.options); the current pick is guaranteed present. */
    options: ModelOption[];
    /** Currently-selected model id. */
    value: string;
    disabled?: boolean;
    /** Accessible name for the trigger + listbox, e.g. "Model for Smart". */
    ariaLabel: string;
    onSelect: (id: string) => void;
  }
  const { options, value, disabled = false, ariaLabel, onSelect }: Props = $props();

  const uid = `modelcb-${(comboboxSeq += 1)}`;

  let open = $state(false);
  let query = $state('');
  let highlight = $state(0);
  let buttonEl: HTMLButtonElement | undefined = $state();
  let popoverEl: HTMLDivElement | undefined = $state();
  let inputEl: HTMLInputElement | undefined = $state();

  const selected = $derived(options.find((o) => o.id === value) ?? null);
  const triggerLabel = $derived(selected?.label ?? value);
  const filtered = $derived(filterModelOptions(options, query));
  const activeId = $derived(
    filtered.length > 0
      ? `${uid}-opt-${Math.min(highlight, filtered.length - 1)}`
      : undefined
  );

  async function openMenu(): Promise<void> {
    if (disabled) return;
    query = '';
    open = true;
    // Highlight the current selection so Enter-on-open re-picks it rather
    // than jumping to the top of the list.
    const idx = options.findIndex((o) => o.id === value);
    highlight = idx >= 0 ? idx : 0;
    await tick();
    inputEl?.focus();
    scrollHighlightIntoView();
  }

  function closeMenu(refocus = true): void {
    open = false;
    if (refocus) buttonEl?.focus();
  }

  function pick(opt: ModelOption): void {
    onSelect(opt.id);
    closeMenu();
  }

  function scrollHighlightIntoView(): void {
    if (!activeId) return;
    document.getElementById(activeId)?.scrollIntoView({ block: 'nearest' });
  }

  // Reset to the top match on every query change so the best result is
  // pre-selected; the clamp in `activeId` covers a list that just shrank.
  function onQueryInput(): void {
    highlight = 0;
  }

  function onInputKey(e: KeyboardEvent): void {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      highlight = Math.min(highlight + 1, filtered.length - 1);
      scrollHighlightIntoView();
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      highlight = Math.max(highlight - 1, 0);
      scrollHighlightIntoView();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const opt = filtered[highlight];
      if (opt) pick(opt);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      closeMenu();
    }
  }

  function onDocClick(e: MouseEvent): void {
    if (!open) return;
    const tgt = e.target;
    if (!(tgt instanceof Node)) return;
    if (popoverEl?.contains(tgt)) return;
    if (buttonEl?.contains(tgt)) return;
    open = false;
  }

  onMount(() => document.addEventListener('click', onDocClick));
  onDestroy(() => document.removeEventListener('click', onDocClick));
</script>

<div class="model-combobox">
  <button
    type="button"
    class="model-combobox-trigger"
    {disabled}
    aria-haspopup="listbox"
    aria-expanded={open}
    aria-label={ariaLabel}
    bind:this={buttonEl}
    onclick={() => (open ? closeMenu(false) : openMenu())}
  >
    <span class="model-combobox-trigger-label">{triggerLabel}</span>
    <span class="model-combobox-caret" aria-hidden="true">
      <svg
        width="12"
        height="12"
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
    <div class="model-combobox-popover" bind:this={popoverEl}>
      <input
        type="text"
        class="model-combobox-search"
        placeholder="Search models…"
        spellcheck="false"
        autocomplete="off"
        role="combobox"
        aria-controls="{uid}-list"
        aria-expanded="true"
        aria-activedescendant={activeId}
        aria-label="Search models"
        bind:this={inputEl}
        bind:value={query}
        oninput={onQueryInput}
        onkeydown={onInputKey}
      />
      <ul id="{uid}-list" class="model-combobox-list" role="listbox" aria-label={ariaLabel}>
        {#each filtered as opt, i (opt.id)}
          {@const m = opt.model}
          <!-- Rows are pointer targets only; keyboard selection is driven
               from the search input via aria-activedescendant, so the
               click-without-key-handler a11y rule doesn't apply here. -->
          <!-- svelte-ignore a11y_click_events_have_key_events -->
          <li
            id="{uid}-opt-{i}"
            class="model-combobox-option"
            class:highlighted={i === highlight}
            class:selected={opt.id === value}
            role="option"
            aria-selected={opt.id === value}
            onmouseenter={() => (highlight = i)}
            onclick={() => pick(opt)}
          >
            <span class="mco-name" title={opt.label}>
              {opt.label}{#if opt.deprecated}<span class="mco-dep"> (deprecated)</span>{/if}
            </span>
            <span class="mco-badges">
              {#if m}
                {#each capabilityChips(m) as chip (chip.label)}
                  <span class="mco-badge" title={chip.label} aria-hidden="true">{chip.icon}</span>
                {/each}
              {/if}
            </span>
            <span class="mco-pill mco-context">{m ? formatContextWindow(m.contextWindow) : ''}</span>
            <span class="mco-pill mco-price">{m ? formatPricing(m) : ''}</span>
          </li>
        {/each}
      </ul>
      {#if filtered.length === 0}
        <p class="model-combobox-empty">No models match "{query}".</p>
      {/if}
    </div>
  {/if}
</div>

<style>
  .model-combobox {
    position: relative;
    flex: 1 1 auto;
    min-width: 8rem;
  }

  /* Trigger reads like the native select it replaces - same bg/border so
     it sits flush next to the reasoning <select> in the tier row. */
  .model-combobox-trigger {
    appearance: none;
    display: flex;
    align-items: center;
    gap: 0.4rem;
    width: 100%;
    padding: 0.4rem 0.55rem;
    background: var(--bg-2);
    color: var(--text);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    font: inherit;
    cursor: pointer;
  }
  .model-combobox-trigger:hover:not(:disabled) {
    background: var(--surface);
  }
  .model-combobox-trigger:focus-visible {
    outline: none;
    border-color: var(--accent);
    box-shadow: 0 0 0 2px var(--accent-weak);
  }
  .model-combobox-trigger:disabled {
    opacity: 0.55;
    cursor: not-allowed;
  }
  .model-combobox-trigger-label {
    flex: 1;
    text-align: left;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .model-combobox-caret {
    display: inline-flex;
    color: var(--muted);
  }
  .model-combobox-caret svg {
    transition: transform 0.12s ease;
  }
  .model-combobox-caret svg.flipped {
    transform: rotate(180deg);
  }

  /* Popover widens past the trigger to fit the four columns - at least
     the trigger width, growing to its content up to a cap so it doesn't
     run off the pane. Anchored to the trigger's left edge (the combobox
     is the left control in the tier row). */
  .model-combobox-popover {
    position: absolute;
    top: calc(100% + 0.2rem);
    left: 0;
    z-index: 10;
    min-width: 100%;
    width: max-content;
    max-width: min(30rem, 86vw);
    background: var(--bg);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    box-shadow: 0 4px 14px rgb(0 0 0 / 0.16);
    overflow: hidden;
  }

  .model-combobox-search {
    width: 100%;
    box-sizing: border-box;
    padding: 0.5rem 0.6rem;
    border: none;
    border-bottom: 1px solid var(--border);
    border-radius: 0;
    background: var(--bg);
    color: var(--text);
    font: inherit;
  }
  .model-combobox-search:focus-visible {
    outline: none;
  }

  /* The list is the grid; each option spans all four tracks and adopts
     them via subgrid, so the name / badges / context / price columns line
     up across every row regardless of content width. Name flexes (col 1
     is the only non-auto track); badges center in their column; the two
     pills hug the right. */
  .model-combobox-list {
    list-style: none;
    margin: 0;
    padding: 0.25rem 0;
    max-height: 18rem;
    overflow-y: auto;
    display: grid;
    grid-template-columns: minmax(6rem, 1fr) auto auto auto;
    align-items: center;
  }

  .model-combobox-option {
    grid-column: 1 / -1;
    display: grid;
    grid-template-columns: subgrid;
    align-items: center;
    column-gap: 0.6rem;
    padding: 0.4rem 0.6rem;
    cursor: pointer;
    font-size: 0.9rem;
  }
  /* Pointer hover and keyboard highlight share one treatment so the
     active row reads the same however the user is driving. */
  .model-combobox-option.highlighted {
    background: var(--surface);
  }
  .model-combobox-option.selected .mco-name {
    font-weight: 600;
  }

  .mco-name {
    justify-self: start;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .mco-dep {
    color: var(--muted);
    font-style: italic;
  }

  .mco-badges {
    justify-self: center;
    display: inline-flex;
    gap: 0.25rem;
  }
  .mco-badge {
    font-size: 0.85rem;
    line-height: 1;
  }

  /* Context + price share the pill treatment; right-justified in their
     own subgrid columns so the numbers stack vertically across rows. */
  .mco-pill {
    justify-self: end;
    font-size: 0.72rem;
    color: var(--muted);
    background: var(--bg-2);
    border-radius: 999px;
    padding: 0.1rem 0.45rem;
    white-space: nowrap;
  }
  /* Empty pill cells (the off-catalog "current" row) collapse rather than
     drawing an empty capsule. */
  .mco-pill:empty {
    background: none;
    padding: 0;
  }

  .model-combobox-empty {
    margin: 0;
    padding: 0.6rem;
    color: var(--muted);
    font-size: 0.85rem;
    text-align: center;
  }
</style>
