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
    | 'export'
    | 'security';
  const GROUPS: { id: Group; label: string }[] = [
    { id: 'keys', label: 'API keys' },
    { id: 'ai', label: 'AI' },
    { id: 'appearance', label: 'Appearance' },
    { id: 'export', label: 'Export' },
    { id: 'security', label: 'Security' },
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

  // --- Security pane ---
  let pwCurrent = $state('');
  let pwNew = $state('');
  let pwError = $state<string | null>(null);
  let pwInfo = $state<string | null>(null);

  let busy = $state(false);

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
        <label class="form-row" style="display:flex;gap:0.5rem;align-items:center">
          <input
            type="checkbox"
            checked={webSearchEnabled}
            onchange={onToggleWebSearch}
          />
          <span><strong>Enable Venice web search</strong></span>
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
      {/if}
    </section>
  </div>
</div>
