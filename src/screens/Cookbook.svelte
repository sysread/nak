<script lang="ts">
  /*
   * Cookbook modal — full-screen recipe manager. Three panes that share
   * one shell:
   *
   *   list    — search + table of recipes + "+ New" button.
   *   detail  — rendered Cooklang output + Copy plain text + Edit + Delete.
   *   edit    — title / source / source_url / cooklang textarea form.
   *
   * State flow is deliberately imperative: a pane switch is a local
   * `$state` change, not routing. The modal is modal — it owns its
   * own focus and escape handling — and nothing outside needs to know
   * which pane we're on.
   *
   * Data source is `cookbook.recipes` from the cookbook store (see
   * `src/lib/cookbook-store.svelte.ts`). We load on mount and listen
   * for `COOKBOOK_CHANGE_EVENT` so an LLM `recipe_save` call mid-
   * session refreshes the list automatically.
   */
  import { onMount, onDestroy } from 'svelte';
  import { app } from '$lib/state.svelte';
  import {
    cookbook,
    loadRecipes,
    COOKBOOK_CHANGE_EVENT,
  } from '$lib/cookbook-store.svelte';
  import {
    cooklangToHtml,
    parseCooklang,
    recipeToPlainText,
    MAX_RECIPE_COOKLANG_CHARS,
    MAX_RECIPE_TITLE_CHARS,
  } from '$lib/cooklang';

  interface Props {
    onClose: () => void;
    /**
     * When set, the modal mounts on the detail pane for this recipe id.
     * Used by the drawer's Recipes tab so a click goes straight to the
     * recipe's rendered view. Ignored if the id isn't in the current
     * list (e.g. the user clicked a row that was deleted in another
     * tab between the list render and the click).
     */
    initialRecipeId?: string | null;
  }
  let { onClose, initialRecipeId = null }: Props = $props();

  type Pane = 'list' | 'detail' | 'edit';
  // svelte-ignore state_referenced_locally
  let pane = $state<Pane>(initialRecipeId ? 'detail' : 'list');

  // --- list pane state ---
  let query = $state('');
  // Case-insensitive title substring filter, applied client-side over
  // the loaded list. Loading the full list once and filtering locally
  // is cheaper than round-tripping a query per keystroke, and a
  // personal cookbook is small enough that in-memory filtering is
  // instantaneous.
  const visibleRecipes = $derived.by(() => {
    const q = query.trim().toLowerCase();
    if (q.length === 0) return cookbook.recipes;
    return cookbook.recipes.filter((r) => r.title.toLowerCase().includes(q));
  });

  // --- detail / edit pane state ---
  // svelte-ignore state_referenced_locally
  let activeId = $state<string | null>(initialRecipeId);
  const activeRecipe = $derived.by(() =>
    activeId ? (cookbook.recipes.find((r) => r.id === activeId) ?? null) : null
  );

  // --- edit pane draft state (shared across new + edit) ---
  let draftTitle = $state('');
  let draftSource = $state('');
  let draftSourceUrl = $state('');
  let draftCooklang = $state('');
  let editError = $state<string | null>(null);
  let saving = $state(false);
  let copyFeedback = $state<string | null>(null);

  // Computed preview HTML for the edit pane. We debounce via derived —
  // Svelte only reruns when draftCooklang actually changes — so typing
  // in the textarea doesn't stall on large recipes. The parser is
  // synchronous and fast; even a 20 KiB recipe parses in single-digit ms.
  const editPreviewHtml = $derived(cooklangToHtml(draftCooklang));

  async function refresh(): Promise<void> {
    if (!app.supabase) return;
    await loadRecipes(app.supabase);
  }

  // --- pane transitions ---
  function openList(): void {
    pane = 'list';
    activeId = null;
    editError = null;
    copyFeedback = null;
  }

  function openDetail(id: string): void {
    activeId = id;
    pane = 'detail';
    copyFeedback = null;
  }

  function openNew(): void {
    activeId = null;
    draftTitle = '';
    draftSource = '';
    draftSourceUrl = '';
    // Seed the draft with a minimal Cooklang scaffold so the user has
    // a head start and a reminder of the syntax. A blank textarea
    // against "learn this DSL first" is hostile to the user journey
    // where they're typing a recipe in from a cookbook.
    draftCooklang = '>> servings: 4\n\n';
    editError = null;
    pane = 'edit';
  }

  function openEdit(): void {
    const r = activeRecipe;
    if (!r) return;
    draftTitle = r.title;
    draftSource = r.source ?? '';
    draftSourceUrl = r.source_url ?? '';
    draftCooklang = r.cooklang;
    editError = null;
    pane = 'edit';
  }

  async function onSave(e: Event): Promise<void> {
    e.preventDefault();
    if (!app.supabase) return;
    const title = draftTitle.trim();
    const cooklang = draftCooklang;
    if (title.length === 0) {
      editError = 'Title is required.';
      return;
    }
    if (title.length > MAX_RECIPE_TITLE_CHARS) {
      editError = `Title exceeds ${MAX_RECIPE_TITLE_CHARS}-char limit.`;
      return;
    }
    if (cooklang.trim().length === 0) {
      editError = 'Recipe source is required.';
      return;
    }
    if (cooklang.length > MAX_RECIPE_COOKLANG_CHARS) {
      editError = `Recipe source exceeds ${MAX_RECIPE_COOKLANG_CHARS}-char limit.`;
      return;
    }
    saving = true;
    editError = null;
    try {
      const source = draftSource.trim().length > 0 ? draftSource.trim() : null;
      const sourceUrl =
        draftSourceUrl.trim().length > 0 ? draftSourceUrl.trim() : null;
      if (activeId) {
        await app.supabase.updateRecipe(activeId, {
          title,
          cooklang,
          source,
          source_url: sourceUrl,
        });
      } else {
        const row = await app.supabase.createRecipe(
          title,
          cooklang,
          source,
          sourceUrl
        );
        activeId = row.id;
      }
      await refresh();
      pane = 'detail';
    } catch (err) {
      editError = err instanceof Error ? err.message : String(err);
    } finally {
      saving = false;
    }
  }

  async function onDelete(id: string): Promise<void> {
    if (!app.supabase) return;
    // Confirm before destructive action — the tool-side delete has
    // the same semantic ("remove a recipe by id") but the UI path
    // needs a user-directed confirm since a misclick is easy.
    if (!window.confirm('Delete this recipe? This cannot be undone.')) return;
    try {
      await app.supabase.deleteRecipe(id);
      await refresh();
      openList();
    } catch (err) {
      editError = err instanceof Error ? err.message : String(err);
    }
  }

  async function onCopyPlain(): Promise<void> {
    const r = activeRecipe;
    if (!r) return;
    const parsed = parseCooklang(r.cooklang);
    const plain = recipeToPlainText(r.title, parsed);
    try {
      await navigator.clipboard.writeText(plain);
      copyFeedback = 'Copied.';
      setTimeout(() => {
        // Guard in case the user navigates away while the timer is
        // pending — setting state on a torn-down component is harmless
        // in Svelte but a tighter no-op keeps dev tools clean.
        if (pane === 'detail') copyFeedback = null;
      }, 1500);
    } catch {
      // clipboard write can fail when the page isn't focused (Safari
      // quirk) or on permissioned browsers — give the user a clear
      // fallback signal rather than a silent drop.
      copyFeedback = 'Could not copy — check browser permissions.';
    }
  }

  async function onCopyCooklang(): Promise<void> {
    const r = activeRecipe;
    if (!r) return;
    try {
      await navigator.clipboard.writeText(r.cooklang);
      copyFeedback = 'Cooklang source copied.';
      setTimeout(() => {
        if (pane === 'detail') copyFeedback = null;
      }, 1500);
    } catch {
      copyFeedback = 'Could not copy — check browser permissions.';
    }
  }

  // --- effects ---

  function onCookbookChange(): void {
    void refresh();
  }

  onMount(() => {
    void refresh();
    window.addEventListener(COOKBOOK_CHANGE_EVENT, onCookbookChange);
  });

  onDestroy(() => {
    window.removeEventListener(COOKBOOK_CHANGE_EVENT, onCookbookChange);
  });

  function onEscape(e: KeyboardEvent): void {
    if (e.key !== 'Escape') return;
    // Escape ladders back: edit → detail-or-list, detail → list, list → close.
    if (pane === 'edit') {
      pane = activeId ? 'detail' : 'list';
    } else if (pane === 'detail') {
      openList();
    } else {
      onClose();
    }
  }

  // Derived preview for detail pane.
  const detailHtml = $derived.by(() => {
    const r = activeRecipe;
    return r ? cooklangToHtml(r.cooklang) : '';
  });
