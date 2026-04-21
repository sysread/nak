/**
 * Version fingerprint + service-worker update detection.
 *
 * Two jobs, tied together because they surface in the same UX:
 *
 *   1. Expose the build-time commit + build timestamp (inlined by
 *      Vite's `define` — see vite.config.ts) as reactive state so
 *      Settings → About can render them verbatim.
 *   2. Register the service worker in `prompt` mode and flip
 *      `available` to true when a new SW is waiting. UpdateBanner
 *      reads this flag; clicking the banner's Reload button calls
 *      `applyUpdate()`, which posts SKIP_WAITING to the waiting SW
 *      and reloads the page into the fresh precache.
 *
 * Why one module owns both: "which build am I running" and "is a
 * new build ready" are the same user question, asked from opposite
 * ends of the deploy cycle. Keeping them colocated means the
 * banner, the About pane, and any future surface (e.g. a footer
 * version tag) all read from one source.
 *
 * The update check runs on an interval (5 minutes) plus whenever the
 * tab regains visibility. Browsers also fire their own update check
 * roughly every 24h; our polling shortens that window so a new deploy
 * is noticed within minutes instead of after next-day page load.
 *
 * Diagnostic logging: every state transition in this module logs to
 * the console under the `[update]` prefix. The volume is low (register
 * once, poll every 5 min, state changes are rare) and the symptoms
 * we've debugged against — spurious banners, reload-button hangs —
 * are all state-machine bugs that can only be explained by the
 * *order* of events. Keep the logs even in production.
 */

import { registerSW } from 'virtual:pwa-register';

// How often to ping the browser's SW registration to re-check for a
// new precache manifest. Five minutes is a compromise — short enough
// that a user who left the tab open sees "new version" within minutes
// of a deploy, long enough that we're not hammering the network.
const UPDATE_POLL_MS = 5 * 60 * 1000;

// Safety net for the reload flow. If `controllerchange` hasn't fired
// this many ms after we post SKIP_WAITING to the waiting SW, force a
// plain reload anyway. Two seconds is a compromise — long enough that
// a slow machine finishing the handover gets the "clean" reload path,
// short enough that a stuck state doesn't feel like the app hung.
// The prior implementation awaited `controllerchange` indefinitely,
// which was the cause of the beach-ball hang when the waiting SW had
// already been claimed by the time the user clicked Reload.
const RELOAD_FALLBACK_MS = 2000;

interface UpdateState {
  /** True once a new SW is installed and waiting for `applyUpdate()`. */
  available: boolean;
  /** Short commit SHA of the running build, or 'dev' in HMR mode. */
  commit: string;
  /** ISO timestamp recorded at build time (not install time). */
  buildTime: string;
}

export const updateState = $state<UpdateState>({
  available: false,
  commit: __APP_COMMIT__,
  buildTime: __APP_BUILD_TIME__,
});

// Cached so `applyUpdate()` and the "Check for updates" button in
// Settings can reach the active registration without threading it
// through the calling code. Set inside `onRegisteredSW`, which runs
// after `wb.register()` resolves.
let swRegistration: ServiceWorkerRegistration | null = null;
let started = false;

/**
 * Register the service worker and wire update callbacks. Safe to call
 * multiple times — subsequent calls are no-ops. App.svelte calls this
 * once from `onMount`. In dev mode (`pnpm dev`) the PWA plugin doesn't
 * wire a SW at all, so `registerSW` returns a no-op updater and
 * `onNeedRefresh` never fires.
 */
export function initUpdateWatcher(): void {
  if (started) return;
  started = true;
  if (typeof window === 'undefined') return;

  console.log('[update] initUpdateWatcher: registering service worker', {
    commit: updateState.commit,
    buildTime: updateState.buildTime,
    existingController: !!navigator.serviceWorker?.controller,
  });

  registerSW({
    onNeedRefresh() {
      // Fires whenever a new SW is installed AND an old SW is still
      // controlling this page — the `waiting` state. Usually that's
      // a real deploy, but it also fires the first time a user with
      // a pre-prompt-mode SW visits after the prompt-mode deploy,
      // because the mode switch alone makes the SW script bytes
      // differ. We log the state rather than trying to suppress it
      // here: hiding the banner requires knowing whether the waiting
      // SW's build fingerprint matches ours, which we don't have.
      console.log('[update] onNeedRefresh: waiting SW detected', {
        hasRegistration: !!swRegistration,
        waiting: !!swRegistration?.waiting,
        installing: !!swRegistration?.installing,
        active: !!swRegistration?.active,
        controller: !!navigator.serviceWorker?.controller,
      });
      updateState.available = true;
    },
    onRegisteredSW(swUrl, registration) {
      console.log('[update] onRegisteredSW', {
        swUrl,
        hasRegistration: !!registration,
        waiting: !!registration?.waiting,
        installing: !!registration?.installing,
        active: !!registration?.active,
      });
      if (!registration) return;
      swRegistration = registration;
      // Poll for updates on an interval. registration.update() is a
      // no-op when the cached SW script matches the server's copy, so
      // the cost is one HEAD-ish request per tick.
      const poll = (reason: string): void => {
        console.log('[update] poll:', reason);
        registration.update().catch((err) => {
          console.warn('[update] poll failed', err);
        });
      };
      window.setInterval(() => poll('interval'), UPDATE_POLL_MS);
      // Also re-check whenever the tab becomes visible again — a user
      // returning from a coffee break should not have to wait up to a
      // full poll interval for the "new version" banner to appear.
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') poll('visibilitychange');
      });
    },
    onRegisterError(error) {
      // Best-effort: a registration failure (blocked by an extension,
      // broken https, etc.) shouldn't crash the app. The user simply
      // won't see update banners; page reloads still work.
      console.warn('[update] onRegisterError', error);
    },
  });
}

