<script module lang="ts">
  // Per-instance id base so option ids that aria-activedescendant points
  // at stay unique if more than one of these ever mounts on a pane.
  let imageSelectSeq = 0;
</script>

<script lang="ts">
  /*
   * Image-model picker - a button + popover listbox that replaces the
   * native <select> in Settings -> AI -> Image generation. Each row
   * left-aligns the model name (with any beta/retiring tags) and right-
   * aligns the per-image price in a pill; the pills line up across rows.
   *
   * Why custom and not <select>: a native <option> can only hold a single
   * text run, so the name-left / price-pill-right layout isn't expressible
   * there. Stripped-down sibling of ModelCombobox.svelte - no fuzzy search
   * box (image models are few), so the keyboard model lives on the
   * focusable listbox itself (arrow/enter/escape + aria-activedescendant)
   * rather than on a search input. Decision logic (option assembly, price
   * formatting) lives in $lib/ui/image-model-picker; this file is glue.
   */
  import { onMount, onDestroy, tick } from 'svelte';
  import type { ImageModelOption } from '$lib/ui/image-model-picker';

  interface Props {
    /** Full option list (buildImageModelOptions); the current pick is guaranteed present. */
    options: ImageModelOption[];
    /** Currently-selected model id. */
    value: string;
    disabled?: boolean;
    /** Accessible name for the trigger + listbox. */
    ariaLabel: string;
    onSelect: (id: string) => void;
  }
  const { options, value, disabled = false, ariaLabel, onSelect }: Props = $props();

  const uid = `imgsel-${(imageSelectSeq += 1)}`;

  let open = $state(false);
  let highlight = $state(0);
  let buttonEl: HTMLButtonElement | undefined = $state();
  let popoverEl: HTMLDivElement | undefined = $state();
  let listEl: HTMLUListElement | undefined = $state();

  const selected = $derived(options.find((o) => o.id === value) ?? null);
  const activeId = $derived(
    options.length > 0 ? `${uid}-opt-${Math.min(highlight, options.length - 1)}` : undefined
  );

  async function openMenu(): Promise<void> {
    if (disabled) return;
    open = true;
    // Highlight the current selection so Enter-on-open re-picks it rather
    // than jumping to the top of the list.
    const idx = options.findIndex((o) => o.id === value);
    highlight = idx >= 0 ? idx : 0;
    await tick();
    listEl?.focus();
    scrollHighlightIntoView();
  }

  function closeMenu(refocus = true): void {
    open = false;
    if (refocus) buttonEl?.focus();
  }

  function pick(opt: ImageModelOption): void {
    onSelect(opt.id);
    closeMenu();
  }

  function scrollHighlightIntoView(): void {
    if (!activeId) return;
    document.getElementById(activeId)?.scrollIntoView({ block: 'nearest' });
  }

  function onListKey(e: KeyboardEvent): void {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      highlight = Math.min(highlight + 1, options.length - 1);
      scrollHighlightIntoView();
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      highlight = Math.max(highlight - 1, 0);
      scrollHighlightIntoView();
    } else if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      const opt = options[highlight];
      if (opt) pick(opt);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      // Stop the event reaching Settings' window Escape handler, which
      // would otherwise close the whole modal. Escape on an open dropdown
      // should only close the dropdown.
      e.stopPropagation();
      closeMenu();
    } else if (e.key === 'Home') {
      e.preventDefault();
      highlight = 0;
      scrollHighlightIntoView();
    } else if (e.key === 'End') {
      e.preventDefault();
      highlight = options.length - 1;
      scrollHighlightIntoView();
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

<div class="image-select">
  <button
    type="button"
    class="image-select-trigger"
    {disabled}
    aria-haspopup="listbox"
    aria-expanded={open}
    aria-label={ariaLabel}
    bind:this={buttonEl}
    onclick={() => (open ? closeMenu(false) : openMenu())}
  >
    <span class="image-select-trigger-main">
      <span class="image-select-trigger-name">{selected?.name ?? value}</span>
      {#each selected?.badges ?? [] as badge (badge)}
        <span class="image-select-badge">{badge}</span>
      {/each}
    </span>
    {#if selected?.priceLabel}
      <span class="image-select-pill">{selected.priceLabel}</span>
    {/if}
    <span class="image-select-caret" aria-hidden="true">
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
    <div class="image-select-popover" bind:this={popoverEl}>
      <ul
        id="{uid}-list"
        class="image-select-list"
        role="listbox"
        tabindex="-1"
        aria-label={ariaLabel}
        aria-activedescendant={activeId}
        bind:this={listEl}
        onkeydown={onListKey}
      >
        {#each options as opt, i (opt.id)}
          <!-- Rows are pointer targets; keyboard selection is driven from
               the listbox via aria-activedescendant, so the click-without-
               key-handler a11y rule doesn't apply to the row itself. -->
          <!-- svelte-ignore a11y_click_events_have_key_events -->
          <li
            id="{uid}-opt-{i}"
            class="image-select-option"
            class:highlighted={i === highlight}
            class:selected={opt.id === value}
            role="option"
            aria-selected={opt.id === value}
            onmouseenter={() => (highlight = i)}
            onclick={() => pick(opt)}
          >
            <span class="image-select-name" title={opt.name}>{opt.name}</span>
            {#each opt.badges as badge (badge)}
              <span class="image-select-badge">{badge}</span>
            {/each}
            {#if opt.priceLabel}
              <span class="image-select-pill">{opt.priceLabel}</span>
            {/if}
          </li>
        {/each}
      </ul>
    </div>
  {/if}
</div>

<style>
  .image-select {
    position: relative;
    flex: 1 1 auto;
    min-width: 8rem;
    max-width: 28rem;
  }

  /* Trigger reads like the native select it replaces - same bg/border. */
  .image-select-trigger {
    appearance: none;
    display: flex;
    align-items: center;
    gap: 0.5rem;
    width: 100%;
    padding: 0.4rem 0.55rem;
    background: var(--bg-2);
    color: var(--text);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    font: inherit;
    cursor: pointer;
  }
  .image-select-trigger:hover:not(:disabled) {
    background: var(--surface);
  }
  .image-select-trigger:focus-visible {
    outline: none;
    border-color: var(--accent);
    box-shadow: var(--focus-ring);
  }
  .image-select-trigger:disabled {
    opacity: 0.55;
    cursor: not-allowed;
  }
  /* Name takes the slack and pushes the price pill + caret to the right. */
  .image-select-trigger-main {
    flex: 1;
    min-width: 0;
    display: inline-flex;
    align-items: center;
    gap: 0.35rem;
    overflow: hidden;
  }
  .image-select-trigger-name {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .image-select-caret {
    display: inline-flex;
    color: var(--muted);
    flex: 0 0 auto;
  }
  .image-select-caret svg {
    transition: transform 0.12s ease;
  }
  .image-select-caret svg.flipped {
    transform: rotate(180deg);
  }

  .image-select-popover {
    position: absolute;
    top: calc(100% + 0.2rem);
    left: 0;
    z-index: 10;
    min-width: 100%;
    width: max-content;
    max-width: min(28rem, 86vw);
    background: var(--bg);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    box-shadow: var(--shadow-menu);
    overflow: hidden;
  }

  /* The list is the grid; each option spans both tracks and adopts them
     via subgrid so the price pills share one right edge across rows.
     name | flex spacer | price. The 1fr spacer pushes the pill right while
     the name stays left-aligned and ellipsizes when long. */
  .image-select-list {
    list-style: none;
    margin: 0;
    padding: 0.25rem 0;
    max-height: 18rem;
    overflow-y: auto;
    display: grid;
    grid-template-columns: minmax(6rem, 1fr) auto;
    align-items: center;
  }
  .image-select-list:focus-visible {
    outline: none;
  }

  .image-select-option {
    grid-column: 1 / -1;
    display: grid;
    grid-template-columns: subgrid;
    align-items: center;
    column-gap: 0.6rem;
    padding: 0.4rem 0.6rem;
    cursor: pointer;
    font-size: 0.9rem;
  }
  /* Pointer hover and keyboard highlight share one treatment. */
  .image-select-option.highlighted {
    background: var(--surface);
  }
  .image-select-option.selected .image-select-name {
    font-weight: 600;
  }

  /* Name sits in track 1, left-aligned; badges trail it inline. The pill
     is placed into the last track so it right-aligns regardless of how
     many badges precede it. */
  .image-select-name {
    grid-column: 1;
    justify-self: start;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .image-select-badge {
    font-size: 0.68rem;
    text-transform: uppercase;
    letter-spacing: 0.03em;
    color: var(--muted);
    border: 1px solid var(--border);
    border-radius: var(--radius-pill);
    padding: 0.02rem 0.35rem;
    white-space: nowrap;
  }

  .image-select-pill {
    grid-column: -1;
    justify-self: end;
    font-size: 0.72rem;
    color: var(--muted);
    background: var(--bg-2);
    border-radius: var(--radius-pill);
    padding: 0.1rem 0.45rem;
    white-space: nowrap;
  }
  /* In the trigger the badge/pill aren't in a grid - keep them from
     shrinking under the name's flex. */
  .image-select-trigger .image-select-badge,
  .image-select-trigger .image-select-pill {
    flex: 0 0 auto;
  }
</style>
