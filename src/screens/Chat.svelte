<script lang="ts">
  /*
   * The main screen. Three concerns stacked top-to-bottom:
   *
   *   top-bar   — hamburger, title (inline renameable), model tier toggle
   *   messages  — scrollable list of bubbles, plus in-flight streaming text
   *   composer  — textarea + expand button + send button
   *
   * Threads come in two flavors:
   *   - Persisted threads: live in Supabase, have real ids, load messages
   *     on select.
   *   - Drafts: local-only, have client-side UUIDs, flagged via
   *     `isDraft`. Created by newThread(); materialized to Supabase on
   *     the first `send` or manual rename (see materializeIfDraft).
   *     Abandoned drafts disappear on refresh because they aren't stored.
   *
   * Streaming lifecycle:
   *   1. User clicks send → insert user message row → clear composer.
   *   2. Kick off `app.venice.streamChat` with an AbortController.
   *      Deltas append into `streamingText`, which renders as an
   *      "assistant" bubble below the persisted messages.
   *   3. When the stream completes: insert an assistant message row,
   *      clear streamingText, refresh the thread list so the sidebar
   *      ordering reflects updated_at.
   *   4. First exchange of a new thread triggers `autoTitle` in the
   *      background — see that helper for the tradeoffs.
   *
   * Model selection:
   *   - The top-right toggle sets a per-thread override (threads.model).
   *   - Clicking the tier that matches the user's default clears the
   *     override (writes null) so the thread keeps tracking default
   *     changes — see setTier().
   */
  import { onMount, tick } from 'svelte';
  import type { Session } from '@supabase/supabase-js';
  import {
    app,
    lock,
    setDefaultModel,
    setDefaultReasoningEffort,
    setDefaultVerbosity,
    setSystemPrompts,
    setTheme,
    setWebSearchEnabled,
  } from '$lib/state.svelte';
  import { clearSession, getSessionThreadId, setSessionThreadId } from '$lib/session';
  import { route, navigate, buildSearch } from '$lib/routing.svelte';
  import {
    DEFAULT_THREAD_PAGE_SIZE,
    RECENT_THREAD_CUTOFF_MS,
    type Thread,
    type ThreadCursor,
    type ThreadSearchHit,
    type Message,
    type NewAttachment,
  } from '$lib/supabase';
  import { runChatLoop, toVeniceMessage } from '$lib/chat-loop';
  import { drainSharesForComposer } from '$lib/share-intake';
  import {
    arrayBufferToBase64,
    formatBytes,
    isConsumableBy,
    isImageMimeType,
    maybeDownscaleImage,
    MAX_ATTACHMENTS_PER_MESSAGE,
    MAX_MESSAGE_AGGREGATE_BYTES,
    toNewAttachment,
    validateFile,
    type LocalAttachment,
  } from '$lib/attachments';
  import {
    DEFAULT_REASONING_EFFORT,
    DEFAULT_TIER,
    DEFAULT_VERBOSITY,
    MODELS,
    TIERS,
    UTILITY_TIER,
    VENICE_EMBEDDING_MODEL,
    padEmbeddingForStorage,
    resolveReasoningEffort,
    resolveTier,
    resolveVerbosity,
    type ModelSpec,
    type ModelTier,
    type ReasoningEffort,
    type Verbosity,
  } from '$lib/models';
  import Auth from './Auth.svelte';
  import Help from './Help.svelte';
  import Memories from './Memories.svelte';
  import Settings from './Settings.svelte';
  import Cookbook from './Cookbook.svelte';
  import {
    cookbook,
    loadRecipes,
    COOKBOOK_CHANGE_EVENT,
  } from '$lib/cookbook-store.svelte';
  import AssistantBody from '../components/AssistantBody.svelte';
  import CitationsPanel from '../components/CitationsPanel.svelte';
  import Markdown from '../components/Markdown.svelte';
  import ReasoningPanel from '../components/ReasoningPanel.svelte';
  import ReasoningPicker from '../components/ReasoningPicker.svelte';
  import VerbosityPicker from '../components/VerbosityPicker.svelte';
  import Scanner from '../components/Scanner.svelte';
  import ToolCalls from '../components/ToolCalls.svelte';
  import MessageAttachments from '../components/MessageAttachments.svelte';
  import ExtractedTextDrawer from '../components/ExtractedTextDrawer.svelte';
  import LogsDrawer from '../components/LogsDrawer.svelte';
  import SamskaraToasts from '../components/SamskaraToasts.svelte';
  import { logsDrawer, createLogger } from '$lib/logger.svelte';

  const log = createLogger('chat');
  import { VeniceError, type Citation, type VeniceMessage } from '$lib/venice';

  const DEFAULT_TITLE = 'New conversation';

  let session = $state<Session | null>(null);
  let sessionLoaded = $state(false);
  // Modal flags + sidebar tab + active thread id all derive from the
  // URL-driven `route` state (see src/lib/routing.svelte.ts). That
  // keeps back / forward / refresh working: each user-visible nav is
  // a pushState, and on mount we parse the URL back into `route`
  // before anything reads it. Writes go through `navigate({...})`
  // rather than direct assignment so the push-vs-replace decision is
  // explicit per call site.
  const showSettings = $derived(route.modal === 'settings');
  const showHelp = $derived(route.modal === 'help');
  const showMemories = $derived(route.modal === 'memories');
  const showCookbook = $derived(route.modal === 'cookbook');
  /**
   * Sidebar drawer tab. Backed by `route.drawer` - absent in the URL
   * means "chats" (the default). 'recipes' renders the cookbook list
   * in place of the thread list. Tab switches use replaceState so a
   * chats<->recipes flip doesn't fill history with UI-chrome entries.
   */
  const drawerTab = $derived<'chats' | 'recipes'>(route.drawer ?? 'chats');
  /** Recipe-side search, separate from conversation search. */
  let recipeDrawerQuery = $state('');
  const visibleDrawerRecipes = $derived.by(() => {
    const q = recipeDrawerQuery.trim().toLowerCase();
    if (q.length === 0) return cookbook.recipes;
    return cookbook.recipes.filter((r) => r.title.toLowerCase().includes(q));
  });

  function onPickRecipesTab(): void {
    navigate({ drawer: 'recipes' }, { replace: true });
    // Load lazily - a user who never opens the Recipes tab shouldn't
    // pay for an extra Supabase round trip on every unlock. Once
    // loaded the list is kept fresh by the COOKBOOK_CHANGE_EVENT
    // listener registered in onMount below.
    if (app.supabase && cookbook.recipes.length === 0 && !cookbook.loading) {
      void loadRecipes(app.supabase);
    }
  }

  // When the user (or a popstate pop) lands on `?drawer=recipes`
  // without having gone through onPickRecipesTab, still make sure the
  // recipe list is fetched so the drawer isn't blank.
  $effect(() => {
    if (route.drawer !== 'recipes') return;
    if (!app.supabase) return;
    if (cookbook.recipes.length !== 0 || cookbook.loading) return;
    void loadRecipes(app.supabase);
  });

  function openRecipeFromDrawer(id: string): void {
    navigate({ modal: 'cookbook', recipe: id });
  }

  function onCookbookModalClose(): void {
    navigate({ modal: null, recipe: null });
  }

  function onCookbookStoreChanged(): void {
    // Any recipe_* tool call or modal write invalidates the list —
    // reload if we've ever loaded it, so the Recipes drawer tab and
    // the modal (if still open) both reflect the new state.
    if (!app.supabase) return;
    if (cookbook.recipes.length === 0 && !cookbook.loading) return;
    void loadRecipes(app.supabase);
  }

  let activeThreadId = $state<string | null>(null);
  // URL->component reconciliation. When `route.cid` changes without
  // going through selectThread - i.e. the user hit Back/Forward and
  // popstate fired syncFromUrl - pull the current thread to match.
  // selectThread itself sets `activeThreadId` first and then navigates,
  // so this effect sees them already in sync and no-ops. Called with
  // `null` when the URL clears the cid (leaving chat with no thread).
  $effect(() => {
    if (route.cid === activeThreadId) return;
    void selectThread(route.cid);
  });
  let messages = $state<Message[]>([]);
  let streamingText = $state('');
  // Live companions to streamingText during a turn. `streamingReasoning`
  // is the running buffer of `delta.reasoning_content` chunks for the
  // current round; `streamingCitations` is Venice's web_search_citations
  // once they arrive on the first chunk. Both are reset when the
  // assistant row persists and a new round begins.
  //
  // `streamingReasoningOpen` drives the slide-open state of the live
  // reasoning panel. We flip it on the first reasoning delta, then —
  // once the visible answer starts flowing — schedule a timer to
  // animate it shut. Value persists across the transition so the
  // intermediate "still streaming content with reasoning tucked away"
  // state has somewhere to sit.
  let streamingReasoning = $state('');
  let streamingCitations = $state<Citation[] | null>(null);
  let streamingReasoningOpen = $state(false);
  // Timer id for the delayed-close on first content arrival. Separated
  // from the text-flush timer because they have different lifetimes —
  // the close fires once per round, the flush fires on every delta.
  let reasoningCloseTimer = 0;
  // Sticky flag: flipped on the first content delta of a round and
  // NOT reset until that round ends (assistant persisted / stream
  // errored). Prevents `onReasoningUpdate` from re-opening the panel
  // after the auto-close timer has already fired — some reasoning
  // models interleave a late thought or two after the first visible
  // sentence, and the panel jumping back open on that reads as a
  // misfire rather than a feature.
  let streamingContentStarted = false;

  // Drawer state: four separate buckets.
  //   drafts         — local-only threads the user has started but not
  //                    sent anything in. Never in Supabase.
  //   recentThreads  — non-archived, `updated_at >= recentCutoff`.
  //                    Eagerly loaded; we expect a handful.
  //   olderThreads   — non-archived, `updated_at <  recentCutoff`.
  //                    Paginated infinite-scroll (see olderCursor).
  //   archivedPage   — archived threads. Paginated the same way; the
  //                    section starts collapsed, the user unfolds it
  //                    to see/scroll.
  //
  // The partition lives here rather than as $derived-filters over a flat
  // `threads` list because pagination means "not all threads are
  // loaded." A single source of truth would silently drop threads the
  // drawer hasn't fetched yet, and "active thread" bookkeeping would
  // start producing wrong answers for deep-in-Older conversations.
  let drafts = $state<Thread[]>([]);
  let recentThreads = $state<Thread[]>([]);
  let olderThreads = $state<Thread[]>([]);
  let archivedPage = $state<Thread[]>([]);

  // Pagination cursors + flags. `null` cursor = "haven't fetched yet OR
  // no more pages". The distinction lives on `*HasMore`: true until a
  // fetch returns `nextCursor === null`, at which point we stop hitting
  // the sentinel.
  let olderCursor = $state<ThreadCursor | null>(null);
  let olderHasMore = $state(true);
  let olderLoading = $state(false);
  let archivedCursor = $state<ThreadCursor | null>(null);
  let archivedHasMore = $state(true);
  let archivedLoading = $state(false);

  // Recent-bucket cutoff — pinned at refresh time so a thread at the
  // 72h boundary doesn't ping-pong between Recent and Older every
  // second. Recomputed whenever we do a full `refreshThreads` (which is
  // already an explicit "reload" moment from the user's perspective).
  let recentCutoff = $state<string>(new Date(Date.now() - RECENT_THREAD_CUTOFF_MS).toISOString());

  /** All threads currently loaded into any bucket, drafts included. */
  const loadedThreads = $derived<Thread[]>([
    ...drafts,
    ...recentThreads,
    ...olderThreads,
    ...archivedPage,
  ]);

  function findThread(id: string): Thread | undefined {
    return loadedThreads.find((t) => t.id === id);
  }

  /**
   * Apply a partial update to whichever bucket currently holds `id`.
   * No-op if the thread isn't loaded (e.g. a realtime update for a
   * thread buried deep in Older that the user hasn't paginated to
   * yet). Safe to call for a patch that doesn't cross bucket
   * boundaries — use `rebucketThread` when archived or updated_at
   * might cause a bucket migration.
   */
  function patchThread(id: string, patch: Partial<Thread>): void {
    drafts = drafts.map((t) => (t.id === id ? { ...t, ...patch } : t));
    recentThreads = recentThreads.map((t) => (t.id === id ? { ...t, ...patch } : t));
    olderThreads = olderThreads.map((t) => (t.id === id ? { ...t, ...patch } : t));
    archivedPage = archivedPage.map((t) => (t.id === id ? { ...t, ...patch } : t));
  }

  /** Remove a thread from every bucket. */
  function removeThread(id: string): void {
    drafts = drafts.filter((t) => t.id !== id);
    recentThreads = recentThreads.filter((t) => t.id !== id);
    olderThreads = olderThreads.filter((t) => t.id !== id);
    archivedPage = archivedPage.filter((t) => t.id !== id);
  }

  /** Classify a thread into its current bucket. Drafts are a special
   *  case — their user-facing placement is always "top of Recent" but
   *  internally they live in the drafts array. */
  function bucketFor(t: Thread): 'draft' | 'recent' | 'older' | 'archived' {
    if (t.isDraft) return 'draft';
    if (t.archived) return 'archived';
    return t.updated_at >= recentCutoff ? 'recent' : 'older';
  }

  /**
   * Insert or move a server-sourced thread into the right bucket. Used
   * by the realtime subscription's onInsert/onUpdate handlers. Pulls
   * the thread out of every other bucket first — a cross-bucket
   * migration (archive toggle; an `updated_at` bump that crosses the
   * 3-day cutoff) is exactly "remove from old, insert into new."
   */
  function rebucketThread(t: Thread): void {
    // Strip from every bucket so a cross-bucket migration doesn't
    // leave a stale copy behind.
    recentThreads = recentThreads.filter((x) => x.id !== t.id);
    olderThreads = olderThreads.filter((x) => x.id !== t.id);
    archivedPage = archivedPage.filter((x) => x.id !== t.id);
    switch (bucketFor(t)) {
      case 'recent':
        recentThreads = insertByUpdatedAtDesc(recentThreads, t);
        break;
      case 'older':
        // Only slot into Older if the thread sorts ahead of the
        // current pagination cursor. A thread the user hasn't scrolled
        // down to yet shouldn't jump into view from a realtime echo —
        // it'll load when the user scrolls.
        if (!olderCursor || sortsAheadOfCursor(t, olderCursor)) {
          olderThreads = insertByUpdatedAtDesc(olderThreads, t);
        }
        break;
      case 'archived':
        if (!archivedCursor || sortsAheadOfCursor(t, archivedCursor)) {
          archivedPage = insertByUpdatedAtDesc(archivedPage, t);
        }
        break;
      case 'draft':
        // Drafts don't come from the server — nothing to do.
        break;
    }
  }

  function sortsAheadOfCursor(t: Thread, c: ThreadCursor): boolean {
    // (updated_at desc, id desc) ordering: a row "ahead of" the cursor
    // is strictly greater than the cursor under that ordering.
    if (t.updated_at > c.updated_at) return true;
    if (t.updated_at < c.updated_at) return false;
    return t.id > c.id;
  }

  function insertByUpdatedAtDesc(arr: Thread[], t: Thread): Thread[] {
    // Keep the existing ordering (already sorted desc). Binary insert
    // would be faster in principle, but the bucket sizes are small
    // enough that a linear scan is simpler and just as quick.
    const idx = arr.findIndex((x) => t.updated_at > x.updated_at);
    if (idx === -1) return [...arr, t];
    return [...arr.slice(0, idx), t, ...arr.slice(idx)];
  }

  function mergeByUpdatedAtDesc(a: Thread[], b: Thread[]): Thread[] {
    // Merge two already-sorted-desc lists into one, deduping by id.
    // Used by the scroll-to-search-result path (`openSearchResult`)
    // which window-fetches a range of threads and needs to splice
    // them into the paginated list without upsetting ordering.
    const out: Thread[] = [];
    const seen = new Set<string>();
    let i = 0;
    let j = 0;
    while (i < a.length && j < b.length) {
      if (seen.has(a[i].id)) {
        i++;
        continue;
      }
      if (seen.has(b[j].id)) {
        j++;
        continue;
      }
      if (a[i].updated_at >= b[j].updated_at) {
        out.push(a[i]);
        seen.add(a[i].id);
        i++;
      } else {
        out.push(b[j]);
        seen.add(b[j].id);
        j++;
      }
    }
    for (; i < a.length; i++) if (!seen.has(a[i].id)) { out.push(a[i]); seen.add(a[i].id); }
    for (; j < b.length; j++) if (!seen.has(b[j].id)) { out.push(b[j]); seen.add(b[j].id); }
    return out;
  }

  // Per-row action menu and long-press state for the drawer. Long-press
  // opens the menu on touch; the trailing click is suppressed via
  // `suppressNextClick` so lifting the finger doesn't also select the
  // thread and close the drawer on mobile.
  let openMenuThreadId = $state<string | null>(null);
  let archiveExpanded = $state(false);
  let longPressTimer: ReturnType<typeof setTimeout> | null = null;
  let suppressNextClick = false;

  /**
   * In-memory latency tracking for tool calls in the current session.
   * Populated by the chat-loop's onToolStart / onToolDone / onToolError
   * handlers and read by the ToolCalls component. Wiped on navigation
   * (fresh thread selection clears this) because "how long did this
   * take when it originally ran?" isn't a question we bother to
   * persist — reopened conversations show only the final status
   * glyph and hide the pill.
   */
  let toolTimings = $state<Record<string, { startedAt: number; endedAt?: number; error?: boolean }>>(
    {}
  );
  /**
   * Live monotonic clock, driven by rAF while any tool is in flight and
   * frozen when everything is idle. Drives the live-duration pill in
   * ToolCalls. Using performance.now() because Date.now() is clamped on
   * a 1ms boundary and can go backwards.
   */
  let nowMs = $state<number>(typeof performance !== 'undefined' ? performance.now() : 0);
  $effect(() => {
    const pending = Object.values(toolTimings).some((t) => t.endedAt === undefined);
    if (!pending) return;
    let raf = 0;
    const tick = (): void => {
      nowMs = performance.now();
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  });
  let composer = $state('');
  let composerEl: HTMLTextAreaElement | undefined = $state();
  let sending = $state(false);
  // Error banner state. `retry` is populated only for transient failures
  // where re-firing the exact same request is meaningful (rate-limit so
  // far) — it re-runs the chat loop with the captured history so the
  // user doesn't have to retype. A fresh error assignment replaces any
  // earlier retry closure; the banner only ever owns one.
  type ChatError = { text: string; retry?: () => void };
  let error = $state<ChatError | null>(null);
  let abortCtl: AbortController | null = null;

  // Pending attachments — one chip per queued file. Populated by the
  // file picker, the paste handler, and the drop handler; cleared on
  // send or explicit remove. Entries start with `pending: true` until
  // their extracted-text / downscale round-trip finishes.
  let pendingAttachments = $state<LocalAttachment[]>([]);
  // Hidden file input the paperclip button triggers via .click(); kept
  // in a ref so we can reset its `value` after every pick (so picking
  // the same file twice still fires `change`).
  let fileInputEl: HTMLInputElement | undefined = $state();
  // Counter for drag-enter / drag-leave balance. A single boolean
  // would flicker off when the cursor moves from the overlay onto a
  // child element (another dragenter fires before the dragleave
  // bubbles). Tracking a counter survives the sub-element traversal
  // and reads 0 only when the drag has actually left the zone.
  let dragDepth = $state(0);
  const isDragging = $derived(dragDepth > 0);

  // Stable-ish random ids for the client-side LocalAttachment rows.
  // crypto.randomUUID is universal in modern browsers; the fallback
  // is for the test environment where jsdom sometimes lacks it.
  function newLocalId(): string {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
      return crypto.randomUUID();
    }
    return `la-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  }

  // Total bytes across all currently-pending attachments. Used by the
  // add-file path to reject files that would push the message past
  // the aggregate cap. Cheap enough to recompute each call.
  function pendingBytes(): number {
    return pendingAttachments.reduce((n, a) => n + a.size_bytes, 0);
  }

  /**
   * Add one file to the composer. Handles the full add-time flow:
   * validate, image-downscale for images, base64-encode, kick off the
   * Venice text-parser call for non-image files. The chip appears
   * immediately (with `pending: true`) so the user sees progress;
   * when its async work finishes, the chip flips to ready and the
   * send button unblocks.
   */
  async function addAttachment(file: File): Promise<void> {
    if (pendingAttachments.length >= MAX_ATTACHMENTS_PER_MESSAGE) {
      error = {
        text: `You can attach at most ${MAX_ATTACHMENTS_PER_MESSAGE} files per message.`,
      };
      return;
    }
    const perFileReason = validateFile(file);
    if (perFileReason) {
      error = { text: `${file.name}: ${perFileReason}` };
      return;
    }
    if (pendingBytes() + file.size > MAX_MESSAGE_AGGREGATE_BYTES) {
      error = {
        text: `Total attachment size exceeds ${formatBytes(MAX_MESSAGE_AGGREGATE_BYTES)}.`,
      };
      return;
    }
    error = null;

    const id = newLocalId();
    // Insert the pending chip first so the user sees feedback while
    // we encode / extract. Mutated in place once the async work lands.
    const draft: LocalAttachment = {
      id,
      filename: file.name,
      mime_type: file.type || 'application/octet-stream',
      size_bytes: file.size,
      data_base64: '',
      extracted_text: null,
      pending: true,
      error: null,
    };
    pendingAttachments = [...pendingAttachments, draft];

    try {
      // Images: downscale if oversize, then encode. Non-images: encode
      // as-is and hit Venice text-parser.
      let finalFile: File | null = file;
      if (isImageMimeType(file.type)) {
        finalFile = await maybeDownscaleImage(file);
        if (!finalFile) throw new Error('Could not decode image.');
      }
      const buffer = await finalFile.arrayBuffer();
      const base64 = arrayBufferToBase64(buffer);

      let extractedText: string | null = null;
      if (!isImageMimeType(finalFile.type) && app.venice) {
        // Fire the text-parser call. We treat failure here as a
        // non-blocking error on the chip — the user gets a red chip
        // with an explanation, and the pre-send guard blocks until
        // they remove or retry.
        try {
          extractedText = await app.venice.extractText(finalFile, finalFile.name);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          patchAttachment(id, {
            pending: false,
            error: `Text extraction failed: ${msg}`,
          });
          return;
        }
      }

      patchAttachment(id, {
        size_bytes: finalFile.size,
        mime_type: finalFile.type || draft.mime_type,
        data_base64: base64,
        extracted_text: extractedText,
        pending: false,
        error: null,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      patchAttachment(id, { pending: false, error: msg });
    }
  }

  function patchAttachment(id: string, patch: Partial<LocalAttachment>): void {
    pendingAttachments = pendingAttachments.map((a) =>
      a.id === id ? { ...a, ...patch } : a
    );
  }

  function removeAttachment(id: string): void {
    pendingAttachments = pendingAttachments.filter((a) => a.id !== id);
    if (pendingAttachments.length === 0) error = null;
  }

  async function onFilePicker(): Promise<void> {
    fileInputEl?.click();
  }

  async function onFileInputChange(e: Event): Promise<void> {
    const input = e.target as HTMLInputElement;
    const files = Array.from(input.files ?? []);
    // Reset the input's value so picking the same file twice still
    // fires `change`. Do this before the awaits so a re-click during
    // upload doesn't race.
    input.value = '';
    for (const file of files) {
      // Sequential so the aggregate-size check sees the running total
      // from the previous adds. The Venice text-parser calls are the
      // dominant latency; in practice users attach 1–3 files.
       
      await addAttachment(file);
    }
  }

  async function onComposerPaste(e: ClipboardEvent): Promise<void> {
    const items = e.clipboardData?.items;
    if (!items) return;
    const files: File[] = [];
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      if (item.kind === 'file') {
        const f = item.getAsFile();
        if (f) files.push(f);
      }
    }
    if (files.length === 0) return;
    // preventDefault only when we consumed files — otherwise text
    // pastes would lose their default behavior (populating the
    // textarea).
    e.preventDefault();
    for (const f of files) {
       
      await addAttachment(f);
    }
  }

  function onComposerDragEnter(e: DragEvent): void {
    if (!e.dataTransfer) return;
    if (!Array.from(e.dataTransfer.types).includes('Files')) return;
    dragDepth += 1;
  }

  function onComposerDragOver(e: DragEvent): void {
    if (!e.dataTransfer) return;
    if (!Array.from(e.dataTransfer.types).includes('Files')) return;
    // Signal that a drop here is accepted — without this the browser
    // falls back to "not allowed" cursor and the drop event never
    // fires.
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
  }

  function onComposerDragLeave(): void {
    if (dragDepth > 0) dragDepth -= 1;
  }

  async function onComposerDrop(e: DragEvent): Promise<void> {
    dragDepth = 0;
    if (!e.dataTransfer) return;
    const files = Array.from(e.dataTransfer.files ?? []);
    if (files.length === 0) return;
    e.preventDefault();
    for (const f of files) {
       
      await addAttachment(f);
    }
  }

  // Auto-grow the composer so the caret is always visible as the user
  // types. CSS caps the textarea at 40vh — once content exceeds that
  // the element scrolls internally. We reset height to auto first so
  // deletes shrink the box back down to the natural content height.
  $effect(() => {
    void composer;
    const el = composerEl;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight}px`;
  });

  // Append a message if we don't already have a row with that id.
  // Dedupe is load-bearing: the device that writes a message also
  // receives the realtime echo of its own insert, and the echo can
  // arrive before or after `addMessage` resolves — either way we'd
  // otherwise double-up the row. The $effect below writes via this
  // helper; the send path calls it explicitly.
  //
  // Upgrade-on-dup: when an incoming row carries attachments that the
  // existing row lacks, REPLACE the existing row instead of skipping.
  // Fixes the local race where realtime echoes a user-row INSERT
  // before attachment rows are persisted — without the upgrade, the
  // attachment-less echo wins, `toVeniceMessage` sees no attachments,
  // and images never reach vision models. Symmetric for the cross-tab
  // path: the subscribe handler re-fires appendMessage after
  // hydrating attachments so the upgrade runs there too.
  function appendMessage(msg: Message): void {
    const existingIdx = messages.findIndex((m) => m.id === msg.id);
    if (existingIdx === -1) {
      messages = [...messages, msg];
      return;
    }
    const existing = messages[existingIdx];
    const incomingHasAttachments = !!msg.attachments && msg.attachments.length > 0;
    const existingHasAttachments =
      !!existing.attachments && existing.attachments.length > 0;
    if (incomingHasAttachments && !existingHasAttachments) {
      const updated = [...messages];
      updated[existingIdx] = msg;
      messages = updated;
    }
  }

  // Insertion ordering across the three buckets is "updated_at desc,
  // id desc tiebreak" — same as the server-side ORDER BY in the
  // pagination RPCs. The single-row insertion helper lives on
  // `insertByUpdatedAtDesc` below; no caller needs the full re-sort
  // variant, so it's not exposed.

  // Realtime: follow the active thread's messages. Re-runs whenever
  // `activeThreadId` changes, so switching threads tears down the
  // previous channel and opens a new one. Drafts are skipped because
  // they don't exist in Supabase yet — there's nothing to sync until
  // the draft materializes, at which point activeThreadId flips to
  // the real id and the effect re-subscribes.
  $effect(() => {
    if (!app.supabase || !activeThreadId) return;
    const active = findThread(activeThreadId);
    if (active?.isDraft) return;
    const threadId = activeThreadId;
    return app.supabase.subscribeToMessages(threadId, (msg) => {
      // Ignore echoes for threads we've since left — the effect's
      // teardown will run, but a message queued in-flight may still
      // reach this closure before removeChannel completes.
      if (activeThreadId !== threadId) return;
      appendMessage(msg);
      // Hydrate attachments for user rows. The realtime payload only
      // carries the `messages` row — Postgres replication doesn't
      // join across tables — so a user message that was sent with
      // files reaches the subscriber with `attachments` unset. Fire
      // a follow-up fetch and re-append; `appendMessage`'s upgrade
      // path replaces the placeholder with the hydrated row.
      //
      // Covers two scenarios:
      //   1. Local sender race — the sender's own `appendMessage(userMsg)`
      //      with attachments already lands via the upgrade path; this
      //      hydration is a defensive second attempt for the case where
      //      the realtime echo arrives but the local path never fires
      //      (e.g. an error between addMessage and addAttachments).
      //   2. Cross-tab sync — tab B sees the INSERT from tab A and
      //      needs to fetch attachments itself; this is the only path
      //      that does it.
      //
      // Fire-and-forget: a failure here just leaves the row without
      // attachments in this tab. The next full `listMessages` on
      // reload (or a re-subscribe) hydrates correctly.
      if (msg.role === 'user' && app.supabase) {
        void app.supabase
          .listAttachmentsByMessageIds([msg.id])
          .then((byId) => {
            if (activeThreadId !== threadId) return;
            const attachments = byId.get(msg.id) ?? [];
            if (attachments.length === 0) return;
            appendMessage({ ...msg, attachments });
          })
          .catch(() => {
            // Swallowed intentionally — best-effort hydration, see above.
          });
      }
    });
  });

  // Realtime: follow the current user's thread list. Covers the
  // sidebar across devices — creates, renames, model/tools toggles,
  // auto-titles, deletes, and `updated_at` bumps on each send all
  // propagate without the user refreshing. RLS enforces the
  // user_id scoping; the filter here just narrows wire traffic.
  $effect(() => {
    if (!app.supabase || !session) return;
    const userId = session.user.id;
    return app.supabase.subscribeToThreads(userId, {
      onInsert: (t) => {
        // The device that created the thread already has it locally
        // (createThread / newThread pushed it); skip the echo.
        if (findThread(t.id)) return;
        rebucketThread(t);
      },
      onUpdate: (t) => {
        // Three cases rolled into one call to rebucketThread:
        //   1. archived flipped → migrate between archivedPage and
        //      recent/older.
        //   2. updated_at bumped past the Recent/Older cutoff →
        //      migrate between those two buckets.
        //   3. Plain in-bucket update (rename, model change, tools
        //      toggle) → remove + re-insert in the same bucket so the
        //      updated_at ordering reflects the bump.
        // `isDraft` is main-thread-only and never round-trips through
        // the server, so the incoming row can't clobber it — but
        // drafts wouldn't match realtime filters anyway (they have no
        // row in Supabase).
        const existing = findThread(t.id);
        if (existing?.isDraft) return; // shouldn't happen — drafts aren't in Supabase
        rebucketThread(t);
      },
      onDelete: (id) => {
        removeThread(id);
        // Another device just deleted the thread we're looking at -
        // close it rather than keep rendering messages that no
        // longer have a home.
        if (activeThreadId === id) {
          activeThreadId = null;
          messages = [];
          setSessionThreadId(null);
          navigate({ cid: null });
        }
      },
    });
  });

  // Inline title rename state.
  let renaming = $state(false);
  let renameBuffer = $state('');
  let titleInputEl: HTMLInputElement | undefined = $state();

  onMount(() => {
    if (!app.supabase) return;
    const unsubscribe = app.supabase.onAuthChange((s) => {
      session = s;
      sessionLoaded = true;
      if (s) {
        void refreshThreads();
        void refreshSettings();
      } else {
        drafts = [];
        recentThreads = [];
        olderThreads = [];
        archivedPage = [];
      }
    });
    void app.supabase.getSession().then((s) => {
      session = s;
      sessionLoaded = true;
      if (s) {
        void refreshThreads();
        void refreshSettings();
      }
    });
    // Web Share Target drain. The service worker (src/sw.ts) stashes
    // incoming shares in IndexedDB and redirects here with
    // `?share=pending` as a navigation signal. We drain unconditionally
    // though — so a share that arrived while the app was locked gets
    // picked up when the user eventually unlocks, even if the URL flag
    // has since been stripped by a manual refresh. Content is merged
    // into whatever the user already typed rather than clobbering it.
    void drainSharesForComposer().then(async (shared) => {
      if (!shared) return;
      composer = composer ? `${composer}\n\n${shared}` : shared;
      if (location.search.includes('share=pending')) {
        // buildSearch drops only the routing keys we own, so
        // ?share=pending gets stripped while routed state
        // (?cid=..., ?modal=..., etc.) rides through untouched.
        const clean = location.pathname + buildSearch(route) + location.hash;
        history.replaceState(null, '', clean);
      }
      await tick();
      composerEl?.focus();
    });
    // Cookbook change listener. Fires when a recipe_* tool call
    // succeeds, so the drawer tab's list reflects a model-driven
    // save without the user having to reopen the tab. We only
    // reload when we've already loaded at least once — a fresh
    // unlock that never opened the Recipes tab stays lazy.
    window.addEventListener(COOKBOOK_CHANGE_EVENT, onCookbookStoreChanged);
    return () => {
      unsubscribe();
      window.removeEventListener(COOKBOOK_CHANGE_EVENT, onCookbookStoreChanged);
    };
  });

  async function refreshSettings(): Promise<void> {
    if (!app.supabase) return;
    try {
      const s = await app.supabase.getSettings();
      if (s.defaultModel) setDefaultModel(s.defaultModel);
      if (s.defaultReasoningEffort) setDefaultReasoningEffort(s.defaultReasoningEffort);
      if (s.defaultVerbosity) setDefaultVerbosity(s.defaultVerbosity);
      // If the server has a theme choice and it differs from the cached one,
      // apply it now. setTheme also re-caches, so subsequent loads are fast.
      if (s.colorMode || s.accent) {
        setTheme(s.colorMode ?? app.colorMode, s.accent ?? app.accent);
      }
      setSystemPrompts(s.systemPrompts ?? []);
      // Only a literal `false` flips web search off — an absent value
      // keeps the enabled-by-default seed set in state.svelte.ts.
      setWebSearchEnabled(s.webSearchEnabled !== false);
      // Only (re)seed the active set if the user hasn't already started
      // toggling prompts on the current thread. Avoids clobbering their
      // per-thread selection when settings arrive late.
      if (activePromptIds.size === 0) resetActivePromptsToDefaults();
    } catch {
      // Best-effort: fall back to DEFAULT_TIER / cached theme from activate().
    }
  }

  // True once we've attempted to restore the last-open thread from the
  // session blob — ensures we only do it on the first threads fetch.
  let threadRestoreAttempted = false;

  /**
   * Full reload of the drawer's three server-sourced buckets. Drafts
   * are local-only and survive a refresh unchanged. Pins a fresh
   * `recentCutoff` so the Recent/Older partition matches the data we
   * just fetched — otherwise a thread whose `updated_at` is exactly
   * the old cutoff could end up in the wrong bucket.
   *
   * The three fetches run in parallel. The Older and Archived pages
   * each come with their first-page cursor; subsequent pages load via
   * `loadMoreOlder` / `loadMoreArchived` on IntersectionObserver
   * intersection.
   */
  async function refreshThreads(): Promise<void> {
    if (!app.supabase) return;
    try {
      const cutoff = new Date(Date.now() - RECENT_THREAD_CUTOFF_MS).toISOString();
      recentCutoff = cutoff;
      const [recent, older, archived] = await Promise.all([
        app.supabase.listRecentThreads(cutoff),
        app.supabase.listOlderThreads({ cutoff, cursor: null, pageSize: DEFAULT_THREAD_PAGE_SIZE }),
        app.supabase.listArchivedThreads({ cursor: null, pageSize: DEFAULT_THREAD_PAGE_SIZE }),
      ]);
      recentThreads = recent;
      olderThreads = older.rows;
      olderCursor = older.nextCursor;
      olderHasMore = older.nextCursor !== null;
      olderLoading = false;
      archivedPage = archived.rows;
      archivedCursor = archived.nextCursor;
      archivedHasMore = archived.nextCursor !== null;
      archivedLoading = false;
      if (!threadRestoreAttempted) {
        threadRestoreAttempted = true;
        // URL wins: if the inbound URL already set `route.cid`, the
        // reconcile $effect will have kicked off selectThread for it
        // already - all we do here is confirm the thread actually
        // exists in a loaded bucket. If it doesn't (stale bookmark,
        // or a thread deleted elsewhere), strip it from the URL so
        // the sidebar doesn't render a phantom highlight.
        if (route.cid) {
          if (!findThread(route.cid)) {
            navigate({ cid: null }, { replace: true });
          }
          return;
        }
        // URL was bare - fall back to the sessionStorage copy of the
        // last-open thread. Same existence check, then mirror the id
        // into the URL via replaceState so refresh-from-here is
        // stable (no more dependence on sessionStorage once the URL
        // holds the id).
        const restored = getSessionThreadId();
        if (restored && findThread(restored)) {
          navigate({ cid: restored }, { replace: true });
          return;
        }
      }
      if (activeThreadId && !findThread(activeThreadId)) {
        activeThreadId = null;
        messages = [];
        setSessionThreadId(null);
        navigate({ cid: null });
      }
    } catch {
      // Best-effort: supabase-js re-throws the raw fetch TypeError
      // ("Failed to fetch") on a network blip rather than surfacing it
      // in the { error } envelope. This runs on every auth-state event
      // (initial session, TOKEN_REFRESHED, tab visibility resume on
      // mobile) plus at end-of-turn, so painting a banner the user
      // can't dismiss on a transient offline moment is the wrong
      // trade. The realtime subscribeToThreads channel also keeps the
      // sidebar fresh in steady state, and the next auth event will
      // re-attempt the full fetch; a legitimately-broken fetch that
      // leaves the drawer empty will self-heal the next time the user
      // comes back online.
    }
  }

  async function loadMoreOlder(): Promise<void> {
    if (!app.supabase || olderLoading || !olderHasMore) return;
    olderLoading = true;
    try {
      const page = await app.supabase.listOlderThreads({
        cutoff: recentCutoff,
        cursor: olderCursor,
        pageSize: DEFAULT_THREAD_PAGE_SIZE,
      });
      olderThreads = mergeByUpdatedAtDesc(olderThreads, page.rows);
      olderCursor = page.nextCursor;
      olderHasMore = page.nextCursor !== null;
    } catch (err) {
      // Surface pagination failures via the existing error banner;
      // leaving `olderLoading` stuck true would also lock the sentinel
      // so users can't retry.
      error = { text: err instanceof Error ? err.message : String(err) };
    } finally {
      olderLoading = false;
    }
  }

  async function loadMoreArchived(): Promise<void> {
    if (!app.supabase || archivedLoading || !archivedHasMore) return;
    archivedLoading = true;
    try {
      const page = await app.supabase.listArchivedThreads({
        cursor: archivedCursor,
        pageSize: DEFAULT_THREAD_PAGE_SIZE,
      });
      archivedPage = mergeByUpdatedAtDesc(archivedPage, page.rows);
      archivedCursor = page.nextCursor;
      archivedHasMore = page.nextCursor !== null;
    } catch (err) {
      error = { text: err instanceof Error ? err.message : String(err) };
    } finally {
      archivedLoading = false;
    }
  }

  /**
   * Turn an in-memory draft thread into a real Supabase row. Returns the
   * materialized Thread. Safe to call when the thread is already real —
   * in that case it's a no-op and just returns the thread as-is.
   */
  async function materializeIfDraft(draft: Thread, title?: string): Promise<Thread> {
    if (!draft.isDraft || !app.supabase) return draft;
    const real = await app.supabase.createThread(
      title ?? draft.title,
      draft.model,
      draft.reasoning_effort,
      draft.verbosity
    );
    // Swap the draft for the real thread: remove from drafts, insert
    // into Recent (a freshly-created thread always lands inside the
    // 3-day window). The session pointer follows the new id so a
    // reload sticks to the now-persisted conversation.
    drafts = drafts.filter((t) => t.id !== draft.id);
    rebucketThread(real);
    if (activeThreadId === draft.id) {
      activeThreadId = real.id;
      setSessionThreadId(real.id);
      navigate({ cid: real.id }, { replace: true });
    }
    return real;
  }

  async function selectThread(id: string | null): Promise<void> {
    // No-op if the target matches our current state. Prevents a
    // feedback loop with the route-reconciling effect above, which
    // calls selectThread when route.cid changes externally.
    if (id === activeThreadId) return;
    // Abandoned-draft cleanup: if the previously active thread was a draft
    // (never sent, never renamed), drop it from the sidebar rather than
    // leaving an empty placeholder behind once the user moves on.
    if (activeThreadId && activeThreadId !== id) {
      const prev = findThread(activeThreadId);
      if (prev?.isDraft) {
        drafts = drafts.filter((t) => t.id !== activeThreadId);
      }
    }
    activeThreadId = id;
    setSessionThreadId(id);
    // Mirror the active thread into the URL. `navigate` no-ops when
    // route.cid is already `id` (e.g. this call originated from a
    // popstate-driven reconcile effect), so the back stack doesn't
    // grow on browser-back navigations.
    navigate({ cid: id });
    messages = [];
    streamingText = '';
    // Re-seed the active prompt set from defaults whenever the user
    // switches threads - per-thread toggles are not persisted, so a
    // thread switch is effectively a fresh start for this UI state.
    resetActivePromptsToDefaults();
    // Opening a thread starts in follow-bottom mode; the autoscroll
    // effect lands the view on the newest messages once they load.
    followBottom = true;
    // Tool-call timings are a session-scoped display aid; nav to another
    // thread drops them so the previous thread's pills don't leak into
    // the new one.
    toolTimings = {};
    // On mobile the drawer is modal, so dismiss it once a thread is chosen.
    // On desktop the sidebar is a persistent column - leave it open.
    if (
      id !== null &&
      typeof window !== 'undefined' &&
      window.matchMedia('(max-width: 720px)').matches
    ) {
      drawerOpen = false;
    }
    if (id === null) return;
    if (!app.supabase) return;
    // Drafts aren't in Supabase yet - no messages to fetch.
    const t = findThread(id);
    if (t?.isDraft) return;
    try {
      const fetched = await app.supabase.listMessages(id);
      // The user may have hopped threads while we were awaiting - guard
      // against a late response stomping newer state.
      if (activeThreadId !== id) return;
      messages = fetched;
    } catch (err) {
      error = { text: err instanceof Error ? err.message : String(err) };
    }
  }

  // True when the active thread has no messages yet — clicking "New thread"
  // in this state would produce a second empty thread, so we disable it.
  const currentIsEmpty = $derived(activeThreadId !== null && messages.length === 0);

  const currentThread = $derived(
    activeThreadId ? findThread(activeThreadId) ?? null : null
  );

  const defaultTier = $derived<ModelTier>(app.defaultModel ?? DEFAULT_TIER);
  const currentTier = $derived<ModelTier>(
    resolveTier(currentThread?.model ?? null, defaultTier)
  );
  const defaultReasoning = $derived<ReasoningEffort>(
    app.defaultReasoningEffort ?? DEFAULT_REASONING_EFFORT
  );
  // Resolved reasoning for the current thread — per-thread override wins,
  // otherwise the user default. Only surfaced in the UI / sent on the wire
  // when `MODELS[currentTier].supportsReasoning`.
  const currentReasoning = $derived<ReasoningEffort>(
    resolveReasoningEffort(
      currentThread?.reasoning_effort ?? null,
      defaultReasoning,
      MODELS[currentTier].defaultReasoningEffort
    )
  );
  const currentSupportsReasoning = $derived<boolean>(
    MODELS[currentTier].supportsReasoning
  );
  const defaultVerbosity = $derived<Verbosity>(
    app.defaultVerbosity ?? DEFAULT_VERBOSITY
  );
  // Resolved verbosity for the current thread. Same override-wins pattern
  // as reasoning; no capability gate — providers that don't recognize
  // `text.verbosity` silently ignore it, so it's always safe to surface.
  const currentVerbosity = $derived<Verbosity>(
    resolveVerbosity(currentThread?.verbosity ?? null, defaultVerbosity)
  );

  async function startRename(): Promise<void> {
    if (!currentThread) return;
    renameBuffer = currentThread.title;
    renaming = true;
    await tick();
    titleInputEl?.focus();
    titleInputEl?.select();
  }

  async function commitRename(): Promise<void> {
    if (!renaming) return;
    renaming = false;
    const next = renameBuffer.trim();
    if (!app.supabase || !currentThread) return;
    if (!next || next === currentThread.title) return;
    try {
      if (currentThread.isDraft) {
        // Manual rename is a save signal: materialize with the new title
        // in a single round-trip rather than create-then-rename.
        await materializeIfDraft(currentThread, next);
        return;
      }
      const threadId = currentThread.id;
      await app.supabase.renameThread(threadId, next);
      // Rename also bumps `updated_at` server-side (see
      // renameThread); re-bucket so the drawer ordering tracks.
      const updated = { ...currentThread, title: next, updated_at: new Date().toISOString() };
      rebucketThread(updated);
    } catch (err) {
      error = { text: err instanceof Error ? err.message : String(err) };
    }
  }

  function cancelRename(): void {
    renaming = false;
    renameBuffer = '';
  }

  function onTitleKey(e: KeyboardEvent): void {
    if (e.key === 'Enter') {
      e.preventDefault();
      void commitRename();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      cancelRename();
    }
  }

  async function setTier(tier: ModelTier): Promise<void> {
    if (!app.supabase) return;
    // Fresh sessions (first run, last thread deleted, sidebar not yet
    // opened) leave `activeThreadId` null, which used to hide the picker
    // entirely — on mobile the sidebar is an overlay, so "pick a thread
    // first" isn't a discoverable step. Auto-create a draft so the tier
    // choice has somewhere to land; draft creation is free (local-only
    // until the first send materializes it).
    if (!currentThread) {
      await newThread();
      if (!currentThread) return;
    }
    // If the chosen tier matches the user's default, clear the per-thread
    // override so the thread keeps tracking future default changes; only
    // pin an explicit tier when it actually differs from the default.
    const next: ModelTier | null = tier === defaultTier ? null : tier;
    if ((currentThread.model ?? null) === next) return;
    const threadId = currentThread.id;
    // Update local state immediately so the UI reflects the choice.
    patchThread(threadId, { model: next });
    // For drafts, the choice rides along in memory and gets persisted when
    // the draft materializes (on send or manual rename). Changing the
    // model alone shouldn't create a Supabase row.
    if (currentThread.isDraft) return;
    try {
      await app.supabase.setThreadModel(threadId, next);
    } catch (err) {
      error = { text: err instanceof Error ? err.message : String(err) };
    }
  }

  // Mirror of setTier for reasoning effort. Clearing the override when
  // the user picks the current default is deliberate: that way a later
  // change to their default propagates to this thread automatically, and
  // we don't pin a stale value just because it happened to match once.
  async function setReasoning(effort: ReasoningEffort): Promise<void> {
    if (!app.supabase) return;
    // Same fresh-session pattern as setTier — without a thread to land
    // the override on, picking an effort would silently no-op. Auto-
    // create a draft so the choice has somewhere to go; the draft is
    // local-only until the first send materializes it.
    if (!currentThread) {
      await newThread();
      if (!currentThread) return;
    }
    const next: ReasoningEffort | null = effort === defaultReasoning ? null : effort;
    if ((currentThread.reasoning_effort ?? null) === next) return;
    const threadId = currentThread.id;
    patchThread(threadId, { reasoning_effort: next });
    if (currentThread.isDraft) return;
    try {
      await app.supabase.setThreadReasoningEffort(threadId, next);
    } catch (err) {
      error = { text: err instanceof Error ? err.message : String(err) };
    }
  }

  // Mirror of setReasoning for text.verbosity. Same clear-override-on-
  // match discipline so a later change to the user's default propagates
  // to this thread automatically.
  async function setVerbosity(verbosity: Verbosity): Promise<void> {
    if (!app.supabase) return;
    if (!currentThread) {
      await newThread();
      if (!currentThread) return;
    }
    const next: Verbosity | null = verbosity === defaultVerbosity ? null : verbosity;
    if ((currentThread.verbosity ?? null) === next) return;
    const threadId = currentThread.id;
    patchThread(threadId, { verbosity: next });
    if (currentThread.isDraft) return;
    try {
      await app.supabase.setThreadVerbosity(threadId, next);
    } catch (err) {
      error = { text: err instanceof Error ? err.message : String(err) };
    }
  }

  /**
   * Best-effort: ask the fast model for a short title for this thread. Runs
   * after the first user+assistant round-trip. Any failure is swallowed —
   * the thread simply keeps the default title.
   */
  async function autoTitle(threadId: string, firstUserMsg: string): Promise<void> {
    if (!app.venice || !app.supabase) return;
    markTitling(threadId, true);
    let raw = '';
    try {
      try {
        for await (const ev of app.venice.streamChat({
          model: MODELS[UTILITY_TIER].id,
          messages: [
            {
              role: 'system',
              content:
                'Return a 3–6 word title summarizing this conversation. No trailing punctuation. No quotes. Plain text.',
            },
            { role: 'user', content: firstUserMsg.slice(0, 1000) },
          ],
          maxTokens: 24,
        })) {
          // Title generation never sends tools; any non-text event is
          // ignored. Keeping the filter explicit makes the intent clear.
          if (ev.type === 'text') raw += ev.delta;
        }
      } catch {
        return;
      }
      const title = raw
        .trim()
        .replace(/^["'“”‘’]+|["'“”‘’.!?]+$/g, '')
        .trim()
        .slice(0, 80);
      if (!title) return;
      try {
        await app.supabase.renameThread(threadId, title);
        const existing = findThread(threadId);
        if (existing) {
          rebucketThread({
            ...existing,
            title,
            updated_at: new Date().toISOString(),
          });
        }
      } catch {
        /* ignore */
      }
    } finally {
      // Always clear the indicator, including early returns above.
      markTitling(threadId, false);
    }
  }

  async function newThread(): Promise<void> {
    if (!app.supabase) return;
    if (currentIsEmpty) return;
    // Create a local-only draft. It materializes in Supabase only when the
    // user sends a message or renames the thread; an abandoned draft just
    // disappears on refresh.
    const session = await app.supabase.getSession();
    if (!session) return;
    const now = new Date().toISOString();
    const draft: Thread = {
      id: crypto.randomUUID(),
      user_id: session.user.id,
      title: DEFAULT_TITLE,
      model: null,
      reasoning_effort: null,
      verbosity: null,
      tools_enabled: false,
      archived: false,
      created_at: now,
      updated_at: now,
      isDraft: true,
    };
    drafts = [draft, ...drafts];
    await selectThread(draft.id);
  }

  async function deleteThread(id: string): Promise<void> {
    if (!app.supabase) return;
    const t = findThread(id);
    if (!t) return;
    closeRowMenu();
    if (!confirm('Delete this thread and all its messages?')) return;
    try {
      // Drafts only exist in memory — just drop them locally.
      if (!t.isDraft) await app.supabase.deleteThread(id);
      removeThread(id);
      if (activeThreadId === id) {
        activeThreadId = null;
        messages = [];
        setSessionThreadId(null);
        navigate({ cid: null });
      }
    } catch (err) {
      error = { text: err instanceof Error ? err.message : String(err) };
    }
  }

  // Archive / restore. Both optimistically mutate local state and rely on
  // the realtime `onUpdate` echo to reconcile — same pattern as rename.
  // Both bump updated_at so the thread surfaces at the top of whichever
  // section it lands in (see setThreadArchived in supabase.ts). Drafts
  // can't be archived because they don't exist server-side yet.
  async function archiveThread(id: string): Promise<void> {
    if (!app.supabase) return;
    const t = findThread(id);
    if (!t || t.isDraft) return;
    closeRowMenu();
    const nowIso = new Date().toISOString();
    rebucketThread({ ...t, archived: true, updated_at: nowIso });
    try {
      await app.supabase.setThreadArchived(id, true);
    } catch (err) {
      error = { text: err instanceof Error ? err.message : String(err) };
    }
  }

  async function restoreThread(id: string): Promise<void> {
    if (!app.supabase) return;
    const t = findThread(id);
    if (!t) return;
    closeRowMenu();
    const nowIso = new Date().toISOString();
    rebucketThread({ ...t, archived: false, updated_at: nowIso });
    try {
      await app.supabase.setThreadArchived(id, false);
    } catch (err) {
      error = { text: err instanceof Error ? err.message : String(err) };
    }
  }

  // Rename via the row dropdown: select the thread first (so the top-bar
  // title input is the one being edited), then flip into rename mode on
  // the next microtask — startRename reads currentThread, which only
  // updates after the selectThread state mutation propagates.
  function renameFromRow(id: string): void {
    closeRowMenu();
    void selectThread(id);
    queueMicrotask(() => {
      void startRename();
    });
  }

  function closeRowMenu(): void {
    openMenuThreadId = null;
  }

  function toggleRowMenu(id: string): void {
    openMenuThreadId = openMenuThreadId === id ? null : id;
  }

  // 500ms matches the platform long-press convention on iOS/Android.
  // Any movement or early release cancels — matches how native context
  // menus behave, so a scroll gesture doesn't accidentally open the menu.
  function startLongPress(id: string): void {
    cancelLongPress();
    longPressTimer = setTimeout(() => {
      openMenuThreadId = id;
      // Swallow the click that fires when the finger eventually lifts —
      // otherwise selectThread would run and close the drawer on mobile,
      // defeating the long-press.
      suppressNextClick = true;
      longPressTimer = null;
    }, 500);
  }

  function cancelLongPress(): void {
    if (longPressTimer !== null) {
      clearTimeout(longPressTimer);
      longPressTimer = null;
    }
  }

  function onThreadClick(id: string): void {
    if (suppressNextClick) {
      suppressNextClick = false;
      return;
    }
    void selectThread(id);
  }

  async function send(): Promise<void> {
    const text = composer.trim();
    // Attachments alone (no text) are allowed — a user may "send an
    // image for you to look at". Still require text OR at least one
    // ready attachment so an empty send doesn't fire.
    const readyAttachments = pendingAttachments.filter((a) => !a.pending && !a.error);
    const hasAttachments = readyAttachments.length > 0;
    if ((!text && !hasAttachments) || !app.supabase || !app.venice) return;
    error = null;

    const active = activeThreadId ? findThread(activeThreadId) ?? null : null;
    // Capture the tier BEFORE materializing, since materialize mutates
    // `threads` and could make `currentThread` briefly null.
    const tier = resolveTier(active?.model ?? null, defaultTier);
    const modelId = MODELS[tier].id;
    const tierSpec = MODELS[tier];
    // Only pass reasoning_effort on models that accept it; letting it
    // ride along to a non-reasoning model produces a 400 on some providers.
    const sendReasoning: ReasoningEffort | undefined = tierSpec.supportsReasoning
      ? resolveReasoningEffort(
          active?.reasoning_effort ?? null,
          defaultReasoning,
          tierSpec.defaultReasoningEffort
        )
      : undefined;
    // Verbosity is safe to send unconditionally — providers that don't
    // recognize `text.verbosity` silently ignore it.
    const sendVerbosity: Verbosity = resolveVerbosity(
      active?.verbosity ?? null,
      defaultVerbosity
    );

    // Pre-send guard on attachments. Block the send if any attachment
    // is still processing, is in an error state, or can't be read by
    // the selected tier. Surface the reason on `error` — the user sees
    // it above the composer and can either remove the file or switch
    // tier.
    const stillPending = pendingAttachments.find((a) => a.pending);
    if (stillPending) {
      error = {
        text: `"${stillPending.filename}" is still processing — wait for it to finish.`,
      };
      return;
    }
    const erroredChip = pendingAttachments.find((a) => a.error);
    if (erroredChip) {
      error = { text: `"${erroredChip.filename}": ${erroredChip.error}` };
      return;
    }
    const unreadable = readyAttachments.find((a) => !isConsumableBy(a, tierSpec));
    if (unreadable) {
      error = {
        text: isImageMimeType(unreadable.mime_type)
          ? `"${unreadable.filename}" is an image and the ${tierSpec.label} tier can't see images. Switch to a vision-capable tier or remove the file.`
          : `"${unreadable.filename}" has no extractable text — the model won't be able to read it. Remove it to send.`,
      };
      return;
    }

    let threadId: string;
    // True when this send should trigger auto-titling after the
    // assistant replies. Historically this was "is this the first
    // user/assistant exchange?", but that made auto-title strictly
    // one-shot — if the first attempt failed (Venice 503, network
    // blip, etc.), the thread stayed stuck on DEFAULT_TITLE
    // permanently. New contract: any send on a thread that's still
    // carrying the default title qualifies. The title-gen cost is
    // trivial (one short utility-tier call) and the only cases where
    // the gate fires more than once are the ones we specifically
    // want to recover from.
    let needsAutoTitle = false;
    if (!active) {
      // No thread selected - create one on the fly.
      const t = await app.supabase.createThread(DEFAULT_TITLE);
      rebucketThread(t);
      threadId = t.id;
      activeThreadId = t.id;
      setSessionThreadId(t.id);
      navigate({ cid: t.id }, { replace: true });
      needsAutoTitle = true;
    } else if (active.isDraft) {
      // First send on a draft — materialize it now, preserving any model
      // choice the user already made from the dropdown.
      const real = await materializeIfDraft(active);
      threadId = real.id;
      needsAutoTitle = true;
    } else {
      threadId = active.id;
      // Used to also require `messages.length === 0` — dropped so a
      // send on a thread whose initial auto-title failed can recover
      // on any subsequent send. The gate is "title is still the
      // placeholder", which is automatically false once a title has
      // landed (or the user renamed the thread manually).
      needsAutoTitle = active.title === DEFAULT_TITLE;
    }

    // Snapshot the queued attachments and clear the composer chips.
    // Keeping a local copy means a late text-parser completion (if we
    // ever allow background adds) can't retroactively mutate the
    // message we just inserted.
    const sendAttachments = readyAttachments;
    composer = '';
    pendingAttachments = [];
    sending = true;
    // Sending is an explicit "pay attention to the bottom" signal — even
    // if the user had scrolled up before hitting send, we want their new
    // message (and the impending streaming response) in view.
    followBottom = true;

    // Build the system-prompt preamble now, against the toggles the user
    // has set at send time. On retry (rate-limit refresh button) we want
    // the original prompts — capturing here, not inside runExchange,
    // pins them even if the user flips a toggle while the banner is up.
    const systemMessages: { role: 'system'; content: string }[] = app.systemPrompts
      .filter((p) => activePromptIds.has(p.id) && p.body.trim().length > 0)
      .map((p) => ({ role: 'system' as const, content: p.body }));

    let userMessageId: string;
    try {
      const userMsg = await app.supabase.addMessage(threadId, 'user', text);
      userMessageId = userMsg.id;
      // Persist attachment rows. Positional index matches the chip
      // order so the message list renders them the way the user queued
      // them. If the insert fails the user message is still saved and
      // the transcript reads as plain text — an attachment-less send
      // is recoverable; a missing user message row is not.
      if (sendAttachments.length > 0) {
        const newRows: NewAttachment[] = sendAttachments.map((a, i) =>
          toNewAttachment(a, i)
        );
        try {
          const rows = await app.supabase.addAttachments(userMsg.id, newRows);
          userMsg.attachments = rows;
        } catch (err) {
          // Non-fatal: surface a warning but keep going. The user's
          // typed text still gets a reply — the attachments just
          // won't make it into history.

          log.warn('persistAttachments failed', err);
          userMsg.attachments = [];
        }
      } else {
        userMsg.attachments = [];
      }
      appendMessage(userMsg);
    } catch (err) {
      // Pre-exchange failure (user message persist). No retry here —
      // the user's row didn't land, so "retry" would mean "try persist
      // again," which is a different UX than "retry the LLM call."
      error = { text: err instanceof Error ? err.message : String(err) };
      sending = false;
      return;
    }

    const freshThread = findThread(threadId);
    if (!freshThread) {
      error = { text: 'Thread disappeared before send.' };
      sending = false;
      return;
    }
    const currentUserId = session?.user.id ?? freshThread.user_id;

    await runExchange({
      threadId,
      currentUserId,
      modelId,
      tierSpec,
      systemMessages,
      sendReasoning,
      sendVerbosity,
      needsAutoTitle,
      originalText: text,
      userMessageId,
    });
  }

  /**
   * Parameters captured once at send-time and re-used verbatim on a
   * refresh-button retry. The wire history is intentionally NOT
   * captured: runExchange rebuilds it from the current `messages` store
   * on each call so a retry after a multi-round exchange (round 1 ran
   * tools and persisted results, round 2 hit a 429) picks up from the
   * right place rather than re-sending the original short history.
   */
  interface ExchangeContext {
    threadId: string;
    currentUserId: string;
    modelId: string;
    tierSpec: ModelSpec;
    systemMessages: { role: 'system'; content: string }[];
    sendReasoning: ReasoningEffort | undefined;
    sendVerbosity: Verbosity;
    needsAutoTitle: boolean;
    originalText: string;
    /**
     * The Supabase id of the user message that opened this exchange.
     * Threaded through to runChatLoop so the chat-loop can pair it
     * with the terminal assistant message in the samskara substrate
     * row written at end-of-turn.
     */
    userMessageId: string;
  }

  /**
   * Run (or re-run) a single chat-loop exchange against the current
   * thread. Owns the `sending` flag, the abort controller, the text
   * flush throttle, and the error banner's retry wiring — so both the
   * initial send path and the rate-limit refresh button share identical
   * lifecycle handling.
   *
   * On a rate-limit failure (VeniceError kind='rate_limit'), parks a
   * retry closure on the error banner that re-invokes this function
   * with the same context. Other errors surface their message without
   * a retry — we only advertise a retry when re-firing is meaningful.
   */
  async function runExchange(ctx: ExchangeContext): Promise<void> {
    if (!app.venice || !app.supabase) return;
    const freshThread = findThread(ctx.threadId);
    if (!freshThread) {
      error = { text: 'Thread disappeared before send.' };
      return;
    }
    error = null;
    sending = true;
    streamingText = '';
    abortCtl = new AbortController();

    // Rebuild at call time so a retry after mid-exchange persists
    // (assistant row + tool result from a prior round) sees them.
    // toVeniceMessage is safe to call on rows without attachments —
    // they come back as plain strings either way.
    const historyOnWire: VeniceMessage[] = [
      ...ctx.systemMessages,
      ...messages.map((m) => toVeniceMessage(m, { visionSpec: ctx.tierSpec })),
    ];

    // Throttle streamingText updates to ~2Hz while the response
    // arrives. Every assignment drives <Markdown> to re-run marked
    // + DOMPurify + highlight.js over the full growing buffer, so
    // flushing on each SSE delta would peg the main thread and make
    // long responses land in visible gulps. Trailing-edge throttle:
    // the first delta schedules a 500ms timer, any deltas arriving
    // inside that window get coalesced into the latest `pending`
    // value, and one flush commits the buffer when the timer fires.
    // Side effect: ~500ms of "thinking dots" before the first
    // rendered paint, which reads as intentional pacing.
    const FLUSH_MS = 500;
    let pending: string | null = null;
    let flushTimer = 0;
    const flushPending = (): void => {
      flushTimer = 0;
      if (pending !== null) {
        streamingText = pending;
        pending = null;
      }
    };
    const cancelPending = (): void => {
      if (flushTimer !== 0) {
        clearTimeout(flushTimer);
        flushTimer = 0;
      }
    };

    try {
      let loopResult;
      try {
        loopResult = await runChatLoop({
          venice: app.venice,
          supabase: app.supabase,
          thread: freshThread,
          userId: ctx.currentUserId,
          modelId: ctx.modelId,
          history: historyOnWire,
          signal: abortCtl.signal,
          userMessageId: ctx.userMessageId,
          // Enabled → 'on' so every turn is grounded with live results
          // plus citations — 'auto' leaves too much up to the model's
          // self-assessment, and we kept seeing refusals on questions
          // that would have benefited from a search. Disabled → 'off'
          // so the field is pinned even against any future Venice-side
          // default change.
          webSearch: app.webSearchEnabled ? 'on' : 'off',
          reasoningEffort: ctx.sendReasoning,
          verbosity: ctx.sendVerbosity,
          handlers: {
            onTextUpdate: (t) => {
              pending = t;
              if (flushTimer === 0) {
                flushTimer = window.setTimeout(flushPending, FLUSH_MS);
              }
              // First content byte of this round — schedule the
              // reasoning panel to animate shut shortly after so the
              // user sees "thinking… answer starts" rather than a
              // snap close. 600ms is long enough to read as a
              // deliberate hand-off; shorter and it feels like the
              // panel is running from the content rather than
              // yielding to it. Guarded on streamingContentStarted
              // so only the first text delta schedules it.
              if (!streamingContentStarted) {
                streamingContentStarted = true;
                if (streamingReasoningOpen && streamingReasoning.length > 0) {
                  reasoningCloseTimer = window.setTimeout(() => {
                    streamingReasoningOpen = false;
                    reasoningCloseTimer = 0;
                  }, 600);
                }
              }
            },
            onReasoningUpdate: (t) => {
              streamingReasoning = t;
              // Panel opens on the first reasoning delta so the user
              // watches the thinking stream in. Only before content
              // has started — once the answer is flowing, late
              // reasoning shouldn't pop the panel back open.
              if (!streamingReasoningOpen && !streamingContentStarted) {
                streamingReasoningOpen = true;
              }
            },
            onCitationsUpdate: (c) => {
              streamingCitations = c;
            },
            onAssistantPersisted: (msg) => {
              // Cancel any pending frame — the persisted row takes
              // over rendering and we don't want a stale flush to
              // replay the text into streamingText after this.
              cancelPending();
              pending = null;
              appendMessage(msg);
              streamingText = '';
              // Streaming companions reset per round so the NEXT
              // round starts with a clean slate. The persisted row
              // already carries reasoning/citations for the round
              // just finished, so the UI keeps rendering them via
              // the message store rather than the streaming state.
              streamingReasoning = '';
              streamingCitations = null;
              streamingReasoningOpen = false;
              streamingContentStarted = false;
              if (reasoningCloseTimer !== 0) {
                window.clearTimeout(reasoningCloseTimer);
                reasoningCloseTimer = 0;
              }
            },
            onToolResultPersisted: (msg) => {
              appendMessage(msg);
            },
            onToolStart: (call) => {
              // performance.now() rather than Date.now() so the
              // elapsed math is monotonic — the user's clock jumping
              // (NTP sync, daylight saving) can't produce negative
              // durations.
              toolTimings[call.id] = { startedAt: performance.now() };
            },
            onToolDone: (call) => {
              const t = toolTimings[call.id];
              if (t) t.endedAt = performance.now();
            },
            onToolError: (call) => {
              const t = toolTimings[call.id];
              if (t) {
                t.endedAt = performance.now();
                t.error = true;
              }
            },
            onToolsEnabledChange: (enabled) => {
              patchThread(ctx.threadId, { tools_enabled: enabled });
              // Brief flash on the composer toolbox so a human eye
              // notices the LLM-initiated state flip. User-initiated
              // flips don't flash (the click itself is the feedback).
              toolboxFlash = true;
              setTimeout(() => {
                toolboxFlash = false;
              }, 600);
            },
          },
        });
      } finally {
        // Commit anything pending synchronously so post-loop code
        // sees the final state.
        cancelPending();
        if (pending !== null) {
          streamingText = pending;
          pending = null;
        }
      }
      if (loopResult.stoppedByLimit && !loopResult.finalText) {
        error = { text: 'Stopped: tool-call loop hit the 5-round limit.' };
      }
      if (ctx.needsAutoTitle && loopResult.finalText.length > 0) {
        // Title from the thread's *opening* user turn, not the one
        // we just sent. Matters for the retry-on-next-send case: if
        // the first auto-title attempt failed and we're now on turn
        // N, the latest user message is a follow-up that won't
        // summarize the conversation well. For a genuinely new
        // thread the two are identical because the just-appended
        // message is also the first. `ctx.originalText` is the
        // fallback — `messages` is reactive state we've already
        // appended to, so the find() should always hit.
        const seed =
          messages.find((m) => m.role === 'user')?.content ?? ctx.originalText;
        // Fire-and-forget: don't block the UI on title generation.
        void autoTitle(ctx.threadId, seed);
      }
      streamingText = '';
      streamingReasoning = '';
      streamingCitations = null;
      streamingReasoningOpen = false;
      streamingContentStarted = false;
      await refreshThreads();
    } catch (err) {
      streamingText = '';
      streamingReasoning = '';
      streamingCitations = null;
      streamingReasoningOpen = false;
      streamingContentStarted = false;
      // Rate-limit is the one error where re-sending the same request
      // a moment later is the right fix — Venice's message literally
      // says "try again later." Park a retry closure on the banner so
      // the refresh button is the only action needed; other failure
      // kinds (auth, parse, the user's abort) would just repeat the
      // error, so we omit the retry for them.
      if (err instanceof VeniceError && err.kind === 'rate_limit') {
        error = {
          text: formatRateLimitMessage(err),
          retry: () => {
            void runExchange(ctx);
          },
        };
      } else {
        error = { text: err instanceof Error ? err.message : String(err) };
      }
    } finally {
      sending = false;
      abortCtl = null;
      // Always clear the close timer on exit — a stale timer firing
      // after a new send has started would flip the panel shut
      // mid-reasoning on the next turn.
      if (reasoningCloseTimer !== 0) {
        window.clearTimeout(reasoningCloseTimer);
        reasoningCloseTimer = 0;
      }
    }
  }

  /**
   * Unwrap a Venice rate-limit error into a message fit for the banner.
   * The raw err.message is `Venice rate limit hit (HTTP 429). <detail>`
   * where <detail> is usually the OpenAI-compat envelope
   * `{"error":"The model is currently overloaded..."}`. Peel both
   * layers so the user sees only the provider's reason; fall back to
   * the raw message when parsing fails — any text beats a blank banner.
   */
  function formatRateLimitMessage(err: VeniceError): string {
    const prefix = `Venice rate limit hit (HTTP ${err.status ?? 429}). `;
    const detail = err.message.startsWith(prefix)
      ? err.message.slice(prefix.length).trim()
      : err.message.trim();
    if (detail.startsWith('{')) {
      try {
        const parsed: unknown = JSON.parse(detail);
        if (parsed && typeof parsed === 'object') {
          const e = (parsed as { error?: unknown }).error;
          if (typeof e === 'string') return e;
          if (
            e &&
            typeof e === 'object' &&
            typeof (e as { message?: unknown }).message === 'string'
          ) {
            return (e as { message: string }).message;
          }
        }
      } catch {
        // Not JSON — fall through to the raw detail.
      }
    }
    return detail || 'Rate limited. Please try again later.';
  }

  // ⌘+Enter (macOS), Ctrl+Enter (everyone else), and the legacy Shift+Enter
  // all submit. Plain Enter still inserts a newline so long-form drafts
  // aren't interrupted. `metaKey` maps to the Command key on macOS; on
  // Windows/Linux it's the rarely-pressed Super/Windows key, so including
  // it there is harmless.
  function onKeydown(e: KeyboardEvent): void {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey || e.shiftKey)) {
      e.preventDefault();
      void send();
    }
  }

  // Platform-aware hint in the composer placeholder. Uses the modern
  // navigator.userAgentData.platform when available and falls back to
  // the legacy navigator.platform string.
  const isMac = $derived.by(() => {
    if (typeof navigator === 'undefined') return false;
    const p =
      (navigator as Navigator & { userAgentData?: { platform?: string } })
        .userAgentData?.platform ?? navigator.platform ?? '';
    return /mac/i.test(p);
  });
  const sendHint = $derived(
    isMac ? '\u2318+Enter to send, Enter for newline' : 'Ctrl+Enter to send, Enter for newline'
  );

  async function signOut(): Promise<void> {
    // Clear the cached master-password session too — an explicit sign-out
    // should reset auto-unlock so a refresh goes back to the Unlock screen.
    clearSession();
    await app.supabase?.signOut();
  }

  // Mobile drawer. Hidden by default on narrow viewports via CSS, which
  // Sidebar visibility — doubles as the mobile drawer toggle and the
  // desktop "hide sidebar" toggle. Initial value is viewport-aware so
  // desktop loads with the sidebar open and mobile loads with it closed,
  // without a layout flash.
  let drawerOpen = $state(
    typeof window !== 'undefined' && window.innerWidth > 720
  );
  function closeDrawer(): void {
    drawerOpen = false;
  }
  function toggleDrawer(): void {
    drawerOpen = !drawerOpen;
  }

  // Composer expand toggle. When true, the textarea grows to 40vh so the
  // The composer textarea resizes naturally up to max-height and is
  // user-resizable via the native drag handle (see .composer-textarea).

  // Scroll behavior for the messages list.
  //
  //   followBottom = true  → stream deltas and user sends pin the view
  //                          to the bottom.
  //   followBottom = false → the user has scrolled upward while content
  //                          was arriving; stop auto-scrolling. The
  //                          floating "↓" button re-engages follow mode.
  //
  // The scroll handler derives `followBottom` from the current
  // position, so programmatic scrolls (streaming appends) and user
  // scrolls go through the same code path — we just react to "is the
  // view still near the bottom?" and set the flag accordingly. No
  // ignore-next-event plumbing needed.
  const NEAR_BOTTOM_PX = 48;
  let messagesEl: HTMLDivElement | undefined = $state();
  let followBottom = $state(true);
  let hasOverflow = $state(false);

  function isNearBottom(el: HTMLElement): boolean {
    return el.scrollTop + el.clientHeight >= el.scrollHeight - NEAR_BOTTOM_PX;
  }

  function scrollToBottom(smooth = false): void {
    const el = messagesEl;
    if (!el) return;
    el.scrollTo({
      top: el.scrollHeight,
      behavior: smooth ? 'smooth' : 'auto',
    });
  }

  function onMessagesScroll(): void {
    const el = messagesEl;
    if (!el) return;
    followBottom = isNearBottom(el);
    hasOverflow = el.scrollHeight > el.clientHeight + 1;
  }

  // Streaming deltas arrive fast enough that scrolling on every
  // coalesced paint makes the content rocket off-screen before the
  // eye can lock onto a word — the view feels like a slot machine.
  // Debounce the streaming-driven scroll so bursts of tokens settle
  // into periodic nudges instead of a continuous blur. The max-wait
  // cap guarantees the view still keeps up with a sustained stream:
  // no matter how fast the tokens come, a scroll fires at least once
  // per SCROLL_MAX_WAIT_MS window. Discrete transitions (user sends,
  // assistant-message commit, thread switch) bypass this path and
  // scroll immediately — see the $effect below.
  const SCROLL_DEBOUNCE_MS = 80;
  const SCROLL_MAX_WAIT_MS = 300;
  let scrollDebounceTimer = 0;
  let scrollMaxWaitTimer = 0;

  function cancelScrollTimers(): void {
    if (scrollDebounceTimer !== 0) {
      clearTimeout(scrollDebounceTimer);
      scrollDebounceTimer = 0;
    }
    if (scrollMaxWaitTimer !== 0) {
      clearTimeout(scrollMaxWaitTimer);
      scrollMaxWaitTimer = 0;
    }
  }

  function firePendingStreamScroll(): void {
    cancelScrollTimers();
    // Re-check followBottom at fire time: the user may have scrolled
    // up while the timer was pending, and scroll-lock honors current
    // intent rather than the intent at the moment the timer was set.
    if (followBottom) scrollToBottom(false);
  }

  function scheduleStreamScroll(): void {
    if (!followBottom) {
      // Scroll-lock engaged — drop any pending scrolls so a stale
      // timer doesn't fight the user after they scroll up.
      cancelScrollTimers();
      return;
    }
    if (scrollDebounceTimer !== 0) clearTimeout(scrollDebounceTimer);
    scrollDebounceTimer = window.setTimeout(
      firePendingStreamScroll,
      SCROLL_DEBOUNCE_MS
    );
    // Max-wait ceiling: armed on the first scheduled scroll of a
    // streaming burst and only reset when a scroll actually fires.
    // Without this, a rapid-enough stream would reset the debounce
    // timer forever and the view would never catch up.
    if (scrollMaxWaitTimer === 0) {
      scrollMaxWaitTimer = window.setTimeout(
        firePendingStreamScroll,
        SCROLL_MAX_WAIT_MS
      );
    }
  }

  // Two separate effects so streaming deltas and discrete message-list
  // mutations can drive different scroll policies. Splitting them is
  // the simplest way to get "debounce tokens, snap on commits" without
  // prev-value bookkeeping inside a single effect.

  // Message-list mutations — user send, assistant-persist, thread load,
  // thread switch. These mark a clean transition and should land the
  // view on the bottom immediately. Firing here also supersedes any
  // pending streaming debounce: the commit we just observed is the
  // latest state, so a stale late-firing timer would just flicker.
  $effect(() => {
    void messages;
    const el = messagesEl;
    if (!el) return;
    hasOverflow = el.scrollHeight > el.clientHeight + 1;
    cancelScrollTimers();
    if (followBottom) scrollToBottom(false);
  });

  // Streaming deltas — debounced with a max-wait cap. Tracks both the
  // answer buffer (`streamingText`) and the reasoning buffer
  // (`streamingReasoning`) so the view follows the bottom of the
  // bubble while the thinking panel is growing, not just after the
  // answer starts. Also tracks `streamingReasoningOpen`: the panel
  // opening or closing causes a vertical layout shift that should
  // scroll the view exactly the same way a token append would.
  // `streamingText` toggling to '' at the end of a round also runs
  // through here; the follow-up messages effect (assistant persisted)
  // will cancel the pending timer and do the final snap-to-bottom,
  // so we don't need a special "stream ended" signal.
  $effect(() => {
    void streamingText;
    void streamingReasoning;
    void streamingReasoningOpen;
    const el = messagesEl;
    if (!el) return;
    hasOverflow = el.scrollHeight > el.clientHeight + 1;
    scheduleStreamScroll();
  });

  // Composer popovers (prompts list + model picker + reasoning picker
  // + verbosity picker). Only one is open at a time. Click-outside
  // closes; Escape too.
  let promptsMenuOpen = $state(false);
  let modelMenuOpen = $state(false);
  let reasoningMenuOpen = $state(false);
  let verbosityMenuOpen = $state(false);

  // IDs of system prompts active for the current thread. Seeded from
  // `enabledByDefault` when a thread is opened, not persisted. Swapping
  // threads resets this to the current defaults — per-thread toggles do
  // not carry across conversations.
  let activePromptIds = $state<Set<string>>(new Set());

  // Thread ids currently having their title auto-generated by the Fast
  // tier. Used to swap the title text for a Scanner in the sidebar and
  // the top bar so the user gets feedback that something is happening.
  let titlingThreadIds = $state<Set<string>>(new Set());
  function markTitling(threadId: string, on: boolean): void {
    const next = new Set(titlingThreadIds);
    if (on) next.add(threadId);
    else next.delete(threadId);
    titlingThreadIds = next;
  }

  function resetActivePromptsToDefaults(): void {
    activePromptIds = new Set(
      app.systemPrompts.filter((p) => p.enabledByDefault).map((p) => p.id)
    );
  }

  function togglePrompt(id: string): void {
    const next = new Set(activePromptIds);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    activePromptIds = next;
  }

  const activePromptCount = $derived(
    app.systemPrompts.filter((p) => activePromptIds.has(p.id)).length
  );

  function closeMenus(): void {
    promptsMenuOpen = false;
    modelMenuOpen = false;
    reasoningMenuOpen = false;
    verbosityMenuOpen = false;
  }

  function onDocClick(e: MouseEvent): void {
    // Close the per-row thread menu unless the click lands inside it or
    // on the actions button that owns it. Menu items close themselves
    // via their handlers, so this branch mostly handles "clicked
    // somewhere else in the drawer".
    if (openMenuThreadId !== null) {
      const tgt = e.target;
      const inside =
        tgt instanceof Element &&
        (tgt.closest('.thread-menu') || tgt.closest('.thread-actions-btn'));
      if (!inside) closeRowMenu();
    }
    if (!promptsMenuOpen && !modelMenuOpen && !reasoningMenuOpen && !verbosityMenuOpen) return;
    // "Inside" is scoped to the open popover and its trigger — not the
    // whole composer bar. Clicks on the bar's empty filler, the send
    // button, or the toolbox toggle all count as outside so the popover
    // yields the moment the user's attention moves anywhere else.
    // `aria-haspopup="true"` is already set on every menu trigger for
    // a11y, so we reuse it here instead of listing CSS classes.
    const tgt = e.target;
    if (
      tgt instanceof Element &&
      (tgt.closest('.composer-menu') || tgt.closest('[aria-haspopup="true"]'))
    ) {
      return;
    }
    closeMenus();
  }

  function onDocKey(e: KeyboardEvent): void {
    if (e.key === 'Escape') {
      closeMenus();
      closeRowMenu();
    }
  }

  $effect(() => {
    const anyOpen =
      promptsMenuOpen ||
      modelMenuOpen ||
      reasoningMenuOpen ||
      verbosityMenuOpen ||
      openMenuThreadId !== null;
    if (!anyOpen) return;
    document.addEventListener('click', onDocClick);
    document.addEventListener('keydown', onDocKey);
    return () => {
      document.removeEventListener('click', onDocClick);
      document.removeEventListener('keydown', onDocKey);
    };
  });

  // Brief pulse on the composer toolbox button when the LLM flips
  // tools_enabled via toggle_tools. Set true on change, unset after the
  // animation finishes — ~600ms is enough for the keyframe to complete.
  let toolboxFlash = $state(false);

  /**
   * Render plan derived from the raw message list. Tool-result rows are
   * folded into their parent assistant message's tool-group so the UI
   * sees one card per turn. Plain user / assistant-text rows pass through.
   *
   * Built as a $derived so messages mutations re-group automatically
   * (e.g. when the chat-loop pushes a new tool-result in mid-turn).
   */
  type MessageBlock =
    | { kind: 'plain'; message: Message }
    | { kind: 'tool-group'; assistant: Message; resultsByCallId: Record<string, Message> };

  // `toggle_tools` is a housekeeping call — the LLM flips tools on/off
  // as it decides whether it needs the full catalog for the next turn.
  // The user already sees the state change (toolbox button flashes and
  // updates its active state via onToolsEnabledChange), and the call
  // itself carries no reply-relevant content. Rendering it as a tool
  // row just adds noise to the transcript, so we hide it from the
  // render plan. The underlying `tool_calls` and tool-result rows
  // still live in the message store and go out on the wire on replay
  // — this is purely a display filter.
  const HIDDEN_TOOL_NAMES = new Set(['toggle_tools']);

  const messageBlocks = $derived.by<MessageBlock[]>(() => {
    // First pass: index tool rows by their tool_call_id.
    const resultsByCallId: Record<string, Message> = {};
    for (const m of messages) {
      if (m.role === 'tool' && m.tool_call_id) {
        resultsByCallId[m.tool_call_id] = m;
      }
    }
    // Second pass: emit blocks, folding assistant-with-tool_calls rows
    // into a tool-group that carries the matching result rows.
    const blocks: MessageBlock[] = [];
    for (const m of messages) {
      if (m.role === 'tool') continue; // folded under their assistant parent
      if (
        m.role === 'assistant' &&
        m.tool_calls &&
        m.tool_calls.length > 0
      ) {
        const visibleCalls = m.tool_calls.filter(
          (c) => !HIDDEN_TOOL_NAMES.has(c.function.name)
        );
        // If every call on this turn is hidden, we either drop the
        // whole row (no body, nothing to show) or demote it to a
        // plain block so any assistant text still reaches the user.
        // Demoting preserves the rare case where a model emits a
        // short "ok, tools off" reply alongside the toggle call.
        if (visibleCalls.length === 0) {
          if (m.content && m.content.trim().length > 0) {
            blocks.push({ kind: 'plain', message: m });
          }
          continue;
        }
        const scoped: Record<string, Message> = {};
        for (const call of visibleCalls) {
          const r = resultsByCallId[call.id];
          if (r) scoped[call.id] = r;
        }
        // Copy the message so we can narrow tool_calls to just the
        // visible ones without mutating the store-owned row.
        const narrowed: Message = { ...m, tool_calls: visibleCalls };
        blocks.push({ kind: 'tool-group', assistant: narrowed, resultsByCallId: scoped });
      } else {
        blocks.push({ kind: 'plain', message: m });
      }
    }
    return blocks;
  });

  /**
   * Manual toolbox toggle — the user-driven path parallel to the
   * toggle_tools tool. Writes straight through to Supabase + updates
   * local state. Only meaningful on a real (non-draft) thread; drafts
   * don't exist server-side until they materialize on send.
   */
  async function toggleToolsManually(): Promise<void> {
    if (!app.supabase || !currentThread || currentThread.isDraft) return;
    const next = !currentThread.tools_enabled;
    const threadId = currentThread.id;
    // Optimistic: update locally first so the button feels instant.
    patchThread(threadId, { tools_enabled: next });
    try {
      await app.supabase.setThreadToolsEnabled(threadId, next);
    } catch (err) {
      // Revert on failure so the UI doesn't lie about server state.
      patchThread(threadId, { tools_enabled: !next });
      error = { text: err instanceof Error ? err.message : String(err) };
    }
  }

  // -----------------------------------------------------------------------
  // Conversation search
  // -----------------------------------------------------------------------
  //
  // The search box at the top of the drawer runs both an exact ILIKE
  // match on the title and a semantic cosine-similarity search against
  // `title + summary` embeddings (see src/lib/agents/summary/* and the
  // threads EmbeddingSource). Exact hits always rank above semantic
  // hits — the merge in SupabaseService.searchThreads enforces that.
  //
  // The paginated list is hidden entirely while a query is active; the
  // mental model is "I'm searching now," and restoring the list is a
  // single Escape away. Archived threads appear in the results (greyed)
  // because the user's mental index doesn't respect the archive flag —
  // "where's that thread about X?" is the question we're answering.

  let searchQuery = $state('');
  let searchResults = $state<ThreadSearchHit[]>([]);
  let searchBusy = $state(false);
  /** Focused row index for arrow-key nav. -1 = nothing focused. */
  let focusedResultIdx = $state(-1);
  /** AbortController for the in-flight Venice embed call — newer queries cancel older ones. */
  let searchAbort: AbortController | null = null;

  const SEARCH_DEBOUNCE_MS = 200;

  $effect(() => {
    // Reactively read searchQuery — if it changes, the cleanup below
    // runs, aborting any in-flight embed call and clearing the timer
    // before a new one is set.
    const q = searchQuery.trim();
    if (q.length === 0) {
      searchResults = [];
      searchBusy = false;
      focusedResultIdx = -1;
      if (searchAbort) searchAbort.abort();
      searchAbort = null;
      return;
    }
    const timer = setTimeout(() => {
      void runSearch(q);
    }, SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  });

  async function runSearch(query: string): Promise<void> {
    if (!app.supabase || !app.venice) return;
    // Supersede any in-flight search: abort the old embed call so its
    // late arrival can't overwrite a newer query's results.
    if (searchAbort) searchAbort.abort();
    const ctl = new AbortController();
    searchAbort = ctl;
    searchBusy = true;
    try {
      let queryEmbedding: number[] | null = null;
      try {
        const resp = await app.venice.embed({
          model: VENICE_EMBEDDING_MODEL,
          input: query,
          signal: ctl.signal,
        });
        const raw = resp.data[0]?.embedding;
        if (raw) queryEmbedding = padEmbeddingForStorage(raw);
      } catch {
        // Best-effort: exact-only is still useful. Fall through with
        // queryEmbedding === null; the Supabase method handles that by
        // skipping the RPC.
      }
      if (ctl.signal.aborted) return;
      const hits = await app.supabase.searchThreads({
        query,
        queryEmbedding,
        limit: 50,
      });
      if (ctl.signal.aborted) return;
      searchResults = hits;
      focusedResultIdx = hits.length > 0 ? 0 : -1;
    } catch (err) {
      if (!ctl.signal.aborted) {
        error = { text: err instanceof Error ? err.message : String(err) };
      }
    } finally {
      if (searchAbort === ctl) {
        searchAbort = null;
        searchBusy = false;
      }
    }
  }

  function clearSearch(): void {
    searchQuery = '';
  }

  /**
   * Open a search result. Loads enough of the Older or Archived
   * bucket to include the target row (so the DOM has something to
   * scroll to), clears the search, selects the thread, then scrolls
   * the drawer to its `[data-thread-id]` node. Recent-bucket targets
   * are always already loaded (eager fetch), so the no-op branch is
   * the common case.
   */
  async function openSearchResult(t: Thread): Promise<void> {
    if (!app.supabase) return;
    const bucket = bucketFor(t);
    try {
      if (bucket === 'older' && !olderThreads.some((x) => x.id === t.id)) {
        const rows = await app.supabase.listThreadsSince({
          target: { updated_at: t.updated_at, id: t.id },
          archived: false,
          cutoff: recentCutoff,
        });
        olderThreads = mergeByUpdatedAtDesc(olderThreads, rows);
        const last = rows[rows.length - 1];
        if (last) olderCursor = { updated_at: last.updated_at, id: last.id };
      } else if (bucket === 'archived') {
        archiveExpanded = true;
        if (!archivedPage.some((x) => x.id === t.id)) {
          const rows = await app.supabase.listThreadsSince({
            target: { updated_at: t.updated_at, id: t.id },
            archived: true,
            cutoff: null,
          });
          archivedPage = mergeByUpdatedAtDesc(archivedPage, rows);
          const last = rows[rows.length - 1];
          if (last) archivedCursor = { updated_at: last.updated_at, id: last.id };
        }
      }
    } catch (err) {
      // Best-effort: even if the window-fetch fails, still open the
      // thread — the drawer just won't scroll to it. An error
      // here usually means the Supabase session has expired or the
      // network is down; both get surfaced via the banner on the
      // subsequent selectThread call anyway.
      error = { text: err instanceof Error ? err.message : String(err) };
    }

    clearSearch();
    await selectThread(t.id);
    await tick();
    scrollDrawerToThread(t.id);
  }

  function scrollDrawerToThread(id: string): void {
    const el = document.querySelector(`[data-thread-id="${id}"]`);
    if (el instanceof HTMLElement) {
      el.scrollIntoView({ block: 'center', behavior: 'smooth' });
    }
  }

  // Arrow-key navigation while the search input owns focus. Enter
  // opens the focused row; Escape clears the query. Scoped to the
  // input via `onkeydown` rather than document-level to avoid
  // interfering with the message-list area.
  function onSearchKey(e: KeyboardEvent): void {
    if (searchResults.length === 0) {
      if (e.key === 'Escape') clearSearch();
      return;
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      focusedResultIdx = Math.min(focusedResultIdx + 1, searchResults.length - 1);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      focusedResultIdx = Math.max(focusedResultIdx - 1, 0);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const hit = searchResults[focusedResultIdx];
      if (hit) void openSearchResult(hit.thread);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      clearSearch();
    }
  }

  // -----------------------------------------------------------------------
  // Infinite-scroll sentinels
  // -----------------------------------------------------------------------
  //
  // Two sentinel elements at the bottom of the Older and Archived
  // sections. When one intersects the drawer viewport we fire the
  // corresponding `loadMore*` call. A single IntersectionObserver
  // handles both; we disambiguate via `dataset.bucket`.

  let olderSentinelEl: HTMLDivElement | undefined = $state();
  let archivedSentinelEl: HTMLDivElement | undefined = $state();

  $effect(() => {
    if (typeof IntersectionObserver === 'undefined') return;
    // Re-create the observer whenever the sentinel refs change. Svelte
    // 5 runs this effect after every DOM patch, so the `untrack`-free
    // reads below pin the dependency set to exactly these two refs
    // plus the drawerOpen flag (observers on a hidden drawer are
    // harmless but unnecessary).
    const older = olderSentinelEl;
    const archived = archivedSentinelEl;
    if (!older && !archived) return;
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          const bucket = (entry.target as HTMLElement).dataset.bucket;
          if (bucket === 'older') void loadMoreOlder();
          else if (bucket === 'archived') void loadMoreArchived();
        }
      },
      {
        // Trigger a little before the sentinel is on-screen so the
        // next page arrives while the user's still scrolling, not as
        // an obvious pause at the bottom.
        rootMargin: '200px 0px',
        threshold: 0,
      }
    );
    if (older) observer.observe(older);
    if (archived) observer.observe(archived);
    return () => observer.disconnect();
  });

  // Auto-scroll the drawer to the currently-active thread whenever it
  // opens. Uses the same [data-thread-id] scroll machinery
  // `openSearchResult` relies on, so a future thread-not-yet-loaded
  // case can reuse the window-fetch path.
  $effect(() => {
    if (!drawerOpen || !activeThreadId) return;
    // Wait for the drawer transition to start so the scroll target is
    // measurable; `tick()` alone runs before layout, which
    // scrollIntoView handles correctly but scrolls the hidden drawer
    // instead of the visible one.
    const id = activeThreadId;
    const timer = setTimeout(() => scrollDrawerToThread(id), 40);
    return () => clearTimeout(timer);
  });
