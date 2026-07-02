/**
 * Markdown → sanitized HTML.
 *
 * Pipeline:
 *   marked(src, extensions) → DOMPurify(html, ALLOWLIST) → string safe to {@html}.
 *
 * Extensions in play:
 *   - GFM (tables, autolinks, strikethrough) via marked's built-in flag.
 *     GFM autolinks cover scheme'd URLs (`https://...`) and `www.`-
 *     prefixed domains; a custom `bareUrl` extension below extends that
 *     to schemeless, non-www domains (`example.com`) against a curated
 *     TLD allowlist.
 *   - Fenced code blocks run through Prism for syntax highlighting when a
 *     language tag is present and supported.
 *   - `$inline$` / `$$block$$` math runs through KaTeX (HTML output).
 *
 * Security stance:
 *   - Raw HTML in source is scrubbed by DOMPurify's element/attribute
 *     allowlist.
 *   - Images are disabled (no network fetch triggered by model output).
 *   - Links are rewritten with `rel="noopener noreferrer nofollow"` and
 *     `target="_blank"` via a post-sanitize hook. `javascript:`/`data:`
 *     URLs are rejected by DOMPurify's URI regex.
 *   - KaTeX runs in `trust: false, strict: false` mode (default) so it
 *     won't emit `\href` links or other side-channel content.
 */

import { marked, type Tokens } from 'marked';
import DOMPurify from 'dompurify';

// `./highlight` is not statically imported - the entire highlight.js
// stack (engine + 26 eager language grammars + the dynamic-loader
// machinery for the rest) lives in its own chunk that lands the
// first time a code fence shows up. Until then, fenced code
// renders as plain escaped text. When the chunk arrives, the
// existing per-language re-render notification fires once for the
// module itself, the listeners in <Markdown> bump their version
// counter, and the next render goes down the highlighted path.
//
// `prewarmHighlight()` is the test-only escape hatch: synchronous
// vitest assertions on highlighted output need the module loaded
// before the assertion fires, so test files call it in a beforeAll
// instead of restructuring around the lazy load.
type HighlightModule = typeof import('./highlight');
let hl: HighlightModule | null = null;
let hlPromise: Promise<HighlightModule> | null = null;
const highlightListeners = new Set<() => void>();

function ensureHighlightLoading(): void {
  if (hl || hlPromise) return;
  hlPromise = import('./highlight').then((m) => {
    hl = m;
    // Forward each subscriber that registered before the module
    // landed to the loaded module's onLanguageLoaded so future
    // per-language fetches still trigger their re-renders.
    for (const cb of highlightListeners) m.onLanguageLoaded(cb);
    // Fire one notification so anyone who's been waiting for the
    // module to land re-renders now - the next render's
    // `isSupported(lang)` will return true for any of the 26 eager
    // languages that the previous render fell back to plain text.
    for (const cb of highlightListeners) cb();
    return m;
  });
}

/**
 * Subscribe to "a language (or the highlight module itself) just
 * loaded." Returns an unsubscribe. Used by `<Markdown>` to bump a
 * version counter and re-render after a fence's grammar arrives.
 *
 * Re-exported through this module so callers (Markdown.svelte) don't
 * need to reach into `./highlight` directly - that would defeat the
 * lazy split by pulling the module into the importer's chunk.
 */
export function onLanguageLoaded(cb: () => void): () => void {
  highlightListeners.add(cb);
  if (hl) {
    // Module already loaded; forward directly so per-language
    // events fire as before. Composed unsubscribe tears down both
    // sides.
    const unsub = hl.onLanguageLoaded(cb);
    return () => {
      highlightListeners.delete(cb);
      unsub();
    };
  }
  return () => {
    highlightListeners.delete(cb);
  };
}

/**
 * Test-only: await the lazy `import('./highlight')` so synchronous
 * vitest assertions on highlighted output can run against a fully-
 * loaded module. Production code never needs to call this; the
 * lazy load fires automatically on the first fenced render.
 */
