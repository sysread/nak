# Offline cache

A per-device IndexedDB mirror of the records the user marked for
offline access, so a PWA install can open them with no network. Nak
otherwise fetches every wiki article and recipe live from Supabase;
the app shell already loads offline (precached by `src/sw.ts` +
vite-plugin-pwa - see [`./build-deploy.md`](./build-deploy.md)), but
the data did not, so an offline device showed nothing.

## Role

Read-only offline access for a bounded, user-chosen set. NOT general
offline support: there is no write queue, no offline editing, and no
photo bytes. The marked set is driven by the existing bookmark
gestures:

- **articles** - every favorited wiki article (`wiki_articles.favorite`).
- **recipes** - every favorited OR upcoming recipe (the union of
  `recipes.favorite` and `recipes.upcoming`).

Favoriting an article is the gesture that "saves it offline"; the
wiki favorite flag exists for this feature (see
[`./wiki.md`](./wiki.md)). Recipes reused their pre-existing
favorite / upcoming flags (see [`./cookbook.md`](./cookbook.md)).

## Files

- `src/lib/offline-cache.ts` - the storage layer. Raw IndexedDB (no
  `idb` dep), same open-per-call / close-in-finally / promise-wrapped
  style as `draft-store.ts` and `share-store.ts`. One DB
  `nak-offline-cache` v1, two object stores `articles` + `recipes`,
  `keyPath: 'id'`. A `CachedEntry<T>` is `{ id, row, cachedAt }`. Pure
  bytes in/out: `putCached` / `getCached` / `getAllCached` /
  `deleteCached`. Every entry point short-circuits when `indexedDB` is
  absent (jsdom without a polyfill, SSR) so callers treat
  "unavailable" as "empty cache".
- `src/lib/offline-sync.svelte.ts` - the brain. Owns the reactive
  `offlineStatus` rune, the reconcile pass, and the read-through
  resolvers. Decides WHAT to store and WHEN; the storage layer is
  dumb underneath.
- `src/lib/ui/offline-status.ts` - pure copy/label primitives
  (`missingRecordMessage`, `offlineBannerText`, `countNoun`).
  Unit-tested.
- `src/lib/wiki-store.svelte.ts` / `src/lib/cookbook-store.svelte.ts` -
  the sidebar list stores. Their `loadWikiFirstPage` / `loadRecipes`
  fall back to the cached set (`getCachedArticles` / `getCachedRecipes`)
  when offline so the Favorites / Upcoming buckets stay browsable, and
  carry a `fromCache` flag the sidebars read to drop into a
  browse-only-the-saved-set regime (see Contracts).
- `src/components/OfflineBanner.svelte` - the fixed, bottom-centered
  connectivity chip; renders only when offline. Mounted once by
  `Chat.svelte` inside `.shell`.
- `tests/offline-cache.test.ts` - the reconcile core, the message
  primitive, and the storage + read-through integration against
  `fake-indexeddb`.

The cache works silently, so `offline-sync.svelte.ts` emits Logs-drawer
breadcrumbs under the `offline` source (see
[`./logging.md`](./logging.md)): connectivity transitions and the
per-sync headline at `info`, a skipped sync at `warn`, and per-record
read-through outcomes at `debug`. On a real device, filtering the drawer
to `offline` is how you confirm a favorited record actually downloaded -
the `info` sync line's `wrote` count is the proof.

## Entry points

- **Session live** - `Chat.svelte` calls `initOfflineStatus()` +
  `syncOfflineCache(supabase)` once the session lands (an `$effect`
  gated on `session`).
- **Realtime relays** - the existing `subscribeToWikiArticleChanges`
  / `subscribeToRecipeChanges` callbacks in `Chat.svelte` now also
  call `syncOfflineCache`, so a server-side write (this device or
  another) re-reconciles the cache. The pings carry no payload, so
  the reconcile re-fetches the marked set; it is a no-op when nothing
  the cache holds actually moved.
- **Back online** - `Chat.svelte` adds a `window` `online` listener
  that re-runs `syncOfflineCache`, so a cache that drifted while
  offline catches up.
- **Detail-view read** - the wiki article view
  (`Wiki.svelte`) and the cookbook detail (`Cookbook.svelte`) resolve
  the open record through `getArticleCached` / `getRecipeCached` when
  it is not in the loaded list. `getWikiArticleById` (new) is the
  authoritative single-row fetch behind the article read-through;
  recipes already had `getRecipe`.
- **Sidebar list (offline)** - the read-through opens a record only
  once its id is in the route; to let the user *browse* to one offline,
  `loadWikiFirstPage` / `loadRecipes` fall back to the cached set when
  the authoritative fetch fails AND `offlineStatus.online` is false.
  The list stores expose `getCachedArticles` / `getCachedRecipes` from
  `offline-sync` and re-bucket recipes by their `favorite` / `upcoming`
  flags. `WikiList.svelte` / `RecipeList.svelte` also add a `window`
  `online` listener that reloads the list on reconnect so the regime
  flips back to the full paginated list + search.

## Data model

No new tables. Two existing columns drive the marked set:
`wiki_articles.favorite` (added for this feature) and the recipe
`favorite` / `upcoming` flags. `updated_at` is the freshness
comparator. Content edits bump it on both tables; favorite /
upcoming toggles deliberately do NOT (they are bookmarks, not
content), so a re-favorite is correctly a no-op for the cache.

