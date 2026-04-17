<script lang="ts">
  /*
   * Settings modal. Reached from the chat sidebar's gear icon. Five
   * panes, each with its own persistence target:
   *
   *   keys        — the three API keys. Re-encrypts + re-activates, so
   *                 requires the current master password.
   *   model       — default model tier. Writes through to Supabase
   *                 `profiles.settings.defaultModel` so the preference
   *                 follows the account across browsers.
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
  import { app, activate, setDefaultModel, setTheme } from '$lib/state.svelte';
  import { MODELS, TIERS, type ModelTier } from '$lib/models';
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
  }
  let { onClose }: Props = $props();

  type Group = 'keys' | 'model' | 'appearance' | 'export' | 'security';
  const GROUPS: { id: Group; label: string }[] = [
    { id: 'keys', label: 'API keys' },
    { id: 'model', label: 'Model' },
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
  let modelError = $state<string | null>(null);
  let modelInfo = $state<string | null>(null);

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

  async function onSaveModel(e: SubmitEvent): Promise<void> {
    e.preventDefault();
    modelError = null;
    modelInfo = null;
    if (!app.supabase) {
      modelError = 'Not connected to Supabase yet.';
      return;
    }
    busy = true;
    try {
      await app.supabase.updateSettings({ defaultModel });
      setDefaultModel(defaultModel);
      modelInfo = `Default model set to ${MODELS[defaultModel].label} (synced to Supabase).`;
    } catch (err) {
      modelError = err instanceof Error ? err.message : String(err);
    } finally {
      busy = false;
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

<div class="center">
  <div class="settings-shell">
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
      <button type="button" class="secondary" style="margin-top:auto" onclick={onClose}>
        Back
      </button>
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
            <SecretInput id="cp" bind:value={keysPassword} required />
          </div>
          {#if keysError}<p class="error">{keysError}</p>{/if}
          {#if keysInfo}<p class="subtle">{keysInfo}</p>{/if}
          <button type="submit" disabled={busy}>Save keys</button>
        </form>
      {:else if group === 'model'}
        <h2>Default AI model</h2>
        <p class="subtle">
          Used for any thread that doesn't have its own model set. You can override
          per-thread from the chat top bar.
        </p>
        <form onsubmit={onSaveModel}>
          <div class="form-row model-choices">
            {#each TIERS as tier (tier)}
              <label class="model-choice">
                <input
                  type="radio"
                  name="default-model"
                  value={tier}
                  checked={defaultModel === tier}
                  onchange={() => (defaultModel = tier)}
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
            No master password needed.
          </p>
          {#if modelError}<p class="error">{modelError}</p>{/if}
          {#if modelInfo}<p class="subtle">{modelInfo}</p>{/if}
          <button type="submit" disabled={busy}>Save default model</button>
        </form>
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
            <SecretInput id="pw-current" bind:value={pwCurrent} required />
          </div>
          <div class="form-row">
            <label for="pw-new">New master password</label>
            <SecretInput id="pw-new" bind:value={pwNew} minlength={8} required />
          </div>
          {#if pwError}<p class="error">{pwError}</p>{/if}
          {#if pwInfo}<p class="subtle">{pwInfo}</p>{/if}
          <button type="submit" disabled={busy}>Change password</button>
        </form>
      {/if}
    </section>
  </div>
</div>