</script>

<svelte:window onkeydown={onEscape} />

<!-- svelte-ignore a11y_no_static_element_interactions -->
<!-- svelte-ignore a11y_click_events_have_key_events -->
<div
  class="center cookbook-backdrop"
  onclick={(e) => {
    if (e.target === e.currentTarget) onClose();
  }}
>
  <div
    class="cookbook-shell"
    role="dialog"
    aria-modal="true"
    aria-label="Cookbook"
  >
    <header class="cookbook-header">
      <h1>Cookbook</h1>
      <!-- Right-side controls share one flex row so the close (×) button
           can't overlap the Back button on the detail/edit panes. Keep
           `cookbook-close` last — it's the outermost "leave this view"
           action, so it reads naturally to the right of pane-local
           controls (Back on detail/edit; search + New on list). -->
      <div class="cookbook-header-actions">
        {#if pane === 'list'}
          <input
            type="search"
            class="cookbook-search"
            placeholder="Search recipes"
            aria-label="Search recipes"
            bind:value={query}
          />
          <button type="button" class="primary" onclick={openNew}>+ New recipe</button>
        {:else}
          <button type="button" class="secondary" onclick={openList}>← Back</button>
        {/if}
        <button
          type="button"
          class="cookbook-close"
          onclick={onClose}
          aria-label="Close cookbook"
          title="Close"
        >×</button>
      </div>
    </header>

    <section class="cookbook-body">
      {#if pane === 'list'}
        {#if cookbook.loading && cookbook.recipes.length === 0}
          <p class="subtle">Loading recipes…</p>
        {:else if cookbook.error}
          <p class="error">{cookbook.error}</p>
        {:else if visibleRecipes.length === 0}
          <p class="subtle">
            {#if cookbook.recipes.length === 0}
              No recipes yet. Click "+ New recipe" to add one, or ask Nak to save
              one from the web.
            {:else}
              No recipes match "{query}".
            {/if}
          </p>
        {:else}
          <ul class="cookbook-list">
            {#each visibleRecipes as r (r.id)}
              <li class="cookbook-list-row">
                <button
                  type="button"
                  class="cookbook-list-title"
                  onclick={() => openDetail(r.id)}
                >
                  <span class="title-text">{r.title}</span>
                  {#if r.source}
                    <span class="subtle title-source">{r.source}</span>
                  {/if}
                </button>
              </li>
            {/each}
          </ul>
        {/if}
      {:else if pane === 'detail'}
        {#if activeRecipe}
          {@const r = activeRecipe}
          <div class="cookbook-detail">
            <div class="cookbook-detail-header">
              <h2>{r!.title}</h2>
              {#if r!.source || r!.source_url}
                <p class="subtle">
                  {#if r!.source}{r!.source}{/if}
                  {#if r!.source && r!.source_url} — {/if}
                  {#if r!.source_url}
                    <a href={r!.source_url} target="_blank" rel="noopener noreferrer">
                      {r!.source_url}
                    </a>
                  {/if}
                </p>
              {/if}
            </div>
            <!-- Icon-only action bar. Each button carries a `title` +
                 `aria-label` so the purpose stays discoverable without
                 the visual weight of text labels — the four actions
                 are common enough that the pencil / clipboard /
                 code / trash glyphs read at a glance, especially on
                 mobile where the text-label version wrapped to a
                 second row. A thin rule separates the destructive
                 Delete from the copy group so a misclick is less
                 likely. -->
            <div class="cookbook-actions">
              <button
                type="button"
                class="secondary icon-btn"
                onclick={openEdit}
                title="Edit recipe"
                aria-label="Edit recipe"
              >
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                     stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                  <path d="M12 20h9" />
                  <path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z" />
                </svg>
              </button>
              <button
                type="button"
                class="secondary icon-btn"
                onclick={onCopyPlain}
                title="Copy as plain text (AnyList-friendly)"
                aria-label="Copy as plain text"
              >
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                     stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                  <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
                  <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
                </svg>
              </button>
              <button
                type="button"
                class="secondary icon-btn"
                onclick={onCopyCooklang}
                title="Copy Cooklang source"
                aria-label="Copy Cooklang source"
              >
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                     stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                  <polyline points="16 18 22 12 16 6" />
                  <polyline points="8 6 2 12 8 18" />
                </svg>
              </button>
              <span class="cookbook-action-sep" aria-hidden="true"></span>
              <button
                type="button"
                class="secondary icon-btn cookbook-action-danger"
                onclick={() => onDelete(r!.id)}
                title="Delete recipe"
                aria-label="Delete recipe"
              >
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                     stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                  <polyline points="3 6 5 6 21 6" />
                  <path d="M19 6l-2 14a2 2 0 0 1-2 2H9a2 2 0 0 1-2-2L5 6" />
                  <path d="M10 11v6M14 11v6" />
                  <path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2" />
                </svg>
              </button>
              <!-- aria-live so screen readers hear the "Copied." flash.
                   Reserves its grid slot when empty so the button row
                   doesn't jump when the message appears and fades. -->
              <span class="subtle copy-feedback" aria-live="polite">
                {copyFeedback ?? ''}
              </span>
            </div>
            <!-- The parsed HTML is produced from trusted source (the
                 user's own Cooklang text, escaped in cooklangToHtml via
                 `esc()`), so rendering with `{@html}` is safe. We still
                 wrap in a scoped container so any future style leak
                 stays contained to `.cookbook-render`. -->
            <div class="cookbook-render">
              {@html detailHtml}
            </div>
          </div>
        {:else}
          <p class="subtle">Recipe not found.</p>
        {/if}
      {:else if pane === 'edit'}
        <form class="cookbook-edit" onsubmit={onSave}>
          <div class="form-row">
            <label for="cb-title">Title</label>
            <input
              id="cb-title"
              type="text"
              bind:value={draftTitle}
              maxlength={MAX_RECIPE_TITLE_CHARS}
              required
            />
          </div>
          <div class="form-row">
            <label for="cb-source">Source <span class="subtle">(optional)</span></label>
            <input
              id="cb-source"
              type="text"
              bind:value={draftSource}
              maxlength={400}
              placeholder="e.g. NYT Cooking — Alison Roman"
            />
          </div>
          <div class="form-row">
            <label for="cb-source-url">Source URL <span class="subtle">(optional)</span></label>
            <input
              id="cb-source-url"
              type="url"
              bind:value={draftSourceUrl}
              maxlength={2000}
              placeholder="https://…"
            />
          </div>
          <div class="cookbook-edit-panes">
            <div class="form-row cookbook-edit-source-col">
              <label for="cb-cooklang">Cooklang source</label>
              <textarea
                id="cb-cooklang"
                class="cookbook-edit-textarea"
                bind:value={draftCooklang}
                maxlength={MAX_RECIPE_COOKLANG_CHARS}
                spellcheck="false"
                required
              ></textarea>
              <p class="subtle cookbook-syntax-hint">
                Syntax: <code>@ingredient{'{'}1%cup{'}'}</code>,
                <code>#cookware{'{'}{'}'}</code>,
                <code>~timer{'{'}30%min{'}'}</code>,
                <code>&gt;&gt; servings: 4</code>.
              </p>
            </div>
            <div class="cookbook-edit-preview-col">
              <div class="cookbook-preview-label">Preview</div>
              <div class="cookbook-render cookbook-edit-preview">
                {@html editPreviewHtml}
              </div>
            </div>
          </div>
          {#if editError}<p class="error">{editError}</p>{/if}
          <div class="cookbook-actions">
            <button type="submit" class="primary" disabled={saving}>
              {saving ? 'Saving…' : 'Save'}
            </button>
            <button
              type="button"
              class="secondary"
              onclick={() => (pane = activeId ? 'detail' : 'list')}
            >Cancel</button>
          </div>
        </form>
      {/if}
    </section>
  </div>
</div>

<style>
  .cookbook-backdrop {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.5);
    z-index: 40;
    padding: 1rem;
  }
  .cookbook-shell {
    background: var(--surface);
    color: var(--text);
    border: 1px solid var(--border);
    border-radius: 10px;
    width: min(1100px, 100%);
    max-height: calc(100vh - 2rem);
    display: flex;
    flex-direction: column;
    position: relative;
    overflow: hidden;
  }
  /* Lives in `.cookbook-header-actions` now — see the template comment
     there. Keep the transparent / borderless look so the glyph reads as
     the modal's "dismiss" affordance rather than competing with the
     adjacent bordered buttons (Back, + New recipe). */
  .cookbook-close {
    background: transparent;
    border: none;
    color: var(--text);
    font-size: 1.5rem;
    cursor: pointer;
    line-height: 1;
    padding: 0.25rem 0.5rem;
    border-radius: 4px;
  }
  .cookbook-close:hover {
    background: var(--border);
  }
  .cookbook-header {
    padding: 1rem 1rem 0.5rem;
    border-bottom: 1px solid var(--border);
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.75rem;
    flex-wrap: wrap;
  }
  .cookbook-header h1 {
    margin: 0;
    font-size: 1.25rem;
  }
  .cookbook-header-actions {
    display: flex;
    gap: 0.5rem;
    align-items: center;
  }
  .cookbook-search {
    padding: 0.35rem 0.6rem;
    border: 1px solid var(--border);
    border-radius: 6px;
    background: var(--bg);
    color: var(--text);
  }
  .cookbook-body {
    padding: 1rem;
    overflow: auto;
    flex: 1;
  }
  .cookbook-list {
    list-style: none;
    padding: 0;
    margin: 0;
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
  }
  .cookbook-list-row {
    border-bottom: 1px solid var(--border);
  }
  .cookbook-list-title {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 0.15rem;
    width: 100%;
    padding: 0.65rem 0.5rem;
    background: transparent;
    border: none;
    color: var(--text);
    text-align: left;
    cursor: pointer;
    border-radius: 4px;
  }
  .cookbook-list-title:hover {
    background: var(--border);
  }
  .cookbook-list-title .title-text {
    font-weight: 600;
  }
  .cookbook-list-title .title-source {
    font-size: 0.8rem;
  }
  .cookbook-detail-header h2 {
    margin: 0 0 0.25rem;
  }
  .cookbook-detail-header p {
    margin: 0 0 0.75rem;
    font-size: 0.85rem;
  }
  .cookbook-actions {
    display: flex;
    gap: 0.35rem;
    align-items: center;
    margin: 0.75rem 0;
    flex-wrap: wrap;
  }
  /* Thin vertical rule between the copy group and the destructive
     Delete. Renders as a 1px column the height of the button row —
     purely decorative, so `aria-hidden` in the markup keeps screen
     readers from announcing it. */
  .cookbook-action-sep {
    width: 1px;
    align-self: stretch;
    background: var(--border);
    margin: 0.15rem 0.15rem;
  }
  /* Danger tint on Delete — only the stroke shifts to the warn color
     on hover / focus so the button's resting state matches its
     neighbors. Matches the Thread drawer's "danger" menu-item
     pattern (secondary chrome, red stroke on interaction). */
  .cookbook-action-danger:hover,
  .cookbook-action-danger:focus-visible {
    color: var(--warn, #c0392b);
    border-color: var(--warn, #c0392b);
  }
  /* Reserve a slot for the "Copied." flash so the button row stays
     stable when the message appears and vanishes. The empty-state
     min-width is rough parity with the longest flash text. */
  .copy-feedback {
    font-size: 0.85rem;
    min-width: 6rem;
    min-height: 1.1em;
  }
  .cookbook-render :global(h3) {
    margin: 1rem 0 0.25rem;
    font-size: 0.95rem;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: var(--subtle, var(--text));
  }
  .cookbook-render :global(ul),
  .cookbook-render :global(ol) {
    margin: 0.25rem 0 0.5rem 1.25rem;
    padding: 0;
  }
  .cookbook-render :global(dl.cook-metadata) {
    display: grid;
    grid-template-columns: max-content 1fr;
    gap: 0.25rem 0.75rem;
    margin: 0 0 0.75rem;
    font-size: 0.85rem;
  }
  .cookbook-render :global(dl.cook-metadata dt) {
    font-weight: 600;
    text-transform: capitalize;
  }
  .cookbook-render :global(dl.cook-metadata dd) {
    margin: 0;
  }
  .cookbook-render :global(.cook-qty) {
    font-weight: 600;
  }
  .cookbook-edit-panes {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 1rem;
  }
  @media (max-width: 800px) {
    .cookbook-edit-panes {
      grid-template-columns: 1fr;
    }
  }
  .cookbook-edit-textarea {
    width: 100%;
    min-height: 260px;
    font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
    font-size: 0.85rem;
    padding: 0.5rem;
    border: 1px solid var(--border);
    border-radius: 6px;
    background: var(--bg);
    color: var(--text);
    resize: vertical;
  }
  .cookbook-syntax-hint {
    font-size: 0.75rem;
    margin: 0.25rem 0 0;
  }
  .cookbook-syntax-hint code {
    background: var(--border);
    padding: 0 0.25rem;
    border-radius: 3px;
    font-size: 0.75rem;
  }
  /* Stand-in for the edit-preview "label" that isn't tied to an input —
     styled to match <label> siblings so the two-column layout looks
     balanced. Divs don't require an associated control, avoiding the
     a11y_label_has_associated_control warning. */
  .cookbook-preview-label {
    font-size: 0.85rem;
    font-weight: 600;
    margin-bottom: 0.25rem;
  }
  .cookbook-edit-preview {
    border: 1px solid var(--border);
    border-radius: 6px;
    padding: 0.5rem 0.75rem;
    min-height: 260px;
    max-height: 320px;
    overflow: auto;
    background: var(--bg);
  }
</style>
