<script lang="ts">
  import { loadConfig, clearStoredConfig } from '$lib/config';
  import { activate, app } from '$lib/state.svelte';

  import { tick } from 'svelte';

  let password = $state('');
  let error = $state<string | null>(null);
  let busy = $state(false);
  let passwordEl: HTMLInputElement | undefined = $state();

  $effect(() => {
    void tick().then(() => passwordEl?.focus());
  });

  async function onSubmit(e: SubmitEvent): Promise<void> {
    e.preventDefault();
    error = null;
    busy = true;
    try {
      const config = await loadConfig(password);
      if (!config) {
        app.phase = 'setup';
        return;
      }
      activate(config);
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    } finally {
      busy = false;
      password = '';
    }
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
      <button type="button" class="secondary" onclick={onReset}>Reset</button>
    </div>
  </form>
</div>
