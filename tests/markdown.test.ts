import { describe, it, expect } from 'vitest';
import { renderMarkdown } from '../src/lib/markdown';

describe('renderMarkdown — happy paths', () => {
  it('returns empty string for empty or non-string input', () => {
    expect(renderMarkdown('')).toBe('');
    expect(renderMarkdown(undefined as unknown as string)).toBe('');
  });

  it('renders bold/italic/strike', () => {
    const html = renderMarkdown('**bold** *italic* ~~strike~~');
    expect(html).toMatch(/<strong>bold<\/strong>/);
    expect(html).toMatch(/<em>italic<\/em>/);
    expect(html).toMatch(/<del>strike<\/del>/);
  });

  it('renders headings', () => {
    const html = renderMarkdown('# h1\n## h2\n### h3');
    expect(html).toMatch(/<h1[^>]*>h1<\/h1>/);
    expect(html).toMatch(/<h2[^>]*>h2<\/h2>/);
    expect(html).toMatch(/<h3[^>]*>h3<\/h3>/);
  });

  it('renders ordered and unordered lists', () => {
    const ul = renderMarkdown('- a\n- b');
    expect(ul).toMatch(/<ul>[\s\S]*<li>a<\/li>[\s\S]*<li>b<\/li>[\s\S]*<\/ul>/);
    const ol = renderMarkdown('1. a\n2. b');
    expect(ol).toMatch(/<ol[^>]*>[\s\S]*<li>a<\/li>[\s\S]*<\/ol>/);
  });

  it('renders inline code and fenced code blocks', () => {
    expect(renderMarkdown('use `foo` here')).toMatch(/<code>foo<\/code>/);
    const fenced = renderMarkdown('```js\nconst x = 1;\n```');
    expect(fenced).toMatch(/<pre><code[^>]*class="[^"]*language-js[^"]*"[^>]*>/);
    expect(fenced).toMatch(/const x = 1;/);
  });

  it('renders GFM tables', () => {
    const html = renderMarkdown('| a | b |\n|---|---|\n| 1 | 2 |');
    expect(html).toMatch(/<table>/);
    expect(html).toMatch(/<th[^>]*>a<\/th>/);
    expect(html).toMatch(/<td[^>]*>1<\/td>/);
  });

  it('renders blockquotes and horizontal rules', () => {
    expect(renderMarkdown('> quoted')).toMatch(/<blockquote>[\s\S]*quoted[\s\S]*<\/blockquote>/);
    expect(renderMarkdown('---')).toMatch(/<hr\s*\/?>/);
  });

  it('autolinks bare URLs under GFM', () => {
    const html = renderMarkdown('see https://example.com for more');
    expect(html).toMatch(/<a [^>]*href="https:\/\/example\.com"/);
  });
});

describe('renderMarkdown — security', () => {
  it('strips raw <script> tags', () => {
    const html = renderMarkdown('hello <script>alert(1)</script> world');
    expect(html).not.toMatch(/<script/);
    expect(html).not.toMatch(/alert\(1\)/);
  });

  it('strips event-handler attributes like onclick from inlined HTML', () => {
    const html = renderMarkdown('<span onclick="alert(1)">x</span>');
    // Look for the attribute name adjacent to `=` rather than just the
    // substring "onclick", which could legitimately appear inside a
    // title="onclick=..." value.
    expect(html).not.toMatch(/\bonclick\s*=/i);
    expect(html).not.toMatch(/alert\(1\)/);
  });

  it('rejects javascript: URLs in markdown links', () => {
    // eslint-disable-next-line no-script-url
    const html = renderMarkdown('[click](javascript:alert(1))');
    expect(html).not.toMatch(/javascript:/i);
  });

  it('rejects data: URLs in markdown links', () => {
    const html = renderMarkdown('[click](data:text/html,<script>1</script>)');
    expect(html).not.toMatch(/data:/i);
  });

  it('does not render images — converts to an inline stub', () => {
    const html = renderMarkdown('![pixel](https://evil.example/track.gif)');
    expect(html).not.toMatch(/<img/);
    expect(html).toMatch(/\[image: pixel\]/);
  });

  it('adds rel and target to external links', () => {
    const html = renderMarkdown('[go](https://example.com)');
    expect(html).toMatch(/rel="noopener noreferrer nofollow"/);
    expect(html).toMatch(/target="_blank"/);
  });

  it('drops raw HTML elements from the source', () => {
    const html = renderMarkdown('<iframe src="https://evil.example"></iframe>');
    expect(html).not.toMatch(/<iframe/);
  });
});
