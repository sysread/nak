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
   * Streaming lifecycle (per thread - see `src/lib/exchange/` for the
   * slot state machine):
   *   1. User clicks send → insert user message row → clear composer.
   *   2. Kick off `app.venice.streamChat` with an AbortController held
   *      on the thread's ExchangeSlot. Deltas append into
   *      `slot.streamingText`, which renders as an "assistant" bubble
   *      below the persisted messages when this thread is the one the
   *      user is currently viewing.
   *   3. When the stream completes: insert an assistant message row,
   *      clear `slot.streamingText`, refresh the thread list so the
   *      sidebar ordering reflects updated_at.
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
  import { app, lock, applyServerSettings, notifyBiasActiveConvIds } from '$lib/state.svelte';
  import {
    notifications,
    notifyTurnComplete,
    notifyAskUser,
    markThreadRead,
  } from '$lib/notifications.svelte';
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
  import { ExchangeStore, mergeMessagesById } from '$lib/exchange/exchange-store.svelte';
  import { ThreadClaimCoordinator } from '$lib/exchange/thread-claim-coordinator';
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
  //   - Cookbook / Memories: panel screens, only render when the
  //     corresponding drawerTab is active.
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
  type MemoriesComponent = typeof import('./Memories.svelte').default;
  type WikiComponent = typeof import('./Wiki.svelte').default;
  type SettingsComponent = typeof import('./Settings.svelte').default;
  type HelpComponent = typeof import('./Help.svelte').default;
  type SamskaraComponent = typeof import('./Samskara.svelte').default;
  type IntuitionComponent = typeof import('./Intuition.svelte').default;
  type BiasProfileComponent = typeof import('./BiasProfile.svelte').default;
  type RecallComponent = typeof import('./Recall.svelte').default;
  import RecipeList from '../components/RecipeList.svelte';
  import MemoryList from '../components/MemoryList.svelte';
  import WikiList from '../components/WikiList.svelte';
  import IntuitionPill from '../components/IntuitionPill.svelte';
  import BiasPill from '../components/BiasPill.svelte';
  import RecallPill from '../components/RecallPill.svelte';
  import TopicsFilter from '../components/TopicsFilter.svelte';
  import BucketHeader from '../components/BucketHeader.svelte';
  import {
    cookbook,
    loadRecipes,
  } from '$lib/cookbook-store.svelte';
  import { onCookbookChange } from '$lib/cookbook-events';
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
  import { moodState } from '$lib/samskara/mood.svelte';
  import {
    bandIndexFor,
    columnFor,
    valenceToEmoji,
    valenceToMoodLabel,
  } from '$lib/samskara/events';
  import {
    coerceIntuitionPayload,
    pickFresherIntuitionPayload,
    type IntuitionPayload,
  } from '$lib/intuition';
  import {
    coerceContextRecallPayload,
    pickFresherContextRecallPayload,
    type ContextRecallPayload,
  } from '$lib/context-recall';
  import AssistantBody from '../components/AssistantBody.svelte';
  import CohortPanel from '../components/CohortPanel.svelte';
  import Markdown from '../components/Markdown.svelte';
  import ReasoningPanel from '../components/ReasoningPanel.svelte';
  import ReasoningPicker from '../components/ReasoningPicker.svelte';
  import VerbosityPicker from '../components/VerbosityPicker.svelte';
  import Scanner from '../components/Scanner.svelte';
  import ToolCalls from '../components/ToolCalls.svelte';
  import AskUserCard from '../components/AskUserCard.svelte';
  import {
    parseAskUserContent,
    buildAskUserAnswerContent,
    ASK_USER_PENDING_FLAG,
    type AskUserVia,
    type AskUserAnsweredContent,
    type AskUserPendingContent,
  } from '$lib/tools/ask_user';
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
  const showBiasProfile = $derived(route.modal === 'bias-profile');
  const showRecall = $derived(route.modal === 'recall');

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
  let MemoriesComp: MemoriesComponent | null = $state(null);
  let WikiComp: WikiComponent | null = $state(null);
  let SettingsComp: SettingsComponent | null = $state(null);
  let HelpComp: HelpComponent | null = $state(null);
  let SamskaraComp: SamskaraComponent | null = $state(null);
  let IntuitionComp: IntuitionComponent | null = $state(null);
  let BiasProfileComp: BiasProfileComponent | null = $state(null);
  let RecallComp: RecallComponent | null = $state(null);
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
    if (showIntuition && !IntuitionComp) {
      void import('./Intuition.svelte').then((m) => (IntuitionComp = m.default));
    }
  });
  $effect(() => {
    if (showBiasProfile && !BiasProfileComp) {
      void import('./BiasProfile.svelte').then((m) => (BiasProfileComp = m.default));
    }
  });
  $effect(() => {
    if (showRecall && !RecallComp) {
      void import('./Recall.svelte').then((m) => (RecallComp = m.default));
    }
  });
  // Trigger flag for the recipe "new" top-bar button. Chat.svelte
  // sets this to true; the panel component resets it via the
  // $bindable prop after handling the event.
  let cookbookTriggerNew = $state(false);
  // Trigger flag for the wiki "Run librarian now" top-bar button.
  // Same $bindable pattern: Chat.svelte flips it to true on click,
  // Wiki.svelte opens its confirmation strip and resets the flag.
  let wikiLibrarianTrigger = $state(false);
  // Trigger flag for the wiki "Changelog" top-bar (clock) button.
  // Same $bindable pattern. Wiki.svelte responds by closing any open
  // librarian and clearing wiki_article_id so the changelog renders.
  // Routed through Wiki.svelte rather than a direct navigate() call
  // because the librarian's open/closed state lives there as a local
  // flag; a clock-button click while the librarian is open has to
  // touch both the route AND the local flag.
  let wikiChangelogTrigger = $state(false);

  // Top-bar Skipped panel jump for the wiki tab. The autonomous wiki
  // worker stamps wiki_last_skip_at on threads it gave up on after
  // repeated agent errors (Venice content classifier rejections are
  // the dominant cause); this trigger asks the Wiki panel to render
  // the Skipped sibling page so the user can see which conversations
  // landed there and why. Same $bindable trigger shape as the other
  // two wiki panel buttons.
  let wikiSkippedTrigger = $state(false);
  /**
   * Sidebar drawer tab. Backed by `route.drawer` - absent in the URL
   * means "chats" (the default). 'recipes' and 'memories' render
   * their own list in place of the thread list. Tab switches use
   * replaceState so a tab flip doesn't fill history with UI-chrome
   * entries.
   */
  const drawerTab = $derived<'chats' | 'recipes' | 'memories' | 'wiki'>(
    route.drawer ?? 'chats'
  );
  // Recipe and memory search/listing state has moved to the
  // RecipeList / MemoryList sidebar components.

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

  // Parallel for the memories tab. `loaded`-gate prevents a re-fire
  // loop: an account with zero memories would otherwise re-fire the
  // load every time the empty result resolved (loading flips false,
  // deps trip, effect runs, loads again, forever).
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
  // Forward the open-thread set to the bias worker so it skips
  // analyzing conversations the user might still be typing in.
  // Empty array when no thread is open (the new-chat screen) so the
  // worker is free to process everything else; one-element array
  // when a thread is selected. This is per-tab; the cross-tab
  // singleton coordination already lives in the worker_leases
  // layer.
  $effect(() => {
    notifyBiasActiveConvIds(activeThreadId ? [activeThreadId] : []);
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

  /**
   * Per-thread map of in-flight chat-turn state. Each thread the user
   * has sent on owns an `ExchangeSlot` (allocated lazily by `send` /
   * `runExchange`); the slot persists in the store after the exchange
   * finishes so re-opening the thread later finds the slot ready for
   * the next send. See `src/lib/exchange/exchange-slot.svelte.ts` for
   * the field-by-field lifecycle docs.
   *
   * The screen reads the ACTIVE thread's slot via `activeSlot` below
   * - that's what drives the visible streaming bubble, the composer's
   * disabled state, the stop button, and the rate-limit countdown.
   * Background slots (other threads mid-stream while the user views
   * something else) keep running silently; their persisted rows accumulate
   * in `slot.persistedRows`, which `selectThread` merges into the
   * screen's `messages` array on the next open of that thread.
   */
  const exchangeStore = new ExchangeStore();
  /**
   * Stable per-tab identifier used as the holder id for every
   * thread-response claim acquired by this screen. Different tabs of
   * the same user get different ids, so two tabs competing for the
   * same thread are visible to each other as separate holders.
   * `crypto.randomUUID` is universal in modern browsers; the fallback
   * is for the test environment where jsdom sometimes lacks it.
   */
  const holderId: string = (() => {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
      return crypto.randomUUID();
    }
    return `holder-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  })();
  /**
   * The slot for the thread the user is currently viewing, or null
   * when no thread is selected or nothing has ever been sent on it.
   * `peek` rather than `slotFor` so navigating into a thread doesn't
   * allocate a slot for it - allocation happens on first send. Every
   * UI surface that asks "is THIS view's exchange in flight?" reads
   * `activeSlot?.X`.
   */
  const activeSlot = $derived(
    activeThreadId ? exchangeStore.peek(activeThreadId) ?? null : null
  );
  /**
   * Screen-level synchronous guard for the pre-runExchange setup
   * window: when send() needs to await createThread or
   * materializeIfDraft to learn the real threadId, the slot's sending
   * flag isn't available yet to block a concurrent click. This flag
   * covers that gap. For existing threads the slot.sending check
   * inside send() catches the duplicate before this even matters.
   * Plain let, not $state - no template reads it.
   */
  let sendSetupInFlight = false;
  // Tick counter that drives a 1Hz reactive re-read of Date.now() while
  // the active slot is in a rate-limit wait, so the bubble's countdown
  // updates each second without rebinding the assistant render. The
  // interval is kept inside an $effect tied to the active slot's wait
  // field so it self-cleans when the wait ends.
  let rateLimitNowTick = $state(0);
  $effect(() => {
    if (!activeSlot || activeSlot.rateLimitWaitUntil === null) return;
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
    if (!activeSlot || activeSlot.rateLimitWaitUntil === null) return 0;
    void rateLimitNowTick;
    return Math.max(0, Math.ceil((activeSlot.rateLimitWaitUntil - Date.now()) / 1000));
  });

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

  // Topic-filter state. `selectedTopics` carries the user's current
  // checkbox selections in the drawer's topic dropdown - including the
  // `(untagged)` sentinel when active. `topicsVocabulary` is the
  // distinct list the background topics agent has assembled across
  // the user's threads; refreshed on drawer mount and after we see
  // the realtime subscription fire on a thread row (which is the
  // proxy we use for "the agent just tagged something"). Both start
  // empty - a brand-new account has nothing selected and an empty
  // vocabulary, and the dropdown still functions (it offers only
  // the sentinel until the worker catches up).
  let selectedTopics = $state<string[]>([]);
  let topicsVocabulary = $state<string[]>([]);

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

  // Tool timings live per-slot on `slot.toolTimings`. Each thread owns
  // its own ledger, so switching threads no longer wipes the previous
  // thread's pills - the slot keeps them through the visit and the
  // ToolCalls component reads them off the active slot. The slot's
  // `finalizePendingToolTimings` is called from runExchange's outer
  // finally to mark any startedAt-only entries errored, so a stream
  // that dies mid-tool doesn't leave a forever-spinning pill.
  /**
   * Live monotonic clock, driven by rAF while any tool is in flight on
   * the active slot and frozen when everything is idle. Drives the
   * live-duration pill in ToolCalls. Using performance.now() because
   * Date.now() is clamped on a 1ms boundary and can go backwards.
   */
  let nowMs = $state<number>(typeof performance !== 'undefined' ? performance.now() : 0);
  $effect(() => {
    if (!activeSlot) return;
    const pending = Object.values(activeSlot.toolTimings).some((t) => t.endedAt === undefined);
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
  // Error banner state. `retry` is populated only for transient failures
  // where re-firing the exact same request is meaningful (rate-limit so
  // far) — it re-runs the chat loop with the captured history so the
  // user doesn't have to retype. A fresh error assignment replaces any
  // earlier retry closure; the banner only ever owns one.
  type ChatError = { text: string; retry?: () => void };
  let error = $state<ChatError | null>(null);
  // abortCtl lives on the slot. The send button's disabled state reads
  // `activeSlot?.abortCtl` directly: while `activeSlot?.sending` is true, the
  // button acts as a stop button and needs to latch to disabled for the
  // brief window after abort() fires but before runExchange's finally
  // block nulls the controller. Slot fields are reactive, so the
  // template re-renders correctly when it flips back to null.

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

  /**
   * `true` while ANY thread's slot is mid-exchange. Wake-lock and the
   * re-acquire-on-visibility effect read this rather than `activeSlot`
   * so a backgrounded thread's stream still keeps the tab from
   * freezing - the user may be viewing a different conversation, but
   * the LLM is still working for them.
   */
  const anySlotSending = $derived.by(() =>
    exchangeStore.slots().some((s) => s.sending)
  );

  // Re-acquire after a page-hide/show cycle while any thread is still
  // streaming. The browser releases any held wake lock when the page
  // hides; without this effect, returning to the tab mid-stream would
  // leave the lock gone.
  $effect(() => {
    if (!anySlotSending) return;
    const handleVisibility = (): void => {
      if (document.visibilityState === 'visible' && anySlotSending && !activeLock) {
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

  // Drawer-tab return handling. The messages container + composer both
  // live inside {#if drawerTab === 'chats'}, so switching to recipes /
  // memories / wiki fully unmounts them. When the user comes back to
  // chats with the same thread still active, selectThread no-ops
  // (route.cid still matches activeThreadId), so the focus + post-load
  // scroll-snap it normally runs never fire. Two regressions follow:
  //
  //   1. The composer remounts unfocused - user stares at an inert
  //      textarea after returning to chats. Mobile is skipped for the
  //      same reason as in selectThread.
  //   2. The messages container remounts at scrollTop=0 - returning to
  //      a previously-scrolled thread lands the user at the top of the
  //      transcript instead of the newest message, breaking the
  //      "opening a conversation jumps to the end" UX.
  //
  // Both fire on the same prev != 'chats' -> 'chats' edge, so they
  // share one effect. prevTab === null skips the initial mount: the
  // selectThread path that ran during syncFromUrl already handled both.
  let prevDrawerTab: typeof drawerTab | null = null;
  $effect(() => {
    const tab = drawerTab;
    const prev = prevDrawerTab;
    prevDrawerTab = tab;
    if (prev === null) return;
    if (tab !== 'chats' || prev === 'chats') return;
    // Wait a tick for the {#if drawerTab === 'chats'} block to commit
    // the remounted composer + messages container before touching
    // either.
    void tick().then(() => {
      if (drawerTab !== 'chats') return;
      if (!composerIsMobile) composerEl?.focus();
      if (activeThreadId !== null && messages.length > 0 && messagesEl) {
        followBottom = true;
        pinBottomWhileSettling();
      }
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
        // If the topics column changed, the dropdown vocabulary may
        // need a refresh - the background topics agent just landed
        // a new tag on this thread, and it might be a new entry to
        // the per-user vocabulary. Compare arrays elementwise rather
        // than identity-wise because every realtime update materializes
        // a fresh array.
        const prevTopics = existing?.topics ?? [];
        const nextTopics = t.topics;
        const topicsChanged =
          prevTopics.length !== nextTopics.length ||
          prevTopics.some((p, i) => p !== nextTopics[i]);
        rebucketThread(t);
        if (topicsChanged) void refreshTopicsVocabulary();
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
        void refreshTopicsVocabulary();
      } else {
        drafts = [];
        recentThreads = [];
        olderThreads = [];
        archivedPage = [];
        topicsVocabulary = [];
        selectedTopics = [];
        // Sign-out: abort every in-flight exchange. Without this a
        // background chat-loop kept running until its next tool/round
        // tripped on the now-invalid session, which Venice surfaces as
        // an auth error in the LOGS rather than anywhere the now-
        // signed-out user can see.
        exchangeStore.disposeAll();
      }
    });
    void app.supabase.getSession().then((s) => {
      session = s;
      sessionLoaded = true;
      if (s) {
        void refreshThreads();
        void refreshSettings();
        void refreshTopicsVocabulary();
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
    // Cookbook + wiki change listeners. Fire when a recipe_* or
    // wiki_* tool call succeeds, so the drawer tab's list reflects a
    // model-driven save without the user having to reopen the tab.
    // We only reload when we've already loaded at least once - a
    // fresh unlock that never opened those tabs stays lazy.
    const offCookbook = onCookbookChange(onCookbookStoreChanged);
    const offWiki = onWikiChange(onWikiStoreChanged);
    return () => {
      unsubscribe();
      offCookbook();
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
      // Snapshot the topic filter at the start of the fetch so a
      // concurrent dropdown change doesn't land mid-flight. The
      // refetch-on-change $effect (below) will re-call us with the
      // new selection if that happens.
      const topicsAtFetch = [...selectedTopics];
      const [recent, older, archived] = await Promise.all([
        app.supabase.listRecentThreads(cutoff, topicsAtFetch),
        app.supabase.listOlderThreads({
          cutoff,
          cursor: null,
          pageSize: DEFAULT_THREAD_PAGE_SIZE,
          selectedTopics: topicsAtFetch,
        }),
        app.supabase.listArchivedThreads({
          cursor: null,
          pageSize: DEFAULT_THREAD_PAGE_SIZE,
          selectedTopics: topicsAtFetch,
        }),
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
        selectedTopics,
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
        selectedTopics,
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
   * Refresh the topic-filter dropdown vocabulary. Fired on drawer
   * mount (via the chats-tab activation $effect) and after a
   * realtime thread update lands - the agent's tagging shows up as
   * an UPDATE row, and that's enough signal that the vocabulary
   * might have grown by one. Best-effort: a failure leaves the
   * dropdown showing whatever vocabulary we had last; the user can
   * still filter and the next mount/event will retry.
   */
  async function refreshTopicsVocabulary(): Promise<void> {
    if (!app.supabase) return;
    try {
      topicsVocabulary = await app.supabase.listUserTopics();
    } catch {
      // see above
    }
  }

  /**
   * Refetch all three thread buckets when the topic filter changes.
   * Cursors are reset because the predicate now matches a different
   * row set - paginating from a cursor recorded against the prior
   * filter would skip rows that should appear at the top. Drops the
   * old cursors and lets the user re-scroll if they want more.
   *
   * Reading `selectedTopics` reactively is enough; `refreshThreads`
   * itself doesn't appear in the dependency graph (its identity is
   * stable) so this won't trigger on every other state change.
   */
  $effect(() => {
    // Track the dependency. Reading length + every entry is what
    // makes Svelte rerun on either a topic added or removed.
    const _trigger = selectedTopics.length + selectedTopics.join('|').length;
    void _trigger;
    if (!app.supabase) return;
    void refreshThreads();
  });

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
      titleManuallySet,
      // Pass the draft's toolbox selections through. The composer
      // toolbox button is live on drafts (see toggleToolboxManually),
      // so a user may have enabled one or more toolboxes before the
      // first send - they need to survive the draft-to-row swap.
      draft.toolboxes_enabled
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
    interruptedDraft = null;
    // Streaming state (streamingText, toolTimings, rate-limit wait,
    // sending flag, etc.) is NOT cleared here. Each thread owns its
    // own slot in `exchangeStore`; a thread the user navigated away
    // from mid-exchange keeps streaming in the background and its
    // bubble surfaces again when the user returns. The `activeSlot`
    // $derived above re-targets at the new thread's slot, which is
    // either null (no slot allocated) or a freshly-idle slot ready
    // for the next send.
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
      // Merge the listMessages snapshot with any rows the slot's chat-
      // loop persisted during the window between `messages = []` and
      // the fetch resolving. Race shape: user switches into a thread
      // whose background slot is mid-exchange; onAssistantPersisted
      // and onToolResultPersisted fire while the await is in flight,
      // pushing into slot.persistedRows. The snapshot may or may not
      // include those rows depending on when its underlying query
      // ran. mergeMessagesById de-dupes by id and orders by created_at
      // ascending (matching listMessages' own ORDER BY), so either
      // path lands the same final transcript. Empty buffer is fast-
      // pathed inside mergeMessagesById; non-streaming threads pay
      // nothing.
      const bufferedRows = exchangeStore.peek(id)?.persistedRows ?? [];
      messages = mergeMessagesById(fetched, bufferedRows);
      // Eager-cancel any pending ask_user sentinel left over from a
      // prior session. The chat-loop suspends without persisting the
      // priming state, and we can't restart inference from where it
      // left off across a page reload anyway, so a pending question
      // is treated as abandoned on (re)load - matching the standing
      // convention in conversation-recovery that incomplete tool
      // exchanges resolve to a cancellation rather than a hang.
      // Best-effort: a write failure leaves the sentinel in place,
      // the card renders pending, and the user can still submit (or
      // hitting send will cancel it on the new-send path). Fire-and-
      // forget so a slow Supabase doesn't block thread switching.
      void cancelPendingAskUser(id, 'abandoned_on_refresh').then(() => {
        // The cancel write also lives inside listMessages's recovery
        // shape - re-pull so the message order and any other state
        // the recovery pipeline touched lands consistently. Skipped
        // if the user has already navigated away.
        if (activeThreadId !== id) return;
        // No need to re-fetch the whole list - the in-memory patch
        // inside cancelPendingAskUser already updated the affected
        // row. The realtime echo will arrive separately and dedupe
        // by id.
      });
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
      //
      // Skipped while THIS thread has a live in-flight exchange: the
      // IDB draft we'd find is the one runExchange is currently
      // updating from another tab/window into this same view (the
      // user switched away mid-stream and came back). Treating that
      // as orphaned would surface the "previous response was
      // interrupted" banner while the response is, in fact, still
      // arriving - which the user reads as a stale/contradictory UI.
      // Slots persist across thread switches in Phase 2, so a peek
      // is enough to detect "we're the device producing this turn."
      interruptedDraft = null;
      const lastMsg = fetched.at(-1);
      if (lastMsg?.role === 'user' && !exchangeStore.peek(id)?.sending) {
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

  // Tick counter that drives a 5Hz reactive re-read of Date.now()
  // while an observer-side claim is live, so the
  // `respondingElsewhere` derivation below can detect TTL expiry
  // even when no realtime event arrives (the responding device
  // crashed mid-turn and stopped heartbeating). 5-second cadence is
  // plenty - the TTL is 60s and the responding device heartbeats
  // every 20s, so we just need to notice that updates have stopped
  // arriving and the stamped expiry has slipped into the past. No
  // tick is armed when the active thread has no observed claim, so
  // idle threads pay nothing.
  let claimNowTick = $state(0);
  $effect(() => {
    const t = currentThread;
    if (!t?.response_holder_id) return;
    if (t.response_holder_id === holderId) return;
    const id = window.setInterval(() => {
      claimNowTick = claimNowTick + 1;
    }, 5000);
    return () => window.clearInterval(id);
  });

  /**
   * `true` when the active thread has a live response claim held by
   * SOMEONE ELSE (a different tab of ours, or a different device).
   * Drives the composer's disabled state and an observer-side
   * "responding on another device" bubble. False on idle threads,
   * on threads we hold the claim for ourselves, and on threads whose
   * stamped expiry has slipped into the past (the holder crashed
   * mid-turn and stopped heartbeating).
   *
   * Reads `claimNowTick` so the TTL-expired transition re-runs the
   * derivation; the value isn't used in the math.
   */
  const respondingElsewhere = $derived.by(() => {
    void claimNowTick;
    const t = currentThread;
    if (!t) return false;
    if (!t.response_holder_id) return false;
    if (t.response_holder_id === holderId) return false;
    if (!t.response_claim_expires_at) return false;
    const expiry = Date.parse(t.response_claim_expires_at);
    if (Number.isNaN(expiry)) return false;
    return Date.now() < expiry;
  });

  /**
   * Safety-net refresh: when the active thread's response claim
   * transitions from foreign-held to released (the other device
   * just finished its turn), re-fetch the thread's message list to
   * reconcile against any realtime packets that may have been
   * dropped. The realtime subscription on `messages` is already
   * appending rows live as the responding device persists them, so
   * the diff should usually be empty - this just catches the edge
   * where the channel lost a packet under load or reconnected
   * after a transient drop.
   *
   * Tracks the prior (threadId, holder) pair so the effect fires
   * only on the genuine release transition. Switching between
   * threads does NOT trigger a refresh - if the user was viewing
   * thread A (foreign-held), then switches to thread B, the effect
   * re-runs but the prev-state's threadId no longer matches and we
   * fall through. Same posture for switching back to a thread
   * whose claim cleared while we were elsewhere: selectThread
   * already did a listMessages on entry, so a second fetch would
   * be wasted work. Our own claim's lifecycle is also skipped -
   * we have authoritative local state for our own turns.
   */
  let prevForeignClaim: { threadId: string; holderId: string } | null = null;
  $effect(() => {
    const t = currentThread;
    if (!t || !app.supabase) return;
    const isForeign =
      t.response_holder_id !== null &&
      t.response_holder_id !== holderId;
    const wasForeignOnSameThread =
      prevForeignClaim !== null && prevForeignClaim.threadId === t.id;
    prevForeignClaim = isForeign
      ? { threadId: t.id, holderId: t.response_holder_id as string }
      : null;
    if (!wasForeignOnSameThread || isForeign) return;
    // Foreign claim on THIS thread just cleared. Reconcile against
    // the canonical state. Guarded against thread switch mid-fetch
    // (activeThreadId changes can race the await).
    const threadId = t.id;
    const supabase = app.supabase;
    void (async () => {
      try {
        const fetched = await supabase.listMessages(threadId);
        if (activeThreadId !== threadId) return;
        const bufferedRows = exchangeStore.peek(threadId)?.persistedRows ?? [];
        messages = mergeMessagesById(fetched, bufferedRows);
      } catch (err) {
        // Best-effort: a failed reconciliation just leaves the
        // realtime-delivered state in place. The user can still
        // navigate away and back to force a full reload.
        log.warn('post-claim-release reconcile failed', err);
      }
    })();
  });

  // Active thread's cached intuition payload, coerced from the
  // jsonb column. Null on cold threads or shape drift; the modal
  // and the inline card both gate on this being non-null. Reactive
  // because patchThread() (used by onIntuitionUpdate) re-derives
  // currentThread, which re-runs this expression.
  const currentIntuitionPayload = $derived<IntuitionPayload | null>(
    currentThread ? coerceIntuitionPayload(currentThread.intuition_payload) : null
  );

  // Active thread's cached context-recall payload, coerced from the
  // jsonb column. Null on cold threads or shape drift; the pill and
  // modal both gate on this being non-null with a non-empty note.
  // Reactive because patchThread() (used by onContextRecallUpdate)
  // re-derives currentThread, which re-runs this expression.
  const currentContextRecallPayload = $derived<ContextRecallPayload | null>(
    currentThread
      ? coerceContextRecallPayload(currentThread.context_recall_payload)
      : null
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
  // Resolved gated-toolbox set for the current thread. The composer
  // toolbox button renders unconditionally (mirroring the model /
  // reasoning / verbosity pickers), so it needs a sensible default
  // when no thread is active or the thread is a draft - empty array,
  // since there's no user-level "default toolboxes" concept.
  const currentToolboxesEnabled = $derived<string[]>(
    currentThread?.toolboxes_enabled ?? []
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
      topics: [],
      response_holder_id: null,
      response_claim_expires_at: null,
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

    // Two-layer synchronous guard:
    //
    //   1. Per-thread: if the active thread already has an in-flight
    //      exchange (slot.sending true on its slot), refuse the click.
    //      Lets concurrent sends across different threads coexist while
    //      blocking a double-click on the same thread.
    //   2. Screen-level: `sendSetupInFlight` covers the brief window
    //      where threadId isn't known yet (no active thread, or an
    //      unmaterialized draft). Without this, a second click during
    //      the createThread / materializeIfDraft await would also pass
    //      the per-thread check (no slot exists yet) and both would
    //      mint a thread, leaving two rows in the drawer.
    //
    // We track `claimedSlot` so the finally can clear the sending flag
    // if anything between claim and runExchange-takeover throws. Once
    // runExchange is on the stack we null it out - runExchange owns the
    // flag's lifecycle from there.
    const knownThreadId = active && !active.isDraft ? active.id : null;
    if (knownThreadId) {
      const existingSlot = exchangeStore.peek(knownThreadId);
      if (existingSlot?.sending) return;
    }
    if (sendSetupInFlight) return;
    sendSetupInFlight = true;
    let claimedSlot: { sending: boolean } | null = null;
    if (knownThreadId) {
      claimedSlot = exchangeStore.slotFor(knownThreadId);
      claimedSlot.sending = true;
    }
    try {
      let threadId: string;
      if (!active) {
        // No thread selected - create one on the fly.
        const t = await app.supabase.createThread(DEFAULT_TITLE);
        rebucketThread(t);
        threadId = t.id;
        activeThreadId = t.id;
        setSessionThreadId(t.id);
        navigate({ cid: t.id }, { replace: true });
        claimedSlot = exchangeStore.slotFor(threadId);
        claimedSlot.sending = true;
      } else if (active.isDraft) {
        // First send on a draft - materialize it now, preserving any
        // model choice the user already made from the dropdown.
        const real = await materializeIfDraft(active);
        threadId = real.id;
        claimedSlot = exchangeStore.slotFor(threadId);
        claimedSlot.sending = true;
      } else {
        threadId = active.id;
      }

      // Snapshot the queued attachments and clear the composer chips.
      // Keeping a local copy means a late text-parser completion (if
      // we ever allow background adds) can't retroactively mutate the
      // message we just inserted.
      const sendAttachments = readyAttachments;
      composer = '';
      pendingAttachments = [];
      // Sending is an explicit "pay attention to the bottom" signal -
      // even if the user had scrolled up before hitting send, we want
      // their new message (and the impending streaming response) in view.
      followBottom = true;

      // Build the system-prompt preamble now, against the toggles the
      // user has set at send time. On retry (rate-limit refresh button)
      // we want the original prompts - capturing here, not inside
      // runExchange, pins them even if the user flips a toggle while
      // the banner is up.
      const systemMessages: { role: 'system'; content: string }[] = app.systemPrompts
        .filter((p) => activePromptIds.has(p.id) && p.body.trim().length > 0)
        .map((p) => ({ role: 'system' as const, content: p.body }));

      // Heal an interrupted-exchange tail before the new user turn
      // lands. listMessages added these synthetic rows in memory so
      // the wire shape was already valid for the prior reads; here we
      // make them real DB rows so the thread stays valid on every
      // future read. Best-effort: a persist failure logs and falls
      // through - the synthetic rows remain in memory for this session
      // and will retry on the next user send.
      try {
        await persistSyntheticRecovery(threadId);
      } catch (err) {
        log.warn('persistSyntheticRecovery failed', err);
      }

      // Cancel any pending ask_user before the new user message lands.
      // The user typed into the composer instead of picking an option;
      // per the design decision, that abandons the question and the
      // new message is processed as a normal user turn. The model sees
      // the cancellation marker + the new user message on its next
      // round and can choose to re-ask or move on.
      await cancelPendingAskUser(threadId, 'abandoned_on_new_send');

      let userMessageId: string;
      try {
        const userMsg = await app.supabase.addMessage(threadId, 'user', text);
        userMessageId = userMsg.id;
        // Persist attachment rows. Positional index matches the chip
        // order so the message list renders them the way the user
        // queued them. If the insert fails the user message is still
        // saved and the transcript reads as plain text - an
        // attachment-less send is recoverable; a missing user message
        // row is not.
        if (sendAttachments.length > 0) {
          const newRows: NewAttachment[] = sendAttachments.map((a, i) =>
            toNewAttachment(a, i)
          );
          try {
            const rows = await app.supabase.addAttachments(userMsg.id, newRows);
            userMsg.attachments = rows;
          } catch (err) {
            // Non-fatal: surface a warning but keep going. The user's
            // typed text still gets a reply - the attachments just
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
        // the user's row didn't land, so "retry" would mean "try
        // persist again," which is a different UX than "retry the LLM
        // call." Surface on the inline bubble so the failure shows up
        // in the transcript where the user expected their message to
        // land.
        log.error('send failed before exchange', err);
        const slot = exchangeStore.slotFor(threadId);
        slot.streamingError = { text: describeError(err) };
        return;
      }

      const freshThread = findThread(threadId);
      if (!freshThread) {
        error = { text: 'Thread disappeared before send.' };
        return;
      }
      const currentUserId = session?.user.id ?? freshThread.user_id;

      // Hand off to runExchange. Clear the claim reference so the
      // finally below doesn't flip sending false while runExchange is
      // running - runExchange's own finally manages the flag from here.
      claimedSlot = null;
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
    } finally {
      sendSetupInFlight = false;
      // Safety net: if a pre-runExchange await threw, the claim is
      // still ours - clear it so the slot doesn't stay stuck on
      // sending=true (which would block every future send to this
      // thread). The explicit return paths above also fall through
      // here with the claim intact, so this handles them too.
      if (claimedSlot) claimedSlot.sending = false;
    }
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
   * thread. Owns the `activeSlot?.sending` flag, the abort controller, the text
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
    // The slot for THIS thread's slot. Allocated on first send and
    // reused for re-runs (rate-limit retries park a closure that calls
    // runExchange again with the same ctx; same threadId -> same slot).
    // All handlers below write to slot.X; the active-thread view
    // observes them through `activeSlot` if and only if the user is
    // currently looking at this thread.
    const slot = exchangeStore.slotFor(ctx.threadId);
    // Reset slot to idle state at the start of every exchange so a
    // re-run on a slot whose previous turn left residual state
    // (persistedRows, half-cleared streaming buffers from an abort
    // mid-finally) starts clean. The sending flag is asserted again
    // below right after - reset() does NOT leave the slot in a
    // visible "not sending" state because no $effect fires between
    // these two statements.
    slot.reset();
    slot.sending = true;
    slot.abortCtl = new AbortController();
    // Cross-device claim. Acquired before any chat-loop work so a
    // contended thread (another tab or another device is already
    // responding) bails out without firing inference. The
    // coordinator heartbeats while the chat-loop runs; a decisive
    // loss (heartbeat RPC returns false because another device took
    // over) aborts our in-flight controller via the onLost callback,
    // and the catch below surfaces a "preempted" banner instead of
    // the silent stop a user-initiated abort produces.
    const claim = new ThreadClaimCoordinator(app.supabase, ctx.threadId, holderId);
    let claimAcquired = false;
    try {
      claimAcquired = await claim.acquire();
    } catch (err) {
      // Network failure on acquire. Surface as a streaming error
      // rather than silently bailing - the user clicked send and
      // deserves to know nothing happened.
      log.warn('thread response claim acquire failed', err);
      slot.streamingError = { text: 'Could not check responding-device status. Try again in a moment.' };
      slot.sending = false;
      slot.abortCtl = null;
      return;
    }
    if (!claimAcquired) {
      // Another device holds a live claim. Don't fire inference -
      // it would race the other device's persisted assistant row
      // and the atomic message-commit RPC would discard whichever
      // landed second anyway.
      slot.streamingError = {
        text: 'Another device is responding to this conversation. Wait for it to finish before sending here.',
      };
      slot.sending = false;
      slot.abortCtl = null;
      return;
    }
    claim.startHeartbeat(() => {
      // Decisive loss: another device took over. Stamp the slot's
      // abort reason so the catch knows to render the "preempted"
      // banner rather than treating this as a user-initiated stop.
      slot.abortReason = 'claim';
      slot.abortCtl?.abort();
    });
    // Timer id for the delayed-close on first content arrival. Local
    // to one exchange's lifetime - the handlers below close over it
    // and the outer finally clears it. Separated from the text-flush
    // timer because they have different lifetimes: the close fires
    // once per round, the flush fires on every delta.
    let reasoningCloseTimer = 0;
    error = null;
    // Clear any orphaned-draft recovery banner at the start of a new
    // exchange so the retry button doesn't persist alongside the new
    // stream. Tied to the active view rather than the slot - if the
    // user kicked off this exchange from a recovery banner click on
    // their currently-viewed thread, clearing here is correct; for a
    // background re-run on a non-active thread the banner isn't
    // showing anyway and the assignment is a no-op.
    interruptedDraft = null;

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

    // Throttle slot.streamingText updates to ~2Hz while the response
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
        slot.streamingText = pending;
        pending = null;
      }
      // Piggyback the IDB draft flush on every display flush (~500ms).
      // Best-effort: a write failure is swallowed so a broken IDB never
      // stalls the visible render path.
      void updateDraftText(ctx.threadId, slot.streamingText, slot.streamingReasoning).catch(() => {});
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

    // Auto-titling no longer fires from here. The auto-title worker
    // (src/lib/agents/auto_title/*) polls the threads table for rows
    // still on the 'New conversation' placeholder and titles them in
    // the background, surviving page closes / refreshes that the
    // old in-Chat fire-and-forget pipeline lost work to. The chat-
    // loop's metadata message stays silent about titles on round 1
    // (the worker owns naming there) and falls back to the loud nag
    // on round 2+ if the worker hasn't landed yet. See
    // docs/dev/auto-title.md for the full pipeline.

    try {
      let loopResult;
      // Auto-retry once on Venice 429 ("model is busy / overloaded").
      // The retry runs inside this inner try so `slot.sending` stays
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
          signal: slot.abortCtl!.signal,
          userMessageId: ctx.userMessageId,
          reasoningEffort: ctx.sendReasoning,
          disableThinking: ctx.sendDisableThinking,
          verbosity: ctx.sendVerbosity,
          emphasisMarkdown: ctx.sendEmphasis,
          userName: ctx.sendUserName,
          userLocation: ctx.sendUserLocation,
          displayTimezone: app.displayTimezone || null,
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
              // yielding to it. Guarded on slot.streamingContentStarted
              // so only the first text delta schedules it.
              if (!slot.streamingContentStarted) {
                slot.streamingContentStarted = true;
                if (slot.streamingReasoningOpen && slot.streamingReasoning.length > 0) {
                  reasoningCloseTimer = window.setTimeout(() => {
                    slot.streamingReasoningOpen = false;
                    reasoningCloseTimer = 0;
                  }, 600);
                }
              }
            },
            onReasoningUpdate: (t) => {
              slot.streamingReasoning = t;
              // Panel opens on the first reasoning delta so the user
              // watches the thinking stream in. Only before content
              // has started — once the answer is flowing, late
              // reasoning shouldn't pop the panel back open.
              if (!slot.streamingReasoningOpen && !slot.streamingContentStarted) {
                slot.streamingReasoningOpen = true;
              }
            },
            onAssistantPersisted: (msg) => {
              // Cancel any pending frame — the persisted row takes
              // over rendering and we don't want a stale flush to
              // replay the text into slot.streamingText after this.
              cancelPending();
              pending = null;
              // Always buffer into the slot so a thread-switch + return
              // can replay this row via mergeMessagesById; only mutate
              // the screen's `messages` if the user is currently
              // viewing this thread.
              slot.recordPersistedRow(msg);
              if (ctx.threadId === activeThreadId) {
                appendMessage(msg);
              }
              slot.streamingText = '';
              // Streaming companions reset per round so the NEXT
              // round starts with a clean slate. The persisted row
              // already carries reasoning for the round just finished,
              // so the UI keeps rendering it via the message store
              // rather than the streaming state.
              slot.streamingReasoning = '';
              slot.streamingReasoningOpen = false;
              slot.streamingContentStarted = false;
              if (reasoningCloseTimer !== 0) {
                window.clearTimeout(reasoningCloseTimer);
                reasoningCloseTimer = 0;
              }
            },
            onToolResultPersisted: (msg) => {
              slot.recordPersistedRow(msg);
              if (ctx.threadId === activeThreadId) {
                appendMessage(msg);
              }
            },
            onToolStart: (call) => {
              // performance.now() rather than Date.now() so the
              // elapsed math is monotonic — the user's clock jumping
              // (NTP sync, daylight saving) can't produce negative
              // durations.
              slot.toolTimings[call.id] = { startedAt: performance.now() };
            },
            onToolDone: (call) => {
              const t = slot.toolTimings[call.id];
              if (t) t.endedAt = performance.now();
            },
            onToolError: (call) => {
              const t = slot.toolTimings[call.id];
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
              // slow slot.
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
              // The RecallPill + Recall modal both derive from
              // currentContextRecallPayload, which re-derives off
              // currentThread; patching here lights the pill up the
              // moment a fresh recall lands rather than waiting for
              // the realtime echo. The patch also keeps the in-memory
              // row consistent with the persisted row so a delayed
              // echo doesn't overwrite the fresher value with null.
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
              slot.rateLimitWaitUntil = until;
              slot.rateLimitAttempt = attempt;
            },
            onRateLimitResolved: () => {
              // Sleep ended (or was cancelled). Clear the indicator
              // so the bubble swaps back to the normal streaming
              // spinner while the next attempt fires. If the retry
              // immediately rate-limits again, onRateLimitWait will
              // re-populate these for the next wait window.
              slot.rateLimitWaitUntil = null;
              slot.rateLimitAttempt = 0;
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
          slot.streamingText = pending;
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
        // The DB delete is correctness work - the old rows are stale
        // regardless of which thread the user is currently viewing -
        // so always fire it. The fade-out animation + `messages`
        // filter, by contrast, are visible only when the user is
        // actually looking at this thread; for a background exchange
        // we skip the animation and let the next selectThread reload
        // see the deleted rows missing from listMessages.
        const deletePromise = app.supabase.deleteMessages(idsToDelete);
        if (ctx.threadId === activeThreadId) {
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
          await new Promise<void>((resolve) => window.setTimeout(resolve, totalMs));
          const drop = new Set(idsToDelete);
          messages = messages.filter((m) => !drop.has(m.id));
          fadeOutDelays = {};
        }
        pendingDeleteIds = [];
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
        slot.streamingError = {
          text: 'This conversation was updated on another device while a response was generating. The response was discarded - refresh this thread to see the latest.',
        };
      }
      slot.streamingText = '';
      slot.streamingReasoning = '';
      slot.streamingReasoningOpen = false;
      slot.streamingContentStarted = false;
      // Belt-and-braces: the chat-loop's onRateLimitResolved already
      // clears the wait indicator at the end of every wait, but if a
      // round completes without firing it (e.g. a successful first
      // attempt) these stay at their initial values anyway. Resetting
      // here keeps the streaming state and the wait indicator on the
      // same lifecycle.
      slot.rateLimitWaitUntil = null;
      slot.rateLimitAttempt = 0;
      // Surface the completion to the notifications service: either
      // fires an OS notification (tab backgrounded + permission granted)
      // or sets an unread dot on the sidebar row. Skip on user-initiated
      // stop (they know they hit Stop), on a limit-without-text outcome
      // (no actual reply to report), and on conflict (nothing committed).
      //
      // Branches on awaitingUserAnswer: when the loop suspended on
      // ask_user, fire notifyAskUser with the question as the body
      // so a backgrounded tab gets a meaningful nudge instead of "your
      // reply is ready" (which would be misleading - the reply is
      // waiting on the USER, not the other way around). The pending
      // question card in the message list is the durable signal
      // regardless of whether the OS notification lands.
      if (!loopResult.interrupted && !loopResult.conflictDetected) {
        const threadForNotif = findThread(ctx.threadId);
        if (loopResult.awaitingUserAnswer) {
          notifyAskUser({
            threadId: ctx.threadId,
            title: threadForNotif?.title || 'Question for you',
            question: loopResult.awaitingUserAnswer.question,
            isActive: activeThreadId === ctx.threadId,
            onClick: (id) => {
              void selectThread(id);
            },
          });
        } else if (loopResult.finalText.length > 0) {
          notifyTurnComplete({
            threadId: ctx.threadId,
            title: threadForNotif?.title || 'New reply',
            isActive: activeThreadId === ctx.threadId,
            onClick: (id) => {
              void selectThread(id);
            },
          });
        }
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
        slot.abortCtl?.signal.aborted === true ||
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
      slot.streamingText = '';
      slot.streamingReasoning = '';
      slot.streamingReasoningOpen = false;
      slot.streamingContentStarted = false;
      // Same belt-and-braces reset as the success branch above - if
      // the loop blew up mid-wait the resolved handler still ran in
      // the chat-loop's finally, but if it failed before any wait
      // started these are already null and the assignment is a no-op.
      slot.rateLimitWaitUntil = null;
      slot.rateLimitAttempt = 0;
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
      // raise a banner at all - the stop was the intended outcome -
      // EXCEPT when abortReason is 'claim', meaning another device
      // took over our turn via the response-claim heartbeat. In that
      // case the user needs to know their turn was preempted, so we
      // surface a banner with no retry (the right move is to refresh
      // and see what the other device produced).
      if (isAbort) {
        if (slot.abortReason === 'claim') {
          slot.streamingError = {
            text: 'Another device took over this conversation. Refresh to see the latest.',
          };
        } else {
          slot.streamingError = null;
        }
        slot.abortReason = null;
      } else if (err instanceof VeniceError && err.kind === 'rate_limit') {
        slot.streamingError = {
          text: formatRateLimitMessage(err),
          retry: () => {
            void runExchange(ctx);
          },
        };
      } else {
        slot.streamingError = { text: describeError(err) };
      }
    } finally {
      // Release the cross-device claim before clearing screen state.
      // `release` swallows RPC errors and stops the heartbeat
      // unconditionally, so a sign-out / network failure here doesn't
      // throw out of the finally and corrupt the exchange's cleanup.
      await claim.release();
      // Finalize any tool timings that never got an endedAt. Runs
      // BEFORE clearing `sending` so the orphan markers land while
      // the slot still reads as in-flight; consumers that observe
      // both fields see the timings cleaned up by the time sending
      // flips false.
      slot.finalizePendingToolTimings();
      slot.sending = false;
      slot.abortCtl = null;
      // Wake lock: only release if no OTHER slot is still streaming.
      // Concurrent per-thread exchanges share the device's single
      // screen lock, and the user wants the tab kept awake as long
      // as anything is in flight.
      if (!exchangeStore.slots().some((s) => s.sending)) {
        releaseWakeLock();
      }
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
    if (activeSlot?.sending || !app.supabase || !app.venice || !interruptedDraft) return;
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
    if (activeSlot?.sending || !app.supabase || !app.venice) return;
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
    if (activeSlot?.sending || !app.supabase || !app.venice) return;
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
  // the stream aborts (activeSlot?.sending flips false), the next submit-modifier
  // Enter fires the draft the user typed while waiting.
  function onKeydown(e: KeyboardEvent): void {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey || e.shiftKey)) {
      e.preventDefault();
      if (activeSlot?.sending) {
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
   * to call repeatedly - once `activeSlot?.abortCtl` is nulled in runExchange's
   * finally block this is a no-op.
   */
  function stopStreaming(): void {
    activeSlot?.abortCtl?.abort();
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
  // (thread, recipe, memory, or wiki article) should dismiss it once the main
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
  // Scanner, then the whole bubble disappears when `activeSlot?.sending` flips),
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

  // Mobile-touch companion to onMessagesScroll. iOS Safari (and some
  // Android WebViews) batch or defer 'scroll' events during a finger-
  // down drag - scrollTop updates live on the element but the listener
  // doesn't fire until the touch ends or the browser decides to flush.
  // The visible symptom: the user drags up to read while a response
  // is streaming, but `followBottom` and `lastScrollTop` stay frozen
  // at the values from before the drag. When `onAssistantPersisted`
  // lands the persisted row, the discrete-mutations effect sees a
  // stale `followBottom=true` and calls `scrollToBottom`, which yanks
  // the view to the bottom of the just-finished response despite the
  // user's scroll-lock. Sampling on every touchmove keeps the state
  // fresh through the drag so the effect's gate reads the user's
  // actual position. Idempotent against extra fires - the handler
  // diffs newScrollTop against lastScrollTop and is a no-op when
  // they match (the user is touching but not scrolling).
  function onMessagesTouchMove(): void {
    onMessagesScroll();
  }

  // Defensive sample-and-disengage for the auto-scroll firing paths.
  // Same stale-state hazard as onMessagesTouchMove guards against,
  // re-checked at the moment we're about to scroll: if the live
  // scrollTop has dropped below lastScrollTop without a 'scroll' or
  // 'touchmove' event having fired in between (rare but possible on
  // mobile when the discrete effect runs in the same microtask as a
  // user drag), drop the lock so we don't fight the user's intent.
  //
  // Asymmetric on purpose - only catches scrollTop going backwards,
  // since scrollTop going forwards is either a programmatic scroll
  // (handled by the scroll-event path) or the user dragging toward
  // the bottom (will pick up via the scroll handler shortly).
  //
  // The `!isNearBottom` second gate distinguishes a stale user-drag
  // from a browser scroll-anchor adjustment: when the reasoning
  // panel above the viewport collapses while the user is riding
  // the bottom, `overflow-anchor: auto` shifts scrollTop down to
  // keep the visible content stable, but the user is still
  // effectively at the bottom. Disengaging the lock in that case
  // would silently break follow-bottom mid-stream. Treat the drop
  // as user intent only when the new position is actually away
  // from the bottom.
  function refreshFollowBottom(): void {
    const el = messagesEl;
    if (!el) return;
    if (el.scrollTop < lastScrollTop) {
      if (!isNearBottom(el)) followBottom = false;
      lastScrollTop = el.scrollTop;
    }
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
    // refreshFollowBottom guards against the mobile case where the
    // user dragged up without a 'scroll' event firing in time.
    refreshFollowBottom();
    if (activeSlot?.sending && followBottom) scrollToBottom(false);
  }

  function scheduleStreamScroll(): void {
    refreshFollowBottom();
    if (!activeSlot?.sending || !followBottom) {
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
  // Gated on `activeSlot?.sending` OR `respondingElsewhere` so the
  // view follows the bottom for both the locally-driven case (this
  // device is producing the response) and the cross-device case
  // (another device is producing it, rows arrive via the realtime
  // messages subscription). A late echo from an exchange that has
  // already ended falls past both gates and leaves the view alone -
  // the user has finished reading; we don't want a stray realtime
  // packet yanking them back to the bottom.
  //
  // Thread-load lands on the bottom via the explicit scrollToBottom
  // in loadMessages, not via this effect.
  $effect(() => {
    void messageBlocks;
    const el = messagesEl;
    if (!el) return;
    hasOverflow = el.scrollHeight > el.clientHeight + 1;
    cancelScrollTimers();
    // refreshFollowBottom: this effect fires synchronously off the
    // assistant-persist appendMessage, which on mobile can happen
    // while the user has a finger down dragging up to read - the
    // 'scroll' event from that drag may not have fired yet, so
    // followBottom can still read stale-true. Sampling scrollTop
    // here disengages the lock before the gate is read.
    refreshFollowBottom();
    if ((activeSlot?.sending || respondingElsewhere) && followBottom) {
      scrollToBottom(false);
    }
  });

  // Streaming deltas — debounced with a max-wait cap. Tracks both the
  // answer buffer (`activeSlot?.streamingText`) and the reasoning buffer
  // (`activeSlot?.streamingReasoning`) so the view follows the bottom of the
  // bubble while the thinking panel is growing, not just after the
  // answer starts. Also tracks `activeSlot?.streamingReasoningOpen`: the panel
  // opening or closing causes a vertical layout shift that should
  // scroll the view exactly the same way a token append would.
  // `activeSlot?.streamingText` toggling to '' at the end of a round also runs
  // through here; the follow-up messages effect (assistant persisted)
  // will cancel the pending timer and do the final snap-to-bottom,
  // so we don't need a special "stream ended" signal.
  $effect(() => {
    void activeSlot?.streamingText;
    void activeSlot?.streamingReasoning;
    void activeSlot?.streamingReasoningOpen;
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

  // Mobile-only diagnostic tray. A sibling wharf docked next to the
  // composer-wharf-trigger on the left of the composer-bar, carrying
  // the three diagnostic pill buttons (intuition / samskara mood /
  // bias profile). On desktop those pills live in the bottom-right
  // column inside .messages-wrap; on mobile that column collides with
  // the assistant response and burns reading space, so they move into
  // this drop-up instead. The CSS mirrors the existing left wharf -
  // hidden above 720px, rendered as a vertical icon column when open
  // above its trigger.
  let composerDiagWharfOpen = $state(false);

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
    composerDiagWharfOpen = false;
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
      !composerWharfOpen &&
      !composerDiagWharfOpen
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
    // on the column's bevel frame or gap should not. The diagnostic
    // wharf gets the same exemption via its `.composer-diag-wharf`
    // class.
    const tgt = e.target;
    if (
      tgt instanceof Element &&
      (tgt.closest('.composer-menu') ||
        tgt.closest('[aria-haspopup="true"]') ||
        tgt.closest('.composer-bar-left.wharf-open') ||
        tgt.closest('.composer-diag-wharf.wharf-open'))
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
      composerDiagWharfOpen ||
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
    | { kind: 'rename'; key: string; assistantId: string; title: string }
    // Rendered as an AskUserCard for an `ask_user` tool call. Three
    // states (pending / answered / abandoned) derive from the tool-
    // result row's content (see parseAskUserContent). `key` is the
    // tool_call_id, stable across renders so the #each loop doesn't
    // tear down the card on every messages mutation. `pendingContent`
    // is set when state==='pending'; `answeredContent` when it isn't.
    // We carry both shapes through the block rather than re-parsing
    // in the template because the pending question text is only on
    // the persisted sentinel - the answered shape doesn't echo it.
    | {
        kind: 'ask-user';
        key: string;
        assistantId: string;
        state: 'pending' | 'answered' | 'abandoned';
        question: string;
        options: { label: string; description: string }[];
        answeredContent: AskUserAnsweredContent | null;
      };

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
  // `ask_user` is suppressed from the standard tool-group card because
  // it has its own dedicated AskUserCard rendering below. The
  // tool_calls and tool-result rows still live in the message store
  // (and ship on the wire on the resumed round) - this is purely a
  // display filter so the question doesn't render as both a faceless
  // tool row and a question card.
  const HIDDEN_TOOL_NAMES = new Set(['toggle_tools', 'update_title', 'ask_user']);

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

  /**
   * Parse the `arguments` JSON string off an ask_user tool call into
   * the question + options shape the card needs. Defensive against
   * malformed JSON and partial wire payloads - returns null when the
   * args are unusable, in which case the block-builder skips emitting
   * an ask-user block for this call. The activity parameter that
   * dispatch.ts injects is ignored here; the card only needs the
   * question + options.
   */
  function parseAskUserCallArgs(
    raw: string
  ): { question: string; options: { label: string; description: string }[] } | null {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw || '{}');
    } catch {
      return null;
    }
    if (!parsed || typeof parsed !== 'object') return null;
    const obj = parsed as Record<string, unknown>;
    const question = typeof obj.question === 'string' ? obj.question.trim() : '';
    const rawOptions = Array.isArray(obj.options) ? obj.options : [];
    const options: { label: string; description: string }[] = [];
    for (const o of rawOptions) {
      if (!o || typeof o !== 'object') continue;
      const oo = o as Record<string, unknown>;
      if (typeof oo.label !== 'string' || typeof oo.description !== 'string') continue;
      const label = oo.label.trim();
      const description = oo.description.trim();
      if (!label || !description) continue;
      options.push({ label, description });
    }
    if (!question || options.length === 0) return null;
    return { question, options };
  }

  /**
   * Locate the unique pending ask_user tool row in the current
   * thread's messages, if any. Per the chat-loop's contract, at most
   * one such row exists at any time: a pending sentinel is written
   * when ask_user lands, and the next event either replaces its
   * content with an answer (user submitted) or with an abandonment
   * payload (refresh / new-send / sibling cancel). A new ask_user
   * cannot land until the previous one resolves because the loop is
   * suspended in between.
   */
  function findPendingAskUserRow(): {
    row: Message;
    toolCallId: string;
    question: string;
  } | null {
    for (const m of messages) {
      if (m.role !== 'tool' || !m.tool_call_id) continue;
      const parsed = parseAskUserContent(m.content);
      if (parsed && ASK_USER_PENDING_FLAG in parsed) {
        return {
          row: m,
          toolCallId: m.tool_call_id,
          question: (parsed as AskUserPendingContent).question,
        };
      }
    }
    return null;
  }

  /**
   * Write an abandonment payload over the pending sentinel and patch
   * the in-memory message. Best-effort: a write failure logs but
   * doesn't surface, because the alternative is blocking the user's
   * action (new send, refresh path) over a transient network blip -
   * the sentinel will get rewritten on the next try and the wire
   * shape stays valid either way.
   *
   * Used by:
   *   - selectThread's mount-time cleanup (via='abandoned_on_refresh')
   *   - send()'s pre-send cancel (via='abandoned_on_new_send')
   *
   * The model sees the abandonment as the resumed-round tool result
   * the next time runChatLoop fires; the `via` field tells it which
   * path led there so it can choose to re-ask or move on.
   */
  async function cancelPendingAskUser(
    threadId: string,
    via: AskUserVia
  ): Promise<void> {
    if (!app.supabase) return;
    const pending = findPendingAskUserRow();
    if (!pending) return;
    const newContent = buildAskUserAnswerContent(null, via);
    try {
      const updated = await app.supabase.updateToolMessageContent(
        threadId,
        pending.toolCallId,
        newContent
      );
      // Patch in-memory message so the AskUserCard immediately
      // re-renders in the 'abandoned' state instead of leaving a
      // stale pending card flashing past while the resumed loop
      // (if any) reads the persisted state.
      messages = messages.map((m) => (m.id === updated.id ? updated : m));
    } catch (err) {
      log.warn('cancelPendingAskUser failed', err);
    }
  }

  /**
   * True when the user is mid-submit on an AskUserCard. Disables the
   * card's chips/textarea during the brief window while we write the
   * answer and start the resumed runChatLoop. Falls back to false
   * after the resume settles (the AskUserCard is now in 'answered'
   * state and ignores the busy prop). One global flag is enough -
   * by invariant there is at most one pending ask_user at a time.
   */
  let askUserSubmitBusy = $state(false);

  /**
   * Submit handler for the active AskUserCard. Writes the answer
   * payload over the pending sentinel, patches the in-memory
   * message, then re-fires the chat-loop against the post-answer
   * history. The resumed turn carries the same userMessageId as the
   * original turn so the samskara substrate stub (which was skipped
   * on suspend) fires on the resumed completion paired with the
   * original user message - one substrate row per logical user turn,
   * regardless of how many suspend/resume cycles it took.
   */
  async function answerAskUser(
    toolCallId: string,
    answer: string,
    via: AskUserVia,
    optionIndex?: number
  ): Promise<void> {
    if (!app.supabase || !app.venice || !activeThreadId) return;
    if (askUserSubmitBusy) return;
    askUserSubmitBusy = true;
    try {
      const threadId = activeThreadId;
      const newContent = buildAskUserAnswerContent(answer, via, optionIndex);
      const updated = await app.supabase.updateToolMessageContent(
        threadId,
        toolCallId,
        newContent
      );
      messages = messages.map((m) => (m.id === updated.id ? updated : m));

      // Resume the chat-loop. Rebuild the exchange context from
      // current state - we may be on a fresh tab load with no
      // in-memory closure from the original send. The userMessageId
      // is the user message that opened the suspended turn, which
      // we recover by walking backward through messages from the
      // updated tool row.
      const userMessageId = findOpeningUserMessageIdForTail();
      if (!userMessageId) {
        log.warn('answerAskUser: could not locate opening user message');
        return;
      }
      const freshThread = findThread(threadId);
      if (!freshThread) return;
      const tier = resolveTier(freshThread.model ?? null, defaultTier);
      const tierSpec = TIERS[tier];
      const modelId = TIERS[tier].id;
      const sendReasoning: ReasoningEffort | undefined =
        tierSpec.supportsReasoning && !tierSpec.disableThinking
          ? resolveReasoningEffort(
              freshThread.reasoning_effort ?? null,
              defaultReasoning,
              tierSpec.defaultReasoningEffort
            )
          : undefined;
      const sendDisableThinking: boolean = tierSpec.disableThinking ?? false;
      const sendVerbosity: Verbosity = resolveVerbosity(
        freshThread.verbosity ?? null,
        defaultVerbosity
      );
      const systemMessages: { role: 'system'; content: string }[] = app.systemPrompts
        .filter((p) => activePromptIds.has(p.id) && p.body.trim().length > 0)
        .map((p) => ({ role: 'system' as const, content: p.body }));
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
        // Not used inside runExchange after the user-message write,
        // which the resume path skips entirely (no new user message
        // is created on resume - the answer is the trigger).
        originalText: '',
        userMessageId,
      });
    } finally {
      askUserSubmitBusy = false;
    }
  }

  /**
   * Walk backward through messages from the tail to find the most
   * recent role='user' message - the one that opened the currently-
   * suspended (or just-resumed) turn. Returns null if no user
   * message is present (cold thread), which means the resume cannot
   * proceed and the caller surfaces a warning.
   */
  function findOpeningUserMessageIdForTail(): string | null {
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i];
      if (m.role === 'user') return m.id;
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

        // Emit one ask-user block per `ask_user` call on this turn.
        // The question and options come from the call's arguments (the
        // model's original ask) so they survive into the answered
        // history view, which carries only the answer payload. The
        // tool-result row's content determines the state and the
        // answer envelope (if any).
        const askUserCalls = m.tool_calls.filter(
          (c) => c.function.name === 'ask_user'
        );
        for (const call of askUserCalls) {
          const args = parseAskUserCallArgs(call.function.arguments);
          if (!args) continue;
          const resultRow = resultsByCallId[call.id];
          const parsedResult = resultRow
            ? parseAskUserContent(resultRow.content)
            : null;
          let state: 'pending' | 'answered' | 'abandoned';
          let answeredContent: AskUserAnsweredContent | null = null;
          if (!parsedResult) {
            // Result row not yet persisted; the chat-loop is in the
            // sub-second window between assistant-row write and
            // tool-row write. Skip the block until the row lands -
            // emitting a card with no backing row would make submit
            // operations target a non-existent tool_call_id.
            continue;
          }
          if (ASK_USER_PENDING_FLAG in parsedResult) {
            state = 'pending';
          } else {
            answeredContent = parsedResult;
            const via = parsedResult.via;
            if (via === 'option' || via === 'free_form') {
              state = 'answered';
            } else {
              state = 'abandoned';
            }
          }
          blocks.push({
            kind: 'ask-user',
            key: call.id,
            assistantId: m.id,
            state,
            question: args.question,
            options: args.options,
            answeredContent,
          });
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
   * Suppressed while `activeSlot?.sending` is true (a turn in progress has the
   * same DB tail mid-exchange and we don't want the banner fighting
   * the live streaming bubble), and while `activeSlot?.streamingError` is set
   * (its own banner already offers a retry where applicable, and
   * double-rendering two retry prompts for the same failure is
   * noisy).
   */
  const incompleteTurnTail = $derived.by<Message | null>(() => {
    if (activeSlot?.sending) return null;
    if (activeSlot?.streamingError) return null;
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
   * server state.
   *
   * Same fresh-session / draft pattern as setTier: with no active
   * thread, auto-create a draft so the choice has somewhere to land.
   * On a draft, the toggle rides along in memory and gets persisted
   * when the draft materializes (see `materializeIfDraft`, which
   * passes `toolboxes_enabled` through to the inserted row). Without
   * the auto-create + draft-local path, the toolbox button had no
   * useful behaviour on fresh sessions or new conversations.
   */
  async function toggleToolboxManually(toolboxName: string): Promise<void> {
    if (!app.supabase) return;
    if (!currentThread) {
      await newThread();
      if (!currentThread) return;
    }
    const threadId = currentThread.id;
    const current = currentThread.toolboxes_enabled;
    const next = current.includes(toolboxName)
      ? current.filter((n) => n !== toolboxName)
      : [...current, toolboxName];
    // Optimistic: update locally first so the checkbox feels instant.
    patchThread(threadId, { toolboxes_enabled: next });
    // For drafts, the choice rides in memory and gets persisted on
    // materialization. Don't create a Supabase row just to record a
    // toolbox flip.
    if (currentThread.isDraft) return;
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
        selectedTopics,
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
          selectedTopics,
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
            selectedTopics,
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
             RecipeList / MemoryList. The four tabs all read the same:
             tabs, search, list - no rule line between them. The
             topbar's `.new-thread-mini` icon (visible on every
             viewport, not just mobile) is the primary new-thread
             affordance. -->
        <div class="thread-list-controls">
          <input
            type="search"
            name="thread-search"
            class="sidebar-search-input"
            placeholder="Search conversations"
            aria-label="Search conversations"
            bind:value={searchQuery}
            onkeydown={onSearchKey}
          />
        </div>
        <!-- Topic-filter row. Sits below the search input and above
             the thread list. The pill row inside TopicsFilter grows
             downward on multi-selections, pushing the conversation
             rows down rather than overflowing. -->
        <div class="thread-list-topics">
          <TopicsFilter
            topics={topicsVocabulary}
            selected={selectedTopics}
            onChange={(next) => (selectedTopics = next)}
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
               that the wiki / recipe sidebars also use, so
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
            <BucketHeader label="Recent" />
            {#each drafts as t (t.id)}
              {@render threadRow(t)}
            {/each}
            {#each recentThreads as t (t.id)}
              {@render threadRow(t)}
            {/each}
          {/if}

          <!-- Older: paginated 25 at a time. Header hides when there's
               nothing to show so a fresh account doesn't see an empty
               "Older" stub above its first real thread. The dinkus
               sits above this header only when Recent rendered, so a
               drawer that opens straight onto Older (cold-load or a
               wiped Recent bucket) doesn't get an orphan ornament. -->
          {#if olderThreads.length > 0 || olderHasMore}
            <BucketHeader
              label="Older"
              flourish={drafts.length > 0 || recentThreads.length > 0}
            />
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
               recipes - the Memories tab IS the entry
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
          <!-- Wiki changelog jump. The changelog is the wiki tab's
               default surface (rendered inline by Wiki.svelte when
               no article is selected and the librarian isn't open),
               so this button asks the panel to land there - a one-
               click "back to wiki home" affordance from the article
               view OR the librarian page. Routed through a
               $bindable trigger (rather than a direct navigate())
               because the librarian's open/closed state lives in
               Wiki.svelte; closing it requires touching that local
               flag alongside the route. Sits next to the librarian
               button so the two "audit the wiki agent's behavior"
               affordances (run it now / see what it has been
               doing) live side by side. -->
          <button
            class="secondary icon-btn wiki-changelog-btn"
            onclick={() => (wikiChangelogTrigger = true)}
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
          <!-- Wiki skipped-threads jump. Mirrors the changelog button
               next door: a one-click affordance to land on a sibling
               page inside the wiki tab. Feather "alert-triangle"
               reads as "something needs your attention" without
               overcommitting to an error tone - the panel itself is
               often empty, and a skip is a "FYI" not a "broken"
               state. -->
          <button
            class="secondary icon-btn wiki-skipped-btn"
            onclick={() => (wikiSkippedTrigger = true)}
            title="Wiki skipped threads"
            aria-label="Wiki skipped threads"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                 stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
              <line x1="12" y1="9" x2="12" y2="13" />
              <line x1="12" y1="17" x2="12.01" y2="17" />
            </svg>
          </button>
          <div class="title-wrap">
            <span class="title-btn panel-section-label">Wiki</span>
          </div>
        {/if}
        <!-- Logs drawer toggle. Lives outside the per-tab branches so it
             appears as the trailing top-bar action on chats, recipes,
             memories, and wiki alike - the in-app log viewer is a
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
        <!--
          ontouchmove: not a user-facing interaction - the handler is a
          scroll-state sampler that re-runs onMessagesScroll during a
          touch drag because mobile browsers (iOS Safari especially)
          can defer 'scroll' events until the finger lifts. The div is
          already scrollable via overflow:auto and doesn't take on any
          new interactive semantics here, so suppressing the a11y rule
          is appropriate rather than slapping a role on it.
        -->
        <!-- svelte-ignore a11y_no_static_element_interactions -->
        <div
          class="messages"
          bind:this={messagesEl}
          onscroll={onMessagesScroll}
          ontouchmove={onMessagesTouchMove}
        >
          {#each messageBlocks as block (
            block.kind === 'plain'
              ? block.message.id
              : block.kind === 'rename'
              ? `rename:${block.key}`
              : block.kind === 'ask-user'
              ? `ask-user:${block.key}`
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
                  disabled={pendingDeleteSet.has(block.assistant.id) || (activeSlot?.sending ?? false)}
                  onRegenerate={() => { void regenerateFrom(block.assistant.id); }}
                >
                  <ToolCalls
                    calls={block.assistant.tool_calls ?? []}
                    resultsByCallId={block.resultsByCallId}
                    timings={activeSlot?.toolTimings ?? {}}
                    nowMs={nowMs}
                    sending={activeSlot?.sending ?? false}
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
            {:else if block.kind === 'ask-user'}
              <!-- ask_user clarifying question. Renders inside an
                   assistant bubble so the visual weight matches the
                   surrounding model-driven content (the question came
                   from the model, the affordance to answer is its
                   dedicated affordance). The card itself owns the
                   three-state render (pending / answered / abandoned)
                   and all the mobile-first wrap rules - see
                   AskUserCard.svelte for the layout discipline. -->
              <div class="msg assistant ask-user-host">
                <AskUserCard
                  mode={block.state}
                  question={block.question}
                  options={block.options}
                  answer={block.answeredContent}
                  busy={askUserSubmitBusy}
                  onSubmit={(answer, via, optionIndex) =>
                    answerAskUser(block.key, answer, via, optionIndex)}
                />
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
                  disabled={pendingDeleteSet.has(block.message.id) || activeSlot?.sending}
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
                 retry lives only on `activeSlot?.streamingError.retry` and doesn't
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
                  disabled={activeSlot?.sending}
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
                  disabled={activeSlot?.sending}
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
          {#if activeSlot?.streamingError}
            <!-- Canonical error surface for chat send-path failures.
                 Rendered in the transcript where the streaming output
                 was, so it follows the conversation flow regardless
                 of what the composer or keyboard are doing. Carries
                 the retry button when `activeSlot?.streamingError.retry` is set
                 (rate-limit errors, currently). The `.error-bar`
                 banner above the composer is reserved for non-
                 exchange errors (attachment upload, thread rename,
                 pre-send guards) that don't have a transcript anchor.
                 Dismissed by the next successful send (or manually
                 via the X). -->
            <div class="msg assistant msg-error" role="alert">
              <div class="msg-error-body">
                <span class="msg-error-icon" aria-hidden="true">!</span>
                <div class="msg-error-text">{activeSlot?.streamingError.text}</div>
                {#if activeSlot?.streamingError.retry}
                  <button
                    type="button"
                    class="secondary icon-btn msg-error-retry"
                    onclick={activeSlot?.streamingError.retry}
                    disabled={activeSlot?.sending}
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
                  onclick={() => { if (activeSlot) activeSlot.streamingError = null; }}
                  aria-label="Dismiss error"
                  title="Dismiss"
                >×</button>
              </div>
            </div>
          {/if}
          <!-- Streaming bubble visibility is gated on `activeSlot?.sending` alone -
               the master flag for "chat loop is running". This
               guarantees the KITT Scanner inside stays on screen for
               the ENTIRE response cycle: from the moment the user hits
               send, through every reasoning + content delta, across
               every tool round (model assembles a tool call, tools
               execute, next round opens, text streams in again), and
               only winks out when the chat loop finally closes after
               the terminal round's `data: [DONE]`. Earlier shapes
               OR'd in `activeSlot?.streamingText || activeSlot?.streamingReasoning` defensively;
               that read as "is there content" rather than "is the
               turn alive" and made the bubble's lifetime ambiguous to
               anyone reading it. Both buffers are cleared by
               onAssistantPersisted at the close of every round (so
               the bubble collapses back to a Scanner-only card while
               tools execute or the next round is being opened) and
               the runExchange success/error paths clear them both
               before `activeSlot?.sending = false` runs in finally - so dropping
               them from the condition can't shorten the visible
               window, only document the intent. -->
          {#if activeSlot && activeSlot.sending}
            <!-- activeSlot is non-null inside this block (the outer
                 condition guarantees it), so bindings can address its
                 fields directly without optional-chaining. -->
            <div class="msg assistant">
              <!-- Live reasoning panel. Open when `streamingReasoningOpen`
                   is true; flipped on by the first reasoning delta and
                   flipped off 600ms after the first content delta (see
                   the onTextUpdate / onReasoningUpdate handlers). The
                   duration is slightly longer than on replayed rows to
                   sell the close as a deliberate hand-off to the
                   answer below. -->
              <ReasoningPanel
                reasoning={activeSlot.streamingReasoning}
                bind:open={activeSlot.streamingReasoningOpen}
                duration={320}
              />
              {#if activeSlot.streamingText}
                <!-- Live markdown render of the in-progress buffer. The
                     onTextUpdate handler throttles writes to ~4Hz (see
                     FLUSH_MS in send()), so marked + DOMPurify +
                     highlight.js only re-parse the growing string a few
                     times per second. Unclosed fences / bold / math
                     resolve themselves as more deltas arrive; once the
                     stream ends the persisted message rerenders through
                     this same <Markdown> path. -->
                <Markdown content={activeSlot.streamingText} />
              {/if}
              <!-- Continuous "still working" signal for the entire
                   window between "user hit send" and the chat loop
                   actually closing - including gaps that aren't
                   emitting any deltas (model has finished reasoning
                   and is assembling a tool call; tools are executing
                   between rounds; round just ended, next round about
                   to start; final round persisted but post-loop
                   bookkeeping like refreshThreads is still running).
                   Stays visible AFTER activeSlot?.streamingText starts arriving
                   too: a single round can emit text deltas and then
                   switch to tool_call deltas within the same
                   assistant message, and once the text stops flowing
                   the bubble otherwise reads as "done responding"
                   even though the model is still building a tool
                   call on the wire. Cleared only when `activeSlot?.sending` flips
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
              {#if activeSlot.rateLimitWaitUntil !== null}
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
                    Waiting on Venice (attempt {activeSlot.rateLimitAttempt})
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
          {#if respondingElsewhere}
            <!-- Observer-side bubble: another tab or device holds the
                 response claim on this thread. We don't have the
                 streaming deltas (those are local to the responding
                 device's chat-loop), but we do want a visible signal
                 that something is happening so the user understands
                 why their composer is disabled and why messages are
                 about to start appearing. The Scanner is the same
                 "still working" cue the local streaming bubble uses,
                 so the visual language is consistent across the two
                 cases. The persisted assistant row will arrive via
                 the realtime subscription on `messages` when the
                 responding device commits it. -->
            <div class="msg assistant" role="status" aria-live="polite">
              <div class="thinking">
                <Scanner label="Responding on another device" />
              </div>
            </div>
          {/if}
          {#if messages.length === 0 && !activeSlot?.streamingText && !activeSlot?.sending && !respondingElsewhere}
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
        <BiasPill />
        <RecallPill payload={currentContextRecallPayload} />
      </div>
      {#if error}
        <div class="error-bar">
          <p class="error">{error.text}</p>
          {#if error.retry}
            <button
              type="button"
              class="secondary icon-btn error-retry"
              onclick={error.retry}
              disabled={activeSlot?.sending}
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
          <!-- The textarea stays enabled while `activeSlot?.sending` is true so the
               user can draft their next message while the current reply
               is still streaming. The send button transforms into a
               stop button in the same state (see the .send-btn block
               below) and a submit-modifier Enter aborts rather than
               sends (see onKeydown) - so any input landing here during
               a stream is a draft for the *next* turn, not something
               that auto-fires when the current stream completes. -->
          <textarea
            name="composer"
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
              : respondingElsewhere
                ? 'Another device is responding. Wait for it to finish.'
                : sendHint}
            disabled={currentThread?.archived || respondingElsewhere}
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
              onclick={() => {
                // Close any other open menu before toggling - the diag
                // wharf now opens above its trigger right next to this
                // one, and we want at most one drop-up on screen.
                const next = !composerWharfOpen;
                closeMenus();
                composerWharfOpen = next;
              }}
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
            <!-- Mobile-only diagnostic wharf, docked right next to the
                 composer-wharf-trigger so both drop-ups originate from
                 the same neighborhood on the left. The .composer-diag-
                 anchor wrapper is a local positioning context so the
                 .composer-diag-wharf panel pops up directly above its
                 trigger; without the wrapper the panel would anchor to
                 .composer-bar and float off-center. Hidden on desktop -
                 the pills live in the bottom-right column inside
                 .messages-wrap there - and on mobile that column
                 collides with readability so the pills move here. -->
            <div class="composer-diag-anchor">
              <button
                type="button"
                class="secondary icon-btn composer-diag-trigger"
                class:open={composerDiagWharfOpen}
                onclick={() => {
                  const next = !composerDiagWharfOpen;
                  closeMenus();
                  composerDiagWharfOpen = next;
                }}
                title="Diagnostics menu"
                aria-label="Diagnostics menu"
                aria-haspopup="true"
                aria-expanded={composerDiagWharfOpen}
                aria-controls="composer-diag-wharf"
              >
                <!-- Three vertical dots, distinct from the adjacent
                     wharf's 3x3 grid so the two affordances read as
                     separate concerns at a glance. -->
                <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"
                     aria-hidden="true">
                  <circle cx="12" cy="5" r="1.8" />
                  <circle cx="12" cy="12" r="1.8" />
                  <circle cx="12" cy="19" r="1.8" />
                </svg>
              </button>

              <!-- Drop-up panel with the three diagnostic buttons.
                   Hidden when the wharf is closed (CSS gates on
                   .wharf-open); rendered as a vertical column
                   anchored above the trigger via the .composer-diag-
                   anchor positioning context. Buttons close the wharf
                   on click via the shared closeMenus helper. -->
              <div
                id="composer-diag-wharf"
                class="composer-diag-wharf"
                class:wharf-open={composerDiagWharfOpen}
              >
                <button
                  type="button"
                  class="diag-tile"
                  disabled={currentIntuitionPayload === null}
                  title={currentIntuitionPayload !== null
                    ? 'Intuition - perception, drives, synthesis'
                    : 'Intuition - no data for this conversation yet'}
                  aria-label={currentIntuitionPayload !== null
                    ? 'Open intuition diagnostics'
                    : 'Intuition diagnostics (no data yet)'}
                  onclick={() => {
                    closeMenus();
                    if (currentIntuitionPayload !== null) {
                      navigate({ modal: 'intuition' });
                    }
                  }}
                >
                  <span class="emoji" aria-hidden="true">&#x1F9E0;</span>
                </button>
                <button
                  type="button"
                  class="diag-tile"
                  disabled={route.cid === null}
                  title={route.cid !== null
                    ? (moodState.current
                        ? `feelin' ${valenceToMoodLabel(moodState.current.valence, moodState.current.confidence)} - open Samskara diagnostics`
                        : 'Samskara diagnostics - no mood data yet')
                    : 'Samskara - no conversation selected'}
                  aria-label={route.cid !== null
                    ? 'Open Samskara diagnostics'
                    : 'Samskara diagnostics (no conversation selected)'}
                  onclick={() => {
                    closeMenus();
                    if (route.cid !== null) navigate({ modal: 'samskara' });
                  }}
                >
                  <span class="emoji" aria-hidden="true">
                    {moodState.current
                      ? valenceToEmoji(moodState.current.valence, moodState.current.confidence)
                      : '\u{1F4A4}'}
                  </span>
                </button>
                <button
                  type="button"
                  class="diag-tile"
                  title="Bias profile - patterns observed across past conversations"
                  aria-label="Open bias profile diagnostics"
                  onclick={() => {
                    closeMenus();
                    navigate({ modal: 'bias-profile' });
                  }}
                >
                  <span class="emoji" aria-hidden="true">&#x1F4C8;</span>
                </button>
                <button
                  type="button"
                  class="diag-tile"
                  disabled={currentContextRecallPayload === null ||
                    currentContextRecallPayload.note.trim().length === 0}
                  title={currentContextRecallPayload !== null &&
                    currentContextRecallPayload.note.trim().length > 0
                    ? 'Recall - what Nak remembered before the next reply'
                    : 'Recall - no data for this conversation yet'}
                  aria-label={currentContextRecallPayload !== null &&
                    currentContextRecallPayload.note.trim().length > 0
                    ? 'Open recall diagnostics'
                    : 'Recall diagnostics (no data yet)'}
                  onclick={() => {
                    closeMenus();
                    if (
                      currentContextRecallPayload !== null &&
                      currentContextRecallPayload.note.trim().length > 0
                    ) {
                      navigate({ modal: 'recall' });
                    }
                  }}
                >
                  <span class="emoji" aria-hidden="true">&#x1F4A1;</span>
                </button>
              </div>
            </div>

            <div class="composer-bar-left" id="composer-wharf" class:wharf-open={composerWharfOpen}>
              <!-- Toolbox popover: each gated toolbox is an independent
                   on/off. Badge shows how many are on for this thread.
                   Pulses on LLM-initiated flips via .flash (see CSS).
                   Sits first in the row because toolbox choice is the
                   most load-bearing decision on this toolbar - cost and
                   capability pivot on it. Renders unconditionally - even
                   with no active thread, or on a draft, the user can
                   pre-enable toolboxes for the conversation they're
                   about to start. `toggleToolboxManually` auto-creates
                   a draft on first toggle so the choice has somewhere
                   to land; the draft carries `toolboxes_enabled` through
                   `materializeIfDraft` to the persisted row on first
                   send. Same pattern as the model / reasoning /
                   verbosity pickers below. Gating on
                   `currentThread && !currentThread.isDraft` previously
                   hid the button on any fresh session or new
                   conversation, leaving no entry point to the toolbox
                   surface on desktop. -->
              <button
                type="button"
                class="secondary toolbox-btn"
                class:on={currentToolboxesEnabled.length > 0}
                class:flash={toolboxFlash}
                onclick={() => {
                  modelMenuOpen = false;
                  reasoningMenuOpen = false;
                  verbosityMenuOpen = false;
                  promptsMenuOpen = false;
                  composerWharfOpen = false;
                  toolboxMenuOpen = !toolboxMenuOpen;
                }}
                title={currentToolboxesEnabled.length > 0
                  ? `Toolboxes: ${currentToolboxesEnabled.join(', ')}`
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
                {#if currentToolboxesEnabled.length > 0}
                  <span class="badge" aria-hidden="true"
                    >{currentToolboxesEnabled.length}</span
                  >
                {/if}
              </button>

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
                disabled={activeSlot?.sending ||
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
                 the handler branches on `activeSlot?.sending`. While activeSlot?.sending, the
                 disabled rules that gate the send path (empty composer,
                 archived thread) are intentionally ignored - stop
                 must always be clickable once a response is in flight,
                 regardless of what the user has typed next. -->
            <button
              class="send-btn"
              class:is-stopping={activeSlot?.sending}
              onclick={activeSlot?.sending ? stopStreaming : send}
              disabled={activeSlot?.sending
                ? activeSlot?.abortCtl === null
                : (composer.trim().length === 0 && pendingAttachments.length === 0) ||
                  currentThread?.archived ||
                  respondingElsewhere}
              title={activeSlot?.sending
                ? 'Stop response'
                : respondingElsewhere
                  ? 'Another device is responding to this conversation'
                  : currentThread?.archived
                    ? 'Archived — restore to continue'
                    : 'Send'}
              aria-label={activeSlot?.sending ? 'Stop response' : 'Send'}
            >
              {#if activeSlot?.sending}
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

            {#if toolboxMenuOpen}
              <div class="composer-menu composer-menu-left" role="menu">
                <div class="menu-header">Toolboxes for this conversation</div>
                {#each GATED_TOOLBOX_META as tb (tb.name)}
                  <label class="menu-item">
                    <input
                      type="checkbox"
                      checked={(currentThread?.toolboxes_enabled ?? []).includes(tb.name)}
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
      {:else if drawerTab === 'memories'}
        <!-- Memories panel. Same shape as Cookbook: inline,
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
             update" all happen inline on the article. Two $bindable
             trigger props wire the top-bar buttons to the panel:
             `triggerLibrarianRun` for the sparkles button (opens the
             librarian confirmation strip), `triggerChangelogView` for
             the clock button (closes the librarian if open and
             clears wiki_article_id so the changelog renders). -->
        {#if WikiComp}
          <WikiComp
            bind:triggerLibrarianRun={wikiLibrarianTrigger}
            bind:triggerChangelogView={wikiChangelogTrigger}
            bind:triggerSkippedView={wikiSkippedTrigger}
          />
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
  {#if showBiasProfile && BiasProfileComp}
    <BiasProfileComp onClose={() => navigate({ modal: null })} />
  {/if}
  {#if showRecall && RecallComp}
    <RecallComp
      onClose={() => navigate({ modal: null })}
      threads={loadedThreads}
    />
  {/if}
  <!-- Cookbook, Memories, and Wiki now render inline in the main
       panel (drawerTab === 'recipes' / 'memories' / 'wiki') rather
       than as modals. -->
{/if}
