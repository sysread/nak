<script lang="ts">
  /*
   * Settings modal. Reached from the chat sidebar's gear icon. Seven
   * panes, each with its own persistence target:
   *
   *   keys        — the Supabase URL + publishable key. Persists to
   *                 localStorage as plaintext JSON (no encryption: the
   *                 publishable key is safe to expose by design) and
   *                 re-activates the in-memory services with the new
   *                 values.
   *   ai          — AI-adjacent subsections sharing one pane: default
   *                 model tier, default reasoning effort, the
   *                 system-prompt library, and the Venice web-search
   *                 toggle. All persist to the Supabase
   *                 `profiles.settings` blob so preferences follow the
   *                 account across browsers.
   *   appearance  — color mode + accent. Live-applies on click (no Save
   *                 button) and mirrors to Supabase the same way as
   *                 the default model.
   *   usage       — date-ranged snapshot of billed spend per model,
   *                 pulled from Venice's beta /billing/usage endpoint.
   *                 The default rolling-7-day view is cached in
   *                 usage-store.svelte and fetched lazily on first
   *                 open of this pane (and re-fetched when older
   *                 than USAGE_STALE_MS); custom date ranges fetch
   *                 on demand. Read-only; nothing persists to disk.
   *   export      — download the Supabase URL + publishable key as a
   *                 plaintext JSON file for import on another browser.
   *                 See config.ts for the file format.
   *   security    — Supabase account-password rotation. The local
   *                 config has no master password to rotate anymore
   *                 (retired with the streaming-root cleanup); this
   *                 pane is reduced to the auth password form.
   *   about       — build fingerprint + update-checker. Read-only.
   *
   * The `busy` flag is shared across forms so double-submits during an
   * in-flight save are harmless.
   *
   * Convention: AI / Appearance controls auto-apply on change. No
   * Save buttons. Each handler does an optimistic in-memory flip +
   * setter, then writes through to Supabase via `updateSettings`,
   * then rolls back the in-memory state if the write throws. Radios
   * and selects fire on `change`, checkboxes on `change`, free-form
   * text inputs on the input's `change` event (blur or Enter, only
   * when the value differs) so a half-typed value doesn't fire a
   * roundtrip per keystroke. The Keys and Security panes are the
   * deliberate exceptions - Keys re-activates services against new
   * endpoints and Security rotates the Supabase login, so a typo
   * auto-applied on either could lock the user out; both keep an
   * explicit Save gesture for "I really mean to change this." Those
   * two are the only Save buttons in the modal; if you find yourself
   * adding another one, the convention says you probably want
   * auto-apply with rollback instead. (The Timezone field in About
   * you autosaves on `change` like the other text inputs. It is the
   * one text field seeded with a value that is NOT persisted - the
   * browser-detected zone - so it also renders an amber "no timezone
   * set - using UTC" notice until a zone is actually committed, so the
   * suggestion is never mistaken for a saved value.)
   */
  import { onDestroy } from 'svelte';
  import { saveConfig, toExportedConfig } from '$lib/config';
  import {
    app,
    activate,
    persistModelProfiles,
    persistImageModel,
    persistDefaultLogLevel,
    persistEmphasisMarkdown,
    persistNotifyOnComplete,
    persistWikiAutomaticEnabled,
    persistIntentsEnabled,
    persistWikiRecordExtractionEnabled,
    persistWikiLibrarianEnabled,
    persistMemoryLibrarianEnabled,
    persistDisplayTimezone,
    persistSystemPrompts,
    persistTheme,
    persistUserName,
    persistUserLocation,
  } from '$lib/state.svelte';
  import { detectTimezone, normalizeTimezone } from '$lib/timezone';
  import { resetAllWikiData } from '$lib/wiki-store.svelte';
  import { isSupported as notificationsSupported, requestPermission } from '$lib/notifications.svelte';
  import { LOG_LEVELS, LOG_LEVEL_LABELS, type LogLevel } from '$lib/logger.svelte';
  import {
    THINKING_LEVELS,
    THINKING_LEVEL_LABELS,
    VERBOSITIES,
    VERBOSITY_LABELS,
    VENICE_DEFAULT_IMAGE_MODEL,
    type ModelProfile,
    type ThinkingLevel,
    type Verbosity,
  } from '$lib/models';
  import { priceCapHiddenNote } from '$lib/ui/model-picker';
  import * as profilesLib from '$lib/ui/model-profiles';
  import {
    buildImageModelOptions,
    imageModelLabel,
    imageModelOverrideFor,
  } from '$lib/ui/image-model-picker';
  import {
    aboutActionLabel,
    authPasswordError,
    exportConfigFilename,
    formatBuildTime,
    notifyOnCompleteNotice,
    notifyPermissionNudgeVisible,
    notifyPermissionRequestNotice,
    toggleNotice,
    userFieldNotice,
  } from '$lib/ui/settings';
  import {
    catalog,
    shouldAutoRefreshCatalog,
    refreshCatalog,
  } from '$lib/models-catalog.svelte';
  import {
    imageCatalog,
    shouldAutoRefreshImageCatalog,
    refreshImageCatalog,
  } from '$lib/image-models-catalog.svelte';
  import { filterCatalogByCaps, filterImageCatalogByCap } from '$lib/models/price-caps';
  import type { SystemPrompt } from '$lib/supabase';
  import * as prompts from '$lib/ui/prompts';
  import {
    ACCENTS,
    MODES,
    STYLES,
    ACCENT_LABELS,
    ACCENT_SWATCHES,
    MODE_LABELS,
    STYLE_LABELS,
    STYLE_DESCRIPTIONS,
    effectiveMode,
    type Accent,
    type ColorMode,
    type UiStyle,
  } from '$lib/theme';
  import SecretInput from '../components/SecretInput.svelte';
  import ModelCombobox from '../components/ModelCombobox.svelte';
  import ImageModelSelect from '../components/ImageModelSelect.svelte';
  import { updateState, applyUpdate, checkForUpdates } from '$lib/update.svelte';
  import { VeniceError } from '$lib/venice';
  import { type UsageModelBucket } from '$lib/usage';
  import {
    aggregateTotalsByCurrency,
    aggregateUsage,
    daysInPickedRange,
    formatAmount,
    formatAmountPerDay,
    formatTokens,
    isCreditCurrency,
    modelCountNoun,
    perDayTitle,
    relativeHue,
    spendPillTitle,
    todayYmd,
    usageBarPercent,
    ymdDaysAgo,
  } from '$lib/ui/usage';
  import {
    usage,
    shouldAutoRefreshUsage,
    refreshUsage,
  } from '$lib/usage-store.svelte';

  interface Props {
    onClose: () => void;
  }
  let { onClose }: Props = $props();

  type Group =
    | 'keys'
    | 'ai'
    | 'modelprofiles'
    | 'customprompts'
    | 'memory'
    | 'wiki'
    | 'appearance'
    | 'usage'
    | 'security'
    | 'about';
  // Tabs are ordered by nearness of subject to the user: the app itself
  // (About), then the user's own presentation and personal data
  // (Appearance, Memory, Wiki), then the assistant (AI, then the model
  // profiles and custom-prompt library that ride on top of it), then the
  // account/infrastructure tail furthest from day-to-day use (Usage,
  // Security, API keys). Model profiles and Custom prompts sit right
  // after AI because they are the same subject (how the assistant
  // behaves) but each carries a tall card list that would push the AI
  // pane's other controls below the fold.
  const GROUPS: { id: Group; label: string }[] = [
    { id: 'about', label: 'About' },
    { id: 'appearance', label: 'Appearance' },
    { id: 'memory', label: 'Memory' },
    { id: 'wiki', label: 'Wiki' },
    { id: 'ai', label: 'AI' },
    { id: 'modelprofiles', label: 'Model profiles' },
    { id: 'customprompts', label: 'Custom prompts' },
    { id: 'usage', label: 'Usage' },
    { id: 'security', label: 'Security' },
    { id: 'keys', label: 'API keys' },
  ];
  // Default landing tab is always the first in GROUPS, so reordering the
  // nav moves the default with it - no separate constant to keep in sync.
  let group = $state<Group>(GROUPS[0].id);

  // --- Keys pane ---
  let supabaseUrl = $state(app.config?.supabaseUrl ?? '');
  let supabasePublishableKey = $state(app.config?.supabasePublishableKey ?? '');
  let keysError = $state<string | null>(null);
  let keysInfo = $state<string | null>(null);

  // --- AI pane ---
  // Opt-in formatting nudge. When on, chat-loop appends a short
  // instruction block to the per-turn system prompt asking the model
  // to use light Markdown emphasis as scan-points. Persisted on
  // `profiles.settings.emphasisMarkdown`.
  let emphasisMarkdown = $state<boolean>(app.emphasisMarkdown);
  // Opt-in intents toggle (off by default). Persisted on
  // `profiles.settings.intentsEnabled`; the minting/evaluation sweeps
  // and applyIntentPriming all read it server-side.
  let intentsEnabled = $state<boolean>(app.intentsEnabled);
  let intentsError = $state<string | null>(null);
  let intentsInfo = $state<string | null>(null);
  // Opt-in completion-notification toggle. Persisted on
  // `profiles.settings.notifyOnComplete`. Flipping on triggers a
  // browser permission prompt via onToggleNotifyOnComplete - if the
  // user denies we snap back off, since the in-app unread dot alone
  // isn't what the toggle advertises.
  let notifyOnComplete = $state<boolean>(app.notifyOnComplete);
  // Per-device snapshot of the browser-level Notification permission.
  // The `notifyOnComplete` preference syncs across devices via Supabase
  // but the OS-level grant is per-origin-per-browser and doesn't sync,
  // so a user who enabled the toggle on phone will arrive at desktop
  // with the checkbox already on AND no permission granted - silently
  // breaking notifications on the new device. We snapshot the current
  // permission so the pane can offer an inline re-grant button when
  // the two diverge. Refreshed inside the toggle handler (which calls
  // requestPermission itself) and inside onEnableNotifyPermission.
  let notifyPermission = $state<NotificationPermission | 'unsupported'>(
    typeof window !== 'undefined' && 'Notification' in window
      ? Notification.permission
      : 'unsupported'
  );
  // Free-form profile fields injected into the system-prompt
  // appendix on every turn. Saved on the input's `change` event
  // (fires on blur or Enter when the value changed) so a half-typed
  // name doesn't fire a roundtrip per keystroke but the user never
  // has to find a Save button - same hands-off feel as the toggles
  // and radios on this pane. Persisted on
  // `profiles.settings.userName` / `profiles.settings.userLocation`.
  let userName = $state<string>(app.userName);
  let userLocation = $state<string>(app.userLocation);
  let modelError = $state<string | null>(null);
  let modelInfo = $state<string | null>(null);

  // Display timezone. Lives in the AI -> About you section because
  // the model uses it to reason about "what time is it for the user"
  // in the per-turn metadata system message; the wiki agent reads it
  // too to bucket day-eligible threads. Persisted on
  // `profiles.settings.displayTimezone`.
  let displayTimezone = $state<string>(app.displayTimezone || detectTimezone());
  // Saved-vs-suggested status for the timezone field. The field autosaves
  // on `change` like Name/Location, but differs in one way: it is seeded
  // with a browser-detected guess (detectTimezone()) that is NOT persisted,
  // so the box looks filled in even when nothing is stored and the server
  // day-gates fall back to UTC. tzSavedValue is the actual persisted value
  // ("" until the first write); app.displayTimezonePersisted distinguishes
  // "stored" from "merely suggested" so the status line can flag the
  // UTC-default state until the user commits a zone.
  const tzSavedValue = $derived(
    app.displayTimezonePersisted ? app.displayTimezone : ''
  );

  // Effective image-generation model: the user's override, or the
  // built-in default when unset. Drives the picker's selected value and
  // the synthetic "current" option when the id isn't in the live catalog.
  const effectiveImageModel = $derived(app.imageModel ?? VENICE_DEFAULT_IMAGE_MODEL);

  // --- Wiki pane ---
  // Toggle for the autonomous wiki agent. The toggle pushes through
  // state.svelte.ts so the worker starts/stops in real time, and
  // persists on `profiles.settings.wikiAutomaticEnabled`.
  let wikiAutomaticEnabled = $state<boolean>(app.wikiAutomaticEnabled);
  let wikiRecordExtractionEnabled = $state<boolean>(app.wikiRecordExtractionEnabled);
  let wikiLibrarianEnabled = $state<boolean>(app.wikiLibrarianEnabled);
  let memoryLibrarianEnabled = $state<boolean>(app.memoryLibrarianEnabled);
  let memoryLibrarianInfo = $state<string | null>(null);
  let memoryLibrarianError = $state<string | null>(null);
  let wikiError = $state<string | null>(null);
  let wikiInfo = $state<string | null>(null);
  let wikiResetBusy = $state(false);

  // --- Prompts pane ---
  // Local working copy of the prompt library. We edit this in memory and
  // push the full updated array to Supabase on every change so the UX is
  // as simple as "type and it saves". Debouncing could come later.
  let promptsDraft = $state<SystemPrompt[]>(
    app.systemPrompts.map((p) => ({ ...p }))
  );
  let promptsError = $state<string | null>(null);
  // A three-state save indicator for the floating status badge in the
  // Prompts pane footer. `idle` renders nothing; `saving` is shown as
  // soon as the user edits (covering both the debounce window and the
  // in-flight request); `saved` sticks around until the next edit.
  let promptsSaveState = $state<'idle' | 'saving' | 'saved'>('idle');
  let promptsSaving = $state(false);
  let promptsDebounce: ReturnType<typeof setTimeout> | null = null;

  // If Chat.svelte updates app.systemPrompts (from a fresh Supabase pull
  // on auth settle), re-sync the draft so the Prompts tab shows the
  // server-side truth instead of a stale local array.
  $effect(() => {
    // Only resync when we aren't actively editing — otherwise every
    // keystroke would nuke the user's in-progress edit.
    if (promptsDebounce !== null || promptsSaving) return;
    const live = app.systemPrompts;
    if (!prompts.promptsMatch(live, promptsDraft)) {
      promptsDraft = live.map((p) => ({ ...p }));
    }
  });

  function addPrompt(): void {
    promptsDraft = prompts.addPrompt(promptsDraft);
    schedulePromptsSave();
  }

  function updatePrompt(id: string, patch: Partial<SystemPrompt>): void {
    promptsDraft = prompts.updatePrompt(promptsDraft, id, patch);
    schedulePromptsSave();
  }

  function deletePrompt(id: string): void {
    promptsDraft = prompts.deletePrompt(promptsDraft, id);
    schedulePromptsSave();
  }

  // --- Drag-and-drop reorder ---
  // Native HTML5 DnD. A grip handle on each card carries draggable=true
  // (so dragging from inside the name input / body textarea still selects
  // text); the cards themselves are the drop targets. `dragId` is the
  // prompt being dragged, `dragOverId` is the card the pointer is hovering
  // so the template can draw an insertion line. Both clear on drop / end.
  let dragId = $state<string | null>(null);
  let dragOverId = $state<string | null>(null);

  function onPromptDragStart(id: string, e: DragEvent): void {
    dragId = id;
    // Required for Firefox to start a drag at all; the payload itself is
    // unused since we track the dragged id in component state.
    e.dataTransfer?.setData('text/plain', id);
    if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move';
  }

  function onPromptDragOver(id: string, e: DragEvent): void {
    if (dragId === null) return;
    // preventDefault is what marks this element as a valid drop target;
    // without it the browser fires no drop event.
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
    dragOverId = id;
  }

  function onPromptDrop(targetId: string, e: DragEvent): void {
    e.preventDefault();
    const from = promptsDraft.findIndex((p) => p.id === dragId);
    const to = promptsDraft.findIndex((p) => p.id === targetId);
    dragId = null;
    dragOverId = null;
    if (from === -1 || to === -1 || from === to) return;
    promptsDraft = prompts.reorderPrompts(promptsDraft, from, to);
    schedulePromptsSave();
  }

  function onPromptDragEnd(): void {
    dragId = null;
    dragOverId = null;
  }

  // --- Touch long-press reorder (mobile) ---
  // Native HTML5 DnD never fires on touch, so phones get a parallel path:
  // press and hold the grip for LONG_PRESS_MS and the card "lifts" (the
  // .touch-dragging style + a haptic tick where supported), after which
  // sliding the finger over another card marks it as the drop target and
  // lifting the finger drops there. A finger that travels more than
  // TOUCH_SLOP before the timer fires is read as a scroll attempt, not a
  // hold, and cancels the press. Touch events all dispatch to the
  // touchstart target (the grip) for the life of the gesture, so we
  // resolve the card actually under the finger via elementFromPoint.
  const LONG_PRESS_MS = 1000;
  const TOUCH_SLOP = 10; // px of travel that still counts as "held still"
  let touchDragId = $state<string | null>(null);
  let longPressTimer: ReturnType<typeof setTimeout> | null = null;
  let touchStartY = 0;

  function clearLongPress(): void {
    if (longPressTimer !== null) {
      clearTimeout(longPressTimer);
      longPressTimer = null;
    }
  }

  function onPromptTouchStart(id: string, e: TouchEvent): void {
    const t = e.touches[0];
    if (!t) return;
    touchStartY = t.clientY;
    clearLongPress();
    longPressTimer = setTimeout(() => {
      longPressTimer = null;
      touchDragId = id;
      dragOverId = id;
      // Haptic confirmation that the card is now liftable. Optional
      // chaining: most desktop browsers and iOS Safari don't implement
      // Vibration, and a missing API must not break the activation.
      navigator.vibrate?.(15);
    }, LONG_PRESS_MS);
  }

  function onPromptTouchMove(e: TouchEvent): void {
    const t = e.touches[0];
    if (!t) return;
    if (touchDragId === null) {
      // Pre-activation: a finger that wanders is scrolling, not holding.
      if (Math.abs(t.clientY - touchStartY) > TOUCH_SLOP) clearLongPress();
      return;
    }
    // Active drag: stop the pane scrolling under the finger and track
    // which card the finger is currently over.
    e.preventDefault();
    const el = document.elementFromPoint(t.clientX, t.clientY);
    const card = el?.closest<HTMLElement>('.prompt-card[data-prompt-id]');
    if (card?.dataset.promptId) dragOverId = card.dataset.promptId;
  }

  function onPromptTouchEnd(): void {
    clearLongPress();
    if (touchDragId === null) return;
    const from = promptsDraft.findIndex((p) => p.id === touchDragId);
    const to = promptsDraft.findIndex((p) => p.id === dragOverId);
    touchDragId = null;
    dragOverId = null;
    if (from === -1 || to === -1 || from === to) return;
    promptsDraft = prompts.reorderPrompts(promptsDraft, from, to);
    schedulePromptsSave();
  }

  function schedulePromptsSave(): void {
    // Transition to 'saving' immediately on edit so the icon reflects
    // intent even during the debounce window — otherwise the user might
    // see 'saved' during the pause between last keystroke and flush.
    promptsSaveState = 'saving';
    if (promptsDebounce) clearTimeout(promptsDebounce);
    promptsDebounce = setTimeout(() => {
      promptsDebounce = null;
      void savePrompts();
    }, 500);
  }

  async function savePrompts(): Promise<void> {
    promptsError = null;
    promptsSaving = true;
    try {
      await persistSystemPrompts(promptsDraft);
      promptsSaveState = 'saved';
    } catch (err) {
      promptsError = err instanceof Error ? err.message : String(err);
      promptsSaveState = 'idle';
    } finally {
      promptsSaving = false;
    }
  }

  // --- Model profiles pane ---
  // Local working copy of the profile list, same draft + debounced-
  // wholesale-save shape as the Custom prompts pane: every mutation is a
  // pure list transform (src/lib/ui/model-profiles.ts) over this array,
  // and the whole list persists 500ms after the last edit. The one
  // difference is a validation gate - profile names must be non-empty
  // and unique (they are the composer menu's row labels), so an invalid
  // draft parks on an inline error and the save re-arms when the user
  // fixes the name.
  let profilesDraft = $state<ModelProfile[]>(
    app.modelProfiles.map((p) => ({ ...p }))
  );
  let profilesError = $state<string | null>(null);
  let profilesSaveState = $state<'idle' | 'saving' | 'saved'>('idle');
  let profilesSaving = $state(false);
  let profilesDebounce: ReturnType<typeof setTimeout> | null = null;
  // The validation the autosave gates on; also rendered inline.
  const profilesNameError = $derived(profilesLib.profileNamesError(profilesDraft));

  // Resync from a fresh Supabase pull unless the user is mid-edit -
  // same guard as the prompts draft above.
  $effect(() => {
    if (profilesDebounce !== null || profilesSaving) return;
    const live = app.modelProfiles;
    if (!profilesLib.profilesMatch(live, profilesDraft)) {
      profilesDraft = live.map((p) => ({ ...p }));
    }
  });

  function addProfile(): void {
    profilesDraft = profilesLib.addProfile(profilesDraft);
    scheduleProfilesSave();
  }

  function updateProfile(id: string, patch: Partial<ModelProfile>): void {
    profilesDraft = profilesLib.updateProfile(profilesDraft, id, patch);
    scheduleProfilesSave();
  }

  function deleteProfile(id: string): void {
    profilesDraft = profilesLib.deleteProfile(profilesDraft, id);
    scheduleProfilesSave();
  }

  function setDefaultProfile(id: string): void {
    profilesDraft = profilesLib.setDefaultProfile(profilesDraft, id);
    scheduleProfilesSave();
  }

  // Re-point a profile at a model picked from the combobox. A live
  // catalog row refreshes the capability snapshot wholesale; re-picking
  // the synthetic off-catalog "current" option is a no-op (there's
  // nothing fresher to copy from).
  function onPickProfileModel(id: string, modelId: string): void {
    const model = (catalog.data ?? []).find((m) => m.id === modelId);
    if (!model) return;
    const current = profilesDraft.find((p) => p.id === id);
    if (!current) return;
    profilesDraft = profilesLib.updateProfile(
      profilesDraft,
      id,
      profilesLib.profileWithCatalogModel(current, model)
    );
    scheduleProfilesSave();
  }

  // Drag / long-press reorder for profile cards. Shares the pure array
  // move shape with the prompts pane but keeps its own gesture state -
  // the two panes never render together, yet separate ids keep a stale
  // timer from one pane ever mutating the other's draft.
  let profileDragId = $state<string | null>(null);
  let profileDragOverId = $state<string | null>(null);
  let profileTouchDragId = $state<string | null>(null);
  let profileLongPressTimer: ReturnType<typeof setTimeout> | null = null;
  let profileTouchStartY = 0;

  function onProfileDragStart(id: string, e: DragEvent): void {
    profileDragId = id;
    // Required for Firefox to start a drag at all; the payload itself is
    // unused since we track the dragged id in component state.
    e.dataTransfer?.setData('text/plain', id);
    if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move';
  }

  function onProfileDragOver(id: string, e: DragEvent): void {
    if (profileDragId === null) return;
    // preventDefault is what marks this element as a valid drop target;
    // without it the browser fires no drop event.
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
    profileDragOverId = id;
  }

  function onProfileDrop(targetId: string, e: DragEvent): void {
    e.preventDefault();
    const from = profilesDraft.findIndex((p) => p.id === profileDragId);
    const to = profilesDraft.findIndex((p) => p.id === targetId);
    profileDragId = null;
    profileDragOverId = null;
    if (from === -1 || to === -1 || from === to) return;
    profilesDraft = profilesLib.reorderProfiles(profilesDraft, from, to);
    scheduleProfilesSave();
  }

  function onProfileDragEnd(): void {
    profileDragId = null;
    profileDragOverId = null;
  }

  function clearProfileLongPress(): void {
    if (profileLongPressTimer !== null) {
      clearTimeout(profileLongPressTimer);
      profileLongPressTimer = null;
    }
  }

  function onProfileTouchStart(id: string, e: TouchEvent): void {
    const t = e.touches[0];
    if (!t) return;
    profileTouchStartY = t.clientY;
    clearProfileLongPress();
    profileLongPressTimer = setTimeout(() => {
      profileLongPressTimer = null;
      profileTouchDragId = id;
      profileDragOverId = id;
      // Haptic confirmation that the card is now liftable. Optional
      // chaining: most desktop browsers and iOS Safari don't implement
      // Vibration, and a missing API must not break the activation.
      navigator.vibrate?.(15);
    }, LONG_PRESS_MS);
  }

  function onProfileTouchMove(e: TouchEvent): void {
    const t = e.touches[0];
    if (!t) return;
    if (profileTouchDragId === null) {
      // Pre-activation: a finger that wanders is scrolling, not holding.
      if (Math.abs(t.clientY - profileTouchStartY) > TOUCH_SLOP) {
        clearProfileLongPress();
      }
      return;
    }
    // Active drag: stop the pane scrolling under the finger and track
    // which card the finger is currently over.
    e.preventDefault();
    const el = document.elementFromPoint(t.clientX, t.clientY);
    const card = el?.closest<HTMLElement>('.prompt-card[data-profile-id]');
    if (card?.dataset.profileId) profileDragOverId = card.dataset.profileId;
  }

  function onProfileTouchEnd(): void {
    clearProfileLongPress();
    if (profileTouchDragId === null) return;
    const from = profilesDraft.findIndex((p) => p.id === profileTouchDragId);
    const to = profilesDraft.findIndex((p) => p.id === profileDragOverId);
    profileTouchDragId = null;
    profileDragOverId = null;
    if (from === -1 || to === -1 || from === to) return;
    profilesDraft = profilesLib.reorderProfiles(profilesDraft, from, to);
    scheduleProfilesSave();
  }

  function scheduleProfilesSave(): void {
    profilesSaveState = 'saving';
    if (profilesDebounce) clearTimeout(profilesDebounce);
    profilesDebounce = setTimeout(() => {
      profilesDebounce = null;
      void saveProfiles();
    }, 500);
  }

  async function saveProfiles(): Promise<void> {
    // Park on the name error rather than persist a list the coercer
    // would mangle (it drops a blank-named profile outright, silently
    // losing the card). The next edit re-arms the debounce, so fixing
    // the name is what saves.
    if (profilesNameError !== null) {
      profilesError = profilesNameError;
      profilesSaveState = 'idle';
      return;
    }
    profilesError = null;
    profilesSaving = true;
    try {
      await persistModelProfiles(profilesDraft);
      profilesSaveState = 'saved';
    } catch (err) {
      profilesError = err instanceof Error ? err.message : String(err);
      profilesSaveState = 'idle';
    } finally {
      profilesSaving = false;
    }
  }

  // Closing the modal mid-debounce would otherwise drop the user's
  // most recent prompt or profile edit on the floor (the timer outlives
  // the component but its closure writes to state nobody reads anymore,
  // and the persist never gets called). Cancel the pending timers and
  // fire one final fire-and-forget save so the typed-but-unsent state
  // lands on the server. Safe to no-op when there's no pending edit.
  onDestroy(() => {
    if (promptsDebounce !== null) {
      clearTimeout(promptsDebounce);
      promptsDebounce = null;
      void savePrompts();
    }
    if (profilesDebounce !== null) {
      clearTimeout(profilesDebounce);
      profilesDebounce = null;
      void saveProfiles();
    }
  });

  // --- Appearance pane ---
  let colorMode = $state<ColorMode>(app.colorMode);
  let accent = $state<Accent>(app.accent);
  let uiStyle = $state<UiStyle>(app.uiStyle);
  let defaultLogLevel = $state<LogLevel>(app.defaultLogLevel);
  let appearanceError = $state<string | null>(null);
  let appearanceInfo = $state<string | null>(null);

  // Apply selection live as the user clicks - no Save button needed.
  // Theme has three axes (mode + accent + style), so each picker
  // assembles the full triple and routes through the same persist
  // helper.
  async function onPickMode(next: ColorMode): Promise<void> {
    const prevMode = colorMode;
    colorMode = next;
    appearanceError = null;
    appearanceInfo = null;
    try {
      await persistTheme(next, accent, uiStyle);
      appearanceInfo = 'Saved.';
    } catch (err) {
      colorMode = prevMode;
      appearanceError = err instanceof Error ? err.message : String(err);
    }
  }
  async function onPickAccent(next: Accent): Promise<void> {
    const prevAccent = accent;
    accent = next;
    appearanceError = null;
    appearanceInfo = null;
    try {
      await persistTheme(colorMode, next, uiStyle);
      appearanceInfo = 'Saved.';
    } catch (err) {
      accent = prevAccent;
      appearanceError = err instanceof Error ? err.message : String(err);
    }
  }
  async function onPickStyle(next: UiStyle): Promise<void> {
    const prevStyle = uiStyle;
    uiStyle = next;
    appearanceError = null;
    appearanceInfo = null;
    try {
      await persistTheme(colorMode, accent, next);
      appearanceInfo = 'Saved.';
    } catch (err) {
      uiStyle = prevStyle;
      appearanceError = err instanceof Error ? err.message : String(err);
    }
  }
  // Default log level lives in Appearance because it's a pure
  // presentation preference - what the drawer starts out showing.
  // The LogsDrawer seeds its own filter from app.defaultLogLevel
  // each time it opens; per-session overrides via the drawer's own
  // dropdown are deliberately not persisted.
  async function onPickLogLevel(next: LogLevel): Promise<void> {
    const prev = defaultLogLevel;
    defaultLogLevel = next;
    appearanceError = null;
    appearanceInfo = null;
    try {
      await persistDefaultLogLevel(next);
      appearanceInfo = 'Saved.';
    } catch (err) {
      defaultLogLevel = prev;
      appearanceError = err instanceof Error ? err.message : String(err);
    }
  }

  // --- Export pane ---
  let exportInfo = $state<string | null>(null);
  let exportError = $state<string | null>(null);

  function onExportConfig(): void {
    exportInfo = null;
    exportError = null;
    if (!app.config) {
      exportError = 'No active config to export.';
      return;
    }
    try {
      const blob = new Blob([JSON.stringify(toExportedConfig(app.config), null, 2)], {
        type: 'application/json',
      });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = exportConfigFilename();
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      exportInfo = 'Download started.';
    } catch (err) {
      exportError = err instanceof Error ? err.message : String(err);
    }
  }

  // --- Usage pane ---
  // Backed by Venice's /billing/usage-analytics (beta per Venice docs).
  // Venice aggregates per-model spend + token totals server-side and
  // returns them in one cached response; the pane renders that roll-up
  // as a token-scaled bar chart with a spend pill per row.
  //
  // Date picker values are yyyy-mm-dd strings (the format
  // `<input type="date">` produces and consumes). The analytics endpoint
  // takes date-only bounds and reads `endDate` as inclusive, so the
  // picker values pass straight through with no ISO conversion.
  //
  // The pane's display decisions (bucket fan-out, totals, formatters,
  // pill tooltips, bar scaling) live in $lib/ui/usage.

  // Default range: rolling 7-day window. A week is the shortest
  // useful slice — long enough to smooth over a single heavy day,
  // short enough that the pane loads quickly and the bars reflect
  // recent habits rather than a month-old workload.
  //
  // Captured at component mount (Settings is a new instance on every
  // open) so a user who changes the dates and later edits them back
  // still matches the stored range to the byte; comparing against a
  // recomputed ymdDaysAgo() on every keystroke would drift if the day
  // rolled over mid-session.
  const DEFAULT_USAGE_START = ymdDaysAgo(7);
  const DEFAULT_USAGE_END = todayYmd();
  let usageStart = $state<string>(DEFAULT_USAGE_START);
  let usageEnd = $state<string>(DEFAULT_USAGE_END);

  /**
   * Display source for the Usage pane. 'store' draws from the
   * background-polled default-range cache in `$lib/usage-store.svelte`
   * (the common case - Settings opens, shows whatever the last poll
   * captured, kicks a refresh if >15 min stale). 'custom' draws from
   * component-local state filled by a user-initiated fetch of a
   * non-default date range; the store is left alone so the next
   * default-range poll doesn't have to re-fetch.
   */
  let usageSource = $state<'store' | 'custom'>('store');
  let customData = $state<UsageModelBucket[] | null>(null);
  let customLoading = $state(false);
  let customError = $state<string | null>(null);

  // Catalog with over-cap models removed, so the profile comboboxes only
  // offer models the venice function would actually run (the server
  // enforces the same caps; this is the UX half). A no-op when no cap is
  // configured.
  const visibleModels = $derived(filterCatalogByCaps(catalog.data ?? [], app.priceCaps));
  // The explanatory note when the cap hides live catalog models (null when
  // nothing is hidden).
  const hiddenModelNote = $derived(
    priceCapHiddenNote((catalog.data?.length ?? 0) - visibleModels.length)
  );

  // Same treatment for the image-generation picker, against the per-image
  // cap (app.priceCaps.maxImageUsd).
  const visibleImageModels = $derived(
    filterImageCatalogByCap(imageCatalog.data ?? [], app.priceCaps)
  );
  const hiddenImageModelNote = $derived(
    priceCapHiddenNote((imageCatalog.data?.length ?? 0) - visibleImageModels.length)
  );

  const usageData = $derived(
    usageSource === 'store' ? usage.data : customData
  );
  const usageLoading = $derived(
    usageSource === 'store' ? usage.loading : customLoading
  );
  const usageError = $derived(
    usageSource === 'store' ? usage.error : customError
  );

  /**
   * First-landing-on-the-pane auto-refresh for the store view. The
   * "should we auto-load now" decision lives in shouldAutoRefreshUsage()
   * - it fires only when the cache is stale, nothing is in flight, and
   * the last attempt did not error. That error guard is what stops a
   * persistently failing fetch from re-firing into a retry storm; a
   * fresh-enough poll is reused as-is so the user sees numbers without a
   * spinner.
   */
  $effect(() => {
    if (
      group === 'usage' &&
      usageSource === 'store' &&
      shouldAutoRefreshUsage() &&
      app.supabase
    ) {
      void refreshUsage(app.supabase);
    }
  });

  // First-landing-on-the-Model-profiles-pane catalog fetch, same
  // lazy-on-open shape as the Usage auto-refresh above. The catalog
  // populates each profile card's model combobox;
  // shouldAutoRefreshCatalog() carries the same stale + not-in-flight +
  // last-attempt-didn't-error guard so a failing fetch surfaces its
  // error instead of retry-storming.
  $effect(() => {
    if (group === 'modelprofiles' && shouldAutoRefreshCatalog() && app.supabase) {
      void refreshCatalog(app.supabase);
    }
  });

  // Same lazy-on-open fetch for the image-model catalog, which backs the
  // Image generation picker. Separate from the text catalog above because
  // Venice serves the two slices independently (different model_spec
  // shapes); same stale/in-flight/error guard.
  $effect(() => {
    if (group === 'ai' && shouldAutoRefreshImageCatalog() && app.supabase) {
      void refreshImageCatalog(app.supabase);
    }
  });

  async function onUsageRefresh(): Promise<void> {
    if (!app.supabase) {
      customError = 'Not connected yet.';
      return;
    }
    const isDefaultRange =
      usageStart === DEFAULT_USAGE_START && usageEnd === DEFAULT_USAGE_END;
    if (isDefaultRange) {
      // Route the Refresh click through the shared store so the
      // manual refresh and the on-open refresh land in the same
      // cache. The next pane open within USAGE_STALE_MS sees the
      // new numbers without having to re-fetch.
      usageSource = 'store';
      await refreshUsage(app.supabase);
      return;
    }
    usageSource = 'custom';
    customError = null;
    customLoading = true;
    // Snapshot the requested range so a user who edits the date
    // pickers and re-clicks Refresh before this fetch settles
    // doesn't see the prior range's rows land as if they were the
    // new range's response.
    const requestedStart = usageStart;
    const requestedEnd = usageEnd;
    const isStale = (): boolean =>
      usageStart !== requestedStart || usageEnd !== requestedEnd;
    try {
      // The analytics endpoint reads date-only bounds with an inclusive
      // endDate, so the picker values pass straight through - no ISO or
      // exclusive-cursor adjustment needed.
      const buckets = await app.supabase.fetchUsage({
        startDate: requestedStart,
        endDate: requestedEnd,
      });
      if (isStale()) return;
      customData = buckets;
    } catch (err) {
      if (isStale()) return;
      customError =
        err instanceof VeniceError
          ? err.message
          : err instanceof Error
            ? err.message
            : String(err);
      customData = null;
    } finally {
      // Only flip the spinner off for our own request - a stale
      // response landing while a newer fetch is in flight would
      // otherwise prematurely clear the spinner the new request
      // just turned on.
      if (!isStale()) customLoading = false;
    }
  }

  // --- Security pane ---
  // Supabase login password rotation. The master-password ceremony
  // was retired with the streaming-root cleanup (the local config
  // carries only public-by-design values); the form below covers the
  // remaining password the user might rotate: their Supabase login.

  let authPwCurrent = $state('');
  let authPwNew = $state('');
  let authPwConfirm = $state('');
  let authPwError = $state<string | null>(null);
  let authPwInfo = $state<string | null>(null);
  let authPwBusy = $state(false);

  let busy = $state(false);

  // --- About pane ---
  // `about-busy` covers both button states since they share the same
  // button: checking for an update vs. reloading once one is found.
  let aboutBusy = $state<'idle' | 'checking' | 'reloading'>('idle');
  // Transient "No update available" hint after a manual check came up
  // empty — clears on next button click. Prevents the user from
  // wondering whether the click did anything when the app is already
  // current.
  let aboutCheckedInfo = $state<string | null>(null);

  async function onAboutAction(): Promise<void> {
    aboutCheckedInfo = null;
    if (updateState.available) {
      aboutBusy = 'reloading';
      try {
        await applyUpdate();
      } catch {
        // `applyUpdate` handles its own errors; reaching here would
        // require `location.reload()` to reject, which effectively
        // can't happen. Reset so the button is usable again.
        aboutBusy = 'idle';
      }
      return;
    }
    aboutBusy = 'checking';
    try {
      await checkForUpdates();
      // If `checkForUpdates` found something, `onNeedRefresh` already
      // fired and `updateState.available` is now true — the button
      // label will reflect that on the next render. If not, leave a
      // subtle "Up to date." note so the click feels acknowledged.
      if (!updateState.available) {
        aboutCheckedInfo = 'You are on the latest build.';
      }
    } finally {
      aboutBusy = 'idle';
    }
  }

  function onSaveKeys(e: SubmitEvent): void {
    e.preventDefault();
    keysError = null;
    keysInfo = null;
    busy = true;
    try {
      const config = {
        supabaseUrl: supabaseUrl.trim(),
        supabasePublishableKey: supabasePublishableKey.trim(),
      };
      saveConfig(config);
      activate(config);
      keysInfo = 'Keys updated.';
    } catch (err) {
      keysError = err instanceof Error ? err.message : String(err);
    } finally {
      busy = false;
    }
  }

  // Image-generation model. One bare id, no reasoning/profile axis.
  // imageModelOverrideFor maps the default id to absence so "default"
  // reads as unset in the settings blob; any other id is persisted.
  async function onPickImageModel(modelId: string): Promise<void> {
    modelError = null;
    modelInfo = null;
    try {
      await persistImageModel(imageModelOverrideFor(modelId));
      const label = imageModelLabel(imageCatalog.data ?? [], modelId);
      modelInfo = `Image generation now uses ${label}.`;
    } catch (err) {
      modelError = err instanceof Error ? err.message : String(err);
    }
  }

  /**
   * Save the user's display name. Trim + 200-char cap live in
   * `persistUserName`; this caller just reads back the canonical
   * trimmed value to sync the local input. On failure the typed
   * value stays in the textbox so the user can retry without
   * losing what they had.
   */
  async function onSaveUserName(next: string): Promise<void> {
    modelError = null;
    modelInfo = null;
    try {
      const trimmed = await persistUserName(next);
      userName = trimmed;
      modelInfo = userFieldNotice('Name', trimmed);
    } catch (err) {
      modelError = err instanceof Error ? err.message : String(err);
    }
  }

  /**
   * Save the user's location. Same shape as `onSaveUserName`.
   */
  async function onSaveUserLocation(next: string): Promise<void> {
    modelError = null;
    modelInfo = null;
    try {
      const trimmed = await persistUserLocation(next);
      userLocation = trimmed;
      modelInfo = userFieldNotice('Location', trimmed);
    } catch (err) {
      modelError = err instanceof Error ? err.message : String(err);
    }
  }

  async function onToggleIntents(next: boolean): Promise<void> {
    intentsError = null;
    intentsInfo = null;
    const prev = intentsEnabled;
    intentsEnabled = next;
    try {
      await persistIntentsEnabled(next);
      intentsInfo = toggleNotice('intents', next);
    } catch (err) {
      intentsEnabled = prev;
      intentsError = err instanceof Error ? err.message : String(err);
    }
  }

  async function onToggleEmphasis(next: boolean): Promise<void> {
    modelError = null;
    modelInfo = null;
    const prev = emphasisMarkdown;
    emphasisMarkdown = next;
    try {
      await persistEmphasisMarkdown(next);
      modelInfo = toggleNotice('emphasisMarkdown', next);
    } catch (err) {
      emphasisMarkdown = prev;
      modelError = err instanceof Error ? err.message : String(err);
    }
  }

  /**
   * Flip the completion-notification toggle. Enabling requires the
   * browser's Notification permission - we ask for it inline the first
   * time the toggle is turned on. On 'denied' we snap the checkbox back
   * off rather than persisting a setting the user can't actually use;
   * only 'granted' gets persisted to Supabase. Turning the toggle OFF
   * never touches permission (the browser-level grant survives, the
   * app-level preference goes back to false).
   */
  async function onToggleNotifyOnComplete(next: boolean): Promise<void> {
    modelError = null;
    modelInfo = null;
    if (next && notificationsSupported()) {
      // Safari + Chromium both require a user gesture to kick off
      // the prompt; the click that toggled the checkbox counts, so
      // we can ask immediately from this handler. 'default' here
      // means the user dismissed the prompt without choosing -
      // treat as a soft deny, since we can't fire OS notifications
      // without a granted state. User can re-flip the toggle to
      // try again. Local state snaps back; app state never moved
      // because we haven't called persist* yet, so no rollback
      // there either.
      const result = await requestPermission();
      notifyPermission = result === 'unsupported' ? 'unsupported' : result;
      if (result === 'denied' || result === 'default') {
        notifyOnComplete = false;
        modelError =
          'Browser notifications are blocked. Allow notifications for this site in your browser settings, then try again.';
        return;
      }
    }
    const prev = notifyOnComplete;
    notifyOnComplete = next;
    try {
      await persistNotifyOnComplete(next);
      modelInfo = notifyOnCompleteNotice(next, notificationsSupported());
    } catch (err) {
      notifyOnComplete = prev;
      modelError = err instanceof Error ? err.message : String(err);
    }
  }

  /**
   * Per-device permission reconciliation. Fired when the synced
   * `notifyOnComplete` preference says ON but this browser's
   * Notification.permission is not 'granted' - usually because the
   * user enabled the toggle on a different device and the OS-level
   * grant didn't travel with the account. We can't auto-request on
   * load (Chromium + Safari both require a user gesture), so we
   * surface a button and call requestPermission from its click.
   * Doesn't touch `notifyOnComplete` itself - the preference is
   * already on the way the user wants it; we're just catching up the
   * browser-side grant.
   */
  async function onEnableNotifyPermission(): Promise<void> {
    modelError = null;
    modelInfo = null;
    const result = await requestPermission();
    notifyPermission = result === 'unsupported' ? 'unsupported' : result;
    // The outcome-to-copy mapping (and the Chromium prior-deny gotcha it
    // narrates) lives in notifyPermissionRequestNotice.
    const notice = notifyPermissionRequestNotice(result);
    if (notice.kind === 'info') modelInfo = notice.text;
    else modelError = notice.text;
  }

  async function onToggleWikiAutomatic(next: boolean): Promise<void> {
    wikiError = null;
    wikiInfo = null;
    const prev = wikiAutomaticEnabled;
    wikiAutomaticEnabled = next;
    try {
      await persistWikiAutomaticEnabled(next);
      wikiInfo = toggleNotice('wikiAutomatic', next);
    } catch (err) {
      wikiAutomaticEnabled = prev;
      wikiError = err instanceof Error ? err.message : String(err);
    }
  }

  async function onToggleWikiRecordExtraction(next: boolean): Promise<void> {
    wikiError = null;
    wikiInfo = null;
    const prev = wikiRecordExtractionEnabled;
    wikiRecordExtractionEnabled = next;
    try {
      await persistWikiRecordExtractionEnabled(next);
      wikiInfo = toggleNotice('wikiRecordExtraction', next);
    } catch (err) {
      wikiRecordExtractionEnabled = prev;
      wikiError = err instanceof Error ? err.message : String(err);
    }
  }

  async function onToggleWikiLibrarian(next: boolean): Promise<void> {
    wikiError = null;
    wikiInfo = null;
    const prev = wikiLibrarianEnabled;
    wikiLibrarianEnabled = next;
    try {
      await persistWikiLibrarianEnabled(next);
      wikiInfo = toggleNotice('wikiLibrarian', next);
    } catch (err) {
      wikiLibrarianEnabled = prev;
      wikiError = err instanceof Error ? err.message : String(err);
    }
  }

  async function onToggleMemoryLibrarian(next: boolean): Promise<void> {
    memoryLibrarianError = null;
    memoryLibrarianInfo = null;
    const prev = memoryLibrarianEnabled;
    memoryLibrarianEnabled = next;
    try {
      await persistMemoryLibrarianEnabled(next);
      memoryLibrarianInfo = toggleNotice('memoryLibrarian', next);
    } catch (err) {
      memoryLibrarianEnabled = prev;
      memoryLibrarianError = err instanceof Error ? err.message : String(err);
    }
  }

  // Fires on the input's `change` event (blur or Enter), same hands-off
  // shape as Name/Location. Validating on `change` rather than `input` is
  // deliberate: a half-typed zone like "America/" should surface one error
  // when the user commits, not on every keystroke.
  async function onChangeDisplayTimezone(next: string): Promise<void> {
    modelError = null;
    modelInfo = null;
    // Input parsing stays here; it's a UI concern about what the user
    // typed rather than a property of the data being saved.
    const normalized = normalizeTimezone(next);
    if (!normalized) {
      modelError = `"${next}" is not a recognized IANA timezone.`;
      return;
    }
    const prev = displayTimezone;
    displayTimezone = normalized;
    try {
      await persistDisplayTimezone(normalized);
      // app.displayTimezonePersisted flips true on success, so the
      // saved-vs-suggested status line updates itself - that IS the
      // confirmation; no separate transient badge needed.
      modelInfo = `Display timezone set to ${normalized}.`;
    } catch (err) {
      displayTimezone = prev;
      modelError = err instanceof Error ? err.message : String(err);
    }
  }


  // Settings -> Wiki -> Reset. Confirmed-irreversible nuke of every
  // wiki article plus the per-thread wiki pipeline state. Resetting
  // does NOT change the auto-articles toggle - if it's on, the agent
  // will start rebuilding articles on its next sweep.
  async function onResetWikiData(): Promise<void> {
    if (!app.supabase) return;
    if (wikiResetBusy) return;
    const ok = window.confirm(
      'Reset all wiki data?\n\n' +
        'This permanently deletes every wiki article and clears the ' +
        'per-conversation wiki state so the agent re-evaluates your ' +
        'threads from scratch.\n\n' +
        'This cannot be undone.\n\n' +
        'If automatic articles are still enabled, the wiki agent will ' +
        'begin rewriting articles on its next sweep.'
    );
    if (!ok) return;
    wikiError = null;
    wikiInfo = null;
    wikiResetBusy = true;
    try {
      await resetAllWikiData(app.supabase);
      wikiInfo = 'Wiki data reset.';
    } catch (err) {
      wikiError = err instanceof Error ? err.message : String(err);
    } finally {
      wikiResetBusy = false;
    }
  }


  async function onChangeAuthPassword(e: SubmitEvent): Promise<void> {
    e.preventDefault();
    authPwError = null;
    authPwInfo = null;
    // Field validation (and its error copy, including the 8-char
    // floor over Supabase's 6) lives in authPasswordError.
    const validationError = authPasswordError(
      authPwCurrent,
      authPwNew,
      authPwConfirm
    );
    if (validationError !== null) {
      authPwError = validationError;
      return;
    }
    if (!app.supabase) {
      authPwError = 'Not connected to Supabase.';
      return;
    }
    authPwBusy = true;
    try {
      await app.supabase.changeAuthPassword(authPwCurrent, authPwNew);
      authPwInfo = 'Account password changed.';
      authPwCurrent = '';
      authPwNew = '';
      authPwConfirm = '';
    } catch (err) {
      authPwError = err instanceof Error ? err.message : String(err);
    } finally {
      authPwBusy = false;
    }
  }
