<script lang="ts">
  /*
   * The Groceries main panel - the current shopping list. Rendered in
   * the main content area when the Groceries drawer tab is active;
   * the sidebar next to it (GroceryList.svelte) is the all-items
   * browse that searches and filters the full purchase history. This
   * panel is the working surface: add, edit, check-off, and section
   * management all happen here, full-width (which is what a phone at
   * the store sees once the drawer closes).
   *
   * Three stacked regions:
   *  - the add-to-list input, whose debounced suggestions search the
   *    acquired history (previously bought items) - picking one flips
   *    its row back to needed with section / note / photo intact;
   *  - the needed list: one CARD per store section ("Other" pinned
   *    first as the intake tray, then the user's order), section
   *    name as the card title, items one per row. Empty cards are
   *    hidden by default; a "Show empty sections" toggle opts into
   *    the full store layout (useful when filing items).
   *    Checkboxes render CHECKED (inverted from the recipe view):
   *    the shopper unchecks items as they land in the cart, which
   *    moves them down to...
   *  - the acquired history: greyed-out, collapsed by default (it
   *    grows every trip, forever), windowed with a "show more" tail.
   *
   * Section management (add / rename / delete / drag-reorder) lives
   * behind the "Sections" toggle - keeping those affordances off the
   * shopping cards means a mid-aisle tap can't accidentally rename
   * or reorder the store layout.
   *
   * Composition-only: every UI-behavior decision lives in
   * src/lib/ui/grocery-list.ts.
   */
  import { app } from '$lib/state.svelte';
  import {
    grocery,
    loadGroceries,
    loadMoreAcquired,
  } from '$lib/grocery-store.svelte';
  import { onGroceryChange } from '$lib/grocery-events';
  import type { GroceryItemView } from '$lib/supabase';
  import {
    ACQUIRED_PAGE_SIZE,
    sectionDropEdge,
    GROCERY_SEARCH_DEBOUNCE_MS,
    GROCERY_SUGGESTION_LIMIT,
    OTHER_SECTION_LABEL,
    OTHER_SECTION_VALUE,
    CART_IDLE_MESSAGE,
    acquiredHeaderLabel,
    canCreateGroceryItem,
    isShoppingTripActive,
    shoppingToggleLabel,
    splitAcquiredForTrip,
    filterSectionGroups,
    groupItemsBySection,
    itemQuantityLabel,
    sectionOrderAfterDrag,
  } from '$lib/ui/grocery-list';
  import {
    arrayBufferToBase64,
    maybeDownscaleImage,
    sha256Hex,
  } from '$lib/attachments';
  import Scanner from '../components/Scanner.svelte';
  import { onMount } from 'svelte';

  let addQuery = $state('');
  let suggestions = $state<GroceryItemView[]>([]);
  let suggestBusy = $state(false);
  let suggestAbort: AbortController | null = null;

  let actionError = $state<string | null>(null);

  // Acquired history disclosure - collapsed by default because the
  // history grows unboundedly and the shopper only needs it when
  // hunting for a mistake ("wait, did I already grab that?").
  let acquiredOpen = $state(false);

  // Inline item editor. One item at a time; the draft is component
  // state until Save so typing never hits the network.
  let editingId = $state<string | null>(null);
  let draftName = $state('');
  let draftCount = $state('');
  let draftUnit = $state('');
  let draftNote = $state('');
  let draftSection = $state(OTHER_SECTION_VALUE);
  let draftImageId = $state<string | null>(null);
  let draftImageUrl = $state<string | null>(null);
  let photoBusy = $state(false);
  let saveBusy = $state(false);

  // Empty section cards are hidden by default - the full store
  // layout is mostly noise on a short list. The toggle shows every
  // aisle, which helps when filing items into sections.
  let showEmptySections = $state(false);

  // --- Shopping trip state ---
  // Persisted on profiles.settings.groceryShoppingStartedAt so a trip
  // survives reloads and follows the account. While a trip is active,
  // items unchecked from the list surface in the In-cart section
  // (updated_at >= trip start); the trip expires implicitly at local
  // midnight (isShoppingTripActive compares calendar days), so no
  // cleanup write is needed. `clockTick` re-evaluates activity once a
  // minute so a tab left open crosses midnight without interaction.
  let shoppingStartedAt = $state<string | undefined>(undefined);
  let shoppingBusy = $state(false);
  let clockTick = $state(Date.now());

  $effect(() => {
    const timer = setInterval(() => (clockTick = Date.now()), 60_000);
    return () => clearInterval(timer);
  });

  onMount(() => {
    void (async () => {
      if (!app.supabase) return;
      try {
        const settings = await app.supabase.getSettings();
        shoppingStartedAt = settings.groceryShoppingStartedAt;
      } catch {
        // Non-fatal: the trip button still works (the next toggle
        // writes fresh state); the cart just reads idle until then.
      }
    })();
  });

  const shoppingActive = $derived(
    isShoppingTripActive(shoppingStartedAt, new Date(clockTick))
  );

  function toggleShopping(): void {
    const supabase = app.supabase;
    if (!supabase || shoppingBusy) return;
    shoppingBusy = true;
    const next = shoppingActive ? undefined : new Date().toISOString();
    void (async () => {
      try {
        const settings = await supabase.updateSettings({
          groceryShoppingStartedAt: next,
        });
        shoppingStartedAt = settings.groceryShoppingStartedAt;
        clockTick = Date.now();
        actionError = null;
      } catch (err) {
        actionError = errMsg(err);
      } finally {
        shoppingBusy = false;
      }
    })();
  }

  // Item drag-to-file: dragging a needed row's handle onto a section
  // card saves the item into that section (which also records the
  // name's sticky section preference server-side). Native HTML5 DnD
  // for pointers plus the long-press touch path below, same pair as
  // the section manager and Settings' custom-prompts reorder.
  let dragItemId = $state<string | null>(null);
  let dragOverSection = $state<string | null | undefined>(undefined);

  // --- Touch long-press drag (mobile) ---
  // Native HTML5 DnD never fires on touch, so phones get the same
  // parallel path the Settings custom-prompts reorder uses: press and
  // hold the grip for LONG_PRESS_MS and the row "lifts" (haptic tick
  // where supported), then sliding the finger marks the drop target
  // and lifting drops there. A finger that travels more than
  // TOUCH_SLOP before the timer fires is a scroll attempt and cancels
  // the press. Touch events all dispatch to the touchstart target
  // (the grip), so the element under the finger is resolved via
  // elementFromPoint against data attributes on the targets.
  const LONG_PRESS_MS = 1000;
  const TOUCH_SLOP = 10; // px of travel that still counts as "held still"
  let longPressTimer: ReturnType<typeof setTimeout> | null = null;
  let touchStartY = 0;

  function clearLongPress(): void {
    if (longPressTimer !== null) {
      clearTimeout(longPressTimer);
      longPressTimer = null;
    }
  }

  function onItemTouchStart(id: string, e: TouchEvent): void {
    const t = e.touches[0];
    if (!t) return;
    touchStartY = t.clientY;
    clearLongPress();
    longPressTimer = setTimeout(() => {
      longPressTimer = null;
      dragItemId = id;
      navigator.vibrate?.(15);
    }, LONG_PRESS_MS);
  }

  function onItemTouchMove(e: TouchEvent): void {
    const t = e.touches[0];
    if (!t) return;
    if (dragItemId === null) {
      if (Math.abs(t.clientY - touchStartY) > TOUCH_SLOP) clearLongPress();
      return;
    }
    e.preventDefault();
    const el = document.elementFromPoint(t.clientX, t.clientY);
    const card = el?.closest<HTMLElement>('.grocery-section-card[data-section-key]');
    if (card) {
      const key = card.dataset.sectionKey ?? '';
      dragOverSection = key === '' ? null : key;
    }
  }

  function onItemTouchEnd(): void {
    clearLongPress();
    if (dragItemId === null) return;
    if (dragOverSection !== undefined) dropItemOnSection(dragOverSection);
    else {
      dragItemId = null;
      dragOverSection = undefined;
    }
  }

  function dropItemOnSection(sectionId: string | null): void {
    const supabase = app.supabase;
    const itemId = dragItemId;
    dragItemId = null;
    dragOverSection = undefined;
    if (!supabase || !itemId) return;
    const current = grocery.needed.find((i) => i.id === itemId);
    if (!current || current.section_id === sectionId) return;
    void mutate(() => supabase.updateGroceryItem(itemId, { section_id: sectionId }));
  }

  // Section management mode.
  let manageSections = $state(false);
  let newSectionName = $state('');
  let renamingSectionId = $state<string | null>(null);
  let renameDraft = $state('');
  let dragSectionId = $state<string | null>(null);
  // Insertion-line indicator for section reorder: which row the drag
  // hovers and which edge the dragged section would land on.
  let sectionDropHint = $state<{ id: string; edge: 'top' | 'bottom' } | null>(null);

  // Refetch on every mount, NOT gated on grocery.loaded. The store is
  // module-level and outlives this panel, and grocery writes made
  // while the tab is closed (a Cookbook ingredient checkbox, the
  // recipe-edit invalidation trigger) fire the change event with no
  // grocery listener mounted to hear it - a loaded-gate would then
  // render that stale store forever. The stale list still paints
  // instantly; this refetch overwrites it. Concurrent-safe with the
  // onGroceryChange refetch below (a later result overwrites).
  onMount(() => {
    if (app.supabase) void loadGroceries(app.supabase);
  });

  // Server-originated writes (a Cookbook checkbox click, the
  // recipe-edit invalidation trigger, another device) arrive through
  // the grocery relay; refetch idempotently.
  $effect(() => {
    return onGroceryChange(() => {
      if (app.supabase) void loadGroceries(app.supabase);
    });
  });

  // Debounced suggestion search over the acquired history.
  $effect(() => {
    const q = addQuery.trim();
    if (q.length === 0) {
      suggestions = [];
      suggestBusy = false;
      if (suggestAbort) suggestAbort.abort();
      suggestAbort = null;
      return;
    }
    if (!app.supabase) return;
    const timer = setTimeout(() => {
      void runSuggestionSearch(q);
    }, GROCERY_SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  });

  async function runSuggestionSearch(q: string): Promise<void> {
    if (!app.supabase) return;
    if (suggestAbort) suggestAbort.abort();
    const ctl = new AbortController();
    suggestAbort = ctl;
    suggestBusy = true;
    try {
      const hits = await app.supabase.searchAcquiredGroceryItems(
        q,
        GROCERY_SUGGESTION_LIMIT
      );
      if (ctl.signal.aborted) return;
      suggestions = hits;
    } catch (err) {
      if (!ctl.signal.aborted) {
        actionError = err instanceof Error ? err.message : String(err);
      }
    } finally {
      if (suggestAbort === ctl) {
        suggestAbort = null;
        suggestBusy = false;
      }
    }
  }

  const errMsg = (err: unknown): string =>
    err instanceof Error ? err.message : String(err);

  /**
   * Run a mutation then refresh the whole store. Every write funnels
   * through here so error handling and the refetch stay uniform.
   */
  async function mutate(fn: () => Promise<unknown>): Promise<boolean> {
    if (!app.supabase) return false;
    try {
      await fn();
      actionError = null;
      await loadGroceries(app.supabase);
      return true;
    } catch (err) {
      actionError = errMsg(err);
      return false;
    }
  }

  function addNewItem(): void {
    const supabase = app.supabase;
    const name = addQuery.trim();
    if (!supabase || name.length === 0) return;
    void mutate(() => supabase.createGroceryItem({ name })).then((ok) => {
      if (ok) addQuery = '';
    });
  }

  function reuseSuggestion(item: GroceryItemView): void {
    const supabase = app.supabase;
    if (!supabase) return;
    void mutate(() => supabase.setGroceryItemNeeded(item.id, true)).then((ok) => {
      if (ok) addQuery = '';
    });
  }

  function setNeeded(item: GroceryItemView, needed: boolean): void {
    const supabase = app.supabase;
    if (!supabase) return;
    void mutate(() => supabase.setGroceryItemNeeded(item.id, needed));
  }

  function startEdit(item: GroceryItemView): void {
    editingId = item.id;
    draftName = item.name;
    draftCount = item.count ?? '';
    draftUnit = item.unit ?? '';
    draftNote = item.note ?? '';
    draftSection = item.section_id ?? OTHER_SECTION_VALUE;
    draftImageId = item.image_id;
    draftImageUrl = item.image_url;
  }

  function cancelEdit(): void {
    editingId = null;
  }

  function saveEdit(): void {
    const supabase = app.supabase;
    const id = editingId;
    if (!supabase || !id || saveBusy) return;
    saveBusy = true;
    void mutate(() =>
      supabase.updateGroceryItem(id, {
        name: draftName,
        count: draftCount.trim() || null,
        unit: draftUnit.trim() || null,
        note: draftNote.trim() || null,
        section_id: draftSection === OTHER_SECTION_VALUE ? null : draftSection,
        image_id: draftImageId,
      })
    ).then((ok) => {
      saveBusy = false;
      if (ok) editingId = null;
    });
  }

  function deleteItem(item: GroceryItemView): void {
    const supabase = app.supabase;
    if (!supabase) return;
    void mutate(() => supabase.deleteGroceryItem(item.id)).then((ok) => {
      if (ok && editingId === item.id) editingId = null;
    });
  }

  async function onPickPhoto(event: Event): Promise<void> {
    const supabase = app.supabase;
    const input = event.currentTarget as HTMLInputElement;
    const file = input.files?.[0];
    if (!supabase || !file) return;
    photoBusy = true;
    try {
      const downscaled = await maybeDownscaleImage(file);
      if (!downscaled) {
        actionError = `${file.name}: could not decode image`;
        return;
      }
      const buffer = await downscaled.arrayBuffer();
      const base64 = arrayBufferToBase64(buffer);
      const sha = await sha256Hex(buffer);
      draftImageId = await supabase.upsertGroceryItemImage(
        sha,
        downscaled.type,
        downscaled.size,
        base64
      );
      // Bytes are in memory - preview from a data: URI, no signed-URL
      // round trip for a just-picked photo.
      draftImageUrl = `data:${downscaled.type};base64,${base64}`;
      actionError = null;
    } catch (err) {
      actionError = `${file.name}: ${errMsg(err)}`;
    } finally {
      photoBusy = false;
      // Clear the value so re-picking the same file re-fires change.
      input.value = '';
    }
  }

  function removePhoto(): void {
    // Draft-only: the image row + object stay in the bucket until the
    // GC sweep reclaims them once no item references the image.
    draftImageId = null;
    draftImageUrl = null;
  }

  // --- section management ---

  function addSection(): void {
    const supabase = app.supabase;
    const name = newSectionName.trim();
    if (!supabase || name.length === 0) return;
    void mutate(() => supabase.createGrocerySection(name)).then((ok) => {
      if (ok) newSectionName = '';
    });
  }

  function startRenameSection(id: string, current: string): void {
    renamingSectionId = id;
    renameDraft = current;
  }

  function commitRenameSection(): void {
    const supabase = app.supabase;
    const id = renamingSectionId;
    const name = renameDraft.trim();
    if (!supabase || !id || name.length === 0) {
      renamingSectionId = null;
      return;
    }
    void mutate(() => supabase.renameGrocerySection(id, name)).then(() => {
      renamingSectionId = null;
    });
  }

  function deleteSection(id: string): void {
    const supabase = app.supabase;
    if (!supabase) return;
    void mutate(() => supabase.deleteGrocerySection(id));
  }

  // Touch twin of the item long-press above, for the section
  // manager's reorder rows. Shares the timer/slop plumbing; the
  // active-drag state rides the same dragSectionId/sectionDropHint
  // the mouse path uses, so the insertion line renders identically.
  function onSectionTouchStart(id: string, e: TouchEvent): void {
    const t = e.touches[0];
    if (!t) return;
    touchStartY = t.clientY;
    clearLongPress();
    longPressTimer = setTimeout(() => {
      longPressTimer = null;
      dragSectionId = id;
      navigator.vibrate?.(15);
    }, LONG_PRESS_MS);
  }

  function onSectionTouchMove(e: TouchEvent): void {
    const t = e.touches[0];
    if (!t) return;
    if (dragSectionId === null) {
      if (Math.abs(t.clientY - touchStartY) > TOUCH_SLOP) clearLongPress();
      return;
    }
    e.preventDefault();
    const el = document.elementFromPoint(t.clientX, t.clientY);
    // A section drag can hover either surface: the manager's rows or
    // the list's cards (data-section-key '' is the Other card, which
    // is not a reorder target).
    const row = el?.closest<HTMLElement>('.grocery-section-row[data-section-id]');
    let overId = row?.dataset.sectionId;
    if (!overId) {
      const card = el?.closest<HTMLElement>('.grocery-section-card[data-section-key]');
      const key = card?.dataset.sectionKey;
      if (key) overId = key;
    }
    if (overId && overId !== dragSectionId) {
      const edge = sectionDropEdge(
        grocery.sections.map((x) => x.id),
        dragSectionId,
        overId
      );
      sectionDropHint = edge ? { id: overId, edge } : null;
    }
  }

  function onSectionTouchEnd(): void {
    clearLongPress();
    if (dragSectionId === null) return;
    const targetId = sectionDropHint?.id;
    sectionDropHint = null;
    if (targetId) dropSection(targetId);
    else dragSectionId = null;
  }

  function dropSection(targetId: string): void {
    const supabase = app.supabase;
    const fromId = dragSectionId;
    dragSectionId = null;
    if (!supabase || !fromId) return;
    const next = sectionOrderAfterDrag(
      grocery.sections.map((s) => s.id),
      fromId,
      targetId
    );
    if (!next) return;
    void mutate(() => supabase.reorderGrocerySections(next));
  }

  const acquiredSplit = $derived(
    splitAcquiredForTrip(grocery.acquired, shoppingStartedAt, shoppingActive)
  );
  const neededGroups = $derived(
    filterSectionGroups(
      groupItemsBySection(grocery.sections, grocery.needed),
      showEmptySections
    )
  );
  const canCreate = $derived(canCreateGroceryItem(addQuery, suggestions, grocery.needed));
  const suggesting = $derived(addQuery.trim().length > 0);
</script>

<div class="groceries-panel">
<div class="groceries-panel-inner">
  <div class="grocery-controls">
    <input
      type="search"
      name="grocery-add"
      class="sidebar-search-input"
      placeholder="Add to list"
      aria-label="Add to grocery list"
      bind:value={addQuery}
      autocomplete="off"
      spellcheck="false"
      onkeydown={(e) => {
        if (e.key === 'Enter' && canCreate) addNewItem();
      }}
    />
    <button
      type="button"
      class="grocery-sections-toggle"
      class:active={manageSections}
      aria-pressed={manageSections}
      title="Manage sections"
      onclick={() => (manageSections = !manageSections)}
    >Sections</button>
    <button
      type="button"
      class="grocery-sections-toggle grocery-shopping-toggle"
      class:active={shoppingActive}
      aria-pressed={shoppingActive}
      disabled={shoppingBusy}
      title={shoppingActive
        ? 'End the shopping trip (also ends automatically at midnight)'
        : 'Start a shopping trip - items you mark off go to the In-cart section'}
      onclick={toggleShopping}
    >{shoppingToggleLabel(shoppingActive)}</button>
  </div>

  <!-- Same toggle idiom as the sidebar's show-recipe-ingredients
       checkbox: explicit input sizing so global form-control styling
       can't stretch it away from its label. -->
  <label class="grocery-empty-toggle">
    <input type="checkbox" bind:checked={showEmptySections} />
    Show empty sections
  </label>

  {#if actionError}
    <p class="error grocery-error">{actionError}</p>
  {/if}

  {#if suggesting}
    <!-- Suggestion dropdown: previously bought items (needed = false)
         matching the query, plus a create action for a new name.
         Picking a suggestion reuses its row (section / note / photo
         intact) instead of inserting a duplicate. -->
    <div class="grocery-suggestions" role="listbox" aria-label="Item suggestions">
      {#if suggestBusy}
        <div class="search-status"><Scanner label="Searching items" size={0.8} /></div>
      {:else}
        {#each suggestions as s (s.id)}
          <button
            type="button"
            class="grocery-suggestion"
            role="option"
            aria-selected="false"
            onclick={() => reuseSuggestion(s)}
          >
            <span class="grocery-item-name">{s.name}</span>
            {#if itemQuantityLabel(s)}
              <span class="grocery-item-qty">{itemQuantityLabel(s)}</span>
            {/if}
          </button>
        {/each}
        {#if canCreate}
          <button type="button" class="grocery-suggestion grocery-suggestion-new" onclick={addNewItem}>
            Add "{addQuery.trim()}"
          </button>
        {:else if suggestions.length === 0}
          <p class="subtle grocery-suggestion-hint">Already on the list.</p>
        {/if}
      {/if}
    </div>
  {/if}

  {#if manageSections}
    <!-- Section manager: drag handles for reorder, inline rename,
         delete. "Other" is not a row here - it's the permanent
         null-section bucket and has no affordances by design. -->
    <div class="grocery-section-manager">
      <!-- Other leads, matching the card order in the list below. Not
           a row (it is the null-section pseudo-bucket), so it carries
           no drag/rename/delete affordances. -->
      <div class="grocery-section-row grocery-section-other">
        <span class="grocery-drag-handle grocery-drag-handle-disabled" aria-hidden="true">&#8942;&#8942;</span>
        <span class="grocery-section-name-static">{OTHER_SECTION_LABEL}</span>
      </div>
      {#each grocery.sections as s (s.id)}
        <div
          class="grocery-section-row"
          data-section-id={s.id}
          class:dragging={dragSectionId === s.id}
          class:drop-before={sectionDropHint?.id === s.id && sectionDropHint.edge === 'top'}
          class:drop-after={sectionDropHint?.id === s.id && sectionDropHint.edge === 'bottom'}
          draggable="true"
          role="listitem"
          ondragstart={(e) => {
            dragSectionId = s.id;
            if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move';
          }}
          ondragover={(e) => {
            e.preventDefault();
            if (!dragSectionId) return;
            const edge = sectionDropEdge(
              grocery.sections.map((x) => x.id),
              dragSectionId,
              s.id
            );
            sectionDropHint = edge ? { id: s.id, edge } : null;
          }}
          ondragleave={() => {
            if (sectionDropHint?.id === s.id) sectionDropHint = null;
          }}
          ondrop={(e) => {
            e.preventDefault();
            sectionDropHint = null;
            dropSection(s.id);
          }}
          ondragend={() => {
            dragSectionId = null;
            sectionDropHint = null;
          }}
        >
          <span
            class="grocery-drag-handle"
            aria-hidden="true"
            ontouchstart={(e) => onSectionTouchStart(s.id, e)}
            ontouchmove={onSectionTouchMove}
            ontouchend={onSectionTouchEnd}
          >&#8942;&#8942;</span>
          {#if renamingSectionId === s.id}
            <!-- svelte-ignore a11y_autofocus -->
            <input
              class="grocery-section-rename"
              bind:value={renameDraft}
              autofocus
              onkeydown={(e) => {
                if (e.key === 'Enter') commitRenameSection();
                if (e.key === 'Escape') renamingSectionId = null;
              }}
              onblur={commitRenameSection}
            />
          {:else}
            <button
              type="button"
              class="grocery-section-name"
              title="Rename section"
              onclick={() => startRenameSection(s.id, s.name)}
            >{s.name}</button>
          {/if}
          <button
            type="button"
            class="grocery-icon-btn"
            title="Delete section (items move to Other)"
            aria-label={`Delete section ${s.name}`}
            onclick={() => deleteSection(s.id)}
          >&times;</button>
        </div>
      {/each}
      <div class="grocery-section-add">
        <input
          class="grocery-section-add-input"
          placeholder="New section"
          aria-label="New section name"
          bind:value={newSectionName}
          onkeydown={(e) => {
            if (e.key === 'Enter') addSection();
          }}
        />
        <button
          type="button"
          class="grocery-small-btn"
          disabled={newSectionName.trim().length === 0}
          onclick={addSection}
        >Add</button>
      </div>
    </div>
  {/if}

  {#snippet itemRow(item: GroceryItemView, needed: boolean)}
    <div
      class="grocery-item-row"
      class:acquired={!needed}
      class:lifted={dragItemId === item.id}
    >
      {#if needed}
        <!-- Drag-to-file handle. Only the handle is draggable so the
             row's tap targets (checkbox, edit) keep their gestures. -->
        <span
          class="grocery-drag-handle"
          draggable="true"
          role="button"
          tabindex="-1"
          aria-label={`Drag ${item.name} to a section`}
          ondragstart={(e) => {
            dragItemId = item.id;
            if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move';
          }}
          ondragend={() => {
            dragItemId = null;
            dragOverSection = undefined;
          }}
          ontouchstart={(e) => onItemTouchStart(item.id, e)}
          ontouchmove={onItemTouchMove}
          ontouchend={onItemTouchEnd}
        >&#8942;&#8942;</span>
      {/if}
      <label class="grocery-check-label">
        <!-- Inverted from the recipe view on purpose: needed items
             render CHECKED and the shopper unchecks as they buy. -->
        <input
          type="checkbox"
          class="grocery-check"
          checked={needed}
          aria-label={needed ? `Mark ${item.name} as acquired` : `Put ${item.name} back on the list`}
          onchange={() => setNeeded(item, !needed)}
        />
      </label>
      <!-- The whole row body is a second checkbox target - at the
           store the tap is a thumb on a phone, and the tiny box
           alone is a miss magnet. Editing moved to the pencil button
           at the row's right edge. -->
      <button
        type="button"
        class="grocery-item-body"
        title={needed ? 'Mark as acquired' : 'Put back on the list'}
        onclick={() => setNeeded(item, !needed)}
      >
        <span class="grocery-item-line">
          <span class="grocery-item-name">{item.name}</span>
          {#if itemQuantityLabel(item)}
            <span class="grocery-item-qty">{itemQuantityLabel(item)}</span>
          {/if}
        </span>
        {#if item.note || item.recipe_title}
          <span class="grocery-item-meta">
            {#if item.note}{item.note}{/if}
            {#if item.note && item.recipe_title && item.note !== `For ${item.recipe_title}`}
              &middot;
            {/if}
            {#if item.recipe_title && item.note !== `For ${item.recipe_title}`}
              {item.recipe_title}
            {/if}
          </span>
        {/if}
      </button>
      {#if item.image_url}
        <img class="grocery-item-thumb" src={item.image_url} alt={item.name} loading="lazy" />
      {/if}
      <button
        type="button"
        class="grocery-icon-btn grocery-edit-btn"
        class:active={editingId === item.id}
        title="Edit item"
        aria-label={`Edit ${item.name}`}
        aria-expanded={editingId === item.id}
        onclick={() => (editingId === item.id ? cancelEdit() : startEdit(item))}
      >
        <!-- Stroked SVG rather than a text glyph: the U+270E pencil
             entity rendered as an unreadable blob at row size, while
             a controlled 2px stroke stays crisp at 13px. Same
             feather-style idiom as the sidebar's cart / thumbs-up
             marks. -->
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none"
             stroke="currentColor" stroke-width="2" stroke-linecap="round"
             stroke-linejoin="round" aria-hidden="true">
          <path d="M17 3a2.83 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z" />
        </svg>
      </button>
    </div>
    {#if editingId === item.id}
      <div class="grocery-item-edit">
        <input class="grocery-edit-input" placeholder="Name" aria-label="Item name" bind:value={draftName} />
        <div class="grocery-edit-pair">
          <input class="grocery-edit-input" placeholder="Count" aria-label="Count" bind:value={draftCount} />
          <input class="grocery-edit-input" placeholder="Unit" aria-label="Unit" bind:value={draftUnit} />
        </div>
        <input class="grocery-edit-input" placeholder="Note" aria-label="Note" bind:value={draftNote} />
        <select class="grocery-edit-input" aria-label="Section" bind:value={draftSection}>
          {#each grocery.sections as s (s.id)}
            <option value={s.id}>{s.name}</option>
          {/each}
          <option value={OTHER_SECTION_VALUE}>{OTHER_SECTION_LABEL}</option>
        </select>
        <div class="grocery-edit-photo">
          {#if draftImageUrl}
            <img class="grocery-edit-thumb" src={draftImageUrl} alt={draftName || 'item'} />
            <button type="button" class="grocery-small-btn" onclick={removePhoto}>Remove photo</button>
          {:else}
            <label class="grocery-small-btn grocery-photo-pick">
              {photoBusy ? 'Uploading...' : 'Add photo'}
              <input
                type="file"
                accept="image/*"
                class="sr-only"
                disabled={photoBusy}
                onchange={onPickPhoto}
              />
            </label>
          {/if}
        </div>
        <div class="grocery-edit-actions">
          <button
            type="button"
            class="grocery-small-btn grocery-save-btn"
            disabled={saveBusy || draftName.trim().length === 0}
            onclick={saveEdit}
          >Save</button>
          <button type="button" class="grocery-small-btn" onclick={cancelEdit}>Cancel</button>
          <button
            type="button"
            class="grocery-small-btn grocery-delete-btn"
            onclick={() => deleteItem(item)}
          >Delete</button>
        </div>
      </div>
    {/if}
  {/snippet}

  {#if grocery.loading && !grocery.loaded}
    <div class="search-status"><Scanner label="Loading grocery list" size={0.9} /></div>
  {:else if grocery.error && !grocery.loaded}
    <p class="error grocery-error">{grocery.error}</p>
  {:else}
    {#if grocery.needed.length === 0}
      <p class="subtle grocery-empty">
        Nothing on the list. Add items above, or check ingredients off
        an upcoming or favorite recipe.
      </p>
    {/if}
    <!-- One card per section: Other pinned FIRST (the intake tray -
         fresh adds and recipe checkboxes land there until filed),
         then the user's sections in their order. Empty cards are
         hidden unless the "Show empty sections" toggle above opts
         into the full store layout. -->
    {#each neededGroups as group (group.id ?? '__other')}
      <!-- svelte-ignore a11y_no_static_element_interactions -->
      <!-- Drag-and-drop is a pointer shortcut; the keyboard path to
           the same write is the item editor's section picker. -->
      <section
        class="grocery-section-card"
        data-section-key={group.id ?? ''}
        class:drop-target={dragItemId !== null && dragOverSection === group.id}
        class:lifted={dragSectionId !== null && dragSectionId === group.id}
        class:drop-before={sectionDropHint?.id === group.id && sectionDropHint.edge === 'top'}
        class:drop-after={sectionDropHint?.id === group.id && sectionDropHint.edge === 'bottom'}
        ondragover={(e) => {
          if (dragItemId !== null) {
            e.preventDefault();
            dragOverSection = group.id;
            return;
          }
          // Card-level section reorder: only real sections are
          // targets (the Other card has no order slot).
          if (dragSectionId !== null && group.id !== null) {
            e.preventDefault();
            const edge = sectionDropEdge(
              grocery.sections.map((x) => x.id),
              dragSectionId,
              group.id
            );
            sectionDropHint = edge ? { id: group.id, edge } : null;
          }
        }}
        ondragleave={() => {
          if (dragOverSection === group.id) dragOverSection = undefined;
          if (sectionDropHint?.id === group.id) sectionDropHint = null;
        }}
        ondrop={(e) => {
          e.preventDefault();
          if (dragItemId !== null) {
            dropItemOnSection(group.id);
          } else if (dragSectionId !== null && group.id !== null) {
            sectionDropHint = null;
            dropSection(group.id);
          }
        }}
      >
        <h3 class="grocery-section-card-title">
          {#if showEmptySections && group.id !== null}
            <!-- Whole-section reorder handle, shown only in the
                 full-layout mode ("Show empty sections" on): with
                 cards hidden, a drag past an invisible section would
                 silently leapfrog it, so the two modes are coupled -
                 the toggle IS the "arrange my store" mode. Same
                 pointer + long-press pair as every other grip. -->
            <span
              class="grocery-drag-handle grocery-card-handle"
              draggable="true"
              role="button"
              tabindex="-1"
              aria-label={`Drag to reorder ${group.name}`}
              ondragstart={(e) => {
                dragSectionId = group.id;
                if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move';
              }}
              ondragend={() => {
                dragSectionId = null;
                sectionDropHint = null;
              }}
              ontouchstart={(e) => group.id !== null && onSectionTouchStart(group.id, e)}
              ontouchmove={onSectionTouchMove}
              ontouchend={onSectionTouchEnd}
            >&#8942;&#8942;</span>
          {/if}
          {group.name}
        </h3>
        {#if group.items.length === 0}
          <p class="subtle grocery-section-card-empty">No items</p>
        {:else}
          {#each group.items as item (item.id)}
            {@render itemRow(item, true)}
          {/each}
        {/if}
      </section>
    {/each}

    <!-- In-cart section: the current trip's checked-off items. Only
         populated while a shopping trip is active - the trip-start
         timestamp is what distinguishes "just put it in the cart"
         from the years of acquired history below. Idle, it renders
         the explainer instead. -->
    <section class="grocery-section-card grocery-cart-section">
      <h3 class="grocery-section-card-title">In cart</h3>
      {#if !shoppingActive}
        <p class="subtle grocery-section-card-empty">{CART_IDLE_MESSAGE}</p>
      {:else if acquiredSplit.cart.length === 0}
        <p class="subtle grocery-section-card-empty">
          Nothing in the cart yet - items you mark off appear here.
        </p>
      {:else}
        {#each acquiredSplit.cart as item (item.id)}
          {@render itemRow(item, false)}
        {/each}
      {/if}
    </section>

    {#if acquiredSplit.history.length > 0}
      <button
        type="button"
        class="grocery-acquired-toggle"
        aria-expanded={acquiredOpen}
        onclick={() => (acquiredOpen = !acquiredOpen)}
      >
        <span class="grocery-acquired-chevron" class:open={acquiredOpen} aria-hidden="true">&#9656;</span>
        {acquiredHeaderLabel(acquiredSplit.history.length, grocery.acquiredHasMore)}
      </button>
      {#if acquiredOpen}
        {#each acquiredSplit.history as item (item.id)}
          {@render itemRow(item, false)}
        {/each}
        {#if grocery.acquiredHasMore}
          <button
            type="button"
            class="grocery-small-btn grocery-show-more"
            disabled={grocery.loadingMore}
            onclick={() => app.supabase && loadMoreAcquired(app.supabase)}
          >{grocery.loadingMore ? 'Loading...' : `Show ${ACQUIRED_PAGE_SIZE} more`}</button>
        {/if}
      {/if}
    {/if}
  {/if}
</div>
</div>

<style>
  /* Panel scroll container. The inner column is width-capped so the
     list stays a readable single column on wide desktops; on a phone
     it fills the viewport, which is the primary use. */
  .groceries-panel {
    flex: 1;
    height: 100%;
    overflow-y: auto;
    min-height: 0;
  }
  .groceries-panel-inner {
    max-width: 40rem;
    margin: 0 auto;
    padding: 0.75rem 0.5rem 2rem;
    display: flex;
    flex-direction: column;
    min-height: 0;
  }
  .grocery-controls {
    display: flex;
    gap: 0.35rem;
    align-items: center;
    padding: 0.4rem 0.6rem;
    margin-bottom: 0.5rem;
  }
  .grocery-controls .sidebar-search-input {
    flex: 1;
    min-width: 0;
  }
  .grocery-sections-toggle {
    flex-shrink: 0;
    padding: 0.3rem 0.5rem;
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    background: var(--bg);
    color: var(--text);
    font: inherit;
    font-size: 0.8rem;
    cursor: pointer;
  }
  .grocery-sections-toggle.active {
    border-color: var(--accent);
    color: var(--accent);
  }
  .grocery-error {
    padding: 0 0.75rem 0.5rem;
  }
  /* Empty-sections toggle under the controls row, same gutters. The
     input gets explicit box sizing and zero margin so global
     form-control styling can't stretch it away from its label. */
  .grocery-empty-toggle {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    padding: 0 0.75rem 0.5rem;
    font-size: 0.8rem;
    color: var(--muted);
    cursor: pointer;
    user-select: none;
    white-space: nowrap;
  }
  .grocery-empty-toggle input {
    width: 0.95rem;
    height: 0.95rem;
    margin: 0;
    flex: 0 0 auto;
    accent-color: var(--accent);
    cursor: pointer;
  }
  .grocery-empty {
    padding: 0.75rem;
  }

  /* Suggestion dropdown. Rendered in flow (not floating) so it never
     fights the drawer's stacking context on mobile. */
  .grocery-suggestions {
    margin: -0.3rem 0.6rem 0.5rem;
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    overflow: hidden;
  }
  .grocery-suggestion {
    display: flex;
    width: 100%;
    align-items: center;
    gap: 0.4rem;
    padding: 0.45rem 0.6rem;
    border: none;
    border-bottom: 1px solid var(--border);
    background: var(--bg);
    color: var(--text);
    font: inherit;
    font-size: 0.85rem;
    text-align: left;
    cursor: pointer;
  }
  .grocery-suggestion:last-child {
    border-bottom: none;
  }
  .grocery-suggestion:hover {
    background: var(--bg-hover, rgba(128, 128, 128, 0.12));
  }
  .grocery-suggestion-new {
    color: var(--accent);
  }
  .grocery-suggestion-hint {
    padding: 0.45rem 0.6rem;
    margin: 0;
    font-size: 0.8rem;
  }

  /* Section manager. */
  .grocery-section-manager {
    margin: 0 0.6rem 0.6rem;
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    padding: 0.25rem;
  }
  .grocery-section-row {
    display: flex;
    align-items: center;
    gap: 0.35rem;
    padding: 0.2rem 0.3rem;
    border-radius: var(--radius-md);
  }
  .grocery-section-row.dragging {
    opacity: 0.5;
  }
  /* Insertion line marking where the dragged section will land -
     box-shadow rather than border so the row doesn't jump a pixel
     while the line flicks between rows. */
  .grocery-section-row.drop-before {
    box-shadow: 0 -2px 0 0 var(--accent);
  }
  .grocery-section-row.drop-after {
    box-shadow: 0 2px 0 0 var(--accent);
  }
  .grocery-drag-handle {
    cursor: grab;
    color: var(--muted);
    font-size: 0.75rem;
    letter-spacing: -0.1em;
    user-select: none;
  }
  .grocery-drag-handle-disabled {
    visibility: hidden;
  }
  .grocery-section-name {
    flex: 1;
    min-width: 0;
    border: none;
    background: none;
    color: var(--text);
    font: inherit;
    font-size: 0.85rem;
    text-align: left;
    padding: 0.15rem 0.2rem;
    cursor: text;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .grocery-section-name-static {
    flex: 1;
    font-size: 0.85rem;
    color: var(--muted);
    padding: 0.15rem 0.2rem;
  }
  .grocery-section-rename,
  .grocery-section-add-input {
    flex: 1;
    min-width: 0;
    padding: 0.2rem 0.3rem;
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    background: var(--bg);
    color: var(--text);
    font: inherit;
    font-size: 0.85rem;
  }
  .grocery-icon-btn {
    flex-shrink: 0;
    border: none;
    background: none;
    color: var(--muted);
    font-size: 1rem;
    line-height: 1;
    padding: 0.15rem 0.3rem;
    cursor: pointer;
  }
  .grocery-icon-btn:hover {
    color: var(--text);
  }
  .grocery-section-add {
    display: flex;
    gap: 0.35rem;
    padding: 0.3rem 0.3rem 0.15rem;
    border-top: 1px solid var(--border);
    margin-top: 0.25rem;
  }

  /* One card per store section: the section name is the card title,
     items stack one per row below it. Cards render for empty
     sections too, so the fill keeps a titled-but-empty card reading
     as a deliberate slot rather than a stray label. */
  /* Body on --surface, title bar on --bg-2: the two-tone split is
     what makes the title read as a header rather than a first row -
     every theme keys the pair one level apart, so the contrast holds
     in light, dark, and both terminal styles. */
  .grocery-section-card {
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    background: var(--surface);
    margin: 0 0.6rem 0.6rem;
    padding: 0 0 0.45rem;
    overflow: hidden;
  }
  /* Left-aligned title with the reorder handle inline before it.
     The handle only renders in full-layout mode, so the title's left
     edge shifts slightly when it appears - preferred over centering,
     which read as disconnected from the items below. --muted (not a
     hardcoded grey) so the header clears WCAG contrast on every
     theme's --bg-2, including light terminal's beige. */
  .grocery-section-card-title {
    display: flex;
    align-items: center;
    margin: 0;
    padding: 0.4rem 0.75rem;
    font-size: 0.88rem;
    font-weight: 600;
    letter-spacing: 0.05em;
    text-transform: uppercase;
    color: var(--muted);
    background: var(--bg-2);
    border-bottom: 1px solid var(--border);
  }
  .grocery-card-handle {
    /* Generous hit box for a store-aisle thumb; the glyph stays
       small, with clear air between it and the title text. */
    padding: 0.3rem 0.75rem 0.3rem 0.1rem;
    margin: -0.3rem 0;
  }
  .grocery-section-card-empty {
    margin: 0;
    padding: 0.4rem 0.75rem 0.1rem;
    font-size: 0.78rem;
    font-style: italic;
  }

  .grocery-item-row {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.3rem 0.75rem;
  }
  /* Card reorder feedback: the lifted card dims, and the insertion
     line rides the hovered card's landing edge (same box-shadow
     idiom as the manager rows, scaled to card width). */
  .grocery-section-card.lifted {
    opacity: 0.6;
  }
  .grocery-section-card.drop-before {
    box-shadow: 0 -3px 0 0 var(--accent);
  }
  .grocery-section-card.drop-after {
    box-shadow: 0 3px 0 0 var(--accent);
  }

  /* Touch-drag "lift": the long-pressed row dims while the finger
     picks a destination card (mouse DnD shows the browser's drag
     ghost instead, so this only reads on touch). */
  .grocery-item-row.lifted {
    opacity: 0.5;
  }

  /* Drop highlight while an item drag hovers a card: accent outline
     plus an accent-tinted title so the target reads at a glance even
     on a tall card. */
  .grocery-section-card.drop-target {
    border-color: var(--accent);
    box-shadow: 0 0 0 1px var(--accent) inset;
  }
  .grocery-section-card.drop-target .grocery-section-card-title {
    color: var(--accent);
  }
  .grocery-item-row.acquired {
    opacity: 0.55;
  }
  .grocery-item-row.acquired .grocery-item-name {
    text-decoration: line-through;
  }
  .grocery-check-label {
    display: inline-flex;
    align-items: center;
    flex-shrink: 0;
  }
  /* Big tap target: this checkbox is hit with a thumb, one-handed, in
     a store aisle. */
  .grocery-check {
    width: 1.15rem;
    height: 1.15rem;
    accent-color: var(--accent);
    cursor: pointer;
  }
  .grocery-item-body {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    align-items: stretch;
    gap: 0.1rem;
    border: none;
    background: none;
    color: var(--text);
    font: inherit;
    text-align: left;
    padding: 0;
    cursor: pointer;
  }
  .grocery-item-line {
    display: flex;
    align-items: baseline;
    gap: 0.4rem;
    min-width: 0;
  }
  .grocery-item-name {
    font-size: 0.9rem;
    /* Bold so the item name is the scannable anchor of each row -
       qty, note, and recipe title stay regular/muted around it. */
    font-weight: 600;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    min-width: 0;
  }
  .grocery-item-qty {
    flex-shrink: 0;
    font-size: 0.75rem;
    color: var(--muted);
  }
  .grocery-item-meta {
    font-size: 0.72rem;
    color: var(--muted);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  /* Editor toggle at the row's right edge. Bordered like the form
     controls so it reads as a button, with the radius token carrying
     the theme's shape (square in terminal style). Muted until
     hovered or open so the pencil column doesn't compete with the
     item names. */
  .grocery-edit-btn {
    flex-shrink: 0;
    display: inline-flex;
    align-items: center;
    padding: 0.25rem 0.35rem;
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    background: var(--bg);
  }

  /* The In-cart card sits between the section cards and the acquired
     disclosure; extra top margin separates the trip surface from the
     store layout above. */
  .grocery-cart-section {
    margin-top: 0.9rem;
  }
  .grocery-edit-btn.active {
    color: var(--accent);
  }

  .grocery-item-thumb {
    flex-shrink: 0;
    width: 1.8rem;
    height: 1.8rem;
    object-fit: cover;
    border-radius: var(--radius-md);
    border: 1px solid var(--border);
  }

  .grocery-item-edit {
    display: flex;
    flex-direction: column;
    gap: 0.35rem;
    margin: 0.1rem 0.75rem 0.5rem 2.3rem;
    padding: 0.5rem;
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
  }
  .grocery-edit-pair {
    display: flex;
    gap: 0.35rem;
  }
  .grocery-edit-pair .grocery-edit-input {
    flex: 1;
    min-width: 0;
  }
  .grocery-edit-input {
    padding: 0.3rem 0.4rem;
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    background: var(--bg);
    color: var(--text);
    font: inherit;
    font-size: 0.85rem;
    width: 100%;
  }
  .grocery-edit-photo {
    display: flex;
    align-items: center;
    gap: 0.5rem;
  }
  .grocery-edit-thumb {
    width: 3rem;
    height: 3rem;
    object-fit: cover;
    border-radius: var(--radius-md);
    border: 1px solid var(--border);
  }
  .grocery-photo-pick {
    display: inline-flex;
    align-items: center;
  }
  .grocery-edit-actions {
    display: flex;
    gap: 0.35rem;
  }
  .grocery-small-btn {
    padding: 0.25rem 0.5rem;
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    background: var(--bg);
    color: var(--text);
    font: inherit;
    font-size: 0.8rem;
    cursor: pointer;
  }
  .grocery-small-btn:disabled {
    opacity: 0.5;
    cursor: default;
  }
  .grocery-save-btn {
    border-color: var(--accent);
    color: var(--accent);
  }
  .grocery-delete-btn {
    margin-left: auto;
    color: var(--danger, #c0504d);
  }

  .grocery-acquired-toggle {
    display: flex;
    align-items: center;
    gap: 0.35rem;
    width: 100%;
    margin-top: 0.75rem;
    padding: 0.4rem 0.75rem;
    border: none;
    border-top: 1px solid var(--border);
    background: none;
    color: var(--muted);
    font: inherit;
    font-size: 0.8rem;
    text-align: left;
    cursor: pointer;
  }
  .grocery-acquired-chevron {
    display: inline-block;
    transition: transform 120ms ease;
  }
  .grocery-acquired-chevron.open {
    transform: rotate(90deg);
  }
  .grocery-show-more {
    margin: 0.35rem 0.75rem 0.75rem 2.3rem;
    align-self: flex-start;
  }
</style>
