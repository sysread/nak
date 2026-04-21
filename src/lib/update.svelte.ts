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
 */

import { registerSW } from 'virtual:pwa-register';

// How often to ping the browser's SW registration to re-check for a
// new precache manifest. Five minutes is a compromise — short enough
// that a user who left the tab open sees "new version" within minutes
// of a deploy, long enough that we're not hammering the network.
const UPDATE_POLL_MS = 5 * 60 * 1000;

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

// `registerSW` returns the updateSW function we call on user confirm.
// Stored at module scope so `applyUpdate()` can reach it without
// having to thread the reference through App.svelte.
let updateSW: ((reloadPage?: boolean) => Promise<void>) | null = null;
// Cached so the Settings "Check for updates" button can trigger an
// out-of-band registration.update() without reloading the page.
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

  updateSW = registerSW({
    onNeedRefresh() {
      updateState.available = true;
    },
    onRegisteredSW(_swUrl, registration) {
      if (!registration) return;
      swRegistration = registration;
      // Poll for updates on an interval. registration.update() is a
      // no-op when the cached SW script matches the server's copy, so
      // the cost is one HEAD-ish request per tick.
      const poll = (): void => {
        void registration.update();
      };
      window.setInterval(poll, UPDATE_POLL_MS);
      // Also re-check whenever the tab becomes visible again — a user
      // returning from a coffee break should not have to wait up to a
      // full poll interval for the "new version" banner to appear.
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') poll();
      });
    },
    onRegisterError() {
      // Best-effort: a registration failure (blocked by an extension,
      // broken https, etc.) shouldn't crash the app. The user simply
      // won't see update banners; page reloads still work.
    },
  });
}

/**
 * Promote the waiting SW to active and reload the page. Called from
 * UpdateBanner's Reload button and from the Settings → About pane's
 * equivalent. In dev / no-SW environments `updateSW` is null, so we
 * fall back to a plain reload — still does the right thing when the
 * user just wants to pick up whatever's on disk.
 */
export async function applyUpdate(): Promise<void> {
  if (updateSW) {
    await updateSW(true);
    return;
  }
  window.location.reload();
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
  if (swRegistration) {
    await swRegistration.update();
    return;
  }
  // Give the "Checking…" label a moment to register visually even on
  // fast machines; otherwise the button flickers and the user wonders
  // if the click registered at all.
  await new Promise((resolve) => setTimeout(resolve, 250));
}
