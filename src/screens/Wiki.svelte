<script lang="ts">
  /*
   * Wiki panel - inline detail view. Mounted in the chat shell's main
   * panel when `drawerTab === 'wiki'`. Sibling of Memories.svelte: the
   * sidebar `WikiList` is the alphabetical browse surface, this panel
   * renders one article at a time keyed by `route.wiki_article_id`.
   *
   * No article selected -> empty-state hint + "Add article" button.
   * Selected -> Markdown body, Edit / Delete / "Ask agent to update".
   * The "ask agent to update" flow mirrors the regenerate-with-preview
   * shape from Journal.svelte: textarea for instructions, preview with
   * Accept / Try Again / Cancel.
   */
  import { app } from '$lib/state.svelte';
  import { route, navigate } from '$lib/routing.svelte';
  import {
    wikiStore,
    runWikiSearch,
    patchWikiRow,
    removeWikiRow,
    addWikiRow,
  } from '$lib/wiki-store.svelte';
  import {
    MAX_WIKI_TITLE_CHARS,
    MAX_WIKI_CONTENT_CHARS,
  } from '$lib/wiki';
  import { onWikiChange, emitWikiChange } from '$lib/wiki-events';
  import { WikiAgent, type WikiUpdateOneResult } from '$lib/agents/wiki/agent';
  import type { WikiArticle } from '$lib/supabase';
  import Markdown from '../components/Markdown.svelte';

  const selectedArticle = $derived<WikiArticle | null>(
    route.wiki_article_id
      ? wikiStore.results.find((a) => a.id === route.wiki_article_id) ?? null
      : null,
  );

  // Initial fetch + listen for cross-surface changes (tool path writes,
  // agent worker writes). The store owns the search debounce; this
  // effect just ensures we have at least the alphabetical list once.
  $effect(() => {
    if (!app.supabase) return;
    if (!wikiStore.loaded && !wikiStore.loading) {
      void runWikiSearch(app.supabase, app.venice);
    }
    const off = onWikiChange(() => {
      if (!app.supabase) return;
      void runWikiSearch(app.supabase, app.venice);
    });
    return () => off();
  });

  // --- Edit mode ---------------------------------------------------------

  type SaveState =
    | { kind: 'idle' }
    | { kind: 'dirty' }
    | { kind: 'saving' }
    | { kind: 'saved' }
    | { kind: 'error'; message: string };

  let editingId = $state<string | null>(null);
  let editTitle = $state('');
  let editContent = $state('');
  let saveState = $state<SaveState>({ kind: 'idle' });

  function startEdit(a: WikiArticle): void {
    editingId = a.id;
    editTitle = a.title;
    editContent = a.content;
    saveState = { kind: 'idle' };
    cancelDelete();
    cancelManualUpdate();
  }

  function cancelEdit(): void {
    if (saveState.kind === 'saving') return;
    editingId = null;
    editTitle = '';
    editContent = '';
    saveState = { kind: 'idle' };
  }

  async function saveEdit(): Promise<void> {
    if (!editingId || !app.supabase) return;
    const id = editingId;
    const title = editTitle.trim();
    const content = editContent;
    if (!title) {
      saveState = { kind: 'error', message: 'Title is required.' };
      return;
    }
    if (title.length > MAX_WIKI_TITLE_CHARS) {
      saveState = {
        kind: 'error',
        message: `Title must be ${MAX_WIKI_TITLE_CHARS} chars or fewer.`,
      };
      return;
    }
    if (!content) {
      saveState = { kind: 'error', message: 'Content is required.' };
      return;
    }
    if (content.length > MAX_WIKI_CONTENT_CHARS) {
      saveState = {
        kind: 'error',
        message: `Content must be ${MAX_WIKI_CONTENT_CHARS} chars or fewer.`,
      };
      return;
    }
    saveState = { kind: 'saving' };
    try {
      const updated = await app.supabase.updateWikiArticle(id, { title, content });
      patchWikiRow(id, updated);
      emitWikiChange();
      saveState = { kind: 'saved' };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      saveState = { kind: 'error', message: msg };
    }
  }

  // Track dirty state so the "Unsaved changes" hint flips on the moment
  // the user diverges from the row on the server.
  $effect(() => {
    if (!editingId) return;
    const original = wikiStore.results.find((a) => a.id === editingId);
    if (!original) return;
    if (saveState.kind === 'saving' || saveState.kind === 'error') return;
    const diverged =
      editTitle !== original.title || editContent !== original.content;
    if (diverged) {
      if (saveState.kind !== 'dirty') saveState = { kind: 'dirty' };
    } else {
      if (saveState.kind !== 'idle') saveState = { kind: 'idle' };
    }
  });

  // --- Create flow -------------------------------------------------------

  let composing = $state(false);
  let composeTitle = $state('');
  let composeContent = $state('');
  let composeBusy = $state(false);
  let composeError = $state<string | null>(null);

  function startCompose(): void {
    composing = true;
    composeTitle = '';
    composeContent = '';
    composeError = null;
    cancelEdit();
    cancelDelete();
    cancelManualUpdate();
  }

  function cancelCompose(): void {
    if (composeBusy) return;
    composing = false;
    composeTitle = '';
    composeContent = '';
    composeError = null;
  }

  async function saveCompose(): Promise<void> {
    if (!app.supabase) return;
    const title = composeTitle.trim();
    const content = composeContent;
    if (!title) {
      composeError = 'Title is required.';
      return;
    }
    if (title.length > MAX_WIKI_TITLE_CHARS) {
      composeError = `Title must be ${MAX_WIKI_TITLE_CHARS} chars or fewer.`;
      return;
    }
    if (!content) {
      composeError = 'Content is required.';
      return;
    }
    if (content.length > MAX_WIKI_CONTENT_CHARS) {
      composeError = `Content must be ${MAX_WIKI_CONTENT_CHARS} chars or fewer.`;
      return;
    }
    composeBusy = true;
    composeError = null;
    try {
      const created = await app.supabase.createWikiArticle({ title, content });
      addWikiRow(created);
      emitWikiChange();
      composing = false;
      composeTitle = '';
      composeContent = '';
      // Surface the new article in the panel so the user lands on
      // their edit straight away.
      navigate({ wiki_article_id: created.id });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // The unique(user_id, title) constraint surfaces here for human
      // creates too. Rephrase so the user sees actionable text rather
      // than a Postgres error.
      composeError =
        /duplicate key|unique constraint/i.test(msg)
          ? 'An article with that title already exists.'
          : msg;
    } finally {
      composeBusy = false;
    }
  }

  // --- Delete flow -------------------------------------------------------

  let deletingId = $state<string | null>(null);
  let deleteError = $state<string | null>(null);

  function requestDelete(a: WikiArticle): void {
    deletingId = a.id;
    deleteError = null;
    cancelEdit();
    cancelManualUpdate();
  }

  function cancelDelete(): void {
    deletingId = null;
    deleteError = null;
  }

  async function confirmDelete(): Promise<void> {
    if (!deletingId || !app.supabase) return;
    const id = deletingId;
    try {
      await app.supabase.deleteWikiArticle(id);
      removeWikiRow(id);
      emitWikiChange();
      deletingId = null;
      deleteError = null;
      if (route.wiki_article_id === id) navigate({ wiki_article_id: null });
    } catch (err) {
      deleteError = err instanceof Error ? err.message : String(err);
    }
  }

  // --- "Ask agent to update" flow ---------------------------------------
  //
  // Mirrors `regenerateAutomaticEntry` in Journal.svelte. The agent
  // runs synchronously on the main thread; the user sees a preview
  // and chooses Accept / Try Again / Cancel before any DB write.
  let manualTargetId = $state<string | null>(null);
  let manualInstructions = $state('');
  let manualBusy = $state(false);
  let manualPreview = $state<{ title: string; content: string } | null>(null);
  let manualNoop = $state<{ reason: string } | null>(null);
  let manualError = $state<string | null>(null);
  let manualAccepting = $state(false);
  let manualController: AbortController | null = null;

  // Article id whose body is currently mid-fade-out. Set on Accept
  // between the DB write and the in-store patch so the user sees
  // the OLD content dissolve before the NEW content snaps in -
  // mirrors the pending-delete / fade-out sequence on chat message
  // bubbles when a turn is regenerated. Kept in sync with the
  // FADE_OUT_MS constant; the matching @keyframes msg-fade-out
  // duration lives in styles.css.
  let fadingArticleId = $state<string | null>(null);
  const FADE_OUT_MS = 500;

  function startManualUpdate(a: WikiArticle): void {
    manualTargetId = a.id;
    manualInstructions = '';
    manualBusy = false;
    manualPreview = null;
    manualNoop = null;
    manualError = null;
    manualAccepting = false;
    cancelEdit();
    cancelDelete();
  }

  function cancelManualUpdate(): void {
    if (manualController) {
      manualController.abort();
      manualController = null;
    }
    manualTargetId = null;
    manualInstructions = '';
    manualBusy = false;
    manualPreview = null;
    manualNoop = null;
    manualError = null;
    manualAccepting = false;
  }

  // Tear down any in-flight manual-update when the panel unmounts so
  // the Venice socket releases instead of running to completion in the
  // background.
  $effect(() => {
    return () => {
      if (manualController) {
        manualController.abort();
        manualController = null;
      }
    };
  });

  async function submitManualUpdate(article: WikiArticle): Promise<void> {
    if (!app.supabase || !app.venice) return;
    const instructions = manualInstructions.trim();
    if (instructions.length === 0) {
      manualError = 'Add some instructions for the agent first.';
      return;
    }
    if (manualController) manualController.abort();
    const ctl = new AbortController();
    manualController = ctl;
    manualBusy = true;
    manualPreview = null;
    manualNoop = null;
    manualError = null;
    try {
      const agent = new WikiAgent(app.venice, app.supabase);
      const result: WikiUpdateOneResult = await agent.updateOne({
        articleId: article.id,
        currentTitle: article.title,
        currentContent: article.content,
        userInstructions: instructions,
        signal: ctl.signal,
      });
      // Stale-result guard - a concurrent cancel/restart should not
      // resurface a stale preview.
      if (manualController !== ctl || manualTargetId !== article.id) return;
      if (result.kind === 'preview') {
        manualPreview = { title: result.title, content: result.content };
      } else {
        manualNoop = { reason: result.reason };
      }
    } catch (err) {
      if (manualController !== ctl || manualTargetId !== article.id) return;
      const msg = err instanceof Error ? err.message : String(err);
      // Aborted runs are intentional (the user clicked Cancel or the
      // panel unmounted); they shouldn't render as red errors.
      if (!/abort/i.test(msg)) manualError = msg;
    } finally {
      if (manualController === ctl) manualController = null;
      manualBusy = false;
    }
  }

  async function acceptManualUpdate(article: WikiArticle): Promise<void> {
    if (!app.supabase || !manualPreview) return;
    manualAccepting = true;
    try {
      const updated = await app.supabase.updateWikiArticle(article.id, {
        title: manualPreview.title,
        content: manualPreview.content,
      });
      // Fade out the original article BEFORE the in-store patch so
      // the user sees the old version dissolve, then the new content
      // snaps in. The DB write has already succeeded at this point;
      // the fade is purely visual sequencing. If the user navigates
      // away mid-fade the panel unmounts cleanly - the fade target
      // is keyed by article id so a stale fade won't bleed onto a
      // different article.
      fadingArticleId = article.id;
      await new Promise<void>((resolve) => window.setTimeout(resolve, FADE_OUT_MS));
      patchWikiRow(article.id, updated);
      emitWikiChange();
      fadingArticleId = null;
      cancelManualUpdate();
    } catch (err) {
      // On error the fade was either never started or the panel is
      // unmounting; clearing here keeps the article visible at full
      // opacity so the user can read the failure context.
      fadingArticleId = null;
      manualError = err instanceof Error ? err.message : String(err);
    } finally {
      manualAccepting = false;
    }
  }

  async function tryAgainManualUpdate(article: WikiArticle): Promise<void> {
    manualPreview = null;
    manualNoop = null;
    manualError = null;
    await submitManualUpdate(article);
  }