export async function prewarmHighlight(): Promise<void> {
  if (hl) return;
  ensureHighlightLoading();
  if (hlPromise) await hlPromise;
}

// `marked-katex-extension` (and its KaTeX dependency) is the other
// heavy markdown addon - the compiled font shapes plus the renderer
// land at ~280 kB unpacked. Most chats never use math, so the
// extension is dynamically imported on the first markdown render
// that contains a `$` character. Until the chunk lands, `$x^2$`
// renders as plain text (which is what marked produces without the
// extension registered). When the chunk arrives, we register the
// extension with marked and fire the same `onLanguageLoaded`
// notification used for highlight - <Markdown> bumps its version
// and re-renders, this time with the extension active.
//
// `prewarmKatex()` is the test-only escape hatch for synchronous
// vitest assertions on KaTeX-rendered output, parallel to
// `prewarmHighlight()`.
let katexLoaded = false;
let katexPromise: Promise<unknown> | null = null;

function ensureKatexLoading(): void {
  if (katexLoaded || katexPromise) return;
  katexPromise = import('marked-katex-extension').then((m) => {
    // Register exactly once. `throwOnError: false` means malformed
    // math inline-renders an error glyph instead of bubbling up
    // through marked's parse - protects the rest of the message.
    // `output: 'html'` keeps the generated tree DOMPurify-friendly
    // (no MathML ambient namespaces).
    marked.use(m.default({ throwOnError: false, output: 'html' }));
    katexLoaded = true;
    // Fire the unified listener notification so anyone waiting
    // (typically <Markdown>) re-renders the message that just had
    // its `$x^2$` show up as plain text.
    for (const cb of highlightListeners) cb();
  });
}

/**
 * Test-only: await the lazy KaTeX/marked-katex import so
 * synchronous vitest assertions on math-rendered output can run
 * against a fully-loaded extension. Production code never needs
 * to call this; the lazy load fires automatically on the first
 * render whose source contains `$`.
 */
export async function prewarmKatex(): Promise<void> {
  if (katexLoaded) return;
  ensureKatexLoading();
  if (katexPromise) await katexPromise;
}

// ---------------------------------------------------------------------------
// marked configuration
// ---------------------------------------------------------------------------

marked.setOptions({
  gfm: true,
  breaks: false,
});

// Override the renderer:
//   - image: replace with an inline text stub so the browser never fetches
//     the URL a model output.
//   - code: Prism-highlight and wrap in <pre><code class="language-...">.
const renderer = new marked.Renderer();

renderer.image = ({ text, title }: { text: string; title?: string | null }) => {
  const label = (title || text || 'image').replace(/[<>]/g, '');
  return `<span class="md-image-stub">[image: ${label}]</span>`;
};

renderer.code = ({ text, lang }: { text: string; lang?: string }) => {
  // First fence triggers the lazy load. Until the module lands,
  // every fence renders as plain escaped text - same fallback the
  // per-language DYNAMIC_LOADERS path uses. Fire-and-forget; the
  // import is deduped inside ensureHighlightLoading.
  if (lang) ensureHighlightLoading();
  const normalized = hl ? hl.normalizeLang(lang ?? '') : '';
  const highlighted = !!hl && !!normalized && hl.isSupported(normalized);
  // If the grammar hasn't been registered yet but we know how to
  // fetch it, kick off the import as a side effect. The module-
  // level highlightListeners notification re-renders this fence
  // once the language lands. Fire-and-forget is safe -
  // ensureLanguage dedupes its own pending map.
  if (hl && !highlighted && normalized && hl.canLoad(normalized)) {
    void hl.ensureLanguage(normalized);
  }
  const body = highlighted && hl ? hl.highlight(text, normalized) : escapeHtml(text);
  const classes: string[] = [];
  if (highlighted) classes.push('hljs', `language-${escapeAttr(normalized)}`);
  const cls = classes.length ? ` class="${classes.join(' ')}"` : '';
  // Wrap every fence in a .code-block div so (1) a "Copy" button can
  // be absolutely positioned inside, and (2) the button has a stable
  // anchor from which a delegated click handler in Markdown.svelte
  // can locate the adjacent <code>. The swap to "Copied!" happens in
  // that delegation handler on click — DOMPurify only permits a
  // static element/attribute set, so we can't attach any script-side
  // behavior to the button from here.
  return (
    `<div class="code-block">` +
      `<button type="button" class="copy-code-btn" aria-label="Copy code">Copy</button>` +
      `<pre><code${cls}>${body}\n</code></pre>` +
    `</div>\n`
  );
};

