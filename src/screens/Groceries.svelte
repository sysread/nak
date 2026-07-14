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
   *  - the needed list: one CARD per store section in the user's
   *    order ("Other" pinned last), section name as the card title,
   *    items one per row. Every section renders even when empty -
   *    the cards are the store's walk order, and an aisle shouldn't
   *    vanish just because nothing is filed under it today.
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
    GROCERY_SEARCH_DEBOUNCE_MS,
    GROCERY_SUGGESTION_LIMIT,
    OTHER_SECTION_LABEL,
    OTHER_SECTION_VALUE,
    acquiredHeaderLabel,
    canCreateGroceryItem,
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

  // Section management mode.
  let manageSections = $state(false);
  let newSectionName = $state('');
  let renamingSectionId = $state<string | null>(null);
  let renameDraft = $state('');
  let dragSectionId = $state<string | null>(null);

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

  const neededGroups = $derived(groupItemsBySection(grocery.sections, grocery.needed));
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
  </div>

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
      {#each grocery.sections as s (s.id)}
        <div
          class="grocery-section-row"
          class:dragging={dragSectionId === s.id}
          draggable="true"
          role="listitem"
          ondragstart={(e) => {
            dragSectionId = s.id;
            if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move';
          }}
          ondragover={(e) => e.preventDefault()}
          ondrop={(e) => {
            e.preventDefault();
            dropSection(s.id);
          }}
          ondragend={() => (dragSectionId = null)}
        >
          <span class="grocery-drag-handle" aria-hidden="true">&#8942;&#8942;</span>
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
      <div class="grocery-section-row grocery-section-other">
        <span class="grocery-drag-handle grocery-drag-handle-disabled" aria-hidden="true">&#8942;&#8942;</span>
        <span class="grocery-section-name-static">{OTHER_SECTION_LABEL}</span>
      </div>
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
    <div class="grocery-item-row" class:acquired={!needed}>
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
      <button
        type="button"
        class="grocery-item-body"
        title="Edit item"
        onclick={() => (editingId === item.id ? cancelEdit() : startEdit(item))}
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
    <!-- One card per section, in the user's order, Other pinned last.
         Every section renders even when empty - the cards ARE the
         store layout, and an aisle shouldn't disappear from the walk
         order just because nothing is filed under it today. -->
    {#each neededGroups as group (group.id ?? '__other')}
      <section class="grocery-section-card">
        <h3 class="grocery-section-card-title">{group.name}</h3>
        {#if group.items.length === 0}
          <p class="subtle grocery-section-card-empty">No items</p>
        {:else}
          {#each group.items as item (item.id)}
            {@render itemRow(item, true)}
          {/each}
        {/if}
      </section>
    {/each}

    {#if grocery.acquired.length > 0}
      <button
        type="button"
        class="grocery-acquired-toggle"
        aria-expanded={acquiredOpen}
        onclick={() => (acquiredOpen = !acquiredOpen)}
      >
        <span class="grocery-acquired-chevron" class:open={acquiredOpen} aria-hidden="true">&#9656;</span>
        {acquiredHeaderLabel(grocery.acquired.length, grocery.acquiredHasMore)}
      </button>
      {#if acquiredOpen}
        {#each grocery.acquired as item (item.id)}
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
  .grocery-drag-handle {
    cursor: grab;
    color: var(--text-muted, #888);
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
    color: var(--text-muted, #888);
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
    color: var(--text-muted, #888);
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
  .grocery-section-card {
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    background: var(--bg-2);
    margin: 0 0.6rem 0.6rem;
    padding: 0.35rem 0 0.45rem;
  }
  .grocery-section-card-title {
    margin: 0;
    padding: 0.25rem 0.75rem 0.35rem;
    font-size: 0.72rem;
    font-weight: 600;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    color: var(--text-muted, #888);
    border-bottom: 1px solid var(--border);
  }
  .grocery-section-card-empty {
    margin: 0;
    padding: 0.4rem 0.75rem 0.1rem;
    font-size: 0.78rem;
  }

  .grocery-item-row {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.3rem 0.75rem;
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
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    min-width: 0;
  }
  .grocery-item-qty {
    flex-shrink: 0;
    font-size: 0.75rem;
    color: var(--text-muted, #888);
  }
  .grocery-item-meta {
    font-size: 0.72rem;
    color: var(--text-muted, #888);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
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
    color: var(--text-muted, #888);
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
