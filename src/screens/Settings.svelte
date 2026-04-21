<script lang="ts">
  /*
   * Settings modal. Reached from the chat sidebar's gear icon. Five
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
   *   export      — download the three keys as a plaintext JSON file
   *                 for import on another browser. See config.ts for
   *                 the file format.
   *   security    — rotate the master password. Re-encrypts the stored
   *                 blob under the new password; doesn't touch Supabase.
   *
   * The `busy` flag is shared across forms so double-submits during an
   * in-flight save are harmless.
   */
  import { changePassword, saveConfig, toExportedConfig } from '$lib/config';
  import {
    app,
    activate,
    setDefaultModel,
    setDefaultReasoningEffort,
    setDefaultVerbosity,
    setSystemPrompts,
    setTheme,
    setWebSearchEnabled,
  } from '$lib/state.svelte';
  import {
    MODELS,
    REASONING_EFFORTS,
    REASONING_EFFORT_LABELS,
    TIERS,
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

  interface Props {
    onClose: () => void;
    /**
     * Optional handoff to the Memories modal. Chat.svelte wires this
     * to `() => { showSettings = false; showMemories = true; }` so the
     * AI pane's "Browse memories" link swaps modals atomically — we
     * can't open Memories *alongside* Settings because both render in
     * the same mutually-exclusive `{:else if}` branch in Chat.svelte.
     * Left optional so Settings stays independently renderable (e.g.
     * from tests) without a second modal in scope.
     */
    onOpenMemories?: () => void;
  }
  let { onClose, onOpenMemories }: Props = $props();

  type Group =
    | 'keys'
    | 'ai'
    | 'appearance'
    | 'usage'
    | 'export'
    | 'security'
    | 'about';
  const GROUPS: { id: Group; label: string }[] = [
    { id: 'keys', label: 'API keys' },
    { id: 'ai', label: 'AI' },
    { id: 'appearance', label: 'Appearance' },
    { id: 'usage', label: 'Usage' },
    { id: 'export', label: 'Export' },
    { id: 'security', label: 'Security' },
    { id: 'about', label: 'About' },
  ];
  let group = $state<Group>('keys');

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
  let modelError = $state<string | null>(null);
  let modelInfo = $state<string | null>(null);

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
    if (!app.supabase) {
      promptsError = 'Not connected to Supabase yet.';
      promptsSaveState = 'idle';
      return;
    }
    promptsSaving = true;
    try {
      const merged = await app.supabase.updateSettings({
        systemPrompts: promptsDraft,
      });
      setSystemPrompts(merged.systemPrompts ?? []);
      promptsSaveState = 'saved';
    } catch (err) {
      promptsError = err instanceof Error ? err.message : String(err);
      promptsSaveState = 'idle';
    } finally {
      promptsSaving = false;
    }
  }

  // --- Web search pane ---
  // Mirror of app.webSearchEnabled. Persisted on Supabase
  // `profiles.settings.webSearchEnabled`. Enabled-by-default: an empty
  // settings jsonb means web search is on, so we only write a literal
  // `false` to flip it off.
  let webSearchEnabled = $state<boolean>(app.webSearchEnabled);
  let webSearchError = $state<string | null>(null);
  let webSearchInfo = $state<string | null>(null);

  // Follow the global flag if it changes while Settings is mounted —
  // a late-arriving refreshSettings() in Chat.svelte shouldn't leave
  // the checkbox stale.
  $effect(() => {
    webSearchEnabled = app.webSearchEnabled;
  });

  async function onToggleWebSearch(): Promise<void> {
    webSearchError = null;
    webSearchInfo = null;
    if (!app.supabase) {
      webSearchError = 'Not connected to Supabase yet.';
      return;
    }
    const next = !webSearchEnabled;
    webSearchEnabled = next;
    // Optimistic in-memory flip so any in-flight send reflects the new
    // choice. Supabase settles below; on failure we roll back both.
    setWebSearchEnabled(next);
    try {
      await app.supabase.updateSettings({ webSearchEnabled: next });
      webSearchInfo = next
        ? 'Web search enabled — the model can pull live citations when they help.'
        : 'Web search disabled.';
    } catch (err) {
      webSearchEnabled = !next;
      setWebSearchEnabled(!next);
      webSearchError = err instanceof Error ? err.message : String(err);
    }
  }

  // --- Appearance pane ---
  let colorMode = $state<ColorMode>(app.colorMode);
  let accent = $state<Accent>(app.accent);
  let appearanceError = $state<string | null>(null);
  let appearanceInfo = $state<string | null>(null);

  // Apply selection live as the user clicks — no Save button needed.
  async function onPickMode(next: ColorMode): Promise<void> {
    colorMode = next;
    setTheme(next, accent);
    await persistTheme();
  }
  async function onPickAccent(next: Accent): Promise<void> {
    accent = next;
    setTheme(colorMode, next);
    await persistTheme();
  }
  async function persistTheme(): Promise<void> {
    appearanceError = null;
    appearanceInfo = null;
    if (!app.supabase) {
      appearanceError = 'Not connected to Supabase — theme saved locally only.';
      return;
    }
    try {
      await app.supabase.updateSettings({ colorMode, accent });
      appearanceInfo = 'Saved.';
    } catch (err) {
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

  // Default range: rolling 30-day window. "Last month of usage" is the
  // mental model most users bring to a billing page.
  let usageStart = $state<string>(ymdDaysAgo(30));
  let usageEnd = $state<string>(todayYmd());
  let usageRows = $state<UsageRow[] | null>(null);
  let usageLoading = $state(false);
  let usageError = $state<string | null>(null);
  // True when fetchUsage bailed at the USAGE_MAX_PAGES cap. Surfaces as
  // a footer note so the user can narrow their range rather than
  // silently seeing only the top slice.
  let usageTruncated = $state(false);
  /**
   * Tracks whether the Usage pane has auto-fetched at least once in
   * this modal lifetime. The `$effect` below fires the first fetch
   * when the user lands on the pane — without this guard it would
   * refire every time `group` changes (including back to 'usage' after
   * visiting another pane), which means a click on the Refresh button
   * can feel redundant.
   */
  let usageAutoFetched = $state(false);

  $effect(() => {
    if (group === 'usage' && !usageAutoFetched && !usageLoading) {
      usageAutoFetched = true;
      void loadUsage();
    }
  });

  async function loadUsage(): Promise<void> {
    if (!app.venice) {
      usageError = 'Not connected to Venice yet.';
      return;
    }
    usageError = null;
    usageLoading = true;
    usageTruncated = false;
    try {
      // End-of-day upper bound: the date picker reads as "through this
      // whole day". Venice treats endDate as an exclusive cutoff, so
      // we pass the *next* midnight to include the picked day itself.
      const startIso = new Date(`${usageStart}T00:00:00Z`).toISOString();
      const endDay = new Date(`${usageEnd}T00:00:00Z`);
      endDay.setUTCDate(endDay.getUTCDate() + 1);
      const endIso = endDay.toISOString();
      const rows = await app.venice.fetchUsage({
        startDate: startIso,
        endDate: endIso,
      });
      usageRows = rows;
      // Best-effort cap detection: if the response came back exactly at
      // the page × per-page ceiling, we almost certainly hit the safety
      // limit. Not perfect (a user with exactly 10k rows would also
      // trip it) but close enough for a "your data may be truncated"
      // hint — never shown when we're confidently under the cap.
      usageTruncated = rows.length >= USAGE_MAX_PAGES * 500;
    } catch (err) {
      usageError =
        err instanceof VeniceError
          ? err.message
          : err instanceof Error
            ? err.message
            : String(err);
      usageRows = null;
    } finally {
      usageLoading = false;
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

  const tokenFormatter = new Intl.NumberFormat(undefined, {
    notation: 'compact',
    maximumFractionDigits: 1,
  });
  function formatTokens(n: number): string {
    if (n === 0) return '—';
    return tokenFormatter.format(n);
  }

  function formatAmount(amount: number, currency: UsageCurrency): string {
    if (currency === 'USD') return `$${amount.toFixed(2)}`;
    // VCU / DIEM / BUNDLED_CREDITS — numeric with a suffix code. Two
    // decimals is plenty for credit-style units.
    return `${amount.toFixed(2)} ${currency}`;
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
  let pwCurrent = $state('');
  let pwNew = $state('');
  let pwError = $state<string | null>(null);
  let pwInfo = $state<string | null>(null);

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

  // Picking a radio applies the choice immediately — no Save button.
  // Optimistic in-memory flip (same pattern as onToggleWebSearch) so the
  // radio reflects the new tier right away; on persistence failure we
  // roll the UI and the global flag back to the previous value.
  async function onPickModel(next: ModelTier): Promise<void> {
    modelError = null;
    modelInfo = null;
    if (!app.supabase) {
      modelError = 'Not connected to Supabase yet.';
      return;
    }
    const prev = defaultModel;
    defaultModel = next;
    setDefaultModel(next);
    try {
      await app.supabase.updateSettings({ defaultModel: next });
      modelInfo = `Default model set to ${MODELS[next].label}.`;
    } catch (err) {
      defaultModel = prev;
      setDefaultModel(prev);
      modelError = err instanceof Error ? err.message : String(err);
    }
  }

  // Same optimistic-then-persist pattern as onPickModel, for the
  // reasoning-effort select. They share modelError/modelInfo so the
  // most recent action is what the user sees.
  async function onPickReasoning(next: ReasoningEffort): Promise<void> {
    modelError = null;
    modelInfo = null;
    if (!app.supabase) {
      modelError = 'Not connected to Supabase yet.';
      return;
    }
    const prev = defaultReasoningEffort;
    defaultReasoningEffort = next;
    setDefaultReasoningEffort(next);
    try {
      await app.supabase.updateSettings({ defaultReasoningEffort: next });
      modelInfo = `Default reasoning effort set to ${REASONING_EFFORT_LABELS[next].toLowerCase()}.`;
    } catch (err) {
      defaultReasoningEffort = prev;
      setDefaultReasoningEffort(prev);
      modelError = err instanceof Error ? err.message : String(err);
    }
  }

  async function onPickVerbosity(next: Verbosity): Promise<void> {
    modelError = null;
    modelInfo = null;
    if (!app.supabase) {
      modelError = 'Not connected to Supabase yet.';
      return;
    }
    const prev = defaultVerbosity;
    defaultVerbosity = next;
    setDefaultVerbosity(next);
    try {
      await app.supabase.updateSettings({ defaultVerbosity: next });
      modelInfo = `Default verbosity set to ${VERBOSITY_LABELS[next].toLowerCase()}.`;
    } catch (err) {
      defaultVerbosity = prev;
      setDefaultVerbosity(prev);
      modelError = err instanceof Error ? err.message : String(err);
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
    busy = true;
    try {
      await changePassword(pwCurrent, pwNew);
      pwInfo = 'Master password changed.';
      pwCurrent = '';
      pwNew = '';
    } catch (err) {
      pwError = err instanceof Error ? err.message : String(err);
    } finally {
      busy = false;
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
      {:else if group === 'ai'}
        <!-- AI-adjacent settings share one pane so the sidebar doesn't
             fan out into a dedicated tab per toggle. All subsections
             autosave — picking a model or reasoning tier flips through
             on change, prompts debounce-save on edit, and the
             web-search checkbox writes on toggle — so the whole pane
             matches the Appearance pane's "touch it and it sticks"
             behavior. -->
        <h2>AI</h2>
        <p class="subtle">Default model, system prompts, and web search.</p>

        <h3 class="pane-section">Default model</h3>
        <p class="subtle">
          Used for any thread that doesn't have its own model set. You can override
          per-thread from the chat top bar.
        </p>
        <div class="form-row model-choices">
          {#each TIERS as tier (tier)}
            <label class="model-choice">
              <input
                type="radio"
                name="default-model"
                value={tier}
                checked={defaultModel === tier}
                onchange={() => onPickModel(tier)}
              />
              <span>
                <strong>{MODELS[tier].label}</strong>
                <span class="subtle" style="margin-left:0.35rem">{MODELS[tier].description}</span>
                <span class="subtle" style="display:block;font-size:0.8rem;margin-top:0.1rem">
                  {MODELS[tier].id} · {(MODELS[tier].contextWindow / 1000).toFixed(0)}k context
                </span>
              </span>
            </label>
          {/each}
        </div>
        <p class="subtle" style="font-size:0.8rem">
          Stored on your Supabase profile so the choice follows you across browsers.
        </p>

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
        {#if modelError}<p class="error">{modelError}</p>{/if}
        {#if modelInfo}<p class="subtle">{modelInfo}</p>{/if}

        <h3 class="pane-section">Web search</h3>
        <p class="subtle">
          Venice grounds every answer with live web results plus inline
          source citations. Enabled by default — each request goes out
          with <code>enable_web_search=on</code> and
          <code>enable_web_citations=true</code>. Toggle off to send
          <code>enable_web_search=off</code> on every request instead.
        </p>
        <label class="form-row toggle-row">
          <input
            type="checkbox"
            checked={webSearchEnabled}
            onchange={onToggleWebSearch}
          />
          <span>Enabled</span>
        </label>
        <p class="subtle" style="font-size:0.8rem">
          Stored on your Supabase profile so the choice follows you across
          browsers.
        </p>
        {#if webSearchError}<p class="error">{webSearchError}</p>{/if}
        {#if webSearchInfo}<p class="subtle">{webSearchInfo}</p>{/if}

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
                  class="prompt-name"
                  value={p.name}
                  placeholder="Name"
                  oninput={(e) => updatePrompt(p.id, { name: (e.currentTarget as HTMLInputElement).value })}
                />
                <label class="prompt-default">
                  <input
                    type="checkbox"
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
                class="prompt-body"
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

        <h3 class="pane-section">Memories</h3>
        <p class="subtle">
          Nak builds up long-term notes about you as you chat — facts,
          preferences, coaching notes the model writes to its future
          self. Open the Memories browser to search, edit, or delete any
          of them. Also reachable from the book icon in the drawer
          footer.
        </p>
        {#if onOpenMemories}
          <button type="button" class="secondary" onclick={onOpenMemories}>
            Browse memories
          </button>
        {/if}
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

        {#if appearanceError}<p class="error">{appearanceError}</p>{/if}
        {#if appearanceInfo}<p class="subtle">{appearanceInfo}</p>{/if}
      {:else if group === 'usage'}
        <!--
          Usage pane: a date-ranged snapshot of the Venice billing
          ledger for this API key. Hits Venice's beta
          `/billing/usage` endpoint, aggregates by (sku, currency),
          and renders a bar chart scaled by total tokens with a spend
          pill per row. The pane auto-loads on first visit (see the
          `$effect` gate above); the Refresh button re-runs the fetch
          with the current date range.
        -->
        <h2>Usage</h2>
        <p class="subtle">
          Token spend against your Venice API key. Pulled live from
          Venice's billing ledger each time you open this pane or
          hit refresh — the numbers below are what Venice reports,
          not a Nak-side tally. Bars are scaled by
          prompt + completion tokens; the pill on the right is the
          raw billed amount in whatever currency each charge was
          denominated in.
        </p>
        <div class="usage-controls">
          <label class="usage-date">
            <span>From</span>
            <input
              type="date"
              bind:value={usageStart}
              max={usageEnd}
            />
          </label>
          <label class="usage-date">
            <span>To</span>
            <input
              type="date"
              bind:value={usageEnd}
              min={usageStart}
              max={todayYmd()}
            />
          </label>
          <button
            type="button"
            onclick={loadUsage}
            disabled={usageLoading}
          >
            {usageLoading ? 'Loading…' : 'Refresh'}
          </button>
        </div>
        {#if usageError}<p class="error">{usageError}</p>{/if}
        {#if usageRows !== null && !usageError}
          {@const buckets = aggregateUsage(usageRows)}
          {@const maxTokens = buckets.reduce((m, b) => Math.max(m, b.tokens), 0)}
          {@const totalTokens = buckets.reduce((s, b) => s + b.tokens, 0)}
          <!--
            Totals strip. We sum tokens unconditionally (a scalar
            regardless of currency) but defer spend to per-row
            formatting — a mixed-currency account can't sensibly be
            collapsed to a single pill.
          -->
          <p class="subtle usage-totals">
            {#if buckets.length === 0}
              No usage in this range.
            {:else}
              <strong>{formatTokens(totalTokens)}</strong> tokens across
              <strong>{buckets.length}</strong>
              {buckets.length === 1 ? 'model' : 'models'}.
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
                  <span class="usage-pill" role="cell">{formatAmount(b.amount, b.currency)}</span>
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
      {:else if group === 'export'}
        <h2>Export</h2>
        <p class="subtle">
          Download your Supabase and Venice credentials as a JSON file so you
          can reimport them when setting up Nak on another browser. This is a
          local-only feature — the file is generated in your browser and
          never uploaded.
        </p>
        <p class="subtle" style="color:var(--warn);font-size:0.85rem">
          ⚠ The exported file contains your API keys in plaintext. Store it
          with the same care as any other secret (e.g. your password
          manager). Deleting it afterward is a fine choice.
        </p>
        <p class="subtle" style="font-size:0.85rem">
          Import happens on the Setup screen of a fresh install — the
          "Import from JSON" button pre-fills the credentials for you.
        </p>
        <button type="button" onclick={onExportConfig}>Export config as JSON</button>
        {#if exportError}<p class="error">{exportError}</p>{/if}
        {#if exportInfo}<p class="subtle">{exportInfo}</p>{/if}
      {:else if group === 'security'}
        <h2>Change master password</h2>
        <p class="subtle">
          Rotate the passphrase that unlocks your encrypted config blob.
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
          {#if pwError}<p class="error">{pwError}</p>{/if}
          {#if pwInfo}<p class="subtle">{pwInfo}</p>{/if}
          <button type="submit" disabled={busy}>Change password</button>
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
        <p class="subtle" style="font-size:0.8rem">
          "Check for updates" asks the service worker to look for a
          fresh deploy without reloading. If one's found the button
          flips to "Reload to update" and the top-right banner
          appears.
        </p>
      {/if}
    </section>
  </div>
</div>
