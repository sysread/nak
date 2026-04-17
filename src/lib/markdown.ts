/**
 * Markdown → sanitized HTML.
 *
 * Pipeline:
 *   marked(src) → DOMPurify(html, ALLOWLIST) → string safe to {@html}.
 *
 * Security stance:
 *   - Raw HTML in the source is dropped by marked's token stream when
 *     `html: false`, and anything that slips through is scrubbed by
 *     DOMPurify's element/attribute allowlist.
 *   - Images are disabled (no network fetch triggered by model output).
 *   - Links are rewritten with `rel="noopener noreferrer nofollow"` and
 *     `target="_blank"` via a post-sanitize hook. `javascript:` /
 *     `data:` URLs are rejected by DOMPurify's built-in URI filter.
 */

import { marked } from 'marked';
import DOMPurify from 'dompurify';

// ---------------------------------------------------------------------------
// marked configuration
// ---------------------------------------------------------------------------

marked.setOptions({
  gfm: true,          // GitHub-flavored markdown: autolinks, tables, strikethrough
  breaks: false,      // don't convert single newlines inside paragraphs to <br>
  // Explicit: treat the source as untrusted. marked doesn't have a flag to
  // strip inline HTML the way some libs do, but DOMPurify handles it on the
  // output side.
});

// Disable image rendering entirely — swap the renderer so `![alt](src)` is
// turned into a plain text fallback. This prevents the browser from making
// outbound requests to model-supplied URLs just because a message rendered.
const renderer = new marked.Renderer();
renderer.image = ({ text, title }: { text: string; title?: string | null }) => {
  const label = (title || text || 'image').replace(/[<>]/g, '');
  return `<span class="md-image-stub">[image: ${label}]</span>`;
};
marked.use({ renderer });

// ---------------------------------------------------------------------------
// DOMPurify configuration
// ---------------------------------------------------------------------------

const ALLOWED_TAGS = [
  'a',
  'b',
  'blockquote',
  'br',
  'code',
  'del',
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
  'span',       // used by our image stub
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

const ALLOWED_ATTR = ['href', 'title', 'class', 'lang', 'align', 'start'];

// Harden external links: open in a new tab, strip referrer and opener.
// Registered lazily (on first render) so SSR / non-DOM test envs don't crash.
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
  // marked.parse is sync when no async extensions are registered.
  const html = marked.parse(src, { async: false }) as string;
  return DOMPurify.sanitize(html, {
    ALLOWED_TAGS,
    ALLOWED_ATTR,
    // Keep text content of disallowed tags so we don't lose the model's
    // words when it emits something unexpected.
    KEEP_CONTENT: true,
    // Disallow `javascript:` / `data:` / `vbscript:` URIs explicitly.
    ALLOWED_URI_REGEXP: /^(?:(?:https?|mailto|tel):|#|\/|\.\/|\.\.\/)/i,
  });
}

export const __test = {
  ALLOWED_TAGS,
  ALLOWED_ATTR,
};