/**
 * Activate the waiting SW and reload the page. Called from
 * UpdateBanner's Reload button and from the Settings → About pane's
 * equivalent.
 *
 * Implemented inline (rather than delegating to vite-plugin-pwa's
 * `updateSW(true)`) so we can guarantee the page reloads no matter
 * what state the SW registration is in:
 *
 *   - No waiting SW: plain `location.reload()`. The browser refetches
 *     the bundle through whatever SW is active, which is fine if the
 *     banner was a false positive or the waiting SW already claimed.
 *   - Waiting SW exists: post SKIP_WAITING, then reload on
 *     `controllerchange` — OR after a 2-second timeout, whichever
 *     comes first. The timeout is the critical bit: vite-plugin-pwa's
 *     helper awaits `controllerchange` indefinitely, which hangs the
 *     UI (spinning beach ball) if the handover never completes.
 *
 * The reload is unconditional, so clicking Reload always ends in a
 * fresh page load. If something's wrong with the SW state machine,
 * the hard reload is the worst case — not a hang.
 */
export async function applyUpdate(): Promise<void> {
  const registration = swRegistration;
  const waiting = registration?.waiting ?? null;

  console.log('[update] applyUpdate: start', {
    hasRegistration: !!registration,
    hasWaiting: !!waiting,
    installing: !!registration?.installing,
    active: !!registration?.active,
    controller: !!navigator.serviceWorker?.controller,
  });

  if (!waiting) {
    // No SW to hand off to — just reload. This is the path for dev
    // mode, for registration errors, and for the edge case where the
    // waiting SW was claimed between the banner appearing and the
    // user clicking Reload.
    console.log('[update] applyUpdate: no waiting SW, plain reload');
    window.location.reload();
    return;
  }

  // Attach the listener BEFORE posting SKIP_WAITING — if the new SW
  // claims fast enough to fire controllerchange synchronously after
  // skipWaiting resolves, a listener attached later would miss it.
  let reloaded = false;
  const reload = (reason: string): void => {
    if (reloaded) return;
    reloaded = true;
    console.log('[update] applyUpdate: reloading', { reason });
    window.location.reload();
  };

  navigator.serviceWorker.addEventListener(
    'controllerchange',
    () => reload('controllerchange'),
    { once: true }
  );

  // Safety net — see RELOAD_FALLBACK_MS comment for the rationale.
  // `setTimeout` runs even when the `controllerchange` listener does
  // fire, but `reload()` is idempotent so the second call is a no-op.
  window.setTimeout(() => reload('timeout'), RELOAD_FALLBACK_MS);

  console.log('[update] applyUpdate: posting SKIP_WAITING to waiting SW');
  try {
    waiting.postMessage({ type: 'SKIP_WAITING' });
  } catch (err) {
    // postMessage can't really fail on a ServiceWorker object, but if
    // somehow it does, fall through to the timeout — the page will
    // still reload in RELOAD_FALLBACK_MS.
    console.warn('[update] applyUpdate: postMessage failed', err);
  }
}

/**
 * Nudge the SW to check for a new build right now — used by the
 * "Check for updates" button in Settings → About. Resolves once
 * `registration.update()` settles. If the check finds a new SW,
 * `onNeedRefresh` flips `updateState.available` and the pane +
 * banner switch to "Reload to update" without a page reload.
 *
 * No-op (with a short artificial delay so the button's "Checking…"
 * label has a visible beat) when the SW is unregistered — the dev
 * server path, plus users whose browsers block service workers.
 */
export async function checkForUpdates(): Promise<void> {
  console.log('[update] checkForUpdates: manual check', {
    hasRegistration: !!swRegistration,
  });
  if (swRegistration) {
    await swRegistration.update();
    console.log('[update] checkForUpdates: registration.update() resolved', {
      waiting: !!swRegistration.waiting,
      installing: !!swRegistration.installing,
    });
    return;
  }
  // Give the "Checking…" label a moment to register visually even on
  // fast machines; otherwise the button flickers and the user wonders
  // if the click registered at all.
  await new Promise((resolve) => setTimeout(resolve, 250));
}