</script>

<section class="wiki-panel" aria-label="Wiki">
  <div class="wiki-body">
    {#if wikiStore.error}
      <p class="error">{wikiStore.error}</p>
    {/if}

    {#if !route.wiki_article_id}
      <!-- Empty state. Encourage either picking from the sidebar or
           creating a fresh article inline. -->
      {#if composing}
        <div class="wiki-compose">
          <h2>New article</h2>
          <div class="form-row">
            <label for="wiki-new-title">Title</label>
            <input
              id="wiki-new-title"
              type="text"
              bind:value={composeTitle}
              maxlength={MAX_WIKI_TITLE_CHARS}
              disabled={composeBusy}
              autocomplete="off"
              spellcheck="false"
            />
          </div>
          <div class="form-row">
            <label for="wiki-new-content">Content</label>
            <textarea
              id="wiki-new-content"
              bind:value={composeContent}
              maxlength={MAX_WIKI_CONTENT_CHARS}
              disabled={composeBusy}
              rows={12}
              spellcheck="true"
            ></textarea>
            <p class="subtle char-count">
              {composeContent.length} / {MAX_WIKI_CONTENT_CHARS}
            </p>
          </div>
          {#if composeError}
            <p class="error">{composeError}</p>
          {/if}
          <div class="row">
            <button
              type="button"
              class="primary"
              onclick={saveCompose}
              disabled={composeBusy}
            >
              {composeBusy ? 'Saving…' : 'Save'}
            </button>
            <button type="button" onclick={cancelCompose} disabled={composeBusy}>
              Cancel
            </button>
          </div>
        </div>
      {:else}
        <p class="subtle wiki-empty">
          Pick an article from the list on the left to read or edit it.
          Or
          <button type="button" class="link" onclick={startCompose}>
            add a new one
          </button>.
        </p>
      {/if}
    {:else if !selectedArticle}
      <p class="subtle wiki-empty">
        That article isn't in the current results. Clear the search to
        find it again.
      </p>
    {:else}
      {@const a = selectedArticle}
      {#if editingId === a.id}
        <div class="wiki-edit">
          <div class="form-row">
            <label for="wiki-edit-title">Title</label>
            <input
              id="wiki-edit-title"
              type="text"
              bind:value={editTitle}
              maxlength={MAX_WIKI_TITLE_CHARS}
              disabled={saveState.kind === 'saving'}
              autocomplete="off"
              spellcheck="false"
            />
          </div>
          <div class="form-row">
            <label for="wiki-edit-content">Content</label>
            <textarea
              id="wiki-edit-content"
              bind:value={editContent}
              maxlength={MAX_WIKI_CONTENT_CHARS}
              disabled={saveState.kind === 'saving'}
              rows={16}
              spellcheck="true"
            ></textarea>
            <p class="subtle char-count">
              {editContent.length} / {MAX_WIKI_CONTENT_CHARS}
            </p>
          </div>
          {#if saveState.kind === 'error'}
            <p class="error">{saveState.message}</p>
          {:else if saveState.kind === 'dirty'}
            <p class="subtle">Unsaved changes.</p>
          {:else if saveState.kind === 'saved'}
            <p class="subtle">Saved.</p>
          {/if}
          <div class="row">
            <button
              type="button"
              class="primary"
              onclick={saveEdit}
              disabled={saveState.kind === 'saving' || saveState.kind === 'idle'}
            >
              {saveState.kind === 'saving' ? 'Saving…' : 'Save'}
            </button>
            <button
              type="button"
              onclick={cancelEdit}
              disabled={saveState.kind === 'saving'}
            >
              Cancel
            </button>
          </div>
        </div>
      {:else}
        <!--
          The .regen-target outline + dim signals "this article is
          marked for replacement" while the manual-update flow is
          open below; .fading-out plays the dissolve animation
          between the DB write and the in-store content swap on
          Accept. Both classes share their visual contract with the
          chat regenerate flow (.msg.disabled / .msg.fading-out) so
          the language reads consistently across surfaces.
        -->
        <article
          class="wiki-article"
          class:regen-target={manualTargetId === a.id}
          class:fading-out={fadingArticleId === a.id}
        >
          <header class="wiki-header">
            <h1 class="wiki-title">{a.title}</h1>
            <div class="wiki-actions">
              <button type="button" onclick={() => startEdit(a)}>Edit</button>
              <button type="button" onclick={() => startManualUpdate(a)}>
                Ask agent to update
              </button>
              <button type="button" onclick={() => requestDelete(a)} class="danger">
                Delete
              </button>
            </div>
          </header>
          <div class="wiki-content">
            <Markdown content={a.content} />
          </div>
        </article>

        {#if deletingId === a.id}
          <div class="wiki-confirm-strip">
            <p>Delete this article? This cannot be undone.</p>
            {#if deleteError}
              <p class="error">{deleteError}</p>
            {/if}
            <div class="row">
              <button type="button" class="danger" onclick={confirmDelete}>
                Delete
              </button>
              <button type="button" onclick={cancelDelete}>Cancel</button>
            </div>
          </div>
        {/if}

        {#if manualTargetId === a.id}
          <div class="wiki-manual-update">
            <h3>Ask the agent to update this article</h3>
            <p class="subtle">
              The agent will preserve every existing fact unless you ask
              it to change them. It works in encyclopedic third-person
              prose.
            </p>
            <div class="form-row">
              <label for="wiki-manual-instructions">Your instructions</label>
              <textarea
                id="wiki-manual-instructions"
                bind:value={manualInstructions}
                disabled={manualBusy || manualAccepting}
                rows={4}
                spellcheck="true"
                placeholder={'e.g. "Add a sentence noting that Maya prefers green tea."'}
              ></textarea>
            </div>
            {#if manualError}
              <p class="error">{manualError}</p>
            {/if}
            {#if !manualPreview && !manualNoop}
              <div class="row">
                <button
                  type="button"
                  class="primary"
                  onclick={() => submitManualUpdate(a)}
                  disabled={manualBusy || manualInstructions.trim().length === 0}
                >
                  {manualBusy ? 'Working…' : 'Ask agent'}
                </button>
                <button
                  type="button"
                  onclick={cancelManualUpdate}
                  disabled={manualBusy}
                >
                  Cancel
                </button>
              </div>
            {:else if manualNoop}
              <div class="wiki-noop">
                <p class="subtle">
                  The agent didn't apply a change. {manualNoop.reason}
                </p>
                <div class="row">
                  <button
                    type="button"
                    onclick={() => tryAgainManualUpdate(a)}
                    disabled={manualBusy}
                  >
                    Try again
                  </button>
                  <button type="button" onclick={cancelManualUpdate}>Close</button>
                </div>
              </div>
            {:else if manualPreview}
              <div class="wiki-preview">
                <h4>Preview</h4>
                {#if manualPreview.title !== a.title}
                  <p class="subtle">
                    Title would change to: <strong>{manualPreview.title}</strong>
                  </p>
                {/if}
                <div class="wiki-content">
                  <Markdown content={manualPreview.content} />
                </div>
                <div class="row">
                  <button
                    type="button"
                    class="primary"
                    onclick={() => acceptManualUpdate(a)}
                    disabled={manualAccepting}
                  >
                    {manualAccepting ? 'Saving…' : 'Accept'}
                  </button>
                  <button
                    type="button"
                    onclick={() => tryAgainManualUpdate(a)}
                    disabled={manualAccepting || manualBusy}
                  >
                    Try again
                  </button>
                  <button
                    type="button"
                    onclick={cancelManualUpdate}
                    disabled={manualAccepting}
                  >
                    Cancel
                  </button>
                </div>
              </div>
            {/if}
          </div>
        {/if}
      {/if}
    {/if}
  </div>
</section>

<style>
  .wiki-panel {
    flex: 1;
    min-height: 0;
    display: flex;
    flex-direction: column;
  }
  .wiki-body {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    padding: 1rem 1.25rem 2rem;
  }
  .wiki-empty {
    padding: 2rem 0;
    text-align: center;
  }
  .wiki-empty .link {
    background: none;
    border: none;
    color: var(--accent, var(--text));
    cursor: pointer;
    text-decoration: underline;
    padding: 0;
    font: inherit;
  }
  .wiki-header {
    display: flex;
    flex-wrap: wrap;
    justify-content: space-between;
    align-items: baseline;
    gap: 0.75rem;
    margin-bottom: 1rem;
  }
  .wiki-title {
    margin: 0;
    font-size: 1.5rem;
    font-weight: 600;
  }
  .wiki-actions {
    display: flex;
    gap: 0.4rem;
    flex-wrap: wrap;
  }
  .wiki-content {
    line-height: 1.6;
  }
  .wiki-edit,
  .wiki-compose,
  .wiki-manual-update,
  .wiki-confirm-strip {
    border: 1px solid var(--border);
    border-radius: 0.5rem;
    padding: 1rem;
    margin-top: 1rem;
    background: var(--bg-2);
  }
  .wiki-compose h2,
  .wiki-manual-update h3 {
    margin: 0 0 0.75rem 0;
  }
  .form-row {
    display: flex;
    flex-direction: column;
    gap: 0.3rem;
    margin-bottom: 0.75rem;
  }
  .form-row label {
    font-weight: 500;
  }
  .form-row input,
  .form-row textarea {
    width: 100%;
    box-sizing: border-box;
    font: inherit;
    padding: 0.4rem 0.5rem;
    border: 1px solid var(--border);
    border-radius: 0.3rem;
    background: var(--bg);
    color: var(--text);
  }
  .form-row textarea {
    resize: vertical;
    min-height: 6rem;
    font-family: inherit;
  }
  .char-count {
    margin: 0.2rem 0 0 0;
    font-size: 0.8rem;
  }
  .row {
    display: flex;
    gap: 0.4rem;
    margin-top: 0.5rem;
    flex-wrap: wrap;
  }
  /* button.danger is styled globally in styles.css (solid red fill +
     light text on top). No local override - the previous version
     re-set `color` to red on top of the global red background, which
     painted the button text invisible. */
  .wiki-preview {
    margin-top: 1rem;
    padding-top: 1rem;
    border-top: 1px dashed var(--border);
  }
  .wiki-preview h4 {
    margin: 0 0 0.5rem 0;
  }
</style>
