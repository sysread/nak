<script lang="ts">
  /*
   * App root. Two jobs:
   *
   *   1. Phase routing. Which screen renders is decided by `app.phase`
   *      in $lib/state.svelte.ts. This file just dispatches.
   *
   *   2. Session lifecycle. On mount we decide whether to auto-unlock
   *      from a prior sessionStorage blob, jump to setup (no stored
   *      config), or show the Unlock screen. While unlocked we listen
   *      for user activity to extend the TTL, and a wall-clock timer
   *      drops the session back to `locked` when it expires.
   *
   * The inline boot script in index.html already applied cached theme
   * attributes to <html> before first paint; applyTheme() in onMount
   * re-syncs that with the reactive state so subsequent toggles keep
   * working.
   */
  import { onMount } from 'svelte';
  import { app, activate, lock, setTheme } from '$lib/state.svelte';
  import { hasStoredConfig } from '$lib/config';
  import {
    loadSession,
    touchSession,
    sessionRemainingMs,
    DEFAULT_TTL_MS,
  } from '$lib/session';
  import { applyTheme } from '$lib/theme';
  import { initUpdateWatcher } from '$lib/update.svelte';
  import Setup from './screens/Setup.svelte';
  import Unlock from './screens/Unlock.svelte';
  import Chat from './screens/Chat.svelte';
  import EditConfig from './screens/EditConfig.svelte';
  import UpdateBanner from './components/UpdateBanner.svelte';

  // Throttle activity writes to sessionStorage — sessionStorage.setItem is
  // synchronous and we don't want to hammer it on every keystroke.
  const TOUCH_THROTTLE_MS = 30_000;
  // How often to check whether the session has expired. Low enough that
  // the auto-lock feels responsive (a user walking away for > 1hr sees
  // the lock screen within 30s of expiry) without burning CPU.
  const IDLE_CHECK_MS = 30_000;

  onMount(() => {
    // Make sure the inline boot script's attributes reflect the current
    // reactive state (they should already match via cached theme, but this
    // keeps Svelte and the DOM in sync on first paint).
    applyTheme(app.colorMode, app.accent);

    // Register the service worker and start polling for new builds. Has
    // to run after mount (not at module top level) so tests that import
    // state.svelte.ts without a DOM don't trip over `registerSW`'s
    // window dependency.
    initUpdateWatcher();

    // When mode === 'system', follow OS changes live.
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const onSystemChange = (): void => {
      if (app.colorMode === 'system') setTheme('system', app.accent);
    };
    media.addEventListener('change', onSystemChange);

    // Prefer an existing sessionStorage unlock over reprompting for the
    // master password. The session blob carries the plaintext config; the
    // check happens entirely client-side.
    const restored = loadSession();
    if (restored) {
      activate(restored, { persist: false });
    } else {
      app.phase = hasStoredConfig() ? 'locked' : 'setup';
    }

    let lastTouch = 0;
    const onActivity = (): void => {
      if (app.phase !== 'unlocked') return;
      const now = Date.now();
      if (now - lastTouch < TOUCH_THROTTLE_MS) return;
      lastTouch = now;
      touchSession(DEFAULT_TTL_MS);
    };

    // These are all "coarse" activity signals — keypress, pointer, scroll,
    // and tab-focus. mousemove intentionally omitted to avoid hyperactive
    // writes while the user is just moving the cursor.
    const events = ['keydown', 'pointerdown', 'scroll', 'focus'] as const;
    for (const ev of events) {
      window.addEventListener(ev, onActivity, { passive: true });
    }

    const idleTimer = window.setInterval(() => {
      if (app.phase !== 'unlocked') return;
      const remaining = sessionRemainingMs();
      if (remaining === null || remaining === 0) {
        lock();
      }
    }, IDLE_CHECK_MS);

    return () => {
      for (const ev of events) {
        window.removeEventListener(ev, onActivity);
      }
      window.clearInterval(idleTimer);
      media.removeEventListener('change', onSystemChange);
    };
  });
</script>

<!-- Banner renders across every phase and sits above the active screen
     via a high z-index — the "new version available" prompt is useless
     if it hides behind Settings or the auth flow. -->
<UpdateBanner />

{#if app.phase === 'loading'}
  <div class="center"><p class="subtle">Loading…</p></div>
{:else if app.phase === 'setup'}
  <Setup />
{:else if app.phase === 'locked'}
  <Unlock />
{:else if app.phase === 'edit-config'}
  <EditConfig />
{:else}
  <Chat />
{/if}
