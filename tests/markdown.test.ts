import { describe, it, expect } from 'vitest';
import { renderMarkdown } from '../src/lib/markdown';
import { canLoad, ensureLanguage, isSupported } from '../src/lib/highlight';

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
    // `js` normalizes to `javascript` via the highlight alias table.
    const fenced = renderMarkdown('```js\nconst x = 1;\n```');
    expect(fenced).toMatch(/<pre><code[^>]*class="[^"]*language-javascript[^"]*"[^>]*>/);
    expect(fenced).toMatch(/const/);
  });

  it('wraps fenced code blocks in a .code-block with a copy button', () => {
    // The wrapper is what gives the absolutely-positioned copy button a
    // stable anchor, and the button itself is what Markdown.svelte
    // delegates clicks to. If either shape changes, the UI breaks
    // silently — this test is the gate that keeps them in sync.
    const html = renderMarkdown('```\nhello\n```');
    expect(html).toMatch(/<div class="code-block">/);
    expect(html).toMatch(/<button[^>]*class="copy-code-btn"[^>]*>Copy<\/button>/);
    // The <pre> must stay inside the wrapper, not become a sibling.
    expect(html).toMatch(/<div class="code-block">[\s\S]*<pre>[\s\S]*<\/pre>[\s\S]*<\/div>/);
  });

  it('applies hljs token spans for supported languages', () => {
    const html = renderMarkdown('```python\ndef hello(): return 1\n```');
    // highlight.js emits <span class="hljs-keyword">def</span> etc.
    expect(html).toMatch(/class="hljs-keyword"/);
    // And tags the code block with `hljs` so CSS can theme it.
    expect(html).toMatch(/<code[^>]*class="[^"]*\bhljs\b[^"]*"/);
  });

  it('leaves unknown languages as plain escaped code', () => {
    const html = renderMarkdown('```mystery\nfoo bar\n```');
    // Unknown langs get no language-/hljs class and no token spans.
    expect(html).not.toMatch(/class="[^"]*hljs/);
    expect(html).not.toMatch(/class="[^"]*language-/);
    expect(html).toMatch(/foo bar/);
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

  describe('citation superscripts', () => {
    it('renders a single ^N^ as a sup with an in-page anchor', () => {
      // Venice marks sourced claims with `^N^` caret-wrapped runs; we
      // turn each into a <sup> carrying an anchor that the Chat UI's
      // click delegation interprets as "expand citation N."
      const html = renderMarkdown('Some fact. ^2^');
      expect(html).toMatch(
        /<sup class="citation-sup"><a href="#cite-2" class="citation-ref"[^>]*>2<\/a><\/sup>/
      );
    });

    it('renders ^i,j^ as one sup containing both anchors', () => {
      // Multi-source citations come in two shapes — `^2^,^5^` (two
      // separate sups, plain comma between) and `^2,5^` (one sup
      // with both numbers). This test covers the latter.
      const html = renderMarkdown('Sources ^2,5^ confirm.');
      expect(html).toMatch(
        /<sup class="citation-sup"><a href="#cite-2"[^>]*>2<\/a>,<a href="#cite-5"[^>]*>5<\/a><\/sup>/
      );
    });

    it('leaves non-digit ^...^ runs as plain text', () => {
      // A literal caret in prose ("^C^C") must not match — only
      // digit-bounded patterns are citation candidates. Without this,
      // any inline "pointing up" phrasing the model used would eat
      // the rest of the line as a failed citation.
      const html = renderMarkdown('press ^C^ to copy');
      expect(html).not.toMatch(/citation-sup/);
    });

    it('does not expand ^N^ patterns inside fenced code', () => {
      // The marked extension runs at the inline level; code fences
      // are a block token whose body is never re-tokenized. Source
      // text like `^1^` inside a fence should stay as-is so the user
      // sees their literal characters, not a synthesized citation.
      const html = renderMarkdown('```\ntext ^1^ here\n```');
      expect(html).not.toMatch(/citation-sup/);
      expect(html).toMatch(/text \^1\^ here/);
    });

    it('keeps #cite- anchors in-page (no target=_blank, no rel)', () => {
      // The link-hardening hook rewrites external anchors with
      // target/rel for safety — but in-page citation anchors must
      // stay navigable inside the conversation view, since the
      // click handler preventDefaults and opens the panel. An empty
      // new tab would otherwise land on every citation click.
      const html = renderMarkdown('Fact. ^1^');
      const anchor = /<a href="#cite-1"[^>]*>/.exec(html)?.[0] ?? '';
      expect(anchor).not.toMatch(/target=/);
      expect(anchor).not.toMatch(/rel=/);
    });
  });

  it('renders inline math via $...$', () => {
    const html = renderMarkdown('Einstein said $E = mc^2$.');
    // KaTeX emits a `<span class="katex">…</span>` wrapper.
    expect(html).toMatch(/<span class="katex/);
    // The E symbol should survive the transform.
    expect(html).toContain('mord');
  });

  it('renders block math via $$...$$', () => {
    const html = renderMarkdown('$$\\int_0^1 x^2 dx$$');
    expect(html).toMatch(/<span class="katex/);
    // Block-form emits an extra wrapper.
    expect(html).toMatch(/katex-display/);
  });

  it('tolerates malformed math without throwing', () => {
    // `throwOnError: false` should inline-render the error rather than
    // blow up the whole message.
    const html = renderMarkdown('broken: $\\frac{1}{$');
    expect(typeof html).toBe('string');
    expect(html.length).toBeGreaterThan(0);
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

describe('renderMarkdown — dynamic language loading', () => {
  it('reports ocaml as loadable but not statically supported', () => {
    // `ocaml` isn't in the eager-register list — it should arrive via the
    // dynamic loader instead.
    expect(isSupported('ocaml')).toBe(false);
    expect(canLoad('ocaml')).toBe(true);
  });

  it('first render of a ```ocaml fence falls back to plain escaped text', () => {
    // Module state is shared across tests in this file; run this before
    // awaiting `ensureLanguage('ocaml')` so we observe the pre-load render.
    const html = renderMarkdown('```ocaml\nlet x = 1\n```');
    expect(html).not.toMatch(/class="[^"]*hljs/);
    expect(html).not.toMatch(/class="[^"]*language-ocaml/);
    expect(html).toMatch(/let x = 1/);
  });

  it('registers the grammar after ensureLanguage resolves, and subsequent renders are highlighted', async () => {
    const ok = await ensureLanguage('ocaml');
    expect(ok).toBe(true);
    expect(isSupported('ocaml')).toBe(true);

    const html = renderMarkdown('```ocaml\nlet x = 1\n```');
    expect(html).toMatch(/<code[^>]*class="[^"]*\bhljs\b[^"]*"/);
    expect(html).toMatch(/class="[^"]*language-ocaml/);
  });

  it('alias `hs` resolves through to the haskell loader', async () => {
    const ok = await ensureLanguage('hs');
    expect(ok).toBe(true);
    expect(isSupported('haskell')).toBe(true);
    const html = renderMarkdown('```hs\nmain = putStrLn "hi"\n```');
    expect(html).toMatch(/class="[^"]*language-haskell/);
  });

  it('ensureLanguage for a truly unknown language resolves to false', async () => {
    expect(await ensureLanguage('not-a-real-language-xyz')).toBe(false);
  });
});