</script>

<!--
  Escape and click-outside both dismiss the modal. The outer `.center`
  doubles as the backdrop — we only close when the click target IS the
  backdrop itself, so clicks inside `.settings-shell` (forms, tabs, the
  horizontally-scrolling mobile nav) don't trigger a spurious close.
-->
<svelte:window onkeydown={(e) => { if (e.key === 'Escape') onClose(); }} />

<!-- svelte-ignore a11y_no_static_element_interactions -->
<!-- svelte-ignore a11y_click_events_have_key_events -->
<div
  class="center settings-backdrop"
  onclick={(e) => { if (e.target === e.currentTarget) onClose(); }}
>
  <div class="settings-shell" role="dialog" aria-modal="true" aria-label="Settings">
    <!-- Fixed top-right close. Anchored to `.settings-shell` (not the nav)
         so it stays put while the mobile nav scrolls horizontally underneath. -->
    <button
      type="button"
      class="settings-close"
      onclick={onClose}
      aria-label="Close settings"
      title="Close"
    >×</button>
    <nav class="settings-nav">
      <h1>Settings</h1>
      <div class="settings-nav-list">
        {#each GROUPS as g (g.id)}
          <button
            type="button"
            class="settings-tab"
            class:active={group === g.id}
            onclick={() => (group = g.id)}
          >{g.label}</button>
        {/each}
      </div>
    </nav>

    <section class="settings-pane">
      {#if group === 'keys'}
        <h2>API keys</h2>
        <p class="subtle">
          Update the Supabase URL and publishable key this browser uses to
          reach your project. Saving re-connects with the new values. (Your
          Venice key lives server-side in your Supabase project, not here.)
        </p>
        <form onsubmit={onSaveKeys}>
          <div class="form-row">
            <label for="su">Supabase URL</label>
            <input id="su" type="url" bind:value={supabaseUrl} required />
          </div>
          <div class="form-row">
            <label for="sa">Supabase publishable key</label>
            <SecretInput id="sa" bind:value={supabasePublishableKey} required />
          </div>
          {#if keysError}<p class="error">{keysError}</p>{/if}
          {#if keysInfo}<p class="subtle">{keysInfo}</p>{/if}
          <button type="submit" disabled={busy}>Save keys</button>
        </form>

        <h3 class="pane-section">Export</h3>
        <p class="subtle">
          Download your Supabase URL and publishable key as a JSON file so you
          can reimport them when setting up Nak on another browser. This is a
          local-only feature - the file is generated in your browser and
          never uploaded.
        </p>
        <p class="subtle" style="font-size:0.85rem">
          Neither value is a secret: the publishable key is the same one your
          deployed app ships to every visitor, and your data is guarded by the
          Supabase sign-in flow plus Row Level Security, not by keeping these
          private.
        </p>
        <p class="subtle" style="font-size:0.85rem">
          Import happens on the Setup screen of a fresh install - the
          "Import from JSON" button pre-fills the credentials for you.
        </p>
        <button type="button" onclick={onExportConfig}>Export config as JSON</button>
        {#if exportError}<p class="error">{exportError}</p>{/if}
        {#if exportInfo}<p class="subtle">{exportInfo}</p>{/if}
      {:else if group === 'ai'}
        <!-- AI-adjacent settings share one pane so the sidebar doesn't
             fan out into a dedicated tab per toggle. All subsections
             autosave — pickers flip through on change and the toggles
             write on click — so the whole pane matches the Appearance
             pane's "touch it and it sticks" behavior. -->
        <h2>AI</h2>
        <p class="subtle">
          Profile and behavior preferences for the assistant. Chat models
          and their defaults live on the
          <strong>Model profiles</strong> tab; your named system prompts
          have their own <strong>Custom prompts</strong> tab.
        </p>

        <h3 class="pane-section">About you</h3>
        <p class="subtle">
          Optional. Anything you add here rides along on every reply
          this account sends, in a short "User profile" block at the
          top of the system prompt. The model uses it to address you
          naturally and to ground location-specific answers (weather,
          local time, regional context) without asking back. Leave
          either field blank to skip it.
        </p>
        <div class="form-row">
          <label for="user-name">Name</label>
          <input
            id="user-name"
            type="text"
            bind:value={userName}
            placeholder="What should the model call you?"
            spellcheck="false"
            autocomplete="off"
            maxlength="200"
            onchange={(e) =>
              onSaveUserName((e.currentTarget as HTMLInputElement).value)}
          />
        </div>
        <div class="form-row">
          <label for="user-location">Location</label>
          <input
            id="user-location"
            type="text"
            bind:value={userLocation}
            placeholder="City, region, or however you want to describe it"
            spellcheck="false"
            autocomplete="off"
            maxlength="200"
            onchange={(e) =>
              onSaveUserLocation((e.currentTarget as HTMLInputElement).value)}
          />
        </div>
        <p class="subtle" style="font-size:0.85rem">
          IANA timezone the model uses when reasoning about "what
          time is it for you" in the system prompt. Browser detected:
          <code>{detectTimezone()}</code>. Saves when you leave the
          field or press Enter (zones go through validation, so a
          half-typed name doesn't fire an error on every keystroke).
        </p>
        <div class="form-row">
          <label for="display-timezone">Timezone</label>
          <input
            id="display-timezone"
            type="text"
            bind:value={displayTimezone}
            placeholder="America/Los_Angeles"
            list="display-timezone-options"
            spellcheck="false"
            autocomplete="off"
            onchange={(e) =>
              onChangeDisplayTimezone((e.currentTarget as HTMLInputElement).value)}
          />
          <datalist id="display-timezone-options">
            <option value="UTC"></option>
            <option value="America/Los_Angeles"></option>
            <option value="America/Denver"></option>
            <option value="America/Chicago"></option>
            <option value="America/New_York"></option>
            <option value="America/Sao_Paulo"></option>
            <option value="Europe/London"></option>
            <option value="Europe/Paris"></option>
            <option value="Europe/Berlin"></option>
            <option value="Europe/Moscow"></option>
            <option value="Africa/Johannesburg"></option>
            <option value="Asia/Dubai"></option>
            <option value="Asia/Kolkata"></option>
            <option value="Asia/Shanghai"></option>
            <option value="Asia/Tokyo"></option>
            <option value="Australia/Sydney"></option>
            <option value="Pacific/Auckland"></option>
          </datalist>
        </div>
        <!-- Unset-vs-saved status. The field is seeded with the browser's
             detected zone, which is NOT persisted - the server day-gates
             fall back to UTC for it - so when nothing is stored we flag that
             in the warn color (amber, not the danger red: this is a heads-up
             that a default is in effect, not an error). Once a zone is
             committed the line drops to a muted confirmation. -->
        <p class="tz-status" aria-live="polite">
          {#if !app.displayTimezonePersisted}
            <span class="tz-status-hint">
              <span class="tz-status-flag" aria-hidden="true">!</span>
              <em>No timezone set - using <strong>UTC</strong> as the
              default. Type or pick your zone above; it saves as soon as you
              leave the field.</em>
            </span>
          {:else}
            <span class="tz-status-saved">Saved as <code>{tzSavedValue}</code>.</span>
          {/if}
        </p>

        <h3 class="pane-section">Image generation</h3>
        <p class="subtle">
          The model the assistant uses when you ask it to
          <strong>generate an image</strong>. This is a backend choice -
          it changes the look, cost, and content policy of generated
          images without changing how you ask. The per-image
          <strong>price</strong> comes from the live Venice catalog.
        </p>
        <div class="form-row" style="display:flex;gap:0.5rem;align-items:center">
          <ImageModelSelect
            options={buildImageModelOptions(visibleImageModels, effectiveImageModel)}
            value={effectiveImageModel}
            disabled={imageCatalog.data === null}
            ariaLabel="Image generation model"
            onSelect={onPickImageModel}
          />
        </div>
        {#if imageCatalog.loading}
          <p class="subtle">Loading image models from Venice…</p>
        {/if}
        {#if imageCatalog.error}
          <p class="error">
            Couldn't load the image-model catalog: {imageCatalog.error}
            <button
              type="button"
              class="tier-reset"
              onclick={() => app.supabase && refreshImageCatalog(app.supabase)}
            >Retry</button>
          </p>
        {/if}
        {#if hiddenImageModelNote}
          <p class="subtle">{hiddenImageModelNote}</p>
        {/if}

        <h3 class="pane-section">Emphasis markdown</h3>
        <p class="subtle">
          Bionic-style scan aid. When on, Nak asks the model to
          sprinkle <strong>bold</strong> on meaningful terms and
          identifiers and <em>italics</em> on short phrases or
          transitional clauses, so long answers skim more easily.
          Off by default; costs a handful of tokens per turn and
          nothing when the reply is short enough that emphasis
          would be noise.
        </p>
        <label class="form-row toggle-row">
          <input
            type="checkbox"
            name="emphasis-markdown"
            checked={emphasisMarkdown}
            onchange={(e) =>
              onToggleEmphasis((e.currentTarget as HTMLInputElement).checked)}
          />
          <span>Ask the model to highlight save-points</span>
        </label>

        <h3 class="pane-section">Working intentions</h3>
        <p class="subtle">
          When on, Nak forms standing intentions about how to help you
          grow over time - drawn from the patterns it already observes -
          and quietly leans on them in conversation. It reviews them
          daily: pursuing what helps, pausing what goes quiet, and
          letting go of approaches that aren't landing. Intentions are
          never announced as an agenda and never override what you
          explicitly ask for. This is the one feature that lets Nak
          develop with you rather than only record; it's off by default
          and a deliberate opt-in.
        </p>
        <label class="form-row toggle-row">
          <input
            type="checkbox"
            name="intents-enabled"
            checked={intentsEnabled}
            onchange={(e) =>
              onToggleIntents((e.currentTarget as HTMLInputElement).checked)}
          />
          <span>Let Nak develop and pursue growth intentions</span>
        </label>
        {#if intentsError}<p class="error">{intentsError}</p>{/if}
        {#if intentsInfo}<p class="subtle">{intentsInfo}</p>{/if}

        <h3 class="pane-section">Reply notifications</h3>
        <p class="subtle">
          When a reply lands in a thread you aren't currently viewing,
          Nak can flag the thread in the sidebar and - if your browser
          supports it and permission is granted - fire a desktop or
          mobile notification when the tab isn't visible. Only fires
          for threads you navigated away from mid-reply; the thread
          you're watching never notifies itself.
          {#if !notificationsSupported()}
            This browser doesn't expose the Notification API, so you'll
            only see the in-app sidebar flag. On iOS, install Nak to
            the home screen to receive OS notifications.
          {/if}
        </p>
        <label class="form-row toggle-row">
          <input
            type="checkbox"
            name="notify-on-complete"
            checked={notifyOnComplete}
            onchange={(e) =>
              onToggleNotifyOnComplete((e.currentTarget as HTMLInputElement).checked)}
          />
          <span>Notify me when replies finish</span>
        </label>
        {#if notifyPermissionNudgeVisible(notifyOnComplete, notificationsSupported(), notifyPermission)}
          <!-- Per-device reconciliation: the account-level setting is
               on but this browser hasn't granted the OS-level permission
               yet. Common case is a user who enabled the toggle on phone
               and is now visiting on desktop for the first time. -->
          <div class="form-row" style="display:flex;flex-direction:column;gap:0.5rem;align-items:flex-start">
            <p class="subtle" style="color:var(--warn);font-size:0.85rem;margin:0">
              Reply notifications are enabled on your account, but this
              browser hasn't been granted permission yet. Browser-level
              grants don't sync across devices.
            </p>
            <button type="button" onclick={onEnableNotifyPermission}>
              Enable notifications for this browser
            </button>
          </div>
        {/if}
        {#if modelError}<p class="error">{modelError}</p>{/if}
        {#if modelInfo}<p class="subtle">{modelInfo}</p>{/if}

      {:else if group === 'modelprofiles'}
        <!-- Model profiles split from the AI pane: the cards are tall
             and the list is unbounded. The list autosaves (debounced)
             on add / edit / delete / reorder / default change, matching
             the Custom prompts pane it borrows its card + drag
             mechanics from. -->
        <h2>Model profiles</h2>
        <p class="subtle">
          Named model configurations you can switch between from the
          chat composer. Each profile pairs a Venice model with the
          default <strong>reasoning</strong> effort and
          <strong>verbosity</strong> new conversations start at - both
          still adjustable per conversation from the composer. The
          <strong>Default</strong> radio marks the profile new
          conversations use. Drag the grip handle to reorder.
        </p>
        <div class="prompt-list">
          {#each profilesDraft as p (p.id)}
            {@const row = profilesLib.profileRowView(p, visibleModels)}
            <!-- svelte-ignore a11y_no_static_element_interactions -->
            <div
              class="prompt-card"
              class:drag-over={profileDragOverId === p.id &&
                profileDragId !== p.id &&
                profileTouchDragId !== p.id}
              class:dragging={profileDragId === p.id}
              class:touch-dragging={profileTouchDragId === p.id}
              data-profile-id={p.id}
              ondragover={(e) => onProfileDragOver(p.id, e)}
              ondrop={(e) => onProfileDrop(p.id, e)}
            >
              <div class="prompt-row">
                <span
                  class="prompt-grip"
                  role="button"
                  tabindex="-1"
                  draggable="true"
                  title="Drag to reorder (press and hold on touch)"
                  aria-label="Drag to reorder profile"
                  ondragstart={(e) => onProfileDragStart(p.id, e)}
                  ondragend={onProfileDragEnd}
                  ontouchstart={(e) => onProfileTouchStart(p.id, e)}
                  ontouchmove={onProfileTouchMove}
                  ontouchend={onProfileTouchEnd}
                  ontouchcancel={onProfileTouchEnd}
                >
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                    <circle cx="9" cy="6" r="1.6" />
                    <circle cx="15" cy="6" r="1.6" />
                    <circle cx="9" cy="12" r="1.6" />
                    <circle cx="15" cy="12" r="1.6" />
                    <circle cx="9" cy="18" r="1.6" />
                    <circle cx="15" cy="18" r="1.6" />
                  </svg>
                </span>
                <input
                  type="text"
                  name="profile-name-{p.id}"
                  class="prompt-name"
                  value={p.name}
                  placeholder="Name"
                  oninput={(e) =>
                    updateProfile(p.id, {
                      name: (e.currentTarget as HTMLInputElement).value,
                    })}
                />
                <!-- Radio semantics carry the exactly-one-default rule:
                     picking one deselects the rest (setDefaultProfile
                     clears every other flag). With a single profile the
                     radio is checked and disabled - the invariant says
                     it cannot be unset until a second profile exists. -->
                <label
                  class="prompt-default"
                  title={profilesDraft.length === 1
                    ? 'Your only profile is always the default'
                    : 'Use this profile for new conversations'}
                >
                  <input
                    type="radio"
                    name="default-profile"
                    checked={p.isDefault}
                    disabled={profilesDraft.length === 1}
                    onchange={() => setDefaultProfile(p.id)}
                  />
                  <span>Default</span>
                </label>
                <button
                  type="button"
                  class="secondary icon-btn"
                  title={profilesDraft.length === 1
                    ? 'The last profile cannot be deleted'
                    : 'Delete profile'}
                  aria-label="Delete profile"
                  disabled={profilesDraft.length === 1}
                  onclick={() => deleteProfile(p.id)}
                >
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                       stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                    <polyline points="3 6 5 6 21 6" />
                    <path d="M19 6l-2 14a2 2 0 0 1-2 2H9a2 2 0 0 1-2-2L5 6" />
                    <path d="M10 11v6M14 11v6" />
                  </svg>
                </button>
              </div>

              <div class="tier-row-controls">
                <ModelCombobox
                  options={row.options}
                  value={p.modelId}
                  disabled={catalog.data === null}
                  ariaLabel={`Model for ${p.name}`}
                  onSelect={(id) => onPickProfileModel(p.id, id)}
                />
                <label class="sr-only" for={`profile-thinking-${p.id}`}
                  >Reasoning for {p.name}</label
                >
                <select
                  id={`profile-thinking-${p.id}`}
                  value={p.thinking}
                  disabled={!p.supportsReasoning}
                  title={p.supportsReasoning
                    ? 'Default reasoning effort for this profile'
                    : "This model doesn't support reasoning"}
                  onchange={(e) =>
                    updateProfile(p.id, {
                      thinking: (e.currentTarget as HTMLSelectElement)
                        .value as ThinkingLevel,
                    })}
                >
                  {#each THINKING_LEVELS as lvl (lvl)}
                    <option value={lvl}>{THINKING_LEVEL_LABELS[lvl]} thinking</option>
                  {/each}
                </select>
                <label class="sr-only" for={`profile-verbosity-${p.id}`}
                  >Verbosity for {p.name}</label
                >
                <select
                  id={`profile-verbosity-${p.id}`}
                  value={p.verbosity}
                  title="Default verbosity for this profile"
                  onchange={(e) =>
                    updateProfile(p.id, {
                      verbosity: (e.currentTarget as HTMLSelectElement)
                        .value as Verbosity,
                    })}
                >
                  {#each VERBOSITIES as v (v)}
                    <option value={v}>{VERBOSITY_LABELS[v]} verbosity</option>
                  {/each}
                </select>
              </div>

              <div class="tier-row-meta">
                {#each row.chips as chip (chip.label)}
                  <span class="cap-chip"
                    ><span aria-hidden="true">{chip.icon}</span> {chip.label}</span
                  >
                {/each}
                <span class="cap-chip">{row.contextLabel} context</span>
                <span class="cap-chip">{row.priceLabel}</span>
              </div>
            </div>
          {/each}
        </div>
        {#if catalog.loading}
          <p class="subtle">Loading models from Venice…</p>
        {/if}
        {#if catalog.error}
          <p class="error">
            Couldn't load the model catalog: {catalog.error}
            <button
              type="button"
              class="tier-reset"
              onclick={() => app.supabase && refreshCatalog(app.supabase)}
            >Retry</button>
          </p>
        {/if}
        {#if hiddenModelNote}
          <p class="subtle">{hiddenModelNote}</p>
        {/if}
        <div class="prompts-footer">
          <button type="button" onclick={addProfile}>+ Add profile</button>
          <!-- Floating save-state indicator, same contract as the
               Custom prompts footer: reserves its slot so it never
               shifts the layout; only the icon inside toggles. -->
          <div class="save-status" aria-live="polite">
            {#if profilesSaveState === 'saving'}
              <svg class="save-icon" width="16" height="16" viewBox="0 0 24 24"
                   fill="none" stroke="currentColor" stroke-width="2"
                   stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                <circle cx="12" cy="12" r="10" />
                <polyline points="12 6 12 12 16 14" />
              </svg>
              <span class="sr-only">Saving…</span>
            {:else if profilesSaveState === 'saved'}
              <svg class="save-icon saved" width="16" height="16" viewBox="0 0 24 24"
                   fill="none" stroke="currentColor" stroke-width="2.5"
                   stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                <polyline points="20 6 9 17 4 12" />
              </svg>
              <span class="sr-only">Saved</span>
            {/if}
          </div>
        </div>
        {#if profilesNameError}<p class="error">{profilesNameError}</p>
        {:else if profilesError}<p class="error">{profilesError}</p>{/if}

      {:else if group === 'customprompts'}
        <!-- Custom prompts split out of the AI pane: the cards are tall
             and pushed the model/reasoning controls below the fold. The
             list autosaves (debounced) on add / edit / delete / reorder,
             matching the rest of the modal's touch-it-and-it-sticks
             behavior. -->
        <h2>Custom prompts</h2>
        <p class="subtle">
          Named system prompts you can toggle on or off from the chat
          composer. The "Default" checkbox seeds the active set for new
          conversations. Per-conversation toggles aren't saved — they only
          affect the current thread. Drag the grip handle to reorder.
        </p>
        <div class="prompt-list">
          {#each promptsDraft as p (p.id)}
            <!-- svelte-ignore a11y_no_static_element_interactions -->
            <div
              class="prompt-card"
              class:drag-over={dragOverId === p.id && dragId !== p.id && touchDragId !== p.id}
              class:dragging={dragId === p.id}
              class:touch-dragging={touchDragId === p.id}
              data-prompt-id={p.id}
              ondragover={(e) => onPromptDragOver(p.id, e)}
              ondrop={(e) => onPromptDrop(p.id, e)}
            >
              <div class="prompt-row">
                <span
                  class="prompt-grip"
                  role="button"
                  tabindex="-1"
                  draggable="true"
                  title="Drag to reorder (press and hold on touch)"
                  aria-label="Drag to reorder prompt"
                  ondragstart={(e) => onPromptDragStart(p.id, e)}
                  ondragend={onPromptDragEnd}
                  ontouchstart={(e) => onPromptTouchStart(p.id, e)}
                  ontouchmove={onPromptTouchMove}
                  ontouchend={onPromptTouchEnd}
                  ontouchcancel={onPromptTouchEnd}
                >
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                    <circle cx="9" cy="6" r="1.6" />
                    <circle cx="15" cy="6" r="1.6" />
                    <circle cx="9" cy="12" r="1.6" />
                    <circle cx="15" cy="12" r="1.6" />
                    <circle cx="9" cy="18" r="1.6" />
                    <circle cx="15" cy="18" r="1.6" />
                  </svg>
                </span>
                <input
                  type="text"
                  name="prompt-name-{p.id}"
                  class="prompt-name"
                  value={p.name}
                  placeholder="Name"
                  oninput={(e) => updatePrompt(p.id, { name: (e.currentTarget as HTMLInputElement).value })}
                />
                <label class="prompt-default">
                  <input
                    type="checkbox"
                    name="prompt-default-{p.id}"
                    checked={p.enabledByDefault}
                    onchange={(e) =>
                      updatePrompt(p.id, {
                        enabledByDefault: (e.currentTarget as HTMLInputElement).checked,
                      })}
                  />
                  <span>Default</span>
                </label>
                <button
                  type="button"
                  class="secondary icon-btn"
                  title="Delete prompt"
                  aria-label="Delete prompt"
                  onclick={() => deletePrompt(p.id)}
                >
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                       stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                    <polyline points="3 6 5 6 21 6" />
                    <path d="M19 6l-2 14a2 2 0 0 1-2 2H9a2 2 0 0 1-2-2L5 6" />
                    <path d="M10 11v6M14 11v6" />
                  </svg>
                </button>
              </div>
              <textarea
                name="prompt-body-{p.id}"
                class="prompt-body"
                rows={8}
                value={p.body}
                placeholder="The system prompt text… (e.g. 'Be concise.')"
                oninput={(e) => updatePrompt(p.id, { body: (e.currentTarget as HTMLTextAreaElement).value })}
              ></textarea>
            </div>
          {/each}
          {#if promptsDraft.length === 0}
            <p class="subtle" style="padding:0.5rem 0">No prompts yet.</p>
          {/if}
        </div>
        <div class="prompts-footer">
          <button type="button" onclick={addPrompt}>+ Add prompt</button>
          <!-- Floating save-state indicator. Reserves its slot so it
               never shifts the footer layout; only the icon inside
               toggles. aria-live keeps screen readers in sync. -->
          <div class="save-status" aria-live="polite">
            {#if promptsSaveState === 'saving'}
              <svg class="save-icon" width="16" height="16" viewBox="0 0 24 24"
                   fill="none" stroke="currentColor" stroke-width="2"
                   stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                <circle cx="12" cy="12" r="10" />
                <polyline points="12 6 12 12 16 14" />
              </svg>
              <span class="sr-only">Saving…</span>
            {:else if promptsSaveState === 'saved'}
              <svg class="save-icon saved" width="16" height="16" viewBox="0 0 24 24"
                   fill="none" stroke="currentColor" stroke-width="2.5"
                   stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                <polyline points="20 6 9 17 4 12" />
              </svg>
              <span class="sr-only">Saved</span>
            {/if}
          </div>
        </div>
        {#if promptsError}<p class="error">{promptsError}</p>{/if}
      {:else if group === 'memory'}
        <h2>Memory</h2>
        <p class="subtle">
          Memories are short facts Nak records about you as you chat -
          preferences, projects, people, recurring details. The
          assistant reaches them through the always-on
          <code>memory_recall</code> and <code>memory_search</code>
          tools; you can browse and edit them from the Memories drawer
          tab. See the Help modal's Memory page for the full picture.
        </p>

        <h3 class="pane-section">Memory librarian</h3>
        <label class="form-row toggle-row">
          <input
            type="checkbox"
            name="memory-librarian"
            checked={memoryLibrarianEnabled}
            onchange={(e) => onToggleMemoryLibrarian(e.currentTarget.checked)}
          />
          <span>
            Let Nak's memory librarian periodically reorganise your
            memory store: consolidate cross-thread duplicates the
            reflection agent couldn't see, fill in missing
            relations between memories you've recalled together,
            and soft-delete contradicted facts. Two passes run on
            staggered 12h cadences (deep-sleep walks similarity
            neighborhoods; rem walks recall co-occurrence
            conversations); both are coordinated across devices so
            only one run happens per cycle. You can also trigger
            either pass on demand from the Memories drawer tab.
          </span>
        </label>
        {#if memoryLibrarianError}<p class="error">{memoryLibrarianError}</p>{/if}
        {#if memoryLibrarianInfo}<p class="subtle">{memoryLibrarianInfo}</p>{/if}
      {:else if group === 'wiki'}
        <h2>Wiki</h2>
        <p class="subtle">
          The Wiki is a flat encyclopedia about you - titled articles
          about projects, people, places, and topics in your life. The
          background wiki agent reads conversations the day after they
          settle and either updates an existing article or creates a
          new one. Articles are never auto-injected into the chat;
          the assistant reaches them through the always-on
          <code>wiki_search</code> tool.
        </p>

        <h3 class="pane-section">Automatic articles</h3>
        <label class="form-row toggle-row">
          <input
            type="checkbox"
            name="wiki-automatic"
            checked={wikiAutomaticEnabled}
            onchange={(e) => onToggleWikiAutomatic(e.currentTarget.checked)}
          />
          <span>
            Let Nak's wiki agent maintain articles automatically as
            you chat. Turning this off stops the per-conversation
            agent; manual edits and the per-article "ask agent to
            update" button still work, and existing articles are
            untouched.
          </span>
        </label>

        <h3 class="pane-section">Automatic records</h3>
        <label class="form-row toggle-row">
          <input
            type="checkbox"
            name="wiki-record-extraction"
            checked={wikiRecordExtractionEnabled}
            onchange={(e) => onToggleWikiRecordExtraction(e.currentTarget.checked)}
          />
          <span>
            Let Nak scan your conversations for discrete events
            (a bake, a doctor visit, a milestone) and log them as dated
            records on the matching wiki article. Turning this off stops
            the background extraction agent; you can still add and edit
            records by hand on any article, and existing records are
            untouched.
          </span>
        </label>

        <h3 class="pane-section">Librarian</h3>
        <label class="form-row toggle-row">
          <input
            type="checkbox"
            name="wiki-librarian"
            checked={wikiLibrarianEnabled}
            onchange={(e) => onToggleWikiLibrarian(e.currentTarget.checked)}
          />
          <span>
            Let Nak's wiki librarian periodically reorganise the wiki:
            consolidate near-duplicate articles, fact-check claims
            against your conversation history, and tighten the
            boundaries between overlapping subjects. Runs at most once
            every 12 hours; coordinated across devices so only one
            run happens per cycle.
          </span>
        </label>

        <p class="subtle" style="font-size:0.85rem">
          The wiki uses the display timezone you set under
          Settings -> AI -> About you to bucket day-eligible threads.
        </p>

        <h3 class="pane-section">Reset</h3>
        <p class="subtle" style="font-size:0.85rem">
          Permanently delete every wiki article and clear the per-
          conversation wiki state so the agent re-evaluates your
          threads from scratch. Irreversible.
        </p>
        <button
          type="button"
          class="danger"
          onclick={onResetWikiData}
          disabled={wikiResetBusy}
        >{wikiResetBusy ? 'Resetting…' : 'Reset wiki data'}</button>

        {#if wikiError}<p class="error">{wikiError}</p>{/if}
        {#if wikiInfo}<p class="subtle">{wikiInfo}</p>{/if}
      {:else if group === 'appearance'}
        <h2>Appearance</h2>
        <p class="subtle">
          Pick a color scheme and accent. Your choice syncs via Supabase so it
          follows you to other browsers, and is cached locally so the right
          theme appears instantly on next load.
        </p>

        <h3 class="pane-section">Mode</h3>
        <div class="form-row mode-picker">
          {#each MODES as m (m)}
            <button
              type="button"
              class="mode-option"
              class:selected={colorMode === m}
              onclick={() => onPickMode(m)}
            >
              <strong>{MODE_LABELS[m]}</strong>
              {#if m === 'system'}
                <span class="subtle" style="display:block;font-size:0.78rem">
                  follows your OS (currently {effectiveMode('system')})
                </span>
              {/if}
            </button>
          {/each}
        </div>

        <h3 class="pane-section">Style</h3>
        <div class="form-row mode-picker">
          {#each STYLES as st (st)}
            <button
              type="button"
              class="mode-option"
              class:selected={uiStyle === st}
              onclick={() => onPickStyle(st)}
            >
              <strong>{STYLE_LABELS[st]}</strong>
              <span class="subtle" style="display:block;font-size:0.78rem">
                {STYLE_DESCRIPTIONS[st]}
              </span>
            </button>
          {/each}
        </div>

        <h3 class="pane-section">Accent</h3>
        <div class="form-row accent-picker">
          {#each ACCENTS as a (a)}
            <button
              type="button"
              class="accent-option"
              class:selected={accent === a}
              onclick={() => onPickAccent(a)}
              title={ACCENT_LABELS[a]}
              aria-label={ACCENT_LABELS[a]}
              aria-pressed={accent === a}
            >
              <span class="swatch" style="--sw-dark:{ACCENT_SWATCHES[uiStyle][a].dark};--sw-light:{ACCENT_SWATCHES[uiStyle][a].light}"></span>
              <span class="swatch-label">{ACCENT_LABELS[a]}</span>
            </button>
          {/each}
        </div>

        <h3 class="pane-section">Default log level</h3>
        <p class="subtle">
          Minimum severity the Logs drawer shows when you open it. Raise this
          to cut noise; lower it to see debug breadcrumbs from every worker.
          Affects the drawer's initial filter only - you can still pick a
          different level within the drawer itself.
        </p>
        <div class="form-row">
          <select
            name="default-log-level"
            aria-label="Default minimum log level"
            value={defaultLogLevel}
            onchange={(e) => {
              void onPickLogLevel((e.currentTarget as HTMLSelectElement).value as LogLevel);
            }}
          >
            {#each LOG_LEVELS as level (level)}
              <option value={level}>{LOG_LEVEL_LABELS[level]}</option>
            {/each}
          </select>
        </div>

        {#if appearanceError}<p class="error">{appearanceError}</p>{/if}
        {#if appearanceInfo}<p class="subtle">{appearanceInfo}</p>{/if}
      {:else if group === 'usage'}
        <!--
          Usage pane: a date-ranged snapshot of Venice spend for this
          API key. Hits Venice's beta `/billing/usage-analytics`
          endpoint, which returns the per-model spend + token roll-up
          pre-aggregated in one cached response; the pane fans that into
          per-(model, currency) rows and renders a bar chart scaled by
          total tokens with a spend pill per row. The default rolling-7-
          day view is cached in `$lib/usage-store.svelte` and fetched
          lazily on first open of this pane in the session; the `$effect`
          above also forces a refresh when the cache is older than
          USAGE_STALE_MS. User-picked custom ranges bypass the cache and
          fetch on-demand.
        -->
        <h2>Usage</h2>
        <p class="subtle">
          Token spend against your Venice API key. Pulled from
          Venice's billing analytics — the numbers below are what
          Venice reports, not a Nak-side tally. The default 7-day view
          fetches the first time you open this pane and caches the
          result for 15 minutes; opening the pane again after that
          re-fetches automatically. Custom date ranges fetch when
          you hit Refresh. Bars are scaled by total tokens; the pill
          on the right is the amount billed in whatever currency each
          model was charged in.
        </p>
        <div class="usage-controls">
          <label class="usage-date">
            <span>From</span>
            <input
              type="date"
              name="usage-start"
              bind:value={usageStart}
              max={usageEnd}
              disabled={usageLoading}
            />
          </label>
          <label class="usage-date">
            <span>To</span>
            <input
              type="date"
              name="usage-end"
              bind:value={usageEnd}
              min={usageStart}
              max={todayYmd()}
              disabled={usageLoading}
            />
          </label>
          <button
            type="button"
            onclick={onUsageRefresh}
            disabled={usageLoading}
          >
            {#if usageLoading}
              Loading…
            {:else}
              Refresh
            {/if}
          </button>
        </div>
        {#if usageError}<p class="error">{usageError}</p>{/if}
        {#if usageData !== null && !usageError}
          {@const buckets = aggregateUsage(usageData)}
          {@const maxTokens = buckets.reduce((m, b) => Math.max(m, b.tokens), 0)}
          {@const totalTokens = buckets.reduce((s, b) => s + b.tokens, 0)}
          {@const totalsByCurrency = aggregateTotalsByCurrency(buckets)}
          <!--
            Two independent color channels over the same rows. tokenPop
            drives the bar hue (how token-heavy is this model?); spendPop
            drives the spend-pill border hue (how costly is this model?).
            Computed once here and fed to relativeHue per row so a model
            that is cheap-but-chatty (long green bar, blue-bordered pill)
            reads differently from an expensive-but-terse one (short bar,
            red-bordered pill).
          -->
          {@const tokenPop = buckets.map((b) => b.tokens)}
          {@const spendPop = buckets.map((b) => b.amount)}
          <!--
            Totals strip. Tokens sum unconditionally (a scalar
            regardless of currency); spend totals split into one
            pill per currency so a mixed USD + credits plan doesn't
            get meaninglessly collapsed into one number. Pills
            reuse the same .credit muting the per-row pills do —
            the USD total pops, credit totals fade.
          -->
          {@const rangeDays = daysInPickedRange(usageStart, usageEnd)}
          <p class="subtle usage-totals">
            {#if buckets.length === 0}
              No usage in this range.
            {:else}
              <strong>{formatTokens(totalTokens)}</strong> tokens across
              <strong>{buckets.length}</strong>{modelCountNoun(buckets.length)}.
              {#each totalsByCurrency as t (t.currency)}
                <span
                  class="usage-pill"
                  class:credit={isCreditCurrency(t.currency)}
                  title={spendPillTitle(t.currency)}
                >{formatAmount(t.amount, t.currency)}</span>
                <!--
                  Avg-per-day pill paired with each currency's total.
                  Divides the inclusive day count of the picked range
                  into the same total the pill on the left is
                  showing, so a user can read "spent $X in this
                  window, averaging $X/day across it" without doing
                  the math themselves. Per-currency rather than a
                  single number because mixed USD + credits plans
                  would otherwise collapse two units into one
                  meaningless figure.
                -->
                <span
                  class="usage-pill per-day"
                  class:credit={isCreditCurrency(t.currency)}
                  title={perDayTitle(rangeDays, t.currency)}
                >{formatAmountPerDay(t.amount / rangeDays, t.currency)}</span>
              {/each}
            {/if}
          </p>
          {#if buckets.length > 0}
            <div class="usage-chart" role="table" aria-label="Usage by model">
              <div class="usage-row usage-head" role="row">
                <span class="usage-sku" role="columnheader">Model</span>
                <span class="usage-bar-head" role="columnheader">Tokens</span>
                <span class="usage-tokens" role="columnheader">&nbsp;</span>
                <span class="usage-pill-head" role="columnheader">Spend</span>
              </div>
              {#each buckets as b (b.sku + ' ' + b.currency)}
                <div class="usage-row" role="row">
                  <span class="usage-sku" role="cell" title={b.sku}>{b.sku}</span>
                  <span class="usage-bar-cell" role="cell">
                    <!--
                      Width is `max(2%, share-of-max)` (usageBarPercent)
                      so a non-zero but tiny row still registers as a
                      visible bar rather than an invisible sliver. A
                      truly zero-token row (image SKU) collapses to
                      nothing.
                    -->
                    <span
                      class="usage-bar"
                      class:zero={b.tokens === 0}
                      style="--usage-pct:{usageBarPercent(b.tokens, maxTokens)}%; --usage-hue:{relativeHue(b.tokens, tokenPop)}"
                    ></span>
                  </span>
                  <span class="usage-tokens" role="cell">{formatTokens(b.tokens)}</span>
                  <!--
                    Non-USD rows get a muted pill style — same $-
                    formatted body as USD rows, just visually
                    de-emphasized so the eye skips past them to the
                    cash charges that actually hit the user's card.
                    The native `title` tooltip spells out which kind
                    of credit paid for the row, so the info isn't
                    lost when the pill is grey. The border hue
                    (--spend-hue) is an orthogonal channel: it tracks
                    this row's spend relative to the others regardless
                    of currency, the same blue->green->red scale the
                    bars use for tokens.
                  -->
                  <span
                    class="usage-pill"
                    class:credit={isCreditCurrency(b.currency)}
                    role="cell"
                    style="--spend-hue:{relativeHue(b.amount, spendPop)}"
                    title={spendPillTitle(b.currency)}
                  >{formatAmount(b.amount, b.currency)}</span>
                </div>
              {/each}
            </div>
          {/if}
        {/if}
      {:else if group === 'security'}
        <h2>Security</h2>

        <h3 class="pane-section">Change account password</h3>
        <p class="subtle">
          Rotate the password you use to sign in to your Supabase account.
          We re-verify your current password before updating, so a stolen
          unlocked tab can't quietly rotate you out of your own account.
        </p>
        <form onsubmit={onChangeAuthPassword}>
          <div class="form-row">
            <label for="auth-pw-current">Current account password</label>
            <SecretInput id="auth-pw-current" bind:value={authPwCurrent} required
                         autocomplete="current-password" />
          </div>
          <div class="form-row">
            <label for="auth-pw-new">New account password</label>
            <SecretInput id="auth-pw-new" bind:value={authPwNew} minlength={8} required
                         autocomplete="new-password" />
          </div>
          <div class="form-row">
            <label for="auth-pw-confirm">Confirm new account password</label>
            <SecretInput id="auth-pw-confirm" bind:value={authPwConfirm} minlength={8} required
                         autocomplete="new-password" />
          </div>
          {#if authPwError}<p class="error">{authPwError}</p>{/if}
          {#if authPwInfo}<p class="subtle">{authPwInfo}</p>{/if}
          <button type="submit" disabled={authPwBusy}>Change account password</button>
        </form>
      {:else if group === 'about'}
        <!-- About pane: surfaces the build fingerprint and lets the
             user pull the latest deploy on demand. Paired with the
             top-right update banner — this pane is the "I want to
             check my version" entry point, the banner is the "the app
             nudged me" one. Both drive the same `applyUpdate()`
             code path. -->
        <h2>About</h2>
        <p class="subtle">
          Which build your browser is running right now. A top-right
          "new version available" banner also appears automatically when
          a fresh deploy lands, so you don't need to open this pane to
          get the prompt — this is just the place to check at any time.
        </p>
        <dl class="about-grid">
          <dt>Version</dt>
          <dd><code>{updateState.commit}</code></dd>
          <dt>Built</dt>
          <dd title={updateState.buildTime}>{formatBuildTime(updateState.buildTime)}</dd>
          <dt>Status</dt>
          <dd>
            {#if updateState.available}
              <span class="update-ready">Update available</span>
            {:else}
              <span class="subtle">Up to date</span>
            {/if}
          </dd>
        </dl>
        <button
          type="button"
          onclick={onAboutAction}
          disabled={aboutBusy !== 'idle'}
        >{aboutActionLabel(aboutBusy, updateState.available)}</button>
        {#if aboutCheckedInfo}
          <p class="subtle" style="margin-top:0.5rem">{aboutCheckedInfo}</p>
        {/if}
        <p class="subtle" style="margin-top:0.5rem;font-size:0.8rem">
          "Check for updates" asks the service worker to look for a
          fresh deploy without reloading. If one's found the button
          flips to "Reload to update" and the top-right banner
          appears.
        </p>
      {/if}
    </section>
  </div>
</div>
