<script lang="ts">
  import { changePassword, saveConfig } from '$lib/config';
  import { app, activate } from '$lib/state.svelte';

  interface Props {
    onClose: () => void;
  }
  let { onClose }: Props = $props();

  let supabaseUrl = $state(app.config?.supabaseUrl ?? '');
  let supabaseAnonKey = $state(app.config?.supabaseAnonKey ?? '');
  let veniceApiKey = $state(app.config?.veniceApiKey ?? '');
  let currentPassword = $state('');
  let newPassword = $state('');
  let keysError = $state<string | null>(null);
  let pwError = $state<string | null>(null);
  let keysInfo = $state<string | null>(null);
  let pwInfo = $state<string | null>(null);
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
