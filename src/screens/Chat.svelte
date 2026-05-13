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
   *   4. Conversation titles are named by the model itself via the
   *      always-on `update_title` tool (see src/lib/tools/update_title.ts).
   *      The chat-loop injects a per-turn system-prompt note telling the
   *      model the current title and when to call the tool; a manual
   *      rename via the title input pins the title (sets
   *      `title_manually_set=true`) so the model never sees the note
   *      again on that thread.
   *
   * Model selection:
   *   - The top-right toggle sets a per-thread override (threads.model).
   *   - Clicking the tier that matches the user's default clears the
   *     override (writes null) so the thread keeps tracking default
   *     changes — see setTier().
   */
  import { onMount, tick } from 'svelte';
  import type { Session } from '@supabase/supabase-js';
  import { app, lock, applyServerSettings } from '$lib/state.svelte';
  import { notifications, notifyTurnComplete, markThreadRead } from '$lib/notifications.svelte';
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
    type SamskaraFireDiagnosticRow,
    type SamskaraSubstrateDiagnosticRow,
  } from '$lib/supabase';
  import { runChatLoop, toVeniceMessage } from '$lib/chat-loop';
  import { isRecoveryMessage } from '$lib/conversation-recovery';
  import {
    saveDraft,
    updateDraftText,
    deleteDraft,
    loadDraft,
    type StreamingDraft,
  } from '$lib/draft-store';
  import { GATED_TOOLBOX_META } from '$lib/tools';
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
    TIERS,
    TIER_ORDER,
    VENICE_EMBEDDING_MODEL,
    agentModel,
    padEmbeddingForStorage,
    resolveReasoningEffort,
    resolveTier,
    resolveVerbosity,
    type ModelSpec,
    type ModelTier,
    type ReasoningEffort,
    type Verbosity,
  } from '$lib/models';
  // Every screen rendered from this file is loaded lazily. None of
  // them sit on the chat critical path:
  //
  //   - Auth: only rendered when the user is signed OUT (no
  //     session). Most cold-starts arrive with a valid session and
  //     never touch this component.
  //   - Cookbook / Journal / Memories: panel screens, only render
  //     when the corresponding drawerTab is active.
  //   - Settings / Help / Samskara / Intuition: pure modals,
  //     rendered behind a `show*` derived state.
  //
  // Each gets a lazy reference + a $effect that fires the dynamic
  // import the first time its visibility flag flips on. The loaded
  // constructor caches in $state so re-renders skip the round-trip.
  // Vite code-splits each into its own chunk; the main chunk pays
  // for none of them at boot.
  type AuthComponent = typeof import('./Auth.svelte').default;
  type CookbookComponent = typeof import('./Cookbook.svelte').default;
  type JournalComponent = typeof import('./Journal.svelte').default;
  type MemoriesComponent = typeof import('./Memories.svelte').default;
  type WikiComponent = typeof import('./Wiki.svelte').default;
  type SettingsComponent = typeof import('./Settings.svelte').default;
  type HelpComponent = typeof import('./Help.svelte').default;
  type SamskaraComponent = typeof import('./Samskara.svelte').default;
  type IntuitionComponent = typeof import('./Intuition.svelte').default;
  type WikiChangelogComponent = typeof import('./WikiChangelog.svelte').default;
  import RecipeList from '../components/RecipeList.svelte';
  import JournalList from '../components/JournalList.svelte';
  import MemoryList from '../components/MemoryList.svelte';
  import WikiList from '../components/WikiList.svelte';
  import IntuitionPill from '../components/IntuitionPill.svelte';
  import {
    cookbook,
    loadRecipes,
  } from '$lib/cookbook-store.svelte';
  import { onCookbookChange } from '$lib/cookbook-events';
  import {
    journal,
    loadJournalEntries,
  } from '$lib/journal-store.svelte';
  import { onJournalChange } from '$lib/journal-events';
  import {
    memoriesStore,
    runMemoriesSearch,
  } from '$lib/memories-store.svelte';
  import {
    wikiStore,
    runWikiSearch,
  } from '$lib/wiki-store.svelte';
  import { onWikiChange } from '$lib/wiki-events';
  import { wikiLibrarianRunner } from '$lib/agents/wiki-librarian/runner.svelte';
  import { todayInZone, shiftDay } from '$lib/journal-day';
  import { moodState } from '$lib/samskara/mood.svelte';
  import { bandIndexFor, columnFor } from '$lib/samskara/events';
  import {
    coerceIntuitionPayload,
    pickFresherIntuitionPayload,
    type IntuitionPayload,
  } from '$lib/intuition';
  import { pickFresherContextRecallPayload } from '$lib/context-recall';
  import AssistantBody from '../components/AssistantBody.svelte';
  import CohortPanel from '../components/CohortPanel.svelte';
  import Markdown from '../components/Markdown.svelte';
  import ReasoningPanel from '../components/ReasoningPanel.svelte';
  import ReasoningPicker from '../components/ReasoningPicker.svelte';
  import VerbosityPicker from '../components/VerbosityPicker.svelte';
  import Scanner from '../components/Scanner.svelte';
  import ToolCalls from '../components/ToolCalls.svelte';
  import MessageAttachments from '../components/MessageAttachments.svelte';
  // ExtractedTextDrawer + LogsDrawer are toggled overlays - the
  // user has to deliberately open them via a button or an
  // attachment-text affordance, so their content only matters
  // after that first interaction. Lazy-loaded; the chunk fetches
  // on first open. See the lazy-component block below for the
  // shared pattern.
  type ExtractedTextDrawerComponent =
    typeof import('../components/ExtractedTextDrawer.svelte').default;
  type LogsDrawerComponent = typeof import('../components/LogsDrawer.svelte').default;
  import { extractedTextDrawer } from '$lib/extractedTextDrawer.svelte';
  import SamskaraToasts from '../components/SamskaraToasts.svelte';
  import { logsDrawer, createLogger } from '$lib/logger.svelte';

  const log = createLogger('chat');
  import { VeniceError, type VeniceMessage } from '$lib/venice';

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
  const showSamskara = $derived(route.modal === 'samskara');
  const showIntuition = $derived(route.modal === 'intuition');
  const showWikiChangelog = $derived(route.modal === 'wiki-changelog');

  // Lazy components. Each holds the loaded constructor in $state
  // (cached after first import) and an $effect that fires the
  // dynamic import the first time the visibility flag flips on.
  // The render-site `{#if show* && Comp}` guard renders nothing
  // until the chunk lands - visible as a tiny first-open latency,
  // invisible thereafter.
  let ExtractedTextDrawerComp: ExtractedTextDrawerComponent | null = $state(null);
  let LogsDrawerComp: LogsDrawerComponent | null = $state(null);
  let AuthComp: AuthComponent | null = $state(null);
  let CookbookComp: CookbookComponent | null = $state(null);
  let JournalComp: JournalComponent | null = $state(null);
  let MemoriesComp: MemoriesComponent | null = $state(null);
  let WikiComp: WikiComponent | null = $state(null);
  let SettingsComp: SettingsComponent | null = $state(null);
  let HelpComp: HelpComponent | null = $state(null);
  let SamskaraComp: SamskaraComponent | null = $state(null);
  let IntuitionComp: IntuitionComponent | null = $state(null);
  let WikiChangelogComp: WikiChangelogComponent | null = $state(null);
  $effect(() => {
    if (sessionLoaded && !session && !AuthComp) {
      void import('./Auth.svelte').then((m) => (AuthComp = m.default));
    }
  });
  $effect(() => {
    if (extractedTextDrawer.state.payload && !ExtractedTextDrawerComp) {
      void import('../components/ExtractedTextDrawer.svelte').then(
        (m) => (ExtractedTextDrawerComp = m.default)
      );
    }
  });
  $effect(() => {
    if (logsDrawer.state.open && !LogsDrawerComp) {
      void import('../components/LogsDrawer.svelte').then(
        (m) => (LogsDrawerComp = m.default)
      );
    }
  });
  $effect(() => {
    if (drawerTab === 'recipes' && !CookbookComp) {
      void import('./Cookbook.svelte').then((m) => (CookbookComp = m.default));
    }
  });
  $effect(() => {
    if (drawerTab === 'journal' && !JournalComp) {
      void import('./Journal.svelte').then((m) => (JournalComp = m.default));
    }
  });
  $effect(() => {
    if (drawerTab === 'memories' && !MemoriesComp) {
      void import('./Memories.svelte').then((m) => (MemoriesComp = m.default));
    }
  });
  $effect(() => {
    if (drawerTab === 'wiki' && !WikiComp) {
      void import('./Wiki.svelte').then((m) => (WikiComp = m.default));
    }
  });
  $effect(() => {
    if (showSettings && !SettingsComp) {
      void import('./Settings.svelte').then((m) => (SettingsComp = m.default));
    }
  });
  $effect(() => {
    if (showHelp && !HelpComp) {
      void import('./Help.svelte').then((m) => (HelpComp = m.default));
    }
  });
  $effect(() => {
    if (showSamskara && !SamskaraComp) {
      void import('./Samskara.svelte').then((m) => (SamskaraComp = m.default));
    }
  });
  $effect(() => {
    if (showWikiChangelog && !WikiChangelogComp) {
      void import('./WikiChangelog.svelte').then(
        (m) => (WikiChangelogComp = m.default)
      );
    }
  });
  $effect(() => {
    if (showIntuition && !IntuitionComp) {
      void import('./Intuition.svelte').then((m) => (IntuitionComp = m.default));
    }
  });
  // Trigger flags for the recipe and journal "new" top-bar buttons.
  // Chat.svelte sets these to true; the panel component resets them
  // via the $bindable prop after handling the event.
  let cookbookTriggerNew = $state(false);
  let journalTriggerNew = $state(false);
  // Trigger flag for the wiki "Run librarian now" top-bar button.
  // Same $bindable pattern as cookbook/journal: Chat.svelte flips it
  // to true on click, Wiki.svelte opens its confirmation strip and
  // resets the flag.
  let wikiLibrarianTrigger = $state(false);
  // Focused date for the journal top-bar navigation. Derived from the
  // route so back/forward keeps the header in sync with the panel.
  const journalToday = $derived(todayInZone(app.journalTimezone || null));
  const journalFocusedDate = $derived(route.journal_date ?? journalToday);
  /**
   * Sidebar drawer tab. Backed by `route.drawer` - absent in the URL
   * means "chats" (the default). 'recipes', 'journal', and 'memories'
   * render their own list in place of the thread list. Tab switches
   * use replaceState so a tab flip doesn't fill history with
   * UI-chrome entries.
   */
  const drawerTab = $derived<'chats' | 'recipes' | 'journal' | 'memories' | 'wiki'>(
    route.drawer ?? 'chats'
  );
  // Recipe, journal, and memory search/listing state has moved to the
  // RecipeList / JournalList / MemoryList sidebar components.

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

  // Journal drawer tab. Same shape as onPickRecipesTab - the list
  // is lazy-loaded the first time the tab is opened, and the store
  // keeps itself fresh via JOURNAL_CHANGE_EVENT.
  function onPickJournalTab(): void {
    navigate({ drawer: 'journal' }, { replace: true });
    if (app.supabase && !journal.loaded && !journal.loading) {
      void loadJournalEntries(app.supabase, { limit: 200 });
    }
  }

  // Memories drawer tab. Same lazy-load shape - MemoryList's $effect
  // fires the first search via the shared `memoriesStore`, but kicking
  // it on tab-pick lets the panel land on a non-empty list even if the
  // sidebar is hidden (mobile-first user opens the panel via deep link).
  function onPickMemoriesTab(): void {
    navigate({ drawer: 'memories' }, { replace: true });
    if (app.supabase && !memoriesStore.loaded && !memoriesStore.loading) {
      void runMemoriesSearch(app.supabase, app.venice);
    }
  }

  // Wiki drawer tab. Same lazy-load shape as memories - WikiList's
  // $effect fires the first search via the shared `wikiStore`, but
  // kicking it on tab-pick lets a deep-linked panel land on a non-empty
  // listing.
  function onPickWikiTab(): void {
    navigate({ drawer: 'wiki' }, { replace: true });
    if (app.supabase && !wikiStore.loaded && !wikiStore.loading) {
      void runWikiSearch(app.supabase, app.venice);
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

  // Parallel for the journal tab. Gates on `journal.loaded` rather
  // than `journal.entries.length === 0` - an account with zero entries
  // would otherwise re-fire this effect every time the load resolves
  // empty (loading flips false, deps trip, effect runs, loads again,
  // forever). The spinner never stops and the modal that shares the
  // store sees the same flicker.
  $effect(() => {
    if (route.drawer !== 'journal') return;
    if (!app.supabase) return;
    if (journal.loaded || journal.loading) return;
    void loadJournalEntries(app.supabase, { limit: 200 });
  });

  // Parallel for the memories tab. Same `loaded`-gate rationale as
  // journal: an account with zero memories would re-fire the load
  // forever otherwise.
  $effect(() => {
    if (route.drawer !== 'memories') return;
    if (!app.supabase) return;
    if (memoriesStore.loaded || memoriesStore.loading) return;
    void runMemoriesSearch(app.supabase, app.venice);
  });

  // Parallel for the wiki tab. Same `loaded`-gate rationale - an
  // account with zero articles would re-fire the load forever
  // otherwise.
  $effect(() => {
    if (route.drawer !== 'wiki') return;
    if (!app.supabase) return;
    if (wikiStore.loaded || wikiStore.loading) return;
    void runWikiSearch(app.supabase, app.venice);
  });

  // Wiki cross-surface change channel. The chat-side wiki_* tool calls
  // and the autonomous wiki worker both fire WIKI_CHANGE_EVENT after a
  // write; refresh the drawer's listing so the new/updated row shows
  // up without the user navigating away and back.
  function onWikiStoreChanged(): void {
    if (!app.supabase) return;
    if (!wikiStore.loaded) return;
    void runWikiSearch(app.supabase, app.venice);
  }

  function onJournalStoreChanged(): void {
    // Any journal write (tool path, worker path, modal compose save)
    // invalidates the list - only reload if we've already loaded it,
    // so an unused drawer / modal stays lazy.
    if (!app.supabase) return;
    if (!journal.loaded) return;
    void loadJournalEntries(app.supabase, { limit: 200 });
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

  // --- Per-user-message samskara diagnostics --------------------------
  // The cohort fires + substrate that the modal used to render in its
  // own sections now mount inline under each user message. Three
  // pieces of state for the active thread: the flat fires list, the
  // flat substrate list, and the thread-wide cluster map. Loaded once
  // when a thread is opened and refreshed at end-of-turn so a fresh
  // cohort appears under its triggering message without a manual
  // reload. Cleared on thread switch so a stale thread's cohorts
  // never bleed into the new one's transcript.
  let cohortFires = $state<SamskaraFireDiagnosticRow[]>([]);
  let cohortSubstrate = $state<SamskaraSubstrateDiagnosticRow[]>([]);
  let cohortClusterMap = $state<
    Map<string, { clusterSeq: number; clusterSize: number }>
  >(new Map());
  // Which user messages have their cohort panel expanded. Keyed by
  // user_message_id, not user_round, because the user can edit/delete
  // user messages and the round count would shift but the id wouldn't.
  // Reset on thread switch.
  let expandedCohortPanels = $state<Set<string>>(new Set());

  function toggleCohortPanel(userMessageId: string): void {
    const next = new Set(expandedCohortPanels);
    if (next.has(userMessageId)) next.delete(userMessageId);
    else next.add(userMessageId);
    expandedCohortPanels = next;
  }

  // Walk messages in transcript order and assign 1..N to user
  // messages. Matches the runtime countUserRounds() the chat loop
  // calls at fire time: both count current user messages, both stop
  // at the same boundary, so the index produced here is the same
  // value persisted on samskara_fires.user_round at fire time. Tool
  // and assistant rows do not advance the counter.
  const userRoundByMessageId: Map<string, number> = $derived.by(() => {
    const map = new Map<string, number>();
    let n = 0;
    for (const m of messages) {
      if (m.role === 'user') {
        n += 1;
        map.set(m.id, n);
      }
    }
    return map;
  });

  // Group fires by their persisted user_round. Legacy rows whose
  // backfill didn't produce a value (the column was NULL and the
  // approximate ranking couldn't reach them - shouldn't happen but
  // guard anyway) are dropped from the inline view rather than
  // anchored at an arbitrary message.
  const firesByUserRound: Map<number, SamskaraFireDiagnosticRow[]> = $derived.by(
    () => {
      const map = new Map<number, SamskaraFireDiagnosticRow[]>();
      for (const f of cohortFires) {
        if (f.userRound === null) continue;
        const bucket = map.get(f.userRound);
        if (bucket) bucket.push(f);
        else map.set(f.userRound, [f]);
      }
      return map;
    }
  );

  const substrateByUserMsgId: Map<string, SamskaraSubstrateDiagnosticRow> =
    $derived.by(() => {
      const map = new Map<string, SamskaraSubstrateDiagnosticRow>();
      for (const r of cohortSubstrate) {
        map.set(r.userMessageId, r);
      }
      return map;
    });

  // Load fires + substrate + cluster map for one thread. Guards
  // against thread switches mid-flight (the user can change rooms
  // while three round trips are racing). Failures clear the inline
  // state silently - the toggle button just doesn't appear on any
  // user message, same as a thread with no fires yet.
  async function loadCohortDiagnostics(threadId: string): Promise<void> {
    if (!app.supabase) return;
    try {
      const [fires, substrate] = await Promise.all([
        app.supabase.samskaraListFiresForThread(threadId),
        app.supabase.samskaraListSubstrateForThread(threadId),
      ]);
      if (activeThreadId !== threadId) return;
      cohortFires = fires;
      cohortSubstrate = substrate;
      // Cluster map is best-effort. The RPC can be expensive for
      // long threads; a failure here just means the panel renders
      // every fire as its own singleton, which is the documented
      // fallback inside CohortPanel.
      try {
        const map = await app.supabase.samskaraClusterThreadFires(threadId);
        if (activeThreadId !== threadId) return;
        cohortClusterMap = map;
      } catch {
        if (activeThreadId === threadId) cohortClusterMap = new Map();
      }
    } catch {
      if (activeThreadId === threadId) {
        cohortFires = [];
        cohortSubstrate = [];
        cohortClusterMap = new Map();
      }
    }
  }

  /**
   * Message ids that the user has clicked "regenerate" on but whose
   * row hasn't been deleted from the DB yet. The chat-loop's wire
   * history filter skips these so they don't reach Venice; the
   * transcript greys them out and disables their action-bar buttons
   * so the user can read what's about to be replaced. Cleared (and
   * the rows actually deleted) when the replacement turn lands
   * cleanly; cleared without a delete on abort or error so the rows
   * un-grey and stay usable. Backed by a derived Set for O(1) lookup
   * during the per-message render.
   */
  let pendingDeleteIds = $state<string[]>([]);
  const pendingDeleteSet = $derived(new Set(pendingDeleteIds));
  /**
   * Per-message animation-delay for the fade-out that plays after a
   * regenerate lands. Keyed by message id, value is the delay in ms
   * before that row begins its blur-and-fade. Rows are staggered
   * newest-first (highest index in `messages` → delay 0) so the
   * replaced tail visibly unwinds back toward the user's prompt.
   * Absence of an id in this map means "not fading" - we check with
   * a `!== undefined` guard rather than truthiness because delay 0
   * is the first row's valid value. Populated at the start of the
   * success-path cleanup and cleared once the animation's total
   * runtime has elapsed and the rows are pruned from `messages`.
   */
  let fadeOutDelays = $state<Record<string, number>>({});
  let streamingText = $state('');
  // Live companion to streamingText during a turn. `streamingReasoning`
  // is the running buffer of `delta.reasoning_content` chunks for the
  // current round; reset when the assistant row persists and a new
  // round begins.
  //
  // `streamingReasoningOpen` drives the slide-open state of the live
  // reasoning panel. We flip it on the first reasoning delta, then —
  // once the visible answer starts flowing — schedule a timer to
  // animate it shut. Value persists across the transition so the
  // intermediate "still streaming content with reasoning tucked away"
  // state has somewhere to sit.
  //
  // Citations are NOT mirrored into a streaming buffer: Venice ships
  // them in the first chunk, but rendering an open citations panel
  // mid-stream pushes the bubble's bottom edge down by the height of
  // the source list, and follow-bottom scrolling then anchors to that
  // edge - leaving reasoning streaming in above the viewport. Skip the
  // live render entirely; the citations show up via AssistantBody
  // (collapsed by default, toggle in the action bar) the instant the
  // message persists.
  let streamingReasoning = $state('');
  let streamingReasoningOpen = $state(false);
  // Rate-limit waiting state. Populated by the chat-loop's
  // onRateLimitWait handler when Venice returns 429 and the loop is
  // about to sleep before retrying; cleared by onRateLimitResolved
  // when the wait ends (whether the next attempt succeeds or fails).
  // The streaming bubble renders a "waiting on Venice" clock-icon
  // indicator while these are non-null. The user's existing stop
  // button (stopStreaming -> abortCtl.abort) doubles as the cancel
  // path; the chat-loop maps an abort-during-wait to an AbortError
  // that lands in the same INTERRUPTED_MARKER branch as a mid-stream
  // cancel, so no separate cancel wiring is needed here.
  let rateLimitWaitUntil = $state<number | null>(null);
  let rateLimitAttempt = $state(0);
  // Tick counter that drives a 1Hz reactive re-read of Date.now() while
  // a rate-limit wait is active, so the bubble's countdown updates each
  // second without rebinding the assistant render. The interval is
  // kept inside an $effect tied to rateLimitWaitUntil so it self-cleans
  // when the wait ends.
  let rateLimitNowTick = $state(0);
  $effect(() => {
    if (rateLimitWaitUntil === null) return;
    const id = window.setInterval(() => {
      rateLimitNowTick = rateLimitNowTick + 1;
    }, 1000);
    return () => window.clearInterval(id);
  });
  // Live countdown to the retry. Reads rateLimitNowTick so it
  // subscribes to the 1Hz interval above; the tick value itself
  // doesn't enter the math. Returns 0 when no wait is active so the
  // template can guard the "resuming in Ns" suffix on a positive
  // value rather than null-checking a separate variable.
  const rateLimitRemainingSec = $derived.by(() => {
    if (rateLimitWaitUntil === null) return 0;
    void rateLimitNowTick;
    return Math.max(0, Math.ceil((rateLimitWaitUntil - Date.now()) / 1000));
  });
  // Inline error surface for chat exchange failures. Rendered as a
  // prominent red bubble at the bottom of the transcript - inside
  // `.messages` - so it travels with the conversation flow and
  // stays visible regardless of what the composer / keyboard are
  // doing. This is the canonical place for send-path errors; the
  // `error` banner above the composer is reserved for non-exchange
  // problems (attachment upload, thread rename, pre-send guards)
  // that don't have a transcript anchor. On a rate-limit, an
  // optional `retry` closure is attached and the bubble renders a
  // refresh button alongside the dismiss X. Cleared at the start
  // of every new send.
  interface StreamingError {
    text: string;
    retry?: () => void;
  }
  let streamingError = $state<StreamingError | null>(null);
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
   * Replace a server-fetched thread list while preserving each row's
   * fresher in-memory `intuition_payload`. Used by `refreshThreads`
   * when the server snapshot may not have caught up with a recent
   * patchThread / pipeline write yet - same hazard rebucketThread
   * defends against, applied across every row of a list refresh.
   * Threads not present in memory pass through unchanged.
   */
  function mergeServerThreadList(rows: readonly Thread[]): Thread[] {
    return rows.map((row) => {
      const existing = findThread(row.id);
      if (!existing) return row;
      return {
        ...row,
        intuition_payload: pickFresherIntuitionPayload(
          existing.intuition_payload,
          row.intuition_payload
        ),
        // Same race / same merge as intuition_payload above. The
        // two subconscious-priming caches ride parallel paths and
        // each one can land in memory ahead of a server snapshot.
        context_recall_payload: pickFresherContextRecallPayload(
          existing.context_recall_payload,
          row.context_recall_payload
        ),
      };
    });
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
   *
   * The intuition_payload column gets an explicit merge: a realtime
   * UPDATE event triggered by an unrelated thread mutation (rename,
   * archive, samskara worker, another tab) carries the FULL row,
   * including whatever `intuition_payload` was at the moment of that
   * UPDATE. If a fresher payload was patched into memory after the
   * server snapshot was taken (or if the cache write failed and the
   * DB still shows null), the realtime echo would silently wipe the
   * brain icon. Keeping whichever side has the higher `computed_at_at`
   * preserves the local patch when it's ahead of the server, and
   * accepts the server payload when it's ahead (e.g. another tab
   * just refreshed).
   */
  function rebucketThread(t: Thread): void {
    const existing = findThread(t.id);
    if (existing) {
      t = {
        ...t,
        intuition_payload: pickFresherIntuitionPayload(
          existing.intuition_payload,
          t.intuition_payload
        ),
        // Parallel merge for the context-recall cache - same race
        // (realtime echo carrying a stale null) handled the same way.
        context_recall_payload: pickFresherContextRecallPayload(
          existing.context_recall_payload,
          t.context_recall_payload
        ),
      };
    }
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
  // Finalize any tool timings that never got an endedAt when the
  // session stops streaming. A clean run sets endedAt via onToolDone /
  // onToolError, but a stream that dies mid-tool (network drop, abort,
  // provider 5xx) leaves the timing entry with just startedAt forever -
  // which statusFor() reads as "still in flight" and keeps the spinner
  // animating indefinitely. Marking them errored on the sending->idle
  // edge converts orphaned spinners into red-X glyphs and also prevents
  // a later same-session send from reviving the animation when sending
  // flips back to true.
  let sendingWasTrue = false;
  $effect(() => {
    if (sending) {
      sendingWasTrue = true;
      return;
    }
    if (!sendingWasTrue) return;
    sendingWasTrue = false;
    const now = performance.now();
    for (const id of Object.keys(toolTimings)) {
      const t = toolTimings[id];
      if (t.endedAt === undefined) {
        toolTimings[id] = { ...t, endedAt: now, error: true };
      }
    }
  });
  // Error banner state. `retry` is populated only for transient failures
  // where re-firing the exact same request is meaningful (rate-limit so
  // far) — it re-runs the chat loop with the captured history so the
  // user doesn't have to retype. A fresh error assignment replaces any
  // earlier retry closure; the banner only ever owns one.
  type ChatError = { text: string; retry?: () => void };
  let error = $state<ChatError | null>(null);
  // Reactive because the send button's disabled state reads it: while
  // `sending` is true, the button acts as a stop button and needs to
  // latch to disabled for the brief window after abort() fires but
  // before the runExchange finally block nulls the controller. Without
  // $state, the template wouldn't re-render when abortCtl flips back
  // to null and the button would stay on its last frame.
  let abortCtl = $state<AbortController | null>(null);

  // Screen wake lock held for the duration of an active streaming round.
  // Prevents Chrome on Android from freezing the tab while the LLM
  // response is still in flight. Auto-released by the browser when the
  // page hides; re-acquired on visibility-visible if streaming is still
  // going (see the $effect below). The lock is best-effort: it is simply
  // absent when the API is unavailable or the user denies permission.
  let activeLock: WakeLockSentinel | null = null;

  async function acquireWakeLock(): Promise<void> {
    if (!('wakeLock' in navigator)) return;
    try {
      activeLock = await navigator.wakeLock.request('screen');
      // The browser releases the lock automatically when the page hides.
      // Clear our reference so we know to re-acquire on visibility-visible.
      activeLock.addEventListener('release', () => { activeLock = null; });
    } catch {
      // Permission denied or API unavailable - not fatal, streaming just
      // becomes freeze-susceptible on mobile the same as before.
    }
  }

  function releaseWakeLock(): void {
    activeLock?.release().catch(() => {});
    activeLock = null;
  }

  // Re-acquire after a page-hide/show cycle while streaming is still active.
  // The browser releases any held wake lock when the page hides; without
  // this effect, returning to the tab mid-stream would leave the lock gone.
  $effect(() => {
    if (!sending) return;
    const handleVisibility = (): void => {
      if (document.visibilityState === 'visible' && sending && !activeLock) {
        void acquireWakeLock();
      }
    };
    document.addEventListener('visibilitychange', handleVisibility);
    return () => document.removeEventListener('visibilitychange', handleVisibility);
  });

  // An interrupted draft detected at thread-load time. Set when a prior
  // streaming session ended abruptly (app closed, browser froze) and left
  // an un-committed response in IndexedDB. Cleared on retry or dismiss.
  let interruptedDraft = $state<StreamingDraft | null>(null);

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

  // Mobile composer collapse: on narrow viewports we collapse the
  // textarea to a single line when blurred and expand it on focus so
  // the composer stops hogging a third of the screen when the user is
  // reading the thread. Desktop keeps the always-expanded behaviour.
  // Breakpoint matches the `@media (max-width: 720px)` block in
  // styles.css that drives the rest of the mobile composer layout.
  let composerFocused = $state(false);
  let composerIsMobile = $state(false);
  $effect(() => {
    if (typeof window === 'undefined') return;
    const mql = window.matchMedia('(max-width: 720px)');
    const update = (): void => {
      composerIsMobile = mql.matches;
    };
    update();
    mql.addEventListener('change', update);
    return () => mql.removeEventListener('change', update);
  });

  // Auto-grow the composer so the caret is always visible as the user
  // types. CSS caps the textarea at 40vh - once content exceeds that
  // the element scrolls internally. We reset height to auto first so
  // deletes shrink the box back down to the natural content height.
  //
  // On mobile when the textarea is blurred we skip the inline height
  // write and let the `.is-collapsed` CSS rule pin the box to a single
  // line; the CSS transition animates between the two states.
  $effect(() => {
    void composer;
    void composerFocused;
    void composerIsMobile;
    const el = composerEl;
    if (!el) return;
    if (composerIsMobile && !composerFocused) {
      el.style.height = '';
      return;
    }
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight}px`;
  });

  // Sibling to the focus-on-selectThread call: when the user flips the
  // drawer tab from recipes/journal/memories back to chats, the composer
  // remounts but selectThread doesn't fire (the active thread didn't
  // change), so we'd otherwise leave the user staring at an unfocused
  // textarea. Track the previous tab and focus on the chats edge.
  // Mobile is skipped for the same reason as in selectThread.
  let prevDrawerTab: typeof drawerTab | null = null;
  $effect(() => {
    const tab = drawerTab;
    const prev = prevDrawerTab;
    prevDrawerTab = tab;
    if (prev === null) return;
    if (tab !== 'chats' || prev === 'chats') return;
    if (composerIsMobile) return;
    void tick().then(() => {
      if (drawerTab === 'chats') composerEl?.focus();
    });
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

  /**
   * Persist any in-memory recovery rows (added by listMessages when
   * the thread tail was wire-format-invalid) to the DB ahead of the
   * next user turn. After this runs, the DB tail is healed and
   * subsequent reads no longer need synthesis - the synthesizer's
   * idempotency check sees the persisted recovery row and no-ops.
   *
   * Race guard: another device may have already healed the same
   * thread between our read and this send. listMessages always runs
   * the synthesizer, so we look for a non-synthetic recovery row at
   * the tail (synthetic=false means it's actually in the DB). When
   * one exists, adopt the DB view wholesale rather than stacking a
   * second copy of the recovery rows on top.
   *
   * After persisting, we re-fetch and assign messages from scratch
   * rather than swapping in the persisted rows by id. The realtime
   * subscriber races our addMessage calls - it fires its own
   * appendMessage on the INSERT echo, which doesn't see the
   * synthetic rows (different ids) and would leave duplicates.
   * A single refetch-and-replace bypasses the race.
   */
  async function persistSyntheticRecovery(threadId: string): Promise<void> {
    if (!app.supabase) return;
    const synthetics = messages.filter((m) => m.synthetic);
    if (synthetics.length === 0) return;
    const beforeWrite = await app.supabase.listMessages(threadId);
    const persistedRecoveryAtTail = beforeWrite
      .slice()
      .reverse()
      .find((m) => !m.synthetic && isRecoveryMessage(m));
    if (persistedRecoveryAtTail) {
      messages = beforeWrite;
      return;
    }
    for (const synth of synthetics) {
      await app.supabase.addMessage(threadId, synth.role, synth.content, {
        tool_call_id: synth.tool_call_id ?? undefined,
        name: synth.name ?? undefined,
      });
    }
    if (activeThreadId !== threadId) return;
    messages = await app.supabase.listMessages(threadId);
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
    // has since been stripped by a manual refresh. Text content is
    // appended to whatever the user already typed; binary / oversized
    // files are fed into the composer's attachment pipeline so the
    // model actually gets to see them (vs. a text placeholder).
    void drainSharesForComposer().then(async ({ text, files }) => {
      if (!text && files.length === 0) return;
      if (text) {
        composer = composer ? `${composer}\n\n${text}` : text;
      }
      // Sequential so the aggregate-size check inside addAttachment
      // sees the running total from previous adds, matching the
      // picker / drag-drop / paste paths.
      for (const file of files) {

        await addAttachment(file);
      }
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
    // Cookbook + journal change listeners. Fire when a recipe_* /
    // journal_* tool call succeeds, so the drawer tab's list reflects
    // a model-driven save without the user having to reopen the tab.
    // We only reload when we've already loaded at least once - a
    // fresh unlock that never opened those tabs stays lazy.
    const offCookbook = onCookbookChange(onCookbookStoreChanged);
    const offJournal = onJournalChange(onJournalStoreChanged);
    const offWiki = onWikiChange(onWikiStoreChanged);
    return () => {
      unsubscribe();
      offCookbook();
      offJournal();
      offWiki();
    };
  });

  async function refreshSettings(): Promise<void> {
    if (!app.supabase) return;
    try {
      const s = await app.supabase.getSettings();
      applyServerSettings(s);
      // Only (re)seed the active set if the user hasn't already
      // started toggling prompts on the current thread. Avoids
      // clobbering their per-thread selection when settings arrive
      // late.
      if (activePromptIds.size === 0) resetActivePromptsToDefaults();
    } catch {
      // Best-effort: fall back to whatever activate() seeded (or
      // earlier applied settings) so a transient Supabase failure
      // doesn't blow up the screen on an auth refresh.
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
      // Preserve a fresher in-memory intuition_payload over the
      // server snapshot. The chat-loop awaits writeIntuitionCache
      // before returning, so on a healthy network the fetched row
      // already carries the latest payload - but the same race that
      // motivates the merge in rebucketThread (cache-write failure,
      // a cross-tab snapshot in flight) applies here too. End-of-
      // turn refreshThreads() running while the in-memory patch is
      // ahead of the server would otherwise wipe the brain icon and
      // the inline card; the merge keeps both visible until the
      // server actually has a payload at least as fresh.
      recentThreads = mergeServerThreadList(recent);
      olderThreads = mergeServerThreadList(older.rows);
      olderCursor = older.nextCursor;
      olderHasMore = older.nextCursor !== null;
      olderLoading = false;
      archivedPage = mergeServerThreadList(archived.rows);
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
    // An explicit `title` argument only comes from the commitRename path —
    // i.e. the user typed a title into the input on a draft thread. That's
    // a manual rename by any other name, so the materialised row carries
    // title_manually_set=true. A draft that materialises on first-send
    // carries the placeholder title and stays flag=false, leaving the
    // update_title tool free to pick a real title on the first round.
    const titleManuallySet = title !== undefined;
    const real = await app.supabase.createThread(
      title ?? draft.title,
      draft.model,
      draft.reasoning_effort,
      draft.verbosity,
      titleManuallySet
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
    // Opening a thread clears its unread dot. No-op if the dot wasn't
    // set (e.g. the user is navigating to a thread they've been viewing
    // all along via back/forward).
    if (id !== null) markThreadRead(id);
    setSessionThreadId(id);
    // Mirror the active thread into the URL. `navigate` no-ops when
    // route.cid is already `id` (e.g. this call originated from a
    // popstate-driven reconcile effect), so the back stack doesn't
    // grow on browser-back navigations.
    navigate({ cid: id });
    messages = [];
    // Drop the prior thread's inline diagnostics in lockstep with
    // its messages. loadMessagesForThread re-populates these once
    // the new thread's listMessages call settles.
    cohortFires = [];
    cohortSubstrate = [];
    cohortClusterMap = new Map();
    expandedCohortPanels = new Set();
    streamingText = '';
    interruptedDraft = null;
    // Re-seed the active prompt set from defaults whenever the user
    // switches threads - per-thread toggles are not persisted, so a
    // thread switch is effectively a fresh start for this UI state.
    resetActivePromptsToDefaults();
    // Opening a thread starts in follow-bottom mode; the autoscroll
    // effect lands the view on the newest messages once they load.
    followBottom = true;
    // Cancel any post-load scroll watchdog still running for the
    // previously-open thread - the new thread's loadMessages will
    // start a fresh one once its content commits.
    cancelPostLoadScroll();
    // Tool-call timings are a session-scoped display aid; nav to another
    // thread drops them so the previous thread's pills don't leak into
    // the new one.
    toolTimings = {};
    // On mobile the drawer is modal, so dismiss it once a thread is chosen.
    // On desktop the sidebar is a persistent column - leave it open.
    if (id !== null) closeDrawerOnMobile();
    if (id === null) return;
    // Focus the composer so the user can start typing immediately after
    // opening a conversation. Skipped on mobile - focusing the textarea
    // there pops the soft keyboard and expands the composer (the
    // .is-collapsed rule keys off composerFocused), which is intrusive
    // when the user is just navigating in to read.
    if (!composerIsMobile) {
      void tick().then(() => {
        if (activeThreadId === id) composerEl?.focus();
      });
    }
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
      // Kick off the cohort + substrate fetch in parallel with the
      // draft check below. The inline cohort panels under each user
      // message read off this state; loading it lazily on first
      // toggle would block the panel open for a round trip, while
      // loading it inline with the thread keeps the toggle instant
      // for every message in the transcript.
      void loadCohortDiagnostics(id);
      // Check for an orphaned streaming draft from a previous session
      // that ended abruptly (tab close, Chrome freeze, power loss). A
      // draft is orphaned when the last message in the thread is a user
      // message - meaning the assistant response never committed. If the
      // response DID commit, the draft was also deleted in the finally
      // block, so loadDraft returns null and nothing is shown.
      interruptedDraft = null;
      const lastMsg = fetched.at(-1);
      if (lastMsg?.role === 'user') {
        const draft = await loadDraft(id);
        if (draft && draft.userMessageId === lastMsg.id && activeThreadId === id) {
          interruptedDraft = draft;
        }
      }
      // Land on the latest exchange. The auto-scroll effect is gated on
      // an active completion (so a realtime echo can't hijack the view
      // out from under the user), which means thread-load can't
      // piggyback on it - do the snap explicitly here, after Svelte
      // commits the new messages. Re-check activeThreadId post-tick: a
      // fast thread-hop during the await would have us scrolling the
      // wrong list otherwise.
      //
      // The transcript keeps growing after the initial tick as image
      // attachments decode, markdown highlighting runs, KaTeX mounts,
      // and inline panels paint. pinBottomWhileSettling() keeps the
      // view glued to the bottom across that window so the user lands
      // on the last message, not on the last message minus an image's
      // worth of pixels.
      await tick();
      if (activeThreadId === id) pinBottomWhileSettling();
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

  // Active thread's cached intuition payload, coerced from the
  // jsonb column. Null on cold threads or shape drift; the modal
  // and the inline card both gate on this being non-null. Reactive
  // because patchThread() (used by onIntuitionUpdate) re-derives
  // currentThread, which re-runs this expression.
  const currentIntuitionPayload = $derived<IntuitionPayload | null>(
    currentThread ? coerceIntuitionPayload(currentThread.intuition_payload) : null
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
  // when `TIERS[currentTier].supportsReasoning`.
  const currentReasoning = $derived<ReasoningEffort>(
    resolveReasoningEffort(
      currentThread?.reasoning_effort ?? null,
      defaultReasoning,
      TIERS[currentTier].defaultReasoningEffort
    )
  );
  // Hide the per-thread reasoning picker when the model can't reason,
  // OR when the current tier explicitly disables thinking (Fast tier
  // ships `venice_parameters.disable_thinking: true` so a picker
  // would show effort levels that have no wire effect).
  const currentSupportsReasoning = $derived<boolean>(
    TIERS[currentTier].supportsReasoning && !TIERS[currentTier].disableThinking
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
      // Manual rename: flip title_manually_set=true server-side so the
      // chat loop stops sending the model the auto-rename instruction.
      // A user's explicit title choice wins over the model's ongoing
      // topic-drift inference for the rest of this thread's life.
      await app.supabase.renameThread(threadId, next, { manuallySet: true });
      // Rename also bumps `updated_at` server-side (see
      // renameThread); re-bucket so the drawer ordering tracks.
      const updated = {
        ...currentThread,
        title: next,
        title_manually_set: true,
        updated_at: new Date().toISOString(),
      };
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
      toolboxes_enabled: [],
      archived: false,
      title_manually_set: false,
      intuition_payload: null,
      context_recall_payload: null,
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
      // If this thread had an unread dot pending, it's meaningless now.
      markThreadRead(id);
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
    const modelId = TIERS[tier].id;
    const tierSpec = TIERS[tier];
    // Skip reasoning_effort in two cases: the model can't reason
    // (some providers 400 on the unknown field) OR the tier explicitly
    // disables thinking. disable_thinking and reasoning_effort are
    // mutually exclusive on the wire - the off-switch wins.
    const sendReasoning: ReasoningEffort | undefined =
      tierSpec.supportsReasoning && !tierSpec.disableThinking
        ? resolveReasoningEffort(
            active?.reasoning_effort ?? null,
            defaultReasoning,
            tierSpec.defaultReasoningEffort
          )
        : undefined;
    const sendDisableThinking: boolean = tierSpec.disableThinking ?? false;
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
    // Images are handled on all tiers via analyze_image(). Only block
    // non-image attachments with no extractable text - those are a real
    // dead end with no tool fallback.
    const unreadable = readyAttachments.find(
      (a) => !isImageMimeType(a.mime_type) && !isConsumableBy(a, tierSpec)
    );
    if (unreadable) {
      error = {
        text: `"${unreadable.filename}" has no extractable text — the model won't be able to read it. Remove it to send.`,
      };
      return;
    }

    let threadId: string;
    if (!active) {
      // No thread selected - create one on the fly.
      const t = await app.supabase.createThread(DEFAULT_TITLE);
      rebucketThread(t);
      threadId = t.id;
      activeThreadId = t.id;
      setSessionThreadId(t.id);
      navigate({ cid: t.id }, { replace: true });
    } else if (active.isDraft) {
      // First send on a draft — materialize it now, preserving any model
      // choice the user already made from the dropdown.
      const real = await materializeIfDraft(active);
      threadId = real.id;
    } else {
      threadId = active.id;
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

    // Heal an interrupted-exchange tail before the new user turn lands.
    // listMessages added these synthetic rows in memory so the wire
    // shape was already valid for the prior reads; here we make them
    // real DB rows so the thread stays valid on every future read.
    // Best-effort: a persist failure logs and falls through - the
    // synthetic rows remain in memory for this session and will retry
    // on the next user send.
    try {
      await persistSyntheticRecovery(threadId);
    } catch (err) {
      log.warn('persistSyntheticRecovery failed', err);
    }

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
      // Pre-exchange failure (user message persist). No retry here -
      // the user's row didn't land, so "retry" would mean "try persist
      // again," which is a different UX than "retry the LLM call."
      // Surface on the inline bubble so the failure shows up in the
      // transcript where the user expected their message to land.
      log.error('send failed before exchange', err);
      streamingError = { text: describeError(err) };
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
      sendDisableThinking,
      sendVerbosity,
      sendEmphasis: app.emphasisMarkdown,
      sendUserName: app.userName,
      sendUserLocation: app.userLocation,
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
    /**
     * Snapshot of the tier's thinking-off kill switch at send time.
     * Captured here for the same reason as sendReasoning: a tier swap
     * mid-stream must not change the wire shape of an in-flight turn.
     * When true, the chat-loop ships `disable_thinking: true` and
     * sendReasoning is forced undefined.
     */
    sendDisableThinking: boolean;
    sendVerbosity: Verbosity;
    /**
     * Snapshot of the "Emphasis markdown" toggle taken at send time.
     * Carried as a context value so a user who flips the setting
     * mid-stream doesn't change the prompt under an already-running
     * request - the initial turn ships with whatever the setting was
     * when they hit send, and subsequent turns pick up the new value
     * on their own send paths.
     */
    sendEmphasis: boolean;
    /**
     * Snapshot of the user's name + location from Settings, taken at
     * send time. Same rationale as sendEmphasis - if the user opens
     * Settings and edits their name mid-stream, the in-flight turn
     * keeps the value the model already saw rather than swapping
     * mid-response. Empty strings are passed through; the chat-loop
     * treats them as "not set" and skips the appendix block.
     */
    sendUserName: string;
    sendUserLocation: string;
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
   * On a rate-limit failure (VeniceError kind='rate_limit') the
   * chat-loop sleeps for the duration parsed from Venice's
   * Retry-After / x-ratelimit-reset-* headers and re-issues the
   * request, up to RATE_LIMIT_MAX_ATTEMPTS times, before propagating
   * the failure. The streaming bubble surfaces the wait via the
   * onRateLimitWait / onRateLimitResolved handlers ("waiting on
   * Venice... resuming in Ns") so the user can see the retry rather
   * than wondering why the spinner has gone quiet. The user's stop
   * button doubles as the cancel - aborting during a wait lands in
   * the same INTERRUPTED_MARKER branch a mid-stream cancel takes.
   * Only when every retry attempt has been rate-limited do we park
   * a manual retry closure on the inline banner. Other error kinds
   * (auth, parse, http) surface immediately without a retry - re-
   * firing them would just repeat the failure.
   */
  async function runExchange(ctx: ExchangeContext): Promise<void> {
    if (!app.venice || !app.supabase) return;
    const freshThread = findThread(ctx.threadId);
    if (!freshThread) {
      error = { text: 'Thread disappeared before send.' };
      return;
    }
    error = null;
    streamingError = null;
    // Clear any orphaned-draft recovery banner at the start of a new
    // exchange so the retry button doesn't persist alongside the new stream.
    interruptedDraft = null;
    sending = true;
    streamingText = '';
    abortCtl = new AbortController();

    // Rebuild at call time so a retry after mid-exchange persists
    // (assistant row + tool result from a prior round) sees them.
    // Same closure is invoked again on the in-loop auto-retry below
    // so that retry path also picks up rows the chat loop persisted
    // before the 429 hit. toVeniceMessage is safe to call on rows
    // without attachments — they come back as plain strings either
    // way.
    //
    // The pendingDeleteSet filter excludes rows the user marked for
    // regenerate-from-here. The rows still exist in the DB at this
    // point (deletion is deferred until the new completion lands so
    // an abort can restore them), but they must not reach the wire -
    // otherwise Venice would see "user, asst-bad, [regenerate
    // request]" and just continue from asst-bad instead of
    // re-rolling.
    const buildHistoryOnWire = (): VeniceMessage[] => [
      ...ctx.systemMessages,
      ...messages
        .filter((m) => !pendingDeleteSet.has(m.id))
        .map((m) => toVeniceMessage(m, { visionSpec: ctx.tierSpec })),
    ];

    // Anchor for the `<datetime>` tag's since_last_response attribute.
    // Walk the persisted messages from the end and return the
    // created_at of the most recent role==='assistant' row that isn't
    // marked for regenerate-from-here (pendingDeleteSet) - those rows
    // are about to be replaced and shouldn't count as "your last
    // reply". null on the opening turn (no prior assistant) and on a
    // regenerate that drops every prior assistant row; the chat-loop
    // omits the attribute in both cases. Recomputed at call time so
    // an auto-retry after a 429 sees newly-persisted assistant rows
    // from earlier tool rounds (the chat-loop persists mid-turn
    // assistant rows before any final-text row lands).
    const findLastAssistantTimestamp = (): string | null => {
      for (let i = messages.length - 1; i >= 0; i--) {
        const m = messages[i];
        if (m.role !== 'assistant') continue;
        if (pendingDeleteSet.has(m.id)) continue;
        return m.created_at;
      }
      return null;
    };

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
      // Piggyback the IDB draft flush on every display flush (~500ms).
      // Best-effort: a write failure is swallowed so a broken IDB never
      // stalls the visible render path.
      void updateDraftText(ctx.threadId, streamingText, streamingReasoning).catch(() => {});
    };
    const cancelPending = (): void => {
      if (flushTimer !== 0) {
        clearTimeout(flushTimer);
        flushTimer = 0;
      }
    };

    // Persist a draft record at turn start so a crash or page-close
    // leaves a recoverable marker in IndexedDB. Updated on each
    // display-flush tick; deleted in the finally block on any clean exit.
    void saveDraft({
      threadId: ctx.threadId,
      userMessageId: ctx.userMessageId,
      modelId: ctx.modelId,
      text: '',
      reasoning: '',
      startedAt: Date.now(),
      updatedAt: Date.now(),
    }).catch(() => {});

    // Hold a screen wake lock for the duration of the streaming round so
    // Chrome on Android does not freeze the tab while the LLM is in
    // flight. Best-effort: absence of the lock is not fatal.
    await acquireWakeLock();

    try {
      let loopResult;
      // Auto-retry once on Venice 429 ("model is busy / overloaded").
      // The retry runs inside this inner try so `sending` stays
      // asserted across the brief delay - the composer doesn't
      // re-enable mid-retry, no error banner appears, and the user
      // just sees a slightly longer pause. Only when the second
      // attempt also rate-limits does the outer catch fire and park
      // a manual retry on the inline banner. A 429 is rejected by
      // venice.ts before any SSE deltas land, so the failed attempt
      // never called the streaming handlers - there is no partial
      // text to roll back on retry. History is rebuilt from
      // `messages` on each attempt so persisted rows from earlier
      // tool rounds (which call onAssistantPersisted before a 429
      // on a later round) reach the wire on the retry.
      // Snapshot the mood at turn-entry. The intuition layer compares
      // it against the cached payload's snapshot to decide whether to
      // refresh; mid-turn mood mints don't affect this turn (they get
      // applied to the *next* user round). null when the thread has
      // never fired or while the seed query is in flight - intuition
      // skips the mood-shift trigger in that case but the title and
      // stale-fuse triggers still work.
      const moodSnapshot = moodState.current;
      const intuitionMoodArg = moodSnapshot
        ? {
            band: bandIndexFor(moodSnapshot.valence),
            column: columnFor(moodSnapshot.confidence),
          }
        : null;
      const oneAttempt = () =>
        runChatLoop({
          venice: app.venice!,
          supabase: app.supabase!,
          thread: freshThread,
          userId: ctx.currentUserId,
          modelId: ctx.modelId,
          history: buildHistoryOnWire(),
          signal: abortCtl!.signal,
          userMessageId: ctx.userMessageId,
          reasoningEffort: ctx.sendReasoning,
          disableThinking: ctx.sendDisableThinking,
          verbosity: ctx.sendVerbosity,
          emphasisMarkdown: ctx.sendEmphasis,
          userName: ctx.sendUserName,
          userLocation: ctx.sendUserLocation,
          journalTimezone: app.journalTimezone || null,
          lastAssistantTimestamp: findLastAssistantTimestamp(),
          intuitionModelId: agentModel('intuition').id,
          intuitionMood: intuitionMoodArg,
          // Topic-boundary recall rides the same trigger machinery as
          // intuition (cold-start, mid-turn title shift, mood shift,
          // stale fuse). Enabled by default in production - the
          // chat-loop's parallel fan-out keeps the wall-clock cost
          // bounded by max(intuition, context-recall) and the cache
          // turns later turns into no-ops on the same trigger fire.
          contextRecallEnabled: true,
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
              // already carries reasoning for the round just finished,
              // so the UI keeps rendering it via the message store
              // rather than the streaming state.
              streamingReasoning = '';
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
            onTitleChange: (title) => {
              // The `update_title` tool just renamed this thread mid-
              // turn. Patch the local thread row and re-bucket the
              // drawer so the new title shows up immediately - without
              // this the drawer and title-bar keep showing the old
              // title (or the "New conversation" placeholder on a
              // fresh thread) until the end-of-turn refreshThreads()
              // call lands, which can be several seconds later on a
              // slow exchange.
              const existing = findThread(ctx.threadId);
              if (existing) {
                rebucketThread({
                  ...existing,
                  title,
                  updated_at: new Date().toISOString(),
                });
              }
            },
            onToolboxesEnabledChange: (enabled) => {
              patchThread(ctx.threadId, {
                toolboxes_enabled: [...enabled],
              });
              // Brief flash on the composer toolbox so a human eye
              // notices the LLM-initiated state flip. User-initiated
              // flips don't flash (the click itself is the feedback).
              toolboxFlash = true;
              setTimeout(() => {
                toolboxFlash = false;
              }, 600);
            },
            onIntuitionUpdate: (payload: IntuitionPayload) => {
              // Patch the in-memory thread row so the modal and any
              // inline indicator pick up the fresh perception/drives/
              // synthesis without waiting for a full thread re-fetch.
              // The chat-loop already persisted to Supabase fire-and-
              // forget; this is the optimistic UI update that makes
              // the new payload visible immediately.
              patchThread(ctx.threadId, {
                intuition_payload: payload,
              });
            },
            onContextRecallUpdate: (payload) => {
              // Same optimistic-patch posture as onIntuitionUpdate.
              // Currently no UI consumer renders the cache directly,
              // but the patch keeps the in-memory row consistent with
              // the persisted row so a later tab/refresh doesn't see
              // a stale null from a delayed realtime echo.
              patchThread(ctx.threadId, {
                context_recall_payload: payload,
              });
            },
            onRateLimitWait: ({ attempt, until }) => {
              // Venice returned 429 and the chat-loop is about to
              // sleep before re-issuing the round. Surface the wait
              // in the streaming bubble so the user sees "waiting on
              // Venice" rather than wondering why the spinner has
              // gone quiet for a few seconds. The stop button keeps
              // working - it aborts the wait and lands in the same
              // INTERRUPTED_MARKER branch a mid-stream cancel takes.
              rateLimitWaitUntil = until;
              rateLimitAttempt = attempt;
            },
            onRateLimitResolved: () => {
              // Sleep ended (or was cancelled). Clear the indicator
              // so the bubble swaps back to the normal streaming
              // spinner while the next attempt fires. If the retry
              // immediately rate-limits again, onRateLimitWait will
              // re-populate these for the next wait window.
              rateLimitWaitUntil = null;
              rateLimitAttempt = 0;
            },
          },
        });

      try {
        // Rate-limit retries are handled inside the chat-loop now
        // (see streamChatWithRateLimitRetry in chat-loop.ts), which
        // sleeps for the duration parsed from Venice's Retry-After /
        // x-ratelimit-reset-* headers and re-issues the request up
        // to RATE_LIMIT_MAX_ATTEMPTS times. By the time a rate_limit
        // error reaches this catch the inner retry has exhausted; we
        // surface it to the user immediately rather than retrying
        // again with a flat backoff.
        loopResult = await oneAttempt();
      } finally {
        // Commit anything pending synchronously so post-loop code
        // sees the final state.
        cancelPending();
        if (pending !== null) {
          streamingText = pending;
          pending = null;
        }
      }
      // Regenerate-from-here commit. Runs only when a real reply
      // landed - a stopped-by-limit-with-no-text outcome is treated
      // as a failure (handled below + by the catch on the outer try)
      // so the greyed rows can be restored.
      //
      // Sequence:
      //   1. Compute a per-row animation-delay, staggered newest
      //      first - highest index in `messages` gets delay 0, each
      //      older row gets +250ms. This makes the tail visibly
      //      unwind back toward the user's prompt rather than
      //      collapsing all at once.
      //   2. Kick off the DB delete in parallel with the fade so
      //      the wall-clock cost of the two overlaps.
      //   3. Wait for the total animation runtime, then prune the
      //      rows from `messages` (which drops them from the DOM)
      //      and clear both the fade delays and the pending-delete
      //      id list in one state flip.
      //
      // A delete failure propagates to the outer catch. The new
      // completion is already safely persisted by the chat loop's
      // per-row writes; the only user-visible effect is that the
      // old rows linger in the DB until the next refresh (the DOM
      // has already moved on).
      if (pendingDeleteIds.length > 0 && loopResult.finalText.length > 0) {
        const idsToDelete = pendingDeleteIds;
        const indexOfId = new Map(
          idsToDelete.map((id) => [id, messages.findIndex((m) => m.id === id)] as const)
        );
        const orderedNewestFirst = [...idsToDelete].sort(
          (a, b) => (indexOfId.get(b) ?? 0) - (indexOfId.get(a) ?? 0)
        );
        const STAGGER_MS = 250;
        const ANIM_MS = 500;
        const delays: Record<string, number> = {};
        orderedNewestFirst.forEach((id, i) => {
          delays[id] = i * STAGGER_MS;
        });
        fadeOutDelays = delays;
        const totalMs =
          (orderedNewestFirst.length - 1) * STAGGER_MS + ANIM_MS;
        const deletePromise = app.supabase.deleteMessages(idsToDelete);
        await new Promise<void>((resolve) => window.setTimeout(resolve, totalMs));
        const drop = new Set(idsToDelete);
        messages = messages.filter((m) => !drop.has(m.id));
        pendingDeleteIds = [];
        fadeOutDelays = {};
        await deletePromise;
      }
      if (loopResult.stoppedByLimit && !loopResult.finalText) {
        error = { text: 'Stopped: tool-call loop hit the 20-round limit.' };
      }
      // Conflict: another device inserted a user message while we were
      // streaming. The generated assistant row was discarded server-side.
      // Show an inline error so the user knows to look at the other
      // device for the new context - no retry closure because the right
      // action is to navigate away and back once the other turn lands.
      if (loopResult.conflictDetected) {
        streamingError = {
          text: 'This conversation was updated on another device while a response was generating. The response was discarded - refresh this thread to see the latest.',
        };
      }
      streamingText = '';
      streamingReasoning = '';
      streamingReasoningOpen = false;
      streamingContentStarted = false;
      // Belt-and-braces: the chat-loop's onRateLimitResolved already
      // clears the wait indicator at the end of every wait, but if a
      // round completes without firing it (e.g. a successful first
      // attempt) these stay at their initial values anyway. Resetting
      // here keeps the streaming state and the wait indicator on the
      // same lifecycle.
      rateLimitWaitUntil = null;
      rateLimitAttempt = 0;
      // Surface the completion to the notifications service: either
      // fires an OS notification (tab backgrounded + permission granted)
      // or sets an unread dot on the sidebar row. Skip on user-initiated
      // stop (they know they hit Stop), on a limit-without-text outcome
      // (no actual reply to report), and on conflict (nothing committed).
      if (!loopResult.interrupted && !loopResult.conflictDetected && loopResult.finalText.length > 0) {
        const threadForNotif = findThread(ctx.threadId);
        notifyTurnComplete({
          threadId: ctx.threadId,
          title: threadForNotif?.title || 'New reply',
          isActive: activeThreadId === ctx.threadId,
          onClick: (id) => {
            void selectThread(id);
          },
        });
      }
      await refreshThreads();
      // Refresh inline diagnostics so the cohort + substrate written
      // by this turn appear under the user message that triggered
      // them. Fire-and-forget: a fetch failure leaves the previous
      // snapshot in place, which is the same fallback as the modal.
      // Guarded against a thread switch mid-turn - the function
      // checks activeThreadId before mutating state.
      if (
        !loopResult.interrupted &&
        !loopResult.conflictDetected &&
        activeThreadId === ctx.threadId
      ) {
        void loadCohortDiagnostics(ctx.threadId);
      }
    } catch (err) {
      // User-initiated stop: runChatLoop catches mid-stream aborts
      // itself and returns cleanly with `interrupted: true`, so we
      // normally don't land here on a stop click. An AbortError
      // reaching this catch means something outside the stream loop
      // (priming work, a tool-execution path not routed through the
      // per-tool catch) bubbled one up - treat it the same way:
      // the user asked for it, not a failure to report.
      const isAbort =
        abortCtl?.signal.aborted === true ||
        (err instanceof Error && err.name === 'AbortError');
      if (!isAbort) {
        // Final-fallback diagnostic. Everything from the pre-stream
        // fetch down through SSE parse, tool dispatch, and persistence
        // funnels here. Log unconditionally so the in-app log drawer
        // has a breadcrumb - on mobile there's no devtools, so an
        // unlogged catch at this boundary is effectively a silent
        // swallow. `err` lands in the drawer's expandable detail so
        // the stack survives.
        log.error('chat exchange failed', err);
      }
      streamingText = '';
      streamingReasoning = '';
      streamingReasoningOpen = false;
      streamingContentStarted = false;
      // Same belt-and-braces reset as the success branch above - if
      // the loop blew up mid-wait the resolved handler still ran in
      // the chat-loop's finally, but if it failed before any wait
      // started these are already null and the assignment is a no-op.
      rateLimitWaitUntil = null;
      rateLimitAttempt = 0;
      // Restore any rows the user had marked for regenerate-from-here.
      // Failure means no replacement landed (or the post-loop delete
      // itself blew up, in which case the old rows are still
      // canonical), so un-greying lets the user read them again and
      // either retry the regenerate or copy the content out. Also
      // drop any fade-out delays so a row that happened to be
      // mid-dissolve (delete-promise failure after fade started)
      // snaps back to the .disabled appearance instead of staying
      // frozen at 8px blur.
      pendingDeleteIds = [];
      fadeOutDelays = {};
      // Rate-limit is the one error where re-sending the same request
      // a moment later is the right fix - Venice's message literally
      // says "try again later." Park a retry closure on the inline
      // bubble so the refresh button sits next to the error text the
      // user is already reading; other failure kinds (auth, parse)
      // would just repeat the error on retry, so we omit the closure
      // for them and the bubble renders dismiss-only. Aborts don't
      // raise a banner at all - the stop was the intended outcome.
      if (isAbort) {
        streamingError = null;
      } else if (err instanceof VeniceError && err.kind === 'rate_limit') {
        streamingError = {
          text: formatRateLimitMessage(err),
          retry: () => {
            void runExchange(ctx);
          },
        };
      } else {
        streamingError = { text: describeError(err) };
      }
    } finally {
      sending = false;
      abortCtl = null;
      releaseWakeLock();
      // Delete the streaming draft on any clean exit (success, conflict,
      // abort, or error). The draft's purpose is crash recovery; once
      // runExchange returns - even with an error - the session is coherent
      // and there is nothing to recover from on the next open.
      void deleteDraft(ctx.threadId).catch(() => {});
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
   * Regenerate-from-here. Marks the clicked assistant row plus every
   * row after it as pending-delete (so the wire history filter skips
   * them and the transcript greys them out), then re-runs the chat
   * loop using the user message that opened the now-greyed range as
   * the turn anchor.
   *
   * Range rules (matches the user-facing spec):
   *   - On the LATEST assistant message: the replaced range is just
   *     that message and any tool/intermediate rows from the same
   *     completion round - i.e. everything from the most recent user
   *     message forward.
   *   - On an OLDER assistant message: the range still starts from
   *     the most recent user message before the clicked row, but it
   *     extends to the END of the conversation - every subsequent
   *     user turn and assistant round goes too. The replacement is
   *     a single new exchange from that user message.
   *
   * Both cases reduce to "find the user message that opened the
   * clicked turn, then mark everything after it for replacement,"
   * which is what the walk-back below computes.
   *
   * Samskara / opening-recall: nothing to do here. Neither is
   * persisted as a message row, so the chat loop will rebuild them
   * from scratch on the new call - using the unchanged user-message
   * embedding, so the priming is materially the same as the first
   * time. End-of-turn substrate writes a new row; the orphaned old
   * row still carries training signal (schema-documented).
   */
  /**
   * Retry an interrupted streaming completion. Called from the orphaned-
   * draft recovery banner. Re-runs runExchange with the original user
   * message id so the assistant response slot is filled. Uses the current
   * thread settings (model, reasoning effort, etc.) rather than the
   * captured ones - the same "current settings apply" policy as
   * regenerateFrom.
   */
  async function retryInterrupted(): Promise<void> {
    if (sending || !app.supabase || !app.venice || !interruptedDraft) return;
    const draft = interruptedDraft;
    interruptedDraft = null;
    // Delete the draft now so a subsequent crash doesn't loop the user
    // into an infinite recovery prompt for the same turn.
    void deleteDraft(draft.threadId).catch(() => {});
    const active = findThread(draft.threadId);
    if (!active || active.isDraft || active.archived) return;
    const tier = resolveTier(active.model ?? null, defaultTier);
    const tierSpec = TIERS[tier];
    // Skip reasoning_effort when the model can't reason OR when the
    // tier explicitly disables thinking - mirror of the send() path.
    const sendReasoning: ReasoningEffort | undefined =
      tierSpec.supportsReasoning && !tierSpec.disableThinking
        ? resolveReasoningEffort(
            active.reasoning_effort ?? null,
            defaultReasoning,
            tierSpec.defaultReasoningEffort
          )
        : undefined;
    const sendDisableThinking: boolean = tierSpec.disableThinking ?? false;
    const sendVerbosity: Verbosity = resolveVerbosity(active.verbosity ?? null, defaultVerbosity);
    const systemMessages: { role: 'system'; content: string }[] = app.systemPrompts
      .filter((p) => activePromptIds.has(p.id) && p.body.trim().length > 0)
      .map((p) => ({ role: 'system' as const, content: p.body }));
    const currentUserId = session?.user.id ?? active.user_id;
    followBottom = true;
    // originalText is not captured in the draft but runExchange only uses
    // it as a display hint; leaving it empty is safe.
    await runExchange({
      threadId: draft.threadId,
      currentUserId,
      modelId: tierSpec.id,
      tierSpec,
      systemMessages,
      sendReasoning,
      sendDisableThinking,
      sendVerbosity,
      sendEmphasis: app.emphasisMarkdown,
      sendUserName: app.userName,
      sendUserLocation: app.userLocation,
      originalText: '',
      userMessageId: draft.userMessageId,
    });
  }

  async function regenerateFrom(assistantMessageId: string): Promise<void> {
    if (sending || !app.supabase || !app.venice) return;
    const active = activeThreadId ? findThread(activeThreadId) ?? null : null;
    if (!active || active.isDraft || active.archived) return;
    const clickedIdx = messages.findIndex((m) => m.id === assistantMessageId);
    if (clickedIdx === -1) return;
    // Walk back to the user message that opened this turn. Skip
    // assistant + tool rows from the same and earlier rounds. We stop
    // at the first user row we see - everything after it (inclusive
    // of intermediate tool/assistant rows AND any later turns) is the
    // replace range.
    let userIdx = -1;
    for (let i = clickedIdx; i >= 0; i--) {
      if (messages[i].role === 'user') {
        userIdx = i;
        break;
      }
    }
    // Defensive: an assistant row without a preceding user message
    // shouldn't exist (every assistant turn requires a user trigger),
    // but bail rather than send an empty turn if the data is somehow
    // shaped that way.
    if (userIdx === -1) return;
    const userMessage = messages[userIdx];
    const replaceRange = messages.slice(userIdx + 1);
    if (replaceRange.length === 0) return;
    pendingDeleteIds = replaceRange.map((m) => m.id);

    // Resolve send-time context the same way send() does. The
    // toggles the user has set RIGHT NOW apply to the regenerate -
    // model swap, reasoning effort, verbosity, system-prompt set.
    // That's intentional: a regenerate is a deliberate "try this
    // turn again" gesture, and the user often wants to re-run with
    // a different model or a tweaked system prompt.
    const tier = resolveTier(active.model ?? null, defaultTier);
    const tierSpec = TIERS[tier];
    const modelId = tierSpec.id;
    // Skip reasoning_effort when the model can't reason OR when the
    // tier explicitly disables thinking - mirror of the send() path.
    const sendReasoning: ReasoningEffort | undefined =
      tierSpec.supportsReasoning && !tierSpec.disableThinking
        ? resolveReasoningEffort(
            active.reasoning_effort ?? null,
            defaultReasoning,
            tierSpec.defaultReasoningEffort
          )
        : undefined;
    const sendDisableThinking: boolean = tierSpec.disableThinking ?? false;
    const sendVerbosity: Verbosity = resolveVerbosity(
      active.verbosity ?? null,
      defaultVerbosity
    );
    const systemMessages: { role: 'system'; content: string }[] = app.systemPrompts
      .filter((p) => activePromptIds.has(p.id) && p.body.trim().length > 0)
      .map((p) => ({ role: 'system' as const, content: p.body }));
    const currentUserId = session?.user.id ?? active.user_id;

    // Pin to the bottom so the new completion streams into view even
    // if the user had scrolled up to inspect the greyed range.
    followBottom = true;

    await runExchange({
      threadId: active.id,
      currentUserId,
      modelId,
      tierSpec,
      systemMessages,
      sendReasoning,
      sendDisableThinking,
      sendVerbosity,
      sendEmphasis: app.emphasisMarkdown,
      sendUserName: app.userName,
      sendUserLocation: app.userLocation,
      originalText: userMessage.content,
      userMessageId: userMessage.id,
    });
  }

  /**
   * Resume an orphaned turn whose tail is an unfinished shape (see
   * `incompleteTurnTail`). The typical path is: user opened a thread
   * where the previous session hit an overload error after a tool
   * round. The in-session rate-limit retry closure lives only in
   * memory and doesn't survive a refresh, so without this handler
   * the user's only recourse is to type a new prompt - which loses
   * the anchoring of the original turn.
   *
   * Unlike `regenerateFrom`, nothing gets replaced or greyed out:
   * the persisted tool rows are exactly what the model needs to
   * pick up where it left off. We just rebuild the send-time
   * context against the current settings and re-enter `runExchange`
   * with no pendingDeletes, so the rebuilt wire history includes
   * every existing row and the chat loop fires a fresh completion
   * that continues the turn.
   */
  async function retryIncompleteTurn(): Promise<void> {
    if (sending || !app.supabase || !app.venice) return;
    const active = activeThreadId ? findThread(activeThreadId) ?? null : null;
    if (!active || active.isDraft || active.archived) return;
    // Walk back to the user message that opened this turn. Mirrors
    // the walk in regenerateFrom - we need the userMessageId anchor
    // for the samskara substrate write at end-of-turn.
    let userIdx = -1;
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === 'user') {
        userIdx = i;
        break;
      }
    }
    if (userIdx === -1) return;
    const userMessage = messages[userIdx];

    const tier = resolveTier(active.model ?? null, defaultTier);
    const tierSpec = TIERS[tier];
    const modelId = tierSpec.id;
    // Skip reasoning_effort when the model can't reason OR when the
    // tier explicitly disables thinking - mirror of the send() path.
    const sendReasoning: ReasoningEffort | undefined =
      tierSpec.supportsReasoning && !tierSpec.disableThinking
        ? resolveReasoningEffort(
            active.reasoning_effort ?? null,
            defaultReasoning,
            tierSpec.defaultReasoningEffort
          )
        : undefined;
    const sendDisableThinking: boolean = tierSpec.disableThinking ?? false;
    const sendVerbosity: Verbosity = resolveVerbosity(
      active.verbosity ?? null,
      defaultVerbosity
    );
    const systemMessages: { role: 'system'; content: string }[] = app.systemPrompts
      .filter((p) => activePromptIds.has(p.id) && p.body.trim().length > 0)
      .map((p) => ({ role: 'system' as const, content: p.body }));
    const currentUserId = session?.user.id ?? active.user_id;

    followBottom = true;

    await runExchange({
      threadId: active.id,
      currentUserId,
      modelId,
      tierSpec,
      systemMessages,
      sendReasoning,
      sendDisableThinking,
      sendVerbosity,
      sendEmphasis: app.emphasisMarkdown,
      sendUserName: app.userName,
      sendUserLocation: app.userLocation,
      originalText: userMessage.content,
      userMessageId: userMessage.id,
    });
  }

  /**
   * Unwrap a Venice rate-limit error into a message fit for the banner.
   * The raw err.message is `Venice rate limit hit (HTTP 429). <detail>`
   * where <detail> is usually the OpenAI-compat envelope
   * `{"error":"The model is currently overloaded..."}`. Peel both
   * layers so the user sees only the provider's reason; fall back to
   * the raw message when parsing fails — any text beats a blank banner.
   */
  /**
   * Render an unknown thrown value as a non-empty human string. The
   * naive `err.message` fallback broke on the "reasoning streams then
   * vanishes silently" bug: an Error with an empty `.message` (or a
   * non-Error thrown value) left the error banner with empty text,
   * which the user read as "no error at all". Cascade down to `name`,
   * then a JSON dump, then the literal `String(err)`, so something
   * always lands. Never returns an empty string.
   */
  function describeError(err: unknown): string {
    if (err instanceof Error) {
      const msg = err.message?.trim();
      if (msg) return msg;
      if (err.name) return err.name;
      return 'Error';
    }
    if (typeof err === 'string') return err || 'Unknown error';
    if (err && typeof err === 'object') {
      try {
        const s = JSON.stringify(err);
        if (s && s !== '{}') return s;
      } catch {
        // fall through
      }
    }
    const s = String(err ?? '');
    return s || 'Unknown error';
  }

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
  //
  // While a response is streaming the same keystroke routes to stop
  // instead of send - the button's dual mode (send <-> stop) is
  // mirrored by its keyboard shortcut, so users never end up firing
  // a new send while waiting for the current stream to clear. After
  // the stream aborts (sending flips false), the next submit-modifier
  // Enter fires the draft the user typed while waiting.
  function onKeydown(e: KeyboardEvent): void {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey || e.shiftKey)) {
      e.preventDefault();
      if (sending) {
        stopStreaming();
      } else {
        void send();
      }
    }
  }

  /**
   * Cancel the in-flight chat request. Fires the outer AbortController,
   * which propagates through runChatLoop (where the stream consumer's
   * abort-aware branch persists partial text / reasoning with a marker)
   * and through any in-flight tool fetches (via childController). Safe
   * to call repeatedly - once `abortCtl` is nulled in runExchange's
   * finally block this is a no-op.
   */
  function stopStreaming(): void {
    abortCtl?.abort();
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
  const sendHint = $derived(isMac ? '\u2318-enter sends' : 'ctrl-enter sends');

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
  // On mobile the drawer is a modal overlay, so picking a row from it
  // (thread, recipe, or journal day) should dismiss it once the main
  // panel has navigated. On desktop the sidebar is a persistent column,
  // so leave it alone. Idempotent on desktop too - drawerOpen stays
  // true when the viewport is wide.
  function closeDrawerOnMobile(): void {
    if (typeof window === 'undefined') return;
    if (!window.matchMedia('(max-width: 720px)').matches) return;
    drawerOpen = false;
  }
  // Inverse of the above: the Cookbook panel calls this when the user
  // closes a recipe and lands on the empty/list pane. On mobile the
  // recipe list lives in the drawer, so without this the empty pane
  // dead-ends with no obvious way back to the listing. Desktop keeps
  // its existing drawerOpen value (the user may have collapsed it on
  // purpose, and the list is still reachable via the toggle).
  function openDrawerOnMobile(): void {
    if (typeof window === 'undefined') return;
    if (!window.matchMedia('(max-width: 720px)').matches) return;
    drawerOpen = true;
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
  // position, with one wrinkle: re-engaging follow-bottom is only
  // honored when scrollTop didn't go backwards. A user scrolling
  // down (or a programmatic scrollToBottom) increases scrollTop;
  // a layout shrink that clamps scrollTop down to the new max
  // also fires 'scroll' and lands at the bottom, but that's the
  // browser, not user intent. See `lastScrollTop` below.
  const NEAR_BOTTOM_PX = 48;
  let messagesEl: HTMLDivElement | undefined = $state();
  let followBottom = $state(true);
  let hasOverflow = $state(false);
  // Last observed scrollTop. We diff against this in `onMessagesScroll`
  // to distinguish a user-driven scroll-down from a browser-driven
  // clamp. A clamp happens when the scroll container shrinks under a
  // user who had scrolled away from the bottom: the streaming bubble
  // collapses (reasoning panel slides closed, text becomes the
  // Scanner, then the whole bubble disappears when `sending` flips),
  // scrollHeight drops, and the browser pins scrollTop to the new
  // max - which now satisfies `isNearBottom`. Without this guard the
  // resulting 'scroll' event would silently flip `followBottom` back
  // to true and the next streaming or messages effect would scroll
  // the user to the bottom even though they had explicitly scrolled
  // up to read.
  let lastScrollTop = 0;

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

  // Re-pin to bottom while async-rendering content (image attachments,
  // markdown highlighting, KaTeX, the cohort/intuition panels) keeps
  // growing the transcript after the initial post-load snap. Without
  // this, opening a thread lands the view at the bottom of the
  // *currently-rendered* content, then the last message drifts upward
  // as images and other deferred work finish painting - the user
  // arrives at the conversation already scrolled away from the
  // newest message.
  //
  // Strategy: poll scrollHeight on rAF. Re-snap whenever it grows;
  // exit when it's been stable for STABLE_FRAMES frames, or the
  // budget runs out, or the user scrolls up (followBottom flips),
  // or another loadMessages supersedes us.
  let postLoadScrollRaf = 0;
  let postLoadScrollToken = 0;

  function cancelPostLoadScroll(): void {
    if (postLoadScrollRaf !== 0) {
      cancelAnimationFrame(postLoadScrollRaf);
      postLoadScrollRaf = 0;
    }
  }

  function pinBottomWhileSettling(): void {
    cancelPostLoadScroll();
    const el = messagesEl;
    if (!el) return;
    const token = ++postLoadScrollToken;
    const STABLE_FRAMES = 6;
    const TIMEOUT_MS = 3000;
    const start = performance.now();
    let lastHeight = el.scrollHeight;
    let stable = 0;
    scrollToBottom(false);

    const step = () => {
      postLoadScrollRaf = 0;
      // Superseded by a newer load, container unmounted, or user
      // scrolled up - drop the watchdog.
      if (token !== postLoadScrollToken) return;
      if (!messagesEl || messagesEl !== el) return;
      if (!followBottom) return;
      if (performance.now() - start > TIMEOUT_MS) return;
      const h = el.scrollHeight;
      if (h !== lastHeight) {
        lastHeight = h;
        stable = 0;
        scrollToBottom(false);
      } else if (++stable >= STABLE_FRAMES) {
        return;
      }
      postLoadScrollRaf = requestAnimationFrame(step);
    };
    postLoadScrollRaf = requestAnimationFrame(step);
  }

  function onMessagesScroll(): void {
    const el = messagesEl;
    if (!el) return;
    const newScrollTop = el.scrollTop;
    const atBottom = isNearBottom(el);
    // Direction matters for the re-engage path. A user scrolling down
    // (or a programmatic scrollToBottom) increases scrollTop; a
    // browser clamp from a content shrink decreases it. We only
    // honor "now at the bottom" as user intent when scrollTop didn't
    // go backwards. The dis-engage path is symmetric: any time the
    // view is no longer near the bottom, the lock is off.
    if (atBottom) {
      if (newScrollTop >= lastScrollTop) followBottom = true;
    } else {
      followBottom = false;
    }
    lastScrollTop = newScrollTop;
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
    // Re-check both gates at fire time. The user may have scrolled up
    // while the timer was pending, and the completion may have ended
    // between schedule and fire (max-wait of 300ms can outlive the
    // final round of streaming) - either condition disables auto-scroll.
    if (sending && followBottom) scrollToBottom(false);
  }

  function scheduleStreamScroll(): void {
    if (!sending || !followBottom) {
      // Auto-scroll only runs while a completion is in progress and
      // scroll-lock isn't engaged. Drop any pending scrolls so a stale
      // timer doesn't yank the view after the user scrolls up or after
      // the completion ends.
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

  // Rendered-transcript mutations during an active completion - user
  // send, assistant-persist, regenerate-drop. These mark a clean
  // transition and should land the view on the bottom immediately.
  // Firing here also supersedes any pending streaming debounce: the
  // commit we just observed is the latest state, so a stale
  // late-firing timer would just flicker.
  //
  // Tracks `messageBlocks` (the derived render list) rather than raw
  // `messages` so non-message render blocks (e.g. the rename
  // indicator) also count as discrete mutations.
  //
  // Gated on `sending` so a delayed realtime echo or cross-tab mutation
  // arriving after the completion ends doesn't yank the view back to
  // the bottom. Thread-load lands on the bottom via the explicit
  // scrollToBottom in loadMessages, not via this effect.
  $effect(() => {
    void messageBlocks;
    const el = messagesEl;
    if (!el) return;
    hasOverflow = el.scrollHeight > el.clientHeight + 1;
    cancelScrollTimers();
    if (sending && followBottom) scrollToBottom(false);
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
  let toolboxMenuOpen = $state(false);
  // Mobile-only "wharf": on narrow viewports the whole composer-button
  // row collapses behind a single tap target. When this is true, the
  // row slides up as a vertical icon column above the bar. Opening any
  // picker auto-closes the wharf so only one popover is on screen at
  // a time - see the `composerWharfOpen = false` lines sprinkled
  // through the button handlers below. Has no effect on desktop; the
  // CSS hides the trigger above 720px.
  let composerWharfOpen = $state(false);

  // IDs of system prompts active for the current thread. Seeded from
  // `enabledByDefault` when a thread is opened, not persisted. Swapping
  // threads resets this to the current defaults — per-thread toggles do
  // not carry across conversations.
  let activePromptIds = $state<Set<string>>(new Set());

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
    toolboxMenuOpen = false;
    composerWharfOpen = false;
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
    if (
      !promptsMenuOpen &&
      !modelMenuOpen &&
      !reasoningMenuOpen &&
      !verbosityMenuOpen &&
      !toolboxMenuOpen &&
      !composerWharfOpen
    )
      return;
    // "Inside" is scoped to the open popover and its trigger — not the
    // whole composer bar. Clicks on the bar's empty filler, the send
    // button, or the toolbox toggle all count as outside so the popover
    // yields the moment the user's attention moves anywhere else.
    // `aria-haspopup="true"` is already set on every menu trigger for
    // a11y, so we reuse it here instead of listing CSS classes. The
    // mobile wharf column also counts as inside: taps on a wharf icon
    // button already close the wharf via their own handlers, but taps
    // on the column's bevel frame or gap should not.
    const tgt = e.target;
    if (
      tgt instanceof Element &&
      (tgt.closest('.composer-menu') ||
        tgt.closest('[aria-haspopup="true"]') ||
        tgt.closest('.composer-bar-left.wharf-open'))
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
      toolboxMenuOpen ||
      composerWharfOpen ||
      openMenuThreadId !== null;
    if (!anyOpen) return;
    document.addEventListener('click', onDocClick);
    document.addEventListener('keydown', onDocKey);
    return () => {
      document.removeEventListener('click', onDocClick);
      document.removeEventListener('keydown', onDocKey);
    };
  });

  // Brief pulse on the composer toolbox button when the LLM changes
  // the thread's gated-toolbox set via `toggle_toolbox`. Set true on
  // change, unset after the animation finishes - ~600ms is enough for
  // the keyframe to complete.
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
    | { kind: 'tool-group'; assistant: Message; resultsByCallId: Record<string, Message> }
    // Rendered as a single faded "Renamed to X" line where an
    // `update_title` call fired. Carries a stable `key` so the #each
    // keyed loop can distinguish multiple renames within one turn
    // (unlikely, but the model could do it). `assistantId` anchors
    // the block to its originating assistant row for debugging /
    // future deep-link needs.
    | { kind: 'rename'; key: string; assistantId: string; title: string };

  // Tool names rendered as something other than a standard tool-call
  // card:
  //   - `toggle_tools` is pure housekeeping (the LLM flips tools on/off
  //     between turns). Rendering it as a tool row adds noise and the
  //     user already sees the state via the composer toolbox flash, so
  //     it's suppressed from the render plan entirely.
  //   - `update_title` is surfaced as a `rename` block instead of a
  //     standard tool card - see the block builder below. It's listed
  //     here so the standard tool-group path skips it.
  // The underlying `tool_calls` and tool-result rows still live in the
  // message store and go out on the wire on replay; this is purely a
  // display filter.
  const HIDDEN_TOOL_NAMES = new Set(['toggle_tools', 'update_title']);

  /**
   * Pull the sanitised title out of an update_title call + its
   * optional result row. Prefers the tool-result (post-sanitisation,
   * post-persist) because that's exactly what was written to the DB;
   * falls back to the call's raw arguments when the result hasn't
   * landed yet (mid-turn, before persistence finishes). Returns null
   * if neither source yields a non-empty title - in which case the
   * rename block is skipped entirely rather than rendering an empty
   * indicator.
   */
  function titleFromRenameCall(
    call: { function: { arguments: string } },
    result: Message | undefined
  ): string | null {
    if (result) {
      try {
        const parsed = JSON.parse(result.content) as unknown;
        if (
          parsed &&
          typeof parsed === 'object' &&
          'title' in parsed &&
          typeof (parsed as { title: unknown }).title === 'string'
        ) {
          const t = (parsed as { title: string }).title.trim();
          if (t) return t;
        }
      } catch {
        // fall through to args
      }
    }
    try {
      const parsed = JSON.parse(call.function.arguments || '{}') as unknown;
      if (
        parsed &&
        typeof parsed === 'object' &&
        'title' in parsed &&
        typeof (parsed as { title: unknown }).title === 'string'
      ) {
        const t = (parsed as { title: string }).title.trim();
        if (t) return t;
      }
    } catch {
      // malformed JSON on the wire is the model's fault; skip the block
    }
    return null;
  }

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
      if (m.role === 'user') {
        blocks.push({ kind: 'plain', message: m });
        continue;
      }
      if (
        m.role === 'assistant' &&
        m.tool_calls &&
        m.tool_calls.length > 0
      ) {
        const visibleCalls = m.tool_calls.filter(
          (c) => !HIDDEN_TOOL_NAMES.has(c.function.name)
        );
        // Pull the rename calls off separately so they render as their
        // own dedicated block below. A turn can contain both rename +
        // other tools; the two render paths coexist, with the rename
        // indicator appearing AFTER the assistant/tool-group block for
        // the turn it fired on (reads as "here's the response. and by
        // the way, renamed").
        const renameCalls = m.tool_calls.filter(
          (c) => c.function.name === 'update_title'
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
        } else {
          const scoped: Record<string, Message> = {};
          for (const call of visibleCalls) {
            const r = resultsByCallId[call.id];
            if (r) scoped[call.id] = r;
          }
          // Copy the message so we can narrow tool_calls to just the
          // visible ones without mutating the store-owned row.
          const narrowed: Message = { ...m, tool_calls: visibleCalls };
          blocks.push({ kind: 'tool-group', assistant: narrowed, resultsByCallId: scoped });
        }

        // Emit one rename block per successful update_title call on
        // this turn. Placed AFTER the main block (see comment above on
        // reading order).
        for (const call of renameCalls) {
          const title = titleFromRenameCall(call, resultsByCallId[call.id]);
          if (title !== null) {
            blocks.push({
              kind: 'rename',
              key: call.id,
              assistantId: m.id,
              title,
            });
          }
        }
      } else {
        blocks.push({ kind: 'plain', message: m });
      }
    }
    return blocks;
  });

  /**
   * True when the persisted transcript ends in a shape that means the
   * model never got to produce a final reply for the last user turn.
   * Three tails qualify:
   *
   *   - `tool`: a tool round completed, and the next assistant round
   *     failed before any text was persisted. This is the overload-
   *     mid-turn case: the rate-limit banner that would normally park
   *     a retry closure only lives in memory, so a page refresh wipes
   *     the in-session retry button and leaves the transcript with
   *     nothing after the tool result rows.
   *   - `assistant` with `tool_calls`: the model emitted tool_calls
   *     but the tool executions or the result-persist step failed
   *     before any tool rows landed. Rare, but leaves the same
   *     orphan-turn shape.
   *   - `user`: the user message persisted but the first assistant
   *     round never wrote anything (immediate failure, or refresh
   *     during the very first round before any persistence).
   *
   * Suppressed while `sending` is true (a turn in progress has the
   * same DB tail mid-exchange and we don't want the banner fighting
   * the live streaming bubble), and while `streamingError` is set
   * (its own banner already offers a retry where applicable, and
   * double-rendering two retry prompts for the same failure is
   * noisy).
   */
  const incompleteTurnTail = $derived.by<Message | null>(() => {
    if (sending) return null;
    if (streamingError) return null;
    if (messages.length === 0) return null;
    const last = messages[messages.length - 1];
    if (last.role === 'tool') return last;
    if (last.role === 'assistant' && last.tool_calls && last.tool_calls.length > 0) {
      return last;
    }
    if (last.role === 'user') return last;
    return null;
  });

  /**
   * User-driven toolbox toggle - parallel to the `toggle_toolbox`
   * meta-tool's LLM path. Flips the named gated toolbox on or off in
   * the current thread's `toolboxes_enabled` array, writes through
   * to Supabase, and reverts on failure so the UI can't lie about
   * server state. Only meaningful on a real (non-draft) thread;
   * drafts don't exist server-side until they materialize on send.
   */
  async function toggleToolboxManually(toolboxName: string): Promise<void> {
    if (!app.supabase || !currentThread || currentThread.isDraft) return;
    const threadId = currentThread.id;
    const current = currentThread.toolboxes_enabled;
    const next = current.includes(toolboxName)
      ? current.filter((n) => n !== toolboxName)
      : [...current, toolboxName];
    // Optimistic: update locally first so the checkbox feels instant.
    patchThread(threadId, { toolboxes_enabled: next });
    try {
      await app.supabase.setThreadToolboxesEnabled(threadId, next);
    } catch (err) {
      // Revert on failure so the UI doesn't lie about server state.
      patchThread(threadId, { toolboxes_enabled: current });
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
  {#if AuthComp}
    <AuthComp />
  {/if}
{:else}
  <!--
    Modals render as overlays ALONGSIDE the chat shell, not in place
    of it, so chat state (in-flight stream, AbortController, scroll
    position, reactive effects) survives navigation into a modal.
    The shell is hidden via `display: none` while a modal is active -
    the DOM tree and every $state / $effect in this component stay
    live, which is what keeps a mid-turn completion running to the
    DB write while the user is looking at Settings / Samskara
    diagnostics / Memories / etc. Without this, the else-if chain
    would unmount the shell each time and ... it shouldn't kill the
    script state by Svelte 5 semantics, but the user observed
    completions stopping across modal navigation, and the safest
    cure is to never let the branch swap happen in the first place.
  -->
  <div
    class="shell"
    class:drawer-open={drawerOpen}
    class:logs-open={logsDrawer.state.open}
    class:shell-behind-modal={route.modal !== null}
  >
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
             chrome. The Chats button only kicks off newThread() when
             no conversation is currently selected - the user is
             returning to the Chats tab and would otherwise hit an
             empty pane. When a thread IS selected, the tab is just a
             "go back to chats" affordance and the existing selection
             rides along. The explicit "start a new conversation"
             gesture lives on the topbar's .new-thread-mini icon. -->
        <div class="sidebar-nav" role="tablist" aria-label="Drawer section">
          <div class="row thread-row">
            <button
              type="button"
              role="tab"
              class="thread grow"
              class:active={drawerTab === 'chats'}
              aria-selected={drawerTab === 'chats'}
              onclick={() => {
                navigate({ drawer: null }, { replace: true });
                // Retain the active conversation when the user is
                // just navigating back to the Chats tab. Only spin up
                // a fresh draft when there's nothing to land on -
                // newThread() would otherwise overwrite route.cid
                // with a new draft id every time the tab is clicked.
                if (!route.cid) void newThread();
              }}
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
          <div class="row thread-row">
            <button
              type="button"
              role="tab"
              class="thread grow"
              class:active={drawerTab === 'journal'}
              aria-selected={drawerTab === 'journal'}
              onclick={() => onPickJournalTab()}
            >Journal</button>
          </div>
          <div class="row thread-row">
            <button
              type="button"
              role="tab"
              class="thread grow"
              class:active={drawerTab === 'memories'}
              aria-selected={drawerTab === 'memories'}
              onclick={() => onPickMemoriesTab()}
            >Memories</button>
          </div>
          <div class="row thread-row">
            <button
              type="button"
              role="tab"
              class="thread grow"
              class:active={drawerTab === 'wiki'}
              aria-selected={drawerTab === 'wiki'}
              onclick={() => onPickWikiTab()}
            >Wiki</button>
          </div>
        </div>
      </header>
      {#if drawerTab === 'chats'}
      <div class="thread-list">
        <!-- Conversation search lives below the tab nav and above the
             thread list, mirroring the search position inside
             RecipeList / JournalList / MemoryList. The wrapper carries
             the divider border so the four tabs all read the same:
             tabs, hr, search, list. The topbar's `.new-thread-mini`
             icon (visible on every viewport, not just mobile) is the
             primary new-thread affordance. -->
        <div class="thread-list-controls">
          <input
            type="search"
            class="sidebar-search-input"
            placeholder="Search conversations"
            aria-label="Search conversations"
            bind:value={searchQuery}
            onkeydown={onSearchKey}
          />
        </div>
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
              {#if notifications.unread.has(t.id)}
                <span
                  class="thread-unread-dot"
                  aria-label="New reply"
                  title="New reply"
                ></span>
              {/if}
              {t.title || 'Untitled'}
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
               An in-flight search renders a Scanner in place of any
               prior result list - the spinner-replaces-entries idiom
               that the wiki / recipe / journal sidebars also use, so
               every search surface in the app gives the same kind of
               progress feedback. -->
          {#if searchBusy}
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
      {:else if drawerTab === 'recipes'}
        <!-- Recipes tab. RecipeList owns the search, sort, and item
             rows. Clicking a recipe navigates to it inline in the main
             panel (no modal). onSelect closes the mobile drawer so the
             newly-navigated panel is visible without a second tap. -->
        <RecipeList onSelect={closeDrawerOnMobile} />
      {:else if drawerTab === 'journal'}
        <!-- Journal tab. JournalList owns the search and date rows.
             Clicking a date navigates to that day in the main panel.
             onSelect mirrors the recipe + thread flow on mobile. -->
        <JournalList onSelect={closeDrawerOnMobile} />
      {:else if drawerTab === 'memories'}
        <!-- Memories tab. MemoryList owns the search and label rows.
             Clicking a label scrolls the panel-side card into view.
             onSelect mirrors the other tabs on mobile. -->
        <MemoryList onSelect={closeDrawerOnMobile} />
      {:else}
        <!-- Wiki tab. WikiList owns the search and alphabetical
             listing. Clicking an article surfaces it in the main
             panel. onSelect mirrors the other tabs on mobile. -->
        <WikiList onSelect={closeDrawerOnMobile} />
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
          <!-- Memories used to live behind a footer bookmark icon
               (and a Settings button). Both went away when memories
               graduated to a sibling drawer tab next to chats /
               recipes / journal - the Memories tab IS the entry
               point now. The Cookbook icon below stays because it's
               a one-tap affordance to the Recipes tab from any
               panel; the Memories tab covers that role itself. -->
          <button
            class="secondary icon-btn"
            onclick={() => onPickRecipesTab()}
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
        {#if drawerTab === 'chats'}
          <!-- Chats top-bar: new-thread + title (inline-renameable). The
               logs-toggle that used to live here moved out of the per-tab
               branches so it appears on every section. -->
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
            {#if currentThread}
              {#if renaming}
                <input
                  class="title-input"
                  bind:this={titleInputEl}
                  bind:value={renameBuffer}
                  onkeydown={onTitleKey}
                  onblur={commitRename}
                  maxlength="80"
                />
              {:else}
                <button
                  class="title-btn"
                  title="Click to rename"
                  onclick={startRename}
                >{currentThread.title || 'Untitled'}</button>
              {/if}
            {/if}
          </div>

        {:else if drawerTab === 'recipes'}
          <!-- Recipes top-bar: new-recipe button mirrors the new-thread
               button in the chats top-bar. Triggers the Cookbook panel
               to open the edit form for a fresh recipe via the
               $bindable cookbookTriggerNew prop. -->
          <button
            class="secondary icon-btn new-thread-mini"
            onclick={() => (cookbookTriggerNew = true)}
            title="New recipe"
            aria-label="New recipe"
          >
            <!-- Feather "file-text" — document with lines, reads as
                 "new document with content" / recipe card. -->
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                 stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
              <polyline points="14 2 14 8 20 8" />
              <line x1="16" y1="13" x2="8" y2="13" />
              <line x1="16" y1="17" x2="8" y2="17" />
              <line x1="10" y1="9" x2="8" y2="9" />
            </svg>
          </button>
          <div class="title-wrap">
            <span class="title-btn panel-section-label">Recipes</span>
          </div>

        {:else if drawerTab === 'journal'}
          <!-- Journal top-bar: new-entry + day navigation. Nav order is
               [<] [Today] [>] so the primary forward/back symmetry is
               unbroken with Today nestled in between as the "home" action.
               Date display moved into Journal.svelte's body as a heading. -->
          <button
            class="secondary icon-btn new-thread-mini"
            onclick={() => (journalTriggerNew = true)}
            title="New journal entry"
            aria-label="New journal entry"
          >
            <!-- Feather "book-open" — open book reads as journal/diary. -->
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                 stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z" />
              <path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z" />
            </svg>
          </button>
          <div class="journal-topbar-nav">
            <button
              type="button"
              class="secondary"
              onclick={() => navigate({ journal_date: shiftDay(journalFocusedDate, -1) })}
              aria-label="Previous day"
              title="Previous day"
            >‹</button>
            {#if journalFocusedDate !== journalToday}
              <button
                type="button"
                class="secondary"
                onclick={() => navigate({ journal_date: journalToday })}
                title="Jump to today"
              >Today</button>
            {/if}
            <button
              type="button"
              class="secondary"
              onclick={() => navigate({ journal_date: shiftDay(journalFocusedDate, 1) })}
              aria-label="Next day"
              title="Next day"
              disabled={journalFocusedDate >= journalToday}
            >›</button>
          </div>
          <div class="title-wrap"></div>
        {:else if drawerTab === 'memories'}
          <!-- Memories top-bar. No new-row affordance (memories are
               written by the reflection agent and the assistant's
               volitional memory tools, not by direct human compose),
               and no per-row navigation - editing happens inline on
               the panel. The label keeps the top-bar visually
               consistent with Recipes, where a static label sits in
               the title slot. -->
          <div class="title-wrap">
            <span class="title-btn panel-section-label">Memories</span>
          </div>
        {:else}
          <!-- Wiki top-bar. No top-bar new-article button - the create
               affordance lives inline on the empty-state hint in
               Wiki.svelte, mirroring how Memories handles the same
               case. Static label in the title slot keeps the chrome
               consistent with the other tabs.

               Manual-librarian button: opens the Wiki panel's
               confirmation strip (with an optional custom-instructions
               textarea). Disabled while either the scheduled worker
               is mid-run or a previous manual run is still in flight -
               we never want two librarian agents writing to the wiki
               concurrently. The strip itself, the run, and the post-
               run summary live in Wiki.svelte; this button is just
               the launcher. -->
          <button
            class="secondary icon-btn librarian-run-btn"
            onclick={() => (wikiLibrarianTrigger = true)}
            disabled={wikiLibrarianRunner.busy}
            title={wikiLibrarianRunner.busy
              ? 'The librarian is already running'
              : 'Run the wiki librarian now'}
            aria-label={wikiLibrarianRunner.busy
              ? 'The librarian is already running'
              : 'Run the wiki librarian now'}
          >
            <!-- Feather "sparkles" - reads as "agent / clean up". -->
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                 stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <path d="M12 3l1.9 4.6L18 9l-4.1 1.4L12 15l-1.9-4.6L6 9l4.1-1.4L12 3z" />
              <path d="M5 17l.8 2L8 19.5l-2.2.5L5 22l-.8-2L2 19.5l2.2-.5L5 17z" />
              <path d="M19 14l.6 1.5L21 16l-1.4.5L19 18l-.6-1.5L17 16l1.4-.5L19 14z" />
            </svg>
          </button>
          <!-- Wiki changelog launcher. Sits next to the librarian button
               so the two "audit the wiki agent's behavior" affordances
               (run it now / see what it has been doing) live side by
               side. The modal itself is the `wiki-changelog` modal
               value on the route; navigating preserves the rest of
               the URL so closing the modal lands the user back on
               the same tab. -->
          <button
            class="secondary icon-btn wiki-changelog-btn"
            onclick={() => navigate({ modal: 'wiki-changelog' })}
            title="Wiki changelog"
            aria-label="Wiki changelog"
          >
            <!-- Feather "clock" - reads as "history / audit log". -->
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                 stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <circle cx="12" cy="12" r="10" />
              <polyline points="12 6 12 12 16 14" />
            </svg>
          </button>
          <div class="title-wrap">
            <span class="title-btn panel-section-label">Wiki</span>
          </div>
        {/if}
        <!-- Logs drawer toggle. Lives outside the per-tab branches so it
             appears as the trailing top-bar action on chats, recipes,
             journal, and memories alike - the in-app log viewer is a
             cross-cutting tool, not chat-specific. Document-glyph icon
             reads as "open the reading panel" rather than "new document".
             Wired to the logsDrawer rune singleton; the LogsDrawer
             component mounted at Chat root watches the same state. -->
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

      {#if drawerTab === 'chats'}
      <div class="messages-wrap">
        <div
          class="messages"
          bind:this={messagesEl}
          onscroll={onMessagesScroll}
        >
          {#each messageBlocks as block (
            block.kind === 'plain'
              ? block.message.id
              : block.kind === 'rename'
              ? `rename:${block.key}`
              : block.assistant.id
          )}
            {#if block.kind === 'tool-group'}
              <!-- Tool-group bubble: reuse AssistantBody for the markdown
                   / reasoning / citations triad, with `<ToolCalls>`
                   snippet-slotted between the body and the action bar.
                   The bubble itself still lives here so the component
                   stays focused on per-message body concerns. -->
              <div
                class="msg assistant"
                class:disabled={pendingDeleteSet.has(block.assistant.id)}
                class:fading-out={fadeOutDelays[block.assistant.id] !== undefined}
                style:animation-delay={`${fadeOutDelays[block.assistant.id] ?? 0}ms`}
              >
                <AssistantBody
                  content={block.assistant.content}
                  reasoning={block.assistant.reasoning}
                  citations={block.assistant.citations}
                  model={block.assistant.model}
                  usage={block.assistant.usage}
                  createdAt={block.assistant.created_at}
                  disabled={pendingDeleteSet.has(block.assistant.id) || sending}
                  onRegenerate={() => { void regenerateFrom(block.assistant.id); }}
                >
                  <ToolCalls
                    calls={block.assistant.tool_calls ?? []}
                    resultsByCallId={block.resultsByCallId}
                    timings={toolTimings}
                    nowMs={nowMs}
                    sending={sending}
                  />
                </AssistantBody>
              </div>
            {:else if block.kind === 'rename'}
              <!-- Low-emphasis inline indicator for an `update_title`
                   tool call. Not a full tool-call card - just a faded
                   line telling the user the conversation was renamed,
                   at the point in the transcript where it happened.
                   The drawer + title bar have already been patched by
                   the chat-loop's onTitleChange handler, so this is
                   purely the "audit trail" surface. Styled in the
                   .renamed-to block at the bottom of this file's
                   <style> block to match other subdued chat chrome. -->
              <div class="renamed-to" role="note" aria-label="Conversation renamed">
                Renamed to <em>{block.title}</em>
              </div>
            {:else if block.message.role === 'assistant'}
              <div
                class="msg assistant"
                class:disabled={pendingDeleteSet.has(block.message.id)}
                class:fading-out={fadeOutDelays[block.message.id] !== undefined}
                style:animation-delay={`${fadeOutDelays[block.message.id] ?? 0}ms`}
              >
                <AssistantBody
                  content={block.message.content}
                  reasoning={block.message.reasoning}
                  citations={block.message.citations}
                  model={block.message.model}
                  usage={block.message.usage}
                  createdAt={block.message.created_at}
                  disabled={pendingDeleteSet.has(block.message.id) || sending}
                  onRegenerate={() => { void regenerateFrom(block.message.id); }}
                />
              </div>
            {:else}
              {@const isUser = block.message.role === 'user'}
              {@const userRound = isUser
                ? userRoundByMessageId.get(block.message.id) ?? null
                : null}
              {@const firesForRound =
                userRound !== null ? firesByUserRound.get(userRound) ?? null : null}
              {@const substrateForMsg = isUser
                ? substrateByUserMsgId.get(block.message.id) ?? null
                : null}
              {@const hasInlineCohort =
                (firesForRound !== null && firesForRound.length > 0) ||
                substrateForMsg !== null}
              {@const cohortExpanded = isUser
                ? expandedCohortPanels.has(block.message.id)
                : false}
              <div
                class="msg {block.message.role}"
                class:disabled={pendingDeleteSet.has(block.message.id)}
                class:fading-out={fadeOutDelays[block.message.id] !== undefined}
                style:animation-delay={`${fadeOutDelays[block.message.id] ?? 0}ms`}
              >
                <Markdown content={block.message.content} />
                {#if block.message.role === 'user' && block.message.attachments && block.message.attachments.length > 0}
                  <MessageAttachments attachments={block.message.attachments} />
                {/if}
                {#if isUser && hasInlineCohort}
                  <!-- User-message action row. Mirrors the assistant
                       message's .msg-actions strip but lives outside
                       AssistantBody since user messages are rendered
                       directly in Chat.svelte. Reuses the shared
                       .msg-actions and .copy-btn rules so the visual
                       weight matches the assistant row's copy /
                       citations / regenerate buttons (14px outline
                       SVG, 2px stroke, hover ramps from muted to
                       text). Only mounts when this turn actually
                       fired samskaras or wrote a substrate stub - we
                       don't surface an empty toggle on cold-start
                       messages. -->
                  <div class="msg-actions">
                    <button
                      type="button"
                      class="copy-btn cohort-toggle"
                      aria-expanded={cohortExpanded}
                      title={cohortExpanded
                        ? 'Hide what samskaras fired on this turn'
                        : 'Show what samskaras fired on this turn'}
                      aria-label={cohortExpanded
                        ? 'Hide samskara fires for this turn'
                        : 'Show samskara fires for this turn'}
                      onclick={() => toggleCohortPanel(block.message.id)}
                    >
                      <!-- Feather "activity" pulse line - reads as a
                           heartbeat / signal trace, matching the
                           assistant action row's outline-stroke icons
                           (14px, 2px stroke). -->
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none"
                           stroke="currentColor" stroke-width="2" stroke-linecap="round"
                           stroke-linejoin="round" aria-hidden="true">
                        <polyline points="22 12 18 12 15 21 9 3 6 12 2 12" />
                      </svg>
                    </button>
                  </div>
                  {#if cohortExpanded}
                    <div class="cohort-panel-host">
                      <CohortPanel
                        fires={firesForRound ?? []}
                        substrate={substrateForMsg}
                        clusterMap={cohortClusterMap}
                      />
                    </div>
                  {/if}
                {/if}
              </div>
            {/if}
          {/each}
          {#if incompleteTurnTail}
            <!-- Post-refresh resume banner. The in-session rate-limit
                 retry lives only on `streamingError.retry` and doesn't
                 survive a page reload, so when a user refreshes after
                 an overload-mid-turn failure the orphaned tool rows
                 sit at the tail with no way to continue the turn short
                 of typing a new prompt. This banner reattaches a retry
                 affordance to that tail (see `incompleteTurnTail` for
                 the exact shapes we treat as incomplete). Rendered as
                 an informational bubble, not an error alert - the
                 failure itself is already in the past. -->
            <div class="msg assistant msg-incomplete" role="note">
              <div class="msg-incomplete-body">
                <div class="msg-incomplete-text">
                  The response appears to have been cut off. Click to retry.
                </div>
                <button
                  type="button"
                  class="secondary icon-btn msg-incomplete-retry"
                  onclick={() => { void retryIncompleteTurn(); }}
                  disabled={sending}
                  aria-label="Retry"
                  title="Retry"
                >
                  <!-- Refresh / circular-arrow icon (Feather "refresh-cw"),
                       matching the regenerate and rate-limit retry buttons. -->
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none"
                       stroke="currentColor" stroke-width="2" stroke-linecap="round"
                       stroke-linejoin="round" aria-hidden="true">
                    <polyline points="23 4 23 10 17 10" />
                    <polyline points="1 20 1 14 7 14" />
                    <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10" />
                    <path d="M20.49 15a9 9 0 0 1-14.85 3.36L1 14" />
                  </svg>
                </button>
              </div>
            </div>
          {/if}
          {#if interruptedDraft}
            <!-- Orphaned-draft recovery banner. Shown when thread load
                 finds an IndexedDB streaming draft whose user message
                 has no committed assistant response - meaning the prior
                 session ended abruptly (tab close, Chrome mobile freeze,
                 power loss) before the LLM response landed. Offers a
                 one-click retry (re-runs the exchange against the same
                 user message) and a dismiss to discard the draft and
                 move on. Rendered at the tail of the transcript so it
                 sits right after the orphaned user message. -->
            <div class="msg assistant msg-incomplete" role="note">
              <div class="msg-incomplete-body">
                <div class="msg-incomplete-text">
                  Previous response was interrupted. Retry to generate a new one.
                </div>
                <button
                  type="button"
                  class="secondary icon-btn msg-incomplete-retry"
                  onclick={() => void retryInterrupted()}
                  disabled={sending}
                  aria-label="Retry interrupted response"
                  title="Retry"
                >
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none"
                       stroke="currentColor" stroke-width="2" stroke-linecap="round"
                       stroke-linejoin="round" aria-hidden="true">
                    <polyline points="23 4 23 10 17 10" />
                    <polyline points="1 20 1 14 7 14" />
                    <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10" />
                    <path d="M20.49 15a9 9 0 0 1-14.85 3.36L1 14" />
                  </svg>
                </button>
                <button
                  type="button"
                  class="secondary icon-btn msg-incomplete-dismiss"
                  onclick={() => {
                    void deleteDraft(interruptedDraft!.threadId).catch(() => {});
                    interruptedDraft = null;
                  }}
                  aria-label="Dismiss"
                  title="Dismiss"
                >×</button>
              </div>
            </div>
          {/if}
          {#if streamingError}
            <!-- Canonical error surface for chat send-path failures.
                 Rendered in the transcript where the streaming output
                 was, so it follows the conversation flow regardless
                 of what the composer or keyboard are doing. Carries
                 the retry button when `streamingError.retry` is set
                 (rate-limit errors, currently). The `.error-bar`
                 banner above the composer is reserved for non-
                 exchange errors (attachment upload, thread rename,
                 pre-send guards) that don't have a transcript anchor.
                 Dismissed by the next successful send (or manually
                 via the X). -->
            <div class="msg assistant msg-error" role="alert">
              <div class="msg-error-body">
                <span class="msg-error-icon" aria-hidden="true">!</span>
                <div class="msg-error-text">{streamingError.text}</div>
                {#if streamingError.retry}
                  <button
                    type="button"
                    class="secondary icon-btn msg-error-retry"
                    onclick={streamingError.retry}
                    disabled={sending}
                    aria-label="Retry"
                    title="Retry"
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
                <button
                  type="button"
                  class="secondary icon-btn msg-error-dismiss"
                  onclick={() => { streamingError = null; }}
                  aria-label="Dismiss error"
                  title="Dismiss"
                >×</button>
              </div>
            </div>
          {/if}
          <!-- Streaming bubble visibility is gated on `sending` alone -
               the master flag for "chat loop is running". This
               guarantees the KITT Scanner inside stays on screen for
               the ENTIRE response cycle: from the moment the user hits
               send, through every reasoning + content delta, across
               every tool round (model assembles a tool call, tools
               execute, next round opens, text streams in again), and
               only winks out when the chat loop finally closes after
               the terminal round's `data: [DONE]`. Earlier shapes
               OR'd in `streamingText || streamingReasoning` defensively;
               that read as "is there content" rather than "is the
               turn alive" and made the bubble's lifetime ambiguous to
               anyone reading it. Both buffers are cleared by
               onAssistantPersisted at the close of every round (so
               the bubble collapses back to a Scanner-only card while
               tools execute or the next round is being opened) and
               the runExchange success/error paths clear them both
               before `sending = false` runs in finally - so dropping
               them from the condition can't shorten the visible
               window, only document the intent. -->
          {#if sending}
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
              {/if}
              <!-- Continuous "still working" signal for the entire
                   window between "user hit send" and the chat loop
                   actually closing - including gaps that aren't
                   emitting any deltas (model has finished reasoning
                   and is assembling a tool call; tools are executing
                   between rounds; round just ended, next round about
                   to start; final round persisted but post-loop
                   bookkeeping like refreshThreads is still running).
                   Stays visible AFTER streamingText starts arriving
                   too: a single round can emit text deltas and then
                   switch to tool_call deltas within the same
                   assistant message, and once the text stops flowing
                   the bubble otherwise reads as "done responding"
                   even though the model is still building a tool
                   call on the wire. Cleared only when `sending` flips
                   false in runExchange's outer finally - by which
                   time every round, every tool execution, and every
                   inter-round gap has played out. Sits below
                   ReasoningPanel rather than being suppressed by it -
                   once reasoning text has accumulated the panel
                   itself stops moving. Wrapper centers the inline-
                   flex Scanner inside the bubble so it doesn't read
                   as a stranded artifact in the top-left corner. -->
              <div class="thinking">
                <Scanner label="Thinking" />
              </div>
              {#if rateLimitWaitUntil !== null}
                <!-- Rate-limit wait indicator. Sits below the Scanner
                     (or the streaming Markdown when text is already
                     arriving) so the existing "still working" cue
                     stays in place; the additional row tells the user
                     specifically WHY the spinner is paused. The
                     remaining-seconds value is recomputed each render
                     against rateLimitNowTick (a 1Hz reactive bump
                     scheduled while the wait is active) so the
                     countdown ticks down without rebinding the bubble.
                     The user's existing stop button serves as the
                     cancel - aborting during the wait lands in the
                     same INTERRUPTED_MARKER branch as a mid-stream
                     cancel, so the orphan-draft retry banner shows up
                     identically afterward. -->
                <div class="rate-limit-wait" role="status" aria-live="polite">
                  <!-- Feather "clock" icon. -->
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none"
                       stroke="currentColor" stroke-width="2" stroke-linecap="round"
                       stroke-linejoin="round" aria-hidden="true">
                    <circle cx="12" cy="12" r="10" />
                    <polyline points="12 6 12 12 16 14" />
                  </svg>
                  <span>
                    Waiting on Venice (attempt {rateLimitAttempt})
                    {#if rateLimitRemainingSec > 0}- resuming in {rateLimitRemainingSec}s{/if}
                  </span>
                </div>
              {/if}
              <!-- Citations are deliberately NOT rendered during
                   streaming. The list is available from Venice's first
                   chunk, but rendering it open here pushes the bubble's
                   bottom edge down by the height of the source list,
                   and follow-bottom scrolling then anchors to that
                   edge - leaving reasoning streaming in above the
                   viewport. The persisted bubble's AssistantBody picks
                   the citations up the instant the row lands, with the
                   panel collapsed by default and an action-bar toggle
                   to expand on demand. -->
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
        <!-- Diagnostic pills (intuition brain, samskara mood) stack
             above the scroll-to-bottom arrow in a vertical column
             pinned to the bottom-right of the messages pane. They sit
             inside .messages-wrap (which is position:relative) so they
             share a coordinate system with .scroll-to-bottom; that
             keeps the column aligned regardless of composer height.
             Mounting them here, rather than as siblings of the shell
             at the bottom of this file, is what couples the alignment
             to the scroll arrow. Both pills suppress themselves when
             their backing data isn't present (no cached intuition
             payload / no samskara reading), so the column collapses
             gracefully on cold threads. -->
        <SamskaraToasts />
        <IntuitionPill payload={currentIntuitionPayload} />
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
          <!-- The textarea stays enabled while `sending` is true so the
               user can draft their next message while the current reply
               is still streaming. The send button transforms into a
               stop button in the same state (see the .send-btn block
               below) and a submit-modifier Enter aborts rather than
               sends (see onKeydown) - so any input landing here during
               a stream is a draft for the *next* turn, not something
               that auto-fires when the current stream completes. -->
          <textarea
            class="composer-textarea"
            class:is-collapsed={composerIsMobile && !composerFocused}
            bind:value={composer}
            bind:this={composerEl}
            onkeydown={onKeydown}
            onpaste={onComposerPaste}
            onfocus={() => (composerFocused = true)}
            onblur={() => (composerFocused = false)}
            placeholder={currentThread?.archived
              ? 'Restore this conversation to continue.'
              : sendHint}
            disabled={currentThread?.archived}
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
            <!-- Mobile-only wharf trigger. On desktop the CSS hides this
                 button entirely; on mobile it toggles the `.wharf-open`
                 class on the sibling button row, which CSS restyles as
                 a vertical icon column floating above the composer
                 bar. The row itself is hidden on mobile when the wharf
                 is closed (see `.composer-bar-left > button` in
                 styles.css), so this trigger is the only way to reach
                 the pickers on a narrow viewport. -->
            <button
              type="button"
              class="secondary icon-btn composer-wharf-trigger"
              class:open={composerWharfOpen}
              onclick={() => (composerWharfOpen = !composerWharfOpen)}
              title="Composer menu"
              aria-label="Composer menu"
              aria-haspopup="true"
              aria-expanded={composerWharfOpen}
              aria-controls="composer-wharf"
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                <circle cx="5" cy="5" r="1.8" />
                <circle cx="12" cy="5" r="1.8" />
                <circle cx="19" cy="5" r="1.8" />
                <circle cx="5" cy="12" r="1.8" />
                <circle cx="12" cy="12" r="1.8" />
                <circle cx="19" cy="12" r="1.8" />
                <circle cx="5" cy="19" r="1.8" />
                <circle cx="12" cy="19" r="1.8" />
                <circle cx="19" cy="19" r="1.8" />
              </svg>
            </button>
            <div class="composer-bar-left" id="composer-wharf" class:wharf-open={composerWharfOpen}>
              <!-- Toolbox popover: each gated toolbox is an independent
                   on/off. Badge shows how many are on for this thread.
                   Pulses on LLM-initiated flips via .flash (see CSS).
                   Sits first in the row because toolbox choice is the
                   most load-bearing decision on this toolbar - cost and
                   capability pivot on it. -->
              {#if currentThread && !currentThread.isDraft}
                <button
                  type="button"
                  class="secondary toolbox-btn"
                  class:on={currentThread.toolboxes_enabled.length > 0}
                  class:flash={toolboxFlash}
                  onclick={() => {
                    modelMenuOpen = false;
                    reasoningMenuOpen = false;
                    verbosityMenuOpen = false;
                    promptsMenuOpen = false;
                    composerWharfOpen = false;
                    toolboxMenuOpen = !toolboxMenuOpen;
                  }}
                  title={currentThread.toolboxes_enabled.length > 0
                    ? `Toolboxes: ${currentThread.toolboxes_enabled.join(', ')}`
                    : 'No toolboxes enabled - click to enable one'}
                  aria-label="Toolboxes"
                  aria-haspopup="true"
                  aria-expanded={toolboxMenuOpen}
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
                  {#if currentThread.toolboxes_enabled.length > 0}
                    <span class="badge" aria-hidden="true"
                      >{currentThread.toolboxes_enabled.length}</span
                    >
                  {/if}
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
                onclick={() => {
                  composerWharfOpen = false;
                  void onFilePicker();
                }}
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
                  composerWharfOpen = false;
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
                  composerWharfOpen = false;
                  modelMenuOpen = !modelMenuOpen;
                }}
                aria-haspopup="true"
                aria-expanded={modelMenuOpen}
                title={`Model: ${TIERS[currentTier].label} (${TIERS[currentTier].id})`}
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
                <span class="model-picker-icon" aria-hidden="true">{TIERS[currentTier].icon}</span>
                <span class="model-picker-label">{TIERS[currentTier].label}</span>
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
                    composerWharfOpen = false;
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
                  composerWharfOpen = false;
                  verbosityMenuOpen = !verbosityMenuOpen;
                }}
                onSelect={(v) => {
                  void setVerbosity(v);
                  verbosityMenuOpen = false;
                }}
              />
            </div>

            <!-- Dual-purpose button: sends when idle, stops the in-
                 flight response when a stream is running. The icon
                 swap (paper plane <-> filled square) signals the mode;
                 the handler branches on `sending`. While sending, the
                 disabled rules that gate the send path (empty composer,
                 archived thread) are intentionally ignored - stop
                 must always be clickable once a response is in flight,
                 regardless of what the user has typed next. -->
            <button
              class="send-btn"
              class:is-stopping={sending}
              onclick={sending ? stopStreaming : send}
              disabled={sending
                ? abortCtl === null
                : (composer.trim().length === 0 && pendingAttachments.length === 0) ||
                  currentThread?.archived}
              title={sending
                ? 'Stop response'
                : currentThread?.archived
                  ? 'Archived — restore to continue'
                  : 'Send'}
              aria-label={sending ? 'Stop response' : 'Send'}
            >
              {#if sending}
                <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"
                     aria-hidden="true">
                  <rect x="5" y="5" width="14" height="14" rx="2" />
                </svg>
              {:else}
                <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"
                     aria-hidden="true">
                  <path d="M2.01 21 23 12 2.01 3 2 10l15 2-15 2z" />
                </svg>
              {/if}
            </button>

            {#if toolboxMenuOpen && currentThread && !currentThread.isDraft}
              <div class="composer-menu composer-menu-left" role="menu">
                <div class="menu-header">Toolboxes for this conversation</div>
                {#each GATED_TOOLBOX_META as tb (tb.name)}
                  <label class="menu-item">
                    <input
                      type="checkbox"
                      checked={currentThread.toolboxes_enabled.includes(tb.name)}
                      onchange={() => void toggleToolboxManually(tb.name)}
                    />
                    <span class="menu-item-label">
                      <strong>{tb.name}</strong>
                      <span class="subtle" style="display:block;font-size:0.75rem"
                        >{tb.description}</span
                      >
                    </span>
                  </label>
                {/each}
              </div>
            {/if}

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
                {#each TIER_ORDER as tier (tier)}
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
                    <span class="menu-item-icon" aria-hidden="true">{TIERS[tier].icon}</span>
                    <span class="menu-item-label">
                      <strong>{TIERS[tier].label}</strong>
                      <span class="subtle" style="display:block;font-size:0.75rem">{TIERS[tier].id}</span>
                    </span>
                    {#if tier === defaultTier}<span class="menu-item-badge">default</span>{/if}
                  </button>
                {/each}
              </div>
            {/if}

          </div>
        </div>
      </div>
      {:else if drawerTab === 'recipes'}
        <!-- Recipe panel. Cookbook.svelte now renders inline - no modal
             wrapper, no list pane. Selecting a recipe is done from the
             sidebar RecipeList. The triggerNew prop wires the top-bar
             "+ New recipe" button to the panel's openNew() flow. The
             onDeselect callback fires when the panel returns to its
             empty state (Back, Delete, Escape, browser back) so the
             shell can auto-expose the recipe list on mobile, where it
             lives in the drawer rather than a persistent column. The
             component itself is lazy-loaded; renders nothing while the
             chunk is in flight. -->
        {#if CookbookComp}
          <CookbookComp
            bind:triggerNew={cookbookTriggerNew}
            onDeselect={openDrawerOnMobile}
          />
        {/if}
      {:else if drawerTab === 'journal'}
        <!-- Journal panel. Journal.svelte now renders inline - no modal
             wrapper, no header. Date navigation in the top-bar drives
             route.journal_date, which the panel reads. The triggerNewEntry
             prop wires the top-bar book button to the compose flow. -->
        {#if JournalComp}
          <JournalComp bind:triggerNewEntry={journalTriggerNew} />
        {/if}
      {:else if drawerTab === 'memories'}
        <!-- Memories panel. Same shape as Cookbook / Journal: inline,
             no modal chrome. The sidebar MemoryList shares the same
             `memoriesStore` so a search keystroke filters this list
             too. Editing happens inline on the cards. -->
        {#if MemoriesComp}
          <MemoriesComp />
        {/if}
      {:else}
        <!-- Wiki panel. Same inline-no-modal-chrome shape. The sidebar
             WikiList shares the same `wikiStore` so a search keystroke
             filters both surfaces. Edit / delete / "ask agent to
             update" all happen inline on the article. The
             triggerLibrarianRun prop wires the top-bar sparkles button
             to the panel's manual-librarian confirmation strip. -->
        {#if WikiComp}
          <WikiComp bind:triggerLibrarianRun={wikiLibrarianTrigger} />
        {/if}
      {/if}
    </main>
    <!-- Right-edge logs panel. On desktop it's the third grid column
         of .shell (mirror of the threads sidebar on the left); on
         mobile it collapses into a fixed-position overlay drawer.
         Visibility is driven by the `.shell.logs-open` class above,
         which is bound to the `logsDrawer` rune singleton; the
         scroll-icon button in the top bar toggles that state. -->
    {#if LogsDrawerComp}
      <LogsDrawerComp />
    {/if}
  </div>
  <!-- Global right-side drawer for the extracted-text preview.
       Controlled by the `extractedTextDrawer` rune store; any
       MessageAttachments "Text" button clicks route through there.
       Mounted at the Chat root so it can sit above the transcript
       without the transcript being a containing block for its
       fixed positioning. -->
  {#if ExtractedTextDrawerComp}
    <ExtractedTextDrawerComp />
  {/if}
  <!-- SamskaraToasts and IntuitionPill mount inside .messages-wrap
       (see above) so they share a coordinate system with the
       scroll-to-bottom arrow and stack as a vertical column at the
       bottom-right of the messages pane. Only rendered on the chats
       panel because .messages-wrap itself is gated on
       drawerTab === 'chats'. -->

  <!--
    Modal overlays. Rendered alongside the shell (above via their
    own fixed-position backdrops + z-index) so opening a modal
    does NOT unmount the chat: in-flight completions, streaming
    state, and every reactive effect in this component keep
    running while the user navigates. The shell's
    `.shell-behind-modal` class hides it via display:none when a
    modal is active so the modal owns the viewport.
  -->
  {#if showSettings && SettingsComp}
    <SettingsComp onClose={() => navigate({ modal: null })} />
  {/if}
  {#if showHelp && HelpComp}
    <HelpComp onClose={() => navigate({ modal: null, doc: null })} />
  {/if}
  {#if showSamskara && SamskaraComp}
    <SamskaraComp onClose={() => navigate({ modal: null })} />
  {/if}
  {#if showIntuition && IntuitionComp}
    <IntuitionComp
      onClose={() => navigate({ modal: null })}
      threads={loadedThreads}
    />
  {/if}
  {#if showWikiChangelog && WikiChangelogComp}
    <WikiChangelogComp onClose={() => navigate({ modal: null })} />
  {/if}
  <!-- Cookbook, Journal, and Memories now render inline in the main
       panel (drawerTab === 'recipes' / 'journal' / 'memories') rather
       than as modals. -->
{/if}
