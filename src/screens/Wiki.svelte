<script lang="ts">
  /*
   * Wiki panel - inline detail view. Mounted in the chat shell's main
   * panel when `drawerTab === 'wiki'`. Sibling of Memories.svelte: the
   * sidebar `WikiList` is the alphabetical browse surface, this panel
   * renders one article at a time keyed by `route.wiki_article_id`.
   *
   * Pages (mutually exclusive surfaces inside .wiki-body, chained as
   * one if/:else-if ladder in the template):
   *
   *   1. Librarian confirmation strip (librarianConfirmOpen)
   *   2. No article + composing -> inline compose form
   *   3. No article + not composing -> WikiChangelogPanel (the default)
   *   4. wiki_article_id set, no match in results -> "not in results" hint
   *   5. wiki_article_id set, match found -> the article view
   *
   * Page-switch entry points and their invariants:
   *
   *   - Top-bar sparkles button -> librarian. Sets `librarianConfirmOpen`.
   *     `openLibrarianConfirm` clears `wiki_article_id` + tears down
   *     per-article mid-edit / delete / manual-update strips. Does NOT
   *     tear down `composing` - if the user was composing a new
   *     article, their typed data persists as a sub-state of the
   *     changelog slot so cancelling the librarian (or navigating
   *     back to the changelog) returns them to their draft.
   *   - Top-bar clock button -> changelog. Flips the
   *     `triggerChangelogView` $bindable prop; the watcher below
   *     closes the librarian and clears `wiki_article_id`. Does not
   *     touch `composing` (same reason - preserve typed drafts).
   *   - WikiList sidebar row click -> article view. Sets
   *     `wiki_article_id`. The route-watch effect below closes any
   *     open librarian so the article actually renders rather than
   *     being hidden behind the librarian page.
   *   - WikiChangelogPanel "+ New article" -> compose. Flips local
   *     `composing` state via the `onAddArticle` callback. Tears down
   *     edit / delete / manual-update strips so leftover article
   *     sub-state doesn't bleed into the compose flow.
   *   - WikiChangelogPanel entry row -> article view. Same `navigate`
   *     call as the sidebar; the route-watch effect provides the
   *     same librarian-close safety even though the changelog and
   *     librarian can't render simultaneously.
   *
   * Selected article sub-flows: Edit / Delete / "Ask agent to update".
   * The "ask agent to update" flow mirrors the regenerate-with-preview
   * shape from Journal.svelte: textarea for instructions, preview with
   * Accept / Try Again / Cancel.
   *
   * The librarian and the changelog used to share the wiki body
   * (librarian rendered on top of whatever was below). They're now
   * sibling pages with the same standing as the article view - the
   * librarian's only exit affordances are the page-switch buttons
   * above (no explicit "Cancel" inside the strip's fresh/busy
   * states). The done-state "Close" survives because dismissing a
   * run result is a different operation from navigating to another
   * page.
   *
   * The changelog used to live in a modal (WikiChangelog.svelte)
   * launched from a top-bar clock button. It moved into the empty
   * state so the wiki tab has a useful default surface instead of a
   * "pick an article from the sidebar" placeholder; the clock button
   * now drives the bindable `triggerChangelogView` prop to land here.
   */
  import { app } from '$lib/state.svelte';
  import { route, navigate } from '$lib/routing.svelte';
  import {
    wikiStore,
    runWikiSearch,
    patchWikiRow,
    applyWikiFavorite,
    removeWikiRow,
    addWikiRow,
  } from '$lib/wiki-store.svelte';
  import {
    MAX_WIKI_TITLE_CHARS,
    MAX_WIKI_CONTENT_CHARS,
    MAX_WIKI_CHANGELOG_MESSAGE_CHARS,
  } from '$lib/wiki';
  import { onWikiChange, emitWikiChange, emitWikiRecordChange } from '$lib/wiki-events';
  import { offlineStatus, getArticleCached } from '$lib/offline-sync.svelte';
  import { missingRecordMessage } from '$lib/ui/offline-status';
  import { createLogger } from '$lib/logger.svelte';
  import { describeRecordOps, recordOpsHeadline } from '$lib/ui/wiki-manual';
  import { contentPreview } from '$lib/ui/wiki-records';
  import type {
    WikiArticle,
    WikiArticleSource,
    WikiArticleRelated,
    WikiLibrarianRunResult,
    WikiManualUpdateResult,
    RecordOp,
    WikiRecord,
  } from '$lib/supabase';
  import { extractHeadings, uniqueSlug, type HeadingEntry } from '$lib/markdown';
  import {
    buildSectionTocLinks,
    WIKI_SOURCES_ANCHOR,
    WIKI_SEE_ALSO_ANCHOR,
  } from '$lib/ui/wiki-toc-sections';
  import {
    appendProgressStep,
    finalizeLibrarianSteps,
    librarianRunButtonLabel,
    outcomeToLibrarianResult,
    LIBRARIAN_PARTIAL_SAVE_NOTE,
    type LibrarianStep,
  } from '$lib/ui/wiki-librarian-run';
  import { recoveredOutcomeIsFresh } from '$lib/ui/manual-run-recovery';
  import { awaitDetachedRun } from '$lib/agents/detached-run';
  import {
    wikiLibrarianLease,
    wikiLibrarianOutcome,
  } from '$lib/agents/inflight-lease.svelte';
  import Markdown from '../components/Markdown.svelte';
  import WikiChangelogPanel from '../components/WikiChangelogPanel.svelte';
  import WikiSkippedPanel from '../components/WikiSkippedPanel.svelte';
  import WikiRecords from '../components/WikiRecords.svelte';

  interface Props {
    /**
     * Top-bar manual-run button in Chat.svelte flips this to true; the
     * panel opens the librarian confirmation strip and resets the flag.
     * `$bindable` so the reset is visible to the parent without a
     * dedicated callback prop.
     */
    triggerLibrarianRun?: boolean;
    /**
     * Top-bar clock button in Chat.svelte flips this to true to ask
     * for the changelog page. The panel closes any open librarian and
     * clears `wiki_article_id` so the changelog renders, then resets
     * the flag. Same $bindable pattern as `triggerLibrarianRun`.
     * Leaves `composing` alone - a user mid-draft keeps their typed
     * data; cancelling compose (or saving) is the explicit way out.
     */
    triggerChangelogView?: boolean;
    /**
     * Top-bar alert button in Chat.svelte flips this to true to ask
     * for the Skipped panel. Mutually exclusive with the librarian
     * and article views (same shape as the changelog trigger). Same
     * `$bindable` pattern.
     */
    triggerSkippedView?: boolean;
  }
  let {
    triggerLibrarianRun = $bindable(false),
    triggerChangelogView = $bindable(false),
    triggerSkippedView = $bindable(false),
  }: Props = $props();

  // The article view normally reads the open article straight out of
  // the loaded list / Favorites bucket. `fetchedArticle` is the
  // fallback for the rows the loaded set doesn't cover: a deep link to
  // an article that was never paged in, and - the point of the offline
  // work - an article opened with no network, served from the
  // IndexedDB cache via getArticleCached.
  let fetchedArticle = $state<WikiArticle | null>(null);
  let fetchingArticle = $state(false);

  const selectedArticle = $derived<WikiArticle | null>(
    route.wiki_article_id
      ? (wikiStore.results.find((a) => a.id === route.wiki_article_id) ??
         wikiStore.favorites.find((a) => a.id === route.wiki_article_id) ??
         (fetchedArticle?.id === route.wiki_article_id ? fetchedArticle : null))
      : null,
  );

  // Resolve the fallback whenever the route points at an article the
  // loaded set doesn't hold. getArticleCached is offline-aware: online
  // it fetches + refreshes the cache; offline it reads the cached copy.
  $effect(() => {
    const id = route.wiki_article_id;
    const supabase = app.supabase;
    if (!id || !supabase) {
      fetchedArticle = null;
      return;
    }
    if (
      wikiStore.results.some((a) => a.id === id) ||
      wikiStore.favorites.some((a) => a.id === id)
    ) {
      return;
    }
    let cancelled = false;
    fetchingArticle = true;
    void getArticleCached(supabase, id)
      .then((res) => {
        if (!cancelled) fetchedArticle = res.row;
      })
      .finally(() => {
        if (!cancelled) fetchingArticle = false;
      });
    return () => {
      cancelled = true;
    };
  });

  // Initial fetch + listen for cross-surface changes (tool path writes,
  // agent worker writes). The store owns the search debounce; this
  // effect just ensures we have at least the alphabetical list once.
  $effect(() => {
    if (!app.supabase) return;
    if (!wikiStore.loaded && !wikiStore.loading) {
      void runWikiSearch(app.supabase);
    }
    const off = onWikiChange(() => {
      if (!app.supabase) return;
      void runWikiSearch(app.supabase);
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

  // Favorite toggle. Marking an article favorite is what saves it
  // offline (offline-sync mirrors the favorite set into IndexedDB), so
  // this is the one bookmark control the wiki has. The local store only
  // updates AFTER the server write lands (applyWikiFavorite), so a
  // failed toggle leaves the glyph showing the true server state; the
  // error line surfaces why nothing changed.
  let favoriteBusy = $state(false);
  let favoriteError = $state<string | null>(null);

  async function toggleFavorite(a: WikiArticle): Promise<void> {
    if (!app.supabase || favoriteBusy) return;
    const next = !a.favorite;
    favoriteBusy = true;
    favoriteError = null;
    try {
      await app.supabase.setWikiArticleFavorite(a.id, next);
      applyWikiFavorite(a, next);
    } catch (err) {
      favoriteError = err instanceof Error ? err.message : String(err);
    } finally {
      favoriteBusy = false;
    }
  }

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
      // Drop straight back to the rendered article. The form closing
      // is the success signal; a successful save followed by a stale
      // form sitting open invited "did it actually save?" doubt.
      //
      // Guard the global-state clears on `editingId === id`. If the
      // user navigated to a different article and clicked Edit on it
      // before this save settled, `editingId` is now that other
      // article's id and the textarea is bound to text the user just
      // typed. Clearing here unconditionally would wipe their
      // in-progress edit and close the form they're actively using.
      // patchWikiRow above is id-keyed so the store write lands
      // correctly regardless.
      if (editingId === id) {
        editingId = null;
        editTitle = '';
        editContent = '';
        editMessage = '';
        saveState = { kind: 'idle' };
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // Same cross-row guard as the success path - a failure on
      // article A's save shouldn't paint a red error banner under
      // article B's edit form after the user has navigated away.
      if (editingId === id) saveState = { kind: 'error', message: msg };
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
      // Guard the global-state clears on `deletingId === id`. If the
      // user navigated to a different article and clicked Delete on
      // it before this delete settled, `deletingId` is now that
      // other article's id and the user has typed a change message
      // into the confirm strip. Clearing here unconditionally would
      // close the strip they're filling out. removeWikiRow above is
      // id-keyed so the store removal lands correctly regardless.
      if (deletingId === id) {
        deletingId = null;
        deleteMessage = '';
        deleteError = null;
      }
      if (route.wiki_article_id === id) navigate({ wiki_article_id: null });
    } catch (err) {
      // Same cross-row guard as the success path - a failure on
      // article A's delete shouldn't paint a red error banner inside
      // article B's confirm strip after the user has navigated.
      if (deletingId === id) {
        deleteError = err instanceof Error ? err.message : String(err);
      }
    }
  }

  // --- "Ask agent to update" flow ---------------------------------------
  //
  // Mirrors `regenerateAutomaticEntry` in Journal.svelte. The agent
  // runs server-side (/wiki-manual-update); the user sees a preview and
  // chooses Accept / Try Again / Cancel before any DB write. The
  // preview-stage outcome logs edge-side under `wiki-manual`; this
  // browser logger reuses the SAME tag so the user's accept/decline
  // choice and the DB commit group under one drawer filter with it.
  const manualLog = createLogger('wiki-manual');
  let manualTargetId = $state<string | null>(null);
  let manualInstructions = $state('');
  let manualBusy = $state(false);
  // `reason` is the agent's one-line commit-style summary - carried
  // alongside the preview so the UI can show it AND use it as the
  // changelog message when the user accepts. `recordOps` are the
  // proposed record create/update/delete operations, previewed and
  // applied on Accept alongside the body edit. The agent runs server-side
  // (/wiki-manual-update, SupabaseService.runWikiManualUpdate).
  let manualPreview = $state<{
    title: string;
    content: string;
    reason: string;
    recordOps: RecordOp[];
  } | null>(null);
  // The article's records as loaded at submit time, used to render
  // update/delete op previews - an update shows the record's existing
  // values for the fields it leaves unchanged; a delete shows what would
  // be removed. The agent reads records server-side; this copy is for
  // display only.
  let manualRecords = $state<WikiRecord[]>([]);
  let manualNoop = $state<{ reason: string } | null>(null);
  let manualError = $state<string | null>(null);
  let manualAccepting = $state(false);
  let manualController: AbortController | null = null;
  let manualTextarea = $state<HTMLTextAreaElement | null>(null);

  // Display-ready projection of the proposed record ops for the preview,
  // resolved against the records loaded at submit time. Empty when there
  // is no preview or the agent proposed no record changes.
  const manualRecordOpViews = $derived(
    manualPreview ? describeRecordOps(manualPreview.recordOps, manualRecords) : []
  );

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
    manualRecords = [];
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
    manualRecords = [];
    manualNoop = null;
    manualError = null;
    manualAccepting = false;
  }

  // Explicit user dismissal of a manual-update RESULT (the Cancel /
  // Close buttons in the preview and noop states), as opposed to the
  // teardown callers of cancelManualUpdate (unmount, navigation, a
  // fresh restart). Log the declined choice only when a result is
  // actually on screen - the fresh-form Cancel and the teardown paths
  // dismiss nothing, so they call cancelManualUpdate directly without a
  // misleading "user declined" line.
  function declineManualUpdate(): void {
    if (manualPreview) {
      manualLog.debug(`user declined preview for article ${manualTargetId}`);
    } else if (manualNoop) {
      manualLog.debug(`user dismissed noop for article ${manualTargetId}`);
    }
    cancelManualUpdate();
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
    if (!app.supabase) return;
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
      // Load the article's records so the preview can resolve update /
      // delete ops against the record they touch (describeRecordOps shows
      // the old value). The agent itself reads the records server-side -
      // these are for display only.
      const records = await app.supabase.listWikiRecords(article.id);
      if (manualController !== ctl || manualTargetId !== article.id) return;
      // The whole run - prompt build, the single JSON completion, the
      // article + record reads - happens server-side; this is a thin
      // authenticated POST. A parse/read failure comes back as a thrown
      // error (the catch below shows the banner); only preview / noop
      // resolve. There is no abort signal: functions.invoke can't be
      // cancelled, but the stale-result guard below drops a late reply.
      const result: WikiManualUpdateResult = await app.supabase.runWikiManualUpdate({
        articleId: article.id,
        instructions,
      });
      // Stale-result guard - a concurrent cancel/restart should not
      // resurface a stale preview.
      if (manualController !== ctl || manualTargetId !== article.id) return;
      if (result.kind === 'preview') {
        manualRecords = records;
        manualPreview = {
          title: result.title,
          content: result.content,
          reason: result.reason,
          recordOps: result.recordOps,
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

  // Apply the agent's proposed record operations in the order it
  // proposed them. Each supabase method auto-appends its own record-
  // changelog row. Sequential (not parallel) so a mid-batch failure
  // leaves a deterministic prefix applied rather than a scattered
  // partial set.
  async function applyRecordOps(
    ops: readonly RecordOp[],
    articleId: string
  ): Promise<void> {
    if (!app.supabase) return;
    for (const op of ops) {
      if (op.op === 'create') {
        await app.supabase.createWikiRecord({
          articleId,
          date: op.date,
          content: op.content,
          tags: op.tags,
        });
      } else if (op.op === 'update') {
        await app.supabase.updateWikiRecord(op.id, {
          date: op.date,
          content: op.content,
          tags: op.tags,
        });
      } else {
        await app.supabase.deleteWikiRecord(op.id);
      }
    }
  }

  async function acceptManualUpdate(article: WikiArticle): Promise<void> {
    if (!app.supabase || !manualPreview) return;
    // Snapshot the preview BEFORE the awaits so a stale-result race
    // (which nulls manualPreview) can't tear out the values mid-flight.
    // The reason is the changelog message for the body edit - the agent
    // produced it alongside the content, so it describes what lands.
    const reason = manualPreview.reason;
    const targetTitle = manualPreview.title;
    const targetContent = manualPreview.content;
    const recordOps = manualPreview.recordOps;
    // The body may be unchanged (a records-only edit). Only write +
    // changelog + fade the article when its title or content actually
    // changed - re-writing identical content would mint a spurious
    // "update" changelog row.
    const bodyChanged =
      targetTitle !== article.title || targetContent !== article.content;
    // The user's choice: they accepted the preview. The edge logged the
    // preview-stage outcome; this is the acceptance half of the pair.
    manualLog.debug(
      `user accepted preview for article ${article.id} ` +
        `(body ${bodyChanged ? 'changed' : 'unchanged'}, ${recordOps.length} record op(s))`
    );
    manualAccepting = true;
    try {
      // Records first, independent of the body write. Refresh the
      // records list in a finally so even a partial apply (some ops
      // landed, a later one threw) surfaces what actually changed.
      if (recordOps.length > 0) {
        try {
          await applyRecordOps(recordOps, article.id);
          // The DB commit itself - per-write breadcrumb, trace tier.
          manualLog.trace(
            `committed ${recordOps.length} record op(s) for article ${article.id}`
          );
        } finally {
          emitWikiRecordChange();
        }
      }

      if (bodyChanged) {
        const updated = await app.supabase.updateWikiArticle(article.id, {
          title: targetTitle,
          content: targetContent,
        });
        manualLog.trace(`committed body update for article ${article.id}`);
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
      }
      // Guard the manualX-state clears on `manualTargetId ===
      // article.id`. If the user navigated to a different article
      // and re-opened the Ask-agent form on it (or even started a
      // fresh submit) before this accept settled, the global
      // manualX state belongs to that new article. Calling
      // cancelManualUpdate() unconditionally would abort the new
      // article's in-flight controller and wipe the form the user
      // is filling in. patchWikiRow above is id-keyed so the store
      // patch lands correctly regardless.
      if (manualTargetId === article.id) {
        fadingArticleId = null;
        cancelManualUpdate();
      } else if (fadingArticleId === article.id) {
        // Drop the stale fade flag without touching the new
        // article's manualX state.
        fadingArticleId = null;
      }
    } catch (err) {
      // On error the fade was either never started or the panel is
      // unmounting; clearing here keeps the article visible at full
      // opacity so the user can read the failure context. Same
      // cross-row guard as the success path - a stale failure
      // shouldn't paint a red banner under a different article's
      // form.
      if (fadingArticleId === article.id) fadingArticleId = null;
      if (manualTargetId === article.id) {
        manualError = err instanceof Error ? err.message : String(err);
      }
    } finally {
      // Same cross-row guard: only flip the busy flag if we're
      // still the active accept. Otherwise the user's new submit
      // on a different article would see its manualAccepting flag
      // clobbered to false mid-flight.
      if (manualTargetId === article.id) manualAccepting = false;
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
  // the panel below; submitting POSTs to the venice function's
  // /wiki-librarian-run route (SupabaseService.runWikiLibrarian). The
  // run does NOT touch the scheduled sweep's cadence stamp, so the
  // next periodic run still fires on its 12h clock. Collisions with a
  // scheduled or chat-dispatched run come back as a `busy` result
  // from the shared server-side in-flight guard; the button itself is
  // only disabled while this strip's own submission is in flight
  // (`librarianBusy`).
  let librarianConfirmOpen = $state(false);
  // True when the user has asked for the Skipped panel (top-bar
  // alert button). Mutually exclusive with the librarian strip and
  // the article view - the template branches enforce that by chaining
  // it into the same :else-if cascade.
  let skippedViewOpen = $state(false);
  let librarianInstructions = $state('');
  let librarianBusy = $state(false);
  let librarianError = $state<string | null>(null);
  let librarianResult = $state<WikiLibrarianRunResult | null>(null);
  let librarianTextarea = $state<HTMLTextAreaElement | null>(null);

  // A wiki-librarian run is in flight that THIS strip didn't start -
  // another tab, another device, or a scheduled background run, detected
  // via the shared in-flight lease. Disables the Run button and drives
  // the "a run is in progress" notice so a second run can't be kicked
  // into the server-side guard's `busy`.
  const runInFlightElsewhere = $derived(
    wikiLibrarianLease.running && !librarianBusy
  );

  // Live step list for the manual librarian run. The run executes
  // server-side; each progress event arrives over the agent-runs
  // Broadcast channel (see SupabaseService.subscribeToAgentRunProgress)
  // and gets translated into one row here. The template renders them
  // with the rotating-glyph spinner next to whichever row is still
  // `pending`, a check on the ones that finished cleanly, and an X on
  // any that errored. Without this the user sees nothing but
  // "Working..." for the 10-30 seconds the agent takes, even though
  // the underlying tool calls each narrate themselves via the
  // runner-injected `activity` field.
  // Step rows + the event->row mapping live in $lib/ui/wiki-librarian-run.
  // The strip only reassigns this $state from those pure transforms; the
  // terminal-finalize there is what keeps the spinner from outliving the run
  // when the `done` broadcast never arrives (gateway-timeout case).
  let librarianSteps = $state<LibrarianStep[]>([]);

  // The runId whose result this strip currently shows. Set by a live run
  // (submitLibrarianRun) and by the recovered-outcome bridge below, so the
  // bridge neither overwrites a live result nor re-applies the same outcome
  // on every realtime tick.
  let librarianShownRunId = $state<string | null>(null);

  // Recover the last run's result card after a reload. wikiLibrarianOutcome
  // reads the persisted outcome on mount and watches the profiles realtime
  // UPDATE the venice function writes when a run finishes; this bridges that
  // into the local result state. Guarded so a live run in this tab (busy) or
  // an already-shown runId wins - the live path keeps full step fidelity,
  // this only fills the gap a reload leaves. No step rows: they're gone after
  // a reload, but the result card is the part worth recovering. The
  // recency guard keeps the sticky `*_last_run_outcome` column from caching
  // an ancient run's result into the strip on a cold load (a fresh realtime
  // outcome has finishedAt ~= now, so it still recovers).
  $effect(() => {
    const outcome = wikiLibrarianOutcome.outcome;
    if (!outcome || librarianBusy || outcome.runId === librarianShownRunId) return;
    if (!recoveredOutcomeIsFresh(outcome.finishedAt, Date.now())) return;
    const result = outcomeToLibrarianResult(outcome);
    if (!result) return;
    librarianResult = result;
    librarianSteps = [];
    librarianShownRunId = outcome.runId;
  });

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

  // Watch the clock-button trigger. Closes the librarian (if open)
  // and clears wiki_article_id (if set) so the changelog renders.
  // Doesn't touch `composing` - see Props docstring for the typed-
  // data-preservation rationale.
  $effect(() => {
    if (triggerChangelogView) {
      librarianConfirmOpen = false;
      skippedViewOpen = false;
      if (route.wiki_article_id) {
        navigate({ wiki_article_id: null });
      }
      triggerChangelogView = false;
    }
  });

  // Watch the alert-button trigger. Closes the librarian and the
  // article view so the Skipped panel can render (the template's
  // :else-if cascade requires both to be cleared).
  $effect(() => {
    if (triggerSkippedView) {
      librarianConfirmOpen = false;
      if (route.wiki_article_id) {
        navigate({ wiki_article_id: null });
      }
      skippedViewOpen = true;
      triggerSkippedView = false;
    }
  });

  // Page-switch safety: when the user lands on an article (sidebar
  // click, changelog row click, browser back/forward to an
  // article-bearing URL), close any open librarian. Without this the
  // librarian's :else-if branch in the template would keep painting
  // and the article the user just picked would be invisible. The
  // gate on `route.wiki_article_id` truthiness - rather than firing
  // unconditionally on every route change - means clearing the
  // article (the clock-button path, the trigger above) doesn't
  // re-trip this and leave us double-closing. The same closes the
  // skipped panel for the same reason.
  $effect(() => {
    if (route.wiki_article_id) {
      librarianConfirmOpen = false;
      skippedViewOpen = false;
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
    // The librarian strip is its own page in the template (the
    // article/changelog/compose conditional is chained as an :else-if
    // off the librarian conditional), so we don't need to swap views
    // explicitly here. We DO need to tear down per-article mid-edit /
    // delete / manual-update strips, so their state doesn't bleed
    // back in if the user later navigates to an article. Also clear
    // wiki_article_id - the librarian's whole reason to exist is
    // wiki-wide operations, and the changelog is the natural surface
    // to fall back to when the user dismisses the post-run result or
    // navigates away via the clock button. `composing` stays:
    // preserving the user's typed draft is more useful than the
    // tidiness of a hard reset.
    if (route.wiki_article_id) {
      navigate({ wiki_article_id: null });
      cancelEdit();
      cancelDelete();
      cancelManualUpdate();
    }
    librarianConfirmOpen = true;
    librarianInstructions = '';
    librarianBusy = false;
    librarianError = null;
    librarianResult = null;
    librarianSteps = [];
  }

  async function submitLibrarianRun(): Promise<void> {
    if (!app.supabase) return;
    if (librarianBusy) return;
    librarianBusy = true;
    librarianError = null;
    librarianResult = null;
    librarianSteps = [];
    // Subscribe to the progress channel BEFORE the POST so the first
    // step events can't race the subscription (the same pre-subscribe
    // rule streaming chat follows). The runId filter keeps a stale or
    // concurrent run's events out of this strip's step list.
    const runId = crypto.randomUUID();
    // This tab owns this runId's display - so the recovered-outcome bridge
    // won't overwrite the live result when this run's outcome later arrives
    // over the profiles realtime UPDATE.
    librarianShownRunId = runId;
    try {
      const session = await app.supabase.getSession();
      if (!session) {
        librarianError = 'Not signed in.';
        return;
      }
      const supa = app.supabase;
      // Detached run: the POST returns {accepted:true} immediately and the
      // run continues server-side past the gateway window. awaitDetachedRun
      // subscribes first, kicks the POST, streams progress into the step
      // list, and resolves with the result carried by the terminal event.
      const result = await awaitDetachedRun<WikiLibrarianRunResult>({
        supabase: supa,
        userId: session.user.id,
        runId,
        post: () =>
          supa.runWikiLibrarian({
            instructions: librarianInstructions.trim() || null,
            runId,
          }),
        onProgress: (event) => {
          librarianSteps = appendProgressStep(librarianSteps, event);
        },
      });
      librarianResult = result;
      if (result.kind === 'busy') {
        // No run started - the in-flight guard rejected it. Nothing was
        // committed and no steps were produced, so there's nothing to
        // finalize or refresh.
        librarianError =
          'A librarian run is already in flight (scheduled or chat-driven). Try again in a moment.';
      } else if (result.kind === 'error') {
        // Run errored server-side mid-loop; earlier wiki_update calls may
        // already be committed. Settle the spinner, refresh to surface them.
        librarianError = `${result.error ?? 'Librarian run failed.'} ${LIBRARIAN_PARTIAL_SAVE_NOTE}`;
        librarianSteps = finalizeLibrarianSteps(librarianSteps, 'error');
        emitWikiChange();
      } else {
        librarianSteps = finalizeLibrarianSteps(librarianSteps, 'ok');
        // Fire the local refresh immediately - the wiki_articles
        // realtime echo also arrives, but consumers refetch
        // idempotently and the local fire keeps the panel snappy.
        emitWikiChange();
      }
    } catch (err) {
      // The kick failed (transport/auth) or awaitDetachedRun's inactivity
      // backstop fired (the channel went silent). The detached run may have
      // landed edits before a dropped channel, so settle the step list,
      // refresh to surface any committed edits, and note the partial save.
      const raw = err instanceof Error ? err.message : String(err);
      librarianError = `${raw} ${LIBRARIAN_PARTIAL_SAVE_NOTE}`;
      librarianSteps = finalizeLibrarianSteps(librarianSteps, 'error');
      emitWikiChange();
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
   * Also intercepts `#anchor` clicks - these come from the in-article
   * ToC at the top of the panel or from any `[link](#heading)` the
   * agents might emit. Default browser behaviour would append the
   * fragment to the page URL and scroll the whole window; we want a
   * smooth scroll WITHIN the .wiki-body scroll container instead, so
   * the surrounding chrome stays put.
   *
   * Without interception the browser does a full same-origin
   * navigation when the user clicks one of these links - which
   * works functionally (the fresh load reads the new search params
   * and lands on the right surface) but is jarring. This handler
   * preventDefaults the click, parses the href's search params,
   * and calls `navigate()` for a soft in-app navigation instead.
   *
   * Absolute / external links still flow through the markdown
   * component's link-hardening (target="_blank" etc.). Anchors without
   * an href (icons, etc.) are ignored.
   */
  function onArticleClick(event: MouseEvent): void {
    const target = event.target as HTMLElement | null;
    if (!target) return;
    const anchor = target.closest('a') as HTMLAnchorElement | null;
    if (!anchor) return;
    const href = anchor.getAttribute('href');
    if (!href) return;
    if (event.defaultPrevented) return;
    if (event.button !== 0) return; // let middle-click open a new tab
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;

    if (href.startsWith('#')) {
      // ToC click or in-article hash link. Resolve against the
      // currently-rendered article body (`articleEl`); the body lives
      // inside a scroll container so .scrollIntoView is enough to
      // bring the heading into view without scrolling the page.
      const id = href.slice(1);
      if (!id || !articleEl) return;
      // In-article headings live inside `articleEl`; the appended-section
      // anchors (Sources / See also are inside, but Records renders as a
      // sibling OUTSIDE `<article>`), so fall back to a document lookup so
      // a "Records" ToC link still resolves.
      const targetEl =
        articleEl.querySelector<HTMLElement>(`#${CSS.escape(id)}`) ??
        document.getElementById(id);
      if (!targetEl) return;
      event.preventDefault();
      targetEl.scrollIntoView({ block: 'start', behavior: 'smooth' });
      return;
    }

    if (!href.startsWith('?')) return;
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

  // --- Table of contents ------------------------------------------------
  //
  // Articles get a ToC at the top of the panel listing the headings in
  // document order, nested by level. Two pieces wire it up:
  //
  //   1. `tocItems` - a nested tree built off `extractHeadings(content)`.
  //      Same slug algorithm as the post-render id assignment below, so
  //      each `<a href="#slug">` in the ToC always matches an `<h*>`
  //      in the rendered body.
  //   2. The post-render effect on `articleEl` walks `.md h1..h6` and
  //      assigns those same slugs as `id` attributes. The renderer
  //      itself does not emit ids (see markdown.ts § Heading slugger
  //      for the rationale).
  //
  // The ToC hides for short articles (<2 headings) - a one-item outline
  // is noise.

  interface TocNode extends HeadingEntry {
    children: TocNode[];
  }

  /**
   * Stack-based flat-to-tree fold. Each new heading hangs off the
   * nearest preceding heading with a strictly lower level; jumps in
   * the document outline (H1 -> H3 directly, no H2 between) attach
   * to whichever ancestor is closest rather than synthesising a
   * placeholder, which keeps the UI honest about the source.
   */
  function nestHeadings(items: HeadingEntry[]): TocNode[] {
    const root: TocNode = { level: 0, text: '', slug: '', children: [] };
    const stack: TocNode[] = [root];
    for (const h of items) {
      while (stack.length > 1 && stack[stack.length - 1].level >= h.level) {
        stack.pop();
      }
      const node: TocNode = { ...h, children: [] };
      stack[stack.length - 1].children.push(node);
      stack.push(node);
    }
    return root.children;
  }

  const tocHeadings = $derived<HeadingEntry[]>(
    selectedArticle ? extractHeadings(selectedArticle.content) : [],
  );
  // Nested for rendering; flat count drives the >=2 visibility gate.
  // A single-entry outline is more visual chrome than navigation.
  const tocItems = $derived<TocNode[]>(nestHeadings(tocHeadings));

  // Record count for the open article, reported up by WikiRecords after
  // each unfiltered load. Drives whether the ToC gets a "Records" link.
  let recordCount = $state(0);

  // Clear the count when the SELECTED ARTICLE changes (not on a body
  // updated_at bump - WikiRecords only re-reports on a record change, so
  // resetting on every content edit would wrongly drop the link until
  // the next record write). The remounted WikiRecords re-reports the new
  // article's count after its load.
  let lastRecordArticleId: string | null = null;
  $effect(() => {
    const id = selectedArticle?.id ?? null;
    if (id !== lastRecordArticleId) {
      lastRecordArticleId = id;
      recordCount = 0;
    }
  });

  // The appended-section links shown at the bottom of the ToC (Sources /
  // See also / Records), one per section actually present on this
  // article. When non-empty they also relax the ToC's >=2-heading gate
  // so a short article still gets navigation to its sections.
  const sectionTocLinks = $derived(
    buildSectionTocLinks({
      hasSources: (sourceRows?.length ?? 0) > 0,
      hasSeeAlso: (relatedRows?.length ?? 0) > 0,
      recordCount,
    }),
  );

  // `bind:this` target for the rendered article. Used by:
  //   - the post-render effect below, to attach heading ids;
  //   - `onArticleClick`, to resolve `#anchor` clicks back to the
  //     matching heading inside this same article.
  let articleEl: HTMLElement | undefined = $state();

  // Post-render: assign ids to the rendered headings using the same
  // slug algorithm the ToC used so each `#slug` link resolves. Runs
  // after `{@html}` commits - `articleEl` is bound by the <article>
  // element below, which only mounts when an article is selected.
  $effect(() => {
    if (!selectedArticle) return;
    // Track content so a manual-update accept (which patches the row
    // in place) re-runs this effect with the new headings.
    void selectedArticle.content;
    if (!articleEl) return;
    const used = new Set<string>();
    for (const h of articleEl.querySelectorAll<HTMLElement>(
      '.wiki-content h1, .wiki-content h2, .wiki-content h3, ' +
      '.wiki-content h4, .wiki-content h5, .wiki-content h6',
    )) {
      // Match the cleaning step in extractHeadings so slug lookup
      // works for headings that carried inline `*` / `_` / `` ` ``
      // markers in the source.
      const text = (h.textContent ?? '').replace(/[*_`~]/g, '').trim();
      h.id = uniqueSlug(text, used);
    }
  });
</script>

<section class="wiki-panel" aria-label="Wiki">
  <div class="wiki-body">
    {#if wikiStore.error}
      <p class="error">{wikiStore.error}</p>
    {/if}

    {#if librarianConfirmOpen}
      <!-- Manual-librarian confirmation strip. Its own page: mutually
           exclusive with the article view, the changelog, and the
           compose form below (chained as :else-if branches off this
           conditional). Three layered states:
             1. fresh:  textarea + Run librarian
             2. busy:   textarea disabled, "Working..." spinner
             3. done:   summary + Close (the run's wiki edits, if any,
                        have already streamed through the wikiStore via
                        emitWikiChange()).
           No "Cancel" affordance in fresh/busy - the librarian is a
           page, so the way out is to navigate elsewhere via the top-
           bar clock (changelog) or sidebar (article). Done-state
           "Close" survives because dismissing the result is a
           different operation from navigating away. -->
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
        {#if runInFlightElsewhere && librarianSteps.length === 0}
          <!-- A run this strip didn't start is in flight (another tab /
               device, or a scheduled background run), detected via the
               in-flight lease. We have no step-level fidelity for it -
               that rides the originator's runId-filtered channel - so
               show a low-fidelity "in progress" spinner and keep the
               Run button disabled until the lease clears. -->
          <p class="subtle wiki-librarian-inflight" aria-live="polite">
            <span class="librarian-step-glyph" aria-hidden="true">↻</span>
            The librarian is running in the background…
          </p>
        {/if}
        {#if librarianSteps.length > 0}
          <!-- Live step list. Each row pairs the rotating-glyph
               spinner (pending) or a final glyph (ok/error) with the
               model-emitted `activity` narration for tool calls and a
               generic phase label for the surrounding phases. Gives
               the user visible evidence the run is actually doing
               work during the 10-30s the loop runs - the old
               "Working..." button alone reads as "hung." Stays
               visible after the run settles so the user can scan the
               trail alongside the summary below. -->
          <ol class="librarian-steps" aria-live="polite">
            {#each librarianSteps as step, i (i)}
              <li class="librarian-step status-{step.status}">
                <span
                  class="librarian-step-glyph"
                  aria-hidden="true"
                >{step.status === 'pending'
                  ? '↻'
                  : step.status === 'ok'
                    ? '✓'
                    : '✗'}</span>
                <span class="librarian-step-label">{step.label}</span>
              </li>
            {/each}
          </ol>
        {/if}
        {#if librarianResult && librarianResult.kind === 'ok'}
          <!-- Post-run summary, between the checklist and the Run button
               so the strip reads top-to-bottom: steps -> what it decided
               -> run again. The librarian's final reply is its
               operator-facing summary; shown as an italic block quote so
               it reads as "the agent said," set apart from the UI chrome.
               Rendered through Markdown because the reply sometimes
               carries backticked article titles or a short list. -->
          <div class="wiki-librarian-result" aria-live="polite">
            {#if librarianResult.finalText.trim().length > 0}
              <blockquote class="wiki-librarian-summary">
                <Markdown content={librarianResult.finalText} />
              </blockquote>
            {:else}
              <p class="subtle">
                The librarian completed without any changes.
              </p>
            {/if}
            <p class="subtle wiki-librarian-result-meta">
              {librarianResult.toolCalls} tool call{librarianResult.toolCalls === 1 ? '' : 's'}
              over {librarianResult.articleCount} article{librarianResult.articleCount === 1 ? '' : 's'}.
              See the Logs drawer for the full trace.
            </p>
          </div>
        {/if}
        <div class="row">
          <button
            type="button"
            class="primary"
            onclick={submitLibrarianRun}
            disabled={librarianBusy || runInFlightElsewhere}
          >
            {librarianRunButtonLabel(librarianBusy, runInFlightElsewhere)}
          </button>
        </div>
      </div>
    {:else if !route.wiki_article_id}
      <!-- No-article default. Compose mode wins (don't yank a mid-
           draft user off their form), then the Skipped panel (alert-
           button trigger), and finally the changelog (the wiki's
           "home page" with a "+ new article" button in its header). -->
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
      {:else if skippedViewOpen}
        <WikiSkippedPanel />
      {:else}
        <WikiChangelogPanel onAddArticle={startCompose} />
      {/if}
    {:else if !selectedArticle}
      <!-- Route points at an article the loaded set doesn't hold and the
           read-through couldn't resolve: still fetching, offline + not
           saved, or genuinely gone. The message picks among those. -->
      <p class="subtle wiki-empty">
        {missingRecordMessage({
          fetching: fetchingArticle,
          online: offlineStatus.online,
          noun: 'article',
        })}
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
                  <button type="button" onclick={declineManualUpdate}>Close</button>
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
                <!-- The reason is the changelog message for the BODY
                     edit, so only surface it when the body actually
                     changes. A records-only edit writes no body
                     changelog row (each record write logs its own). -->
                {#if manualPreview.title !== a.title || manualPreview.content !== a.content}
                  <p class="subtle wiki-preview-reason">
                    Changelog entry: <em>{manualPreview.reason}</em>
                  </p>
                {/if}
                {#if manualPreview.content !== a.content}
                  <div
                    class="wiki-content"
                    role="presentation"
                    onclick={onArticleClick}
                  >
                    <Markdown content={manualPreview.content} />
                  </div>
                {:else if manualRecordOpViews.length > 0}
                  <p class="subtle">
                    The article body is unchanged; only the records below
                    will change.
                  </p>
                {/if}
                {#if manualRecordOpViews.length > 0}
                  <div class="wiki-preview-records">
                    <h5>{recordOpsHeadline(manualRecordOpViews.length)}</h5>
                    <ul class="wiki-preview-record-list">
                      {#each manualRecordOpViews as op, i (i)}
                        <li class="wiki-preview-record wiki-preview-record-{op.kind}">
                          <span class="wiki-record-op-label">{op.label}</span>
                          {#if op.date}
                            <span class="subtle wiki-record-op-date">{op.date}</span>
                          {/if}
                          {#if op.content}
                            <span class="wiki-record-op-content">
                              {contentPreview(op.content, 160)}
                            </span>
                          {/if}
                        </li>
                      {/each}
                    </ul>
                  </div>
                {/if}
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
                    onclick={declineManualUpdate}
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
          Accept. .regen-target is shared with the chat regenerate
          flow (Chat.svelte applies it to the .msg bubble) so the
          language reads consistently across surfaces - see the
          definition in styles.css.
        -->
        <!--
          The onclick here is delegation only: it catches anchor clicks
          inside the article so `#slug` ToC links and `?cid=` source
          links can be intercepted for in-app navigation. The article
          element itself is never the interactive target; the actual
          interactive surfaces inside (buttons, anchors) carry their
          own keyboard handling.
        -->
        <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
        <!-- svelte-ignore a11y_click_events_have_key_events -->
        <article
          bind:this={articleEl}
          class="wiki-article"
          class:regen-target={manualTargetId === a.id}
          class:fading-out={fadingArticleId === a.id}
          onclick={onArticleClick}
        >
          <header class="wiki-header">
            <h1 class="wiki-title">{a.title}</h1>
            <div class="wiki-actions">
              <button
                type="button"
                class="icon-btn wiki-favorite-btn"
                class:active={a.favorite}
                onclick={() => toggleFavorite(a)}
                disabled={favoriteBusy}
                title={a.favorite
                  ? 'Saved offline (remove from favorites)'
                  : 'Save offline (mark as favorite)'}
                aria-label={a.favorite
                  ? 'Remove from favorites'
                  : 'Mark as favorite'}
                aria-pressed={a.favorite}
              >
                <!-- Star: filled when favorited (saved offline), outline
                     otherwise. Same fill-vs-stroke active convention as
                     the Cookbook bookmark glyphs. -->
                <svg
                  width="16"
                  height="16"
                  viewBox="0 0 24 24"
                  fill={a.favorite ? 'currentColor' : 'none'}
                  stroke="currentColor"
                  stroke-width="2"
                  stroke-linecap="round"
                  stroke-linejoin="round"
                  aria-hidden="true"
                >
                  <path
                    d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"
                  />
                </svg>
              </button>
              <button type="button" onclick={() => startEdit(a)}>Edit</button>
              <button type="button" onclick={() => startManualUpdate(a)}>
                Ask agent to update
              </button>
              <button type="button" onclick={() => requestDelete(a)} class="danger">
                Delete
              </button>
            </div>
          </header>
          {#if favoriteError}
            <p class="wiki-favorite-error" role="alert">{favoriteError}</p>
          {/if}
          {#if tocHeadings.length >= 2 || sectionTocLinks.length > 0}
            <!--
              Table of contents. Rendered before the article body so the
              reader sees the outline first; clicking an entry scrolls
              the corresponding heading into view within .wiki-body via
              onArticleClick (which sits on the surrounding <article>
              and intercepts both `#anchor` and `?cid=` links).
              Headings nest by level via nestHeadings(); a flat-with-
              one-heading article skips the heading list but still shows
              the appended-section links below when present.
            -->
            <nav class="wiki-toc" aria-label="Table of contents">
              <h2>Contents</h2>
              {#if tocHeadings.length >= 2}
                {@render tocList(tocItems)}
              {/if}
              {#if sectionTocLinks.length > 0}
                <!--
                  Links to the article's appended sections (Sources, See
                  also, Records). Records lives outside <article>, so its
                  anchor resolves via the document-lookup fallback in
                  onArticleClick. Separated from the heading list with a
                  rule when both are present.
                -->
                <ul
                  class="wiki-toc-sections"
                  class:has-divider={tocHeadings.length >= 2}
                >
                  {#each sectionTocLinks as link (link.id)}
                    <li><a href={`#${link.id}`}>{link.label}</a></li>
                  {/each}
                </ul>
              {/if}
            </nav>
          {/if}
          <div class="wiki-content">
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
            <aside class="wiki-sources" id={WIKI_SOURCES_ANCHOR} aria-label="Sources">
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
            <aside class="wiki-related" id={WIKI_SEE_ALSO_ANCHOR} aria-label="See also">
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

        <!-- Records section: dated entries linked to this article (the
             topic's journey), rendered below the article body (the
             current state). Keyed on a.id so switching articles remounts
             with a fresh load rather than leaking the prior list. -->
        {#key a.id}
          <WikiRecords article={a} onCount={(n) => (recordCount = n)} />
        {/key}

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

<!--
  Recursive snippet for the ToC. Svelte 5 snippets carry their own
  scope and can self-reference cleanly, so a nested outline (H2 with
  H3 children, etc.) renders as nested <ul>s without a separate
  component. Anchors carry `href="#slug"`; the click handler on the
  surrounding <article> intercepts and smooth-scrolls within the
  body so the surrounding chrome stays put.
-->
{#snippet tocList(items: TocNode[])}
  <ul>
    {#each items as item (item.slug)}
      <li>
        <a href="#{item.slug}">{item.text}</a>
        {#if item.children.length > 0}
          {@render tocList(item.children)}
        {/if}
      </li>
    {/each}
  </ul>
{/snippet}

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
    align-items: center;
  }
  /* Favorite (save-offline) toggle. Muted until active, then the brand
     accent fills the star - the same "active = accent" read the
     Cookbook bookmark buttons use. */
  .wiki-favorite-btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    color: var(--text-subtle, var(--text));
  }
  .wiki-favorite-btn.active {
    color: var(--accent, #f5a623);
  }
  .wiki-favorite-btn:disabled {
    opacity: 0.5;
    cursor: default;
  }
  .wiki-favorite-error {
    margin: 0 0 0.75rem 0;
    color: var(--danger, #c0392b);
    font-size: 0.85rem;
  }
  .wiki-content {
    line-height: 1.6;
    /* The reader-content text-shadow thickener is applied globally in
       src/styles.css (see "Main-section reader-content thickener"), not
       here, so all main-section content shares one weight step. */
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
  /* The manual-update form sits directly above the article body (see
     the placement comment at the use site). Without a bottom margin
     the form's border butts right up against the article's first
     heading and reads as one merged block. */
  .wiki-manual-update {
    margin-bottom: 1rem;
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
  /* Live step list shown under the librarian's custom-instructions
     textarea while a manual run is in flight. The spinner glyph
     mirrors the chat tool-row pattern - rotate the same Lekton-safe
     character (used by .tool-status.status-pending in styles.css)
     rather than swapping sprites. Steps are an <ol> for semantics
     but rendered without numbering since the labels already imply
     order. */
  .librarian-steps {
    list-style: none;
    padding: 0;
    margin: 0.25rem 0 0.75rem 0;
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
    font-size: 0.85rem;
    line-height: 1.35;
  }
  .librarian-step {
    display: flex;
    align-items: flex-start;
    gap: 0.5rem;
  }
  .librarian-step-glyph {
    display: inline-flex;
    width: 1.1rem;
    justify-content: center;
    flex-shrink: 0;
    font-size: 0.95rem;
    line-height: 1.2;
    /* Pull up slightly so the glyph optical-aligns to the first
       baseline of the label even when the label wraps onto two
       lines. */
    margin-top: 0.05rem;
  }
  .librarian-step-label {
    flex: 1;
    overflow-wrap: anywhere;
    word-break: break-word;
  }
  .librarian-step.status-pending .librarian-step-glyph {
    color: var(--muted);
    animation: librarian-step-spin 1.1s linear infinite;
  }
  .librarian-step.status-ok .librarian-step-glyph {
    color: var(--ok);
  }
  .librarian-step.status-error .librarian-step-glyph {
    color: var(--danger);
  }
  /* Settled steps muted slightly so the pending one (with the
     spinner) is the visual focus. The pending row keeps the
     default --text colour for emphasis. */
  .librarian-step.status-ok .librarian-step-label,
  .librarian-step.status-error .librarian-step-label {
    color: var(--muted);
  }
  @keyframes librarian-step-spin {
    from { transform: rotate(0deg); }
    to   { transform: rotate(360deg); }
  }
  @media (prefers-reduced-motion: reduce) {
    .librarian-step.status-pending .librarian-step-glyph {
      animation: none;
    }
  }
  /* Post-run result card. Visually mirrors the chat .msg.assistant
     bubble (surface bg + hairline + rounded corners) so the librarian
     reply reads as "a message from the agent" rather than a status
     panel - but locally scoped to avoid inheriting .msg's 80%-width
     centering, which would clip the card against the strip above.
     `min-width: 0` keeps long fenced article titles inside the
     <Markdown> render from blowing out the column. */
  .wiki-librarian-result {
    margin-top: 0.75rem;
    min-width: 0;
  }
  /* The librarian's final reply as an italic block quote - reads as
     "the agent said," set apart from the surrounding UI. The left rule
     is the block-quote affordance now that the bordered card is gone. */
  .wiki-librarian-summary {
    margin: 0;
    padding: 0.1rem 0 0.1rem 0.75rem;
    border-left: 3px solid var(--border);
    font-style: italic;
  }
  /* Trim the rendered markdown's outer paragraph margins so the quote
     sits tight against its rule; keep inter-paragraph spacing for a
     multi-line reply. */
  .wiki-librarian-summary :global(p:first-child) {
    margin-top: 0;
  }
  .wiki-librarian-summary :global(p:last-child) {
    margin-bottom: 0;
  }
  .wiki-librarian-result-meta {
    margin: 0.5rem 0 0 0;
    font-size: 0.85rem;
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

  /* Proposed record changes, previewed beneath the body diff. Each row
     leads with a kind-coloured action label (Add/Edit/Delete) so the
     user can scan the batch before accepting. */
  .wiki-preview-records {
    margin-top: 1rem;
    padding-top: 0.75rem;
    border-top: 1px dashed var(--border);
  }
  .wiki-preview-records h5 {
    margin: 0 0 0.5rem 0;
    font-size: 0.85rem;
    font-weight: 600;
    color: var(--muted);
    text-transform: uppercase;
    letter-spacing: 0.05em;
  }
  .wiki-preview-record-list {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 0.4rem;
  }
  .wiki-preview-record {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    gap: 0.4rem;
    font-size: 0.9rem;
  }
  .wiki-record-op-label {
    font-weight: 600;
    font-size: 0.75rem;
    text-transform: uppercase;
    letter-spacing: 0.03em;
    white-space: nowrap;
  }
  .wiki-preview-record-create .wiki-record-op-label {
    color: var(--success, #2e7d32);
  }
  .wiki-preview-record-update .wiki-record-op-label {
    color: var(--accent, var(--text));
  }
  /* Delete reuses the destructive cue the .danger button uses. */
  .wiki-preview-record-delete .wiki-record-op-label {
    color: var(--danger, #c62828);
  }
  .wiki-record-op-content {
    flex: 1 1 12rem;
    min-width: 0;
    color: var(--text);
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

  /* Article ToC. Sits between the title header and the body. Shares
     the small-uppercase-label visual contract with Sources / See also
     so the three article sub-sections read as a family. */
  .wiki-toc {
    margin: 0 0 1.5rem 0;
    padding: 0.75rem 1rem;
    border: 1px solid var(--border);
    border-radius: 0.5rem;
    background: var(--bg-2);
  }
  .wiki-toc h2 {
    margin: 0 0 0.4rem 0;
    font-size: 0.85rem;
    font-weight: 600;
    color: var(--muted);
    text-transform: uppercase;
    letter-spacing: 0.05em;
  }
  /* Top-level list flush with the heading; nested lists indent to
     visualise the outline. Bullets are drawn via ::before so we
     control the gutter independently of the browser's list-style
     default - on mobile the limited width makes the difference
     between a 1rem and a 1.5rem left gutter material. */
  .wiki-toc ul {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 0.35rem;
  }
  /* Each row carries a small bullet at the left edge. The hanging
     indent (padding-left + absolutely-positioned bullet at left:0)
     means wrapped lines align with the link text, not under the
     bullet - without that, a wrapped entry on a narrow viewport
     reads as a paragraph rather than as a list item. */
  .wiki-toc li {
    position: relative;
    padding-left: 0.85rem;
  }
  .wiki-toc li::before {
    content: '\2022'; /* U+2022 BULLET */
    position: absolute;
    left: 0;
    top: 0;
    color: var(--muted);
    line-height: 1.4;
    /* The bullet glyph reads slightly heavy at body font-size;
       trim it down so it's a marker, not a competing focal point. */
    font-size: 0.85em;
  }
  .wiki-toc ul ul {
    margin-top: 0.35rem;
    /* Indent alone communicates nesting; the previous border-left
       guide line conflicted with markdown's blockquote convention
       (vertical bar = quoted content) and read as a blockquote
       rather than as a child list. The bullets carry the "list
       item" signal on their own. */
    padding-left: 1rem;
    /* em (not rem) so each nested level compounds against its
       parent - L2 is 92% of L1, L3 is 92% of L2, etc. Gives a
       clear visual hierarchy without per-level rules. The bullet
       ::before above uses 0.85em, which scales down alongside the
       text at each level. */
    font-size: 0.92em;
  }
  .wiki-toc a {
    color: var(--accent, var(--text));
    text-decoration: none;
    line-height: 1.4;
  }
  .wiki-toc a:hover,
  .wiki-toc a:focus-visible {
    text-decoration: underline;
  }
  /* Appended-section links (Sources / See also / Records) inherit the
     ToC list styling above. When the heading outline is also present,
     a hairline rule + spacing separates the two groups so the section
     jumps read as a distinct cluster below the content outline. */
  .wiki-toc-sections.has-divider {
    margin-top: 0.6rem;
    padding-top: 0.6rem;
    border-top: 1px solid var(--border);
  }
</style>
