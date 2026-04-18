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

import { marked } from 'marked';
import DOMPurify from 'dompurify';
import markedKatex from 'marked-katex-extension';
import { canLoad, ensureLanguage, highlight, isSupported, normalizeLang } from './highlight';

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
  const normalized = normalizeLang(lang ?? '');
  const highlighted = normalized && isSupported(normalized);
  // If the grammar hasn't been registered yet but we know how to fetch it,
  // kick off the import as a side effect. This render falls back to
  // unhighlighted escaped text; once the module lands, <Markdown>'s
  // `onLanguageLoaded` subscriber re-renders and this branch takes the
  // highlighted path. Fire-and-forget is safe — `ensureLanguage` dedupes.
  if (!highlighted && normalized && canLoad(normalized)) {
    void ensureLanguage(normalized);
  }
  const body = highlighted ? highlight(text, normalized) : escapeHtml(text);
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
// `$...$` for inline, `$$...$$` for block math. Output stays as inline HTML
// so DOMPurify can scrub it along with the rest.
marked.use(markedKatex({ throwOnError: false, output: 'html' }));

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
      node.setAttribute('rel', 'noopener noreferrer nofollow');
      node.setAttribute('target', '_blank');
    }
  });
  hookRegistered = true;
}

export function renderMarkdown(src: string): string {
  if (typeof src !== 'string' || src.length === 0) return '';
  registerLinkHardening();
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

export const __test = {
  ALLOWED_TAGS,
  ALLOWED_ATTR,
};
