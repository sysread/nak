<script lang="ts">
  import { app } from '$lib/state.svelte';

  let email = $state('');
  let password = $state('');
  let mode = $state<'sign-in' | 'sign-up'>('sign-in');
  let error = $state<string | null>(null);
  let busy = $state(false);
  let info = $state<string | null>(null);

  async function onSubmit(e: SubmitEvent): Promise<void> {
    e.preventDefault();
    if (!app.supabase) return;
    error = null;
    info = null;
    busy = true;
    try {
      if (mode === 'sign-in') {
        await app.supabase.signIn(email, password);
      } else {
        const session = await app.supabase.signUp(email, password);
        if (!session) info = 'Check your email to confirm your account, then sign in.';
      }
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    } finally {
      busy = false;
    }
  }
</script>

<div class="center">
  <form class="card" onsubmit={onSubmit}>
    <h1>{mode === 'sign-in' ? 'Sign in' : 'Create account'}</h1>
    <p class="subtle">
      Authenticate against your Supabase project. This is separate from your master
      password, which only unlocks local config.
    </p>
    <div class="form-row">
      <label for="email">Email</label>
      <input id="email" type="email" bind:value={email} required />
    </div>
    <div class="form-row">
      <label for="password">Password</label>
      <input id="password" type="password" bind:value={password} required minlength="6" />
    </div>
    {#if error}<p class="error">{error}</p>{/if}
    {#if info}<p class="subtle">{info}</p>{/if}
    <button type="submit" disabled={busy}>
      {busy ? 'Working…' : mode === 'sign-in' ? 'Sign in' : 'Sign up'}
    </button>
    <button type="button" class="secondary" style="margin-top:0.5rem;width:100%"
            onclick={() => (mode = mode === 'sign-in' ? 'sign-up' : 'sign-in')}>
      {mode === 'sign-in' ? 'Need an account? Sign up.' : 'Have an account? Sign in.'}
    </button>
  </form>
</div>
