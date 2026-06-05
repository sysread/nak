<script lang="ts">
  /*
   * App root. Two jobs:
   *
   *   1. Phase routing. Which screen renders is decided by `app.phase`
   *      in $lib/state.svelte.ts. This file just dispatches.
   *
   *   2. Boot lifecycle. On mount we either find a stored config in
   *      localStorage and call activate() to bring the app online, or
   *      we jump to Setup. There's no longer a separate Unlock /
   *      Locked phase - the master-password ceremony got retired with
   *      the streaming-root cleanup (only public-by-design values left
   *      in local config, so encryption bought zero security and cost
   *      real UX).
   *
   * The inline boot script in index.html already applied cached theme
   * attributes to <html> before first paint; applyTheme() in onMount
   * re-syncs that with the reactive state so subsequent toggles keep
   * working.
   */
  import { onMount } from 'svelte';
  import { app, activate, setTheme } from '$lib/state.svelte';
  import { hasStoredConfig, loadConfig } from '$lib/config';
  import { applyTheme } from '$lib/theme';
  import { initUpdateWatcher } from '$lib/update.svelte';
  import { initRouting } from '$lib/routing.svelte';
  import Setup from './screens/Setup.svelte';
  import Chat from './screens/Chat.svelte';
  import UpdateBanner from './components/UpdateBanner.svelte';

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

    // Phase decision. With master password retired, the in-memory
    // activate happens synchronously here: there's no encrypted blob
    // to unlock, no separate sessionStorage cache to consult, just a
    // plain localStorage JSON we trust on read. A stored config that
    // failed validateConfig reads back as null and falls through to
    // Setup - the same outcome as a fresh browser - which doubles as
    // the hard-reset path for users coming from the old encrypted
    // v1 blob.
    if (hasStoredConfig()) {
      const cfg = loadConfig();
      if (cfg) activate(cfg);
      else app.phase = 'setup';
    } else {
      app.phase = 'setup';
    }

    return () => {
      media.removeEventListener('change', onSystemChange);
    };
  });

  // Install URL routing as soon as the app is unlocked. The setup
  // phase stays URL-inert on purpose - it's gated by stored-config
  // presence, not by the address bar, so a stray ?modal=settings
  // during setup would open nothing. initRouting is idempotent so
  // re-running on every mount cycle is a no-op after the first.
  $effect(() => {
    if (app.phase === 'unlocked') initRouting();
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
{:else}
  <Chat />
{/if}
