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
 * The update check runs on an interval (3 minutes) plus whenever the
 * tab regains visibility. Browsers also fire their own update check
 * roughly every 24h; our polling shortens that window so a new deploy
 * is noticed within minutes instead of after next-day page load.
 *
 * Diagnostic logging: every state transition in this module logs
 * through the `update` logger (see `./logger.svelte`). The volume is
 * low (register once, poll every 5 min, state changes are rare) and
 * the symptoms we've debugged against - spurious banners, reload-
 * button hangs - are all state-machine bugs that can only be
 * explained by the *order* of events. Keep the logs even in
 * production.
 */

import { registerSW } from 'virtual:pwa-register';
import { createLogger } from './logger.svelte';

const log = createLogger('update');

// How often to ping the browser's SW registration to re-check for a
// new precache manifest. Three minutes is a compromise - short enough
// that a user who left the tab open sees "new version" within minutes
// of a deploy, long enough that we're not hammering the network.
const UPDATE_POLL_MS = 3 * 60 * 1000;

// Safety net for the reload flow. If `controllerchange` hasn't fired
// this many ms after we post SKIP_WAITING to the waiting SW, force a
// plain reload anyway. Two seconds is a compromise — long enough that
// a slow machine finishing the handover gets the "clean" reload path,
// short enough that a stuck state doesn't feel like the app hung.
// The prior implementation awaited `controllerchange` indefinitely,
// which was the cause of the beach-ball hang when the waiting SW had
// already been claimed by the time the user clicked Reload.
const RELOAD_FALLBACK_MS = 2000;

