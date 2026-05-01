<script lang="ts">
  /*
   * "Edit keys before unlocking" screen. Reached from Unlock via the
   * Edit keys button. Lets a user fix a mistyped API key (or rotate
   * one) without first having to authenticate to Supabase — which they
   * can't do if the stored URL / anon key is wrong.
   *
   * Pre-fill note: by the time we render here, Unlock has already
   * decrypted the config into `app.config`, so we read the three
   * fields from state rather than prompting for the master password
   * again. Saving does need the password as the KDF input — we don't
   * hold the password in memory, intentionally.
   */
  import { saveConfig, clearStoredConfig, type AppConfig } from '$lib/config';
  import { clearBiometric } from '$lib/biometric';
  import { activate, app } from '$lib/state.svelte';
  import SecretInput from '../components/SecretInput.svelte';

  // The Unlock screen already decrypted the config into app.config before
  // routing here, so we can pre-fill the fields without asking for the
  // password again. Re-encrypting on save still needs the master password
  // (below) because that's the KDF input — we don't hold it in memory.
  let supabaseUrl = $state(app.config?.supabaseUrl ?? '');
  let supabaseAnonKey = $state(app.config?.supabaseAnonKey ?? '');
  let veniceApiKey = $state(app.config?.veniceApiKey ?? '');
  let password = $state('');
  let error = $state<string | null>(null);
  let busy = $state(false);

  async function onSubmit(e: SubmitEvent): Promise<void> {
    e.preventDefault();
    error = null;
    if (!password) {
      error = 'Enter your master password to re-encrypt.';
      return;
    }
    busy = true;
    try {
      const next: AppConfig = {
        supabaseUrl: supabaseUrl.trim(),
        supabaseAnonKey: supabaseAnonKey.trim(),
        veniceApiKey: veniceApiKey.trim(),
      };
      await saveConfig(next, password);
      activate(next);
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    } finally {
      busy = false;
    }
  }

  function onReset(): void {
    const ok = confirm(
      'Erase the encrypted config and start over from scratch? You will need to re-enter everything.'
    );
    if (!ok) return;
    clearStoredConfig();
    // Wrapped biometric password is meaningless once the config it
    // protects is gone. Clear both together.
    clearBiometric();
    app.phase = 'setup';
  }
</script>

<div class="center">
  <form class="card" onsubmit={onSubmit}>
    <h1>Edit credentials</h1>
    <p class="subtle">
      Fix a mistyped key without reinstalling. Re-encrypting uses your
      existing master password.
    </p>

    <div class="form-row">
      <label for="su">Supabase URL</label>
      <input id="su" type="url" bind:value={supabaseUrl} required
             placeholder="https://your-project.supabase.co" />
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
      <label for="pw">Master password</label>
      <SecretInput id="pw" bind:value={password} required
                   autocomplete="current-password" />
    </div>

    {#if error}<p class="error">{error}</p>{/if}

    <div class="row">
      <button type="submit" class="grow" disabled={busy}>
        {busy ? 'Saving…' : 'Save and continue'}
      </button>
      <button type="button" class="secondary" onclick={() => (app.phase = 'locked')}>
        Cancel
      </button>
    </div>

    <button type="button" class="secondary danger"
            style="width:100%;margin-top:0.7rem" onclick={onReset}>
      Erase and start over
    </button>
  </form>
</div>