</script>

{#if !sessionLoaded}
  <div class="center"><p class="subtle">Connecting…</p></div>
{:else if !session}
  <Auth />
{:else if showSettings}
  <Settings
    onClose={() => navigate({ modal: null })}
    onOpenMemories={() => navigate({ modal: 'memories' })}
  />
{:else if showHelp}
  <Help onClose={() => navigate({ modal: null, doc: null })} />
{:else if showMemories}
  <Memories onClose={() => navigate({ modal: null })} />
{:else if showCookbook}
  <Cookbook onClose={onCookbookModalClose} />
{:else}
  <div class="shell" class:drawer-open={drawerOpen}>
    <div
      class="drawer-backdrop"
      onclick={closeDrawer}
      onkeydown={(e) => { if (e.key === 'Escape') closeDrawer(); }}
      role="button"
      tabindex={drawerOpen ? 0 : -1}
      aria-label="Close thread drawer"
      aria-hidden={!drawerOpen}
    ></div>
    <aside class="sidebar">
      <header class="sidebar-header">
        <!-- Tab switcher between conversation threads and the
             cookbook. Rendered as a vertical pair of thread-row-
             styled buttons above the search input so the nav items
             visually belong to the same "row in a list" family as
             the conversations or recipes they switch between.
             Keeping both lists here avoids a second top-level drawer
             affordance for a feature whose relationship to Chats is
             "two sibling collections of user-owned items". Clicks
             route through the URL router - Chats clears the drawer
             param (absent = default) and Recipes goes through the
             lazy-load wrapper; both use replaceState so a chats
             <-> recipes flip doesn't fill the back stack with UI
             chrome. -->
        <div class="sidebar-nav" role="tablist" aria-label="Drawer section">
          <div class="row thread-row">
            <button
              type="button"
              role="tab"
              class="thread grow"
              class:active={drawerTab === 'chats'}
              aria-selected={drawerTab === 'chats'}
              onclick={() => navigate({ drawer: null }, { replace: true })}
            >Chats</button>
          </div>
          <div class="row thread-row">
            <button
              type="button"
              role="tab"
              class="thread grow"
              class:active={drawerTab === 'recipes'}
              aria-selected={drawerTab === 'recipes'}
              onclick={() => onPickRecipesTab()}
            >Recipes</button>
          </div>
        </div>
        {#if drawerTab === 'chats'}
          <!-- Search replaces the old "+ New thread" button — the
               topbar's `.new-thread-mini` icon (now visible on every
               viewport, not just mobile) is the primary new-thread
               affordance. -->
          <input
            type="search"
            class="sidebar-search-input"
            placeholder="Search conversations"
            aria-label="Search conversations"
            bind:value={searchQuery}
            onkeydown={onSearchKey}
          />
        {:else}
          <input
            type="search"
            class="sidebar-search-input"
            placeholder="Search recipes"
            aria-label="Search recipes"
            bind:value={recipeDrawerQuery}
          />
        {/if}
      </header>
      {#if drawerTab === 'chats'}
      <div class="thread-list">
        {#snippet threadRow(t: Thread)}
          <div class="row thread-row" data-thread-id={t.id}>
            <button
              class="thread grow"
              class:active={t.id === activeThreadId}
              onclick={() => onThreadClick(t.id)}
              ontouchstart={() => startLongPress(t.id)}
              ontouchend={cancelLongPress}
              ontouchmove={cancelLongPress}
              ontouchcancel={cancelLongPress}
              title={t.title || 'Untitled'}
            >
              {#if titlingThreadIds.has(t.id)}
                <Scanner label="Generating title" size={0.85} />
              {:else}
                {t.title || 'Untitled'}
              {/if}
            </button>
            <button
              class="secondary thread-actions-btn"
              onclick={(e) => { e.stopPropagation(); toggleRowMenu(t.id); }}
              aria-haspopup="menu"
              aria-expanded={openMenuThreadId === t.id}
              title="Actions"
              aria-label="Thread actions"
            >⋯</button>
            {#if openMenuThreadId === t.id}
              <div class="thread-menu" role="menu">
                {#if t.archived}
                  <button class="thread-menu-item" role="menuitem"
                          onclick={() => restoreThread(t.id)}>Restore</button>
                  <button class="thread-menu-item danger" role="menuitem"
                          onclick={() => deleteThread(t.id)}>Delete</button>
                {:else}
                  <button class="thread-menu-item" role="menuitem"
                          onclick={() => archiveThread(t.id)}
                          disabled={t.isDraft}
                          title={t.isDraft ? "Draft threads can't be archived — send or rename to save first." : undefined}>
                    Archive
                  </button>
                  <button class="thread-menu-item" role="menuitem"
                          onclick={() => renameFromRow(t.id)}>Rename</button>
                  <button class="thread-menu-item danger" role="menuitem"
                          onclick={() => deleteThread(t.id)}>Delete</button>
                {/if}
              </div>
            {/if}
          </div>
        {/snippet}

        {#snippet searchResultRow(hit: ThreadSearchHit, idx: number)}
          <!-- Results have no kebab menu (no archive/rename/delete
               while searching) and get greyed when archived. -->
          <div
            class="row thread-row search-result"
            class:archived-result={hit.thread.archived}
            data-thread-id={hit.thread.id}
          >
            <button
              class="thread grow"
              class:active={hit.thread.id === activeThreadId}
              class:focused={idx === focusedResultIdx}
              onclick={() => openSearchResult(hit.thread)}
              title={hit.thread.title || 'Untitled'}
            >
              <span class="search-result-title">{hit.thread.title || 'Untitled'}</span>
              <span
                class="search-result-kind"
                aria-label={hit.kind === 'exact' ? 'exact title match' : 'semantic match'}
              >{hit.kind}</span>
            </button>
          </div>
        {/snippet}

        {#if searchQuery.trim().length > 0}
          <!-- Search mode: replace the paginated list entirely.
               Escape or clearing the input returns to the list view.
               An in-flight search renders a Scanner in place of the
               result list so the user sees the work happening. -->
          {#if searchBusy && searchResults.length === 0}
            <div class="search-status">
              <Scanner label="Searching conversations" size={0.9} />
            </div>
          {:else if searchResults.length === 0}
            <p class="subtle" style="padding:0.75rem">No matches.</p>
          {:else}
            {#each searchResults as hit, idx (hit.thread.id)}
              {@render searchResultRow(hit, idx)}
            {/each}
          {/if}
        {:else}
          <!-- Recent: everything updated in the last 3 days. Drafts
               live above Recent since they're always "in progress"
               even though they have no server-side updated_at. -->
          {#if drafts.length > 0 || recentThreads.length > 0}
            <h3 class="bucket-header">Recent</h3>
            {#each drafts as t (t.id)}
              {@render threadRow(t)}
            {/each}
            {#each recentThreads as t (t.id)}
              {@render threadRow(t)}
            {/each}
          {/if}

          <!-- Older: paginated 25 at a time. Header hides when there's
               nothing to show so a fresh account doesn't see an empty
               "Older" stub above its first real thread. -->
          {#if olderThreads.length > 0 || olderHasMore}
            <h3 class="bucket-header">Older</h3>
            {#each olderThreads as t (t.id)}
              {@render threadRow(t)}
            {/each}
            {#if olderHasMore}
              <div
                class="sentinel"
                bind:this={olderSentinelEl}
                data-bucket="older"
                aria-hidden="true"
              >
                {#if olderLoading}
                  <Scanner label="Loading older conversations" size={0.85} />
                {/if}
              </div>
            {/if}
          {/if}

          {#if drafts.length === 0 && recentThreads.length === 0 && olderThreads.length === 0 && !olderLoading && !olderHasMore}
            <p class="subtle" style="padding:0.75rem">No threads yet.</p>
          {/if}

          <!-- Archive: collapsible, paginated 25 at a time. The
               section header always shows while Archive has any rows
               OR more pages are available — otherwise a fresh account
               with zero archived threads doesn't see an empty section
               cluttering the drawer. -->
          {#if archivedPage.length > 0 || archivedHasMore}
            <div class="archive-section">
              <button
                class="archive-toggle"
                onclick={() => (archiveExpanded = !archiveExpanded)}
                aria-expanded={archiveExpanded}
                aria-controls="archive-list"
              >
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none"
                     stroke="currentColor" stroke-width="2" stroke-linecap="round"
                     stroke-linejoin="round" aria-hidden="true"
                     class="archive-chevron" class:expanded={archiveExpanded}>
                  <polyline points="9 6 15 12 9 18" />
                </svg>
                <span class="archive-label">Archive</span>
              </button>
              {#if archiveExpanded}
                <div id="archive-list">
                  {#each archivedPage as t (t.id)}
                    {@render threadRow(t)}
                  {/each}
                  {#if archivedHasMore}
                    <div
                      class="sentinel"
                      bind:this={archivedSentinelEl}
                      data-bucket="archived"
                      aria-hidden="true"
                    >
                      {#if archivedLoading}
                        <Scanner label="Loading archived conversations" size={0.85} />
                      {/if}
                    </div>
                  {/if}
                </div>
              {/if}
            </div>
          {/if}
        {/if}
      </div>
      {:else}
        <!-- Recipes tab. Click opens the Cookbook modal on the detail
             pane for that recipe. The list itself is a flattened read-
             only view into `cookbook.recipes`; editing flows through
             the modal, which owns the edit form and the delete
             confirmation. -->
        <div class="recipe-drawer-list">
          {#if cookbook.loading && cookbook.recipes.length === 0}
            <p class="subtle" style="padding:0.75rem">Loading recipes…</p>
          {:else if visibleDrawerRecipes.length === 0}
            <p class="subtle" style="padding:0.75rem">
              {#if cookbook.recipes.length === 0}
                No recipes yet. Open the Cookbook to add one.
              {:else}
                No matches.
              {/if}
            </p>
          {:else}
            {#each visibleDrawerRecipes as r (r.id)}
              <div class="row thread-row" data-recipe-id={r.id}>
                <button
                  class="thread grow"
                  onclick={() => openRecipeFromDrawer(r.id)}
                  title={r.title}
                >{r.title}</button>
              </div>
            {/each}
          {/if}
          <div class="recipe-drawer-footer">
            <button
              type="button"
              class="secondary"
              onclick={() => navigate({ modal: 'cookbook' })}
            >Open cookbook</button>
          </div>
        </div>
      {/if}
      <footer>
        <div class="subtle" style="margin-bottom:0.4rem;font-size:0.8rem">
          {session.user.email}
        </div>
        <div class="row">
          <!-- Help sits first in the row so the leftmost affordance
               is the "where do I start" button. Opens the in-app
               manual (docs/user/ rendered through the Markdown
               pipeline). See src/screens/Help.svelte. -->
          <button
            class="secondary icon-btn"
            onclick={() => navigate({ modal: 'help' })}
            title="Help"
            aria-label="Help"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                 stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <circle cx="12" cy="12" r="10" />
              <path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3" />
              <line x1="12" y1="17" x2="12.01" y2="17" />
            </svg>
          </button>
          <!-- Memories modal — the human-facing browser for the
               memory table the reflection/recall agents read and
               write behind the scenes. See src/screens/Memories.svelte.
               Uses the Feather "bookmark" glyph so it doesn't collide
               with the adjacent Cookbook button (which owns the
               "book" glyph). Semantically a bookmark — a thing
               you flagged to remember — is closer to a memory than
               a closed book anyway. -->
          <button
            class="secondary icon-btn"
            onclick={() => navigate({ modal: 'memories' })}
            title="Memories"
            aria-label="Memories"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                 stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z" />
            </svg>
          </button>
          <button
            class="secondary icon-btn"
            onclick={() => navigate({ modal: 'cookbook' })}
            title="Cookbook"
            aria-label="Cookbook"
          >
            <!-- Feather-style "book" glyph — paths taken from the Feather
                 Icons "book" icon so it visually matches the rest of the
                 footer row (help, settings, lock) that also use 16×16
                 Feather-style strokes. -->
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                 stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" />
              <path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z" />
            </svg>
          </button>
          <button
            class="secondary icon-btn"
            onclick={() => navigate({ modal: 'settings' })}
            title="Settings"
            aria-label="Settings"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                 stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <circle cx="12" cy="12" r="3" />
              <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
            </svg>
          </button>
          <button
            class="secondary icon-btn lock-btn"
            onclick={lock}
            title="Lock (session is unlocked)"
            aria-label="Lock"
          >
            <svg class="lock-open" width="16" height="16" viewBox="0 0 24 24" fill="none"
                 stroke="currentColor" stroke-width="2" stroke-linecap="round"
                 stroke-linejoin="round" aria-hidden="true">
              <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
              <path d="M7 11V7a5 5 0 0 1 9.9-1" />
            </svg>
            <svg class="lock-closed" width="16" height="16" viewBox="0 0 24 24" fill="none"
                 stroke="currentColor" stroke-width="2" stroke-linecap="round"
                 stroke-linejoin="round" aria-hidden="true">
              <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
              <path d="M7 11V7a5 5 0 0 1 10 0v4" />
            </svg>
          </button>
          <button
            class="secondary icon-btn"
            onclick={signOut}
            title="Sign out"
            aria-label="Sign out"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                 stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
              <polyline points="16 17 21 12 16 7" />
              <line x1="21" y1="12" x2="9" y2="12" />
            </svg>
          </button>
        </div>
      </footer>
    </aside>

    <main class="chat">
      <div class="top-bar">
        <button
          class="secondary icon-btn hamburger"
          onclick={toggleDrawer}
          title={drawerOpen ? 'Hide threads' : 'Show threads'}
          aria-label={drawerOpen ? 'Hide threads' : 'Show threads'}
          aria-expanded={drawerOpen}
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor"
               stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <line x1="3" y1="6" x2="21" y2="6" />
            <line x1="3" y1="12" x2="21" y2="12" />
            <line x1="3" y1="18" x2="21" y2="18" />
          </svg>
        </button>
        <button
          class="secondary icon-btn new-thread-mini"
          onclick={newThread}
          disabled={currentIsEmpty}
          title={currentIsEmpty ? "You're already on an empty thread." : 'Start a new conversation'}
          aria-label="Start a new conversation"
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor"
               stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path d="M21 15a2 2 0 0 1-2 2H8l-5 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
          </svg>
        </button>
        <div class="title-wrap">
          {#if !currentThread}
            <div class="subtle">Start a new conversation</div>
          {:else if renaming}
            <input
              class="title-input"
              bind:this={titleInputEl}
              bind:value={renameBuffer}
              onkeydown={onTitleKey}
              onblur={commitRename}
              maxlength="80"
            />
          {:else if titlingThreadIds.has(currentThread.id)}
            <div class="title-btn" aria-label="Generating title">
              <Scanner label="Generating title" />
            </div>
          {:else}
            <button
              class="title-btn"
              title="Click to rename"
              onclick={startRename}
            >{currentThread.title || 'Untitled'}</button>
          {/if}
        </div>
        <!-- Logs drawer toggle. Document-glyph icon so the button reads
             as "open the reading panel" rather than "new document".
             Placed after `.title-wrap` so the flex layout parks it on
             the right edge, aligned with the right-anchored drawer it
             opens. Wired to the logsDrawer rune singleton; the
             LogsDrawer component mounted at Chat root watches the
             same state. -->
        <button
          class="secondary icon-btn logs-toggle"
          onclick={() => logsDrawer.toggle()}
          title={logsDrawer.state.open ? 'Hide logs' : 'Show logs'}
          aria-label={logsDrawer.state.open ? 'Hide logs' : 'Show logs'}
          aria-expanded={logsDrawer.state.open}
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor"
               stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
            <polyline points="14 2 14 8 20 8" />
            <line x1="16" y1="13" x2="8" y2="13" />
            <line x1="16" y1="17" x2="8" y2="17" />
            <line x1="10" y1="9" x2="8" y2="9" />
          </svg>
        </button>
      </div>
      <div class="messages-wrap">
        <div
          class="messages"
          bind:this={messagesEl}
          onscroll={onMessagesScroll}
        >
          {#each messageBlocks as block (block.kind === 'plain' ? block.message.id : block.assistant.id)}
            {#if block.kind === 'tool-group'}
              <!-- Tool-group bubble: reuse AssistantBody for the markdown
                   / reasoning / citations triad, with `<ToolCalls>`
                   snippet-slotted between the body and the action bar.
                   The bubble itself still lives here so the component
                   stays focused on per-message body concerns. -->
              <div class="msg assistant">
                <AssistantBody
                  content={block.assistant.content}
                  reasoning={block.assistant.reasoning}
                  citations={block.assistant.citations}
                  model={block.assistant.model}
                  usage={block.assistant.usage}
                >
                  <ToolCalls
                    calls={block.assistant.tool_calls ?? []}
                    resultsByCallId={block.resultsByCallId}
                    timings={toolTimings}
                    nowMs={nowMs}
                  />
                </AssistantBody>
              </div>
            {:else if block.message.role === 'assistant'}
              <div class="msg assistant">
                <AssistantBody
                  content={block.message.content}
                  reasoning={block.message.reasoning}
                  citations={block.message.citations}
                  model={block.message.model}
                  usage={block.message.usage}
                />
              </div>
            {:else}
              <div class="msg {block.message.role}">
                <Markdown content={block.message.content} />
                {#if block.message.role === 'user' && block.message.attachments && block.message.attachments.length > 0}
                  <MessageAttachments attachments={block.message.attachments} />
                {/if}
              </div>
            {/if}
          {/each}
          {#if sending || streamingText || streamingReasoning}
            <div class="msg assistant">
              <!-- Live reasoning panel. Open when `streamingReasoningOpen`
                   is true; flipped on by the first reasoning delta and
                   flipped off 600ms after the first content delta (see
                   the onTextUpdate / onReasoningUpdate handlers). The
                   duration is slightly longer than on replayed rows to
                   sell the close as a deliberate hand-off to the
                   answer below. -->
              <ReasoningPanel
                reasoning={streamingReasoning}
                bind:open={streamingReasoningOpen}
                duration={320}
              />
              {#if streamingText}
                <!-- Live markdown render of the in-progress buffer. The
                     onTextUpdate handler throttles writes to ~4Hz (see
                     FLUSH_MS in send()), so marked + DOMPurify +
                     highlight.js only re-parse the growing string a few
                     times per second. Unclosed fences / bold / math
                     resolve themselves as more deltas arrive; once the
                     stream ends the persisted message rerenders through
                     this same <Markdown> path. -->
                <Markdown content={streamingText} />
              {:else if !streamingReasoning}
                <!-- Placeholder shown between "user hit send" and "first
                     token arrived" — gives the composer submit some
                     immediate feedback that something is happening.
                     Wrapper centers the inline-flex Scanner inside the
                     bubble so it doesn't read as a stranded artifact in
                     the top-left corner. Suppressed once reasoning has
                     started (the thinking panel is itself feedback). -->
                <div class="thinking">
                  <Scanner label="Thinking" />
                </div>
              {/if}
              <!-- Live citations panel. Venice ships the full list in
                   the first chunk, so it typically appears ahead of
                   the answer body. Shown open-always during streaming
                   (no toggle button here; the streaming bubble has no
                   action bar). Once the assistant row persists, the
                   regular AssistantBody panel takes over with the
                   toggle affordance. -->
              {#if streamingCitations && streamingCitations.length > 0}
                <CitationsPanel citations={streamingCitations} open={true} />
              {/if}
            </div>
          {/if}
          {#if messages.length === 0 && !streamingText && !sending}
            <div class="empty">Type a message to begin.</div>
          {/if}
          <!-- End-of-conversation notice for archived chats. Sits inside
               .messages so it scrolls with the transcript, and after any
               streaming bubble so it always reads as "the end". -->
          {#if currentThread?.archived}
            <div class="archived-notice">
              This conversation is archived. Restore it to continue.
            </div>
          {/if}
        </div>
        {#if !followBottom && hasOverflow}
          <button
            type="button"
            class="scroll-to-bottom"
            onclick={() => {
              followBottom = true;
              scrollToBottom(true);
            }}
            title="Scroll to latest"
            aria-label="Scroll to latest"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none"
                 stroke="currentColor" stroke-width="2.5" stroke-linecap="round"
                 stroke-linejoin="round" aria-hidden="true">
              <polyline points="6 9 12 15 18 9" />
            </svg>
          </button>
        {/if}
      </div>
      {#if error}
        <div class="error-bar">
          <p class="error">{error.text}</p>
          {#if error.retry}
            <button
              type="button"
              class="secondary icon-btn error-retry"
              onclick={error.retry}
              disabled={sending}
              title="Retry"
              aria-label="Retry"
            >
              <!-- Refresh / circular-arrow icon (Feather "refresh-cw"). -->
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none"
                   stroke="currentColor" stroke-width="2" stroke-linecap="round"
                   stroke-linejoin="round" aria-hidden="true">
                <polyline points="23 4 23 10 17 10" />
                <polyline points="1 20 1 14 7 14" />
                <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10" />
                <path d="M20.49 15a9 9 0 0 1-14.85 3.36L1 14" />
              </svg>
            </button>
          {/if}
        </div>
      {/if}
      <div class="composer">
        <div
          class="composer-shell"
          class:dragging={isDragging}
          ondragenter={onComposerDragEnter}
          ondragover={onComposerDragOver}
          ondragleave={onComposerDragLeave}
          ondrop={onComposerDrop}
          role="group"
        >
          {#if isDragging}
            <!-- Drop overlay. Sits over the textarea while a file drag
                 is in progress so the user has visible feedback that
                 releasing here will attach. pointer-events:none would
                 cause the hover styling to cascade to the textarea,
                 so we wrap the overlay in an absolutely-positioned
                 div that lets drag events pass through. -->
            <div class="composer-drop-overlay" aria-hidden="true">
              Drop files to attach
            </div>
          {/if}
          {#if pendingAttachments.length > 0}
            <div class="composer-attachments" role="list">
              {#each pendingAttachments as a (a.id)}
                <div
                  class="composer-attachment-chip"
                  class:pending={a.pending}
                  class:errored={!!a.error}
                  role="listitem"
                  title={a.error ?? ''}
                >
                  <span class="chip-name">{a.filename}</span>
                  <span class="chip-size">{formatBytes(a.size_bytes)}</span>
                  {#if a.pending}
                    <span class="chip-status" aria-label="Processing">…</span>
                  {:else if a.error}
                    <span class="chip-status chip-error" aria-label="Error">!</span>
                  {/if}
                  <button
                    type="button"
                    class="chip-remove"
                    aria-label="Remove attachment"
                    onclick={() => removeAttachment(a.id)}
                  >×</button>
                </div>
              {/each}
            </div>
          {/if}
          <textarea
            class="composer-textarea"
            bind:value={composer}
            bind:this={composerEl}
            onkeydown={onKeydown}
            onpaste={onComposerPaste}
            placeholder={currentThread?.archived
              ? 'Restore this conversation to continue.'
              : `Message… (${sendHint})`}
            disabled={sending || currentThread?.archived}
          ></textarea>
          <!-- Hidden file input — the paperclip button triggers this
               via .click(). `multiple` because users routinely attach
               more than one file at a time; no `accept` filter
               because we deliberately allow any MIME type (the
               pre-send guard decides whether the model can read it). -->
          <input
            type="file"
            class="composer-file-input"
            bind:this={fileInputEl}
            onchange={onFileInputChange}
            multiple
            aria-hidden="true"
            tabindex="-1"
          />
          <div class="composer-bar">
            <div class="composer-bar-left">
              <!-- Tool master switch: on = every registered tool's schema
                   rides along with the next send; off = only toggle_tools.
                   Pulses on LLM-initiated flips via .flash (see CSS). Sits
                   first in the row because whether tools are armed for
                   this conversation is the most load-bearing decision on
                   this toolbar — cost and capability both pivot on it. -->
              {#if currentThread && !currentThread.isDraft}
                <button
                  type="button"
                  class="secondary toolbox-btn"
                  class:on={currentThread.tools_enabled}
                  class:flash={toolboxFlash}
                  onclick={toggleToolsManually}
                  title={currentThread.tools_enabled
                    ? 'Tools ON — click to disable'
                    : 'Tools OFF — click to enable'}
                  aria-label={currentThread.tools_enabled ? 'Disable tools' : 'Enable tools'}
                  aria-pressed={currentThread.tools_enabled}
                >
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none"
                       stroke="currentColor" stroke-width="2"
                       stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                    <path d="M3 7h18v12a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7z" />
                    <path d="M8 7V5a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                    <line x1="3" y1="12" x2="21" y2="12" />
                    <line x1="10" y1="12" x2="10" y2="14" />
                    <line x1="14" y1="12" x2="14" y2="14" />
                  </svg>
                </button>
              {/if}

              <!-- File picker: opens a native file chooser; selected
                   files become pendingAttachments chips above the
                   textarea. Paste (on the textarea) and drag-drop
                   (on the composer-shell) are the two other entry
                   points into the same add pipeline. -->
              <button
                type="button"
                class="secondary icon-btn"
                class:active={pendingAttachments.length > 0}
                onclick={onFilePicker}
                title="Attach files (or paste / drag-drop)"
                aria-label="Attach files"
                disabled={sending ||
                  currentThread?.archived ||
                  pendingAttachments.length >= MAX_ATTACHMENTS_PER_MESSAGE}
              >
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none"
                     stroke="currentColor" stroke-width="2" stroke-linecap="round"
                     stroke-linejoin="round" aria-hidden="true">
                  <path d="M21.44 11.05L12.25 20.24a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66L9.41 17.41a2 2 0 1 1-2.83-2.83L14.5 6.66" />
                </svg>
                {#if pendingAttachments.length > 0}
                  <span class="badge" aria-hidden="true">{pendingAttachments.length}</span>
                {/if}
              </button>

              <!-- Prompts: toggles which system prompts ride along on
                   every future send in this conversation. -->
              <button
                type="button"
                class="secondary icon-btn"
                class:active={activePromptCount > 0}
                onclick={() => {
                  modelMenuOpen = false;
                  reasoningMenuOpen = false;
                  verbosityMenuOpen = false;
                  promptsMenuOpen = !promptsMenuOpen;
                }}
                title="System prompts"
                aria-label="System prompts"
                aria-haspopup="true"
                aria-expanded={promptsMenuOpen}
                disabled={app.systemPrompts.length === 0}
              >
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                     stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                  <line x1="4" y1="21" x2="4" y2="14" />
                  <line x1="4" y1="10" x2="4" y2="3" />
                  <line x1="12" y1="21" x2="12" y2="12" />
                  <line x1="12" y1="8" x2="12" y2="3" />
                  <line x1="20" y1="21" x2="20" y2="16" />
                  <line x1="20" y1="12" x2="20" y2="3" />
                  <line x1="1" y1="14" x2="7" y2="14" />
                  <line x1="9" y1="8" x2="15" y2="8" />
                  <line x1="17" y1="16" x2="23" y2="16" />
                </svg>
                {#if activePromptCount > 0}
                  <span class="badge" aria-hidden="true">{activePromptCount}</span>
                {/if}
              </button>

              <!-- Model picker: per-thread override, stored on threads.model.
                   Renders unconditionally — even with no active thread the
                   current tier is well-defined (falls back to the user
                   default via `resolveTier`), and `setTier` auto-creates
                   a draft on first pick so the choice has somewhere to
                   live. Gating on `currentThread` hid the button on any
                   fresh session where session-restore didn't pick a thread,
                   which on mobile is the common case. -->
              <button
                type="button"
                class="secondary model-picker-btn"
                onclick={() => {
                  promptsMenuOpen = false;
                  reasoningMenuOpen = false;
                  verbosityMenuOpen = false;
                  modelMenuOpen = !modelMenuOpen;
                }}
                aria-haspopup="true"
                aria-expanded={modelMenuOpen}
                title={`Model: ${MODELS[currentTier].label} (${MODELS[currentTier].id})`}
              >
                <!-- Generic "model selection" glyph for the collapsed
                     icon-only trigger. A CPU outline rather than the
                     tier emoji so the button reads as "pick a model"
                     instead of "currently on 🧠" — the CSS hides the
                     tier emoji whenever this CPU icon precedes it. -->
                <svg class="model-picker-model-icon" width="18" height="18"
                     viewBox="0 0 24 24" fill="none" stroke="currentColor"
                     stroke-width="2" stroke-linecap="round" stroke-linejoin="round"
                     aria-hidden="true">
                  <rect x="4" y="4" width="16" height="16" rx="2" />
                  <rect x="9" y="9" width="6" height="6" />
                  <line x1="9" y1="2" x2="9" y2="4" />
                  <line x1="15" y1="2" x2="15" y2="4" />
                  <line x1="9" y1="20" x2="9" y2="22" />
                  <line x1="15" y1="20" x2="15" y2="22" />
                  <line x1="20" y1="9" x2="22" y2="9" />
                  <line x1="20" y1="14" x2="22" y2="14" />
                  <line x1="2" y1="9" x2="4" y2="9" />
                  <line x1="2" y1="14" x2="4" y2="14" />
                </svg>
                <span class="model-picker-icon" aria-hidden="true">{MODELS[currentTier].icon}</span>
                <span class="model-picker-label">{MODELS[currentTier].label}</span>
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                     stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                  <polyline points="6 9 12 15 18 9" />
                </svg>
              </button>

              <!-- Reasoning-effort picker: per-thread override, stored on
                   threads.reasoning_effort. Hidden when the resolved model
                   doesn't advertise reasoning support — no point offering
                   a knob the provider will reject. Renders with no active
                   thread too: `currentReasoning` falls back to the user
                   default via `resolveReasoningEffort`, and `setReasoning`
                   auto-creates a draft on first pick so the choice has
                   somewhere to land — same pattern as the model picker.
                   Extracted so the picker is mountable in isolation under
                   @testing-library/svelte; Chat.svelte itself is too
                   coupled to the live app state to mount cleanly. -->
              {#if currentSupportsReasoning}
                <ReasoningPicker
                  value={currentReasoning}
                  defaultEffort={defaultReasoning}
                  open={reasoningMenuOpen}
                  onToggle={() => {
                    promptsMenuOpen = false;
                    modelMenuOpen = false;
                    verbosityMenuOpen = false;
                    reasoningMenuOpen = !reasoningMenuOpen;
                  }}
                  onSelect={(effort) => {
                    void setReasoning(effort);
                    reasoningMenuOpen = false;
                  }}
                />
              {/if}

              <!-- Verbosity picker: per-thread override, stored on
                   threads.verbosity. Surfaced unconditionally — unlike
                   the reasoning picker there's no model-capability
                   gate; providers that don't recognize `text.verbosity`
                   silently ignore it. Same auto-create-draft pattern
                   as the model and reasoning pickers so the choice
                   always has somewhere to land. -->
              <VerbosityPicker
                value={currentVerbosity}
                defaultVerbosity={defaultVerbosity}
                open={verbosityMenuOpen}
                onToggle={() => {
                  promptsMenuOpen = false;
                  modelMenuOpen = false;
                  reasoningMenuOpen = false;
                  verbosityMenuOpen = !verbosityMenuOpen;
                }}
                onSelect={(v) => {
                  void setVerbosity(v);
                  verbosityMenuOpen = false;
                }}
              />
            </div>

            <button
              class="send-btn composer-send"
              onclick={send}
              disabled={sending ||
                (composer.trim().length === 0 && pendingAttachments.length === 0) ||
                currentThread?.archived}
              title={sending
                ? 'Sending…'
                : currentThread?.archived
                  ? 'Archived — restore to continue'
                  : 'Send'}
              aria-label={sending ? 'Sending' : 'Send'}
            >
              <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"
                   aria-hidden="true">
                <path d="M2.01 21 23 12 2.01 3 2 10l15 2-15 2z" />
              </svg>
            </button>

            {#if promptsMenuOpen}
              <div class="composer-menu composer-menu-left" role="menu">
                <div class="menu-header">Active for this conversation</div>
                {#each app.systemPrompts as p (p.id)}
                  <label class="menu-item">
                    <input
                      type="checkbox"
                      checked={activePromptIds.has(p.id)}
                      onchange={() => togglePrompt(p.id)}
                    />
                    <span class="menu-item-label">{p.name || '(unnamed)'}</span>
                    {#if p.enabledByDefault}<span class="menu-item-badge">default</span>{/if}
                  </label>
                {/each}
                {#if app.systemPrompts.length === 0}
                  <div class="menu-empty">No prompts — add some in Settings.</div>
                {/if}
              </div>
            {/if}

            {#if modelMenuOpen}
              <div class="composer-menu composer-menu-left" role="menu">
                <div class="menu-header">Model for this conversation</div>
                {#each TIERS as tier (tier)}
                  <button
                    type="button"
                    class="menu-item menu-item-btn"
                    class:selected={currentTier === tier}
                    onclick={() => {
                      void setTier(tier);
                      modelMenuOpen = false;
                    }}
                    role="menuitemradio"
                    aria-checked={currentTier === tier}
                  >
                    <span class="menu-item-icon" aria-hidden="true">{MODELS[tier].icon}</span>
                    <span class="menu-item-label">
                      <strong>{MODELS[tier].label}</strong>
                      <span class="subtle" style="display:block;font-size:0.75rem">{MODELS[tier].id}</span>
                    </span>
                    {#if tier === defaultTier}<span class="menu-item-badge">default</span>{/if}
                  </button>
                {/each}
              </div>
            {/if}

          </div>
        </div>
      </div>
    </main>
  </div>
  <!-- Global right-side drawer for the extracted-text preview.
       Controlled by the `extractedTextDrawer` rune store; any
       MessageAttachments "Text" button clicks route through there.
       Mounted at the Chat root so it can sit above the transcript
       without the transcript being a containing block for its
       fixed positioning. -->
  <ExtractedTextDrawer />
  <!-- Global left-side drawer for the in-app log buffer. Controlled
       by the `logsDrawer` rune singleton; the scroll-icon button in
       the top bar toggles it. Mounted at Chat root for the same
       reason as ExtractedTextDrawer - overlay positioning can't sit
       inside a containing block. -->
  <LogsDrawer />
  <!-- Top-right toast stack for samskara-formation events. Listens
       on a window CustomEvent dispatched by SamskaraManager when
       the formation worker reports a fresh mint. Subtle by design -
       the underlying predictive model is meant to stay background.
       See docs/dev/samskara.md. -->
  <SamskaraToasts />
{/if}