marked.use({ renderer });
// `$...$` for inline, `$$...$$` for block math. The extension is
// registered lazily by `ensureKatexLoading` the first time
// `renderMarkdown` sees a `$` in the source - see the lazy block
// near the top of this file. Output stays as inline HTML so
// DOMPurify can scrub it along with the rest.

// Venice citation superscripts. The model is instructed (by Venice's
// server-side prompt when `enable_web_citations=true`) to mark sourced
// claims with a `^N^` or `^i,j^` caret-wrapped run of digits. We
// translate those into in-page anchors that (1) read as superscripts
// even without CSS via the `<sup>` element, and (2) jump to / flash
// the corresponding row in the citations panel when clicked. Lives
// as a marked inline extension rather than a regex on the rendered
// HTML so matches inside code fences / code spans are automatically
// skipped — marked's tokenizer never descends into those contexts.
//
// Accepts `^N^`, `^N,M^`, and whitespace-tolerant variants like
// `^1, 2, 3^`. The outer regex is anchored with `^` (start of the
// inline source slice marked hands us), so a stray `^` mid-word
// doesn't match.
interface CitationToken extends Tokens.Generic {
  type: 'citation';
  raw: string;
  numbers: string[];
}
marked.use({
  extensions: [
    {
      name: 'citation',
      level: 'inline',
      start(src: string): number | undefined {
        const idx = src.indexOf('^');
        return idx < 0 ? undefined : idx;
      },
      tokenizer(src: string): Tokens.Generic | undefined {
        const match = /^\^(\d+(?:\s*,\s*\d+)*)\^/.exec(src);
        if (!match) return undefined;
        const numbers = match[1]
          .split(',')
          .map((s) => s.trim())
          .filter((s) => s.length > 0);
        if (numbers.length === 0) return undefined;
        const tok: CitationToken = {
          type: 'citation',
          raw: match[0],
          numbers,
        };
        return tok;
      },
      renderer(token: Tokens.Generic): string {
        const tok = token as CitationToken;
        const links = tok.numbers
          .map(
            (n) =>
              `<a href="#cite-${escapeAttr(n)}" class="citation-ref" ` +
              `title="Source ${escapeAttr(n)}">${escapeHtml(n)}</a>`
          )
          .join(',');
        return `<sup class="citation-sup">${links}</sup>`;
      },
    },
  ],
});

// "Good enough" bare-domain autolinking. marked's GFM extension already
// autolinks scheme'd URLs (`https://example.com`) and `www.`-prefixed
// domains (`www.example.com`) per the GFM autolink spec - but the spec
// deliberately excludes bare domains with neither a scheme nor a `www.`
// prefix (`example.com`, `koaa.com/relief/...`), since without one of
// those signals there's no way to tell a domain-looking string from
// prose ("Node.js", "e.g.", "Acme.Corp"). We accept that ambiguity for
// a curated set of common TLDs so donation-link-style text (bare
// `site.org/path` with no scheme) still renders as a clickable link.
//
// Registered as a separate marked.use() call (rather than folded into
// the citation extensions array above) so the two independent concerns
// stay easy to find/remove separately.
const BARE_URL_TLDS = new Set([
  'com', 'org', 'net', 'edu', 'gov', 'mil', 'int', 'io', 'co', 'ai', 'app',
  'dev', 'info', 'biz', 'tv', 'me', 'us', 'uk', 'ca', 'de', 'fr', 'jp',
  'cn', 'au', 'in', 'ru', 'br', 'eu', 'nl', 'es', 'it', 'se', 'no', 'dk',
  'fi', 'ch', 'at', 'be', 'pl', 'ie', 'nz', 'mx', 'kr', 'cc', 'ly', 'gl',
  'sh', 'to', 'fm', 'im', 'gg', 'je', 'xyz', 'online', 'site', 'tech',
  'store', 'blog', 'cloud', 'digital', 'live', 'news', 'world', 'email',
  'name', 'pro', 'mobi', 'asia', 'coop', 'museum', 'aero', 'jobs',
  'travel', 'tel', 'cat', 'id', 'sg', 'hk', 'tw', 'za', 'ke', 'ng', 'ph',
  'vn', 'th', 'my',
]);

