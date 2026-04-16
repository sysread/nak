<script lang="ts">
  import { saveConfig, type AppConfig } from '$lib/config';
  import { activate } from '$lib/state.svelte';

  let supabaseUrl = $state('');
  let supabaseAnonKey = $state('');
  let veniceApiKey = $state('');
  let password = $state('');
  let confirmPassword = $state('');
  let error = $state<string | null>(null);
  let busy = $state(false);

  async function onSubmit(e: SubmitEvent): Promise<void> {
    e.preventDefault();
    error = null;
    if (password.length < 8) {
      error = 'Master password must be at least 8 characters.';
      return;
    }
    if (password !== confirmPassword) {
      error = 'Passwords do not match.';
      return;
    }
    const config: AppConfig = {
      supabaseUrl: supabaseUrl.trim(),
      supabaseAnonKey: supabaseAnonKey.trim(),
      veniceApiKey: veniceApiKey.trim(),
    };
    busy = true;
    try {
      await saveConfig(config, password);
      activate(config);
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    } finally {
      busy = false;
    }
  }
</script>

<div class="center">
  <form class="card" onsubmit={onSubmit}>
    <h1>Initial setup</h1>
    <p class="subtle">
      Paste your Supabase and Venice credentials. They will be encrypted with your master
      password and stored only in this browser's localStorage.
    </p>
    <div class="form-row">
      <label for="supabase-url">Supabase URL</label>
      <input id="supabase-url" type="url" bind:value={supabaseUrl}
             placeholder="https://your-project.supabase.co" required />
    </div>
    <div class="form-row">
      <label for="supabase-anon">Supabase anon key</label>
      <input id="supabase-anon" type="password" bind:value={supabaseAnonKey} required />
    </div>
    <div class="form-row">
      <label for="venice-key">Venice API key</label>
      <input id="venice-key" type="password" bind:value={veniceApiKey} required />
    </div>
    <div class="form-row">
      <label for="password">Master password</label>
      <input id="password" type="password" bind:value={password} required minlength="8" />
    </div>
    <div class="form-row">
      <label for="password-confirm">Confirm master password</label>
      <input id="password-confirm" type="password" bind:value={confirmPassword} required />
    </div>
    {#if error}<p class="error">{error}</p>{/if}
    <button type="submit" disabled={busy}>
      {busy ? 'Encrypting…' : 'Save and continue'}
    </button>
  </form>
</div>
