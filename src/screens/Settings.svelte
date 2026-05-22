<script lang="ts">
  /*
   * Settings modal. Reached from the chat sidebar's gear icon. Seven
   * panes, each with its own persistence target:
   *
   *   keys        — the three API keys. Re-encrypts + re-activates, so
   *                 requires the current master password.
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
   *   export      — download the three keys as a plaintext JSON file
   *                 for import on another browser. See config.ts for
   *                 the file format.
   *   security    — rotate the master password. Re-encrypts the stored
   *                 blob under the new password; doesn't touch Supabase.
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
   * roundtrip per keystroke. The Keys and Security panes are
   * deliberate exceptions - they re-encrypt the config blob and need
   * a deliberate Save gesture so a typo can't lock the user out.
   * The Timezone field inside About you is also deliberate:
   * IANA-zone validation needs a commit gesture so a half-typed zone
   * (e.g. "America/") doesn't keep erroring on every keystroke.
   * Those three are the only Save buttons in the modal; if you find
   * yourself adding another one, the convention says you probably
   * want auto-apply with rollback instead.
   */
  import { onDestroy } from 'svelte';
  import { changePassword, saveConfig, toExportedConfig } from '$lib/config';
  import {
    app,
    activate,
    persistDefaultModel,
    persistDefaultReasoningEffort,
    persistDefaultVerbosity,
    persistDefaultLogLevel,
    persistEmphasisMarkdown,
    persistNotifyOnComplete,
    persistWikiAutomaticEnabled,
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
    REASONING_EFFORTS,
    REASONING_EFFORT_LABELS,
    TIERS,
    TIER_ORDER,
    VERBOSITIES,
    VERBOSITY_LABELS,
    type ModelTier,
    type ReasoningEffort,
    type Verbosity,
  } from '$lib/models';
  import type { SystemPrompt } from '$lib/supabase';
  import {
    ACCENTS,
    MODES,
    ACCENT_LABELS,
    ACCENT_SWATCHES,
    MODE_LABELS,
    effectiveMode,
    type Accent,
    type ColorMode,
  } from '$lib/theme';
  import SecretInput from '../components/SecretInput.svelte';
  import { updateState, applyUpdate, checkForUpdates } from '$lib/update.svelte';
  import {
    USAGE_MAX_PAGES,
    VeniceError,
    type UsageCurrency,
    type UsageRow,
  } from '$lib/venice';
  import {
    usage,
    isUsageStale,
    refreshUsage,
  } from '$lib/usage-store.svelte';

  interface Props {
    onClose: () => void;
  }
  let { onClose }: Props = $props();

  type Group =
    | 'keys'
    | 'ai'
    | 'wiki'
    | 'appearance'
    | 'usage'
    | 'security'
    | 'about';
  const GROUPS: { id: Group; label: string }[] = [
    { id: 'ai', label: 'AI' },
    { id: 'wiki', label: 'Wiki' },
    { id: 'appearance', label: 'Appearance' },
    { id: 'usage', label: 'Usage' },
    { id: 'security', label: 'Security' },
    { id: 'keys', label: 'API keys' },
    { id: 'about', label: 'About' },
  ];
  let group = $state<Group>('ai');

  // --- Keys pane ---
  let supabaseUrl = $state(app.config?.supabaseUrl ?? '');
  let supabaseAnonKey = $state(app.config?.supabaseAnonKey ?? '');
  let veniceApiKey = $state(app.config?.veniceApiKey ?? '');
  let keysPassword = $state('');
  let keysError = $state<string | null>(null);
  let keysInfo = $state<string | null>(null);

  // --- Model pane ---
  // Lives in Supabase `profiles.settings.defaultModel` (synced across
  // browsers), so no master password is needed to change it.
  let defaultModel = $state<ModelTier>(app.defaultModel);
  // Paired with defaultModel in the same pane / form because the two
  // always feel like one decision ("what am I asking the model to do,
  // and how hard should it think about it?"). Persisted on
  // `profiles.settings.defaultReasoningEffort`.
  let defaultReasoningEffort = $state<ReasoningEffort>(app.defaultReasoningEffort);
  // Paired with defaultModel / defaultReasoningEffort — a third knob in
  // the same "how do I want this model to answer me?" decision cluster.
  // Persisted on `profiles.settings.defaultVerbosity`.
  let defaultVerbosity = $state<Verbosity>(app.defaultVerbosity);
  // Opt-in formatting nudge. When on, chat-loop appends a short
  // instruction block to the per-turn system prompt asking the model
  // to use light Markdown emphasis as scan-points. Persisted on
  // `profiles.settings.emphasisMarkdown`.
  let emphasisMarkdown = $state<boolean>(app.emphasisMarkdown);
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

  // --- Wiki pane ---
  // Toggle for the autonomous wiki agent. The toggle pushes through
  // state.svelte.ts so the worker starts/stops in real time, and
  // persists on `profiles.settings.wikiAutomaticEnabled`.
  let wikiAutomaticEnabled = $state<boolean>(app.wikiAutomaticEnabled);
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
    const same =
      live.length === promptsDraft.length &&
      live.every((p, i) => {
        const local = promptsDraft[i];
        return (
          local.id === p.id &&
          local.name === p.name &&
          local.body === p.body &&
          local.enabledByDefault === p.enabledByDefault
        );
      });
    if (!same) promptsDraft = live.map((p) => ({ ...p }));
  });

  function addPrompt(): void {
    promptsDraft = [
      ...promptsDraft,
      {
        id: crypto.randomUUID(),
        name: 'New prompt',
        body: '',
        enabledByDefault: false,
      },
    ];
    schedulePromptsSave();
  }

  function updatePrompt(id: string, patch: Partial<SystemPrompt>): void {
    promptsDraft = promptsDraft.map((p) => (p.id === id ? { ...p, ...patch } : p));
    schedulePromptsSave();
  }

  function deletePrompt(id: string): void {
    promptsDraft = promptsDraft.filter((p) => p.id !== id);
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

  // Closing the modal mid-debounce would otherwise drop the user's
  // most recent prompt edit on the floor (the timer outlives the
  // component but its closure writes to state nobody reads anymore,
  // and persistSystemPrompts never gets called). Cancel the pending
  // timer and fire one final fire-and-forget save so the typed-but-
  // unsent state lands on the server. Safe to no-op when there's no
  // pending edit.
  onDestroy(() => {
    if (promptsDebounce !== null) {
      clearTimeout(promptsDebounce);
      promptsDebounce = null;
      void savePrompts();
    }
  });

  // --- Appearance pane ---
  let colorMode = $state<ColorMode>(app.colorMode);
  let accent = $state<Accent>(app.accent);
  let defaultLogLevel = $state<LogLevel>(app.defaultLogLevel);
  let appearanceError = $state<string | null>(null);
  let appearanceInfo = $state<string | null>(null);

  // Apply selection live as the user clicks - no Save button needed.
  // Theme has two axes (mode + accent), so each picker assembles the
  // full pair and routes through the same persist helper.
  async function onPickMode(next: ColorMode): Promise<void> {
    const prevMode = colorMode;
    colorMode = next;
    appearanceError = null;
    appearanceInfo = null;
    try {
      await persistTheme(next, accent);
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
      await persistTheme(colorMode, next);
      appearanceInfo = 'Saved.';
    } catch (err) {
      accent = prevAccent;
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
      exportError = 'No active config — please unlock first.';
      return;
    }
    try {
      const blob = new Blob([JSON.stringify(toExportedConfig(app.config), null, 2)], {
        type: 'application/json',
      });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      a.download = `nak-config-${stamp}.json`;
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
  // Backed by Venice's /billing/usage (beta per Venice docs). We pull
  // all rows in the range, aggregate by (sku, currency), and show a
  // token-scaled bar chart with a spend pill per row.
  //
  // Date picker values are yyyy-mm-dd strings (the format
  // `<input type="date">` produces and consumes). We convert to ISO
  // 8601 at fetch time — startDate as 00:00:00Z of the picked day,
  // endDate as 24:00:00Z of the picked day so the upper bound is
  // inclusive of the whole end-of-range day despite Venice's exclusive
  // cursor semantics.

  /** One aggregated bucket for the Usage table. */
  interface UsageBucket {
    sku: string;
    currency: UsageCurrency;
    /** Sum of prompt + completion tokens across LLM rows in this bucket. */
    tokens: number;
    /** Sum of `amount` in this bucket's currency. */
    amount: number;
    /** Row count — for the tooltip / debug, not displayed. */
    requests: number;
  }

  function todayYmd(): string {
    return new Date().toISOString().slice(0, 10);
  }
  function ymdDaysAgo(days: number): string {
    const d = new Date();
    d.setDate(d.getDate() - days);
    return d.toISOString().slice(0, 10);
  }

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
  let customRows = $state<UsageRow[] | null>(null);
  let customLoading = $state(false);
  let customError = $state<string | null>(null);
  let customTruncated = $state(false);
  // Per-page progress for the custom-range fetch. Mirrors the
  // pagesLoaded/pagesTotal pair on the shared store so the in-pane
  // progress indicator can read from a single derived signal
  // regardless of which source the pane is currently displaying.
  let customPagesLoaded = $state(0);
  let customPagesTotal = $state(0);

  const usageRows = $derived(
    usageSource === 'store' ? usage.data : customRows
  );
  const usageLoading = $derived(
    usageSource === 'store' ? usage.loading : customLoading
  );
  const usageError = $derived(
    usageSource === 'store' ? usage.error : customError
  );
  const usageTruncated = $derived(
    usageSource === 'store' ? usage.truncated : customTruncated
  );
  const usagePagesLoaded = $derived(
    usageSource === 'store' ? usage.pagesLoaded : customPagesLoaded
  );
  const usagePagesTotal = $derived(
    usageSource === 'store' ? usage.pagesTotal : customPagesTotal
  );

  /**
   * First-landing-on-the-pane auto-refresh. Fires only when the pane
   * is showing the store view AND the cache is null or older than
   * USAGE_STALE_MS - a fresher poll is reused as-is so the user sees
   * numbers without a spinner. The guard on `usage.loading` means a
   * poll already in flight (common during the boot window) isn't
   * double-triggered.
   */
  $effect(() => {
    if (
      group === 'usage' &&
      usageSource === 'store' &&
      !usage.loading &&
      isUsageStale() &&
      app.venice
    ) {
      void refreshUsage(app.venice);
    }
  });

  async function onUsageRefresh(): Promise<void> {
    if (!app.venice) {
      customError = 'Not connected to Venice yet.';
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
      await refreshUsage(app.venice);
      return;
    }
    usageSource = 'custom';
    customError = null;
    customLoading = true;
    customTruncated = false;
    // Reset progress so a previous custom fetch's "5/5" doesn't read
    // as complete while the new one is still on page 1.
    customPagesLoaded = 0;
    customPagesTotal = 0;
    // Snapshot the requested range so a user who edits the date
    // pickers and re-clicks Refresh before this fetch settles
    // doesn't see the prior range's rows land as if they were the
    // new range's response.
    const requestedStart = usageStart;
    const requestedEnd = usageEnd;
    const isStale = (): boolean =>
      usageStart !== requestedStart || usageEnd !== requestedEnd;
    try {
      // End-of-day upper bound: the date picker reads as "through this
      // whole day". Venice treats endDate as an exclusive cutoff, so
      // we pass the *next* midnight to include the picked day itself.
      const startIso = new Date(`${requestedStart}T00:00:00Z`).toISOString();
      const endDay = new Date(`${requestedEnd}T00:00:00Z`);
      endDay.setUTCDate(endDay.getUTCDate() + 1);
      const endIso = endDay.toISOString();
      const rows = await app.venice.fetchUsage({
        startDate: startIso,
        endDate: endIso,
        onProgress: ({ page, totalPages }) => {
          // Late progress ticks from a stale fetch must not overwrite
          // the counters the newer in-flight request is updating - the
          // same staleness guard the row-assignment block below uses.
          if (isStale()) return;
          customPagesLoaded = page;
          customPagesTotal = totalPages;
        },
      });
      if (isStale()) return;
      customRows = rows;
      // Best-effort cap detection: if the response came back exactly at
      // the page × per-page ceiling, we almost certainly hit the safety
      // limit. Not perfect (a user with exactly 10k rows would also
      // trip it) but close enough for a "your data may be truncated"
      // hint — never shown when we're confidently under the cap.
      customTruncated = rows.length >= USAGE_MAX_PAGES * 500;
    } catch (err) {
      if (isStale()) return;
      customError =
        err instanceof VeniceError
          ? err.message
          : err instanceof Error
            ? err.message
            : String(err);
      customRows = null;
    } finally {
      // Only flip the spinner off for our own request - a stale
      // response landing while a newer fetch is in flight would
      // otherwise prematurely clear the spinner the new request
      // just turned on.
      if (!isStale()) customLoading = false;
    }
  }

  /**
   * Aggregate per (sku, currency). LLM rows contribute
   * prompt+completion to `tokens`; non-LLM rows (image/video) have a
   * null `inferenceDetails` and contribute 0 to tokens but still land
   * in a bucket so they appear in the list (with a zero-width bar).
   * Grouping by currency too keeps a user on a mixed USD+VCU plan
   * from seeing nonsensical summed spend.
   *
   * `amount` is inverted before accumulation. Venice's ledger
   * convention records charges as negative (debits against the
   * balance); in a "what am I spending?" view we want those to read
   * as positive costs — otherwise the pane reads as a balance sheet
   * and sub-cent rows flashed `$-0.00` when the sign leaked through
   * `.toFixed(2)` rounding.
   *
   * Buckets whose inverted spend lands below one cent are dropped.
   * Dust rows clutter the chart without telling the user anything
   * they'd act on, and keeping them produced the `$0.00` / `$-0.00`
   * cells that started this refinement.
   */
  function aggregateUsage(rows: UsageRow[]): UsageBucket[] {
    const buckets = new Map<string, UsageBucket>();
    for (const row of rows) {
      const key = `${row.sku}|${row.currency}`;
      let b = buckets.get(key);
      if (!b) {
        b = {
          sku: row.sku,
          currency: row.currency,
          tokens: 0,
          amount: 0,
          requests: 0,
        };
        buckets.set(key, b);
      }
      const d = row.inferenceDetails;
      if (d) {
        b.tokens += (d.promptTokens ?? 0) + (d.completionTokens ?? 0);
      }
      // Invert Venice's signed debit to a positive cost.
      b.amount += -row.amount;
      b.requests += 1;
    }
    return (
      Array.from(buckets.values())
        // One-cent dust filter. The USD display resolution is two
        // decimals, so anything under $0.01 renders as zero anyway;
        // applying the same numeric threshold to credit currencies
        // (VCU / DIEM / BUNDLED_CREDITS) drops equivalently trivial
        // rows there too without needing a per-currency table.
        .filter((b) => b.amount >= 0.01)
        .sort((a, b) => {
          // Token-heavy rows first. Zero-token rows (image, video)
          // cluster at the bottom in amount order so spend-only SKUs
          // still sort sensibly among themselves.
          if (b.tokens !== a.tokens) return b.tokens - a.tokens;
          return b.amount - a.amount;
        })
    );
  }

  /** One row of the per-currency spend summary at the top of the pane. */
  interface CurrencyTotal {
    currency: UsageCurrency;
    amount: number;
  }

  /**
   * Roll the per-model buckets up into one total per currency. We
   * group rather than collapse so a user on a mixed USD + credits
   * plan sees two totals — summing across currencies would be
   * meaningless (a dollar and a credit aren't the same unit). USD
   * sorts first so the cash total — the one that actually hit the
   * user's card — reads as the primary figure; credit currencies
   * fall in stable alpha order after.
   */
  function aggregateTotalsByCurrency(buckets: UsageBucket[]): CurrencyTotal[] {
    const sums = new Map<UsageCurrency, number>();
    for (const b of buckets) {
      sums.set(b.currency, (sums.get(b.currency) ?? 0) + b.amount);
    }
    return Array.from(sums.entries())
      .map(([currency, amount]) => ({ currency, amount }))
      .sort((a, b) => {
        if (a.currency === 'USD') return -1;
        if (b.currency === 'USD') return 1;
        return a.currency.localeCompare(b.currency);
      });
  }

  const tokenFormatter = new Intl.NumberFormat(undefined, {
    notation: 'compact',
    maximumFractionDigits: 1,
  });
  function formatTokens(n: number): string {
    if (n === 0) return '—';
    return tokenFormatter.format(n);
  }

  /**
   * Always render spend with the `$` sigil. Non-USD charges (VCU,
   * DIEM, BUNDLED_CREDITS) get a muted pill style and a hover
   * tooltip spelling out the origin — that's where "this was paid
   * with credits, not cash" gets communicated. Keeping the numeric
   * body identical across currencies lets every pill align cleanly
   * in the spend column without the currency code widening the
   * cell for a subset of rows.
   */
  function formatAmount(amount: number, _currency: UsageCurrency): string {
    void _currency;
    return `$${amount.toFixed(2)}`;
  }

  /**
   * Inclusive day count for the picked range. The date pickers read
   * as yyyy-mm-dd in the user's local calendar; "from May 1 to May 7"
   * intuitively covers 7 days, not 6 (the diff between midnights) and
   * not 8 (the exclusive upper bound the fetch uses). The clamp at 1
   * keeps a same-day selection from dividing by zero.
   */
  function daysInPickedRange(start: string, end: string): number {
    const startMs = new Date(`${start}T00:00:00Z`).getTime();
    const endMs = new Date(`${end}T00:00:00Z`).getTime();
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) return 1;
    const diffDays = Math.round((endMs - startMs) / (24 * 60 * 60 * 1000));
    return Math.max(1, diffDays + 1);
  }

  /**
   * Sub-cent precision for the avg-per-day pill. The totals pill
   * rounds to two decimals because dollars and cents is the usual
   * display unit, but daily averages from a 7-day window of light
   * traffic can easily land at fractions of a cent - rounding those
   * to `$0.00` defeats the pill's purpose. Three decimals keeps the
   * pill readable while still showing signal on a sub-cent average.
   */
  function formatAmountPerDay(amount: number, _currency: UsageCurrency): string {
    void _currency;
    if (amount === 0) return '$0/day';
    if (amount < 0.005) return `$${amount.toFixed(3)}/day`;
    return `$${amount.toFixed(2)}/day`;
  }

  /**
   * Human-facing tooltip text for a non-USD pill. Expands the wire-
   * shape code into prose so a user who doesn't know what
   * `BUNDLED_CREDITS` means on Venice's plan page still gets a
   * readable hint. Unknown codes fall back to the raw identifier
   * rather than silently hiding the distinction.
   */
  function currencyTitle(currency: UsageCurrency): string {
    switch (currency) {
      case 'BUNDLED_CREDITS':
        return 'Paid with bundled credits';
      case 'VCU':
        return 'Paid with Venice Compute Units';
      case 'DIEM':
        return 'Paid with DIEM credits';
      default:
        return `Paid with ${currency}`;
    }
  }

  /**
   * Compute a hue (0–360) for a bucket's bar based on its token
   * count relative to the rest of the chart. Maps "typical" to
   * green (~140°), lightweight models to blue (~220°), and heavy
   * hitters to red (~5°).
   *
   * Why median-anchored on log tokens, not a plain percentile
   * tertile: usage distributions are heavy-tailed — a user with
   * one kimi-heavy workload and a dozen utility calls on other
   * models would see the whole spectrum collapsed to two adjacent
   * shades under straight "top-third / middle-third / bottom-third"
   * bucketing. Anchoring at the median isolates the outlier on the
   * high side without flattening the rest into a single color,
   * which matches the intuitive read: "most of these are the green
   * pack, that one is obviously doing more work." log() is the
   * other half of the trick — it squeezes an order-of-magnitude
   * outlier into a comparable distance on the color axis so the
   * gradient stays readable whether the biggest bucket is 2× or
   * 200× the smallest.
   *
   * Small-N behavior: with 1 bucket, everything sits at the median
   * (green). With 2, the larger is at +1 (red) and the smaller at
   * -1 (blue) — minimally useful but not wrong. The coloring earns
   * its keep at 3+ models, which is the common case.
   */
  function usageHue(tokens: number, buckets: UsageBucket[]): number {
    // Neutral (green) — any row that somehow has zero tokens picks
    // up the same color the rest of the "typical" band uses.
    if (tokens <= 0) return 140;
    const logs = buckets
      .map((b) => b.tokens)
      .filter((t) => t > 0)
      .map((t) => Math.log(t))
      .sort((a, b) => a - b);
    if (logs.length === 0) return 140;
    const median = logs[Math.floor(logs.length / 2)];
    const minLog = logs[0];
    const maxLog = logs[logs.length - 1];
    const cur = Math.log(tokens);
    // Position in [-1, +1] anchored at the median. +1 = the biggest
    // bucket, -1 = the smallest, 0 = sitting on the median.
    let pos: number;
    if (cur >= median) {
      pos = maxLog === median ? 0 : (cur - median) / (maxLog - median);
    } else {
      pos = minLog === median ? 0 : -(median - cur) / (median - minLog);
    }
    pos = Math.max(-1, Math.min(1, pos));
    // Map: -1 → 220 (blue), 0 → 140 (green), +1 → 5 (red). The red
    // side uses a steeper slope (140° → 5° over [0, 1]) so outliers
    // reach a genuinely red hue; the blue side moves more gently
    // (140° → 220° over [-1, 0]) to avoid pushing past cyan into
    // purple.
    if (pos >= 0) return 140 - pos * 135;
    return 140 - pos * 80;
  }

  // --- Security pane ---
  // Two independent rotations live here:
  //   - master password: unlocks the local encrypted config blob
  //   - Supabase login password: signs in to the user's Supabase project
  // Each has its own current/new/error/info pair so a failure in one
  // form doesn't blow away feedback from the other.
  let pwCurrent = $state('');
  let pwNew = $state('');
  let pwConfirm = $state('');
  let pwError = $state<string | null>(null);
  let pwInfo = $state<string | null>(null);

  let authPwCurrent = $state('');
  let authPwNew = $state('');
  let authPwConfirm = $state('');
  let authPwError = $state<string | null>(null);
  let authPwInfo = $state<string | null>(null);
  let authPwBusy = $state(false);

  let busy = $state(false);

  // --- About pane ---
  // Humanize the ISO string Vite stamped at build time. Falls back to
  // the raw value on any parse hiccup — e.g. the literal 'dev' that
  // shows up during `pnpm dev` (no build step ran, so nothing to
  // parse) or on a browser that doesn't speak the en-* locale family.
  function formatBuildTime(iso: string): string {
    const parsed = new Date(iso);
    if (isNaN(parsed.getTime())) return iso;
    return parsed.toLocaleString(undefined, {
      dateStyle: 'medium',
      timeStyle: 'short',
    });
  }

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

  async function onSaveKeys(e: SubmitEvent): Promise<void> {
    e.preventDefault();
    keysError = null;
    keysInfo = null;
    if (!keysPassword) {
      keysError = 'Enter your current master password to re-encrypt.';
      return;
    }
    busy = true;
    try {
      const config = {
        supabaseUrl: supabaseUrl.trim(),
        supabaseAnonKey: supabaseAnonKey.trim(),
        veniceApiKey: veniceApiKey.trim(),
      };
      await saveConfig(config, keysPassword);
      activate(config);
      keysInfo = 'Keys updated.';
      keysPassword = '';
    } catch (err) {
      keysError = err instanceof Error ? err.message : String(err);
    } finally {
      busy = false;
    }
  }

  // Picking a radio applies the choice immediately - no Save button.
  // Optimistic in-memory flip so the radio reflects the new tier
  // right away; on persistence failure we roll the local form state
  // back. The persistX helper handles app-state apply + rollback.
  async function onPickModel(next: ModelTier): Promise<void> {
    modelError = null;
    modelInfo = null;
    const prev = defaultModel;
    defaultModel = next;
    try {
      await persistDefaultModel(next);
      modelInfo = `Default model set to ${TIERS[next].label}.`;
    } catch (err) {
      defaultModel = prev;
      modelError = err instanceof Error ? err.message : String(err);
    }
  }

  async function onPickReasoning(next: ReasoningEffort): Promise<void> {
    modelError = null;
    modelInfo = null;
    const prev = defaultReasoningEffort;
    defaultReasoningEffort = next;
    try {
      await persistDefaultReasoningEffort(next);
      modelInfo = `Default reasoning effort set to ${REASONING_EFFORT_LABELS[next].toLowerCase()}.`;
    } catch (err) {
      defaultReasoningEffort = prev;
      modelError = err instanceof Error ? err.message : String(err);
    }
  }

  async function onPickVerbosity(next: Verbosity): Promise<void> {
    modelError = null;
    modelInfo = null;
    const prev = defaultVerbosity;
    defaultVerbosity = next;
    try {
      await persistDefaultVerbosity(next);
      modelInfo = `Default verbosity set to ${VERBOSITY_LABELS[next].toLowerCase()}.`;
    } catch (err) {
      defaultVerbosity = prev;
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
      modelInfo = trimmed.length > 0 ? 'Name saved.' : 'Name cleared.';
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
      modelInfo = trimmed.length > 0 ? 'Location saved.' : 'Location cleared.';
    } catch (err) {
      modelError = err instanceof Error ? err.message : String(err);
    }
  }

  async function onToggleEmphasis(next: boolean): Promise<void> {
    modelError = null;
    modelInfo = null;
    const prev = emphasisMarkdown;
    emphasisMarkdown = next;
    try {
      await persistEmphasisMarkdown(next);
      modelInfo = next
        ? 'Emphasis markdown enabled.'
        : 'Emphasis markdown disabled.';
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
      modelInfo = next
        ? notificationsSupported()
          ? 'Reply notifications enabled.'
          : 'Reply notifications enabled. This browser does not support OS notifications, so Nak will flag unread threads in the sidebar instead.'
        : 'Reply notifications disabled.';
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
    if (result === 'granted') {
      modelInfo = 'Reply notifications enabled for this browser.';
    } else if (result === 'denied') {
      // Chromium auto-rejects requestPermission() after a prior deny
      // without showing UI, so the user has to unblock via browser
      // settings. Spell that out rather than leaving them clicking a
      // button that silently does nothing.
      modelError =
        'Browser notifications are blocked for this site. Allow them in your browser settings, then reload.';
    } else {
      // 'default' means the user dismissed the prompt without picking
      // (closed the chip, hit Escape). Re-clicking the button will
      // re-show the prompt since the gesture chain stays alive.
      modelError =
        'Notifications still off. Click the button again to retry, or allow them in your browser settings.';
    }
  }

  async function onToggleWikiAutomatic(next: boolean): Promise<void> {
    wikiError = null;
    wikiInfo = null;
    const prev = wikiAutomaticEnabled;
    wikiAutomaticEnabled = next;
    try {
      await persistWikiAutomaticEnabled(next);
      wikiInfo = next
        ? 'Automatic wiki enabled.'
        : 'Automatic wiki disabled. Manual edits and the per-article "ask agent to update" button still work.';
    } catch (err) {
      wikiAutomaticEnabled = prev;
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
      wikiInfo = next
        ? 'Wiki librarian enabled.'
        : 'Wiki librarian disabled. Existing articles are unaffected.';
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
      memoryLibrarianInfo = next
        ? 'Memory librarian enabled.'
        : 'Memory librarian disabled. Existing memories are unaffected.';
    } catch (err) {
      memoryLibrarianEnabled = prev;
      memoryLibrarianError = err instanceof Error ? err.message : String(err);
    }
  }

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

  async function onChangePassword(e: SubmitEvent): Promise<void> {
    e.preventDefault();
    pwError = null;
    pwInfo = null;
    if (!pwCurrent) {
      pwError = 'Enter your current master password.';
      return;
    }
    if (pwNew.length < 8) {
      pwError = 'New password must be at least 8 characters.';
      return;
    }
    if (pwNew !== pwConfirm) {
      pwError = 'New password and confirmation do not match.';
      return;
    }
    busy = true;
    try {
      await changePassword(pwCurrent, pwNew);
      pwInfo = 'Master password changed.';
      pwCurrent = '';
      pwNew = '';
      pwConfirm = '';
    } catch (err) {
      pwError = err instanceof Error ? err.message : String(err);
    } finally {
      busy = false;
    }
  }

  async function onChangeAuthPassword(e: SubmitEvent): Promise<void> {
    e.preventDefault();
    authPwError = null;
    authPwInfo = null;
    if (!authPwCurrent) {
      authPwError = 'Enter your current account password.';
      return;
    }
    // Supabase enforces a 6-character minimum by default. Bump to 8 to
    // match the master-password form above so both rotations have the
    // same floor.
    if (authPwNew.length < 8) {
      authPwError = 'New password must be at least 8 characters.';
      return;
    }
    if (authPwNew !== authPwConfirm) {
      authPwError = 'New password and confirmation do not match.';
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
          Update your Supabase and Venice credentials. Requires your current master
          password to re-encrypt.
        </p>
        <form onsubmit={onSaveKeys}>
          <div class="form-row">
            <label for="su">Supabase URL</label>
            <input id="su" type="url" bind:value={supabaseUrl} required />
          </div>
          <div class="form-row">
            <label for="sa">Supabase anon key</label>
            <SecretInput id="sa" bind:value={supabaseAnonKey} required />
          </div>
          <div class="form-row">
            <label for="vk">Venice API key</label>
            <SecretInput id="vk" bind:value={veniceApiKey} required />
          </div>
          <div class="form-row">
            <label for="cp">Current master password</label>
            <SecretInput id="cp" bind:value={keysPassword} required
                         autocomplete="current-password" />
          </div>
          {#if keysError}<p class="error">{keysError}</p>{/if}
          {#if keysInfo}<p class="subtle">{keysInfo}</p>{/if}
          <button type="submit" disabled={busy}>Save keys</button>
        </form>

        <h3 class="pane-section">Export</h3>
        <p class="subtle">
          Download your Supabase and Venice credentials as a JSON file so you
          can reimport them when setting up Nak on another browser. This is a
          local-only feature - the file is generated in your browser and
          never uploaded.
        </p>
        <p class="subtle" style="color:var(--warn);font-size:0.85rem">
          ⚠ The exported file contains your API keys in plaintext. Store it
          with the same care as any other secret (e.g. your password
          manager). Deleting it afterward is a fine choice.
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
             autosave — picking a model or reasoning tier flips through
             on change, prompts debounce-save on edit, and the
             web-search checkbox writes on toggle — so the whole pane
             matches the Appearance pane's "touch it and it sticks"
             behavior. -->
        <h2>AI</h2>
        <p class="subtle">Default model and system prompts.</p>

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
          <code>{detectTimezone()}</code>. Save commits the value
          (zones go through validation, so a half-typed name doesn't
          fire an error on every keystroke).
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
          <button
            type="button"
            class="secondary"
            onclick={() => onChangeDisplayTimezone(displayTimezone)}
          >Save</button>
        </div>

        <h3 class="pane-section">Default model</h3>
        <p class="subtle">
          Used for any thread that doesn't have its own model set. You can override
          per-thread from the chat top bar.
        </p>
        <div class="form-row model-choices">
          {#each TIER_ORDER as tier (tier)}
            <label class="model-choice">
              <input
                type="radio"
                name="default-model"
                value={tier}
                checked={defaultModel === tier}
                onchange={() => onPickModel(tier)}
              />
              <span>
                <strong>{TIERS[tier].label}</strong>
                <span class="subtle" style="margin-left:0.35rem">{TIERS[tier].description}</span>
                <span class="subtle" style="display:block;font-size:0.8rem;margin-top:0.1rem">
                  {TIERS[tier].id} · {(TIERS[tier].contextWindow / 1000).toFixed(0)}k context
                </span>
              </span>
            </label>
          {/each}
        </div>

        <h3 class="pane-section">Default reasoning effort</h3>
        <p class="subtle">
          Controls how hard the model thinks before replying on
          reasoning-capable models. <strong>Low</strong> keeps turns
          snappy; <strong>high</strong> trades latency for depth.
          Ignored on non-reasoning models. Overridable per-thread from
          the composer.
        </p>
        <div class="form-row" style="display:flex;gap:0.5rem;align-items:center">
          <label for="default-reasoning" class="sr-only">Default reasoning effort</label>
          <select
            id="default-reasoning"
            value={defaultReasoningEffort}
            onchange={(e) =>
              onPickReasoning((e.currentTarget as HTMLSelectElement).value as ReasoningEffort)}
          >
            {#each REASONING_EFFORTS as effort (effort)}
              <option value={effort}>{REASONING_EFFORT_LABELS[effort]}</option>
            {/each}
          </select>
        </div>
        <h3 class="pane-section">Default verbosity</h3>
        <p class="subtle">
          Suggests how long the model's answers should be before any
          reasoning knob kicks in. <strong>Low</strong> biases toward
          short, direct replies; <strong>high</strong> invites
          expansive prose. Passed on every request as
          <code>text.verbosity</code> — providers that don't honor the
          field silently ignore it. Overridable per-thread from the
          composer.
        </p>
        <div class="form-row" style="display:flex;gap:0.5rem;align-items:center">
          <label for="default-verbosity" class="sr-only">Default verbosity</label>
          <select
            id="default-verbosity"
            value={defaultVerbosity}
            onchange={(e) =>
              onPickVerbosity((e.currentTarget as HTMLSelectElement).value as Verbosity)}
          >
            {#each VERBOSITIES as v (v)}
              <option value={v}>{VERBOSITY_LABELS[v]}</option>
            {/each}
          </select>
        </div>

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
        <div class="form-row" style="display:flex;gap:0.5rem;align-items:center">
          <label style="display:flex;gap:0.5rem;align-items:center">
            <input
              type="checkbox"
              name="emphasis-markdown"
              checked={emphasisMarkdown}
              onchange={(e) =>
                onToggleEmphasis((e.currentTarget as HTMLInputElement).checked)}
            />
            <span>Ask the model to highlight save-points</span>
          </label>
        </div>

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
        <div class="form-row" style="display:flex;gap:0.5rem;align-items:center">
          <label style="display:flex;gap:0.5rem;align-items:center">
            <input
              type="checkbox"
              name="notify-on-complete"
              checked={notifyOnComplete}
              onchange={(e) =>
                onToggleNotifyOnComplete((e.currentTarget as HTMLInputElement).checked)}
            />
            <span>Notify me when replies finish</span>
          </label>
        </div>
        {#if notifyOnComplete && notificationsSupported() && notifyPermission !== 'granted'}
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
            only one run happens per cycle.
          </span>
        </label>
        {#if memoryLibrarianError}<p class="error">{memoryLibrarianError}</p>{/if}
        {#if memoryLibrarianInfo}<p class="subtle">{memoryLibrarianInfo}</p>{/if}

        <h3 class="pane-section">System prompts</h3>
        <p class="subtle">
          Named prompts you can toggle on or off from the chat composer. The
          "Default" checkbox seeds the active set for new conversations.
          Per-conversation toggles aren't saved — they only affect the
          current thread.
        </p>
        <div class="prompt-list">
          {#each promptsDraft as p (p.id)}
            <div class="prompt-card">
              <div class="prompt-row">
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
              <span class="swatch" style="--sw-dark:{ACCENT_SWATCHES[a].dark};--sw-light:{ACCENT_SWATCHES[a].light}"></span>
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
          Usage pane: a date-ranged snapshot of the Venice billing
          ledger for this API key. Hits Venice's beta
          `/billing/usage` endpoint, aggregates by (sku, currency),
          and renders a bar chart scaled by total tokens with a spend
          pill per row. The default rolling-7-day view is cached in
          `$lib/usage-store.svelte` and fetched lazily on first open
          of this pane in the session; the `$effect` above also
          forces a refresh when the cache is older than
          USAGE_STALE_MS. User-picked custom ranges bypass the cache
          and fetch on-demand.
        -->
        <h2>Usage</h2>
        <p class="subtle">
          Token spend against your Venice API key. Pulled from
          Venice's billing ledger — the numbers below are what Venice
          reports, not a Nak-side tally. The default 7-day view
          fetches the first time you open this pane and caches the
          result for 15 minutes; opening the pane again after that
          re-fetches automatically. Custom date ranges fetch when
          you hit Refresh. Bars are scaled by
          prompt + completion tokens; the pill on the right is the
          raw billed amount in whatever currency each charge was
          denominated in.
        </p>
        <div class="usage-controls">
          <label class="usage-date">
            <span>From</span>
            <input
              type="date"
              name="usage-start"
              bind:value={usageStart}
              max={usageEnd}
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
            />
          </label>
          <button
            type="button"
            onclick={onUsageRefresh}
            disabled={usageLoading}
          >
            {#if usageLoading && usagePagesTotal > 0}
              Loading… {usagePagesLoaded}/{usagePagesTotal}
            {:else if usageLoading}
              Loading…
            {:else}
              Refresh
            {/if}
          </button>
        </div>
        {#if usageLoading}
          <!--
            The bar renders the moment the fetch starts so the user
            isn't left staring at a frozen "Loading..." button while
            Venice works on the first page (the slowest step - the
            server computes the count + sort there, subsequent pages
            return quickly). Until `pagesTotal` lands from the first
            response we show an indeterminate marching bar; once the
            count is known the bar flips to a determinate fill that
            tracks `pagesLoaded / pagesTotal`. ARIA attributes drop
            the value fields in the indeterminate phase per the WAI-
            ARIA spec for an unknown-progress bar.
          -->
          {#if usagePagesTotal > 0}
            <div
              class="usage-progress"
              role="progressbar"
              aria-label="Loading usage pages"
              aria-valuemin="0"
              aria-valuemax={usagePagesTotal}
              aria-valuenow={usagePagesLoaded}
            >
              <span
                class="usage-progress-fill"
                style="--usage-progress-pct:{(usagePagesLoaded / usagePagesTotal) * 100}%"
              ></span>
            </div>
          {:else}
            <div
              class="usage-progress"
              role="progressbar"
              aria-label="Loading first page of usage data"
            >
              <span class="usage-progress-fill indeterminate"></span>
            </div>
          {/if}
        {/if}
        {#if usageError}<p class="error">{usageError}</p>{/if}
        {#if usageRows !== null && !usageError}
          {@const buckets = aggregateUsage(usageRows)}
          {@const maxTokens = buckets.reduce((m, b) => Math.max(m, b.tokens), 0)}
          {@const totalTokens = buckets.reduce((s, b) => s + b.tokens, 0)}
          {@const totalsByCurrency = aggregateTotalsByCurrency(buckets)}
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
              <strong>{buckets.length}</strong>{buckets.length === 1 ? ' model' : ' models'}.
              {#each totalsByCurrency as t (t.currency)}
                <span
                  class="usage-pill"
                  class:credit={t.currency !== 'USD'}
                  title={t.currency !== 'USD' ? currencyTitle(t.currency) : undefined}
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
                  class:credit={t.currency !== 'USD'}
                  title={`Average per day over ${rangeDays} day${rangeDays === 1 ? '' : 's'}${t.currency !== 'USD' ? ' - ' + currencyTitle(t.currency) : ''}`}
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
                      Width is `max(2%, share-of-max)` so a non-zero
                      but tiny row still registers as a visible bar
                      rather than an invisible sliver. A truly zero-
                      token row (image SKU) collapses to nothing.
                    -->
                    <span
                      class="usage-bar"
                      class:zero={b.tokens === 0}
                      style="--usage-pct:{maxTokens > 0 && b.tokens > 0
                        ? Math.max(2, (b.tokens / maxTokens) * 100)
                        : 0}%; --usage-hue:{usageHue(b.tokens, buckets)}"
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
                    lost when the pill is grey.
                  -->
                  <span
                    class="usage-pill"
                    class:credit={b.currency !== 'USD'}
                    role="cell"
                    title={b.currency !== 'USD' ? currencyTitle(b.currency) : undefined}
                  >{formatAmount(b.amount, b.currency)}</span>
                </div>
              {/each}
            </div>
          {/if}
          {#if usageTruncated}
            <p class="subtle" style="font-size:0.8rem">
              Only the most recent {USAGE_MAX_PAGES * 500} rows were
              loaded — narrow the date range to see the full picture.
            </p>
          {/if}
        {/if}
        <p class="subtle" style="font-size:0.8rem">
          The underlying endpoint is marked beta by Venice; the shape
          of a row can shift without notice. If the list comes back
          empty after a successful fetch, Venice most likely hasn't
          ingested your recent requests yet — the ledger can lag live
          traffic by a few minutes.
        </p>
      {:else if group === 'security'}
        <h2>Security</h2>

        <h3 class="pane-section">Change master password</h3>
        <p class="subtle">
          Rotate the passphrase that unlocks your encrypted config blob.
          Local-only - this re-encrypts the blob in your browser and does
          not touch Supabase.
        </p>
        <form onsubmit={onChangePassword}>
          <div class="form-row">
            <label for="pw-current">Current master password</label>
            <SecretInput id="pw-current" bind:value={pwCurrent} required
                         autocomplete="current-password" />
          </div>
          <div class="form-row">
            <label for="pw-new">New master password</label>
            <SecretInput id="pw-new" bind:value={pwNew} minlength={8} required
                         autocomplete="new-password" />
          </div>
          <div class="form-row">
            <label for="pw-confirm">Confirm new master password</label>
            <SecretInput id="pw-confirm" bind:value={pwConfirm} minlength={8} required
                         autocomplete="new-password" />
          </div>
          {#if pwError}<p class="error">{pwError}</p>{/if}
          {#if pwInfo}<p class="subtle">{pwInfo}</p>{/if}
          <button type="submit" disabled={busy}>Change password</button>
        </form>

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
        >
          {#if aboutBusy === 'reloading'}
            Reloading…
          {:else if aboutBusy === 'checking'}
            Checking…
          {:else if updateState.available}
            Reload to update
          {:else}
            Check for updates
          {/if}
        </button>
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