The cache itself lives in IndexedDB (`nak-offline-cache`), not
Supabase - it is per-device, ephemeral, and rebuildable from the
server at any time.

## Contracts

- **`syncOfflineCache(supabase)`** fetches the authoritative marked
  set (`listFavoriteWikiArticles`, `listFavoriteRecipes`,
  `listUpcomingRecipes`), then per store upserts rows whose
  `updated_at` differs from the cached copy and evicts cached ids no
  longer in the set. Returns `{ ok }`.
- **Never evict on a failed fetch.** If the authoritative fetch
  throws (offline, transient Supabase error), `syncOfflineCache`
  returns `{ ok: false }` WITHOUT touching the cache. This is the
  load-bearing "remote changed" vs "can't reach remote" distinction:
  evicting on a network hiccup would wipe the very copies saved for
  offline use. Pinned by `tests/offline-cache.test.ts`.
- **Read-through** (`getArticleCached` / `getRecipeCached`): online,
  fetch and refresh the cached copy; on an authoritative null
  (deleted server-side) clear the stale entry and report the miss; on
  a network error or while offline, fall back to the cached copy.
  Returns `{ row, fromCache }`. Never throws.
- **`offlineStatus`** is the reactive `{ online, lastSyncAt,
  articleCount, recipeCount }` the UI reads. `online` tracks
  `navigator.onLine` via `initOfflineStatus`.
- **Offline list fallback + `fromCache` regime.** When
  `loadWikiFirstPage` / `loadRecipes` throw, the next step depends on
  `offlineStatus.online`: offline, the buckets are repopulated from the
  IndexedDB mirror (articles title ASC; recipes the favorited-or-
  upcoming union re-bucketed by flag), the paginated browse list is
  emptied (it needs the server), and `fromCache` is set true; online,
  the failure is surfaced as an error and `fromCache` is cleared -
  hiding the full list + search over a transient blip is the worse
  trade. The sidebars read `fromCache` to hide the search / sort /
  topic controls and show only the saved buckets. A successful load
  (or a successful search) clears `fromCache`. Pinned by
  `tests/offline-list-fallback.test.ts`.

## Interactions

- **Wiki** ([`./wiki.md`](./wiki.md)) - the `favorite` flag, its
  toggle in the article header, the Favorites bucket in the sidebar,
  and `setWikiArticleFavorite` / `listFavoriteWikiArticles` /
  `getWikiArticleById` were added here. The article read-through
  feeds `Wiki.svelte`'s detail fallback.
- **Cookbook** ([`./cookbook.md`](./cookbook.md)) - reuses the
  existing favorite / upcoming flags and their complete-bucket
  fetches; the recipe read-through routes the existing `getRecipe`
  deep-link fallback through the cache.
- **Build & deploy** ([`./build-deploy.md`](./build-deploy.md)) - the
  service worker precaches the app shell that hosts all of this; the
  offline cache is the data layer the shell reads when the network is
  gone.
- **Auth & session** ([`./auth-session.md`](./auth-session.md)) - the
  offline cache is only reachable once the shell renders, which
  depends on `getSession()` resolving. supabase-js resolves it from
  localStorage without a round-trip, so an offline cold boot with a
  valid stored JWT renders; the `getSession().then` in `Chat.svelte`
  gained a `.catch` so a rejected read can never strand the UI on the
  "Connecting..." gate.

## Gotchas

- **The reconcile early-return on a failed fetch is intentional**, not
  a missing error path. It is the never-evict-on-failure invariant.
  Commented in `syncOfflineCache`.
- **A bookmark toggle does not bump `updated_at`.** The cache's
  `updated_at` comparator therefore treats a re-favorite as "no
  content change" and skips the rewrite - correct, the body is
  unchanged. Eviction is driven by set membership, not by
  `updated_at`.
- **Photos and records are not cached.** The cache holds article /
  recipe text + metadata only. Recipe photos are signed-URL blobs
  (they would expire); offline the detail pane shows "Photos are only
  available online" rather than broken images. Wiki records / sources
  / see-also are not cached either, so an article opened offline
  renders its body but an empty Records section.
- **IndexedDB unavailable degrades to no-cache, not an error.** The
  `available()` guard in `offline-cache.ts` makes every op a no-op
  when `indexedDB` is absent, so a hostile environment loses offline
  support but never crashes a read.
- **Writes are disabled offline, not queued.** The wiki and cookbook
  write controls gate on `offlineStatus.online`. There is no offline
  write queue by design - it is a large subsystem the requirements
  did not call for.

## Verification

`tests/offline-cache.test.ts` covers the reconcile diff (add /
refresh / evict, the bookmark-toggle no-op), the never-evict-on-
failure invariant, the read-through (online refresh, offline
serve, network-error fallback, authoritative-null eviction), and the
cached-list readers against `fake-indexeddb`.
`tests/offline-list-fallback.test.ts` covers the sidebar fallback: the
offline path repopulates the buckets and sets `fromCache`, while an
online fetch failure stays an error. The end-to-end PWA flow (install,
favorite, go offline, reload, browse, open) is the
[offline-cache](../qa/use-cases/offline-cache.md) QA walkthrough -
it needs a real browser + service worker, which the cloud agent
cannot drive.
