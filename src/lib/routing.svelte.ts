/*
 * URL-driven routing for the unlocked Chat shell. All observable UI
 * state that survives a refresh lives in the query string:
 *
 *   cid     = active thread id
 *   drawer  = 'chats' | 'groceries' | 'recipes' | 'memories' | 'wiki' | ...  (sidebar tab; absent = 'chats')
 *   modal   = 'settings' | 'help' | 'samskara' | 'intuition' | 'bias-profile' | 'recall'  (utility overlays)
 *   recipe  = recipe id; selecting one switches the main panel to the recipe detail
 *   doc     = docs/user/ path when modal=help
 *
 * recipe is a primary content selector, not a sub-param of modal.
 * Recipes, memories, and wiki articles open inline in the main panel
 * (not as modal overlays). Settings, Help, and Samskara remain as
 * modal overlays.
 *
 * Memories used to be a modal. It moved to a drawer tab so the
 * primary content surfaces (chats, recipes, memories, wiki) all
 * read as siblings - same tab nav, same sidebar layout, same inline
 * panel pattern. The Memories tab carries `memory` as its per-row
 * routing key (parallel to `recipe` for cookbook): the panel renders
 * the single selected memory's full card, and the sidebar list is the
 * browse surface that picks one. Absent `memory` means "nothing
 * selected" and the panel shows an empty-state hint pointing at the
 * sidebar.
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

import {
  MCP_CALLBACK_CODE_KEY,
  MCP_CALLBACK_STATE_KEY,
} from './ui/mcp';

export type Modal =
  | 'settings'
  | 'help'
  | 'samskara-mood'
  | 'intuition'
  | 'bias-profile'
  | 'intents'
  | 'recall';
export type DrawerTab =
  | 'chats'
  | 'groceries'
  | 'recipes'
  | 'memories'
  | 'wiki'
  | 'library'
  | 'artifacts'
  | 'samskara';

export interface Route {
  cid: string | null;
  drawer: DrawerTab | null;
  modal: Modal | null;
  recipe: string | null;
  doc: string | null;
  /**
   * Memory id for the focused memory card. Absent means the panel
   * shows an empty-state hint and the sidebar list is the only surface
   * with content.
   */
  memory: string | null;
  /**
   * Wiki article id for the focused article panel. Absent means the
   * panel shows an empty-state hint and the sidebar listing is the
   * only surface with content. Same shape as `memory` - the Wiki tab
   * mirrors the Memories tab's "list in drawer, single card in
   * panel" pattern.
   */
  wiki_article_id: string | null;
  /**
   * Document id for the focused Library document panel. Absent means the
   * panel shows the upload / empty-state surface and the sidebar listing is
   * the only content. Same shape as `wiki_article_id` - the Library tab
   * mirrors the Wiki tab's "list in drawer, single item in panel" pattern.
   */
  document_id: string | null;
  /**
   * Samskara id for the focused samskara in the Corpus panel of the
   * Samskara diagnostics tab. Absent means the panel shows the Health
   * or Summary sub-view, or the Corpus empty-state. Same "list in
   * drawer, detail in panel" shape as `memory` / `wiki_article_id`.
   */
  samskara_id: string | null;
  /**
   * Presence flag ('1') for the Daily digest panel on the Chats tab.
   * Routed (rather than a local flag) so browser back closes the
   * panel and a refresh restores it. Unlike the wiki changelog it is
   * NOT the tab's default surface - absent means the ordinary
   * conversation view.
   */
  digest: string | null;
}

const ROUTED_KEYS = [
  'cid',
  'drawer',
  'modal',
  'recipe',
  'doc',
  'memory',
  'wiki_article_id',
  'document_id',
  'samskara_id',
  'digest',
] as const;
const MODAL_VALUES: readonly Modal[] = [
  'settings',
  'help',
  'samskara-mood',
  'intuition',
  'bias-profile',
  'intents',
  'recall',
];
const DRAWER_VALUES: readonly DrawerTab[] = [
  'chats',
  'groceries',
  'recipes',
  'memories',
  'wiki',
  'library',
  'artifacts',
  'samskara',
];

export const route = $state<Route>({
  cid: null,
  drawer: null,
  modal: null,
  recipe: null,
  doc: null,
  memory: null,
  wiki_article_id: null,
  document_id: null,
  samskara_id: null,
  digest: null,
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
    memory: readString(params, 'memory'),
    wiki_article_id: readString(params, 'wiki_article_id'),
    document_id: readString(params, 'document_id'),
    samskara_id: readString(params, 'samskara_id'),
    digest: readString(params, 'digest'),
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
  if (r.memory) params.set('memory', r.memory);
  if (r.wiki_article_id) params.set('wiki_article_id', r.wiki_article_id);
  if (r.document_id) params.set('document_id', r.document_id);
  if (r.samskara_id) params.set('samskara_id', r.samskara_id);
  if (r.digest) params.set('digest', r.digest);
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
  if (patch.memory !== undefined && patch.memory !== route.memory) {
    route.memory = patch.memory;
    changed = true;
  }
  if (
    patch.wiki_article_id !== undefined &&
    patch.wiki_article_id !== route.wiki_article_id
  ) {
    route.wiki_article_id = patch.wiki_article_id;
    changed = true;
  }
  if (patch.document_id !== undefined && patch.document_id !== route.document_id) {
    route.document_id = patch.document_id;
    changed = true;
  }
  if (patch.samskara_id !== undefined && patch.samskara_id !== route.samskara_id) {
    route.samskara_id = patch.samskara_id;
    changed = true;
  }
  if (patch.digest !== undefined && patch.digest !== route.digest) {
    route.digest = patch.digest;
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
 * Detect an MCP OAuth callback on boot and stash the code + state for
 * the Settings Integrations pane to complete the token exchange.
 *
 * The OAuth provider redirects back to `origin/?code=...&state=...`
 * (no hash fragment - OAuth 2.1 forbids fragments in redirect URIs).
 * This detects `code` + `state` in `location.search`, stashes them in
 * sessionStorage under the keys the Settings pane reads (see
 * src/lib/ui/mcp.ts), and cleans the URL so the app boots without
 * stray OAuth params in the address bar.
 *
 * No-op when there are no code + state params. Runs once at the top of
 * `initRouting()` (the boot-time URL handler) so the stash lands before
 * any pane mounts and reads it.
 */
function consumeMcpCallbackParams(): void {
  if (typeof window === 'undefined') return;
  const params = new URLSearchParams(window.location.search);
  const code = params.get('code');
  const state = params.get('state');
  if (!code) return;
  sessionStorage.setItem(MCP_CALLBACK_CODE_KEY, code);
  if (state) sessionStorage.setItem(MCP_CALLBACK_STATE_KEY, state);
  // Strip the OAuth params so the address bar is clean on boot and the
  // routing parse doesn't see stray code/state keys. Preserve any
  // routed keys (cid / drawer / modal) the user had in the URL.
  params.delete('code');
  params.delete('state');
  const remaining = params.toString();
  const cleanSearch = remaining ? `?${remaining}` : '';
  history.replaceState(null, '', window.location.pathname + cleanSearch);
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
  // Drain an MCP OAuth callback BEFORE the route parse so the
  // stash lands in sessionStorage and the OAuth params are cleared
  // from the URL ahead of syncFromUrl.
  consumeMcpCallbackParams();
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
    route.memory = null;
    route.wiki_article_id = null;
    route.document_id = null;
    route.samskara_id = null;
    route.digest = null;
  },
  syncFromUrl,
};
