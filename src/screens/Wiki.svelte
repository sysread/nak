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
    MAX_WIKI_CHANGELOG_MESSAGE_CHARS,
  } from '$lib/wiki';
  import { onWikiChange, emitWikiChange } from '$lib/wiki-events';
  import { WikiAgent, type WikiUpdateOneResult } from '$lib/agents/wiki/agent';
  import {
    runManually as runLibrarianManually,
    type RunManuallyResult,
  } from '$lib/agents/wiki-librarian/runner.svelte';
  import type {
    WikiArticle,
    WikiArticleSource,
    WikiArticleRelated,
  } from '$lib/supabase';
  import Markdown from '../components/Markdown.svelte';

  interface Props {
    /**
     * Top-bar manual-run button in Chat.svelte flips this to true; the
     * panel opens the librarian confirmation strip and resets the flag.
     * `$bindable` so the reset is visible to the parent without a
     * dedicated callback prop.
     */
    triggerLibrarianRun?: boolean;
  }
  let { triggerLibrarianRun = $bindable(false) }: Props = $props();

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

  // --- Bibliography + See Also -----------------------------------------
  //
  // Two sections rendered beneath the article body. Both are derived
  // from structured data, not from anything embedded in the article
  // markdown itself - the wiki tools attach source threads to a
  // sidecar table (wiki_article_sources) and the See Also list comes
  // from a server-side RPC that uses a dynamic cosine-similarity
  // floor calibrated from the article's own source conversations.
  //
  // Both surfaces stay empty (no section rendered) when the article
  // has no data for them - a brand-new article whose embedding hasn't
  // landed yet has neither sources nor neighbors, and an honest empty
  // state beats an "everything is empty here" placeholder.
  let sourceRows = $state<WikiArticleSource[] | null>(null);
  let relatedRows = $state<WikiArticleRelated[] | null>(null);

  $effect(() => {
    const supabase = app.supabase;
    const article = selectedArticle;
    if (!supabase || !article) {
      sourceRows = null;
      relatedRows = null;
      return;
    }
    // Re-run on content updates: when the autonomous agent or the
    // librarian touches the article, updated_at moves and the
    // bibliography may have gained a row. Same for See Also after
    // the embedding worker re-embeds.
    void article.updated_at;
    const id = article.id;
    let cancelled = false;
    void (async () => {
      try {
        const [srcs, rel] = await Promise.all([
          supabase.listWikiArticleSources(id),
          supabase.findRelatedWikiArticles(id, 5),
        ]);
        if (!cancelled) {
          sourceRows = srcs;
          relatedRows = rel;
        }
      } catch {
        // Best-effort - the article body still renders. Surfacing an
        // error banner for a missing bibliography would be more noise
        // than signal.
        if (!cancelled) {
          sourceRows = [];
          relatedRows = [];
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  });

  /**
   * Soft-navigate to a thread when the user clicks a Sources entry.
   * Mirrors the patch the inline-markdown click handler produces for
   * `?cid=` anchors: set cid, clear the wiki tab so the user lands
   * on the chat surface rather than staying inside the wiki panel
   * with a thread id behind the scenes.
   */
  function openSourceThread(threadId: string): void {
    navigate({ cid: threadId, drawer: null, wiki_article_id: null });
  }

  /**
   * Soft-navigate to another wiki article (See Also click). Keeps
   * the wiki tab open and just swaps the selected article id.
   */
  function openRelatedArticle(articleId: string): void {
    navigate({ wiki_article_id: articleId });
  }

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
  // One-line "what did you change and why" message that lands in the
  // wiki changelog when the user clicks Save. The agent paths supply
  // their own message via the tool's `message` arg or the manual
  // agent's `reason` field; this state is just the direct-edit form's
  // input box.
  let editMessage = $state('');
  let saveState = $state<SaveState>({ kind: 'idle' });

  function startEdit(a: WikiArticle): void {
    editingId = a.id;
    editTitle = a.title;
    editContent = a.content;
    editMessage = '';
    saveState = { kind: 'idle' };
    cancelDelete();
    cancelManualUpdate();
  }

  function cancelEdit(): void {
    if (saveState.kind === 'saving') return;
    editingId = null;
    editTitle = '';
    editContent = '';
    editMessage = '';
    saveState = { kind: 'idle' };
  }

  async function saveEdit(): Promise<void> {
    if (!editingId || !app.supabase) return;
    const id = editingId;
    const title = editTitle.trim();
    const content = editContent;
    const message = editMessage.trim();
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
    if (!message) {
      saveState = {
        kind: 'error',
        message: 'Add a one-line change message before saving.',
      };
      return;
    }
    if (message.length > MAX_WIKI_CHANGELOG_MESSAGE_CHARS) {
      saveState = {
        kind: 'error',
        message: `Change message must be ${MAX_WIKI_CHANGELOG_MESSAGE_CHARS} chars or fewer.`,
      };
      return;
    }
    saveState = { kind: 'saving' };
    try {
      const updated = await app.supabase.updateWikiArticle(id, { title, content });
      patchWikiRow(id, updated);
      // Append the changelog row after the update lands. Best-effort -
      // the article already updated, and a failed log write should
      // not roll back a successful edit. Errors here are silent for
      // the same reason as the tool path (see wiki_update.ts).
      try {
        await app.supabase.createWikiChangelogEntry({
          article_id: id,
          kind: 'update',
          title_at_change: updated.title,
          message,
        });
      } catch {
        // best-effort; see comment above.
      }
      emitWikiChange();
      editMessage = '';
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
  // Same as editMessage above - direct-edit commit message that lands
  // in the wiki changelog. The compose path always logs a 'create'
  // entry; the user-supplied message is the only thing here that's
  // not a side-effect of the article fields themselves.
  let composeMessage = $state('');
  let composeBusy = $state(false);
  let composeError = $state<string | null>(null);

  function startCompose(): void {
    composing = true;
    composeTitle = '';
    composeContent = '';
    composeMessage = '';
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
    composeMessage = '';
    composeError = null;
  }

  async function saveCompose(): Promise<void> {
    if (!app.supabase) return;
    const title = composeTitle.trim();
    const content = composeContent;
    const message = composeMessage.trim();
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
    if (!message) {
      composeError = 'Add a one-line change message before saving.';
      return;
    }
    if (message.length > MAX_WIKI_CHANGELOG_MESSAGE_CHARS) {
      composeError = `Change message must be ${MAX_WIKI_CHANGELOG_MESSAGE_CHARS} chars or fewer.`;
      return;
    }
    composeBusy = true;
    composeError = null;
    try {
      const created = await app.supabase.createWikiArticle({ title, content });
      addWikiRow(created);
      // Append the changelog row. Best-effort - see the matching
      // comment in saveEdit above.
      try {
        await app.supabase.createWikiChangelogEntry({
          article_id: created.id,
          kind: 'create',
          title_at_change: created.title,
          message,
        });
      } catch {
        // best-effort; see comment above.
      }
      emitWikiChange();
      composing = false;
      composeTitle = '';
      composeContent = '';
      composeMessage = '';
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
  // Commit message captured in the delete confirmation strip. Required
  // before the destructive call fires; the article title at this point
  // gets snapshotted into the changelog row's `title_at_change` so the
  // log still reads after the article itself is gone.
  let deleteMessage = $state('');
  let deleteError = $state<string | null>(null);

  function requestDelete(a: WikiArticle): void {
    deletingId = a.id;
    deleteMessage = '';
    deleteError = null;
    cancelEdit();
    cancelManualUpdate();
  }

  function cancelDelete(): void {
    deletingId = null;
    deleteMessage = '';
    deleteError = null;
  }

  async function confirmDelete(): Promise<void> {
    if (!deletingId || !app.supabase) return;
    const id = deletingId;
    const message = deleteMessage.trim();
    if (!message) {
      deleteError = 'Add a one-line change message before deleting.';
      return;
    }
    if (message.length > MAX_WIKI_CHANGELOG_MESSAGE_CHARS) {
      deleteError = `Change message must be ${MAX_WIKI_CHANGELOG_MESSAGE_CHARS} chars or fewer.`;
      return;
    }
    // Capture the title BEFORE the delete so the changelog row can
    // snapshot it - same reasoning as wiki_delete.ts. Reads off the
    // in-store row to avoid a round-trip.
    const article = wikiStore.results.find((a) => a.id === id) ?? null;
    try {
      await app.supabase.deleteWikiArticle(id);
      removeWikiRow(id);
      if (article) {
        try {
          await app.supabase.createWikiChangelogEntry({
            // Same as the tool path - article_id stays null because
            // the row is already gone; the snapshot title carries
            // the meaning forward.
            article_id: null,
            kind: 'delete',
            title_at_change: article.title,
            message,
          });
        } catch {
          // best-effort; the delete already landed.
        }
      }
      emitWikiChange();
      deletingId = null;
      deleteMessage = '';
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
  // `reason` is the agent's one-line commit-style summary - carried
  // alongside the preview so the UI can show it AND use it as the
  // changelog message when the user accepts. See WikiAgent.updateOne.
  let manualPreview = $state<{ title: string; content: string; reason: string } | null>(null);
  let manualNoop = $state<{ reason: string } | null>(null);
  let manualError = $state<string | null>(null);
  let manualAccepting = $state(false);
  let manualController: AbortController | null = null;
  let manualTextarea = $state<HTMLTextAreaElement | null>(null);

  // Focus the instructions textarea as soon as the form mounts so the
  // user can start typing without an extra click. The bound element
  // stays referentially stable across the form's lifetime; this effect
  // fires once when the form opens (manualTargetId flips from null to
  // an id) and is a no-op when it closes.
  $effect(() => {
    if (manualTargetId && manualTextarea) {
      manualTextarea.focus();
    }
  });

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
        manualPreview = {
          title: result.title,
          content: result.content,
          reason: result.reason,
        };
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
    // Snapshot the agent's reason BEFORE the await so a stale-result
    // race (which cancels manualPreview) can't null it out mid-flight.
    // The reason is the changelog message for this edit - the agent
    // produced it alongside the preview content, so it always
    // accurately describes what's being applied here.
    const reason = manualPreview.reason;
    const targetTitle = manualPreview.title;
    const targetContent = manualPreview.content;
    manualAccepting = true;
    try {
      const updated = await app.supabase.updateWikiArticle(article.id, {
        title: targetTitle,
        content: targetContent,
      });
      // Append the changelog row. Best-effort, same as the direct-
      // edit path - the article already updated; a failed log write
      // shouldn't surface as an error to the user.
      try {
        await app.supabase.createWikiChangelogEntry({
          article_id: updated.id,
          kind: 'update',
          title_at_change: updated.title,
          message: reason,
        });
      } catch {
        // best-effort; see comment above.
      }
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

  // --- Manual librarian-run flow ---------------------------------------
  //
  // Triggered by the top-bar button in Chat.svelte via the
  // `triggerLibrarianRun` $bindable prop. Confirmation strip with an
  // optional custom-instructions textarea is rendered at the top of
  // the panel below; submitting calls `runLibrarianManually()` (a
  // main-thread runner that does NOT touch the scheduled worker's
  // claim RPC, so the next periodic run still fires on its 12h
  // cadence). The button itself is disabled while either a scheduled
  // run is in flight (`wikiLibrarianRunner.workerBusy`) or this
  // strip's own submission is in flight (`librarianBusy`).
  let librarianConfirmOpen = $state(false);
  let librarianInstructions = $state('');
  let librarianBusy = $state(false);
  let librarianError = $state<string | null>(null);
  let librarianResult = $state<RunManuallyResult | null>(null);
  let librarianTextarea = $state<HTMLTextAreaElement | null>(null);

  // Watch the trigger from the top-bar button. Opens the confirmation
  // strip (and only the strip - the run itself is gated behind the
  // user clicking "Run librarian"). Resets the trigger so the parent
  // can re-fire on subsequent clicks.
  $effect(() => {
    if (triggerLibrarianRun) {
      openLibrarianConfirm();
      triggerLibrarianRun = false;
    }
  });

  // Auto-focus the instructions textarea when the strip opens so the
  // user can start typing without an extra click. Mirrors the focus
  // pattern on the "Ask agent to update" form above.
  $effect(() => {
    if (librarianConfirmOpen && !librarianBusy && librarianTextarea) {
      librarianTextarea.focus();
    }
  });

  function openLibrarianConfirm(): void {
    librarianConfirmOpen = true;
    librarianInstructions = '';
    librarianBusy = false;
    librarianError = null;
    librarianResult = null;
  }

  function cancelLibrarianRun(): void {
    if (librarianBusy) return;
    librarianConfirmOpen = false;
    librarianInstructions = '';
    librarianError = null;
    librarianResult = null;
  }

  async function submitLibrarianRun(): Promise<void> {
    if (!app.supabase || !app.venice) return;
    if (librarianBusy) return;
    librarianBusy = true;
    librarianError = null;
    librarianResult = null;
    try {
      const session = await app.supabase.getSession();
      if (!session) {
        librarianError = 'Not signed in.';
        return;
      }
      const result = await runLibrarianManually({
        supabase: app.supabase,
        venice: app.venice,
        userId: session.user.id,
        userName: app.userName,
        userLocation: app.userLocation,
        customInstructions: librarianInstructions.trim() || null,
      });
      librarianResult = result;
      if (result.kind === 'error') {
        librarianError = result.error ?? 'Librarian run failed.';
      }
    } catch (err) {
      librarianError = err instanceof Error ? err.message : String(err);
    } finally {
      librarianBusy = false;
    }
  }

  /**
   * Intercept clicks on relative `?...` anchors in the rendered
   * article body. The wiki agents emit Markdown links of the form
   * `[label](?cid=<thread-id>)` to anchor facts to their source
   * conversation; the same mechanism would work for any of the
   * routed keys in src/lib/routing.svelte.ts (e.g. `?wiki_article_id=...`,
   * `?recipe=...`).
   *
   * Without interception the browser does a full same-origin
   * navigation when the user clicks one of these links - which
   * works functionally (the fresh load reads the new search params
   * and lands on the right surface) but is jarring. This handler
   * preventDefaults the click, parses the href's search params,
   * and calls `navigate()` for a soft in-app navigation instead.
   *
   * Only `?...` hrefs are intercepted. Absolute / external links
   * still flow through the markdown component's link-hardening
   * (target="_blank" etc.). Anchors without an href (icons, etc.)
   * are ignored.
   */
  function onArticleClick(event: MouseEvent): void {
    const target = event.target as HTMLElement | null;
    if (!target) return;
    const anchor = target.closest('a') as HTMLAnchorElement | null;
    if (!anchor) return;
    const href = anchor.getAttribute('href');
    if (!href || !href.startsWith('?')) return;
    if (event.defaultPrevented) return;
    if (event.button !== 0) return; // let middle-click open a new tab
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    const params = new URLSearchParams(href);
    // Build the navigate patch from whichever routed keys appear.
    // `cid` is by far the most common (the source-link convention),
    // but the same handler covers other in-app `?key=val` link
    // patterns the agents might add later. Unknown keys silently
    // fall through - navigate ignores keys it doesn't recognise.
    const patch: Record<string, string | null> = {};
    const cid = params.get('cid');
    if (cid !== null) {
      patch.cid = cid;
      // Clearing the wiki tab so the user lands on the chat surface
      // for that thread, rather than staying inside the wiki panel
      // with a thread id behind the scenes.
      patch.drawer = null;
      patch.wiki_article_id = null;
    }
    if (Object.keys(patch).length === 0) return;
    navigate(patch);
  }
</script>

<section class="wiki-panel" aria-label="Wiki">
  <div class="wiki-body">
    {#if wikiStore.error}
      <p class="error">{wikiStore.error}</p>
    {/if}

    {#if librarianConfirmOpen}
      <!-- Manual-librarian confirmation strip. Sits at the top of the
           panel so the user lands on it regardless of which article
           was last selected. Three layered states:
             1. fresh:  textarea + Run / Cancel
             2. busy:   textarea disabled, "Working..." spinner
             3. done:   summary + Close (the run's wiki edits, if any,
                        have already streamed through the wikiStore via
                        emitWikiChange()). -->
      <div class="wiki-librarian-confirm">
        <h3>Run the librarian now</h3>
        <p class="subtle">
          The librarian reviews, consolidates, fact-checks, and may delete
          articles in your wiki. <strong>Edits are immediate and cannot be
          undone.</strong> Add optional instructions to scope what it
          should do; leave the box empty to run the normal periodic
          sweep. This manual run does not reset the schedule for the
          next background run.
        </p>
        {#if librarianResult && librarianResult.kind === 'ok'}
          <p>
            <strong>Done.</strong>
            {#if librarianResult.finalText.trim().length > 0}
              {librarianResult.finalText}
            {:else}
              The librarian completed without any changes.
            {/if}
          </p>
          <p class="subtle">
            {librarianResult.toolCalls} tool call{librarianResult.toolCalls === 1 ? '' : 's'}
            over {librarianResult.articleCount} article{librarianResult.articleCount === 1 ? '' : 's'}.
            See the Logs drawer for the full trace.
          </p>
          <div class="row">
            <button type="button" onclick={cancelLibrarianRun}>Close</button>
          </div>
        {:else}
          <div class="form-row">
            <label for="wiki-librarian-instructions">
              Custom instructions (optional)
            </label>
            <textarea
              id="wiki-librarian-instructions"
              bind:this={librarianTextarea}
              bind:value={librarianInstructions}
              disabled={librarianBusy}
              rows={4}
              spellcheck="true"
              placeholder={'e.g. "Delete the article about Kermit protocol; it’s out of scope."'}
            ></textarea>
          </div>
          {#if librarianError}
            <p class="error">{librarianError}</p>
          {/if}
          <div class="row">
            <button
              type="button"
              class="primary"
              onclick={submitLibrarianRun}
              disabled={librarianBusy}
            >
              {librarianBusy ? 'Working…' : 'Run librarian'}
            </button>
            <button
              type="button"
              onclick={cancelLibrarianRun}
              disabled={librarianBusy}
            >
              Cancel
            </button>
          </div>
        {/if}
      </div>
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
          <div class="form-row">
            <!-- Changelog commit message. Required: lands in the wiki
                 changelog so the user has an audit trail of why this
                 article was added. Mirrors the same field on the edit
                 and delete strips. -->
            <label for="wiki-new-message">Change message</label>
            <input
              id="wiki-new-message"
              type="text"
              bind:value={composeMessage}
              maxlength={MAX_WIKI_CHANGELOG_MESSAGE_CHARS}
              disabled={composeBusy}
              placeholder={'One line, e.g. "Add Maya, my sister"'}
              autocomplete="off"
              spellcheck="true"
            />
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
          <div class="form-row">
            <!-- Same changelog commit message as the compose form.
                 Cleared back to blank on Save so a follow-up edit
                 has to write its own message rather than inheriting
                 the prior one. -->
            <label for="wiki-edit-message">Change message</label>
            <input
              id="wiki-edit-message"
              type="text"
              bind:value={editMessage}
              maxlength={MAX_WIKI_CHANGELOG_MESSAGE_CHARS}
              disabled={saveState.kind === 'saving'}
              placeholder={'One line, e.g. "Fix Maya\'s job title"'}
              autocomplete="off"
              spellcheck="true"
            />
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
        {#if manualTargetId === a.id}
          <!-- Sits ABOVE the article on purpose. Clicking "Ask agent to
               update" should drop the user straight into the
               instructions textarea (which auto-focuses on mount); if
               the form rendered below, a long article would push it
               off-screen and force a scroll before typing. -->
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
                bind:this={manualTextarea}
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
                <!-- Show the agent's commit-style summary so the user
                     knows what will land in the wiki changelog if they
                     accept. The agent supplied this alongside the
                     content; no separate input is needed. -->
                <p class="subtle wiki-preview-reason">
                  Changelog entry: <em>{manualPreview.reason}</em>
                </p>
                <div
                  class="wiki-content"
                  role="presentation"
                  onclick={onArticleClick}
                >
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

        <!--
          The .regen-target outline + dim signals "this article is
          marked for replacement" while the manual-update flow is
          open above; .fading-out plays the dissolve animation
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
          <div
            class="wiki-content"
            role="presentation"
            onclick={onArticleClick}
          >
            <Markdown content={a.content} />
          </div>

          {#if sourceRows && sourceRows.length > 0}
            <!--
              Bibliography. Ordered by last_processed_at ascending so
              the first contributing conversation is at the top - tells
              the story of how the article grew. Deleted-thread rows
              (cascade not yet caught up) render as a non-link placeholder
              rather than a broken link.
            -->
            <aside class="wiki-sources" aria-label="Sources">
              <h2>Sources</h2>
              <ul>
                {#each sourceRows as src (src.thread_id)}
                  <li>
                    {#if src.thread_title !== null}
                      <button
                        type="button"
                        class="wiki-link"
                        onclick={() => openSourceThread(src.thread_id)}
                      >
                        {src.thread_title || '(untitled thread)'}
                      </button>
                    {:else}
                      <span class="wiki-link-gone">(thread no longer available)</span>
                    {/if}
                  </li>
                {/each}
              </ul>
            </aside>
          {/if}

          {#if relatedRows && relatedRows.length > 0}
            <!--
              See Also. Returned by find_related_wiki_articles, which
              uses the article's own source-conversation embeddings to
              calibrate a similarity floor. Articles whose embeddings
              don't clear the floor never reach us, so an empty section
              is the honest "no real neighbors" answer.
            -->
            <aside class="wiki-related" aria-label="See also">
              <h2>See also</h2>
              <ul>
                {#each relatedRows as rel (rel.id)}
                  <li>
                    <button
                      type="button"
                      class="wiki-link"
                      onclick={() => openRelatedArticle(rel.id)}
                    >
                      {rel.title}
                    </button>
                  </li>
                {/each}
              </ul>
            </aside>
          {/if}
        </article>

        {#if deletingId === a.id}
          <div class="wiki-confirm-strip">
            <p>Delete this article? This cannot be undone.</p>
            <div class="form-row">
              <!-- Required: the title snapshot is captured for the
                   changelog row but the WHY isn't, so the user has to
                   supply it. Lands as a one-line entry in the wiki
                   changelog with article_id=null (the article is gone
                   after the delete; the title snapshot is what makes
                   the row legible). -->
              <label for="wiki-delete-message">Change message</label>
              <input
                id="wiki-delete-message"
                type="text"
                bind:value={deleteMessage}
                maxlength={MAX_WIKI_CHANGELOG_MESSAGE_CHARS}
                placeholder={'One line, e.g. "Remove draft duplicate of Maya"'}
                autocomplete="off"
                spellcheck="true"
              />
            </div>
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
  .wiki-confirm-strip,
  .wiki-librarian-confirm {
    border: 1px solid var(--border);
    border-radius: 0.5rem;
    padding: 1rem;
    margin-top: 1rem;
    background: var(--bg-2);
  }
  .wiki-compose h2,
  .wiki-manual-update h3,
  .wiki-librarian-confirm h3 {
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

  /* Sources and See Also share a visual contract: small heading, tight
     list, links styled as buttons-that-look-like-links so they're
     keyboard-focusable and accessible without sprouting button chrome. */
  .wiki-sources,
  .wiki-related {
    margin-top: 2rem;
    padding-top: 1rem;
    border-top: 1px dashed var(--border);
  }
  .wiki-sources h2,
  .wiki-related h2 {
    margin: 0 0 0.5rem 0;
    font-size: 1rem;
    font-weight: 600;
    color: var(--muted);
    text-transform: uppercase;
    letter-spacing: 0.05em;
  }
  .wiki-sources ul,
  .wiki-related ul {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 0.3rem;
  }
  .wiki-link {
    background: none;
    border: none;
    color: var(--accent, var(--text));
    cursor: pointer;
    text-decoration: underline;
    padding: 0;
    font: inherit;
    text-align: left;
  }
  .wiki-link:hover {
    text-decoration: none;
  }
  .wiki-link-gone {
    color: var(--muted);
    font-style: italic;
  }
</style>
