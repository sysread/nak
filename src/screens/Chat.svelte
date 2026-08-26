<script lang="ts">
  /*
   * The main screen. Three concerns stacked top-to-bottom:
   *
   *   top-bar   — hamburger, title (inline renameable), model-profile picker
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
   *   - The composer picker pins a model profile per thread
   *     (threads.model holds the profile id).
   *   - Picking the profile that matches the user's default clears the
   *     pin (writes null) so the thread keeps tracking default
   *     changes — see setProfile().
   */
  import { onMount, tick } from 'svelte';
  import { fade } from 'svelte/transition';
  import type { Session } from '@supabase/supabase-js';
  import {
    app,
    applyServerSettings,
    resetForSignOut,
    setPriceCaps,
    setModelFeatureRejections,
  } from '$lib/state.svelte';
  import {
    notifications,
    notifyTurnComplete,
    notifyAskUser,
    markThreadRead,
  } from '$lib/notifications.svelte';
  import { clearSessionThreadId, getSessionThreadId, setSessionThreadId } from '$lib/session';
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
    type TopicVocabulary,
  } from '$lib/supabase';
  import { runChatLoop, toVeniceMessage } from '$lib/chat/loop';
  import { withForkPointMarker } from '$lib/chat/prompt-assembly';
  import { slopNoticeCopy } from '$lib/ui/slop-notice';
  import CopyButton from '../components/CopyButton.svelte';
  import { ExchangeStore, mergeMessagesById } from '$lib/exchange/exchange-store.svelte';
  import type { ExchangeSlot } from '$lib/exchange/exchange-slot.svelte';
  import { ThreadClaimCoordinator } from '$lib/exchange/thread-claim-coordinator';
  import { resolveHolderId } from '$lib/exchange/holder-id';
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
    compressImage,
    formatBytes,
    isConsumableBy,
    isImageMimeType,
    MAX_ATTACHMENTS_PER_MESSAGE,
    MAX_MESSAGE_AGGREGATE_BYTES,
    toNewAttachment,
    validateFile,
    type LocalAttachment,
  } from '$lib/attachments';
  import {
    isPdfMimeType,
    renderPdfPages,
    type PdfRenderResult,
  } from '$lib/pdf-pages';
  import { chipStatus, totalAttachmentBytes } from '$lib/ui/composer-attachments';
  import {
    VENICE_EMBEDDING_MODEL,
    agentModel,
    defaultModelProfile,
    padEmbeddingForStorage,
    profileModelSpec,
    resolveModelProfile,
    thinkingWireForProfile,
    type ModelProfile,
    type ModelSpec,
    type ReasoningEffort,
    type ThinkingLevel,
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
  type DigestPanelComponent = typeof import('../components/DigestPanel.svelte').default;
  type MemoriesComponent = typeof import('./Memories.svelte').default;
  type WikiComponent = typeof import('./Wiki.svelte').default;
  type LibraryComponent = typeof import('./Library.svelte').default;
  type SamskarasComponent = typeof import('./Samskaras.svelte').default;
  type SettingsComponent = typeof import('./Settings.svelte').default;
  type HelpComponent = typeof import('./Help.svelte').default;
  type IntuitionComponent = typeof import('./Intuition.svelte').default;
  type SamskaraMoodComponent = typeof import('./SamskaraMood.svelte').default;
  type BiasProfileComponent = typeof import('./BiasProfile.svelte').default;
  type IntentsComponent = typeof import('./Intents.svelte').default;
  type RecallComponent = typeof import('./Recall.svelte').default;
  import WikiList from '../components/WikiList.svelte';
  import SamskaraBrowseList from '../components/SamskaraBrowseList.svelte';
  import LibraryList from '../components/LibraryList.svelte';
  import ArtifactsList from '../components/ArtifactsList.svelte';
  import DiagnosticPills from '../components/DiagnosticPills.svelte';
  import OfflineBanner from '../components/OfflineBanner.svelte';
  import SamskaraMoodSync from '../components/SamskaraMoodSync.svelte';
  import TopicsFilter from '../components/TopicsFilter.svelte';
  import BucketHeader from '../components/BucketHeader.svelte';
  import {
    cookbook,
    loadRecipes,
  } from '$lib/cookbook-store.svelte';
  import { onCookbookChange, emitCookbookChange } from '$lib/cookbook-events';
  import { emitGroceryChange } from '$lib/grocery-events';
  import {
    memoriesStore,
    runMemoriesSearch,
  } from '$lib/memories-store.svelte';
  import {
    wikiStore,
    runWikiSearch,
  } from '$lib/wiki-store.svelte';
  import { onWikiChange, emitWikiChange, emitWikiRecordChange } from '$lib/wiki-events';
  import { initOfflineStatus, syncOfflineCache } from '$lib/offline-sync.svelte';
  import {
    wikiLibrarianLease,
    memoryLibrarianLease,
    wikiLibrarianOutcome,
    memoryLibrarianOutcome,
  } from '$lib/agents/inflight-lease.svelte';
  import { emitMemoryChange } from '$lib/memory-events';
  import {
    documentStore,
    runDocumentSearch,
  } from '$lib/documents-store.svelte';
  import {
    artifactStore,
    loadArtifactsFirstPage,
  } from '$lib/artifacts-store.svelte';
  import { onDocumentChange } from '$lib/document-events';
  import { moodState } from '$lib/samskara/mood.svelte';
  import {
    bandIndexFor,
    columnFor,
    notifySamskaraMint,
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
  import {
    appendContextRecallHistory,
    buildUserMessageByRound,
    shouldRetainDisplaced,
  } from '$lib/ui/recall';
  import { formatMessageStamp } from '$lib/ui/message-timestamp';
  import { coerceSecondThoughts } from '$lib/ui/second-thoughts';
  import { buildMcpToolboxes, mcpToolboxMetaItems } from '$lib/ui/mcp';
  import {
    classifyIncompleteTurnTail,
    isReasoningOnlyStall,
    isCutOffPartialText,
  } from '$lib/ui/incomplete-turn';
  import { selectRecoveryBanner, recoveryBannerSource } from '$lib/ui/recovery-banner';
  import { streamLikelyInFlight } from '$lib/ui/stream-inflight';
  import {
    describeError,
    formatRateLimitMessage,
    headingFor,
    parseLastError,
  } from '$lib/ui/last-error';
  import { buildMessageBlocks, findOpeningUserMessageIdForTail } from '$lib/ui/message-blocks';
  import {
    bucketFor,
    insertByUpdatedAtDesc,
    mergeByUpdatedAtDesc,
    mergeServerThreadList,
    sortsAheadOfCursor,
  } from '$lib/ui/thread-buckets';
  import {
    buildUserRoundByMessageId,
    groupFiresByUserRound,
  } from '$lib/ui/cohort-panel';
  import {
    isMacPlatform,
    newThreadButtonState,
    rateLimitRemainingSeconds,
    sendHintLabel,
  } from '$lib/ui/chat-screen';
  import { computeRegenerateRangeIds, persistedRowIds } from '$lib/ui/regenerate';
  import { computeDeleteFromRangeIds } from '$lib/ui/message-delete';
  import { findDraftMessage } from '$lib/ui/draft-message';
  import {
    canForkAtMessage,
    computeForkRangeIds,
    deleteForkAnchor,
    deleteFromTitle,
    regenerateTitle,
    sharedRowIds,
  } from '$lib/ui/fork';
  import {
    orderedSubconsciousRows,
    subconsciousLabel,
  } from '$lib/ui/subconscious-status';
  import { streamingCardHasContent } from '$lib/ui/streaming-bubble';
  import {
    sendButtonState,
    shouldDrainQueue,
    queuedHeadline,
    queuedAttachmentSummary,
  } from '$lib/ui/message-queue';
  import {
    reasoningShouldCollapse,
    reasoningElapsedPill,
    reasoningCharPill,
  } from '$lib/ui/reasoning-panel';
  import { verbosityRejectedForModel } from '$lib/ui/model-profiles';
  import AssistantBody from '../components/AssistantBody.svelte';
  import Markdown from '../components/Markdown.svelte';
  import ReasoningPanel from '../components/ReasoningPanel.svelte';
  import ReasoningPicker from '../components/ReasoningPicker.svelte';
  import VerbosityPicker from '../components/VerbosityPicker.svelte';
  import Scanner from '../components/Scanner.svelte';
  import ToolCalls from '../components/ToolCalls.svelte';
  import GeneratedImageCard from '../components/GeneratedImageCard.svelte';
  import {
    buildAskUserAnswerContent,
    findPendingAskUserRow,
    type AskUserVia,
  } from '$lib/ask-user';
  import MessageAttachments from '../components/MessageAttachments.svelte';
  import TopBarActions from '../components/TopBarActions.svelte';
  // ExtractedTextDrawer + LogsDrawer are toggled overlays - the
  // user has to deliberately open them via a button or an
  // attachment-text affordance, so their content only matters
  // after that first interaction. Lazy-loaded; the chunk fetches
  // on first open. See the lazy-component block below for the
  // shared pattern.
  type ExtractedTextDrawerComponent =
    typeof import('../components/ExtractedTextDrawer.svelte').default;
  type LogsDrawerComponent = typeof import('../components/LogsDrawer.svelte').default;
  // Chat-surface companions lazy-loaded for the same reason as the
  // drawers above: each is conditionally rendered (drawer tabs,
  // expanded cohort panel, ask_user tool call) or late-firing
  // (SamskaraToasts seeds from its own DB query on mount, so a
  // post-first-paint load misses nothing). All five together carry
  // ~19 kB gz of weight out of the main bundle.
  type RecipeListComponent = typeof import('../components/RecipeList.svelte').default;
  type GroceryListComponent = typeof import('../components/GroceryList.svelte').default;
  type GroceriesComponent = typeof import('./Groceries.svelte').default;
  type MemoryListComponent = typeof import('../components/MemoryList.svelte').default;
  type CohortPanelComponent = typeof import('../components/CohortPanel.svelte').default;
  type AskUserCardComponent = typeof import('../components/AskUserCard.svelte').default;
  import { extractedTextDrawer } from '$lib/extractedTextDrawer.svelte';
  import { logsDrawer, createLogger, appendFromEdge } from '$lib/logger.svelte';
  import { downloadText } from '$lib/download';
  import { buildTranscriptMarkdown, canExportTranscript, transcriptExportFilename } from '$lib/ui/transcript-export';

  const log = createLogger('chat');
  import { VeniceError, StreamDisconnectedError, cancelStream, awaitStreamSettled, type VeniceMessage } from '$lib/venice';

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
  const showIntuition = $derived(route.modal === 'intuition');
  const showSamskaraMood = $derived(route.modal === 'samskara-mood');
  const showBiasProfile = $derived(route.modal === 'bias-profile');
  const showIntents = $derived(route.modal === 'intents');
  const showRecall = $derived(route.modal === 'recall');

  // Lazy components. Each holds the loaded constructor in $state
  // (cached after first import) and an $effect that fires the
  // dynamic import the first time the visibility flag flips on.
  // The render-site `{#if show* && Comp}` guard renders nothing
  // until the chunk lands - visible as a tiny first-open latency,
  // invisible thereafter.
  let ExtractedTextDrawerComp: ExtractedTextDrawerComponent | null = $state(null);
  let LogsDrawerComp: LogsDrawerComponent | null = $state(null);
  let RecipeListComp: RecipeListComponent | null = $state(null);
  let GroceryListComp: GroceryListComponent | null = $state(null);
  let GroceriesComp: GroceriesComponent | null = $state(null);
  let MemoryListComp: MemoryListComponent | null = $state(null);
  let CohortPanelComp: CohortPanelComponent | null = $state(null);
  let AskUserCardComp: AskUserCardComponent | null = $state(null);
  let AuthComp: AuthComponent | null = $state(null);
  let CookbookComp: CookbookComponent | null = $state(null);
  let DigestPanelComp: DigestPanelComponent | null = $state(null);
  let MemoriesComp: MemoriesComponent | null = $state(null);
  let WikiComp: WikiComponent | null = $state(null);
  let LibraryComp: LibraryComponent | null = $state(null);
  let SamskarasComp: SamskarasComponent | null = $state(null);
  let SettingsComp: SettingsComponent | null = $state(null);
  let HelpComp: HelpComponent | null = $state(null);
  let IntuitionComp: IntuitionComponent | null = $state(null);
  let SamskaraMoodComp: SamskaraMoodComponent | null = $state(null);
  let BiasProfileComp: BiasProfileComponent | null = $state(null);
  let IntentsComp: IntentsComponent | null = $state(null);
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
    if (route.digest && !DigestPanelComp) {
      void import('../components/DigestPanel.svelte').then(
        (m) => (DigestPanelComp = m.default)
      );
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
    if (drawerTab === 'library' && !LibraryComp) {
      void import('./Library.svelte').then((m) => (LibraryComp = m.default));
    }
    if (drawerTab === 'samskara' && !SamskarasComp) {
      void import('./Samskaras.svelte').then((m) => (SamskarasComp = m.default));
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
    if (showIntuition && !IntuitionComp) {
      void import('./Intuition.svelte').then((m) => (IntuitionComp = m.default));
    }
    if (showSamskaraMood && !SamskaraMoodComp) {
      void import('./SamskaraMood.svelte').then((m) => (SamskaraMoodComp = m.default));
    }
  });
  $effect(() => {
    if (showBiasProfile && !BiasProfileComp) {
      void import('./BiasProfile.svelte').then((m) => (BiasProfileComp = m.default));
    }
  });
  $effect(() => {
    if (showIntents && !IntentsComp) {
      void import('./Intents.svelte').then((m) => (IntentsComp = m.default));
    }
  });
  $effect(() => {
    if (showRecall && !RecallComp) {
      void import('./Recall.svelte').then((m) => (RecallComp = m.default));
    }
  });
  $effect(() => {
    if (drawerTab === 'recipes' && !RecipeListComp) {
      void import('../components/RecipeList.svelte').then(
        (m) => (RecipeListComp = m.default)
      );
    }
  });
  $effect(() => {
    if (drawerTab === 'groceries' && !GroceryListComp) {
      void import('../components/GroceryList.svelte').then(
        (m) => (GroceryListComp = m.default)
      );
    }
    if (drawerTab === 'groceries' && !GroceriesComp) {
      void import('./Groceries.svelte').then((m) => (GroceriesComp = m.default));
    }
  });
  $effect(() => {
    if (drawerTab === 'memories' && !MemoryListComp) {
      void import('../components/MemoryList.svelte').then(
        (m) => (MemoryListComp = m.default)
      );
    }
  });
  // Cohort panels are collapsed by default; the first expand-click on
  // any message triggers the chunk fetch. Subsequent panels for other
  // messages reuse the cached module.
  $effect(() => {
    if (expandedCohortPanels.size > 0 && !CohortPanelComp) {
      void import('../components/CohortPanel.svelte').then(
        (m) => (CohortPanelComp = m.default)
      );
    }
  });
  // ask_user is rare - most threads never see it. Load on demand when
  // an ask_user block first appears in the rendered transcript.
  $effect(() => {
    if (
      !AskUserCardComp &&
      messageBlocks.some((b) => b.kind === 'ask-user')
    ) {
      void import('../components/AskUserCard.svelte').then(
        (m) => (AskUserCardComp = m.default)
      );
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

  // Trigger flag for the Samskara top-bar Overview button. The surface
  // it reaches is GLOBAL (per-user, not per-samskara), which is why it
  // lives on the top row rather than as sub-nav next to the per-samskara
  // Corpus detail (where it would read as belonging to one instinct).
  // Overview is the tab's default landing page - the always-on compound
  // summary stacked above corpus-wide pipeline health. Clears any
  // selected samskara. Routed through Samskaras.svelte (which owns the
  // sub-view state) via a $bindable trigger, same shape as the wiki
  // top-bar buttons.
  let samskaraOverviewTrigger = $state(false);

  // Trigger flags for the memory librarian top-bar buttons. Two
  // separate buttons because the user might want to run one pass
  // without the other (deep-sleep is the cosine-similarity sweep;
  // rem is the conversation-batched associative pass). Same
  // $bindable pattern as the wiki librarian trigger.
  let deepSleepTrigger = $state(false);
  let remTrigger = $state(false);
  // Trigger flag for the Memories "changelog" top-bar button - the
  // leftmost action, ahead of the two librarian-pass buttons. Flips the
  // panel back to its changelog default surface (deselects the open
  // memory, dismisses a finished librarian strip). Same $bindable
  // pattern as the wiki changelog button.
  let memoriesChangelogTrigger = $state(false);
  /**
   * Sidebar drawer tab. Backed by `route.drawer` - absent in the URL
   * means "chats" (the default). 'recipes' and 'memories' render
   * their own list in place of the thread list. Tab switches use
   * replaceState so a tab flip doesn't fill history with UI-chrome
   * entries.
   */
  const drawerTab = $derived<
    'chats' | 'groceries' | 'recipes' | 'memories' | 'wiki' | 'library' | 'artifacts' | 'samskara'
  >(route.drawer ?? 'chats');
  // Recipe and memory search/listing state has moved to the
  // RecipeList / MemoryList sidebar components.

  // Groceries drawer tab. Unlike the sibling tabs there is no gated
  // fetch here: the Groceries panel refetches unconditionally on
  // every mount (see Groceries.svelte - a loaded-gate would freeze
  // the module-level store against writes made while the tab was
  // closed), and the panel mounts whenever this tab is active.
  function onPickGroceriesTab(): void {
    navigate({ drawer: 'groceries' }, { replace: true });
  }

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
      void runMemoriesSearch(app.supabase);
    }
  }

  // Wiki drawer tab. Same lazy-load shape as memories - WikiList's
  // $effect fires the first search via the shared `wikiStore`, but
  // kicking it on tab-pick lets a deep-linked panel land on a non-empty
  // listing.
  function onPickWikiTab(): void {
    navigate({ drawer: 'wiki' }, { replace: true });
    if (app.supabase && !wikiStore.loaded && !wikiStore.loading) {
      void runWikiSearch(app.supabase);
    }
  }

  // Library drawer tab. Same lazy-load shape as wiki - LibraryList's $effect
  // fires the first search via the shared `documentStore`, but kicking it on
  // tab-pick lets a deep-linked panel land on a non-empty listing.
  function onPickLibraryTab(): void {
    navigate({ drawer: 'library' }, { replace: true });
    if (app.supabase && !documentStore.loaded && !documentStore.loading) {
      void runDocumentSearch(app.supabase);
    }
  }

  // Artifacts drawer tab. Like the library tab - kick the first load on
  // pick so the listing is populated immediately; the $effect below covers
  // a direct ?drawer=artifacts landing.
  function onPickArtifactsTab(): void {
    navigate({ drawer: 'artifacts' }, { replace: true });
    if (app.supabase && !artifactStore.loaded && !artifactStore.loading) {
      void loadArtifactsFirstPage(app.supabase);
    }
  }

  // Samskara diagnostics tab. The SamskaraBrowseList sidebar loads its
  // own corpus on mount (its tier/sort/query effects fire once the
  // component renders), so this only has to flip the route - whether the
  // user clicks the tab or lands on ?drawer=samskara directly, mounting
  // the list is what triggers the fetch.
  function onPickSamskaraTab(): void {
    navigate({ drawer: 'samskara' }, { replace: true });
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
    void runMemoriesSearch(app.supabase);
  });

  // Parallel for the wiki tab. Same `loaded`-gate rationale - an
  // account with zero articles would re-fire the load forever
  // otherwise.
  $effect(() => {
    if (route.drawer !== 'wiki') return;
    if (!app.supabase) return;
    if (wikiStore.loaded || wikiStore.loading) return;
    void runWikiSearch(app.supabase);
  });

  // Parallel for the library tab. Same `loaded`-gate rationale - a cold
  // Library would re-fire the load forever otherwise.
  $effect(() => {
    if (route.drawer !== 'library') return;
    if (!app.supabase) return;
    if (documentStore.loaded || documentStore.loading) return;
    void runDocumentSearch(app.supabase);
  });

  // Parallel for the artifacts tab. Same `loaded`-gate rationale - an
  // account with zero attachments would re-fire the load forever otherwise.
  $effect(() => {
    if (route.drawer !== 'artifacts') return;
    if (!app.supabase) return;
    if (artifactStore.loaded || artifactStore.loading) return;
    void loadArtifactsFirstPage(app.supabase);
  });

  // Wiki cross-surface change channel. The chat-side wiki_* tool calls
  // and the autonomous wiki worker both fire WIKI_CHANGE_EVENT after a
  // write; refresh the drawer's listing so the new/updated row shows
  // up without the user navigating away and back.
  function onWikiStoreChanged(): void {
    if (!app.supabase) return;
    if (!wikiStore.loaded) return;
    void runWikiSearch(app.supabase);
  }

  // Library cross-surface change channel. The chat-side doc_* tool calls and
  // the Library panel's own uploads/edits/deletes fire DOCUMENT_CHANGE_EVENT;
  // refresh the drawer listing so the change shows without navigating away.
  function onDocumentStoreChanged(): void {
    if (!app.supabase) return;
    if (!documentStore.loaded) return;
    void runDocumentSearch(app.supabase);
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

  // Final reasoning header pills (elapsed-ms + char count) captured per
  // assistant message at persist time, keyed by message id. The pills the
  // user watched while the answer streamed live on the streaming bubble;
  // once the row persists, the bubble is replaced by the persisted card
  // (AssistantBody), which has no live timing to read. This map carries
  // the frozen values across that handoff so the pills stay put for as
  // long as the thread is loaded. In-memory only - never written to
  // Supabase - so a cold reopen (state not in memory) renders the bare
  // header, same elision as the tool-duration pills. Populated only for
  // the active thread (the one whose streaming bubble actually showed the
  // pills), so a background completion the user never watched doesn't
  // sprout pills on first view.
  let reasoningPillsById = $state<Record<string, { elapsed: string | null; chars: string | null }>>({});

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

  // Frontend-only history of context-recall injections, keyed by thread
  // id. Each entry is the payload that was displaced when a fresher one
  // landed via the chat-loop's onContextRecallUpdate callback. The
  // currently-active payload still lives on the thread row itself (and
  // therefore in the database); this Map only carries the previously-
  // injected ones so the Recall modal can show them in descending order
  // alongside the current one. Lost on full page reload by design - the
  // user opted into in-memory retention, not persistence. Next-state
  // computation for the Map lives in src/lib/ui/recall.ts; the Svelte
  // wire-up here is just "compute then reassign for reactivity."
  let contextRecallHistory = $state<Map<string, ContextRecallPayload[]>>(
    new Map()
  );

  function toggleCohortPanel(userMessageId: string): void {
    const next = new Set(expandedCohortPanels);
    if (next.has(userMessageId)) next.delete(userMessageId);
    else next.add(userMessageId);
    expandedCohortPanels = next;
  }

  // Anchor the inline cohort panels: message id -> 1-based user round
  // (same counting rule the chat loop persists on samskara_fires at
  // fire time), and user round -> that round's fires. Both walks live
  // in $lib/ui/cohort-panel; these sites are the rune wire-up.
  const userRoundByMessageId: Map<string, number> = $derived(
    buildUserRoundByMessageId(messages)
  );

  const firesByUserRound: Map<number, SamskaraFireDiagnosticRow[]> = $derived(
    groupFiresByUserRound(cohortFires)
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

  // The fork-and-edit flow creates a fork with a draft user message
  // (status='draft') and loads the draft text into the composer. On
  // send, the draft is promoted (status cleared, content updated) and
  // the completion runs normally. This id tracks which draft row the
  // composer is editing so send() knows to promote rather than insert.
  // Null when the composer is in normal (non-draft) mode.
  let pendingDraftId = $state<string | null>(null);

  // Reconnection: when the user navigates to a thread that has a draft
  // row (from a previous fork-and-edit that they abandoned), load the
  // draft text into the composer and set pendingDraftId so the next
  // send promotes the draft instead of inserting a new message.
  //
  // Runs on messages change, not on activeThreadId change directly,
  // because selectThread clears messages to [] before the async fetch
  // resolves - the draft only appears once the fetch lands. The guard
  // on composer length prevents wiping the user's in-progress edits
  // when the effect re-runs for an unrelated messages update (e.g. a
  // realtime INSERT).
  $effect(() => {
    // Track the dependency on messages.
    void messages.length;
    if (pendingDraftId) return;
    const draft = findDraftMessage(messages);
    if (!draft) return;
    // Only pre-populate when the composer is empty - the user may
    // already be typing.
    if (composer.length > 0) return;
    composer = draft.content;
    pendingDraftId = draft.id;
  });

  // Id of the thread's latest live assistant row - the only one that
  // gets a second-thoughts refinement button, since a refinement
  // appends at the transcript tail and must reconsider the last answer,
  // not a mid-thread one. Skips rows greyed for regenerate-from-here.
  // Mirrors the find-last-assistant walk `findLastAssistantTimestamp`
  // does for the datetime anchor.
  const latestAssistantId = $derived.by((): string | null => {
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      const m = messages[i];
      if (m.role === 'assistant' && !pendingDeleteSet.has(m.id)) return m.id;
    }
    return null;
  });
  /**
   * Hover-preview of the regenerate range. Populated while the user
   * hovers (or focuses) a message's Regenerate button; cleared on
   * leave. Mirrors `pendingDeleteIds` semantically - same id list, same
   * Set lookup, same .regen-target class - but is purely transient
   * UI affordance: never persists across a click, never affects the
   * disabled-button gating, never reaches the chat-loop. The render
   * sites OR this set with pendingDeleteSet so the user sees the red
   * border on every row that would be replaced before committing.
   */
  let hoverRegenerateIds = $state<string[]>([]);
  const hoverRegenerateSet = $derived(new Set(hoverRegenerateIds));

  /**
   * Set the hover-preview range for a given assistant message id.
   * Wired to the Regenerate button's mouseenter + focus handlers.
   * Skipped while a turn is sending - the button is already disabled
   * in that state and painting the preview would be misleading.
   */
  function previewRegenerateFrom(assistantMessageId: string): void {
    if (activeSlot?.sending) return;
    hoverRegenerateIds = computeRegenerateRangeIds(messages, assistantMessageId);
  }

  function clearRegeneratePreview(): void {
    if (hoverRegenerateIds.length > 0) hoverRegenerateIds = [];
  }

  /**
   * Fork-point message ids of the ACTIVE thread's child forks (hidden
   * children included - see listChildForkPointIds). Feeds the
   * shared-region test that switches delete-from-here and regenerate
   * tooltips to their "continues in a new fork" copy. The cache is
   * best-effort: loaded when a thread is opened, extended by realtime
   * fork INSERTs, and only ever drives tooltip copy - the click paths
   * re-fetch fresh state before deciding destructive vs edit-fork, so
   * a stale cache can never cause a wrong edit.
   */
  let childForkPointIds = $state<Set<string>>(new Set());
  const sharedRowSet = $derived(
    activeThreadId
      ? sharedRowIds(messages, activeThreadId, childForkPointIds)
      : new Set<string>()
  );

  async function refreshChildForkPoints(threadId: string): Promise<void> {
    if (!app.supabase) return;
    try {
      const ids = await app.supabase.listChildForkPointIds(threadId);
      // The user may have hopped threads during the await.
      if (activeThreadId === threadId) childForkPointIds = new Set(ids);
    } catch {
      // Tooltip-only cache: the click paths re-fetch and surface their
      // own errors, so a failed prefetch just leaves the default copy.
    }
  }

  /**
   * Hover-preview for a message card's Fork button, riding the same
   * channel (and the same .regen-target outline) as the regenerate
   * and delete-from previews. The semantic differs - the outlined
   * rows are the ones the fork LEAVES BEHIND, not rows about to be
   * deleted - and the button tooltip carries that difference. Skipped
   * mid-send for the same reason as previewRegenerateFrom: the button
   * is disabled then, and painting a preview under a disabled button
   * would be misleading.
   */
  function previewForkFrom(messageId: string): void {
    if (activeSlot?.sending) return;
    hoverRegenerateIds = computeForkRangeIds(messages, messageId);
  }
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
   * Stable per-device holder id for every thread-response claim this
   * screen acquires. A localStorage UUID that survives refresh, app-
   * update reload, and browser restart - so the chat-loop's stale claim
   * from before a refresh reads as ours, not as "another device is
   * responding", and the user's retry resumes the turn instead of
   * failing for the 60s TTL. Device-level (not per-tab) on purpose: see
   * `src/lib/exchange/holder-id.ts` for why, the two-tab trade-off, and
   * the storage-unavailable fallback.
   */
  const holderId: string = resolveHolderId();
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
  // doesn't enter the math (the primitive reads the wall clock).
  const rateLimitRemainingSec = $derived.by(() => {
    void rateLimitNowTick;
    return rateLimitRemainingSeconds(
      activeSlot?.rateLimitWaitUntil ?? null,
      Date.now()
    );
  });

  // Subconscious-priming checklist rows for the active slot, in stable
  // fire -> intuition -> recall order, each carrying its running/done
  // status. Empty array when no slot or nothing has fired; the template
  // renders the checklist only while the slot hasn't dismissed it.
  const subconsciousRows = $derived(
    activeSlot ? orderedSubconsciousRows(activeSlot.subconsciousStatus) : []
  );

  // Whether the streaming response card has anything to show this frame
  // (reasoning panel, streaming markdown, the subconscious checklist, or
  // the rate-limit wait row). The throbber lives below the card, not in
  // it, so the card collapses to nothing during the inter-round gap and
  // the pre-first-delta window - this gate keeps an empty bordered box
  // from flashing there. See src/lib/ui/streaming-bubble.ts.
  const streamingCardVisible = $derived(
    !!activeSlot && streamingCardHasContent(activeSlot, subconsciousRows.length)
  );

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
  // distinct topic list + per-topic thread counts the background
  // topics agent has assembled across the user's threads (the counts
  // drive the "(7)" the dropdown shows next to each topic); refreshed
  // on drawer mount and after we see the realtime subscription fire on
  // a thread row (which is the proxy we use for "the agent just tagged
  // something"). Both start empty - a brand-new account has nothing
  // selected and an empty vocabulary, and the dropdown still functions
  // (it offers only the sentinel until the worker catches up).
  let selectedTopics = $state<string[]>([]);
  let topicsVocabulary = $state<TopicVocabulary>({ topics: [], untagged: 0 });

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
    switch (bucketFor(t, recentCutoff)) {
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
    const toolPending = Object.values(activeSlot.toolTimings).some((t) => t.endedAt === undefined);
    // Also tick while reasoning is streaming so the elapsed-ms pill in
    // the reasoning header counts up. Stops once reasoning ends
    // (reasoningEndedAt set) - the pill freezes at its final value and
    // the rAF loop can idle until the next live timing source.
    const reasoningLive =
      activeSlot.reasoningStartedAt !== null && activeSlot.reasoningEndedAt === null;
    if (!toolPending && !reasoningLive) return;
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
    if (totalAttachmentBytes(pendingAttachments) + file.size > MAX_MESSAGE_AGGREGATE_BYTES) {
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
      compressing: false,
      compression: null,
      page_count: null,
      pages: [],
      rendering: null,
      error: null,
    };
    pendingAttachments = [...pendingAttachments, draft];

    try {
      // Images: compress toward the byte target (resize + re-encode), then
      // encode. Non-images: encode as-is and hit Venice text-parser.
      let finalFile: File = file;
      let compression: { beforeBytes: number; afterBytes: number } | null = null;
      if (isImageMimeType(file.type)) {
        patchAttachment(id, { compressing: true });
        // compressImage throws on an undecodable image; the outer catch
        // turns that into an error chip.
        const result = await compressImage(file);
        finalFile = result.file;
        if (result.changed) {
          compression = { beforeBytes: result.beforeBytes, afterBytes: result.afterBytes };
        }
        patchAttachment(id, { compressing: false });
      }
      const buffer = await finalFile.arrayBuffer();
      const base64 = arrayBufferToBase64(buffer);

      // Text extraction and PDF rasterization run CONCURRENTLY. Extraction
      // is a network round trip that uploads the whole file to Venice and
      // dominates the wall clock; rendering is local CPU. Serializing them
      // would make a scanned PDF wait out both in turn for no reason.
      //
      // Extraction resolves to a result object rather than throwing so a PDF
      // that rendered fine isn't rejected over a text-parser blip - the
      // readability decision happens once, below, with both results in hand.
      const supabase = app.supabase;
      const extraction: Promise<{ text: string | null; error: string | null }> =
        !isImageMimeType(finalFile.type) && supabase
          ? supabase
              .extractText(finalFile, finalFile.name)
              .then((text) => ({ text, error: null }))
              .catch((err: unknown) => ({
                text: null,
                error: err instanceof Error ? err.message : String(err),
              }))
          : Promise.resolve({ text: null, error: null });

      const rasterization: Promise<PdfRenderResult | null> = isPdfMimeType(finalFile.type)
        ? renderPdfPages(finalFile, (done, total) =>
            patchAttachment(id, { rendering: { done, total } })
          ).catch(() =>
            // Swallowed: an unrenderable PDF (corrupt, password-protected)
            // still has its text layer, and the readability decision below
            // covers the case where it has neither. Surfacing a render error
            // here would reject documents that read perfectly well.
            null
          )
        : Promise.resolve(null);

      const [extracted, render] = await Promise.all([extraction, rasterization]);
      patchAttachment(id, { rendering: null });

      const extractedText = extracted.text;
      const extractionError = extracted.error;
      const hasText = typeof extractedText === 'string' && extractedText.trim().length > 0;
      const hasPages = (render?.pages.length ?? 0) > 0;

      // Only fail the chip when the file ended up with NO readable form at
      // all. A PDF whose text-parser call failed but which rasterized is
      // still fully answerable through analyze_pdf_page, so the extraction
      // error is only worth surfacing when nothing else landed.
      if (!isImageMimeType(finalFile.type) && !hasText && !hasPages && extractionError) {
        patchAttachment(id, {
          pending: false,
          rendering: null,
          error: `Text extraction failed: ${extractionError}`,
        });
        return;
      }

      patchAttachment(id, {
        size_bytes: finalFile.size,
        mime_type: finalFile.type || draft.mime_type,
        data_base64: base64,
        extracted_text: extractedText,
        compression,
        // page_count stays null unless pages actually rendered, so a
        // non-null value downstream always means "there is something to
        // look at" rather than merely "this was a PDF."
        page_count: hasPages ? (render?.pageCount ?? null) : null,
        pages: render?.pages ?? [],
        pending: false,
        rendering: null,
        error: null,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      patchAttachment(id, {
        pending: false,
        compressing: false,
        rendering: null,
        error: msg,
      });
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
  // live inside {#if drawerTab === 'chats' || 'artifacts'} (the Artifacts
  // tab shares the chat main view), so switching to recipes /
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
  // Both fire on the edge INTO the {chats, artifacts} group from a tab
  // that unmounted the container, so they share one effect. Transitions
  // within the group (chats <-> artifacts) don't remount it, so they're
  // skipped. prevTab === null skips the initial mount: the selectThread
  // path that ran during syncFromUrl already handled both.
  const sharesChatView = (t: typeof drawerTab | null): boolean =>
    t === 'chats' || t === 'artifacts';
  let prevDrawerTab: typeof drawerTab | null = null;
  $effect(() => {
    const tab = drawerTab;
    const prev = prevDrawerTab;
    prevDrawerTab = tab;
    if (prev === null) return;
    if (!sharesChatView(tab) || sharesChatView(prev)) return;
    // Wait a tick for the chat main-view block to commit the remounted
    // composer + messages container before touching either.
    void tick().then(() => {
      if (!sharesChatView(drawerTab)) return;
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
    // Row already present. A realtime echo and a follow-up fetch can each
    // carry a field the other lacked; merge those upgrades onto the
    // existing row rather than dropping the echo (and rather than a
    // wholesale swap, which would clobber a field the existing row holds
    // and the echo doesn't - e.g. co-fetched attachments). Two cases:
    //   - attachments: the realtime payload can't join the attachments
    //     table, so a later listAttachmentsByMessageIds fetch upgrades a
    //     row that first arrived attachment-less.
    //   - second_thoughts: the reviewer agent writes this via a messages
    //     UPDATE a beat after the row committed (see
    //     supabase/functions/venice/agents/second_thoughts.ts), so its
    //     echo carries a verdict the locally-hydrated row didn't have yet.
    const existing = messages[existingIdx];
    const incomingHasAttachments = !!msg.attachments && msg.attachments.length > 0;
    const existingHasAttachments =
      !!existing.attachments && existing.attachments.length > 0;
    const gainsAttachments = incomingHasAttachments && !existingHasAttachments;
    const gainsSecondThoughts =
      msg.second_thoughts != null && existing.second_thoughts == null;
    if (!gainsAttachments && !gainsSecondThoughts) return;
    const updated = [...messages];
    updated[existingIdx] = {
      ...existing,
      ...(gainsAttachments ? { attachments: msg.attachments } : {}),
      ...(gainsSecondThoughts ? { second_thoughts: msg.second_thoughts } : {}),
    };
    messages = updated;
  }

  // Backstop for the second-thoughts verdict's realtime delivery. The
  // reviewer writes the verdict a few seconds AFTER a turn commits, and
  // it reaches the live view only via the messages UPDATE echo - which
  // Supabase realtime occasionally drops (a brief disconnect, a
  // backgrounded tab), leaving the verdict absent until a manual
  // refresh. A single delayed re-fetch of the just-completed row lands
  // it anyway; a no-op when the echo already delivered it (appendMessage
  // merges nothing) or when the reviewer wrote no verdict. Bounded set
  // of pending timers so a thread teardown can cancel them.
  // Past the observed reviewer latency (avg ~5s, max ~12s in
  // production) with margin, since this fires only when the realtime
  // echo dropped - a rare path where a slightly longer wait costs
  // nothing, and covering the slow tail matters more than being quick.
  const VERDICT_BACKFILL_DELAY_MS = 20000;
  const verdictBackfillTimers = new Set<ReturnType<typeof setTimeout>>();

  function scheduleVerdictBackfill(messageId: string, threadId: string): void {
    const timer = setTimeout(() => {
      verdictBackfillTimers.delete(timer);
      if (!app.supabase || activeThreadId !== threadId) return;
      // Already delivered by the realtime echo -> nothing to fetch.
      const local = messages.find((m) => m.id === messageId);
      if (local?.second_thoughts != null) return;
      void app.supabase
        .getMessage(messageId)
        .then((fresh) => {
          if (!fresh || activeThreadId !== threadId) return;
          if (fresh.second_thoughts != null) appendMessage(fresh);
        })
        .catch(() => {
          // Best-effort backstop; a failed fetch just leaves the manual
          // refresh as the fallback it already was.
        });
    }, VERDICT_BACKFILL_DELAY_MS);
    verdictBackfillTimers.add(timer);
  }

  /**
   * Total time the slop-notice CRT-power-off animation runs before the
   * card unmounts. Must stay >= the `crt-power-off` keyframe duration in
   * styles.css so the animation finishes before the node is removed.
   */
  const SLOP_NOTICE_CRT_MS = 560;

  /**
   * Retire a slot's "oops, all slop!" notice cards. Flips each into its
   * `dying` state (which runs the CRT-power-off animation via the
   * `.crt-off` class) and removes them from the slot once the animation
   * has played. Safe to call when there are no notices - it's a no-op.
   * Called when the replacement response persists, and on the
   * exchange's terminal paths so a notice can't outlive its turn.
   */
  function dismissSlopNotices(slot: ExchangeSlot): void {
    if (slot.slopNotices.length === 0) return;
    for (const notice of slot.slopNotices) notice.dying = true;
    window.setTimeout(() => {
      slot.slopNotices = [];
    }, SLOP_NOTICE_CRT_MS);
  }

  /**
   * Persist any in-memory recovery rows (added by listMessages when
   * the thread had wire-format-invalid gaps) to the DB ahead of the
   * next user turn. After this runs, those DB gaps are healed and
   * subsequent reads no longer need synthesis at those positions -
   * the synthesizer's idempotency check sees the persisted recovery
   * row sitting in the gap and no-ops.
   *
   * Position-preserving: synthesizeRecoveryMessages assigns each
   * synthetic a fractional position strictly between its real
   * neighbors when it builds the list, so persisting is just writing
   * each synthetic with the position it already carries - the row
   * lands in the same transcript slot the in-memory view shows,
   * while its created_at stays an honest "when the heal happened".
   * The unique (thread_id, position) index turns a cross-tab race
   * (both tabs healing the same gap) into an insert error instead of
   * a duplicate row; the callers' catch treats any insert failure as
   * "heal again on the next revisit".
   *
   * Re-fetching as input: the local `messages` array may be stale
   * (another tab could have already healed some gaps). Using the
   * DB's current state as the input - then synthesizing - avoids
   * writing recovery rows that are no longer needed.
   *
   * Own-segment only: a forked thread's transcript opens with rows
   * inherited from ancestor threads, and a gap in that inherited
   * prefix synthesizes rows carrying the ANCESTOR's thread_id (the
   * anchor rule in conversation-recovery). Persisting those from
   * here would write into another thread's position coordinates, so
   * they stay in-memory-only for this thread - they heal durably
   * when a thread that owns the gap revisits it. On a thread with no
   * fork ancestry every synthetic is own-segment and all heal here.
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
    const beforeWrite = await app.supabase.listMessages(threadId);
    const synthetics = beforeWrite.filter(
      (m) => m.synthetic && m.thread_id === threadId
    );
    if (synthetics.length === 0) {
      // Either nothing to heal (or nothing this thread owns), or
      // another tab already healed it. Adopt the DB view wholesale.
      messages = beforeWrite;
      return;
    }
    for (const m of synthetics) {
      await app.supabase.addMessage(threadId, m.role, m.content, {
        tool_call_id: m.tool_call_id ?? undefined,
        name: m.name ?? undefined,
        // Never undefined in practice - the synthesizer positions
        // every synthetic - but a defensive fall-through here means
        // the insert trigger appends at the tail rather than the
        // whole heal failing.
        position: m.position ?? undefined,
      });
    }
    if (activeThreadId !== threadId) return;
    messages = await app.supabase.listMessages(threadId);
  }

  // Insertion ordering across the three buckets is "updated_at desc,
  // id desc tiebreak" — same as the server-side ORDER BY in the
  // pagination RPCs. The single-row insertion helper is
  // `insertByUpdatedAtDesc` in $lib/ui/thread-buckets; no caller
  // needs the full re-sort variant, so it's not exposed.

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
      // Skip in-flight streaming-row echoes. The streaming-root edge
      // function INSERTs the assistant row with `status='streaming'`
      // and content='' at first content delta, then UPDATEs the same
      // row repeatedly as text accumulates. Appending those rows here
      // would paint an empty (and then incrementally-filling) bubble
      // alongside the live streamingText buffer the chat-loop is
      // already rendering. The terminal UPDATE flips status to a
      // non-streaming value and falls through to appendMessage, which
      // is when the persisted row enters the local view.
      if (msg.role === 'assistant' && msg.status === 'streaming') return;
      appendMessage(msg);
      // Hydrate attachments for user rows (uploads). The realtime
      // payload only carries the `messages` row — Postgres replication
      // doesn't join across tables — so a message with attachments
      // reaches the subscriber with `attachments` unset. Fire a
      // follow-up fetch and re-append; `appendMessage`'s upgrade path
      // replaces the placeholder with the hydrated row.
      //
      // Covers two scenarios for uploads:
      //   1. Local sender race — the sender's own appendMessage with
      //      attachments already lands; this hydration is a defensive
      //      second attempt for the case where the realtime echo
      //      arrives but the local path never fires.
      //   2. Cross-tab sync — tab B sees the INSERT from tab A and
      //      needs to fetch attachments itself.
      //
      // Assistant rows are deliberately excluded: their only
      // attachment source is generate_image, and that output is
      // attached server-side AFTER this row's INSERT echo, so it would
      // never be hydrated here anyway. GeneratedImageCard resolves the
      // image by filename instead (see generated-image.ts).
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
        // A fork of the ACTIVE thread extends its shared region - keep
        // the tooltip cache honest. Runs before the local-echo dedupe
        // below because the fork columns matter even when the row
        // itself is already in the drawer (idempotent Set add).
        if (t.forked_from_thread_id === activeThreadId && t.forked_from_msg_id) {
          childForkPointIds = new Set(childForkPointIds).add(t.forked_from_msg_id);
        }
        // The device that created the thread already has it locally
        // (createThread / newThread pushed it); skip the echo.
        if (findThread(t.id)) return;
        rebucketThread(t);
      },
      onUpdate: (t) => {
        // Delete arrives as an UPDATE now: the delete gesture hides
        // the thread (the fork GC destroys it later), so the echo
        // every device gets is hidden=true - treat it exactly like
        // the DELETE event below. Without this branch, rebucketThread
        // would re-insert the deleted thread into the drawer.
        if (t.hidden) {
          removeThread(t.id);
          if (activeThreadId === t.id) {
            activeThreadId = null;
            messages = [];
            setSessionThreadId(null);
            navigate({ cid: null });
          }
          return;
        }
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
        // If the toolboxes_enabled column changed on the active
        // thread, drive the composer's brief flash so a human eye
        // notices the LLM-initiated state flip. toggle_toolbox
        // executes server-side, so the realtime UPDATE echo is
        // the only signal we have here. User-initiated flips path
        // through setToolboxEnabled, which patches the local thread
        // row optimistically before the realtime UPDATE arrives - so
        // by the time this handler fires, existing.toolboxes_enabled
        // already matches t.toolboxes_enabled and the set comparison
        // skips the flash (the click itself was the feedback). Only
        // LLM-driven flips - where local state never patched - reach
        // here with a real delta to surface. ~200ms later than the
        // old in-process patch, but a perceptible flash beats none.
        const prevToolboxes = existing?.toolboxes_enabled ?? [];
        const nextToolboxes = t.toolboxes_enabled;
        const toolboxesChangedOnActive =
          t.id === activeThreadId &&
          (prevToolboxes.length !== nextToolboxes.length ||
            prevToolboxes.some((p, i) => p !== nextToolboxes[i]));
        rebucketThread(t);
        if (topicsChanged) void refreshTopicsVocabulary();
        if (toolboxesChangedOnActive) {
          toolboxFlash = true;
          setTimeout(() => {
            toolboxFlash = false;
          }, 600);
        }
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

  // Realtime: follow the current user's edge-function log channel and
  // feed entries into the Logs drawer. Background work that runs server-
  // side (reflection, and the agent fleets as they migrate off the
  // browser) has no Web Worker postMessage path to the drawer, so it
  // broadcasts structured entries to `logs:<userId>` instead; this is
  // the browser end of that pipe. RLS scopes the channel to the owner.
  $effect(() => {
    if (!app.supabase || !session) return;
    return app.supabase.subscribeToUserLogs(session.user.id, appendFromEdge);
  });

  // Realtime: relay server-side wiki writes into the window-level
  // wiki-change event bus. The autonomous wiki agent runs in the
  // venice function (cron-driven sweep), where emitWikiChange is
  // unreachable - this subscription is how an open Wiki panel learns
  // a background article write landed. Browser-side writers (the Wiki
  // UI, the librarian's tools) still fire the bus directly; their
  // own DB writes ALSO echo back through this subscription, which is
  // harmless - consumers refetch idempotently.
  $effect(() => {
    if (!app.supabase || !session) return;
    const supabase = app.supabase;
    return supabase.subscribeToWikiArticleChanges(session.user.id, () => {
      emitWikiChange();
      // A server-side article write (this device or another) may have
      // changed a favorited article's body or its favorite flag - re-
      // reconcile the offline cache so the saved copy tracks it. The
      // ping carries no payload, so we re-fetch the marked set; the
      // reconcile is a no-op when nothing the cache holds actually moved.
      void syncOfflineCache(supabase);
    });
  });

  // Realtime: relay server-side wiki-record writes into the record
  // change bus. Same rationale as the article subscription above - the
  // extraction agent and librarian write records in the venice function
  // where emitWikiRecordChange is unreachable, so an open article's
  // Records section learns about background writes through this relay.
  $effect(() => {
    if (!app.supabase || !session) return;
    return app.supabase.subscribeToWikiRecordChanges(session.user.id, emitWikiRecordChange);
  });

  // Watch the wiki-librarian in-flight lease so every client knows when a
  // run is active - the originating tab, a refresh, another device, AND
  // scheduled background runs (they hold the same lease). Drives the
  // top-bar sparkle button's disabled state below and the Wiki panel's
  // "a run is in progress" spinner. Start/stop with the session; the
  // watcher does its own realtime subscribe + initial read.
  $effect(() => {
    if (!app.supabase || !session) return;
    wikiLibrarianLease.start({ supabase: app.supabase, userId: session.user.id });
    return () => wikiLibrarianLease.stop();
  });

  // Memory librarian (rem + deep-sleep) twin of the wiki lease watcher.
  // Both passes share one in-flight guard, so one watcher drives the
  // disable state on both top-bar buttons and reflects scheduled
  // background memory-librarian runs too.
  $effect(() => {
    if (!app.supabase || !session) return;
    memoryLibrarianLease.start({ supabase: app.supabase, userId: session.user.id });
    return () => memoryLibrarianLease.stop();
  });

  // Outcome-recovery watchers - the leases' twins. The lease re-disables a
  // button across a reload; these recover the result CARD so the strip can
  // re-render "what the last run did" (read on mount + watched via the same
  // profiles realtime UPDATE). The Wiki panel reads wikiLibrarianOutcome
  // directly; the memory one is bridged into the librarianRun store in
  // Memories.svelte. Start/stop with the session, same as the leases.
  $effect(() => {
    if (!app.supabase || !session) return;
    wikiLibrarianOutcome.start({ supabase: app.supabase, userId: session.user.id });
    return () => wikiLibrarianOutcome.stop();
  });
  $effect(() => {
    if (!app.supabase || !session) return;
    memoryLibrarianOutcome.start({ supabase: app.supabase, userId: session.user.id });
    return () => memoryLibrarianOutcome.stop();
  });

  // Realtime: the memories twin of the wiki relay above. Every memory
  // writer is server-side now (the hourly reflection sweep, the
  // rem / deep-sleep librarian sweeps), so this subscription is how an
  // open Memories panel learns a background write landed.
  $effect(() => {
    if (!app.supabase || !session) return;
    return app.supabase.subscribeToMemoryChanges(session.user.id, emitMemoryChange);
  });

  // Realtime: the recipes leg of the same family. The recipe_* tools
  // dispatch in the venice function, so a model-driven recipe write
  // reaches the Cookbook modal and the drawer's Recipes tab through
  // this relay into the cookbook event bus.
  $effect(() => {
    if (!app.supabase || !session) return;
    const supabase = app.supabase;
    return supabase.subscribeToRecipeChanges(session.user.id, () => {
      emitCookbookChange();
      // Twin of the wiki relay: a server-side recipe write may have
      // changed a favorited / upcoming recipe or its bookmark flags,
      // so re-reconcile the offline cache off the fresh marked set.
      void syncOfflineCache(supabase);
    });
  });

  // Realtime: the grocery leg. Grocery writes the UI didn't make
  // itself - the recipe-edit invalidation trigger's bulk delete, a
  // Cookbook checkbox click while the Groceries tab is open, another
  // device at the store - reach the open list through this relay
  // into the grocery event bus.
  $effect(() => {
    if (!app.supabase || !session) return;
    return app.supabase.subscribeToGroceryChanges(session.user.id, emitGroceryChange);
  });

  // Offline cache: track connectivity and keep the IndexedDB mirror of
  // the marked set (favorited articles, favorited / upcoming recipes)
  // current. Reconcile once when the session goes live, and again each
  // time the device comes back online so a cache that drifted while
  // offline catches up. The realtime relays above cover the
  // online-steady-state case. initOfflineStatus owns the
  // navigator.onLine flag the offline UI reads.
  $effect(() => {
    if (!app.supabase || !session) return;
    const supabase = app.supabase;
    const teardownStatus = initOfflineStatus();
    void syncOfflineCache(supabase);
    const onOnline = (): void => {
      void syncOfflineCache(supabase);
    };
    window.addEventListener('online', onOnline);
    return () => {
      window.removeEventListener('online', onOnline);
      teardownStatus();
    };
  });

  // Realtime: mint toasts. The samskara formation pipeline runs in the
  // venice function (turn tail + hourly sweep), so a fresh mint reaches
  // the mood pill as a private samskara-mint Broadcast event, relayed
  // into the same window event the old in-tab worker dispatched.
  // SamskaraToasts.svelte is the unchanged consumer.
  $effect(() => {
    if (!app.supabase || !session) return;
    return app.supabase.subscribeToSamskaraInserts(session.user.id, notifySamskaraMint);
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
        topicsVocabulary = { topics: [], untagged: 0 };
        selectedTopics = [];
        // Sign-out: abort every in-flight exchange. Without this a
        // background chat-loop kept running until its next tool/round
        // tripped on the now-invalid session, which Venice surfaces as
        // an auth error in the LOGS rather than anywhere the now-
        // signed-out user can see.
        exchangeStore.disposeAll();
      }
    });
    // supabase-js getSession() reads the persisted session from
    // localStorage and resolves without a network round-trip (token
    // refresh is fire-and-forget), so an offline cold boot with a valid
    // stored JWT still resolves here and renders the shell - which is
    // what makes the offline cache reachable. The .catch is the
    // belt-and-suspenders: if getSession ever rejects (a hardened
    // storage error), we must still flip sessionLoaded so the UI can't
    // strand on the "Connecting..." gate forever. onAuthChange's
    // INITIAL_SESSION (also storage-backed) is what sets `session` in
    // that case.
    void app.supabase
      .getSession()
      .then((s) => {
        session = s;
        sessionLoaded = true;
        if (s) {
          void refreshThreads();
          void refreshSettings();
          void refreshTopicsVocabulary();
        }
      })
      .catch(() => {
        sessionLoaded = true;
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
    const offDocuments = onDocumentChange(onDocumentStoreChanged);
    return () => {
      unsubscribe();
      offCookbook();
      offWiki();
      offDocuments();
      for (const t of verdictBackfillTimers) clearTimeout(t);
      verdictBackfillTimers.clear();
    };
  });

  async function refreshSettings(): Promise<void> {
    if (!app.supabase) return;
    try {
      const s = await app.supabase.getSettings();
      applyServerSettings(s);
      // Project-global price caps live on app_config, not profiles.settings,
      // so they come back from a separate read. getPriceCaps swallows its
      // own errors (returns NO_PRICE_CAPS), so a caps-read hiccup can't
      // break the settings refresh.
      setPriceCaps(await app.supabase.getPriceCaps());
      // Same story for the model_feature_rejections snapshot (wire
      // fields a model's backend rejects; disables matching controls in
      // Settings -> Model profiles). Swallows its own errors too ({}).
      setModelFeatureRejections(await app.supabase.getModelFeatureRejections());
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
      recentThreads = mergeServerThreadList(recent, loadedThreads);
      olderThreads = mergeServerThreadList(older.rows, loadedThreads);
      olderCursor = older.nextCursor;
      olderHasMore = older.nextCursor !== null;
      olderLoading = false;
      archivedPage = mergeServerThreadList(archived.rows, loadedThreads);
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
    // calls selectThread when route.cid changes externally. (The
    // effect only fires on a cid mismatch, so this equal-id path is
    // reached only by direct user actions - sidebar row click,
    // notification click - never by the reconcile loop.) Re-selecting
    // the active thread still means "show me the transcript", so close
    // the Daily digest panel if it is covering it; otherwise clicking
    // the highlighted sidebar row while the digest is open does
    // nothing and the user reads the view as stuck.
    if (id === activeThreadId) {
      navigate({ digest: null });
      return;
    }
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
    // grow on browser-back navigations. Opening a thread also closes
    // the Daily digest panel - the digest's deep-links and the sidebar
    // both land the user in the transcript, never behind the panel.
    navigate({ cid: id, digest: null });
    messages = [];
    // Reset the shared-region tooltip cache in lockstep with the
    // messages it qualifies; the refresh below repopulates it.
    childForkPointIds = new Set();
    if (id !== null) void refreshChildForkPoints(id);
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
      // Point-read the thread's in-flight streaming state in parallel
      // with the message list. On a cold page load the route effect
      // opens the URL's thread BEFORE the sidebar's thread buckets have
      // fetched, so `findThread(id)` is empty and the local copy of
      // stream_started_at doesn't exist yet - which made the
      // refresh-during-pregame reconnect silently fail to arm on
      // exactly the reload it was built for. The DB row is the
      // authority; the bucket copy is only a fallback when the point
      // read fails.
      const streamStatePromise = app.supabase
        .getThreadStreamState(id)
        .catch((err: unknown) => {
          log.warn('thread stream-state point read failed', err);
          return null;
        });
      const fetched = await app.supabase.listMessages(id);
      const streamState = await streamStatePromise;
      // The user may have hopped threads while we were awaiting - guard
      // against a late response stomping newer state.
      if (activeThreadId !== id) return;
      // Pull an in-flight assistant row off the snapshot before
      // merging. The streaming bubble (slot.streamingText) owns
      // rendering of mid-flight content; if the row stayed in the
      // transcript we'd double-paint the live answer alongside the
      // bubble. Reconnect kicks off below once messages is committed
      // so the static render lands before the bubble's first delta.
      const streamingTail = fetched.find(
        (m) => m.role === 'assistant' && m.status === 'streaming',
      );
      const visibleFetched = streamingTail
        ? fetched.filter((m) => m.id !== streamingTail.id)
        : fetched;
      // Merge the listMessages snapshot with any rows the slot's chat-
      // loop persisted during the window between `messages = []` and
      // the fetch resolving. Race shape: user switches into a thread
      // whose background slot is mid-exchange; onAssistantPersisted
      // and onToolResultPersisted fire while the await is in flight,
      // pushing into slot.persistedRows. The snapshot may or may not
      // include those rows depending on when its underlying query
      // ran. mergeMessagesById de-dupes by id and slots the buffered
      // rows into the thread's own segment by position (inherited
      // fork-prefix rows keep their snapshot order), so either path
      // lands the same final transcript. Empty buffer is fast-pathed
      // inside mergeMessagesById; non-streaming threads pay nothing.
      const bufferedRows = exchangeStore.peek(id)?.persistedRows ?? [];
      messages = mergeMessagesById(visibleFetched, bufferedRows, id);
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
      // Two in-flight signals: the streaming assistant row (created at
      // the first content delta) and the server-side stream_started_at
      // stamp, which the orchestrator writes at turn entry so the
      // priming window BEFORE any row exists is also visible. Without
      // the stamp, a refresh during the pre-response "pregame"
      // (predicting / recalling) found nothing to reconnect to and
      // fell through to the interrupted-draft / cut-off retry banners
      // for a turn that was still running server-side.
      const streamStartedAt =
        streamState?.streamStartedAt ?? findThread(id)?.stream_started_at ?? null;
      const serverTurnInFlight =
        streamingTail != null ||
        streamLikelyInFlight(streamStartedAt, Date.now());
      // Mirror the authoritative stamp into the loaded bucket copy (a
      // no-op when the buckets haven't fetched yet) so the
      // incompleteTurnTail suppression, which reads currentThread,
      // agrees with the decision made here.
      if (streamState) {
        patchThread(id, { stream_started_at: streamState.streamStartedAt });
      }
      const lastMsg = fetched.at(-1);
      // Diagnostics for the refresh-during-pregame recovery path: one
      // debug line per thread open recording every signal the banner /
      // reconnect decisions below read, so the Logs drawer shows WHY a
      // retry banner or a reconnect happened (source: chat).
      log.debug(
        `thread-open signals thread=${id} tail=${lastMsg?.role ?? 'empty'}` +
          ` streamingRow=${streamingTail != null}` +
          ` stampDb=${streamState?.streamStartedAt ?? 'null'}` +
          ` stampLocal=${findThread(id)?.stream_started_at ?? 'null'}` +
          ` inFlight=${serverTurnInFlight}` +
          ` claimHolder=${streamState?.responseHolderId ?? 'null'}` +
          ` claimExpires=${streamState?.responseClaimExpiresAt ?? 'null'}` +
          ` slotSending=${exchangeStore.peek(id)?.sending === true}`,
      );
      if (
        lastMsg?.role === 'user' &&
        !serverTurnInFlight &&
        !exchangeStore.peek(id)?.sending
      ) {
        const draft = await loadDraft(id);
        if (draft && draft.userMessageId === lastMsg.id && activeThreadId === id) {
          interruptedDraft = draft;
          log.debug(
            `interrupted-draft banner armed thread=${id} userMessageId=${draft.userMessageId}`,
          );
        }
      }
      // Join an in-flight assistant turn if either signal says one is
      // running AND this device isn't the one producing it. Three
      // paths: same-device reload (slot from prior tab lifetime is
      // gone), cross-device ape mode (peer is streaming), and a reload
      // that landed during the pre-row priming window (stamp only, no
      // streaming row yet - the reconnect poll picks the row up once
      // the first content delta creates it). The streaming row, when
      // present, was already pulled out of the rendered transcript
      // above so the live bubble can own its visual slot without a
      // duplicate static row underneath.
      //
      // Fire-and-forget: the reconnect drives its own slot lifecycle
      // (sending flag, throttled buffers, terminal handling). A
      // failure surfaces on the slot's streamingError banner.
      if (serverTurnInFlight && !exchangeStore.peek(id)?.sending) {
        log.debug(
          `reconnect armed thread=${id} seed=${streamingTail ? 'streaming-row' : 'pregame-stamp'}`,
        );
        void reconnectInflightTurn(id, streamingTail?.content ?? '');
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
    // Armed for a foreign-held claim (the respondingElsewhere TTL
    // check) and for a live server-side in-flight stamp (the
    // incompleteTurnTail suppression below) - both are time-based
    // verdicts that must eventually flip even if no realtime event
    // ever arrives to re-run their deriveds.
    const foreignClaim =
      t?.response_holder_id != null && t.response_holder_id !== holderId;
    if (!foreignClaim && !t?.stream_started_at) return;
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
        messages = mergeMessagesById(fetched, bufferedRows, threadId);
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

  // Prior context-recall injections accumulated in this tab for the
  // active thread, in landing order (earliest first). Drives the
  // history section of the Recall modal; empty for cold / never-fired
  // threads and for threads where only one injection has happened.
  const currentContextRecallHistory = $derived<readonly ContextRecallPayload[]>(
    activeThreadId === null
      ? []
      : (contextRecallHistory.get(activeThreadId) ?? [])
  );

  // Inverse of userRoundByMessageId: round number -> user Message row.
  // Lets the Recall modal show the user prompt that triggered each
  // injection without the modal having to walk the messages array
  // itself. The walk lives in $lib/ui/recall as buildUserMessageByRound;
  // this site is the rune wire-up.
  const userMessageByRound: Map<number, Message> = $derived(
    buildUserMessageByRound(messages)
  );

  // The user's default profile - what a thread with no per-thread pin
  // (threads.model null) resolves to.
  const defaultProfile = $derived<ModelProfile>(
    defaultModelProfile(app.modelProfiles)
  );
  // Effective profile for the current thread: the pinned profile when
  // threads.model names a live one, otherwise the default (which also
  // covers deleted profiles and legacy pre-profile tier names). Drives
  // every capability read below (default thinking, reasoning support,
  // context window) so the thread behaves as its profile is configured.
  const currentProfile = $derived<ModelProfile>(
    resolveModelProfile(app.modelProfiles, currentThread?.model ?? null)
  );
  // Resolved thinking level for the current thread (override -> profile
  // default). Drives the picker's displayed value; may be 'off' when
  // the profile defaults off or the user picked Off for this thread.
  // Only surfaced when `currentProfile.supportsReasoning`.
  const currentReasoning = $derived<ThinkingLevel>(
    currentThread?.reasoning_effort ?? currentProfile.thinking
  );
  // Show the per-thread reasoning picker on any reasoning-capable
  // profile. 'Off' is one of the picker's positions rather than a
  // reason to hide it, so a profile that defaults thinking off still
  // shows the picker (the user can bump it back up for one thread).
  // Only a model that can't reason at all hides the control - a knob
  // the provider would reject.
  const currentSupportsReasoning = $derived<boolean>(
    currentProfile.supportsReasoning
  );
  // Resolved verbosity for the current thread. Same override-wins pattern
  // as reasoning; no capability gate - most providers that don't honor
  // `text.verbosity` silently ignore it, and the ones that 400 on the
  // field are recovered server-side by stripping it and re-issuing
  // (see getStreamingCompletion's strict-validation fallback).
  const currentVerbosity = $derived<Verbosity>(
    currentThread?.verbosity ?? currentProfile.verbosity
  );
  // Whether the current model is recorded as rejecting the verbosity
  // knob outright (model_feature_rejections). Disables the composer's
  // verbosity picker - same signal that disables the Settings profile
  // card's verbosity dropdown, so the two surfaces can't disagree.
  const currentVerbosityRejected = $derived<boolean>(
    verbosityRejectedForModel(app.modelFeatureRejections, currentProfile.modelId)
  );
  // Resolved gated-toolbox set for the current thread. The composer
  // toolbox button renders unconditionally (mirroring the model /
  // reasoning / verbosity pickers), so it needs a sensible default
  // when no thread is active or the thread is a draft - empty array,
  // since there's no user-level "default toolboxes" concept.
  const currentToolboxesEnabled = $derived<string[]>(
    currentThread?.toolboxes_enabled ?? []
  );

  const allToolboxMeta = $derived(
    GATED_TOOLBOX_META.concat(
      mcpToolboxMetaItems(app.mcpIntegrations)
    )
  );

  const mcpProblemCount = $derived(
    app.mcpIntegrations.filter((i) => i.authStatus === 'expired' || i.authStatus === 'revoked').length,
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

  async function setProfile(profileId: string): Promise<void> {
    if (!app.supabase) return;
    // Fresh sessions (first run, last thread deleted, sidebar not yet
    // opened) leave `activeThreadId` null, which used to hide the picker
    // entirely — on mobile the sidebar is an overlay, so "pick a thread
    // first" isn't a discoverable step. Auto-create a draft so the
    // profile choice has somewhere to land; draft creation is free
    // (local-only until the first send materializes it).
    if (!currentThread) {
      await newThread();
      if (!currentThread) return;
    }
    // If the chosen profile is the user's default, clear the per-thread
    // pin so the thread keeps tracking future default changes; only pin
    // an explicit profile id when it actually differs from the default.
    const next: string | null = profileId === defaultProfile.id ? null : profileId;
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

  // Mirror of setProfile for reasoning effort. Clearing the override
  // when the user picks the profile's current default is deliberate:
  // that way a later change to the profile's default propagates to this
  // thread automatically, and we don't pin a stale value just because
  // it happened to match once.
  async function setReasoning(level: ThinkingLevel): Promise<void> {
    if (!app.supabase) return;
    // Same fresh-session pattern as setProfile — without a thread to
    // land the override on, picking a level would silently no-op. Auto-
    // create a draft so the choice has somewhere to go; the draft is
    // local-only until the first send materializes it.
    if (!currentThread) {
      await newThread();
      if (!currentThread) return;
    }
    // Clear the override when the pick matches the profile's default so
    // the thread keeps tracking a later default change (including the
    // 'off' default of a thinking-off profile).
    const next: ThinkingLevel | null =
      level === currentProfile.thinking ? null : level;
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
  // match discipline so a later change to the profile's default
  // propagates to this thread automatically.
  async function setVerbosity(verbosity: Verbosity): Promise<void> {
    if (!app.supabase) return;
    if (!currentThread) {
      await newThread();
      if (!currentThread) return;
    }
    const next: Verbosity | null =
      verbosity === currentProfile.verbosity ? null : verbosity;
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
    if (currentIsEmpty) {
      // While the Daily digest panel covers the transcript, the New
      // button stays enabled on an empty thread and acts as "back to
      // the conversation" (see newThreadButtonState) - closing the
      // panel instead of minting a second empty draft.
      if (route.digest) navigate({ digest: null });
      return;
    }
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
      hidden: false,
      forked_from_thread_id: null,
      forked_from_msg_id: null,
      title_manually_set: false,
      intuition_payload: null,
      context_recall_payload: null,
      topics: [],
      response_holder_id: null,
      response_claim_expires_at: null,
      stream_started_at: null,
      last_error: null,
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

  // Fork via the row dropdown: whole-conversation fork (fork point =
  // transcript tail), then open the fork. The new row lands adjacent
  // to its parent with an identical title - the git-branch glyph in
  // the row is what tells them apart. No optimistic insert: the fork
  // row only exists once the server mints it, and the realtime INSERT
  // echo dedupes against the local add via findThread.
  async function forkFromRow(id: string): Promise<void> {
    if (!app.supabase) return;
    const t = findThread(id);
    if (!t || t.isDraft) return;
    closeRowMenu();
    try {
      const fork = await app.supabase.forkThread(id);
      rebucketThread(fork);
      await selectThread(fork.id);
    } catch (err) {
      error = { text: err instanceof Error ? err.message : String(err) };
    }
  }

  // Fork via a message card's fork button: fork the active
  // conversation AT that row (the copied prefix ends there; later
  // rows stay behind in this thread, untouched), then open the fork.
  // Same no-optimistic-insert posture as forkFromRow. The hover
  // preview is cleared up front because selectThread swaps the
  // messages array out from under the outlined ids.
  async function forkFromMessage(messageId: string): Promise<void> {
    if (!app.supabase || !activeThreadId) return;
    clearRegeneratePreview();
    try {
      const fork = await app.supabase.forkThread(activeThreadId, messageId);
      rebucketThread(fork);
      await selectThread(fork.id);
    } catch (err) {
      error = { text: err instanceof Error ? err.message : String(err) };
    }
  }

  // Fork and edit: fork from the message BEFORE the user message (not
  // at the user message itself), insert a draft row carrying the old
  // text, open the fork, and load the draft into the composer. The
  // user edits and sends normally - the send path promotes the draft
  // (status cleared, content updated) and runs the completion.
  //
  // Forking before the user message means the old text stays in the
  // original conversation, untouched. The edited text starts the
  // fork's own segment. If the user message is the first message (no
  // anchor before it), create a fresh thread with the parent's pins.
  async function forkAndEdit(userMessageId: string): Promise<void> {
    if (!app.supabase || !activeThreadId) return;
    const active = findThread(activeThreadId);
    if (!active) return;
    const userMsg = messages.find((m) => m.id === userMessageId);
    if (!userMsg || userMsg.role !== 'user') return;
    clearRegeneratePreview();
    // Clear any pending edit state - mutually exclusive.
    pendingDeleteIds = [];
    try {
      const anchor = deleteForkAnchor(messages, userMessageId);
      const fork = anchor
        ? await app.supabase.forkThread(active.id, anchor.id, { markTitle: false })
        : await app.supabase.createThread(
            active.title,
            active.model,
            active.reasoning_effort,
            active.verbosity,
            active.title_manually_set,
            active.toolboxes_enabled,
          );
      rebucketThread(fork);
      // Insert a draft row on the fork with the old user message text.
      // The draft is invisible in the transcript (buildMessageBlocks
      // filters status='draft') and the composer is the only surface
      // that shows it.
      const draft = await app.supabase.addMessage(fork.id, 'user', userMsg.content, {
        status: 'draft',
      });
      await selectThread(fork.id);
      composer = draft.content;
      pendingDraftId = draft.id;
      // Focus the composer so the user can start editing immediately.
      composerEl?.focus();
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

  // Download a conversation as a Markdown transcript. The active thread
  // exports the in-memory `messages` array (which includes any turns
  // realtime delivered since the last fetch); any other thread - the
  // row-menu path - fetches its rows first. Draft threads are blocked
  // at both call sites (no DB rows to export yet).
  async function exportTranscript(id: string): Promise<void> {
    closeRowMenu();
    const thread = findThread(id);
    if (!thread || thread.isDraft || !app.supabase) return;
    try {
      const rows =
        id === activeThreadId ? messages : await app.supabase.listMessages(id);
      downloadText(
        transcriptExportFilename(thread),
        buildTranscriptMarkdown(thread, rows),
      );
    } catch (err) {
      error = { text: err instanceof Error ? err.message : String(err) };
    }
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

  /**
   * What one composer submission carries: the trimmed text plus the
   * attachment chips that are ready to ride with it.
   */
  interface ComposerPayload {
    text: string;
    attachments: LocalAttachment[];
  }

  /**
   * Validate the composer's current contents and snapshot them for a
   * send. Returns null when there is nothing to send, or when an
   * attachment blocks the send - in which case `error` is painted above
   * the composer with the reason so the user can remove the file or
   * switch profile.
   *
   * Does NOT clear the composer. `send()` clears only after the thread
   * is materialized; `queueMessage()` clears immediately. Both need the
   * same rules applied at the same moment - a queued message is
   * validated when the user queues it, not when it fires, because at
   * drain time the composer that caused the error is long gone and an
   * error banner about it would have no referent.
   */
  function readComposerPayload(modelSpec: ModelSpec): ComposerPayload | null {
    const text = composer.trim();
    // Attachments alone (no text) are allowed — a user may "send an
    // image for you to look at". Still require text OR at least one
    // ready attachment so an empty send doesn't fire.
    const attachments = pendingAttachments.filter((a) => !a.pending && !a.error);
    if (!text && attachments.length === 0) return null;
    error = null;
    // Pre-send guard on attachments. Block the send if any attachment
    // is still processing, is in an error state, or can't be read by
    // the selected model.
    const stillPending = pendingAttachments.find((a) => a.pending);
    if (stillPending) {
      error = {
        text: `"${stillPending.filename}" is still processing — wait for it to finish.`,
      };
      return null;
    }
    const erroredChip = pendingAttachments.find((a) => a.error);
    if (erroredChip) {
      error = { text: `"${erroredChip.filename}": ${erroredChip.error}` };
      return null;
    }
    // Images are handled on all models via analyze_image(), and a PDF that
    // rasterized is readable through analyze_pdf_page even with an empty
    // text layer (the scanned-document case). Only block a non-image
    // attachment that has neither - that's a real dead end with no tool
    // fallback.
    const unreadable = attachments.find(
      (a) => !isImageMimeType(a.mime_type) && !isConsumableBy(a, modelSpec)
    );
    if (unreadable) {
      error = {
        text: `"${unreadable.filename}" has no text the parser could read and no pages that could be rendered — the model won't be able to read it. Remove it to send.`,
      };
      return null;
    }
    return { text, attachments };
  }

  /**
   * Persist one user turn - the message row plus its attachment rows -
   * and append it to the active view. Shared by the composer send and
   * the queued-message drain so a message that waited out a stream
   * lands as exactly the same rows as one sent immediately.
   *
   * An attachment-insert failure is non-fatal: the user's typed text
   * still gets a reply and the transcript reads as plain text. A failed
   * message insert throws - there is no recoverable shape without the
   * user row, so the caller surfaces it.
   *
   * The append is gated on the target being the thread on screen, the
   * same guard every persisted-row handler in `runExchange` carries
   * (see exchange.md, "appendMessage vs recordPersistedRow"). `send()`
   * always targets the active thread so the gate is a no-op there, but
   * the queued drain can fire against a thread the user has navigated
   * away from - ungated, its user rows would appear in whatever
   * transcript happened to be open. The rows are on screen for that
   * thread either way once `selectThread` refetches it.
   */
  async function persistUserTurn(
    threadId: string,
    text: string,
    attachments: LocalAttachment[]
  ): Promise<Message> {
    const supabase = app.supabase;
    if (!supabase) throw new Error('Not connected.');
    const userMsg = await supabase.addMessage(threadId, 'user', text);
    // Positional index matches the chip order so the message list
    // renders them the way the user queued them.
    if (attachments.length > 0) {
      const newRows: NewAttachment[] = attachments.map((a, i) => toNewAttachment(a, i));
      try {
        userMsg.attachments = await supabase.addAttachments(userMsg.id, newRows);
        // Rasterized PDF pages upload AFTER the attachment rows commit -
        // their own rows FK to the attachment id and their object keys embed
        // it, so neither exists until this point. `addAttachments` returns
        // rows in the order it was handed them, which is the composer's chip
        // order, so index alignment with `attachments` holds.
        //
        // Non-fatal: a failed page upload costs the model its visual read of
        // the document, not the message. The user's turn and the extracted
        // text land either way, so this must never take the send down with
        // it.
        await Promise.all(
          userMsg.attachments.map(async (row, i) => {
            const local = attachments[i];
            if (!local || local.pages.length === 0) return;
            try {
              await supabase.addAttachmentPages(row.id, local.pages);
            } catch (err) {
              log.warn('addAttachmentPages failed', err);
            }
          })
        );
      } catch (err) {
        log.warn('persistAttachments failed', err);
        userMsg.attachments = [];
      }
    } else {
      userMsg.attachments = [];
    }
    if (threadId === activeThreadId) appendMessage(userMsg);
    return userMsg;
  }

  async function send(): Promise<void> {
    if (!app.supabase || !app.venice) return;

    const active = activeThreadId ? findThread(activeThreadId) ?? null : null;
    // Capture the profile BEFORE materializing, since materialize mutates
    // `threads` and could make `currentThread` briefly null.
    const profile = resolveModelProfile(app.modelProfiles, active?.model ?? null);
    const modelSpec = profileModelSpec(profile);
    const modelId = profile.modelId;
    // Resolve the thread's thinking level against the profile and split
    // it into the two mutually-exclusive wire knobs (reasoning_effort vs
    // disable_thinking). 'off' -> disable_thinking; non-reasoning models
    // get neither. See thinkingWireForProfile.
    const { reasoningEffort: sendReasoning, disableThinking: sendDisableThinking } =
      thinkingWireForProfile(profile, active?.reasoning_effort ?? null);
    // Verbosity is safe to send unconditionally - a model whose
    // backend rejects `text.verbosity` outright is recovered
    // server-side (strip-and-retry on first encounter, then a
    // preemptive strip from the model_feature_rejections record).
    const sendVerbosity: Verbosity = active?.verbosity ?? profile.verbosity;
    const payload = readComposerPayload(modelSpec);
    if (!payload) return;
    const text = payload.text;

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
      const sendAttachments = payload.attachments;
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
        if (pendingDraftId) {
          // Fork-and-edit send: promote the draft row (update content,
          // clear status) rather than inserting a new user message.
          // The draft row already exists in the DB from the
          // forkAndEdit handler; this update turns it into a normal
          // user message that the completion runs against.
          const supabase = app.supabase;
          if (!supabase) throw new Error('Not connected.');
          const { data, error: updErr } = await supabase.client
            .from('messages')
            .update({ content: text.trim(), status: null })
            .eq('id', pendingDraftId)
            .select()
            .single();
          if (updErr) throw updErr;
          const promoted = data as Message;
          // Update the in-memory row so the transcript shows the
          // edited text immediately (it was previously hidden as a
          // draft; now it renders as a normal user message).
          if (threadId === activeThreadId) {
            messages = messages.map((m) =>
              m.id === pendingDraftId
                ? { ...promoted, attachments: m.attachments }
                : m
            );
          }
          userMessageId = pendingDraftId;
          pendingDraftId = null;
        } else {
          const userMsg = await persistUserTurn(threadId, text, sendAttachments);
          userMessageId = userMsg.id;
        }
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
        modelSpec,
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
   * Bank what's in the composer for after the in-flight turn instead of
   * sending it now. Bound to the same submit-modifier Enter that sends
   * when idle (see onKeydown).
   *
   * The keystroke used to route to stop while a reply streamed, which
   * meant a user who thought of something mid-answer had to choose
   * between killing the response and holding the thought. Queueing is
   * the third option: the reply runs to completion, the draft leaves
   * the composer so it can't be lost or double-sent, and it fires the
   * moment the turn settles. The stop BUTTON keeps its cancel meaning -
   * the two affordances now do different things on purpose.
   *
   * Requires an in-flight turn on a materialized thread; with no stream
   * running there is nothing to wait for and onKeydown routes to send()
   * instead.
   */
  function queueMessage(): void {
    const active = activeThreadId ? findThread(activeThreadId) ?? null : null;
    if (!active || active.isDraft || active.archived) return;
    const slot = exchangeStore.peek(active.id);
    if (!slot?.sending) return;
    const profile = resolveModelProfile(app.modelProfiles, active.model ?? null);
    const payload = readComposerPayload(profileModelSpec(profile));
    if (!payload) return;
    slot.queued = [...slot.queued, { id: newLocalId(), ...payload }];
    composer = '';
    pendingAttachments = [];
    // Same "pay attention to the bottom" signal a send gives - the new
    // card lands below the streaming response.
    followBottom = true;
  }

  /**
   * Drop a queued message before it fires.
   *
   * The text and any files that rode with it come back to the composer
   * when the composer is empty, so an accidental queue is one click
   * from being editable again. When the user has already started typing
   * something else the entry is discarded rather than clobbering the
   * draft in front of them - restoring would destroy work to undo work.
   */
  function unqueueMessage(id: string): void {
    const slot = activeSlot;
    if (!slot) return;
    const entry = slot.queued.find((q) => q.id === id);
    if (!entry) return;
    slot.queued = slot.queued.filter((q) => q.id !== id);
    if (composer.trim().length === 0 && pendingAttachments.length === 0) {
      composer = entry.text;
      pendingAttachments = entry.attachments;
    }
  }

  /**
   * Fire this thread's queued messages now that its turn has settled.
   * Called from the tail of every path that ends a turn - runExchange
   * and the reconnect poll - so the queue drains identically whether
   * the reply finished on its own or the user hit stop mid-answer.
   *
   * That shared tail is what makes the stop button's second meaning
   * work: with messages queued, "stop" reads as "cancel this reply and
   * get on with mine." Nothing extra is discarded to make that happen -
   * the abort persists the partial answer and every completed tool
   * round exactly as a bare stop does (see stopStreaming), and the
   * queued rows land after them.
   *
   * The decision of WHETHER to drain - notably the "an errored turn
   * holds the queue back" rule - lives in `shouldDrainQueue`
   * (`$lib/ui/message-queue`), which carries the reasoning and is
   * covered by `tests/message-queue.test.ts`.
   */
  function maybeDrainQueuedMessages(threadId: string): void {
    const slot = exchangeStore.peek(threadId);
    if (!slot) return;
    const drain = shouldDrainQueue(
      slot.queued.length,
      slot.streamingError !== null,
      findThread(threadId) ?? null
    );
    if (!drain) return;
    // Assert `sending` synchronously - before the async body's first
    // await - so the composer, the throbber, and the send button never
    // flicker back to their idle shapes in the gap between this turn's
    // finally and the next turn's runExchange.
    slot.sending = true;
    void runQueuedMessages(threadId, slot);
  }

  async function runQueuedMessages(threadId: string, slot: ExchangeSlot): Promise<void> {
    // Take the whole queue up front: anything the user queues from here
    // on belongs to the turn AFTER this one, not to the batch we are
    // about to persist.
    const batch = slot.queued;
    slot.queued = [];
    // Cleared once runExchange is on the stack - it owns the sending
    // flag's lifecycle from that point, exactly as it does for send().
    let ownsSending = true;
    try {
      const thread = findThread(threadId);
      if (!thread || !app.supabase || !app.venice) return;
      const profile = resolveModelProfile(app.modelProfiles, thread.model ?? null);
      const { reasoningEffort: sendReasoning, disableThinking: sendDisableThinking } =
        thinkingWireForProfile(profile, thread.reasoning_effort ?? null);
      const sendVerbosity: Verbosity = thread.verbosity ?? profile.verbosity;
      const systemMessages: { role: 'system'; content: string }[] = app.systemPrompts
        .filter((p) => activePromptIds.has(p.id) && p.body.trim().length > 0)
        .map((p) => ({ role: 'system' as const, content: p.body }));
      const currentUserId = session?.user.id ?? thread.user_id;

      // Same two pre-flight repairs send() makes. The reconnect poll
      // refetches the thread with listMessages, which can materialize
      // synthetic recovery rows into `messages`, so this path really can
      // meet an unhealed tail; and a turn that suspended on ask_user
      // leaves a pending question the queued message implicitly
      // abandons, the same way typing over the card does.
      try {
        await persistSyntheticRecovery(threadId);
      } catch (err) {
        log.warn('persistSyntheticRecovery failed', err);
      }
      await cancelPendingAskUser(threadId, 'abandoned_on_new_send');

      // Each queued draft becomes its own user row, in the order the
      // user queued them. The turn anchors on the LAST one: it is the
      // newest user message, so commit_assistant_message's
      // newer-user-message conflict check passes. Anchoring on the first
      // would make its own siblings look like a competing device's send.
      let anchor: Message | null = null;
      for (const entry of batch) {
        anchor = await persistUserTurn(threadId, entry.text, entry.attachments);
      }
      if (!anchor) return;

      followBottom = true;
      ownsSending = false;
      await runExchange({
        threadId,
        currentUserId,
        modelId: profile.modelId,
        modelSpec: profileModelSpec(profile),
        systemMessages,
        sendReasoning,
        sendDisableThinking,
        sendVerbosity,
        sendEmphasis: app.emphasisMarkdown,
        sendUserName: app.userName,
        sendUserLocation: app.userLocation,
        originalText: anchor.content,
        userMessageId: anchor.id,
      });
    } catch (err) {
      // A persist failure here has no composer to fall back to - the
      // text left it when the user queued. Surface it on the inline
      // bubble where the queued cards were, so the failure shows up
      // where they were watching.
      log.error('queued send failed', err);
      slot.streamingError = { text: describeError(err) };
    } finally {
      if (ownsSending) slot.sending = false;
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
    /**
     * Capability snapshot of the resolved profile's model at send time
     * (see profileModelSpec). Drives the vision-routing decision below;
     * captured so a profile swap mid-stream can't change how an
     * in-flight turn treats its attachments.
     */
    modelSpec: ModelSpec;
    systemMessages: { role: 'system'; content: string }[];
    sendReasoning: ReasoningEffort | undefined;
    /**
     * Snapshot of the profile's thinking-off kill switch at send time.
     * Captured here for the same reason as sendReasoning: a profile
     * swap mid-stream must not change the wire shape of an in-flight
     * turn. When true, the chat-loop ships `disable_thinking: true`
     * and sendReasoning is forced undefined.
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
    /**
     * DB row ids this exchange replaces (regenerate-from-here and the
     * dead-tail retry). Rides the /stream request into the terminal
     * commit RPC, which excludes these rows from its cross-device
     * conflict check and deletes them atomically with the commit -
     * the browser side only animates and prunes the view. Already
     * filtered to persisted rows (see persistedRowIds); synthetic
     * recovery rows stay in pendingDeleteIds for the in-memory prune
     * only. Omitted on plain sends.
     */
    supersededIds?: string[];
    /**
     * True on a second-thoughts refinement turn (Chat.svelte
     * `refineFrom`). Two effects: server-side standard priming is
     * skipped (this is the model reconsidering itself, not a new user
     * round - see `skipPriming`), and the wire history carries the
     * doubt because `refineFrom` marked the original row's verdict
     * `acted` before the run, so `toVeniceMessage` projects the
     * `<think>` connective onto it. No separate ephemeral splice is
     * needed.
     */
    isRefinement?: boolean;
    /**
     * The doubt note seeding a refinement turn. Forwarded to the server
     * so its priming stage can run the targeted read-only samskara
     * probe (cross-thread patterns that bear on whether the misgiving
     * holds). Set by `refineFrom` alongside `isRefinement`.
     */
    refinementDoubtNote?: string;
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

    // Clear the persistent error card optimistically at the start of
    // a new exchange against THIS thread. The displayed error
    // represents the most recent unresolved failure; sending a new
    // message - whether via Retry on the error card, a fresh user
    // prompt, or any other entry into runExchange - is the user
    // implicitly trying to resolve it, so the card should disappear
    // immediately rather than lingering through the in-flight period.
    // commit_assistant_message clears threads.last_error server-side
    // on the happy path, and any new terminal-error path writes a
    // fresh payload that overwrites; this optimistic patch just
    // closes the visual gap between "user clicked retry" and "server
    // confirmed it cleared." Scoped to the active thread because
    // background re-runs against a non-active thread shouldn't reach
    // into the in-memory row for a thread the user isn't looking at.
    if (ctx.threadId === activeThreadId) {
      const t = findThread(ctx.threadId);
      if (t?.last_error) {
        void clearThreadLastError();
      }
    }

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
    // Pre-resolve short-lived signed URLs for the live image attachments
    // so the wire builder hands Venice a URL it fetches server-side - the
    // bytes never touch the client, and history replay just re-signs
    // rather than re-shipping base64. Vision models only; resolved once and
    // captured by the closure so the in-loop 429 retry reuses it.
    // Best-effort: a signing failure just means those images don't inline
    // this turn (the non-vision note path still tells the model they exist).
    // Did the user message that opened this turn bring a file? Drives the
    // chat-loop's anti-fabrication reinforcement so the model is told to
    // ground its claims in the inlined content / analyze_image rather than
    // answer from the filename. Keyed on the opening user message id (not
    // "any attachment in the thread") so a later text-only turn doesn't
    // trigger it. Recomputed cheaply each attempt; constant across retries.
    const currentTurnHasAttachments = messages.some(
      (m) => m.id === ctx.userMessageId && (m.attachments?.length ?? 0) > 0
    );

    let attachmentImageUrls = new Map<string, string>();
    if (ctx.modelSpec.supportsVision && app.supabase) {
      const liveImages = messages
        .filter((m) => !pendingDeleteSet.has(m.id))
        .flatMap((m) => m.attachments ?? [])
        .filter((a) => a.mime_type.startsWith('image/') && a.storage_path !== null);
      if (liveImages.length > 0) {
        try {
          attachmentImageUrls = await app.supabase.createAttachmentSignedUrls(liveImages);
        } catch {
          attachmentImageUrls = new Map();
        }
      }
    }

    const buildHistoryOnWire = (): VeniceMessage[] => {
      const rows = messages.filter((m) => !pendingDeleteSet.has(m.id));
      // While a fork's title still carries the fork marker,
      // withForkPointMarker splices the FORK POINT line into the wire
      // at the inherited/own boundary so the model can locate the
      // seam its metadata fork-nudge refers to. Wire-only - the
      // display list never shows it - and gone the moment the fork is
      // renamed (see docs/dev/forking.md).
      const conversation = withForkPointMarker(
        rows.map((m) =>
          toVeniceMessage(m, {
            visionSpec: ctx.modelSpec,
            imageUrls: attachmentImageUrls,
          })
        ),
        rows,
        ctx.threadId,
        findThread(ctx.threadId)?.title
      );
      return [...ctx.systemMessages, ...conversation];
    };

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

    // Throttle both streaming buffers - the answer text and the
    // reasoning trace - to ~20Hz while the response arrives. Every
    // assignment to slot.streamingText drives <Markdown> to re-run
    // marked + DOMPurify + highlight.js over the full growing buffer,
    // and every assignment to slot.streamingReasoning reflows the open
    // reasoning panel; reasoning models emit the thinking trace at
    // hundreds of deltas/sec, so flushing either channel on each SSE
    // delta would peg the main thread and make long responses land in
    // visible gulps. Trailing-edge throttle on a single shared timer:
    // the first delta on either channel schedules a 50ms timer, deltas
    // arriving inside that window coalesce into the latest `pendingText`
    // / `pendingReasoning`, and one flush commits both buffers when the
    // timer fires. Side effect: ~50ms of "thinking dots" before the
    // first rendered paint, which reads as intentional pacing.
    const FLUSH_MS = 50;
    let pendingText: string | null = null;
    let pendingReasoning: string | null = null;
    let flushTimer = 0;
    const flushPending = (): void => {
      flushTimer = 0;
      if (pendingText !== null) {
        slot.streamingText = pendingText;
        pendingText = null;
        // Retire the subconscious checklist the instant the answer text
        // actually paints (not on the first not-yet-flushed byte). The
        // checklist lives in the response card and the card mounts only
        // while it has content; dismissing here, where streamingText goes
        // non-empty in the same tick, hands the card straight from
        // checklist to streaming text with no content-less frame between
        // them - dismissing on the first delta instead would blank the
        // card for the ~50ms flush window and flicker its border out and
        // back. Sticky and idempotent: stays dismissed across later
        // flushes and round boundaries. The reasoning branch below
        // dismisses on the same principle when the thinking paints.
        slot.subconsciousDismissed = true;
      }
      if (pendingReasoning !== null) {
        slot.streamingReasoning = pendingReasoning;
        pendingReasoning = null;
        // Same checklist-dismissal logic as the text branch: dismiss when
        // the thinking actually paints, not on the first not-yet-flushed
        // reasoning byte, so the card never blanks for the flush window
        // between checklist and the first visible reasoning. On a
        // reasoning model this is the channel that fires first.
        slot.subconsciousDismissed = true;
      }
      // Piggyback the IDB draft flush on every display flush (~50ms).
      // Best-effort: a write failure is swallowed so a broken IDB never
      // stalls the visible render path.
      void updateDraftText(ctx.threadId, slot.streamingText, slot.streamingReasoning).catch(() => {});
    };
    // Arm the shared flush timer if it isn't already running. Both
    // streaming channels call this; the leading delta on whichever
    // channel arrives first owns the timer for the window.
    const armFlush = (): void => {
      if (flushTimer === 0) {
        flushTimer = window.setTimeout(flushPending, FLUSH_MS);
      }
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

    // Auto-titling does not fire from here. The server-side auto-title
    // agent (supabase/functions/venice/agents/auto_title.ts) polls the
    // threads table for rows still on the 'New conversation'
    // placeholder and titles them in the background, surviving page
    // closes / refreshes. The chat-loop's metadata message stays
    // silent about titles on round 1 (the agent owns naming there)
    // and falls back to the loud nag on round 2+ if the agent hasn't
    // landed yet. See docs/dev/auto-title.md for the full pipeline.

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
          supersededIds: ctx.supersededIds,
          reasoningEffort: ctx.sendReasoning,
          disableThinking: ctx.sendDisableThinking,
          verbosity: ctx.sendVerbosity,
          emphasisMarkdown: ctx.sendEmphasis,
          userName: ctx.sendUserName,
          userLocation: ctx.sendUserLocation,
          displayTimezone: app.displayTimezone || null,
          lastAssistantTimestamp: findLastAssistantTimestamp(),
          // A refinement turn skips the standard priming stage: it is
          // the model reconsidering its own answer (not a new user
          // round), it carries its own <think> doubt (projected onto
          // the acted original row by toVeniceMessage), and re-running
          // priming would double-fire samskara for the round and bury
          // that doubt. Omitting the intuition/recall inputs disables
          // those pipelines; `skipPriming` suppresses the samskara
          // chain + bias. What a refinement DOES get is the targeted
          // doubt-keyed samskara probe (`refinementDoubtNote`), so the
          // full-context deliberation can weigh the reviewer's twinge
          // against learned cross-thread patterns.
          intuitionModelId: ctx.isRefinement ? undefined : agentModel('intuition').id,
          intuitionMood: ctx.isRefinement ? null : intuitionMoodArg,
          skipPriming: ctx.isRefinement ? true : undefined,
          refinementDoubtNote: ctx.isRefinement ? ctx.refinementDoubtNote : undefined,
          currentTurnHasAttachments,
          // Same spec that routed the images above: on a vision tier
          // they inline as image_url parts, and the metadata message
          // must not tell the model to analyze_image what it already
          // sees.
          modelSupportsVision: ctx.modelSpec.supportsVision,
          // Dynamic MCP-integration toolboxes, built at turn entry
          // from app state. Each authorized integration becomes a
          // gated `mcp:<id>` toolbox the model can toggle on; the
          // chat-loop composes them with the static catalog under one
          // dedup-by-name pass. Built here (not in loop.ts) so the
          // loop stays free of a global `app` dependency and stays
          // unit-testable with an explicit mcpToolboxes arg.
          mcpToolboxes: buildMcpToolboxes(app.mcpIntegrations, app.mcpToolSchemas),
          // Topic-boundary recall rides the same trigger machinery as
          // intuition (cold-start, mid-turn title shift, mood shift,
          // stale fuse). Enabled by default in production - the
          // chat-loop's parallel fan-out keeps the wall-clock cost
          // bounded by max(intuition, context-recall) and the cache
          // turns later turns into no-ops on the same trigger fire.
          // Off on a refinement turn (see the priming note above).
          contextRecallEnabled: ctx.isRefinement ? false : true,
          handlers: {
            onTextUpdate: (t) => {
              pendingText = t;
              armFlush();
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
                // Reasoning has yielded to the answer: freeze the
                // elapsed-ms pill at the final thinking duration. Only
                // when this round actually thought (reasoningStartedAt
                // set) and not already frozen. Independent of the panel's
                // open state - the pill stays whether the panel is open
                // or collapsed.
                if (slot.reasoningStartedAt !== null && slot.reasoningEndedAt === null) {
                  slot.reasoningEndedAt = performance.now();
                }
                // Checklist dismissal happens in flushPending, when the
                // first text actually paints - see the note there for why
                // it can't fire on this not-yet-flushed first byte.
                // pendingReasoning is OR'd in because reasoning now rides
                // the same throttle: a fast first text delta can land
                // before the leading reasoning buffer has flushed, so
                // slot.streamingReasoning may still be empty even though
                // reasoning content arrived and the panel is open.
                // Skipped once the user has taken manual control - their
                // explicit choice wins until the card is delivered.
                if (
                  !slot.reasoningUserToggled &&
                  slot.streamingReasoningOpen &&
                  (slot.streamingReasoning.length > 0 || pendingReasoning !== null)
                ) {
                  reasoningCloseTimer = window.setTimeout(() => {
                    slot.streamingReasoningOpen = false;
                    reasoningCloseTimer = 0;
                  }, 600);
                }
              }
            },
            onReasoningUpdate: (t) => {
              // Coalesce reasoning deltas through the same trailing-edge
              // throttle as the answer text. The buffer commits in
              // flushPending, and the subconscious-checklist dismissal
              // moved there with it (see the reasoning branch in
              // flushPending) so the card doesn't blank between the
              // checklist and the first painted reasoning.
              pendingReasoning = t;
              armFlush();
              // First reasoning delta of the round: stamp the start (the
              // elapsed-ms pill reads it) and open the panel so the user
              // watches the thinking stream in. Set eagerly here rather
              // than on the throttled flush so streamingReasoningOpen is
              // already true when the first reasoning buffer paints -
              // ReasoningPanel guards its markup on reasoning.length > 0,
              // so there's no empty-panel frame.
              //
              // Open ONLY on this first delta, never re-asserted on later
              // ones. Re-opening on every delta (the prior shape) is what
              // made a mid-stream collapse impossible: the next delta
              // after a manual or auto collapse snapped the panel back
              // open within ~50ms. The user's explicit collapse now
              // sticks because nothing re-opens behind it.
              if (slot.reasoningStartedAt === null) {
                slot.reasoningStartedAt = performance.now();
                if (!slot.reasoningUserToggled) slot.streamingReasoningOpen = true;
              }
              // Auto-collapse once the thought runs long (length / first
              // sentence boundary past the floor - see
              // reasoningShouldCollapse). Gated on the panel still being
              // open and the user not having taken manual control; once it
              // collapses, `open` is false so later deltas short-circuit
              // before the regex. A short thought that never crosses the
              // boundary stays open through to the answer hand-off.
              if (
                slot.streamingReasoningOpen &&
                !slot.reasoningUserToggled &&
                !slot.streamingContentStarted &&
                reasoningShouldCollapse(t)
              ) {
                slot.streamingReasoningOpen = false;
              }
            },
            onAssistantPersisted: (msg) => {
              // Cancel any pending frame — the persisted row takes
              // over rendering and we don't want a stale flush to
              // replay the text or reasoning into the slot after this.
              cancelPending();
              pendingText = null;
              pendingReasoning = null;
              // Always buffer into the slot so a thread-switch + return
              // can replay this row via mergeMessagesById; only mutate
              // the screen's `messages` if the user is currently
              // viewing this thread.
              slot.recordPersistedRow(msg);
              if (ctx.threadId === activeThreadId) {
                appendMessage(msg);
                // Freeze this row's reasoning pills so they survive the
                // handoff from streaming bubble to persisted card (see
                // reasoningPillsById). Captured before the per-round reset
                // below nulls the timing. Duration comes from the slot's
                // start/end stamps; the char count from the persisted
                // reasoning text (msg.reasoning), which is the same string
                // the card renders. Only rows that actually thought get an
                // entry.
                if (slot.reasoningStartedAt !== null) {
                  const end = slot.reasoningEndedAt ?? performance.now();
                  const elapsed = reasoningElapsedPill(slot.reasoningStartedAt, end, end);
                  const chars = reasoningCharPill((msg.reasoning ?? '').length);
                  if (elapsed !== null || chars !== null) {
                    reasoningPillsById[msg.id] = { elapsed, chars };
                  }
                }
                // Only a completed terminal answer gets a second-thoughts
                // verdict (the reviewer runs on `terminalKind==='completed'`,
                // never on tool-call rounds or aborted/error tails). Schedule
                // the delayed re-fetch backstop for exactly that row so a
                // dropped realtime echo doesn't leave the verdict invisible
                // until a manual refresh.
                if (msg.status === 'complete') {
                  scheduleVerdictBackfill(msg.id, ctx.threadId);
                }
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
              // Per-round reset of the reasoning interaction + timing
              // state: the card is delivered, so the next round's
              // reasoning starts under automation again and the user's
              // manual choice no longer applies (per-round, per #3).
              slot.reasoningUserToggled = false;
              slot.reasoningStartedAt = null;
              slot.reasoningEndedAt = null;
              if (reasoningCloseTimer !== 0) {
                window.clearTimeout(reasoningCloseTimer);
                reasoningCloseTimer = 0;
              }
              // The replacement response for any discarded slop attempts
              // has now landed - retire their notice cards with the
              // CRT-power-off animation.
              dismissSlopNotices(slot);
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
              //
              // Before overwriting, capture the about-to-be-displaced
              // payload into the per-thread history Map so the Recall
              // modal can show it under the new one. The retention
              // decision (skip duplicates from cross-tab realtime
              // echoes) and the next-Map computation both live in
              // $lib/ui/recall; this site is glue.
              const existing = findThread(ctx.threadId);
              const displaced = existing
                ? coerceContextRecallPayload(existing.context_recall_payload)
                : null;
              if (displaced !== null && shouldRetainDisplaced(displaced, payload)) {
                contextRecallHistory = appendContextRecallHistory(
                  contextRecallHistory,
                  ctx.threadId,
                  displaced
                );
              }
              patchThread(ctx.threadId, {
                context_recall_payload: payload,
              });
            },
            onSubconsciousStart: (op) => {
              // A pre-response priming pipeline (samskara fire,
              // intuition, or context recall) began for this turn. Mark
              // it 'running' so a spinner row shows in the checklist.
              slot.subconsciousStatus.set(op, 'running');
            },
            onSubconsciousEnd: (op) => {
              // Pipeline settled (fresh payload, empty, or error - the
              // row only signals liveness, so we don't branch on
              // outcome). Flip the row to 'done' so its spinner checks
              // off in place. Guarded on has(): this can fire after the
              // exchange already reset the slot - the samskara fire
              // outruns the priming race timeout and can resolve once
              // streaming is well underway, so its End lands late. Once
              // the map's been cleared (or the checklist dismissed),
              // re-setting here would resurrect a stale checkmark, so we
              // only flip an entry that's still present.
              if (slot.subconsciousStatus.has(op)) {
                slot.subconsciousStatus.set(op, 'done');
              }
            },
            onBegin: () => {
              // Priming complete, completion starting. Dismiss the
              // pregame card so it does not stay visible when a model
              // emits tool calls without preamble text. Without this,
              // the card only dismisses on the first text/reasoning
              // delta, which non-reasoning models may not emit before
              // calling tools.
              slot.subconsciousDismissed = true;
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
            onGuardRetry: ({ guard }) => {
              // An output guard discarded this attempt (e.g. a leaked
              // special token) and the loop is re-rolling. Drop an
              // "oops, all slop!" notice card and clear the streaming
              // buffers so the replacement renders into a clean bubble.
              // None of the discarded text reached us, so there's
              // nothing to strike through - the notice stands in for
              // the junk. The card is animated away by
              // dismissSlopNotices once the replacement persists.
              cancelPending();
              pendingText = null;
              pendingReasoning = null;
              slot.slopNotices.push({
                id:
                  globalThis.crypto?.randomUUID?.() ??
                  `slop-${Date.now()}-${slot.slopNotices.length}`,
                guard,
                dying: false,
              });
              slot.streamingText = '';
              slot.streamingReasoning = '';
              slot.streamingReasoningOpen = false;
              slot.streamingContentStarted = false;
              // The re-roll is a fresh attempt at this round: clear the
              // reasoning timing + manual-toggle so the replacement's
              // first reasoning delta opens a clean panel and the pill
              // counts from the new start, not the discarded attempt's.
              slot.reasoningUserToggled = false;
              slot.reasoningStartedAt = null;
              slot.reasoningEndedAt = null;
            },
          },
        });

      try {
        // Rate-limit retries are handled inside the chat-loop now
        // (see streamChatWithRateLimitRetry in chat/loop.ts), which
        // sleeps for the duration parsed from Venice's Retry-After /
        // x-ratelimit-reset-* headers and re-issues the request up
        // to RATE_LIMIT_MAX_ATTEMPTS times. By the time a rate_limit
        // error reaches this catch the inner retry has exhausted; we
        // surface it to the user immediately rather than retrying
        // again with a flat backoff.
        loopResult = await oneAttempt();
      } finally {
        // Commit anything pending synchronously so post-loop code sees
        // the final state - both the answer text and the reasoning
        // trace, since both now ride the shared throttle.
        cancelPending();
        if (pendingText !== null) {
          slot.streamingText = pendingText;
          pendingText = null;
        }
        if (pendingReasoning !== null) {
          slot.streamingReasoning = pendingReasoning;
          pendingReasoning = null;
        }
      }
      // Regenerate-from-here view-side exit. The DB delete of the
      // replaced rows is NOT done here: the terminal commit RPC
      // (commit_assistant_message, supabase/schema.sql) deleted them
      // in the same transaction that flipped the new row to
      // 'complete', so a turn that never commits leaves the originals
      // untouched and a browser that dies after the commit cannot
      // strand them. What remains browser-side is the fade-out
      // animation and the in-memory prune.
      //
      // The branch condition mirrors the RPC's own delete guard, so
      // the view never drops rows the server kept:
      //   - trimmed finalText non-empty: the RPC skips the delete
      //     when the committed content trims to empty (reasoning-only
      //     re-roll), and a stopped-by-limit-with-no-text outcome is
      //     treated as a failure so the greyed rows can be restored.
      //   - no conflict: on a commit conflict the response was
      //     discarded server-side and the superseded rows kept.
      //
      // Sequence:
      //   1. Compute a per-row animation-delay, staggered newest
      //      first - highest index in `messages` gets delay 0, each
      //      older row gets +250ms. This makes the tail visibly
      //      unwind back toward the user's prompt rather than
      //      collapsing all at once.
      //   2. Wait for the total animation runtime, then prune the
      //      rows from `messages` (which drops them from the DOM)
      //      and clear both the fade delays and the pending-delete
      //      id list in one state flip.
      // `!interrupted` is load-bearing: an aborted regenerate can
      // still carry partial finalText, but the server never ran the
      // commit RPC, so the superseded rows are all still in the DB.
      // Pruning them here made the view lie until the next reload
      // rebuilt the rows (and left the aborted partial as an orphan
      // below them).
      if (
        pendingDeleteIds.length > 0 &&
        loopResult.finalText.trim().length > 0 &&
        !loopResult.interrupted &&
        !loopResult.conflictDetected
      ) {
        const idsToDelete = pendingDeleteIds;
        // The fade-out animation + `messages` filter are visible only
        // when the user is actually looking at this thread; for a
        // background exchange we skip the animation and let the next
        // selectThread reload see the deleted rows missing from
        // listMessages.
        if (ctx.threadId === activeThreadId) {
          await fadeOutAndPruneRows(idsToDelete);
        }
        pendingDeleteIds = [];
      } else if (pendingDeleteIds.length > 0) {
        // No replacement landed: the re-roll produced no replaceable
        // text (a reasoning-only completion, or a turn that suspended
        // on ask_user), or the commit was discarded as a conflict (a
        // genuinely-foreign user message landed mid-stream - the RPC
        // excludes the superseded rows themselves from that check).
        // In every case the server kept the old rows, so don't prune
        // them from the view. But the regenerate greying
        // (.regen-target + disabled action buttons, keyed off
        // pendingDeleteSet) has to clear regardless, or the old rows
        // sit frozen and uninteractable until a thread reload.
        pendingDeleteIds = [];
        fadeOutDelays = {};
      }
      if (loopResult.stoppedByLimit && !loopResult.finalText) {
        error = { text: 'Stopped: the tool-call loop hit its round limit.' };
      }
      // Conflict: another device inserted a user message while we were
      // streaming. The generated assistant row was discarded server-side
      // (and on a regenerate, the rows marked for replacement were kept;
      // the commit RPC exempts those from this check, so a conflict here
      // means a genuinely-foreign send). Show an inline error so the
      // user knows to look at the other device for the new context - no
      // retry closure because the right action is to navigate away and
      // back once the other turn lands.
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
            // Pass the raw title (possibly empty); the notification
            // function decides the heading shape based on whether
            // there's a meaningful title to interpolate.
            title: threadForNotif?.title ?? '',
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
      // Live Broadcast stream dropped mid-turn (socket loss while the
      // tab was backgrounded, or a transient network blip). This is NOT
      // a turn failure: the edge-function orchestrator runs detached
      // under EdgeRuntime.waitUntil and is unaffected by the browser
      // losing its socket - it is still streaming into the row, or has
      // already committed it. Broadcast events are ephemeral, so the END
      // that closes the live stream may have fired into the dead socket;
      // trusting the live path here would either hang forever or surface
      // a spurious "response was cut off" banner for a turn that the
      // server actually finished. Hand off to the same poll-the-row
      // reconnect a fresh tab uses (see reconnectInflightTurn and
      // docs/dev/chat.md "Reconnect POLLS the DB row"). We release the
      // dead live turn's hold on the slot first - the claim because the
      // edge function, not this tab, now owns the response; `sending` so
      // reconnectInflightTurn's own sending lifecycle isn't blocked by
      // its guard. The outer finally still runs after this returns
      // (release is idempotent), tearing down draft + wake lock.
      if (err instanceof StreamDisconnectedError) {
        const seedPartial = slot.streamingText;
        log.info('live stream disconnected mid-turn; handing off to reconnect poll');
        await claim.release();
        slot.sending = false;
        slot.abortCtl = null;
        // A regenerate's superseded rows are deleted server-side (the
        // commit RPC drops them atomically with the terminal commit),
        // and the reconnect path's listMessages refetch is what
        // reconciles the view - so the greying must not outlive this
        // handoff. If the turn ends up not committing, the rows are
        // still in the DB and the refetch restores them ungreyed.
        pendingDeleteIds = [];
        fadeOutDelays = {};
        await reconnectInflightTurn(ctx.threadId, seedPartial);
        return;
      }
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
      // snaps back to the .regen-target appearance instead of staying
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
      } else if (err instanceof Error && err.message.startsWith('Stream guard "')) {
        // Guard exhaustion: the model kept emitting a junk completion
        // (e.g. a leaked special token) past the output guard's re-roll
        // cap. The server collapses GuardExhaustedError to kind='internal'
        // on the Broadcast error event, so the browser receives it as a
        // VeniceError - not a GuardExhaustedError instance. Detect it by
        // the message prefix, same as getStreamingResponse.ts does for
        // threads.last_error. Re-sending is the right move because the
        // failure is stochastic, so park a retry closure next to the
        // message, same as the rate-limit path.
        slot.streamingError = {
          text: 'The model kept returning a malformed response. Try again.',
          retry: () => {
            void runExchange(ctx);
          },
        };
      } else {
        slot.streamingError = { text: describeError(err) };
      }
    } finally {
      // Retire any slop-notice cards still showing - on the success
      // path onAssistantPersisted already animated them out, but a
      // terminal path that never persisted a replacement (conflict,
      // stopped-by-limit, guard exhaustion, abort) would otherwise
      // leave them stranded above the transcript.
      dismissSlopNotices(slot);
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
      // Freeze a reasoning timer that never saw an answer delta (a turn
      // aborted or errored mid-thought, or a reasoning-only round). Left
      // live, reasoningEndedAt stays null and the elapsed-ms rAF ticker
      // would spin forever after sending flips false. Same BEFORE-sending
      // ordering as the tool finalize above.
      if (slot.reasoningStartedAt !== null && slot.reasoningEndedAt === null) {
        slot.reasoningEndedAt = performance.now();
      }
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
    // The turn has fully settled, including the finally's claim release -
    // so anything the user queued while it ran can go out now. Fired
    // AFTER the try/finally rather than inside it so the new exchange
    // acquires the cross-device claim this one has already dropped, and
    // deliberately not awaited so the queue chains as a sequence of
    // sibling turns rather than nesting one promise inside the last.
    // The StreamDisconnectedError branch returns from the catch instead
    // of reaching here; that path hands off to reconnectInflightTurn,
    // whose own tail drains.
    maybeDrainQueuedMessages(ctx.threadId);
  }

  /**
   * Re-attach to an assistant turn that runs in the edge function while
   * this tab can no longer follow it on the live Broadcast stream. Two
   * callers:
   *   - selectThread, when the loaded transcript tail carries a
   *     `status='streaming'` row AND no slot on this device is already
   *     producing it (a backgrounded mobile PWA that got discarded, a
   *     fresh tab, a hard reload).
   *   - runExchange's catch, when the live stream this very tab was
   *     draining drops mid-turn (StreamDisconnectedError - socket loss
   *     while backgrounded, a network blip). The dead live turn releases
   *     the slot first, then hands off here.
   *
   * The turn runs entirely inside the edge function and survives the
   * disconnect. We do NOT try to resume the live Broadcast stream: its
   * events are ephemeral, so whatever fired while this tab was gone -
   * including the single END that signals completion - is unrecoverable,
   * and re-subscribing only ever caught events from that point on. That
   * is exactly what produced the two failure cards: a re-subscribe that
   * timed out on a not-yet-recovered mobile socket (the "disconnected"
   * banner), or a wait for an END that already fired / a stale-row
   * janitor write (the persistent red error).
   *
   * Instead we POLL the row to a terminal state via awaitStreamSettled
   * (which re-probes /stream reconnectOnly), show a "Reconnecting"
   * throbber over the partial-so-far, then re-fetch the thread and render
   * the committed rows from the DB. In effect this behaves exactly as if
   * the user reopened the thread after the turn finished in the
   * background - the only thing we can honestly show, and robust to the
   * mobile realtime socket dropping.
   *
   * `sending` gates the throbber + composer the same as a live turn;
   * `reconnecting` only re-labels the throbber. Skips everything a live
   * turn needs (claim acquire, priming, draft persistence) - the function
   * already owns all of that on the producing side.
   */
  async function reconnectInflightTurn(
    threadId: string,
    seedPartial: string,
  ): Promise<void> {
    if (!app.supabase) return;
    const slot = exchangeStore.slotFor(threadId);
    if (slot.sending) return;
    const supabase = app.supabase;

    slot.reset();
    slot.sending = true;
    slot.reconnecting = true;
    slot.abortCtl = new AbortController();
    // Paint the partial-so-far so the user sees where the reply got to,
    // not a bare spinner. Two seed sources: selectThread passes the
    // streaming row's persisted content; the live-disconnect handoff
    // passes whatever the dropped stream had buffered. onProgress grows
    // it as the function persists more content while we poll.
    slot.streamingText = seedPartial;
    slot.subconsciousDismissed = true;
    // Wake-lock parity with a live turn: a reconnecting turn is still
    // producing, so keep the device awake until it settles.
    void acquireWakeLock();

    try {
      await awaitStreamSettled(
        supabase.client,
        { threadId },
        {
          signal: slot.abortCtl.signal,
          onProgress: (completedSoFar) => {
            // Full content-so-far, not a delta - assign, don't append.
            slot.streamingText = completedSoFar;
          },
        },
      );
      // Settled: the row reached a terminal status (or the server's
      // stale-row janitor swept it). Re-fetch the thread and render the
      // canonical rows - the committed assistant row, any tool rows, and
      // any threads.last_error the function wrote all live in the DB now.
      // Guarded on the active thread: a background reconnect (user
      // navigated away mid-poll) just clears its slot; the next
      // selectThread re-fetches when they return.
      if (threadId === activeThreadId) {
        const fresh = await supabase.listMessages(threadId);
        messages = mergeMessagesById(fresh, slot.persistedRows, threadId);
        log.debug(
          `reconnect settled thread=${threadId} tail=${fresh.at(-1)?.role ?? 'empty'}` +
            ` tailStatus=${fresh.at(-1)?.status ?? 'none'} rows=${fresh.length}`,
        );
        // The turn settled past the user row, so the IDB streaming
        // draft from the pre-reload session is no longer an orphan -
        // clearing it here keeps the "previous response was
        // interrupted" banner from resurfacing under the committed
        // reply. A tail still on the user row (the turn errored before
        // persisting anything) keeps the draft: it remains the fuel
        // for a retry.
        if (fresh.at(-1)?.role !== 'user') {
          if (interruptedDraft?.threadId === threadId) interruptedDraft = null;
          void deleteDraft(threadId).catch(() => {});
        }
      }
    } catch (err) {
      // awaitStreamSettled resolves (never rejects) on abort or the
      // max-wait ceiling, so a throw here is an unexpected listMessages
      // failure. Don't paint a banner - the turn's terminal state
      // (including any last_error the function persisted) renders through
      // the normal surfaces on the next realtime UPDATE or thread reopen.
      log.warn('reconnectInflightTurn failed', err);
    } finally {
      slot.streamingText = '';
      slot.streamingReasoning = '';
      slot.finalizePendingToolTimings();
      slot.sending = false;
      slot.reconnecting = false;
      slot.abortCtl = null;
      if (!exchangeStore.slots().some((s) => s.sending)) {
        releaseWakeLock();
      }
    }
    // Second of the two turn-settled tails (runExchange has the other).
    // A turn the user queued messages against can end here rather than
    // there whenever the live stream dropped and this poll took over,
    // so the drain has to hang off both or the queue strands on exactly
    // the flaky-connection turns it is most annoying to lose.
    maybeDrainQueuedMessages(threadId);
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
    const profile = resolveModelProfile(app.modelProfiles, active.model ?? null);
    // Resolve thinking level -> wire knobs; mirror of the send() path.
    const { reasoningEffort: sendReasoning, disableThinking: sendDisableThinking } =
      thinkingWireForProfile(profile, active.reasoning_effort ?? null);
    const sendVerbosity: Verbosity = active.verbosity ?? profile.verbosity;
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
      modelId: profile.modelId,
      modelSpec: profileModelSpec(profile),
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

  /**
   * Staggered fade-out then prune of a set of message rows from the
   * view. Shared by the regenerate path (replaced rows unwind as the
   * new turn lands) and deleteFrom (the deleted range unwinds after the
   * DB delete). The tail fades newest-first - the highest index gets
   * delay 0, each older row +250ms - so the rows visibly unwind back
   * toward the anchor rather than collapsing at once. Resolves once the
   * rows are gone from `messages` and the delays are cleared. Callers
   * own deciding WHETHER to animate (e.g. background exchanges skip it).
   */
  async function fadeOutAndPruneRows(idsToDelete: string[]): Promise<void> {
    if (idsToDelete.length === 0) return;
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
    const totalMs = (orderedNewestFirst.length - 1) * STAGGER_MS + ANIM_MS;
    await new Promise<void>((resolve) => window.setTimeout(resolve, totalMs));
    const drop = new Set(idsToDelete);
    messages = messages.filter((m) => !drop.has(m.id));
    fadeOutDelays = {};
  }

  /**
   * Paint the would-be-deleted range red while the user hovers the
   * user-message delete button, reusing the same .regen-target hover
   * channel the Regenerate button uses (the visual language - red
   * outline on doomed rows - is identical). Cleared on leave by the
   * shared clearRegeneratePreview.
   */
  function previewDeleteFrom(userMessageId: string): void {
    if (activeSlot?.sending) return;
    hoverRegenerateIds = computeDeleteFromRangeIds(messages, userMessageId);
  }

  /**
   * Delete a user message and everything after it, reverting the thread
   * to its state just before that message was sent. Nothing re-runs -
   * this is the destructive half of regenerate without the re-send.
   *
   * The DB delete only carries persisted rows (synthetic recovery rows
   * have sentinel ids no row matches); the in-memory fade-out prunes the
   * full range. Server-side, message FKs cascade or clear (see
   * SupabaseService.deleteMessages), so the thread's derived state
   * (summary, reflection, topics, wiki, evaluation watermarks) simply
   * re-runs from a cleared mark on the next worker cycle.
   */
  async function deleteFrom(userMessageId: string): Promise<void> {
    if (activeSlot?.sending || !app.supabase) return;
    const active = activeThreadId ? findThread(activeThreadId) ?? null : null;
    if (!active || active.isDraft || active.archived) return;
    const rangeIds = computeDeleteFromRangeIds(messages, userMessageId);
    if (rangeIds.length === 0) return;
    if (!confirm('Delete this message and everything after it?')) return;
    // Decide destructive vs edit-fork against FRESH child-fork state -
    // the cached set only drives tooltips, and a fork minted on
    // another device since the last refresh must not have its history
    // edited out from under it.
    let freshForkPoints: Set<string>;
    try {
      freshForkPoints = new Set(await app.supabase.listChildForkPointIds(active.id));
    } catch (e) {
      error = { text: e instanceof Error ? e.message : 'Failed to check for forks.' };
      return;
    }
    childForkPointIds = freshForkPoints;
    if (sharedRowIds(messages, active.id, freshForkPoints).has(userMessageId)) {
      await deleteFromViaFork(active, userMessageId);
      return;
    }
    // Red-outline the doomed range during the await the same way
    // regenerate does, then drop the hover channel so pendingDeleteSet
    // is the sole source of .regen-target through the fade-out.
    pendingDeleteIds = rangeIds;
    hoverRegenerateIds = [];
    try {
      await app.supabase.deleteMessages(persistedRowIds(messages, rangeIds));
    } catch (e) {
      // The rows survived server-side, so clear the greying and surface
      // the failure rather than pruning a view that no longer matches
      // the DB.
      pendingDeleteIds = [];
      error = { text: e instanceof Error ? e.message : 'Failed to delete messages.' };
      return;
    }
    await fadeOutAndPruneRows(rangeIds);
    pendingDeleteIds = [];
  }

  /**
   * Delete-from-here inside a shared region: the doomed range is
   * history some other conversation depends on, so nothing is
   * destroyed. Fork at the closest anchorable row before the range
   * (the fork inherits exactly what the user keeps), hide the edited
   * thread, and swap the selection - the drawer shows "the same
   * conversation, minus the deleted turns", while every other
   * timeline keeps the unchanged history. With nothing anchorable
   * before the range this degenerates to a fresh empty thread
   * carrying the same title and pins (a fork with an empty prefix is
   * just a new thread; no parent link needed).
   *
   * Order matters: the replacement is created BEFORE the old thread
   * is hidden, so a failure between the two leaves both visible (a
   * duplicate-looking drawer row, annoying but recoverable) rather
   * than neither.
   */
  async function deleteFromViaFork(active: Thread, userMessageId: string): Promise<void> {
    if (!app.supabase) return;
    const anchor = deleteForkAnchor(messages, userMessageId);
    try {
      const replacement = anchor
        ? await app.supabase.forkThread(active.id, anchor.id, { markTitle: false })
        : await app.supabase.createThread(
            active.title,
            active.model,
            active.reasoning_effort,
            active.verbosity,
            active.title_manually_set,
            active.toolboxes_enabled
          );
      rebucketThread(replacement);
      await selectThread(replacement.id);
      await app.supabase.deleteThread(active.id);
      removeThread(active.id);
    } catch (e) {
      error = { text: e instanceof Error ? e.message : 'Failed to fork the conversation.' };
    }
  }

  async function regenerateFrom(assistantMessageId: string): Promise<void> {
    if (activeSlot?.sending || !app.supabase || !app.venice) return;
    const active = activeThreadId ? findThread(activeThreadId) ?? null : null;
    if (!active || active.isDraft || active.archived) return;
    const clickedIdx = messages.findIndex((m) => m.id === assistantMessageId);
    if (clickedIdx === -1) return;
    const rangeIds = computeRegenerateRangeIds(messages, assistantMessageId);
    // computeRegenerateRangeIds returns [] when the input is malformed
    // (no preceding user message, the clicked id isn't in the array,
    // or no rows follow the user message). Bail rather than send an
    // empty turn.
    if (rangeIds.length === 0) return;
    // Walk back to the user message that opened this turn. Same logic
    // computeRegenerateRangeIds uses, repeated here because we need
    // the user message ROW for the runExchange call below.
    let userIdx = -1;
    for (let i = clickedIdx; i >= 0; i -= 1) {
      if (messages[i].role === 'user') {
        userIdx = i;
        break;
      }
    }
    if (userIdx === -1) return;
    const userMessage = messages[userIdx];
    // Decide destructive vs edit-fork against FRESH child-fork state
    // (the cached set only drives tooltips). rangeIds[0] is the first
    // REPLACED row - the one right after the anchor - so testing it
    // asks exactly "does the replace range touch shared history".
    let freshForkPoints: Set<string>;
    try {
      freshForkPoints = new Set(await app.supabase.listChildForkPointIds(active.id));
    } catch (e) {
      error = { text: e instanceof Error ? e.message : 'Failed to check for forks.' };
      return;
    }
    childForkPointIds = freshForkPoints;
    const shared = sharedRowIds(messages, active.id, freshForkPoints).has(rangeIds[0]);

    let targetThreadId = active.id;
    if (shared) {
      // Shared-region regenerate: the replaced rows are history another
      // conversation depends on, so nothing is superseded. Fork at the
      // anchoring user message (the fork's transcript ends with the
      // now-unanswered user turn), hide the edited thread, swap the
      // selection, and run the completion on the fork. The anchor stays
      // owned by the hidden thread - commit_assistant_message accepts
      // an inherited anchor via transcript membership. Fork BEFORE
      // hide, so a failure in between leaves both threads visible
      // rather than neither.
      if (!canForkAtMessage(userMessage)) {
        // A synthetic recovery anchor has no DB row to fork at, and
        // the destructive path is off the table in a shared region.
        error = {
          text: 'This turn is still being recovered - reload the conversation and try again.',
        };
        return;
      }
      hoverRegenerateIds = [];
      try {
        const fork = await app.supabase.forkThread(active.id, userMessage.id, {
          markTitle: false,
        });
        rebucketThread(fork);
        await selectThread(fork.id);
        await app.supabase.deleteThread(active.id);
        removeThread(active.id);
        targetThreadId = fork.id;
      } catch (e) {
        error = { text: e instanceof Error ? e.message : 'Failed to fork the conversation.' };
        return;
      }
    } else {
      pendingDeleteIds = rangeIds;
      // Hover preview gets cleared on click so the click-committed
      // pendingDeleteSet is the only source of the .regen-target class
      // from here on - no double-source flicker on the way to fade-out.
      hoverRegenerateIds = [];
    }

    // Resolve send-time context the same way send() does. The
    // toggles the user has set RIGHT NOW apply to the regenerate -
    // model swap, reasoning effort, verbosity, system-prompt set.
    // That's intentional: a regenerate is a deliberate "try this
    // turn again" gesture, and the user often wants to re-run with
    // a different model or a tweaked system prompt.
    const profile = resolveModelProfile(app.modelProfiles, active.model ?? null);
    const modelId = profile.modelId;
    // Resolve thinking level -> wire knobs; mirror of the send() path.
    const { reasoningEffort: sendReasoning, disableThinking: sendDisableThinking } =
      thinkingWireForProfile(profile, active.reasoning_effort ?? null);
    const sendVerbosity: Verbosity = active.verbosity ?? profile.verbosity;
    const systemMessages: { role: 'system'; content: string }[] = app.systemPrompts
      .filter((p) => activePromptIds.has(p.id) && p.body.trim().length > 0)
      .map((p) => ({ role: 'system' as const, content: p.body }));
    const currentUserId = session?.user.id ?? active.user_id;

    // Pin to the bottom so the new completion streams into view even
    // if the user had scrolled up to inspect the greyed range.
    followBottom = true;

    await runExchange({
      threadId: targetThreadId,
      currentUserId,
      modelId,
      modelSpec: profileModelSpec(profile),
      systemMessages,
      sendReasoning,
      sendDisableThinking,
      sendVerbosity,
      sendEmphasis: app.emphasisMarkdown,
      sendUserName: app.userName,
      sendUserLocation: app.userLocation,
      originalText: userMessage.content,
      userMessageId: userMessage.id,
      // The edit-fork path supersedes nothing: the replaced rows live
      // in the hidden thread's segment, not the fork's.
      supersededIds: shared ? undefined : persistedRowIds(messages, rangeIds),
    });
  }

  /**
   * Second-thoughts refinement: run one extra turn seeded with the
   * reviewer's doubt as a `<think>`, APPENDING a fresh answer below the
   * original. Unlike regenerate, nothing is superseded/deleted - the
   * original answer stays. Anchored to the original turn's user message
   * so the appended assistant row commits without a cross-device
   * conflict (commit_assistant_message keys on newer USER messages, not
   * the existing assistant answer). Only wired for the thread's latest
   * assistant row (see the render site), so the append always lands at
   * the transcript tail. Priming is skipped for the turn (see
   * `refinementThink` handling in runExchange).
   */
  async function refineFrom(assistantMessageId: string): Promise<void> {
    if (activeSlot?.sending || !app.supabase || !app.venice) return;
    const active = activeThreadId ? findThread(activeThreadId) ?? null : null;
    if (!active || active.isDraft || active.archived) return;
    const idx = messages.findIndex((m) => m.id === assistantMessageId);
    if (idx === -1) return;
    const row = messages[idx];
    if (row.role !== 'assistant') return;
    // The doubt to seed the refinement lives on the row's verdict. No
    // verdict (or a conviction with no button) means nothing to act on.
    const verdict = coerceSecondThoughts(row.second_thoughts);
    if (!verdict) return;
    // Walk back to the user message that opened this turn - the append
    // anchor. Mirrors regenerateFrom's walk.
    let userIdx = -1;
    for (let i = idx; i >= 0; i -= 1) {
      if (messages[i].role === 'user') {
        userIdx = i;
        break;
      }
    }
    if (userIdx === -1) return;
    const userMessage = messages[userIdx];

    // Mark the doubt ACTED. This is what flips it from display-only to
    // model-visible: `toVeniceMessage` projects the `<think>` connective
    // onto any acted row, so the refinement turn's own history (which
    // includes this row) carries the doubt, and so do all future replays
    // - giving the model the logical link between this answer and the
    // refinement that follows. Patch the local row FIRST so
    // buildHistoryOnWire sees it on this very turn; the DB persist (for
    // reload / cross-device) rides a security-definer RPC because the
    // client's messages-UPDATE policy only covers role='tool' rows.
    // Best-effort persist: a failure just means the flag won't survive a
    // reload; this turn's wire is already driven by the local patch.
    const actedVerdict = { ...(row.second_thoughts as object), acted: true };
    messages = messages.map((m) =>
      m.id === row.id ? { ...m, second_thoughts: actedVerdict } : m
    );
    void app.supabase.markSecondThoughtsActed(row.id).catch((e) => {
      log.error('failed to persist second-thoughts acted flag', e);
    });

    // Resolve send-time context the same way regenerateFrom does - the
    // user's current toggles (model, reasoning, verbosity, system
    // prompts) apply to the refinement.
    const profile = resolveModelProfile(app.modelProfiles, active.model ?? null);
    const modelId = profile.modelId;
    const { reasoningEffort: sendReasoning, disableThinking: sendDisableThinking } =
      thinkingWireForProfile(profile, active.reasoning_effort ?? null);
    const sendVerbosity: Verbosity = active.verbosity ?? profile.verbosity;
    const systemMessages: { role: 'system'; content: string }[] = app.systemPrompts
      .filter((p) => activePromptIds.has(p.id) && p.body.trim().length > 0)
      .map((p) => ({ role: 'system' as const, content: p.body }));
    const currentUserId = session?.user.id ?? active.user_id;

    // Pin to the bottom so the appended refinement streams into view.
    followBottom = true;

    await runExchange({
      threadId: active.id,
      currentUserId,
      modelId,
      modelSpec: profileModelSpec(profile),
      systemMessages,
      sendReasoning,
      sendDisableThinking,
      sendVerbosity,
      sendEmphasis: app.emphasisMarkdown,
      sendUserName: app.userName,
      sendUserLocation: app.userLocation,
      originalText: userMessage.content,
      userMessageId: userMessage.id,
      isRefinement: true,
      // The raw note (not displayNote's fallback copy) - the server
      // keys its samskara probe to the reviewer's actual words, and an
      // empty note correctly yields no probe.
      refinementDoubtNote: verdict.note,
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

    // A dead-turn tail carries nothing coherent for the re-roll to
    // build on, so mark it for replacement the way regenerateFrom marks
    // its range. Two shapes qualify:
    //   - reasoning-only stall: the model thought but never answered
    //     (isReasoningOnlyStall), so the bubble is a bare reasoning
    //     panel with no reply.
    //   - partial-text cutoff: the stream failed mid-answer and the
    //     edge function persisted the half-sentence as a status='error'
    //     row (isCutOffPartialText). Continuing from a sentence that
    //     stops mid-thought reads disjointly, so we re-roll instead.
    // Without this the dead card lingers above the fresh answer once the
    // retry lands: the pendingDeleteSet red-outlines it (.regen-target)
    // and keeps it off the wire, the commit RPC deletes the row
    // atomically with the new turn's commit, and the post-loop fade in
    // runExchange prunes it from the view. The other incomplete-tail
    // shapes (orphaned tool rows, a bare user message) ARE genuine
    // continuation points - their persisted rows are exactly what the
    // model needs to pick up - so they keep the no-delete behavior. When
    // the cutoff landed after one or more completed tool rounds, only
    // the trailing partial-text row is the dead tail; the tool rows
    // before it stay as fuel and the re-roll synthesizes a new final
    // answer from them.
    const tail = messages[messages.length - 1];
    let supersededIds: string[] | undefined;
    if (isReasoningOnlyStall(tail) || isCutOffPartialText(tail)) {
      pendingDeleteIds = [tail.id];
      supersededIds = persistedRowIds(messages, [tail.id]);
    }

    const profile = resolveModelProfile(app.modelProfiles, active.model ?? null);
    const modelId = profile.modelId;
    // Resolve thinking level -> wire knobs; mirror of the send() path.
    const { reasoningEffort: sendReasoning, disableThinking: sendDisableThinking } =
      thinkingWireForProfile(profile, active.reasoning_effort ?? null);
    const sendVerbosity: Verbosity = active.verbosity ?? profile.verbosity;
    const systemMessages: { role: 'system'; content: string }[] = app.systemPrompts
      .filter((p) => activePromptIds.has(p.id) && p.body.trim().length > 0)
      .map((p) => ({ role: 'system' as const, content: p.body }));
    const currentUserId = session?.user.id ?? active.user_id;

    followBottom = true;

    await runExchange({
      threadId: active.id,
      currentUserId,
      modelId,
      modelSpec: profileModelSpec(profile),
      systemMessages,
      sendReasoning,
      sendDisableThinking,
      sendVerbosity,
      sendEmphasis: app.emphasisMarkdown,
      sendUserName: app.userName,
      sendUserLocation: app.userLocation,
      originalText: userMessage.content,
      userMessageId: userMessage.id,
      supersededIds,
    });
  }

  // ⌘+Enter (macOS), Ctrl+Enter (everyone else), and the legacy Shift+Enter
  // all submit. Plain Enter still inserts a newline so long-form drafts
  // aren't interrupted. `metaKey` maps to the Command key on macOS; on
  // Windows/Linux it's the rarely-pressed Super/Windows key, so including
  // it there is harmless. All three modifiers stay interchangeable in
  // the queue mode below - a chord that means "submit" in one state and
  // nothing in another would be worse than either behavior.
  //
  // While a response is streaming the same keystroke QUEUES the draft
  // (see queueMessage) rather than sending or stopping. The shortcut and
  // the button deliberately diverge here: the button is the cancel, the
  // keystroke is the "and also..." - so a thought that arrives mid-answer
  // costs the user neither the reply nor the thought.
  function onKeydown(e: KeyboardEvent): void {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey || e.shiftKey)) {
      e.preventDefault();
      if (activeSlot?.sending) {
        queueMessage();
      } else {
        void send();
      }
    }
  }

  /**
   * Cancel the in-flight chat request. Two paths, both fired together:
   *
   *   1. Local AbortController.abort() tears down our streamChat
   *      consumer so the UI stops collecting events from the
   *      Broadcast channel and the in-flight envelope POST aborts.
   *   2. cancelStream() publishes a `{type:'cancel'}` event on the
   *      thread's control channel. The streaming function (subscribed
   *      to its own control channel) aborts its Venice fetch and any
   *      in-flight server-side tool calls, persists the partial row
   *      with status='aborted', and publishes END {terminalKind:
   *      'aborted'} on the stream channel. Without this path the
   *      function would keep generating after the browser disconnected
   *      - the whole point of moving the loop server-side.
   *
   * Safe to call repeatedly - once `activeSlot?.abortCtl` is nulled in
   * runExchange's finally block this is a no-op, and the control
   * channel publish is idempotent (the function has already
   * unsubscribed by then).
   */
  function stopStreaming(): void {
    activeSlot?.abortCtl?.abort();
    if (activeSlot && app.supabase && activeThreadId) {
      void cancelStream(app.supabase.client, activeThreadId);
    }
  }

  // Platform-aware hint in the composer placeholder. Uses the modern
  // navigator.userAgentData.platform when available and falls back to
  // the legacy navigator.platform string; the classification and the
  // label copy live in $lib/ui/chat-screen.
  const isMac = $derived.by(() => {
    if (typeof navigator === 'undefined') return false;
    const p =
      (navigator as Navigator & { userAgentData?: { platform?: string } })
        .userAgentData?.platform ?? navigator.platform ?? '';
    return isMacPlatform(p);
  });
  const sendHint = $derived(sendHintLabel(isMac, activeSlot?.sending === true));

  // Mode, disabled state, and labels for the dual-purpose composer
  // button. Three modes now (send / stop / stop-and-send-the-queue), so
  // the cascade lives in the primitive rather than three parallel
  // ternaries in the markup.
  const sendButton = $derived(
    sendButtonState({
      sending: activeSlot?.sending === true,
      queuedCount: activeSlot?.queued.length ?? 0,
      stopSettled: activeSlot?.abortCtl === null,
      composerEmpty: composer.trim().length === 0 && pendingAttachments.length === 0,
      archived: currentThread?.archived === true,
      respondingElsewhere,
    })
  );

  async function signOut(): Promise<void> {
    // Drop the tab-local last-active-thread id so a post-sign-in
    // session doesn't reopen a thread the user has just signed away
    // from. The localStorage config stays - signing back in re-uses
    // it without going through Setup.
    clearSessionThreadId();
    // Reset config defaults (model profiles, user profile, system prompts,
    // wiki/memory toggles) so the previous account's preferences
    // don't bleed into a subsequent sign-in-as-someone-else before
    // refreshSettings re-seeds them from the new account's Supabase
    // settings.
    resetForSignOut();
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
      // Only act - disengage AND advance the watermark - when the
      // backward move is the user actually scrolling up and away from
      // the bottom. When the backward move lands near the bottom it's
      // a browser clamp, not user intent: the streaming bubble
      // collapses at completion (reasoning panel closes, streaming text
      // is replaced by the persisted row), scrollHeight drops, and the
      // browser pins scrollTop down to the new max. That benign drop
      // must NOT lower lastScrollTop, because onMessagesScroll's
      // clamp-rejection guard depends on lastScrollTop still holding the
      // pre-clamp value when the clamp's own deferred 'scroll' event
      // fires - it rejects the re-engage precisely because
      // newScrollTop < lastScrollTop. Lowering the watermark here would
      // make that 'scroll' event read as "at bottom and not backwards"
      // and silently flip followBottom back to true, yanking the view to
      // the bottom of the just-finished response even though the user
      // had scrolled up to read.
      if (!isNearBottom(el)) {
        followBottom = false;
        lastScrollTop = el.scrollTop;
      }
    }
  }

  // Streaming deltas mutate the transcript fast - both the answer text
  // and the reasoning trace land in ~50ms gulps (FLUSH_MS).
  // Coalesce the follow-bottom scroll onto a single requestAnimationFrame:
  // any number of synchronous mutations within one frame schedule one
  // scroll, fired on the next frame once the browser has laid the new
  // content out.
  //
  // rAF rather than a setTimeout debounce on purpose. It fires AFTER
  // layout, so scrollHeight is final and scrollToBottom lands on the true
  // bottom - the standalone throbber row below the card included - instead
  // of a stale height captured mid-reflow. And it fires on the very next
  // frame, so the view never trails the stream by a fixed delay (the old
  // 80ms debounce was the source of the throbber drifting below the fold
  // between gulps). One scroll per frame is its own ceiling, so a fast
  // reasoning stream can't slot-machine the view and there's no separate
  // max-wait timer to arm. Discrete transitions (user sends,
  // assistant-message commit, thread switch) bypass this and scroll
  // immediately - see the $effect below.
  let streamScrollRaf = 0;

  function cancelStreamScroll(): void {
    if (streamScrollRaf !== 0) {
      cancelAnimationFrame(streamScrollRaf);
      streamScrollRaf = 0;
    }
  }

  function scheduleStreamScroll(): void {
    refreshFollowBottom();
    if (!activeSlot?.sending || !followBottom) {
      // Auto-scroll only runs while a completion is in progress and
      // scroll-lock isn't engaged. Drop any queued frame so a stale
      // scroll doesn't yank the view after the user scrolls up or after
      // the completion ends.
      cancelStreamScroll();
      return;
    }
    // A frame is already queued this tick - let it coalesce the burst.
    if (streamScrollRaf !== 0) return;
    streamScrollRaf = requestAnimationFrame(() => {
      streamScrollRaf = 0;
      // Re-check both gates at fire time. The user may have scrolled up
      // between schedule and frame, and the completion may have ended in
      // that gap (the persisted-row effect cancels this frame, but one
      // already dispatched can still run) - either disables auto-scroll.
      // refreshFollowBottom also guards the mobile case where the user
      // dragged up without a 'scroll' event firing in time.
      refreshFollowBottom();
      if (activeSlot?.sending && followBottom) scrollToBottom(false);
    });
  }

  // Two separate effects so streaming deltas and discrete message-list
  // mutations can drive different scroll policies. Splitting them is
  // the simplest way to get "coalesce tokens onto a frame, snap on
  // commits" without prev-value bookkeeping inside a single effect.

  // Rendered-transcript mutations during an active completion - user
  // send, assistant-persist, regenerate-drop. These mark a clean
  // transition and should land the view on the bottom immediately.
  // Firing here also supersedes any queued streaming frame: the
  // commit we just observed is the latest state, so a stale
  // late-firing scroll would just flicker.
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
    cancelStreamScroll();
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

  // Streaming-card height changes - re-pin the bottom (rAF-coalesced via
  // scheduleStreamScroll). Tracks every signal that grows or shrinks the
  // streaming card, because each one moves the throbber row sitting below
  // it and the view has to follow or the throbber slips under the fold:
  //   - streamingText / streamingReasoning: the answer and thinking
  //     buffers growing as tokens arrive.
  //   - streamingReasoningOpen: the reasoning panel opening or closing is
  //     a vertical layout shift, same as a token append.
  //   - subconsciousRows: the priming checklist (Reacting / Predicting /
  //     Recalling) gaining a row or flipping one running -> done. These
  //     land BEFORE the first answer delta, so without tracking them the
  //     card grows, shoves the throbber under the fold, and nothing
  //     scrolls until the reply finally starts - the throbber stays hidden
  //     through the whole priming window and a stray scroll there reads as
  //     the user disengaging follow-bottom.
  //   - subconsciousDismissed: the checklist fading out shrinks the card.
  //   - rateLimitWaitUntil: the rate-limit wait row appearing or clearing.
  // streamingText toggling to '' at a round boundary also runs through
  // here; the discrete persisted-row effect cancels the queued frame and
  // does the final snap, so there's no special "stream ended" signal.
  $effect(() => {
    void activeSlot?.streamingText;
    void activeSlot?.streamingReasoning;
    void activeSlot?.streamingReasoningOpen;
    void subconsciousRows;
    void activeSlot?.subconsciousDismissed;
    void activeSlot?.rateLimitWaitUntil;
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
    const pending = findPendingAskUserRow(messages);
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
      const userMessageId = findOpeningUserMessageIdForTail(messages);
      if (!userMessageId) {
        log.warn('answerAskUser: could not locate opening user message');
        return;
      }
      const freshThread = findThread(threadId);
      if (!freshThread) return;
      const profile = resolveModelProfile(app.modelProfiles, freshThread.model ?? null);
      const modelId = profile.modelId;
      const { reasoningEffort: sendReasoning, disableThinking: sendDisableThinking } =
        thinkingWireForProfile(profile, freshThread.reasoning_effort ?? null);
      const sendVerbosity: Verbosity = freshThread.verbosity ?? profile.verbosity;
      const systemMessages: { role: 'system'; content: string }[] = app.systemPrompts
        .filter((p) => activePromptIds.has(p.id) && p.body.trim().length > 0)
        .map((p) => ({ role: 'system' as const, content: p.body }));
      const currentUserId = session?.user.id ?? freshThread.user_id;

      await runExchange({
        threadId,
        currentUserId,
        modelId,
        modelSpec: profileModelSpec(profile),
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
   * Render plan derived from the raw message list - the fold lives in
   * $lib/ui/message-blocks (tool-result folding, recovery-row hiding,
   * hidden-tool filtering, the rename / generated-image / ask-user
   * sibling blocks). Built as a $derived so messages mutations
   * re-group automatically (e.g. when the chat-loop pushes a new
   * tool-result row mid-turn).
   */
  const messageBlocks = $derived(buildMessageBlocks(messages));

  /**
   * The persisted transcript tail when it means the model never got
   * to produce a final reply for the last user turn (see
   * classifyIncompleteTurnTail in $lib/ui/incomplete-turn for the
   * qualifying tail shapes), gated on session state the transcript
   * can't see:
   *
   * Suppressed while `activeSlot?.sending` is true (a turn in progress has the
   * same DB tail mid-exchange and we don't want the banner fighting
   * the live streaming bubble), and while `activeSlot?.streamingError` is set
   * (its own banner already offers a retry where applicable, and
   * double-rendering two retry prompts for the same failure is
   * noisy). Also suppressed while `respondingElsewhere` is true: a
   * different device holds a live claim and is actively producing the
   * reply, so the tail only LOOKS incomplete from here - the persisted
   * assistant row will arrive over realtime. Offering retry in that
   * window invites a competing turn that the claim is specifically
   * there to prevent (and whose acquire would just fail with "another
   * device is responding"), so we show the observer Scanner instead.
   */
  const incompleteTurnTail = $derived.by<Message | null>(() => {
    if (activeSlot?.sending) return null;
    if (activeSlot?.streamingError) return null;
    if (respondingElsewhere) return null;
    // A live server-side in-flight stamp means the turn is still
    // running under the edge function's waitUntil even though no local
    // slot is producing it - the reload-during-priming case, plus the
    // await window in selectThread before reconnectInflightTurn flips
    // `sending` on. The tail only LOOKS incomplete; the reply arrives
    // via the reconnect poll. Reads claimNowTick so the staleness
    // verdict re-runs even when no realtime clear ever lands (the
    // function died before its finally).
    void claimNowTick;
    if (streamLikelyInFlight(currentThread?.stream_started_at, Date.now())) {
      return null;
    }
    return classifyIncompleteTurnTail(messages);
  });

  /**
   * Single error surface for the bottom of the message list. Combines
   * three sources, in precedence:
   *
   *   1. `activeSlot.streamingError` - session-local, set by the
   *      live-turn catch sites. Freshest signal; the user just hit it.
   *   2. `currentThread.last_error` - persistent, written by the
   *      streaming function on any terminalKind='error' path and
   *      cleared by commit_assistant_message on the happy path.
   *      Survives reload, so the user sees it on next visit.
   *   3. nothing - card stays hidden.
   *
   * The `incompleteTurnTail` cut-off banner only fires when
   * displayedError is null, so an orphan tail with no explained cause
   * (typically: user closed the tab mid-stream before END could fire)
   * still gets a generic retry affordance, but an orphan tail WITH a
   * thread.last_error explanation collapses to the single error card
   * (the explanation + retry button live together, see option-A
   * design decision from the 2026-06-05 session).
   *
   * `dismiss` clears the source state. For session errors that's just
   * the slot field; for persisted errors that's an UPDATE on the
   * thread row (best-effort - the realtime echo re-syncs whichever
   * way the write went). `retry` is wired only when the underlying
   * error is recoverable (rate_limit, network, 5xx, timeout, etc.);
   * non-retryable kinds (auth, certain commit conflicts) render the
   * card without a Retry button so the user is steered toward the
   * actual fix instead of re-hitting the same wall.
   */
  const displayedError = $derived.by<{
    heading?: string;
    text: string;
    retry?: () => void;
    dismiss: () => void;
  } | null>(() => {
    if (activeSlot?.streamingError) {
      const slot = activeSlot;
      return {
        text: slot.streamingError!.text,
        retry: slot.streamingError!.retry,
        dismiss: () => {
          slot.streamingError = null;
        },
      };
    }
    const persisted = parseLastError(currentThread?.last_error);
    if (persisted) {
      return {
        heading: headingFor(persisted.kind),
        text: persisted.message,
        retry: persisted.retryable
          ? () => {
              void retryIncompleteTurn();
            }
          : undefined,
        dismiss: () => {
          void clearThreadLastError();
        },
      };
    }
    return null;
  });

  /**
   * Single recovery surface for the transcript tail. The tail can satisfy
   * several "this turn did not finish" conditions at once - most visibly a
   * session that died with a persisted user row AND a leftover IndexedDB
   * streaming draft trips both `incompleteTurnTail` and `interruptedDraft`,
   * which used to render as two stacked, near-identical retry boxes.
   * `selectRecoveryBanner` collapses error / interrupted-draft / cut-off
   * into one banner by precedence (error > interrupted-draft > cut-off);
   * here we only bind each source's retry/dismiss closures and gate them.
   *
   * Gating mirrors the prior per-banner conditions: the interrupted-draft
   * source is suppressed while a foreign device holds a live claim
   * (`respondingElsewhere`) or a local turn is sending, and `displayedError`
   * already wins precedence so the cut-off / draft variants never compete
   * with an explained error. `incompleteTurnTail` self-suppresses on
   * sending / streamingError / respondingElsewhere (see its derivation).
   */
  const recoveryBanner = $derived(
    selectRecoveryBanner({
      error: displayedError,
      interruptedDraft:
        interruptedDraft && !respondingElsewhere && !activeSlot?.sending
          ? {
              retry: () => void retryInterrupted(),
              dismiss: () => {
                void deleteDraft(interruptedDraft!.threadId).catch(() => {});
    interruptedDraft = null;
    // Clear any pending draft from the prior thread. The reconnection
    // $effect below will re-populate from a draft row if the new
    // thread has one.
    pendingDraftId = null;
              },
            }
          : null,
      cutOff: incompleteTurnTail
        ? {
            retry: () => {
              void retryIncompleteTurn();
            },
          }
        : null,
    }),
  );

  // Recovery-banner diagnostics. One debug line whenever the rendered
  // banner changes (including to none), attributing it to its source
  // and snapshotting the gates that let it through - so the Logs
  // drawer can answer "why is this banner showing" after the fact.
  // The post-tick DOM census exists for a reported-but-not-yet-
  // reproduced sighting of TWO banners overlapping: the template has a
  // single render site fed by one selector, so more than one banner
  // node should be impossible - if it ever happens, the warn line
  // (with the nodes' texts) is the evidence that pins down where the
  // second element comes from.
  let lastBannerLogKey = '';
  $effect(() => {
    const b = recoveryBanner;
    const source = recoveryBannerSource(b);
    const key = `${activeThreadId}|${source}|${b?.text ?? ''}`;
    if (key === lastBannerLogKey) return;
    lastBannerLogKey = key;
    log.debug(
      `recovery banner -> ${source} thread=${activeThreadId}` +
        ` sending=${activeSlot?.sending === true}` +
        ` reconnecting=${activeSlot?.reconnecting === true}` +
        ` respondingElsewhere=${respondingElsewhere}` +
        ` stamp=${currentThread?.stream_started_at ?? 'null'}` +
        ` lastError=${currentThread?.last_error != null}` +
        ` tail=${messages.at(-1)?.role ?? 'empty'}/${messages.at(-1)?.status ?? 'none'}`,
    );
    void tick().then(() => {
      const nodes = document.querySelectorAll('.msg-incomplete, .msg-error');
      if (nodes.length > 1) {
        log.warn(
          `recovery banner DOM census found ${nodes.length} banner nodes: ` +
            Array.from(nodes)
              .map((n) => JSON.stringify(n.textContent?.trim().slice(0, 80) ?? ''))
              .join(' | '),
        );
      }
    });
  });

  /**
   * Best-effort clear of `threads.last_error` when the user dismisses
   * the persistent error card. Optimistic local patch fires first so
   * the card vanishes immediately; the DB UPDATE follows. If the write
   * fails (network, auth lapsed), the realtime echo never lands and
   * the column stays - next thread reopen rehydrates the error. The
   * inverse case (write succeeds, echo updates the row) is the
   * canonical happy path and produces the same UI as the optimistic
   * patch did.
   */
  async function clearThreadLastError(): Promise<void> {
    if (!currentThread || !app.supabase) return;
    const threadId = currentThread.id;
    patchThread(threadId, { last_error: null });
    try {
      await app.supabase.client
        .from('threads')
        .update({ last_error: null })
        .eq('id', threadId);
    } catch {
      // Swallowed by design; see jsdoc above.
    }
  }

  /**
   * User-driven toolbox toggle - parallel to the `toggle_toolbox`
   * meta-tool's LLM path. Flips the named gated toolbox on or off in
   * the current thread's `toolboxes_enabled` array, writes through
   * to Supabase, and reverts on failure so the UI can't lie about
   * server state.
   *
   * Same fresh-session / draft pattern as setProfile: with no active
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
  // `title + summary` embeddings; the server-side summary agent
  // (supabase/functions/venice/agents/summary.ts) writes
  // `threads.summary`. Exact hits always rank above semantic
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
        const resp = await app.supabase.embed({
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
    const bucket = bucketFor(t, recentCutoff);
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
    <!-- Fixed-position connectivity banner; renders only when offline. -->
    <OfflineBanner />
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
              class:active={drawerTab === 'groceries'}
              aria-selected={drawerTab === 'groceries'}
              onclick={() => onPickGroceriesTab()}
            >Groceries</button>
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
              class:active={drawerTab === 'wiki'}
              aria-selected={drawerTab === 'wiki'}
              onclick={() => onPickWikiTab()}
            >Wiki</button>
          </div>
          <div class="row thread-row">
            <button
              type="button"
              role="tab"
              class="thread grow"
              class:active={drawerTab === 'library'}
              aria-selected={drawerTab === 'library'}
              onclick={() => onPickLibraryTab()}
            >Library</button>
          </div>
          <div class="row thread-row">
            <button
              type="button"
              role="tab"
              class="thread grow"
              class:active={drawerTab === 'artifacts'}
              aria-selected={drawerTab === 'artifacts'}
              onclick={() => onPickArtifactsTab()}
            >Artifacts</button>
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
              class:active={drawerTab === 'samskara'}
              aria-selected={drawerTab === 'samskara'}
              onclick={() => onPickSamskaraTab()}
              title="Samskara diagnostics - what the model has formed about you, and pipeline health"
            >Samskara</button>
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
            vocabulary={topicsVocabulary}
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
              {#if t.forked_from_thread_id}
                <!-- Feather git-branch outline: stroke SVG to match the
                     app's other card/action icons. -->
                <svg
                  class="thread-fork-glyph"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="2"
                  stroke-linecap="round"
                  stroke-linejoin="round"
                  role="img"
                  aria-label="Forked conversation"
                ><line x1="6" y1="3" x2="6" y2="15"></line><circle cx="18" cy="6" r="3"></circle><circle cx="6" cy="18" r="3"></circle><path d="M18 9a9 9 0 0 1-9 9"></path></svg>
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
                  <button class="thread-menu-item" role="menuitem"
                          onclick={() => { void exportTranscript(t.id); }}>Download transcript</button>
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
                  <button class="thread-menu-item" role="menuitem"
                          onclick={() => { void forkFromRow(t.id); }}
                          disabled={t.isDraft}
                          title={t.isDraft ? "Draft threads have nothing to fork yet." : undefined}>
                    Fork
                  </button>
                  <button class="thread-menu-item" role="menuitem"
                          onclick={() => { void exportTranscript(t.id); }}
                          disabled={t.isDraft}
                          title={t.isDraft ? "Draft threads have nothing to export yet." : undefined}>
                    Download transcript
                  </button>
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
      {:else if drawerTab === 'groceries'}
        <!-- Groceries tab. The sidebar is the all-items browse
             (search + status/section filters over the full purchase
             history); the current shopping list renders in the main
             panel (Groceries.svelte). No onSelect - the sidebar's
             checkbox toggles items onto the list, and closing the
             drawer per toggle would fight a multi-add flow. -->
        {#if GroceryListComp}
          <GroceryListComp />
        {/if}
      {:else if drawerTab === 'recipes'}
        <!-- Recipes tab. RecipeList owns the search, sort, and item
             rows. Clicking a recipe navigates to it inline in the main
             panel (no modal). onSelect closes the mobile drawer so the
             newly-navigated panel is visible without a second tap.
             Lazy-loaded - the panel is empty for a tick on first
             open. -->
        {#if RecipeListComp}
          <RecipeListComp onSelect={closeDrawerOnMobile} />
        {/if}
      {:else if drawerTab === 'memories'}
        <!-- Memories tab. MemoryList owns the search and label rows.
             Clicking a label scrolls the panel-side card into view.
             onSelect mirrors the other tabs on mobile. -->
        {#if MemoryListComp}
          <MemoryListComp onSelect={closeDrawerOnMobile} />
        {/if}
      {:else if drawerTab === 'wiki'}
        <!-- Wiki tab. WikiList owns the search and alphabetical
             listing. Clicking an article surfaces it in the main
             panel. onSelect mirrors the other tabs on mobile. -->
        <WikiList onSelect={closeDrawerOnMobile} />
      {:else if drawerTab === 'samskara'}
        <!-- Samskara diagnostics tab. SamskaraBrowseList owns the
             search, the tier/sort/hide-similar controls, and selection.
             onSelect mirrors the other tabs on mobile. -->
        <SamskaraBrowseList onSelect={closeDrawerOnMobile} />
      {:else if drawerTab === 'artifacts'}
        <!-- Artifacts tab. ArtifactsList owns the filename search, the
             type/sort filters, and per-file delete. Clicking a row jumps
             to the conversation the file lives in; onSelect closes the
             drawer on mobile. -->
        <ArtifactsList onSelect={closeDrawerOnMobile} />
      {:else}
        <!-- Library tab. LibraryList owns the search and newest-first
             listing. Clicking a document surfaces it in the main panel.
             onSelect mirrors the other tabs on mobile. -->
        <LibraryList onSelect={closeDrawerOnMobile} />
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
               point now. The Cookbook button was also removed for
               the same reason - the Recipes drawer tab covers it. -->
          <button
            class="secondary icon-btn"
            onclick={() => navigate({ modal: 'settings' })}
            title="Settings"
            aria-label="Settings"
            style="position:relative"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                 stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <circle cx="12" cy="12" r="3" />
              <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
            </svg>
            {#if mcpProblemCount > 0}
              <span
                class="badge-dot"
                style="position:absolute;top:-4px;right:-4px;min-width:16px;height:16px;
                       padding:0 4px;border-radius:8px;background:var(--danger,#e53e3e);
                       color:#fff;font-size:10px;font-weight:700;line-height:16px;
                       text-align:center"
                aria-label={`${mcpProblemCount} integration${mcpProblemCount > 1 ? 's' : ''} need attention`}
              >{mcpProblemCount}</span>
            {/if}
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
        <!-- Section action icons. The per-tab `actions` array below maps
             each one to a TopBarAction; TopBarActions renders them as a
             merged button group on desktop and collapses them behind a
             single overflow menu on mobile (the icons are render-only
             snippets, shared by both layouts). The title slot stays out
             of the cluster - it owns its own flex space. -->
        {#snippet newThreadIcon()}
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor"
               stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path d="M21 15a2 2 0 0 1-2 2H8l-5 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
          </svg>
        {/snippet}
        {#snippet newRecipeIcon()}
          <!-- Feather "file-text" - document with lines, reads as
               "new document with content" / recipe card. -->
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor"
               stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
            <polyline points="14 2 14 8 20 8" />
            <line x1="16" y1="13" x2="8" y2="13" />
            <line x1="16" y1="17" x2="8" y2="17" />
            <line x1="10" y1="9" x2="8" y2="9" />
          </svg>
        {/snippet}
        {#snippet deepSleepIcon()}
          <!-- Feather "moon" - reads as "slow-wave sleep / deep
               consolidation". -->
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor"
               stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
          </svg>
        {/snippet}
        {#snippet remIcon()}
          <!-- Feather "shuffle" - reads as "associative recombination /
               reshuffling memories". -->
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor"
               stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <polyline points="16 3 21 3 21 8" />
            <line x1="4" y1="20" x2="21" y2="3" />
            <polyline points="21 16 21 21 16 21" />
            <line x1="15" y1="15" x2="21" y2="21" />
            <line x1="4" y1="4" x2="9" y2="9" />
          </svg>
        {/snippet}
        {#snippet librarianIcon()}
          <!-- Feather "sparkles" - reads as "agent / clean up". -->
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor"
               stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path d="M12 3l1.9 4.6L18 9l-4.1 1.4L12 15l-1.9-4.6L6 9l4.1-1.4L12 3z" />
            <path d="M5 17l.8 2L8 19.5l-2.2.5L5 22l-.8-2L2 19.5l2.2-.5L5 17z" />
            <path d="M19 14l.6 1.5L21 16l-1.4.5L19 18l-.6-1.5L17 16l1.4-.5L19 14z" />
          </svg>
        {/snippet}
        {#snippet digestIcon()}
          <!-- Feather "calendar" - reads as "day-by-day history",
               distinct from the clock the changelog buttons use so the
               two history surfaces don't look interchangeable. -->
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor"
               stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <rect x="3" y="4" width="18" height="18" rx="2" ry="2" />
            <line x1="16" y1="2" x2="16" y2="6" />
            <line x1="8" y1="2" x2="8" y2="6" />
            <line x1="3" y1="10" x2="21" y2="10" />
          </svg>
        {/snippet}
        {#snippet transcriptDownloadIcon()}
          <!-- Feather "download" - arrow into a tray, the conventional
               save-to-disk glyph. -->
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor"
               stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
            <polyline points="7 10 12 15 17 10" />
            <line x1="12" y1="15" x2="12" y2="3" />
          </svg>
        {/snippet}
        {#snippet copyIdIcon()}
          <!-- Feather "copy" - two overlapping pages, the standard
               copy-to-clipboard glyph. Same shape CopyButton.svelte
               uses inline, extracted here so it can render inside a
               TopBarActions overflow entry on mobile. -->
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor"
               stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
            <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
          </svg>
        {/snippet}
        {#snippet changelogIcon()}
          <!-- Feather "clock" - reads as "history / audit log". -->
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor"
               stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <circle cx="12" cy="12" r="10" />
            <polyline points="12 6 12 12 16 14" />
          </svg>
        {/snippet}
        {#snippet skippedIcon()}
          <!-- Feather "alert-triangle" - reads as "something needs your
               attention" without the error tone; a skip is an FYI, not a
               broken state. -->
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor"
               stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
            <line x1="12" y1="9" x2="12" y2="13" />
            <line x1="12" y1="17" x2="12.01" y2="17" />
          </svg>
        {/snippet}
        {#snippet overviewIcon()}
          <!-- Feather "activity" - an ECG/pulse line, reads as "pipeline
               health / is the machinery still beating." The Overview
               surface stacks the compound summary over live pipeline
               health, and the pulse glyph reads as the diagnostics view
               more distinctly than a prose-lines glyph would. -->
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor"
               stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <polyline points="22 12 18 12 15 21 9 3 6 12 2 12" />
          </svg>
        {/snippet}
        {#if drawerTab === 'chats' || drawerTab === 'artifacts'}
          <!-- Chats top-bar: new-thread + title (inline-renameable). The
               logs-toggle that used to live here moved out of the per-tab
               branches so it appears on every section. The Artifacts tab is
               a drawer-only management surface - it shares the chats
               top-bar + transcript so the main view stays the conversation
               while the user reviews files in the drawer. -->
          {@const newBtn = newThreadButtonState(
            currentIsEmpty,
            // The digest panel only renders on the chats tab, so on
            // the artifacts tab the button keeps its transcript-view
            // gating even if ?digest=1 is still in the URL.
            route.digest !== null && drawerTab === 'chats'
          )}
          {@const actions = [
            {
              id: 'new-thread',
              label: 'New conversation',
              title: newBtn.title,
              class: 'new-thread-mini',
              disabled: newBtn.disabled,
              onclick: newThread,
              icon: newThreadIcon,
              // Primary action of the whole app: stays a standalone
              // button on mobile instead of collapsing into the
              // overflow menu with the digest (and any future
              // chats-tab actions).
              pinned: true,
            },
            {
              id: 'digest',
              label: 'Daily digest',
              title: route.digest
                ? 'Back to the conversation'
                : 'Daily digest of past conversations',
              onclick: () => navigate({ digest: route.digest ? null : '1' }),
              icon: digestIcon,
            },
            {
              id: 'transcript-export',
              label: 'Download transcript',
              title: 'Download this conversation as Markdown',
              // Mobile-menu-only: the desktop placement is the
              // standalone button beside the logs toggle (top right),
              // so the desktop merged group hides this copy via CSS.
              class: 'transcript-export-menu-only',
              disabled: !canExportTranscript(
                currentThread,
                route.digest !== null && drawerTab === 'chats',
                messages.length
              ),
              onclick: () => { if (activeThreadId) void exportTranscript(activeThreadId); },
              icon: transcriptDownloadIcon,
            },
            {
              id: 'copy-thread-id',
              label: 'Copy conversation ID',
              title: 'Copy this conversation\'s ID to clipboard',
              class: 'transcript-export-menu-only',
              disabled: !activeThreadId,
              onclick: () => { if (activeThreadId) void navigator.clipboard.writeText(activeThreadId); },
              icon: copyIdIcon,
            },
          ]}
          <TopBarActions {actions} menuLabel="Chat actions" />
          <div class="title-wrap">
            {#if route.digest && drawerTab === 'chats'}
              <span class="title-btn panel-section-label">Daily digest</span>
            {:else if currentThread}
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

        {:else if drawerTab === 'groceries'}
          <!-- Groceries top-bar: label only. Add / edit / section
               management all live inline in the sidebar list, so
               there is nothing to launch from here. -->
          <div class="title-wrap">
            <span class="title-btn panel-section-label">Groceries</span>
          </div>

        {:else if drawerTab === 'recipes'}
          <!-- Recipes top-bar: new-recipe button mirrors the new-thread
               button in the chats top-bar. Triggers the Cookbook panel
               to open the edit form for a fresh recipe via the
               $bindable cookbookTriggerNew prop. -->
          {@const actions = [
            {
              id: 'new-recipe',
              label: 'New recipe',
              title: 'New recipe',
              class: 'new-thread-mini',
              onclick: () => (cookbookTriggerNew = true),
              icon: newRecipeIcon,
            },
          ]}
          <TopBarActions {actions} menuLabel="Recipe actions" />
          <div class="title-wrap">
            <span class="title-btn panel-section-label">Recipes</span>
          </div>

        {:else if drawerTab === 'memories'}
          <!-- Memories top-bar. A changelog launcher (leftmost, mirrors
               the wiki tab's changelog button) plus two manual-trigger
               actions for the memory librarian's two passes (deep-sleep
               = similarity-sweep consolidation; rem = conversation-
               batched associative integration). Like the wiki sparkle,
               these are NAVIGATION (they open the pass's confirm strip),
               so they stay enabled while a pass is in flight - the page's
               Run button is what disables, with a "running in the
               background" spinner. The panel owns the progress strip and
               the result line; these are just the launchers. -->
          {@const actions = [
            {
              id: 'changelog',
              label: 'Changelog',
              title: 'Memory changelog',
              onclick: () => (memoriesChangelogTrigger = true),
              icon: changelogIcon,
            },
            {
              id: 'deep-sleep',
              label: 'Deep-sleep pass',
              title: 'Run the deep-sleep pass (similarity-sweep consolidation)',
              onclick: () => (deepSleepTrigger = true),
              icon: deepSleepIcon,
            },
            {
              id: 'rem',
              label: 'Rem pass',
              title: 'Run the rem pass (associative integration over recent recall)',
              onclick: () => (remTrigger = true),
              icon: remIcon,
            },
          ]}
          <TopBarActions {actions} menuLabel="Memory actions" />
          <div class="title-wrap">
            <span class="title-btn panel-section-label">Memories</span>
          </div>
        {:else if drawerTab === 'wiki'}
          <!-- Wiki top-bar. No top-bar new-article button - the create
               affordance lives inline on the empty-state hint in
               Wiki.svelte, mirroring how Memories handles the same
               case. Static label in the title slot keeps the chrome
               consistent with the other tabs.

               changelog: the wiki tab's default surface, so this is a
               one-click "back to wiki home" from an article or the
               librarian page. skipped: a sibling FYI page for threads
               the agent passed over. librarian: opens the Wiki panel's
               confirmation strip (with an optional custom-instructions
               textarea). Disabled while either the scheduled worker is
               mid-run or a previous manual run is still in flight - we
               never want two librarian agents writing to the wiki
               concurrently. All three route through $bindable
               triggers (rather than direct navigate()) because the
               librarian's open/closed state lives in Wiki.svelte and
               must be touched alongside the route. The strips, runs, and
               summaries all live in Wiki.svelte; these are launchers. -->
          {@const actions = [
            {
              id: 'changelog',
              label: 'Changelog',
              title: 'Wiki changelog',
              onclick: () => (wikiChangelogTrigger = true),
              icon: changelogIcon,
            },
            {
              id: 'skipped',
              label: 'Skipped threads',
              title: 'Wiki skipped threads',
              onclick: () => (wikiSkippedTrigger = true),
              icon: skippedIcon,
            },
            {
              id: 'librarian',
              label: 'Run librarian',
              // Always enabled: this NAVIGATES to the librarian page, it
              // does not start a run. Disabling it would lock the user out
              // of the very page that shows the in-flight state. When a run
              // (theirs, another device's, or a scheduled sweep) is active,
              // the page itself shows a "running in the background" spinner
              // with a disabled Run button - driven by wikiLibrarianLease in
              // Wiki.svelte. The server-side guard remains the real mutual
              // exclusion.
              title: 'Run the wiki librarian',
              onclick: () => (wikiLibrarianTrigger = true),
              icon: librarianIcon,
            },
          ]}
          <TopBarActions {actions} menuLabel="Wiki actions" />
          <div class="title-wrap">
            <span class="title-btn panel-section-label">Wiki</span>
          </div>
        {:else if drawerTab === 'samskara'}
          <!-- Samskara diagnostics top-bar. Overview is a GLOBAL read
               (per-user, not per-samskara), so it lives on the top row
               rather than as a sub-tab next to the per-samskara Corpus
               detail (where it would read as belonging to the selected
               instinct). Overview -> the landing page: compound summary
               stacked above corpus-wide pipeline health. The only
               per-samskara surface, Corpus, is reached by selecting a
               sidebar row, so it needs no top-bar button. Routes through
               the Samskaras panel via a $bindable trigger because the
               sub-view state lives there. -->
          {@const actions = [
            {
              id: 'overview',
              label: 'Overview',
              title: 'Global compound summary + pipeline health',
              onclick: () => (samskaraOverviewTrigger = true),
              icon: overviewIcon,
            },
          ]}
          <TopBarActions {actions} menuLabel="Samskara actions" />
          <div class="title-wrap">
            <span class="title-btn panel-section-label">Samskara</span>
          </div>
        {:else}
          <!-- Library top-bar. The upload affordance lives inline in
               Library.svelte's panel (mirroring how Memories / Wiki put
               their create affordance inline), so the chrome here is just
               the static section label. -->
          <div class="title-wrap">
            <span class="title-btn panel-section-label">Library</span>
          </div>
        {/if}
        {#if drawerTab === 'chats' || drawerTab === 'artifacts'}
          <!-- Desktop-only transcript download, sitting beside the logs
               toggle as a trailing top-bar action. On mobile the same
               action lives in the chats overflow menu instead (see the
               transcript-export entry in the TopBarActions array), so
               this button hides under the 720px breakpoint. -->
          <button
            class="secondary icon-btn transcript-export-toggle"
            onclick={() => { if (activeThreadId) void exportTranscript(activeThreadId); }}
            disabled={!canExportTranscript(
              currentThread,
              route.digest !== null && drawerTab === 'chats',
              messages.length
            )}
            title="Download this conversation as Markdown"
            aria-label="Download this conversation as Markdown"
          >
            {@render transcriptDownloadIcon()}
          </button>
          <!-- Desktop-only copy-thread-ID. Sits beside the transcript
               download button so the two "get this conversation's data"
               actions are adjacent. Same mobile-hide pattern: the
               overflow menu carries the mobile copy. `secondary icon-btn`
               rides along so the button matches its 30px top-bar
               neighbors - the bare .copy-btn base is sized for the
               message-bubble action row and reads undersized here. -->
          {#if activeThreadId}
            <CopyButton
              text={activeThreadId}
              ariaLabel="Copy conversation ID"
              class="secondary icon-btn transcript-export-toggle"
              size={16}
            />
          {/if}
        {:else if drawerTab === 'recipes' && route.recipe}
          <!-- Copy-recipe-ID, mirroring the chats tab's copy-thread-ID
               placement beside the logs toggle. Pasting the UUID into a
               chat lets an agent reference the open recipe by id. Always
               visible (no mobile-hide class): the recipes top bar has no
               overflow-menu duplicate to defer to, and copying ids on
               mobile is this button's whole reason to exist. -->
          <CopyButton
            text={route.recipe}
            ariaLabel="Copy recipe ID"
            class="secondary icon-btn"
            size={16}
          />
        {:else if drawerTab === 'wiki' && route.wiki_article_id}
          <!-- Copy-article-ID, same placement contract as the recipe
               copy above. -->
          <CopyButton
            text={route.wiki_article_id}
            ariaLabel="Copy article ID"
            class="secondary icon-btn"
            size={16}
          />
        {/if}
        <!-- Logs drawer toggle. Lives outside the per-tab branches so it
             appears as the trailing top-bar action on chats, recipes,
             memories, wiki, and library alike - the in-app log viewer is a
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

      {#if drawerTab === 'chats' || drawerTab === 'artifacts'}
      {#if route.digest && drawerTab === 'chats'}
        <!-- Daily digest panel replaces the transcript while open
             (calendar button in the chats top-bar; routed via
             ?digest=1 so browser back closes it). Gated to the chats
             tab so flipping to Artifacts mid-digest still shows the
             conversation the drawer is managing files for. Lazy chunk:
             renders nothing for the import's first-open beat.
             onOpenThread routes through selectThread, which clears
             route.digest in the same navigate patch. -->
        {#if DigestPanelComp}
          <DigestPanelComp onOpenThread={(id: string) => { void selectThread(id); }} />
        {/if}
      {:else}
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
              : block.kind === 'generated-image'
              ? `generated-image:${block.key}`
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
                class:regen-target={pendingDeleteSet.has(block.assistant.id) || hoverRegenerateSet.has(block.assistant.id)}
                class:fading-out={fadeOutDelays[block.assistant.id] !== undefined}
                style:animation-delay={`${fadeOutDelays[block.assistant.id] ?? 0}ms`}
              >
                <AssistantBody
                  content={block.assistant.content}
                  reasoning={block.assistant.reasoning}
                  reasoningElapsed={reasoningPillsById[block.assistant.id]?.elapsed ?? null}
                  reasoningChars={reasoningPillsById[block.assistant.id]?.chars ?? null}
                  citations={block.assistant.citations}
                  secondThoughts={block.assistant.second_thoughts}
                  contextWindow={currentProfile.contextWindow}
                  usage={block.assistant.usage}
                  createdAt={block.assistant.created_at}
                  disabled={pendingDeleteSet.has(block.assistant.id) || (activeSlot?.sending ?? false)}
                  onRegenerate={() => { void regenerateFrom(block.assistant.id); }}
                  regenerateTitle={regenerateTitle(sharedRowSet.has(block.assistant.id))}
                  onRegeneratePreviewEnter={() => previewRegenerateFrom(block.assistant.id)}
                  onRegeneratePreviewLeave={clearRegeneratePreview}
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
            {:else if block.kind === 'generated-image'}
              <!-- Generated-image card: its own assistant bubble sitting
                   directly under the tool-group block whose generate_image
                   call produced it. GeneratedImageCard resolves the image
                   by filename and shows a sized Scanner placeholder until
                   it lands - it does NOT read the assistant row's
                   attachments, because the server-side per-round attach
                   never echoes over the messages realtime channel, so the
                   in-memory row stays attachment-less until a reload. -->
              <div class="msg assistant generated-image-host">
                <GeneratedImageCard
                  threadId={activeThreadId}
                  filename={block.filename}
                  aspectRatio={block.aspectRatio}
                />
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
                {#if AskUserCardComp}
                  <AskUserCardComp
                    mode={block.state}
                    question={block.question}
                    options={block.options}
                    answer={block.answeredContent}
                    busy={askUserSubmitBusy}
                    onSubmit={(answer, via, optionIndex) =>
                      answerAskUser(block.key, answer, via, optionIndex)}
                  />
                {/if}
              </div>
            {:else if block.message.role === 'assistant'}
              <div
                class="msg assistant"
                class:regen-target={pendingDeleteSet.has(block.message.id) || hoverRegenerateSet.has(block.message.id)}
                class:fading-out={fadeOutDelays[block.message.id] !== undefined}
                style:animation-delay={`${fadeOutDelays[block.message.id] ?? 0}ms`}
              >
                <AssistantBody
                  content={block.message.content}
                  reasoning={block.message.reasoning}
                  reasoningElapsed={reasoningPillsById[block.message.id]?.elapsed ?? null}
                  reasoningChars={reasoningPillsById[block.message.id]?.chars ?? null}
                  citations={block.message.citations}
                  secondThoughts={block.message.second_thoughts}
                  onRefine={block.message.id === latestAssistantId
                    ? () => { void refineFrom(block.message.id); }
                    : undefined}
                  contextWindow={currentProfile.contextWindow}
                  usage={block.message.usage}
                  createdAt={block.message.created_at}
                  disabled={pendingDeleteSet.has(block.message.id) || activeSlot?.sending}
                  onRegenerate={() => { void regenerateFrom(block.message.id); }}
                  regenerateTitle={regenerateTitle(sharedRowSet.has(block.message.id))}
                  onRegeneratePreviewEnter={() => previewRegenerateFrom(block.message.id)}
                  onRegeneratePreviewLeave={clearRegeneratePreview}
                  onFork={canForkAtMessage(block.message)
                    ? () => { void forkFromMessage(block.message.id); }
                    : undefined}
                  onForkPreviewEnter={() => previewForkFrom(block.message.id)}
                  onForkPreviewLeave={clearRegeneratePreview}
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
              {@const userStamp = isUser
                ? formatMessageStamp(block.message.created_at, app.displayTimezone)
                : null}
              <div
                class="msg {block.message.role}"
                class:regen-target={pendingDeleteSet.has(block.message.id) || hoverRegenerateSet.has(block.message.id)}
                class:fading-out={fadeOutDelays[block.message.id] !== undefined}
                style:animation-delay={`${fadeOutDelays[block.message.id] ?? 0}ms`}
              >
                <Markdown content={block.message.content} />
                {#if block.message.role === 'user' && block.message.attachments && block.message.attachments.length > 0}
                  <MessageAttachments attachments={block.message.attachments} />
                {/if}
                {#if isUser}
                  <!-- User-message action row. Mirrors the assistant
                       message's .msg-actions strip but lives outside
                       AssistantBody since user messages are rendered
                       directly in Chat.svelte. Reuses the shared
                       .msg-actions and .copy-btn rules so the visual
                       weight matches the assistant row's copy /
                       citations / regenerate buttons (14px outline
                       SVG, 2px stroke, hover ramps from muted to
                       text). Always renders for user rows so the
                       left-aligned timestamp has a home even on
                       cold-start turns; the cohort toggle only joins
                       the row when this turn actually fired samskaras
                       or wrote a substrate stub. -->
                  <div class="msg-actions">
                    {#if userStamp}
                      <!-- Left-aligned timestamp. `margin-right: auto`
                           on `.msg-time` pushes any buttons to the
                           right edge; with no cohort toggle it simply
                           sits alone on the left. -->
                      <span class="msg-time">{userStamp}</span>
                    {/if}
                    {#if hasInlineCohort}
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
                    {/if}
                    {#if canForkAtMessage(block.message)}
                      <!-- Fork-from-here. Copies the conversation up to
                           and including this message into a new
                           conversation and opens it; later rows stay
                           behind, untouched. Hover outlines the
                           stays-behind range via the shared regen
                           preview channel - the tooltip carries the
                           "nothing is deleted" difference. Hidden on
                           synthetic recovery rows (no DB row to fork
                           from yet). -->
                      <button
                        type="button"
                        class="copy-btn fork-btn"
                        title="Fork here - later messages stay in this conversation"
                        aria-label="Fork the conversation at this message"
                        disabled={activeSlot?.sending ?? false}
                        onclick={() => { void forkFromMessage(block.message.id); }}
                        onmouseenter={() => previewForkFrom(block.message.id)}
                        onmouseleave={clearRegeneratePreview}
                        onfocus={() => previewForkFrom(block.message.id)}
                        onblur={clearRegeneratePreview}
                      >
                        <!-- Feather "git-branch" - same glyph as the
                             drawer's fork indicator, in the action
                             row's 14px / 2px-stroke icon language. -->
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none"
                             stroke="currentColor" stroke-width="2" stroke-linecap="round"
                             stroke-linejoin="round" aria-hidden="true">
                          <line x1="6" y1="3" x2="6" y2="15" />
                          <circle cx="18" cy="6" r="3" />
                          <circle cx="6" cy="18" r="3" />
                          <path d="M18 9a9 9 0 0 1-9 9" />
                        </svg>
                      </button>
                    {/if}
                    <!-- Fork and edit. Forks from the message before
                         this user message, inserts a draft row with
                         the old text, opens the fork, and loads the
                         draft into the composer. The user edits and
                         sends normally. The old message stays in this
                         conversation, untouched. Disabled mid-send. -->
                    <button
                      type="button"
                      class="copy-btn fork-edit-btn"
                      title="Fork and edit - edit a copy of this message in a new conversation"
                      aria-label="Fork and edit this message"
                      disabled={activeSlot?.sending ?? false}
                      onclick={() => { void forkAndEdit(block.message.id); }}
                    >
                      <!-- Feather "edit-2" (pencil) - reads as "edit",
                           distinct from the git-branch fork icon. 14px,
                           2px stroke, same outline language. -->
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none"
                           stroke="currentColor" stroke-width="2" stroke-linecap="round"
                           stroke-linejoin="round" aria-hidden="true">
                        <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
                        <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
                      </svg>
                    </button>
                    <!-- Delete-from-here. Removes this user message and
                         every row after it, reverting the thread to its
                         pre-message state - or, when the range touches
                         history a fork depends on, continues in a new
                         fork instead (the tooltip switches to say so).
                         Disabled mid-send (a delete racing the
                         streaming turn would prune rows the loop is
                         still writing). Hovering red-outlines the
                         affected range via the shared regen preview
                         channel. -->
                    <button
                      type="button"
                      class="copy-btn delete-from-btn"
                      title={deleteFromTitle(sharedRowSet.has(block.message.id))}
                      aria-label={deleteFromTitle(sharedRowSet.has(block.message.id))}
                      disabled={activeSlot?.sending ?? false}
                      onclick={() => { void deleteFrom(block.message.id); }}
                      onmouseenter={() => previewDeleteFrom(block.message.id)}
                      onmouseleave={clearRegeneratePreview}
                      onfocus={() => previewDeleteFrom(block.message.id)}
                      onblur={clearRegeneratePreview}
                    >
                      <!-- Feather "trash-2" - matches the action row's
                           14px / 2px-stroke outline icon language. -->
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none"
                           stroke="currentColor" stroke-width="2" stroke-linecap="round"
                           stroke-linejoin="round" aria-hidden="true">
                        <polyline points="3 6 5 6 21 6" />
                        <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                        <line x1="10" y1="11" x2="10" y2="17" />
                        <line x1="14" y1="11" x2="14" y2="17" />
                      </svg>
                    </button>
                  </div>
                  {#if cohortExpanded && CohortPanelComp}
                    <div class="cohort-panel-host">
                      <CohortPanelComp
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
          {#if recoveryBanner}
            {@const isError = recoveryBanner.variant === 'error'}
            <!-- Unified recovery surface for the transcript tail. ONE
                 banner for every "this turn did not finish" state, chosen
                 by precedence in selectRecoveryBanner (error > recovered
                 interrupted-draft > generic cut-off tail). These used to
                 render as up to three independent stacked banners: a
                 session that died with a persisted user row AND a leftover
                 IndexedDB streaming draft satisfied two at once and showed
                 two near-identical retry boxes (the cut-off note plus the
                 interrupted-draft note). Collapsing to a single descriptor
                 guarantees exactly one banner - one message, one retry
                 path - on desktop and mobile alike.

                 The 'error' variant keeps the danger-tinted .msg-error
                 styling: leading "!" icon, an optional kind heading, and a
                 pre-wrap body so multi-line server errors (stack traces,
                 JSON) keep their structure. Fed by `displayedError`
                 (session streamingError or persisted thread.last_error);
                 the .error-bar above the composer still owns non-exchange
                 errors with no transcript anchor. The 'incomplete' variant
                 is the muted, italic note. Retry is disabled while a local
                 turn is sending; dismiss renders only when the source
                 offers one (error cards and the recoverable draft, never
                 the generic cut-off tail). See docs/dev/exchange.md for the
                 respondingElsewhere suppression that keeps the recovery
                 variants from offering a competing retry while a foreign
                 device holds a live claim. -->
            <div
              class="msg assistant"
              class:msg-error={isError}
              class:msg-incomplete={!isError}
              role={isError ? 'alert' : 'note'}
            >
              <div class:msg-error-body={isError} class:msg-incomplete-body={!isError}>
                {#if isError}
                  <span class="msg-error-icon" aria-hidden="true">!</span>
                {/if}
                <div class:msg-error-text={isError} class:msg-incomplete-text={!isError}>
                  {#if recoveryBanner.heading}
                    <strong class="msg-error-heading">{recoveryBanner.heading}</strong>
                  {/if}
                  {recoveryBanner.text}
                </div>
                {#if recoveryBanner.retry}
                  <button
                    type="button"
                    class="secondary icon-btn"
                    class:msg-error-retry={isError}
                    class:msg-incomplete-retry={!isError}
                    onclick={recoveryBanner.retry}
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
                {/if}
                {#if recoveryBanner.dismiss}
                  <button
                    type="button"
                    class="secondary icon-btn"
                    class:msg-error-dismiss={isError}
                    onclick={recoveryBanner.dismiss}
                    aria-label={isError ? 'Dismiss error' : 'Dismiss'}
                    title="Dismiss"
                  >×</button>
                {/if}
              </div>
            </div>
          {/if}
          <!-- Discarded "oops, all slop!" notice cards. One per streaming
               attempt an output guard rejected this turn (e.g. a leaked
                special token; see supabase/functions/venice/stream-guards.ts). Rendered above the
               live bubble so the failed attempt reads as having come
               before the replacement now streaming in below. Gated on
               the array, NOT on `sending`, so a card can finish its
               CRT-power-off animation even after the exchange ends.
               `dismissSlopNotices` flips `dying` to run the animation,
               then unmounts. Keyed by id so Svelte animates the right
               nodes out. -->
          {#each activeSlot?.slopNotices ?? [] as notice (notice.id)}
            <div
              class="msg assistant msg-slop-notice"
              class:crt-off={notice.dying}
              role="note"
            >
              <div class="msg-slop-notice-headline">{slopNoticeCopy(notice.guard).headline}</div>
              <div class="msg-slop-notice-detail">{slopNoticeCopy(notice.guard).detail}</div>
            </div>
          {/each}
          <!-- The streaming region is gated on `activeSlot?.sending` alone -
               the master flag for "chat loop is running". This keeps the
               throbber below on screen for the ENTIRE response cycle:
               from the moment the user hits send, through every reasoning
               + content delta, across every tool round (model assembles a
               tool call, tools execute, next round opens, text streams in
               again), and only winks out when the chat loop finally closes
               after the terminal round's `data: [DONE]`. Earlier shapes
               OR'd in `activeSlot?.streamingText || activeSlot?.streamingReasoning` defensively;
               that read as "is there content" rather than "is the
               turn alive" and made the region's lifetime ambiguous to
               anyone reading it.

               The response CARD (the bordered .msg.assistant bubble) is
               a tighter gate: it only mounts when it has something to
               show - reasoning, streaming text, the subconscious
               checklist, or the rate-limit wait row (streamingCardVisible).
               Both streaming buffers are cleared by onAssistantPersisted
               at every round boundary, so during the inter-round gap (and
               the initial pre-first-delta window) the card has no content;
               rendering it anyway would flash an empty bordered box. In
               those gaps only the throbber shows. The throbber sits OUTSIDE
               the card, as a standalone row below it, so it stays the last
               element in the transcript while a completion runs - which is
               exactly what the follow-bottom scroll anchors to (see
               scrollToBottom). -->
          {#if activeSlot && activeSlot.sending}
            <!-- activeSlot is non-null inside this block (the outer
                 condition guarantees it), so bindings can address its
                 fields directly without optional-chaining. -->
            {#if streamingCardVisible}
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
                elapsedPill={reasoningElapsedPill(
                  activeSlot.reasoningStartedAt,
                  activeSlot.reasoningEndedAt,
                  nowMs
                )}
                charPill={reasoningCharPill(activeSlot.streamingReasoning.length)}
                onToggle={() => {
                  activeSlot.reasoningUserToggled = true;
                }}
              />
              {#if activeSlot.streamingText}
                <!-- Live markdown render of the in-progress buffer. The
                     onTextUpdate handler throttles writes to ~20Hz (see
                     FLUSH_MS in send()), so marked + DOMPurify +
                     highlight.js only re-parse the growing string a few
                     times per second. Unclosed fences / bold / math
                     resolve themselves as more deltas arrive; once the
                     stream ends the persisted message rerenders through
                     this same <Markdown> path. -->
                <Markdown content={activeSlot.streamingText} />
              {/if}
              <!-- Subconscious-priming checklist. One row per
                   pre-response pipeline (samskara fire, intuition,
                   context recall) that fired this turn: a spinner while
                   running, a checkmark once done, so the user watches
                   the batch check off before the reply lands. The whole
                   group ease-fades out the moment the first reply chunk
                   arrives (subconsciousDismissed) - priming is finished
                   by then and the answer is the payoff. Rows persist
                   through the running -> done flip rather than
                   vanishing one by one; orderedSubconsciousRows pins the
                   row order regardless of which pipeline finishes first.
                   On a warm turn only the samskara fire runs (and may
                   fade mid-spin before checking off); a cold-start turn
                   shows all three. Lives inside the card, above the
                   throbber that sits below it - the user watches the
                   batch check off in the card while the pulse continues
                   underneath. -->
              {#if !activeSlot.subconsciousDismissed && subconsciousRows.length > 0}
                <div
                  class="subconscious-checklist"
                  role="status"
                  aria-live="polite"
                  transition:fade={{ duration: 240 }}
                >
                  {#each subconsciousRows as row (row.op)}
                    <div class="subconscious-status" class:done={row.status === 'done'}>
                      {#if row.status === 'done'}
                        <!-- Feather "check". Decorative - the row's label
                             text carries the meaning for screen readers, so
                             the glyph is aria-hidden to avoid a bare "check"
                             announcement. -->
                        <svg class="check" width="14" height="14" viewBox="0 0 24 24"
                             fill="none" stroke="currentColor" stroke-width="3"
                             stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                          <polyline points="20 6 9 17 4 12" />
                        </svg>
                      {:else}
                        <span class="spinner" aria-hidden="true"></span>
                      {/if}
                      <span>{subconsciousLabel(row.op)}</span>
                    </div>
                  {/each}
                </div>
              {/if}
              {#if activeSlot.rateLimitWaitUntil !== null}
                <!-- Rate-limit wait indicator. The last row in the card,
                     below any streaming Markdown; the throbber pulsing
                     below the card is the "still working" cue, and this
                     row tells the user specifically WHY that pulse has
                     gone quiet. The
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
            <!-- Continuous "still working" signal for the entire window
                 between "user hit send" and the chat loop actually closing -
                 including gaps that aren't emitting any deltas (model has
                 finished reasoning and is assembling a tool call; tools are
                 executing between rounds; round just ended, next round about
                 to start; final round persisted but post-loop bookkeeping
                 like refreshThreads is still running). Stays visible AFTER
                 streaming text starts arriving too: a single round can emit
                 text deltas and then switch to tool_call deltas within the
                 same assistant message, and once the text stops flowing the
                 turn otherwise reads as "done responding" even though the
                 model is still building a tool call on the wire. Cleared
                 only when `activeSlot?.sending` flips false in runExchange's
                 outer finally - by which time every round, every tool
                 execution, and every inter-round gap has played out.

                 Rendered OUTSIDE the response card, as a standalone row
                 below it, on purpose: the subconscious checklist and any
                 streaming content live in the card above, and the pulse
                 reads as a separate "the turn is alive" beat underneath.
                 It is the last element in .messages while sending EXCEPT
                 when the user has queued messages, whose cards render
                 below it (they are chronologically after this reply). The
                 follow-bottom scroll is scrollHeight-based, so it anchors
                 to whichever of the two is last and stays correct either
                 way; the respondingElsewhere / empty / archived blocks
                 further down are all mutually exclusive with an active
                 local completion. The wrapper centers the inline-flex
                 Scanner in the pane so it doesn't read as a stranded
                 artifact in the top-left corner. -->
            <div class="thinking streaming-throbber">
              <Scanner label={activeSlot?.reconnecting ? 'Reconnecting' : 'Thinking'} />
            </div>
          {/if}
          {#if activeSlot && activeSlot.queued.length > 0}
            <!-- Messages the user banked with the submit-modifier Enter
                 while this reply streamed. They are real user text that
                 has NOT been sent - no DB row exists until the queue
                 drains - so they render as user bubbles (same species,
                 so the eye reads them as "my words") held back by the
                 dashed border and reduced opacity.

                 Rendered outside the sending gate on purpose: a turn
                 that ends on an error does NOT drain the queue (see
                 maybeDrainQueuedMessages), and messages that survive
                 have to stay visible or they become invisible pending
                 sends the user cannot see, edit, or cancel.

                 The per-card x is the escape hatch: without it a
                 mis-queued message is unrecallable and fires the moment
                 the turn settles. -->
            <div class="queued-stack" role="group" aria-label="Queued messages">
              <div class="queued-heading">{queuedHeadline(activeSlot.queued.length)}</div>
              {#each activeSlot.queued as entry (entry.id)}
                {@const attachmentNote = queuedAttachmentSummary(entry)}
                <div class="msg user queued">
                  <div class="queued-body">
                    {#if entry.text}<div class="queued-text">{entry.text}</div>{/if}
                    {#if attachmentNote}
                      <div class="queued-attachment-note">{attachmentNote}</div>
                    {/if}
                  </div>
                  <button
                    type="button"
                    class="queued-remove"
                    onclick={() => unqueueMessage(entry.id)}
                    title="Remove from the queue"
                    aria-label="Remove queued message"
                  >×</button>
                </div>
              {/each}
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
        <!-- Diagnostic pills (recall / intuition / bias / samskara mood /
             intents), bottom-right of the messages pane. Mounted inside
             .messages-wrap (position:relative) so the absolutely-
             positioned column shares a coordinate system with
             .scroll-to-bottom and stays aligned regardless of composer
             height. The order, labels, and which pills show all live in
             the registry the component loops (src/lib/ui/diagnostic-
             pills.ts). The MOBILE twin of this surface is the
             <DiagnosticPills variant="mobile"> in the composer bar below.
             SamskaraMoodSync is the headless single owner of the mood
             data both surfaces read - mounted once here. -->
        <SamskaraMoodSync />
        <DiagnosticPills
          variant="desktop"
          recall={currentContextRecallPayload}
          intuition={currentIntuitionPayload}
        />
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
                {@const status = chipStatus(a)}
                <div
                  class="composer-attachment-chip"
                  class:pending={a.pending}
                  class:errored={!!a.error}
                  role="listitem"
                  title={a.error ??
                    (status.kind === 'compressed' || status.kind === 'rendering'
                      ? status.label
                      : '')}
                >
                  <span class="chip-name">{a.filename}</span>
                  {#if status.kind === 'compressed'}
                    <!-- Replaces the plain size with the reduction so the
                         user sees the payoff; the full label is also the
                         chip's tooltip above. -->
                    <span class="chip-size compressed">{status.label}</span>
                  {:else if status.kind === 'rendering'}
                    <!-- Same slot as the compression note: a long PDF's
                         render is the slowest attach-time step, so the page
                         counter replaces the size rather than sitting beside
                         a bare spinner the user can't read progress from. -->
                    <span class="chip-size">{status.label}</span>
                  {:else}
                    <span class="chip-size">{formatBytes(a.size_bytes)}</span>
                  {/if}
                  {#if status.kind === 'compressing'}
                    <span
                      class="chip-status chip-spinner"
                      aria-label="Compressing large image"
                    ></span>
                  {:else if status.kind === 'rendering'}
                    <span class="chip-status chip-spinner" aria-label="Rendering PDF pages"
                    ></span>
                  {:else if status.kind === 'pending'}
                    <!-- Generic in-flight state: no per-page or
                         compression detail to show, but it is doing
                         the same kind of work as the two branches
                         above, so it gets the same ring spinner
                         rather than a static ellipsis. -->
                    <span
                      class="chip-status chip-spinner"
                      aria-label="Processing"
                    ></span>
                  {:else if status.kind === 'error'}
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
            <!-- Mobile twin of the bottom-right desktop pill column (the
                 <DiagnosticPills variant="desktop"> up in .messages-wrap).
                 Docked next to the composer-wharf-trigger so both drop-ups
                 originate from the same neighborhood on the left edge. The
                 open state stays lifted here because closeMenus()
                 coordinates this wharf with the sibling model-picker wharf
                 and the outside-click handler keys on
                 .composer-diag-wharf.wharf-open. -->
            <DiagnosticPills
              variant="mobile"
              recall={currentContextRecallPayload}
              intuition={currentIntuitionPayload}
              open={composerDiagWharfOpen}
              onToggle={() => {
                const next = !composerDiagWharfOpen;
                closeMenus();
                composerDiagWharfOpen = next;
              }}
              onClose={closeMenus}
            />

            <div class="composer-bar-left" id="composer-wharf" class:wharf-open={composerWharfOpen}>
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
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none"
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
                  const next = !promptsMenuOpen;
                  closeMenus();
                  promptsMenuOpen = next;
                }}
                title="System prompts"
                aria-label="System prompts"
                aria-haspopup="true"
                aria-expanded={promptsMenuOpen}
                disabled={app.systemPrompts.length === 0}
              >
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor"
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

              <!-- Toolbox popover: each gated toolbox is an independent
                   on/off. Badge shows how many are on for this thread.
                   Pulses on LLM-initiated flips via .flash (see CSS).
                   Leads the picker cluster (ahead of model / reasoning /
                   verbosity) because toolbox choice is the most load-
                   bearing decision on this toolbar - cost and capability
                   pivot on it. The attach and prompts buttons sit ahead
                   of it: attach is a one-shot action and prompts is a
                   selector over user-configured options, neither a per-
                   conversation picker. Renders unconditionally - even
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
                  const next = !toolboxMenuOpen;
                  closeMenus();
                  toolboxMenuOpen = next;
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

              <!-- Model-profile picker: per-thread pin, stored on
                   threads.model as a profile id. Renders unconditionally —
                   even with no active thread the current profile is
                   well-defined (falls back to the user's default via
                   `resolveModelProfile`), and `setProfile` auto-creates
                   a draft on first pick so the choice has somewhere to
                   live. Gating on `currentThread` hid the button on any
                   fresh session where session-restore didn't pick a thread,
                   which on mobile is the common case. -->
              <button
                type="button"
                class="secondary model-picker-btn"
                onclick={() => {
                  const next = !modelMenuOpen;
                  closeMenus();
                  modelMenuOpen = next;
                }}
                aria-haspopup="true"
                aria-expanded={modelMenuOpen}
                title={`Model profile: ${currentProfile.name} (${currentProfile.modelId})`}
              >
                <!-- Generic "model selection" glyph for the collapsed
                     icon-only trigger. A CPU outline so the button reads
                     as "pick a model" on mobile, where the profile-name
                     label is hidden and only this icon shows. -->
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
                <span class="model-picker-label">{currentProfile.name}</span>
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                     stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                  <polyline points="6 9 12 15 18 9" />
                </svg>
              </button>

              <!-- Reasoning picker: per-thread override, stored on
                   threads.reasoning_effort (which can hold 'off' as well
                   as low/medium/high). Shows on any reasoning-capable
                   profile; 'Off' is a picker position rather than a reason
                   to hide the control, so a profile that defaults thinking
                   off still offers the knob. Hidden only when the model
                   can't reason at all. Renders with no active thread too:
                   `currentReasoning` falls back to the profile's default,
                   and `setReasoning` auto-creates a
                   draft on first pick so the choice has somewhere to land
                   — same pattern as the model picker.
                   Extracted so the picker is mountable in isolation under
                   @testing-library/svelte; Chat.svelte itself is too
                   coupled to the live app state to mount cleanly. -->
              {#if currentSupportsReasoning}
                <ReasoningPicker
                  value={currentReasoning}
                  defaultLevel={currentProfile.thinking}
                  open={reasoningMenuOpen}
                  onToggle={() => {
                    const next = !reasoningMenuOpen;
                    closeMenus();
                    reasoningMenuOpen = next;
                  }}
                  onSelect={(effort) => {
                    void setReasoning(effort);
                    reasoningMenuOpen = false;
                  }}
                />
              {/if}

              <!-- Verbosity picker: per-thread override, stored on
                   threads.verbosity. Surfaced unconditionally but
                   disabled when the model is recorded as rejecting the
                   knob (currentVerbosityRejected) - providers that
                   merely don't honor `text.verbosity` silently ignore
                   it, so the common no-support case stays enabled.
                   Same auto-create-draft pattern as the model and
                   reasoning pickers so the choice always has somewhere
                   to land. -->
              <VerbosityPicker
                value={currentVerbosity}
                defaultVerbosity={currentProfile.verbosity}
                disabled={currentVerbosityRejected}
                open={verbosityMenuOpen}
                onToggle={() => {
                  const next = !verbosityMenuOpen;
                  closeMenus();
                  verbosityMenuOpen = next;
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
                 sendButtonState resolves which of the three it is.
                 While a stream runs, the disabled rules that gate the
                 send path (empty composer, archived thread) are
                 intentionally ignored - stop must always be clickable
                 once a response is in flight, regardless of what the
                 user has typed next.

                 The 'continue' mode keeps the square and the stop
                 handler: with messages queued, stopping IS the way to
                 skip ahead to them (runExchange's tail drains the queue
                 on any settled turn, aborted or not), so a third icon
                 would imply a third code path that doesn't exist. The
                 count badge is what marks the difference. -->
            <button
              class="send-btn"
              class:is-stopping={sendButton.mode !== 'send'}
              onclick={sendButton.mode === 'send' ? send : stopStreaming}
              disabled={sendButton.disabled}
              title={sendButton.title}
              aria-label={sendButton.ariaLabel}
            >
              {#if sendButton.mode === 'send'}
                <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"
                     aria-hidden="true">
                  <path d="M2.01 21 23 12 2.01 3 2 10l15 2-15 2z" />
                </svg>
              {:else}
                <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"
                     aria-hidden="true">
                  <rect x="5" y="5" width="14" height="14" rx="2" />
                </svg>
              {/if}
              {#if sendButton.mode === 'continue'}
                <span class="send-btn-queue-count" aria-hidden="true"
                  >{activeSlot?.queued.length}</span
                >
              {/if}
            </button>

            {#if toolboxMenuOpen}
              <div class="composer-menu composer-menu-left" role="menu">
                <div class="menu-header">Toolboxes for this conversation</div>
                {#each allToolboxMeta as tb (tb.name)}
                  <label class="menu-item">
                    <input
                      type="checkbox"
                      checked={(currentThread?.toolboxes_enabled ?? []).includes(tb.name)}
                      onchange={() => void toggleToolboxManually(tb.name)}
                    />
                    <span class="menu-item-label">
                      <strong>
                        {tb.name.startsWith('mcp:') ? tb.name.slice(4) : tb.name}
                      </strong>
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
                <div class="menu-header">Model profile for this conversation</div>
                {#each app.modelProfiles as p (p.id)}
                  <button
                    type="button"
                    class="menu-item menu-item-btn"
                    class:selected={currentProfile.id === p.id}
                    onclick={() => {
                      void setProfile(p.id);
                      modelMenuOpen = false;
                    }}
                    role="menuitemradio"
                    aria-checked={currentProfile.id === p.id}
                  >
                    <span class="menu-item-label">
                      <strong>{p.name}</strong>
                      <span class="subtle" style="display:block;font-size:0.75rem"
                        >{p.modelId}</span
                      >
                    </span>
                    {#if p.isDefault}<span class="menu-item-badge">default</span>{/if}
                  </button>
                {/each}
              </div>
            {/if}

          </div>
        </div>
      </div>
      {/if}
      {:else if drawerTab === 'groceries'}
        <!-- Groceries panel: the current shopping list (add-input,
             section groups, acquired history, section management,
             inline editor). The sidebar GroceryList is the all-items
             browse that feeds it. Lazy-loaded like the other tabs. -->
        {#if GroceriesComp}
          <GroceriesComp />
        {/if}
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
             too. Editing happens inline on the cards.

             Three $bindable trigger props wire the top-bar buttons to
             the panel: `triggerChangelog` flips back to the changelog
             default surface, `triggerDeepSleep` for the slow-wave
             consolidation pass, `triggerRem` for the associative
             integration pass. Same trigger-then-reset pattern the
             wiki librarian uses. -->
        {#if MemoriesComp}
          <MemoriesComp
            bind:triggerDeepSleep={deepSleepTrigger}
            bind:triggerRem={remTrigger}
            bind:triggerChangelog={memoriesChangelogTrigger}
          />
        {/if}
      {:else if drawerTab === 'wiki'}
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
      {:else if drawerTab === 'samskara'}
        <!-- Samskara diagnostics panel. Overview is the default landing
             page (global compound summary stacked above corpus-wide
             pipeline health), reached via the single top-bar button.
             Corpus is the per-samskara detail: the sidebar
             SamskaraBrowseList drives route.samskara_id, which the panel
             uses to switch into it. `triggerOverviewView` wires the
             top-bar Overview button to the global surface. -->
        {#if SamskarasComp}
          <SamskarasComp
            bind:triggerOverviewView={samskaraOverviewTrigger}
          />
        {/if}
      {:else}
        <!-- Library panel. Inline, no modal chrome. The sidebar LibraryList
             shares the same `documentStore` so a search keystroke filters
             both surfaces. Upload / edit description / delete happen inline;
             selecting a document (route.document_id) shows its detail. -->
        {#if LibraryComp}
          <LibraryComp />
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
  {#if showSamskaraMood && SamskaraMoodComp}
    <SamskaraMoodComp onClose={() => navigate({ modal: null })} />
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
  {#if showIntents && IntentsComp}
    <IntentsComp onClose={() => navigate({ modal: null })} />
  {/if}
  {#if showRecall && RecallComp}
    <RecallComp
      onClose={() => navigate({ modal: null })}
      threads={loadedThreads}
      history={currentContextRecallHistory}
      userMessageByRound={userMessageByRound}
    />
  {/if}
  <!-- Cookbook, Memories, and Wiki now render inline in the main
       panel (drawerTab === 'recipes' / 'memories' / 'wiki') rather
       than as modals. -->
{/if}
