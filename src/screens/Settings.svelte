<script lang="ts">
  import { changePassword, saveConfig } from '$lib/config';
  import { app, activate } from '$lib/state.svelte';
  import { MODELS, TIERS, DEFAULT_TIER, type ModelTier } from '$lib/models';

  interface Props {
    onClose: () => void;
  }
  let { onClose }: Props = $props();

  let supabaseUrl = $state(app.config?.supabaseUrl ?? '');
  let supabaseAnonKey = $state(app.config?.supabaseAnonKey ?? '');
  let veniceApiKey = $state(app.config?.veniceApiKey ?? '');
  let defaultModel = $state<ModelTier>(app.config?.defaultModel ?? DEFAULT_TIER);
  let currentPassword = $state('');
  let newPassword = $state('');
  let keysError = $state<string | null>(null);
  let pwError = $state<string | null>(null);
  let modelError = $state<string | null>(null);
  let keysInfo = $state<string | null>(null);
  let pwInfo = $state<string | null>(null);
  let modelInfo = $state<string | null>(null);
  let modelPassword = $state('');
  let busy = $state(false);

  async function onSaveKeys(e: SubmitEvent): Promise<void> {
    e.preventDefault();
    keysError = null;
    keysInfo = null;
    if (!currentPassword) {
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
      await saveConfig(config, currentPassword);
      activate(config);
      keysInfo = 'Keys updated.';
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
    if (newPassword.length < 8) {
      pwError = 'New password must be at least 8 characters.';
      return;
    }
    busy = true;
    try {
      await changePassword(currentPassword, newPassword);
      pwInfo = 'Master password changed.';
      currentPassword = '';
      newPassword = '';
    } catch (err) {
      pwError = err instanceof Error ? err.message : String(err);
    } finally {
      busy = false;
    }
  }
</script>

<div class="center">
  <div class="card">
    <h1>Settings</h1>
    <p class="subtle">
      Update your API keys or rotate your master password. Both operations require
      your current master password.
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
        <input id="cp" type="password" bind:value={currentPassword} required />
      </div>
      {#if keysError}<p class="error">{keysError}</p>{/if}
      {#if keysInfo}<p class="subtle">{keysInfo}</p>{/if}
      <button type="submit" disabled={busy}>Save keys</button>
    </form>

    <hr style="border:0;border-top:1px solid var(--border);margin:1.25rem 0" />

    <form onsubmit={onSaveModel}>
      <h1 style="font-size:1.05rem">Default AI model</h1>
      <p class="subtle">
        Used for any thread that doesn't have its own model set. You can override
        per-thread from the chat top bar.
      </p>
      <div class="form-row">
        {#each TIERS as tier (tier)}
          <label style="display:flex;align-items:flex-start;gap:0.5rem;margin-bottom:0.35rem;cursor:pointer">
            <input
              type="radio"
              name="default-model"
              value={tier}
              checked={defaultModel === tier}
              onchange={() => (defaultModel = tier)}
              style="margin-top:0.25rem;width:auto"
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

    <hr style="border:0;border-top:1px solid var(--border);margin:1.25rem 0" />

    <form onsubmit={onChangePassword}>
      <h1 style="font-size:1.05rem">Change master password</h1>
      <div class="form-row">
        <label for="np">New master password</label>
        <input id="np" type="password" bind:value={newPassword} minlength="8" required />
      </div>
      {#if pwError}<p class="error">{pwError}</p>{/if}
      {#if pwInfo}<p class="subtle">{pwInfo}</p>{/if}
      <button type="submit" disabled={busy}>Change password</button>
    </form>

    <div style="margin-top:1rem">
      <button type="button" class="secondary" onclick={onClose}>Back</button>
    </div>
  </div>
</div>
