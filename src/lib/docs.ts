/**
 * Doc loaders for the in-app Help modal and the `research_docs` tool.
 *
 * Role:
 *   Vite picks up every `.md` under `docs/user/` (and, separately,
 *   `docs/dev/`) at the project root and turns each into a raw-string
 *   chunk. This module exposes the glob maps behind a tiny API: the
 *   Help screen drives the user-doc side ("does this doc exist", "give
 *   me its source", "turn this relative href into a canonical doc
 *   path"), and the `research_docs` tool drives both sides (flat
 *   list + raw load, no path resolution).
 *
 * Why bundle instead of fetch at runtime:
 *   Nak is a PWA. If the docs lived under `public/` we'd still need to
 *   teach the service worker to cache them; `import.meta.glob` puts
 *   them into the normal Vite build graph, which means they ship with
 *   every release and work offline on the first install. Lazy (non-
 *   eager) loading keeps the initial bundle small — each doc is its own
 *   chunk and only lands when the user navigates to it (Help modal) or
 *   the research tool fires (fast-tier sub-completion).
 *
 * Path convention:
 *   `loadDoc` / `hasDoc` / `resolveDocPath` take and return paths
 *   *relative to* `docs/user/`. `listDevDocs` / `loadDevDoc` mirror
 *   that for `docs/dev/`. The full `/docs/<tree>/` prefix is an
 *   internal implementation detail of the glob map and never leaks
 *   out; callers that need to disambiguate across trees (only
 *   `research_docs` today) prefix the returned path themselves.
 *
 * Security:
 *   `resolveDocPath` rejects anything that escapes the `docs/user/`
 *   subtree (via the URL constructor against a synthetic base). That
 *   means a malicious internal link like `../../secret.md` can't trick
 *   the loader into pulling a module it didn't intend to expose.
 *   Combined with `hasDoc`, the returned path is always a known,
 *   bundle-verified doc. The dev-doc surface deliberately skips the
 *   resolve/hasDoc layer: the Help modal never renders dev docs, and
 *   the research tool only iterates `listDevDocs()` output — no user
 *   href is ever resolved against the dev tree, so there's no attack
 *   surface to protect.
 */

// The glob itself. Vite resolves `/`-prefixed globs against the project
// root, so this catches every markdown file under `docs/user/` no
// matter how deep. `query: '?raw'` + `import: 'default'` asks Vite for
// the file's text content (not a module object). Non-eager: each entry
// is a `() => Promise<string>` thunk, so only docs the user actually
// opens land in the main-thread chunk budget.
const docModules = import.meta.glob('/docs/user/**/*.md', {
  query: '?raw',
  import: 'default',
}) as Record<string, () => Promise<string>>;

const DOC_PREFIX = '/docs/user/';

/** Every doc path we know about (keys are relative to `docs/user/`). */
export function listDocs(): string[] {
  return Object.keys(docModules)
    .map((k) => k.slice(DOC_PREFIX.length))
    .sort();
}

/** True if `path` (relative to `docs/user/`) names a bundled doc. */
export function hasDoc(path: string): boolean {
  return Object.prototype.hasOwnProperty.call(docModules, DOC_PREFIX + path);
}

/**
 * Load the raw markdown for a doc. Throws if the path isn't in the
 * bundle — the caller is expected to have already classified the link
 * via `resolveDocPath`, so a miss here indicates a bug (a bad link
 * slipped through) rather than a user-input problem.
 */
export async function loadDoc(path: string): Promise<string> {
  const loader = docModules[DOC_PREFIX + path];
  if (!loader) throw new Error(`Unknown doc: ${path}`);
  return await loader();
}

/**
 * True if `href` is a link to something outside the docs tree — an
 * absolute URL with an explicit scheme, or a protocol-relative URL.
 * Used by the Help modal to decide whether to intercept a click or let
 * the browser follow it (DOMPurify already tagged the anchor with
 * `target="_blank"`).
 *
 * Scheme regex matches the RFC 3986 "scheme" production: ALPHA
 * followed by ALPHA / DIGIT / "+" / "-" / ".". Case-insensitive.
 */
export function isExternalHref(href: string): boolean {
  if (href.startsWith('//')) return true;
  return /^[a-z][a-z0-9+\-.]*:/i.test(href);
}

export interface ResolvedDoc {
  path: string;
  hash: string;
}

/**
 * Resolve a relative href (the kind `marked` emits for a markdown
 * link like `[text](./foo.md#sec)`) against the doc the user is
 * currently looking at. Returns `null` if the resolved path escapes
 * the `docs/user/` subtree or names a doc we don't have.
 *
 * `currentPath` is expected to be relative to `docs/user/` — the
 * format `loadDoc` accepts. A doc one directory deep (e.g.
 * `sub/page.md`) resolves `../foo.md` correctly because we feed
 * `currentPath` straight into the synthetic-base URL.
 */
export function resolveDocPath(currentPath: string, href: string): ResolvedDoc | null {
  // Synthetic base: an `https:` URL whose path mirrors the real
  // `docs/user/` layout. Using `https:` (rather than a fake scheme)
  // guarantees predictable URL-normalization — non-special schemes
  // have subtly different resolution rules across runtimes. The host
  // is a sentinel that can't exist in practice, which is paranoia
  // rather than a real defense: absolute URLs and protocol-relative
  // hrefs are already classified as external by `isExternalHref` and
  // never reach this function.
  let resolved: URL;
  try {
    resolved = new URL(href, 'https://nak.docs.invalid' + DOC_PREFIX + currentPath);
  } catch {
    return null;
  }
  // An absolute href with a different origin would slip past the
  // `isExternalHref` check only if that check were skipped. Belt and
  // braces: reject anything that left our synthetic host.
  if (resolved.host !== 'nak.docs.invalid') return null;
  if (!resolved.pathname.startsWith(DOC_PREFIX)) return null;
  const path = resolved.pathname.slice(DOC_PREFIX.length);
  if (!hasDoc(path)) return null;
  // `URL.hash` includes the leading `#`; strip it so callers can treat
  // an empty string as "no anchor" without parsing.
  const hash = resolved.hash.startsWith('#') ? resolved.hash.slice(1) : '';
  return { path, hash };
}

// --- Developer docs --------------------------------------------------
//
// Parallel glob for `docs/dev/` - the architecture + per-feature dev
// notes that ship alongside the user manual. Not reachable from the
// Help modal (it renders only `docs/user/`); the single consumer is
// the `research_docs` tool, which bundles this corpus into its sub-
// completion system prompt when the caller passes
// `include_internal_dev_docs: true`. Kept as its own glob rather than
// a union with the user tree so the default research path (user docs
// only) doesn't pay the ~200 KB dev-docs cost on every call.

const devDocModules = import.meta.glob('/docs/dev/**/*.md', {
  query: '?raw',
  import: 'default',
}) as Record<string, () => Promise<string>>;

const DEV_DOC_PREFIX = '/docs/dev/';

/** Every dev-doc path we know about (keys are relative to `docs/dev/`). */
export function listDevDocs(): string[] {
  return Object.keys(devDocModules)
    .map((k) => k.slice(DEV_DOC_PREFIX.length))
    .sort();
}

/**
 * Load the raw markdown for a dev doc. Throws if the path isn't in
 * the bundle - the single caller (`research_docs`) only ever passes
 * paths returned by `listDevDocs()`, so a miss here is a bug rather
 * than a user-input problem.
 */
export async function loadDevDoc(path: string): Promise<string> {
  const loader = devDocModules[DEV_DOC_PREFIX + path];
  if (!loader) throw new Error(`Unknown dev doc: ${path}`);
  return await loader();
}
