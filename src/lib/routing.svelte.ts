/*
 * URL-driven routing for the unlocked Chat shell. All observable UI
 * state that survives a refresh lives in the query string:
 *
 *   cid     = active thread id
 *   drawer  = 'chats' | 'recipes' | 'journal'  (sidebar tab; absent = 'chats')
 *   modal   = 'settings'|'cookbook'|'help'|'memories'|'journal'
 *   recipe  = recipe id when modal=cookbook
 *   doc     = docs/user/ path when modal=help
 *   journal_date = YYYY-MM-DD focused in the journal modal
 *
 * The deploy target is GitHub Pages with no SPA fallback, so path-style
 * routes (/settings, /recipes/<id>) would 404 on refresh. Every routed
 * field lives in `location.search`, which always resolves to the root
 * index.html.
 *
 * The module owns:
 *   - `route`          reactive state object; the in-memory cache of
 *                      the URL's routed keys.
 *   - `navigate(patch)` the only path that mutates `route` AND the URL
 *                      together (pushState / replaceState).
 *   - the popstate listener, which uses a `suppressPush` guard to flip
 *                      state without re-pushing back into history.
 *
 * Adjacent modules read `route.cid` / `route.modal` / etc. directly
 * (Svelte 5 $state reads stay reactive across module boundaries).
 * Writes always go through `navigate({...})` so the push-vs-replace
 * decision is explicit at the call site.
 *
 * Non-routed keys in the URL (notably `share=pending` from the Web
 * Share Target flow, plus `#setup=...` in the hash) pass through every
 * pushState unchanged — `buildSearch` only strips the keys this module
 * owns.
 */

export type Modal =
  | 'settings'
  | 'cookbook'
  | 'help'
  | 'memories'
  | 'samskara'
  | 'journal';
export type DrawerTab = 'chats' | 'recipes' | 'journal';

export interface Route {
  cid: string | null;
  drawer: DrawerTab | null;
  modal: Modal | null;
  recipe: string | null;
  doc: string | null;
  /**
   * YYYY-MM-DD focused in the Journal daily view when
   * `modal === 'journal'`. Absent on the list view.
   */
  journal_date: string | null;
}

const ROUTED_KEYS = [
  'cid',
  'drawer',
  'modal',
  'recipe',
  'doc',
  'journal_date',
] as const;
const MODAL_VALUES: readonly Modal[] = [
  'settings',
  'cookbook',
  'help',
  'memories',
  'samskara',
  'journal',
];
const DRAWER_VALUES: readonly DrawerTab[] = ['chats', 'recipes', 'journal'];

export const route = $state<Route>({
  cid: null,
  drawer: null,
  modal: null,
  recipe: null,
  doc: null,
  journal_date: null,
});

function readEnum<T extends string>(
  params: URLSearchParams,
  key: string,
  allowed: readonly T[],
): T | null {
  const v = params.get(key);
  if (v === null || v === '') return null;
  return (allowed as readonly string[]).includes(v) ? (v as T) : null;
}

function readString(params: URLSearchParams, key: string): string | null {
  const v = params.get(key);
  return v === null || v === '' ? null : v;
}

export function parseUrl(search: string = typeof location !== 'undefined' ? location.search : ''): Route {
  const params = new URLSearchParams(search);
  return {
    cid: readString(params, 'cid'),
    drawer: readEnum(params, 'drawer', DRAWER_VALUES),
    modal: readEnum(params, 'modal', MODAL_VALUES),
    recipe: readString(params, 'recipe'),
    doc: readString(params, 'doc'),
    journal_date: readString(params, 'journal_date'),
  };
}

/**
 * Serialize `r` into a search string ("?k=v&...") while preserving any
 * unknown keys already on `location.search` (e.g. ?share=pending).
 * Returns an empty string when nothing would be set, so we don't paint
 * a stray "?" onto the URL.
 */
