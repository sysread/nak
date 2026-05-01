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
   *
   * Biometric unlock (when enrolled in Settings -> Security) takes
   * over the screen on mount: as soon as the platform support probe
   * settles, we fire `unlockWithBiometric()` automatically so the
   * user lands on the system biometric prompt without an extra tap.
   * On success the `loadConfig` -> `activate` flow runs exactly like
   * the typed-password path. On cancellation or failure we fall back
   * to the typed-password screen with focus on the password input;
   * the "Unlock with biometric" button stays visible so the user can
   * retry without refreshing. Biometric is always opt-in convenience,
   * never the only way in.
   */
  import { loadConfig, clearStoredConfig } from '$lib/config';
  import { activate, enterEditConfig, app } from '$lib/state.svelte';
  import {
    isBiometricSupported,
    isBiometricEnrolled,
    unlockWithBiometric,
    clearBiometric,
  } from '$lib/biometric';

  import { tick } from 'svelte';

  type Intent = 'unlock' | 'edit';

  let password = $state('');
  let error = $state<string | null>(null);
  let busy = $state(false);
  let passwordEl: HTMLInputElement | undefined = $state();

  // Biometric availability gate. `bioEnrolled` is read synchronously
  // from localStorage (so the button can render on first paint
  // without flashing in); `bioSupported` is the async platform probe
  // that confirms a user-verifying authenticator is actually present.
  // `bioSupportChecked` flips once the probe resolves either way -
  // the auto-trigger waits on it so we don't fall through to the
  // typed-password focus path before the probe has had a chance to
  // come back true.
  let bioEnrolled = $state(isBiometricEnrolled());
  let bioSupported = $state(false);
  let bioSupportChecked = $state(false);
  let bioBusy = $state(false);
  // Whether the auto-trigger arbiter below has fired its one-shot
  // decision (run biometric / focus password). Without this flag the
  // effect would re-fire on every state change - re-prompting the
  // user every time `bioBusy` flipped, which would be a UX disaster.
  let arbiterFired = $state(false);

  $effect(() => {
    void isBiometricSupported().then((ok) => {
      bioSupported = ok;
      bioSupportChecked = true;
    });
  });

  // One-shot arbiter on mount: decide whether to auto-trigger the
  // biometric prompt or just focus the password input. The branches:
  //
  //   - Not enrolled: focus password.
  //   - Enrolled but support probe still pending: wait (the effect
  //     re-runs when `bioSupportChecked` flips).
  //   - Enrolled but unsupported (PRF browser, fresh device): focus
  //     password. The button won't render either, but the support
  //     check carries the load.
  //   - Enrolled + supported: fire `onBiometric()` immediately;
  //     focus password once the prompt resolves so a cancellation
  //     lands the user on the typed input without an extra tap.
  $effect(() => {
    if (arbiterFired) return;
    if (!bioEnrolled) {
      arbiterFired = true;
      void tick().then(() => passwordEl?.focus());
      return;
    }
    if (!bioSupportChecked) return;
    if (!bioSupported) {
      arbiterFired = true;
      void tick().then(() => passwordEl?.focus());
      return;
    }
    arbiterFired = true;
    void onBiometric().finally(() => {
      void tick().then(() => passwordEl?.focus());
    });
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

  async function onBiometric(): Promise<void> {
    error = null;
    bioBusy = true;
    try {
      const recovered = await unlockWithBiometric();
      const config = await loadConfig(recovered);
      if (!config) {
        // Stored config was cleared out from under the biometric
        // enrollment - probably via Reset on another tab. Drop both
        // and route to Setup so the user re-enters their keys.
        clearBiometric();
        bioEnrolled = false;
        app.phase = 'setup';
        return;
      }
      activate(config);
    } catch (err) {
      // WebAuthn maps user-cancel, dismissal, and timeout all to
      // NotAllowedError. The user explicitly opted out of biometric
      // (or just walked away); surfacing a red error message in that
      // case reads as "the app yelled at me for closing a prompt I
      // never asked to see." Stay quiet and let the typed-password
      // screen do its job.
      const isCancel =
        err instanceof DOMException && err.name === 'NotAllowedError';
      if (!isCancel) {
        error = err instanceof Error ? err.message : String(err);
      }
      // Re-read enrollment state - `unlockWithBiometric` self-clears
      // if the wrapped blob became undecryptable, and we want the
      // button to disappear on the next render rather than offer a
      // dead path.
      bioEnrolled = isBiometricEnrolled();
    } finally {
      bioBusy = false;
    }
  }

  function onReset(): void {
    const ok = confirm(
      'This will erase the encrypted config stored in this browser. ' +
      'You will need to re-enter your Supabase and Venice keys. Continue?'
    );
    if (!ok) return;
    clearStoredConfig();
    // The wrapped biometric password is meaningless once the config
    // it protects is gone. Wipe both together.
    clearBiometric();
    bioEnrolled = false;
    app.phase = 'setup';
  }
</script>

<div class="center">
  <form class="card" onsubmit={onSubmit}>
    <h1>Unlock</h1>
    <p class="subtle">Enter your master password to decrypt your configuration.</p>
    {#if bioEnrolled && bioSupported}
      <button type="button" class="biometric" onclick={onBiometric} disabled={bioBusy || busy}>
        {bioBusy ? 'Waiting for biometric…' : 'Unlock with biometric'}
      </button>
      <p class="subtle" style="font-size:0.78rem;text-align:center;margin:0.4rem 0 0.8rem">
        or enter your master password below
      </p>
    {/if}
    <div class="form-row">
      <label for="password">Master password</label>
      <!--
        "current-password" so an OS/browser password manager that has saved
        the master password can offer to fill it. This blob can only be
        decrypted with the user's own password, so there's nothing to lose
        by letting a local vault remember it.
      -->
      <input id="password" type="password" bind:value={password} required
             bind:this={passwordEl} autocomplete="current-password" />
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

<style>
  /*
   * The biometric button is the primary affordance on phones where
   * the user expects to tap a fingerprint icon, not type a long
   * password. Sized to span the form so it reads as the recommended
   * action; the typed-password fields stay below as the always-
   * available fallback.
   */
  .biometric {
    width: 100%;
    margin-bottom: 0.4rem;
  }
</style>