// Escalation after the soft reload. If `location.reload()` is called
// (by the controllerchange listener or the soft-reload timer above)
// and we are STILL running this script N ms later, something ate the
// navigation — typically a SW fetch handler that never resolves,
// keeping the old page visible while the browser waits on a response
// that won't come. The hard-reload path unregisters the SW and
// navigates with a cache-busting query so the next fetch can't be
// served by either the SW or the HTTP cache. Five seconds gives a
// slow network / large bundle time to complete the soft reload
// before we go nuclear.
const HARD_RELOAD_FALLBACK_MS = 5000;

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

  log.info('initUpdateWatcher: registering service worker', {
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
      log.info('onNeedRefresh: waiting SW detected', {
        hasRegistration: !!swRegistration,
        waiting: !!swRegistration?.waiting,
        installing: !!swRegistration?.installing,
        active: !!swRegistration?.active,
        controller: !!navigator.serviceWorker?.controller,
      });
      updateState.available = true;
    },
    onRegisteredSW(swUrl, registration) {
      // Routine SW-registered confirmation - fires on every load; the
      // interesting cases (need-refresh, poll, applyUpdate) have their
      // own info-tier entries. Kept at debug so the default Info+ view
      // isn't dominated by one-per-pageload registration noise.
      log.debug('onRegisteredSW', {
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
        // Per-tick heartbeat - fires every UPDATE_POLL_MS plus on every
        // visibilitychange-back-to-visible. Kept at debug so the
        // default Info+ view isn't dominated by routine update probes;
        // failures still surface at warn.
        log.debug('poll', reason);
        registration.update().catch((err) => {
          log.warn('poll failed', err);
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
      log.warn('onRegisterError', error);
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
 *   - No waiting SW: plain `location.reload()` immediately, escalating
 *     to a hard reload if the navigation is still pending after
 *     HARD_RELOAD_FALLBACK_MS. Covers dev mode, registration errors,
 *     and the edge case where the waiting SW already claimed.
 *   - Waiting SW exists: post SKIP_WAITING, then reload on
 *     `controllerchange` — OR after RELOAD_FALLBACK_MS, whichever
 *     comes first. The timeout is the critical bit: vite-plugin-pwa's
 *     helper awaits `controllerchange` indefinitely, which hangs the
 *     UI (spinning beach ball) if the handover never completes.
 *
 * Escalation ladder, tiered so the common "it just works" path stays
 * fast and the pathological paths self-recover:
 *
 *   T+0      post SKIP_WAITING
 *   T+2s     soft reload (location.reload) if controllerchange didn't
 *            fire yet
 *   T+5s     hard reload (unregister SW + cache-busted navigate) if
 *            we are STILL here — meaning something ate the soft
 *            reload, typically a SW fetch handler that never resolves.
 *
 * Every tier is guarded by an idempotence flag so a late event doesn't
 * re-trigger a navigation that's already in flight. Clicking Reload
 * always ends in a fresh page load.
 */
export async function applyUpdate(): Promise<void> {
  const registration = swRegistration;
  const waiting = registration?.waiting ?? null;

  log.info('applyUpdate: start', {
    hasRegistration: !!registration,
    hasWaiting: !!waiting,
    installing: !!registration?.installing,
    active: !!registration?.active,
    controller: !!navigator.serviceWorker?.controller,
  });

  // Arm the hard-reload escalation up-front so even the "no waiting
  // SW" branch benefits from it. If the soft reload below navigates
  // the tab within HARD_RELOAD_FALLBACK_MS, this timer never fires
  // because setTimeout callbacks don't execute after navigation
  // starts. If the tab is still alive when it fires, it's because
  // something is holding navigation hostage.
  window.setTimeout(() => {
    void hardReload('hard-reload timeout');
  }, HARD_RELOAD_FALLBACK_MS);

  if (!waiting) {
    // No SW to hand off to — just reload. This is the path for dev
    // mode, for registration errors, and for the edge case where the
    // waiting SW was claimed between the banner appearing and the
    // user clicking Reload.
    log.info('applyUpdate: no waiting SW, plain reload');
    softReload('no waiting SW');
    return;
  }

  // Attach the listener BEFORE posting SKIP_WAITING — if the new SW
  // claims fast enough to fire controllerchange synchronously after
  // skipWaiting resolves, a listener attached later would miss it.
  navigator.serviceWorker.addEventListener(
    'controllerchange',
    () => softReload('controllerchange'),
    { once: true }
  );

  // Soft-reload safety net — see RELOAD_FALLBACK_MS comment for the
  // rationale. `softReload` is idempotent so the listener + timeout
  // racing to call it is fine.
  window.setTimeout(() => softReload('soft-reload timeout'), RELOAD_FALLBACK_MS);

  log.info('applyUpdate: posting SKIP_WAITING to waiting SW');
  try {
    waiting.postMessage({ type: 'SKIP_WAITING' });
  } catch (err) {
    // postMessage can't really fail on a ServiceWorker object, but if
    // somehow it does, fall through to the timeout — the page will
    // still reload in RELOAD_FALLBACK_MS.
    log.warn('applyUpdate: postMessage failed', err);
  }
}

// Idempotence guards for the two reload tiers. Module-scoped so a
// late controllerchange firing after the soft-reload timer already
// ran doesn't try to reload a second time, and so the hard-reload
// timer doesn't re-enter while its async unregister is in flight.
let softReloadFired = false;
let hardReloadFired = false;

function softReload(reason: string): void {
  if (softReloadFired) return;
  softReloadFired = true;
  log.info('softReload', reason);
  window.location.reload();
}

async function hardReload(reason: string): Promise<void> {
  if (hardReloadFired) return;
  hardReloadFired = true;
  log.info('hardReload', reason);
  // Unregister the SW so the next navigation can't be intercepted by
  // whatever stuck fetch handler held the soft reload hostage. Any
  // controlled clients (this tab included) lose SW control on the
  // next navigation — which is what we're about to do anyway.
  try {
    const reg = await navigator.serviceWorker?.getRegistration();
    if (reg) {
      const ok = await reg.unregister();
      log.info('hardReload: unregistered SW', { ok });
    }
  } catch (err) {
    // Failing to unregister is survivable — the cache-buster below
    // still forces a fresh index.html fetch, and most SW fetch
    // handlers don't rewrite top-level navigations anyway.
    log.warn('hardReload: unregister failed', err);
  }
  // Cache-busting query so neither the HTTP cache nor a lingering SW
  // fetch handler can return the stale bundle. `replace` (vs `href =`)
  // keeps this navigation out of session history so Back doesn't land
  // the user back on the frozen page.
  const url = new URL(window.location.href);
  url.searchParams.set('_update', String(Date.now()));
  log.info('hardReload: navigating to', url.toString());
  window.location.replace(url.toString());
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
  log.info('checkForUpdates: manual check', {
    hasRegistration: !!swRegistration,
  });
  if (swRegistration) {
    await swRegistration.update();
    log.info('checkForUpdates: registration.update() resolved', {
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
