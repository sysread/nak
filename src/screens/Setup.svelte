<script lang="ts">
  /*
   * Initial-setup screen. Shown when there's no encrypted config in
   * localStorage (first visit, or after Reset). Collects the three API
   * keys plus a fresh master password, writes the encrypted blob, and
   * activates into the unlocked phase.
   *
   * Three entry paths into this screen:
   *   1. Clean first visit — empty form.
   *   2. `#setup=<base64>` fragment left by `mise run setup`. We decode
   *      it in onMount, strip the fragment from the address bar (so a
   *      later refresh or accidental share doesn't re-leak the keys),
   *      and prefill the form.
   *   3. Import from JSON — user picks a previously-exported config
   *      file. See parseExportedConfig in $lib/config.
   *
   * The master password never reaches the network — it's the PBKDF2
   * input for the local envelope crypto in $lib/crypto.
   */
  import { onMount } from 'svelte';
  import { saveConfig, parseExportedConfig, type AppConfig } from '$lib/config';
  import { activate } from '$lib/state.svelte';
  import SecretInput from '../components/SecretInput.svelte';

  let supabaseUrl = $state('');
  let supabasePublishableKey = $state('');
  let veniceApiKey = $state('');
  let password = $state('');
  let confirmPassword = $state('');
  let error = $state<string | null>(null);
  let busy = $state(false);
  let prefilled = $state(false);
  let importInfo = $state<string | null>(null);
  let fileEl: HTMLInputElement | undefined = $state();

  /**
   * If the URL carries `#setup=<base64>`, decode and pre-fill. The fragment
   * is produced by `mise run setup` and never traverses the network.
   */
  onMount(() => {
    const hash = location.hash;
    if (!hash.startsWith('#setup=')) return;
    try {
      const raw = hash.slice('#setup='.length);
      // Support both base64url and standard base64.
      const normalized = raw.replace(/-/g, '+').replace(/_/g, '/');
      const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4);
      const json = atob(padded);
      const obj = JSON.parse(json);
      if (typeof obj.supabaseUrl === 'string') supabaseUrl = obj.supabaseUrl;
      // Accept the legacy `supabaseAnonKey` from setup links generated before
      // the publishable-key rename.
      const pub = obj.supabasePublishableKey ?? obj.supabaseAnonKey;
      if (typeof pub === 'string') supabasePublishableKey = pub;
      if (typeof obj.veniceApiKey === 'string') veniceApiKey = obj.veniceApiKey;
      prefilled = true;
    } catch {
      // Ignore malformed hash — user will just fill in manually.
    } finally {
      // Strip the fragment from the address bar + history so a later refresh
      // or sharing the tab doesn't re-expose secrets.
      history.replaceState(null, '', location.pathname + location.search);
    }
  });

  async function onPickFile(e: Event): Promise<void> {
    error = null;
    importInfo = null;
    const input = e.target as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;
    try {
      const text = await file.text();
      const cfg = parseExportedConfig(text);
      supabaseUrl = cfg.supabaseUrl;
      supabasePublishableKey = cfg.supabasePublishableKey;
      veniceApiKey = cfg.veniceApiKey;
      prefilled = true;
      importInfo = `Imported from ${file.name}. Pick a master password below to continue.`;
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    } finally {
      // Reset the file input so the user can re-pick the same file if needed.
      input.value = '';
    }
  }

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
      supabasePublishableKey: supabasePublishableKey.trim(),
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
    {#if prefilled}
      <p class="subtle">
        Keys were pre-filled. Pick a master password to encrypt them locally,
        then continue.
      </p>
    {:else}
      <p class="subtle">
        Paste your Supabase and Venice credentials. They will be encrypted with your master
        password and stored only in this browser's localStorage.
      </p>
    {/if}

    <button
      type="button"
      class="secondary"
      style="width:100%;margin-bottom:0.9rem"
      onclick={() => fileEl?.click()}
    >Import from JSON…</button>
    <input
      type="file"
      accept="application/json,.json"
      bind:this={fileEl}
      onchange={onPickFile}
      style="display:none"
    />
    {#if importInfo}<p class="subtle">{importInfo}</p>{/if}

    <div class="form-row">
      <label for="supabase-url">Supabase URL</label>
      <input id="supabase-url" type="url" bind:value={supabaseUrl}
             placeholder="https://your-project.supabase.co" required />
    </div>
    <div class="form-row">
      <label for="supabase-publishable">Supabase publishable key</label>
      <SecretInput id="supabase-publishable" bind:value={supabasePublishableKey} required />
    </div>
    <div class="form-row">
      <label for="venice-key">Venice API key</label>
      <SecretInput id="venice-key" bind:value={veniceApiKey} required />
    </div>
    <div class="form-row">
      <label for="password">Master password</label>
      <SecretInput id="password" bind:value={password} required minlength={8}
                   autocomplete="new-password" />
    </div>
    <div class="form-row">
      <label for="password-confirm">Confirm master password</label>
      <SecretInput id="password-confirm" bind:value={confirmPassword} required
                   autocomplete="new-password" />
    </div>
    {#if error}<p class="error">{error}</p>{/if}
    <button type="submit" disabled={busy}>
      {busy ? 'Encrypting…' : 'Save and continue'}
    </button>
  </form>
</div>