export function buildSearch(
  r: Route,
  currentSearch: string = typeof location !== 'undefined' ? location.search : '',
): string {
  const params = new URLSearchParams(currentSearch);
  for (const k of ROUTED_KEYS) params.delete(k);
  if (r.cid) params.set('cid', r.cid);
  if (r.drawer) params.set('drawer', r.drawer);
  if (r.modal) params.set('modal', r.modal);
  if (r.recipe) params.set('recipe', r.recipe);
  if (r.doc) params.set('doc', r.doc);
  if (r.journal_date) params.set('journal_date', r.journal_date);
  const s = params.toString();
  return s ? `?${s}` : '';
}

let suppressPush = false;
let initialized = false;

function applyPatch(patch: Partial<Route>): boolean {
  // Explicit per-key assignment. `undefined` means "don't touch", `null`
  // means "clear". Kept unrolled rather than looping because TS can't
  // narrow `Route[k]` under a generic key without a cast. Returns true
  // when anything actually moved - navigate() uses this to skip a
  // no-op pushState when a caller sets a value that's already current
  // (e.g. when the popstate-driven reconcile effect calls a helper
  // that in turn calls navigate to "echo" the URL change).
  let changed = false;
  if (patch.cid !== undefined && patch.cid !== route.cid) {
    route.cid = patch.cid;
    changed = true;
  }
  if (patch.drawer !== undefined && patch.drawer !== route.drawer) {
    route.drawer = patch.drawer;
    changed = true;
  }
  if (patch.modal !== undefined && patch.modal !== route.modal) {
    route.modal = patch.modal;
    changed = true;
  }
  if (patch.recipe !== undefined && patch.recipe !== route.recipe) {
    route.recipe = patch.recipe;
    changed = true;
  }
  if (patch.doc !== undefined && patch.doc !== route.doc) {
    route.doc = patch.doc;
    changed = true;
  }
  if (
    patch.journal_date !== undefined &&
    patch.journal_date !== route.journal_date
  ) {
    route.journal_date = patch.journal_date;
    changed = true;
  }
  return changed;
}

/**
 * Apply a partial route update AND push (or replace) a history entry.
 * `replace: true` means "don't create a back-button stop for this" —
 * use it for drawer tab toggles and the one-shot mount-time sync of
 * sessionStorage-restored state.
 *
 * Callable during popstate via the `suppressPush` guard — popstate
 * needs to update `route` without re-writing history, which would
 * loop forever.
 */
export function navigate(patch: Partial<Route>, opts: { replace?: boolean } = {}): void {
  const changed = applyPatch(patch);
  if (!changed) return;
  if (suppressPush) return;
  if (typeof window === 'undefined') return;
  const url = location.pathname + buildSearch(route) + location.hash;
  if (opts.replace) {
    history.replaceState(null, '', url);
  } else {
    history.pushState(null, '', url);
  }
}

function syncFromUrl(): void {
  // popstate handler and one-shot mount-time parse share this path.
  // Setting `suppressPush` prevents a subsequent `navigate` inside
  // downstream reactive effects from re-pushing the URL we just
  // adopted.
  suppressPush = true;
  try {
    applyPatch(parseUrl());
  } finally {
    suppressPush = false;
  }
}

/**
 * Idempotent — call this when the app first enters the `unlocked`
 * phase. Subsequent calls are no-ops. Installs the popstate listener
 * exactly once per page lifecycle.
 */
export function initRouting(): void {
  if (initialized) return;
  initialized = true;
  if (typeof window === 'undefined') return;
  syncFromUrl();
  window.addEventListener('popstate', syncFromUrl);
}

// Exposed for tests only. Resets module-level flags and clears the
// shared `route` object so each test starts from a known state.
export const __test = {
  reset(): void {
    initialized = false;
    suppressPush = false;
    route.cid = null;
    route.drawer = null;
    route.modal = null;
    route.recipe = null;
    route.doc = null;
    route.journal_date = null;
  },
  syncFromUrl,
};
