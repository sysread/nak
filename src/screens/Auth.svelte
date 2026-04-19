<script lang="ts">
  /*
   * Supabase auth screen — email + password sign-in and sign-up.
   * Distinct from the Unlock screen: Unlock gates the encrypted local
   * config blob; this screen gates access to the user's Supabase
   * project. A user always passes through Unlock first (or auto-unlock
   * via sessionStorage), then sees this form only if Supabase doesn't
   * already have a live session for them.
   *
   * Sign-up is conditional on the Supabase project's auth settings.
   * When `mise run setup` disabled public sign-ups (the default), the
   * signUp call comes back with a server-side error — which we just
   * render as the error message. The form still shows the toggle; we
   * don't try to probe whether sign-ups are allowed client-side.
   */
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
      <input id="email" type="email" bind:value={email} required
             autocomplete="email" />
    </div>
    <div class="form-row">
      <label for="password">Password</label>
      <!--
        Mode-dependent autocomplete. "current-password" lets password managers
        offer saved credentials on sign-in; "new-password" tells them to offer
        to save the freshly-entered one on sign-up. A single fixed value would
        either suppress autofill on sign-in or spam the save prompt on sign-up.
      -->
      <input id="password" type="password" bind:value={password} required minlength="6"
             autocomplete={mode === 'sign-in' ? 'current-password' : 'new-password'} />
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
