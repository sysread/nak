/**
 * Regression tests for the research-docs corpus generator.
 *
 * The load-bearing one: a doc that quotes an import statement in
 * prose must NOT poison the generated module. The supabase CLI's
 * edge-function scanner is a regex over raw source, not a parser, so
 * a literal `import './x.ts';` inside an emitted string gets resolved
 * as a real import from the corpus's directory and kills the entire
 * local edge runtime at startup (observed 2026-10-29; see
 * scannerSafeJsonStringify in scripts/bundle-research-docs.mjs).
 *
 * The generator is imported (not spawned) so the auto-run guard keeps
 * the import side-effect-free; fixtures live in a temp dir.
 */
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { buildCorpus, scannerSafeJsonStringify } from '../scripts/bundle-research-docs.mjs';

const tmp = mkdtempSync(join(tmpdir(), 'nak-corpus-'));
afterAll(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function fixture(userDocs: Record<string, string>, devDocs: Record<string, string>) {
  const userRoot = join(tmp, 'user');
  const devRoot = join(tmp, 'dev');
  mkdirSync(userRoot, { recursive: true });
  mkdirSync(devRoot, { recursive: true });
  for (const [name, body] of Object.entries(userDocs)) {
    const dest = join(userRoot, name);
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, body, 'utf8');
  }
  for (const [name, body] of Object.entries(devDocs)) {
    const dest = join(devRoot, name);
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, body, 'utf8');
  }
  return { userRoot, devRoot };
}

// Extract every `body: "<json>"` literal back out of the emitted
// module so round-trip checks run against the PARSED value, proving
// the scanner escape is content-preserving.
function parsedBodies(source: string): string[] {
  const out = [];
  for (const line of source.split('\n')) {
    const m = /^    body: (".*"),$/.exec(line);
    if (m) out.push(JSON.parse(m[1]));
  }
  return out;
}

describe('scannerSafeJsonStringify', () => {
  it('round-trips content exactly, import token included', () => {
    const content = "See the barrel: import './wiki_save.ts'; at line 68.";
    const encoded = scannerSafeJsonStringify(content);
    expect(JSON.parse(encoded)).toBe(content);
  });

  it('round-trips incidental hits inside words', () => {
    const content = 'This is important for importing recipes.';
    expect(JSON.parse(scannerSafeJsonStringify(content))).toBe(content);
  });

  it('hides the raw import token from a regex scanner', () => {
    const encoded = scannerSafeJsonStringify("import './x.ts'");
    expect(/import\s+['"]/.test(encoded)).toBe(false);
    expect(encoded.includes('impo\\u0072t')).toBe(true);
  });
});

describe('buildCorpus', () => {
  it('emits no raw import statement for docs that quote one in prose', () => {
    const poison = [
      'plan.md',
      [
        'The barrel pulls in every tool module:',
        '',
        "import './wiki_save.ts';",
        "import './skills.ts';",
        '',
        'A dynamic form would be import("./x.ts").',
      ].join('\n'),
    ];
    const { userRoot, devRoot } = fixture(
      { 'intro.md': '# Intro\n\nNo imports here.' },
      Object.fromEntries([poison]),
    );
    const { source, userCount, devCount } = buildCorpus({ userRoot, devRoot });
    expect(userCount).toBe(1);
    expect(devCount).toBe(1);
    // Static and dynamic import forms must both be absent from the
    // raw text; the scanner cannot tell string content from code.
    expect(/import\s+['"]/.test(source)).toBe(false);
    expect(/import\(/.test(source)).toBe(false);
    // And the content itself survives verbatim.
    const bodies = parsedBodies(source);
    expect(bodies.some((b) => b.includes("import './wiki_save.ts';"))).toBe(true);
    expect(bodies.some((b) => b.includes("import './skills.ts';"))).toBe(true);
    expect(bodies.some((b) => b.includes('import("./x.ts")'))).toBe(true);
  });

  it('keeps the emitted module shaped like the real corpus', () => {
    const { userRoot, devRoot } = fixture(
      { 'a.md': '# A' },
      { 'sub/b.md': '# B' },
    );
    const { source } = buildCorpus({ userRoot, devRoot });
    expect(source).toContain('export interface BundledDoc');
    expect(source).toContain('export const USER_DOCS');
    expect(source).toContain('export const DEV_DOCS');
    expect(source).toMatch(/path: "a\.md"/);
    expect(source).toMatch(/path: "sub\/b\.md"/);
  });
});
