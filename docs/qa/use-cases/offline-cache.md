# Offline cache: favorited records readable with no network

## Covers

The per-device IndexedDB mirror of the marked set (favorited wiki
articles; favorited / upcoming recipes), the reconcile + read-through,
the never-evict-on-failure rule, the offline indicator, and the
read-only gating ([dev: offline-cache](../../dev/offline-cache.md),
[dev: wiki](../../dev/wiki.md), [dev: cookbook](../../dev/cookbook.md)).

This case needs a **real browser with a service worker** - the PWA
shell only loads offline when installed (`pnpm build && pnpm preview`,
then install; the dev server emits no SW). DevTools Network "Offline"
plus a reload stands in for losing signal.

## Preconditions

- Production-shaped build served and installed as a PWA:
  `pnpm build && pnpm preview`, open the preview URL, install via the
  address-bar prompt. Signed in.
- At least one wiki article and one recipe exist (create them, or use
  seeded data).
- DevTools open (Application -> Service Workers shows the active SW;
  Network has the Offline throttle).
- To inspect the cache directly: DevTools -> Application -> IndexedDB
  -> `nak-offline-cache` -> `articles` / `recipes`.

## Steps

1. **Mark the set.** Open an article, click the **star** in its
   header (it fills). Open a recipe, click the **favorite** (thumbs)
   bookmark. Stay online ~2s.
2. **Confirm it cached.** In Application -> IndexedDB ->
   `nak-offline-cache`, check `articles` holds the favorited article's
   id and `recipes` holds the favorited recipe's id.
3. **Go offline + reload.** Set Network to Offline. Reload the PWA.
4. **Browse the saved set offline (no link needed).** Click the Wiki
   tab. With no connection, the sidebar lists your saved articles under
   **Favorites - saved offline** and the search box + A-Z list are
   hidden. Pick the article from the list (not from a URL) and it
   opens. Do the same on the Recipes tab - the **Upcoming** /
   **Favorites** buckets list, controls hidden, pick one to open.
5. **Open by deep link offline.** Note the article's URL
   (`?drawer=wiki&wiki_article_id=...`) while online; offline, paste it
   into the installed app's address bar (or reload on it).
6. **Try a write offline.** On the open article, hover **Edit** /
   **Delete** / the star; on the recipe, the bookmark / edit / delete.
7. **Recipe photo offline.** Open (offline) a favorited recipe that
   has photos.
8. **Un-favorite cross-device (eviction).** Go back online. On a
   second device (or a second browser profile signed into the same
   account), un-favorite the article. Back on the first device, stay
   online a moment (or toggle offline->online to force a sync).
9. **Offline does not evict.** Favorite a fresh article online (let it
   cache), go offline, reload a few times, navigate around.
10. **Reconnect refreshes the sidebar.** With the Wiki (or Recipes) tab
    open and showing the offline buckets-only view, set Network back to
    Online. Without reloading, the sidebar should swap back to the full
    A-Z list with the search box returned.

## Expected

- (1-2) Both ids appear in the IndexedDB stores within ~2s of
  favoriting - the marked set mirrored without a manual action.
- (3) The app shell loads with no network. A bottom banner reads
  "You're offline. N articles and M recipes saved for offline use."
- (4) The sidebar is browsable offline: the saved buckets list every
  favorited / upcoming record (not just one you have a link to), the
  search box and full A-Z list are hidden, and picking a row opens the
  record. The favorited article renders fully offline - title, body,
  table of contents - via the cache. The favorited recipe renders its
  text, ingredients, and steps.
- (5) The same records also open by deep-link URL offline.
- (6) Every write control is disabled with a "Reconnect to ..."
  tooltip; nothing errors on click because nothing fires.
- (7) The photo strip is replaced by "Photos are only available
  online" - no broken image icons.
- (8) On the first device, the un-favorited article drops out of the
  Favorites section and its id disappears from the `articles` store on
  the next successful sync (the realtime ping or the online tick).
- (9) The freshly-favorited article stays in the cache across offline
  reloads - going offline NEVER drops a saved copy. Only an
  un-favorite seen while online evicts (the "remote changed" vs
  "can't reach remote" distinction).
- (10) On reconnect the open sidebar reloads from the server on its own:
  the buckets-only offline view gives way to the full paginated list
  and the search box returns, no manual reload needed.
- **[hosted]** Same against the hosted project: hosted realtime
  delivers the cross-device eviction ping (step 8) that local realtime
  may differ on, and a genuinely installed PWA on a phone with
  airplane mode is the real target of step 4.

## Cleanup

Un-favorite the QA articles / recipes (online) so the caches drain.
Re-enable Network. The IndexedDB DB can be deleted from DevTools
(Application -> IndexedDB -> `nak-offline-cache` -> Delete database)
if you want a clean slate.

## Results log

| Date | Env | Commit | Result | Notes |
| ---- | --- | ------ | ------ | ----- |
| 2026-06-30 | n/a | 166f67b | pending-manual | feature landed via cloud agent (no browser/SW available there); unit layer green (tests/offline-cache.test.ts); awaiting a manual PWA pass per the steps above |
| 2026-06-30 | n/a | (this PR) | pending-manual | offline sidebar browse added (steps 4, 10): list stores fall back to the cached set when offline, sidebars hide server-only controls, reconnect reloads. Unit layer green (tests/offline-list-fallback.test.ts, offline-cache.test.ts, recipe-list.test.ts); still needs the manual PWA pass - cloud agent can't drive a browser/SW |
| 2026-06-30 | hosted (Android PWA) | 3ce4dc4 | pass | manual pass on the installed phone PWA. Verified: airplane-mode cold open shows the saved Wiki + Recipe listings (steps 3-4); opening a saved recipe AND a saved article renders offline (step 4); reconnecting repopulates both listings on remount and the chat list auto-reloads on nav-back (step 10); recipe photos backfilled a few seconds after restoring service. Required two prior fixes found during this pass: cache-first list load (airplane mode hangs the fetch instead of failing fast) and precaching the Cookbook/Wiki panel chunks (runtime-cached screen chunks 404 offline right after a deploy). navigator.onLine reports online in airplane mode on this device, so offline detection leans on cache-first paint + fetch-failure fallback, not the flag alone. |
