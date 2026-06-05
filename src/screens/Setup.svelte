<script lang="ts">
  /*
   * Initial-setup screen. Collects the Supabase URL + publishable key
   * and writes them to localStorage as plaintext JSON. The values are
   * not secrets in the RLS-key sense - the publishable key is meant to
   * ship in client bundles, the URL is a project identifier, and the
   * Venice API key lives server-side in app_config.
   *
   * Four entry paths into this screen:
   *   1. Clean first visit - empty form.
   *   2. `#setup=<base64>` fragment left by `mise run setup`. We decode
   *      it in onMount, strip the fragment from the address bar (so a
   *      later refresh or accidental share doesn't re-leak the keys),
   *      and prefill the form.
   *   3. Import from JSON - user picks a previously-exported config
   *      file. See parseExportedConfig in $lib/config.
   *   4. Edit-from-Auth - the user pasted a wrong publishable key on
   *      first setup and is now stuck on the Auth screen with a 401
   *      from the REST gateway. The "Edit Supabase config" button on
   *      Auth.svelte calls enterSetup() in state.svelte.ts, which
   *      flips phase back here while leaving the stored config in
   *      place. We pre-fill from loadConfig() so the user only has
   *      to fix the wrong field.
   */
  import { onMount } from 'svelte';
  import {
    loadConfig,
    saveConfig,
    parseExportedConfig,
    type AppConfig,
  } from '$lib/config';
  import { activate } from '$lib/state.svelte';
  import SecretInput from '../components/SecretInput.svelte';

  let supabaseUrl = $state('');
  let supabasePublishableKey = $state('');
  let error = $state<string | null>(null);
  let busy = $state(false);
  let prefilled = $state(false);
  let importInfo = $state<string | null>(null);
  let fileEl: HTMLInputElement | undefined = $state();

  /**
   * Two pre-fill sources, in priority order:
   *
   *   1. `#setup=<base64>` URL fragment left by `mise run setup`.
   *      Decoded, stripped from the address bar (so a refresh or
   *      shared link doesn't re-leak the keys), and used to seed both
   *      fields. The `veniceApiKey` field on the setup-link payload
   *      is ignored: the Venice key lives server-side in app_config,
   *      so the link's leftover field has nothing to land in.
   *   2. Otherwise, fall back to whatever is already in
   *      `localStorage['nak:config:v2']`. This covers the edit-from-
   *      Auth path - `enterSetup()` flips the phase back here without
   *      clearing the stored config, and pre-fill lets the user
   *      correct a single mistyped field.
   */
  onMount(() => {
    const hash = location.hash;
    if (hash.startsWith('#setup=')) {
      try {
        const raw = hash.slice('#setup='.length);
        // Support both base64url and standard base64.
        const normalized = raw.replace(/-/g, '+').replace(/_/g, '/');
        const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4);
        const json = atob(padded);
        const obj = JSON.parse(json);
        if (typeof obj.supabaseUrl === 'string') supabaseUrl = obj.supabaseUrl;
        const pub = obj.supabasePublishableKey ?? obj.supabaseAnonKey;
        if (typeof pub === 'string') supabasePublishableKey = pub;
        prefilled = true;
      } catch {
        // Ignore malformed hash - user will just fill in manually.
      } finally {
        // Strip the fragment from the address bar + history so a later
        // refresh or sharing the tab doesn't re-expose the keys.
        history.replaceState(null, '', location.pathname + location.search);
      }
      return;
    }
    const stored = loadConfig();
    if (stored) {
      supabaseUrl = stored.supabaseUrl;
      supabasePublishableKey = stored.supabasePublishableKey;
      prefilled = true;
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
      prefilled = true;
      importInfo = `Imported from ${file.name}. Click Save and continue.`;
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    } finally {
      // Reset the file input so the user can re-pick the same file if needed.
      input.value = '';
    }
  }

  function onSubmit(e: SubmitEvent): void {
    e.preventDefault();
    error = null;
    const config: AppConfig = {
      supabaseUrl: supabaseUrl.trim(),
      supabasePublishableKey: supabasePublishableKey.trim(),
    };
    busy = true;
    try {
      saveConfig(config);
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
        Keys were pre-filled. Click Save and continue to start using Nak.
      </p>
    {:else}
      <p class="subtle">
        Paste your Supabase URL and publishable key. They are stored as
        plaintext JSON in this browser's localStorage - the publishable
        key is safe to ship in client bundles (see Supabase docs); the
        security boundary is the sign-in flow, not key secrecy.
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
    {#if error}<p class="error">{error}</p>{/if}
    <button type="submit" disabled={busy}>
      {busy ? 'Saving…' : 'Save and continue'}
    </button>
  </form>
</div>
