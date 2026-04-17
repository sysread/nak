<script lang="ts">
  import { changePassword, saveConfig } from '$lib/config';
  import { app, activate } from '$lib/state.svelte';
  import { MODELS, TIERS, DEFAULT_TIER, type ModelTier } from '$lib/models';

  interface Props {
    onClose: () => void;
  }
  let { onClose }: Props = $props();

  type Group = 'keys' | 'model' | 'security';
  const GROUPS: { id: Group; label: string }[] = [
    { id: 'keys', label: 'API keys' },
    { id: 'model', label: 'Model' },
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
  let defaultModel = $state<ModelTier>(app.config?.defaultModel ?? DEFAULT_TIER);
  let modelPassword = $state('');
  let modelError = $state<string | null>(null);
  let modelInfo = $state<string | null>(null);

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
        defaultModel: app.config?.defaultModel,
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
    if (!modelPassword) {
      modelError = 'Enter your current master password to re-encrypt.';
      return;
    }
    if (!app.config) {
      modelError = 'No active config — please unlock first.';
      return;
    }
    busy = true;
    try {
      const config = { ...app.config, defaultModel };
      await saveConfig(config, modelPassword);
      activate(config);
      modelInfo = `Default model set to ${MODELS[defaultModel].label}.`;
      modelPassword = '';
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
            <input id="sa" type="password" bind:value={supabaseAnonKey} required />
          </div>
          <div class="form-row">
            <label for="vk">Venice API key</label>
            <input id="vk" type="password" bind:value={veniceApiKey} required />
          </div>
          <div class="form-row">
            <label for="cp">Current master password</label>
            <input id="cp" type="password" bind:value={keysPassword} required />
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
          <div class="form-row">
            <label for="mp">Current master password</label>
            <input id="mp" type="password" bind:value={modelPassword} required />
          </div>
          {#if modelError}<p class="error">{modelError}</p>{/if}
          {#if modelInfo}<p class="subtle">{modelInfo}</p>{/if}
          <button type="submit" disabled={busy}>Save default model</button>
        </form>
      {:else if group === 'security'}
        <h2>Change master password</h2>
        <p class="subtle">
          Rotate the passphrase that unlocks your encrypted config blob.
        </p>
        <form onsubmit={onChangePassword}>
          <div class="form-row">
            <label for="pw-current">Current master password</label>
            <input id="pw-current" type="password" bind:value={pwCurrent} required />
          </div>
          <div class="form-row">
            <label for="pw-new">New master password</label>
            <input id="pw-new" type="password" bind:value={pwNew} minlength="8" required />
          </div>
          {#if pwError}<p class="error">{pwError}</p>{/if}
          {#if pwInfo}<p class="subtle">{pwInfo}</p>{/if}
          <button type="submit" disabled={busy}>Change password</button>
        </form>
      {/if}
    </section>
  </div>
</div>
