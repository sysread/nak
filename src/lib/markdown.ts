/**
 * Markdown → sanitized HTML.
 *
 * Pipeline:
 *   marked(src, extensions) → DOMPurify(html, ALLOWLIST) → string safe to {@html}.
 *
 * Extensions in play:
 *   - GFM (tables, autolinks, strikethrough) via marked's built-in flag.
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
    KEEP_CONTENT: true,
    ALLOWED_URI_REGEXP: /^(?:(?:https?|mailto|tel):|#|\/|\.\/|\.\.\/)/i,
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
