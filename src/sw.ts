/// <reference lib="webworker" />

/**
 * Custom service worker. Two jobs:
 *
 *   1. Precache the app shell via workbox-precaching so the installed
 *      PWA keeps working offline — the same behavior the old
 *      `generateSW` setup provided.
 *   2. Intercept POST requests to `<scope>share` emitted by the OS
 *      share sheet (Web Share Target API). The incoming multipart
 *      form data is unpacked, stashed in IndexedDB via share-store,
 *      and the user is redirected to the app root with `?share=pending`
 *      so Chat.svelte knows to drain the queue on mount.
 *
 * The POST-handler registration has to come BEFORE
 * `precacheAndRoute` — the first listener to call `respondWith()`
 * wins, and we do NOT want workbox's navigation fallback to serve
 * index.html for the share POST. (Workbox's nav fallback is
 * GET-only in practice, but explicit ordering keeps this robust
 * against workbox version bumps.)
 */

import { precacheAndRoute } from 'workbox-precaching';
import { savePendingShare, type SharedFile } from './lib/share-store';

declare const self: ServiceWorkerGlobalScope & {
  __WB_DISABLE_DEV_LOGS?: boolean;
};

// Workbox ships a dev-mode log channel that fires one line per
// precache lookup ("Router is responding to…", "Found a cached
// response…", "No route found for…"). In a deployed PWA this
// floods DevTools with DEBUG-level chatter that buries real errors —
// the logs are only useful when you're actively debugging the SW
// itself. Keep them on under localhost so local-dev stays
// instrumentable; silence them everywhere else.
//
// Must be set before any workbox API that logs is called. The flag
// is read lazily inside workbox's logger, so this assignment
// before `precacheAndRoute` below is sufficient.
if (
  self.location.hostname !== 'localhost' &&
  self.location.hostname !== '127.0.0.1'
) {
  self.__WB_DISABLE_DEV_LOGS = true;
}

// Scoped pathname for the share endpoint. On GitHub Pages the SW
// scope is `/<repo>/`, so the effective share URL is
// `/<repo>/share`. Deriving it from `registration.scope` rather than
// hard-coding `/share` keeps us working under any deploy base.
const SHARE_PATH = new URL('share', self.registration.scope).pathname;
const APP_ROOT_WITH_FLAG = new URL('./?share=pending', self.registration.scope).toString();

// Snappier updates — with `autoUpdate` registration on the client
// side, this pair ensures a refreshed SW takes over without waiting
// for every tab to close.
self.addEventListener('install', () => {
  void self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'POST') return;
  const url = new URL(request.url);
  if (url.pathname !== SHARE_PATH) return;
  event.respondWith(handleShare(request));
});

async function handleShare(request: Request): Promise<Response> {
  try {
    const form = await request.formData();
    const title = formString(form.get('title'));
    const text = formString(form.get('text'));
    const sharedUrl = formString(form.get('url'));
    // Files come through as repeated `files` entries per the manifest
    // `share_target.params.files[0].name` value. Non-File entries
    // (extra text fields with the same key, if any) are filtered out.
    const files: SharedFile[] = form
      .getAll('files')
      .filter((entry): entry is File => entry instanceof File)
      .map((file) => ({ name: file.name, type: file.type, blob: file }));

    await savePendingShare({
      ts: Date.now(),
      title,
      text,
      url: sharedUrl,
      files,
    });
  } catch {
    // Best-effort: if the formData parse or IDB write fails we still
    // want to redirect the user into the app rather than leave them
    // on a blank browser error page. Chat.svelte will find nothing
    // queued and behave normally.
  }
  // 303 See Other so the follow-up is a GET — the browser navigates
  // the (possibly freshly-opened) tab to the app root, which reloads
  // the SPA and triggers the share drain on Chat mount.
  return Response.redirect(APP_ROOT_WITH_FLAG, 303);
}

function formString(value: FormDataEntryValue | null): string {
  return typeof value === 'string' ? value : '';
}

// `self.__WB_MANIFEST` is replaced at build time by vite-plugin-pwa
// with the precache manifest built from injectManifest.globPatterns.
// The `|| []` keeps dev-mode (where the plugin doesn't inject) from
// blowing up.
precacheAndRoute(self.__WB_MANIFEST || []);