// Matches `label.label.tld` optionally followed by a `/path?query#hash`
// segment. The TLD-length cap (24) and character classes keep the regex
// itself from runaway backtracking; the TLD allowlist is what actually
// filters out prose like "Node.js" or "e.g." (whose final "TLD" isn't in
// the set) once matched.
const BARE_URL_RE =
  /^(?:[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.)+[a-zA-Z]{2,24}(?:\/[^\s<>[\]{}"']*)?/;

// GFM's own trailing-punctuation trimming rule (see the GFM spec's
// "extended autolink" section): strip trailing `?!.,:*_~'"`, then strip
// a trailing `)` only while it's unbalanced against `(` earlier in the
// match - so "(see example.com/foo)" links "example.com/foo" without
// swallowing the closing paren, but "example.com/wiki/Foo_(bar)" keeps
// its balanced paren.
const BARE_URL_TRAILING_RE = /[?!.,:*_~'"]+$/;
function trimBareUrlTrailingPunctuation(url: string): string {
  let trimmed = url.replace(BARE_URL_TRAILING_RE, '');
  while (trimmed.endsWith(')')) {
    const opens = (trimmed.match(/\(/g) ?? []).length;
    const closes = (trimmed.match(/\)/g) ?? []).length;
    if (closes <= opens) break;
    trimmed = trimmed.slice(0, -1);
  }
  return trimmed;
}

interface BareUrlToken extends Tokens.Generic {
  type: 'bareUrl';
  raw: string;
  url: string;
}
marked.use({
  extensions: [
    {
      name: 'bareUrl',
      level: 'inline',
      start(src: string): number | undefined {
        const m = /[a-zA-Z0-9][a-zA-Z0-9-]*\.[a-zA-Z]{2,24}/.exec(src);
        return m ? m.index : undefined;
      },
      tokenizer(src: string, tokens: Tokens.Generic[]): Tokens.Generic | undefined {
        const match = BARE_URL_RE.exec(src);
        if (!match) return undefined;
        // Guard against grabbing the domain half of an email address
        // GFM's own autolink extension declined to match (malformed
        // local part, etc.) - if the previous sibling token ends in
        // `@`, `.`, or `/`, this match is a continuation of something
        // else, not a standalone URL.
        const prev = tokens[tokens.length - 1];
        const prevRaw = prev && typeof prev.raw === 'string' ? prev.raw : '';
        const prevChar = prevRaw.slice(-1);
        if (prevChar === '@' || prevChar === '.' || prevChar === '/') return undefined;
        const url = trimBareUrlTrailingPunctuation(match[0]);
        const tld = /\.([a-zA-Z]{2,24})(?:\/|$)/.exec(url)?.[1]?.toLowerCase();
        if (!tld || !BARE_URL_TLDS.has(tld)) return undefined;
        const tok: BareUrlToken = { type: 'bareUrl', raw: url, url };
        return tok;
      },
      renderer(token: Tokens.Generic): string {
        const tok = token as BareUrlToken;
        // Not escapeAttr() - that helper strips to bare
        // alphanumerics for CSS-class-like tokens (lang names,
        // citation numbers) and would mangle a URL's dots/slashes.
        // The BARE_URL_RE charset already excludes quotes/angle
        // brackets, so escapeHtml is sufficient here.
        const label = escapeHtml(tok.url);
        const href = escapeHtml(`https://${tok.url}`);
        return `<a href="${href}" title="${label}">${label}</a>`;
      },
    },
  ],
});

// ---------------------------------------------------------------------------
// DOMPurify configuration
// ---------------------------------------------------------------------------

const ALLOWED_TAGS = [
  'a',
  'b',
  'blockquote',
  'br',
  // `button` and `div` are needed for the code-fence copy-button
  // wrapper emitted by `renderer.code` above. DOMPurify still strips
  // any event-handler attributes (onclick etc.) from any <button> that
  // a model tries to smuggle in through raw HTML, and the allowlisted
  // attributes below don't include anything script-executing.
  'button',
  'code',
  'del',
  'div',
  'em',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'hr',
  'i',
  'li',
  'ol',
  'p',
  'pre',
  's',
  'span',
  'strong',
  'sub',
  'sup',
  'table',
  'tbody',
  'td',
  'th',
  'thead',
  'tr',
  'u',
  'ul',
];

// `style` is needed for KaTeX's layout (font-size, padding, transforms on
// individual glyph spans). DOMPurify sanitizes the value, rejecting url()
// and other attack vectors, so allowing the attribute here is safe.
// `type` and `aria-label` cover the button we emit for code-fence copy.
const ALLOWED_ATTR = [
  'href',
  'title',
  'class',
  'lang',
  'align',
  'start',
  'style',
  'type',
  'aria-label',
];

let hookRegistered = false;
function registerLinkHardening(): void {
  if (hookRegistered) return;
  DOMPurify.addHook('afterSanitizeAttributes', (node) => {
    if (!(node instanceof Element)) return;
    if (node.tagName === 'A') {
      const href = node.getAttribute('href') ?? '';
      // In-page citation anchors (`#cite-N`) must stay in-page — a
      // `target="_blank"` here would open an empty new tab with the
      // hash, and `rel="noopener..."` reads as link-to-external even
      // though the anchor never navigates. The citation-ref click
      // handler preventDefaults and expands/flashes the panel instead.
      if (href.startsWith('#')) return;
      // Relative `?...` URLs are in-app navigation (the wiki agents
      // emit `?cid=<thread-id>` source links to anchor article facts
      // to their source conversation; the same convention can be used
      // for any of the routed keys in src/lib/routing.svelte.ts).
      // We skip `target="_blank"` so the click stays in the current
      // tab; the surrounding component (e.g. Wiki.svelte) intercepts
      // the click and calls navigate() for soft navigation rather
      // than letting the browser do a full reload.
      if (href.startsWith('?')) return;
      node.setAttribute('rel', 'noopener noreferrer nofollow');
      node.setAttribute('target', '_blank');
    }
  });
  hookRegistered = true;
}

export function renderMarkdown(src: string): string {
  if (typeof src !== 'string' || src.length === 0) return '';
  registerLinkHardening();
  // Cheap source-scan: any `$` in the source COULD be math. False
  // positives ("the cost was $5") are fine - we just kick off the
  // chunk load, the next render uses it, and the cost is a one-
  // time fetch per session for users who happened to use a `$`
  // anywhere. Done before parse so the import is in flight while
  // marked tokenises.
  if (!katexLoaded && src.indexOf('$') !== -1) ensureKatexLoading();
  const html = marked.parse(src, { async: false }) as string;
  return DOMPurify.sanitize(html, {
    ALLOWED_TAGS,
    ALLOWED_ATTR,
    // The `\?` clause is for in-app relative URLs like `?cid=<id>`
    // or `?wiki_article_id=<id>`. The `registerLinkHardening` hook
    // above has explicit handling for `href.startsWith('?')` (skips
    // target="_blank" so the click stays in the current tab); that
    // branch is only reachable if DOMPurify allows the href through
    // in the first place, so the prefix has to live in this regex
    // too. Forgetting it once made the hook effectively dead code
    // and silently turned every `[label](?cid=<uuid>)` source link
    // into bare text without a clickable anchor.
    KEEP_CONTENT: true,
    ALLOWED_URI_REGEXP: /^(?:(?:https?|mailto|tel):|#|\?|\/|\.\/|\.\.\/)/i,
  });
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function escapeAttr(s: string): string {
  return s.replace(/[^a-zA-Z0-9_\-+]/g, '');
}

// ---------------------------------------------------------------------------
// Heading slugger
// ---------------------------------------------------------------------------
//
// Used by surfaces that want anchor IDs on rendered headings - currently
// the Help modal (in-doc `#hash` links) and the Wiki article view (ToC at
// the top of each article). The renderer itself does NOT emit `id`
// attributes; the consumer post-processes the DOM after `{@html}` commits.
//
// Two reasons for that split: (1) DOMPurify's ALLOWED_ATTR list above
// would have to grow to include `id`, which broadens the surface for any
// model-emitted raw HTML to plant arbitrary ids; (2) producing stable,
// collision-free slugs needs per-render state that doesn't compose
// cleanly with marked's stateless renderer overrides.
//
// `slugify` and `uniqueSlug` together produce the same ids the post-
// render effect in Help.svelte / Wiki.svelte assigns to actual <h*>
// elements, so a ToC computed off `extractHeadings` lines up with the
// rendered DOM byte-for-byte.

/**
 * Lower-case, collapse non-word runs to single dashes, strip leading /
 * trailing dashes. Matches the convention most markdown renderers
 * (GitHub, GitLab) use. Empty output falls back to `section` so
 * headings consisting only of punctuation still get a stable id.
 */
export function slugify(text: string): string {
  return text
    .toLowerCase()
    .trim()
    .replace(/[^\w\s-]+/g, '')
    .replace(/[\s_-]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * Slug for `text` with `-2`, `-3`, ... suffixes appended on collision.
 * Mutates `used` so consecutive calls within one render coordinate.
 */
export function uniqueSlug(text: string, used: Set<string>): string {
  const base = slugify(text) || 'section';
  let slug = base;
  let n = 2;
  while (used.has(slug)) slug = `${base}-${n++}`;
  used.add(slug);
  return slug;
}

export interface HeadingEntry {
  /** 1..6 - matches the `<h*>` level marked will emit. */
  level: number;
  /** Display text. Markdown formatting characters are stripped. */
  text: string;
  /** Slug produced by `uniqueSlug` in document order. */
  slug: string;
}

/**
 * Extract top-level ATX / Setext headings from a markdown source. Walks
 * marked's token stream so headings nested inside lists / blockquotes
 * (which marked tokenises as paragraphs, not headings) are correctly
 * skipped. The returned list is in document order with slugs that match
 * what `uniqueSlug` would assign on a fresh `used` set - so the post-
 * render effect that walks `.md h1..h6` and assigns ids using the same
 * algorithm produces the same id sequence.
 */
export function extractHeadings(content: string): HeadingEntry[] {
  if (typeof content !== 'string' || content.length === 0) return [];
  // Same trim as renderMarkdown above - keep heading detection aligned
  // with what actually gets rendered.
  const tokens = marked.lexer(content.trim());
  const used = new Set<string>();
  const out: HeadingEntry[] = [];
  for (const tok of tokens) {
    if (tok.type !== 'heading') continue;
    const h = tok as Tokens.Heading;
    // `tok.text` preserves the raw source including inline markdown
    // chars (`**bold**`, `` `code` ``, etc.). Strip the formatting
    // characters so the ToC reads as plain prose. Slug generation
    // runs on the same cleaned string so the anchor target matches
    // what a manual `#slug` link to that heading would produce.
    const text = h.text.replace(/[*_`~]/g, '').trim();
    out.push({
      level: h.depth,
      text,
      slug: uniqueSlug(text, used),
    });
  }
  return out;
}
