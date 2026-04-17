<script lang="ts">
  /*
   * Unlock screen. Shown when we have an encrypted config in
   * localStorage but no active session. Takes the master password,
   * runs it through PBKDF2 via $lib/crypto, and either activates the
   * app or branches to EditConfig (so a user with a mistyped key can
   * fix it without starting over).
   *
   * The third "Reset" button nukes the encrypted blob and routes back
   * to Setup — an escape hatch when the user has forgotten their
   * master password. There's no recovery path: without the password
   * the blob is cryptographically useless, and the three keys inside
   * it can always be re-obtained from their respective services.
   */
  import { loadConfig, clearStoredConfig } from '$lib/config';
  import { activate, enterEditConfig, app } from '$lib/state.svelte';

  import { tick } from 'svelte';

  type Intent = 'unlock' | 'edit';

  let password = $state('');
  let error = $state<string | null>(null);
  let busy = $state(false);
  let passwordEl: HTMLInputElement | undefined = $state();

  $effect(() => {
    void tick().then(() => passwordEl?.focus());
  });

  async function submit(intent: Intent): Promise<void> {
    error = null;
    busy = true;
    try {
      const config = await loadConfig(password);
      if (!config) {
        app.phase = 'setup';
        return;
      }
      if (intent === 'edit') {
        enterEditConfig(config);
      } else {
        activate(config);
      }
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    } finally {
      busy = false;
      password = '';
    }
  }

  async function onSubmit(e: SubmitEvent): Promise<void> {
    e.preventDefault();
    await submit('unlock');
  }

  async function onEdit(): Promise<void> {
    if (!password) {
      error = 'Enter your master password to decrypt before editing.';
      return;
    }
    await submit('edit');
  }

  function onReset(): void {
    const ok = confirm(
      'This will erase the encrypted config stored in this browser. ' +
      'You will need to re-enter your Supabase and Venice keys. Continue?'
    );
    if (!ok) return;
    clearStoredConfig();
    app.phase = 'setup';
  }
</script>

<div class="center">
  <form class="card" onsubmit={onSubmit}>
    <h1>Unlock</h1>
    <p class="subtle">Enter your master password to decrypt your configuration.</p>
    <div class="form-row">
      <label for="password">Master password</label>
      <input id="password" type="password" bind:value={password} required
             bind:this={passwordEl} />
    </div>
    {#if error}<p class="error">{error}</p>{/if}
    <div class="row">
      <button type="submit" class="grow" disabled={busy}>
        {busy ? 'Unlocking…' : 'Unlock'}
      </button>
      <button type="button" class="secondary" onclick={onEdit} disabled={busy}>
        Edit keys
      </button>
    </div>
    <button type="button" class="secondary"
            style="width:100%;margin-top:0.5rem" onclick={onReset}>
      Reset (erase config)
    </button>
    <p class="subtle" style="font-size:0.78rem;margin-top:0.7rem">
      Mistyped a key? Type your master password and hit <strong>Edit keys</strong>
      to fix values without starting over.
    </p>
  </form>
</div>
