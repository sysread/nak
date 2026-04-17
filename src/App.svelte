<script lang="ts">
  import { onMount } from 'svelte';
  import { app, activate, lock } from '$lib/state.svelte';
  import { hasStoredConfig } from '$lib/config';
  import {
    loadSession,
    touchSession,
    sessionRemainingMs,
    DEFAULT_TTL_MS,
  } from '$lib/session';
  import Setup from './screens/Setup.svelte';
  import Unlock from './screens/Unlock.svelte';
  import Chat from './screens/Chat.svelte';

  // Throttle activity writes to sessionStorage to once per TOUCH_THROTTLE_MS.
  const TOUCH_THROTTLE_MS = 30_000;
  // How often to check whether the session has expired.
  const IDLE_CHECK_MS = 30_000;

  onMount(() => {
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
    };
  });
</script>

{#if app.phase === 'loading'}
  <div class="center"><p class="subtle">Loading…</p></div>
{:else if app.phase === 'setup'}
  <Setup />
{:else if app.phase === 'locked'}
  <Unlock />
{:else}
  <Chat />
{/if}
