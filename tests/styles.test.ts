/**
 * Guardrail for the production CSS bundle.
 *
 * The symptom we're protecting against: a stray `}` once slipped into
 * `src/styles.css`. Vite's dev server was forgiving enough to keep
 * rendering, and `pnpm check` / `pnpm test` don't parse CSS, so the
 * error only surfaced at `pnpm build` — i.e. the GitHub Pages deploy
 * workflow — *after* the tests job had already gone green. Running
 * postcss over the file here catches the same class of error in the
 * normal test pass, so a broken stylesheet can't make it to main.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import postcss from 'postcss';
import { describe, it, expect } from 'vitest';

const srcDir = join(__dirname, '..', 'src');

function findCssFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...findCssFiles(full));
    } else if (entry.isFile() && entry.name.endsWith('.css')) {
      out.push(full);
    }
  }
  return out;
}

describe('stylesheets parse cleanly', () => {
  const files = findCssFiles(srcDir);

  it('src/ contains at least one stylesheet', () => {
    expect(files.length).toBeGreaterThan(0);
  });

  // One case per file so a failure names the offending stylesheet rather
  // than collapsing all of them into a single "CSS broken" line.
  for (const file of files) {
    const rel = file.slice(srcDir.length + 1);
    it(`${rel} parses without syntax errors`, () => {
      const css = readFileSync(file, 'utf8');
      // postcss.parse throws a CssSyntaxError on malformed input (e.g.
      // a stray `}`, an unterminated block, a missing selector). Its
      // error messages already include file:line:column, so we just let
      // them propagate to the test reporter.
      expect(() => postcss.parse(css, { from: file })).not.toThrow();
    });
  }
});
