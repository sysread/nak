/**
 * Cross-check that the server-side gated-toolbox-name mirror stays in
 * sync with the browser source of truth.
 *
 * The toggle_toolbox tool dispatches in the venice edge function, which
 * validates the model's requested toolbox names against a HAND-MAINTAINED
 * Set in supabase/functions/venice/tools/toggle_tools.ts. That Deno
 * module can't import the browser barrel (src/lib/tools), so the names
 * are duplicated. When the duplicate drifts, the model can no longer
 * enable the missing toolbox - the toggle silently drops the unknown
 * name and returns `enabled: []` (this is the bug that shipped with
 * wiki_records: the toolbox existed everywhere except this mirror).
 *
 * This test imports the source of truth (GATED_TOOLBOX_NAMES) and reads
 * the edge file as TEXT - not via import, which would drag Deno-only
 * deps into vitest - then parses the Set literal and asserts the two
 * agree. Adding a toolbox in only one place fails here.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it, expect } from 'vitest';
import { GATED_TOOLBOX_NAMES } from '../src/lib/tools';

// vitest runs from the repo root; resolve the edge file from cwd rather
// than import.meta.url (not a file: URL under the vitest loader).
const EDGE_FILE = resolve(
  process.cwd(),
  'supabase/functions/venice/tools/toggle_tools.ts',
);

/**
 * Extract the quoted names from the edge file's
 * `const GATED_TOOLBOX_NAMES = new Set<string>([ ... ])` literal. The
 * edge comment asks that the literal stay a flat list of quoted strings
 * so this parser keeps working.
 */
function parseEdgeGatedNames(source: string): string[] {
  const m = /GATED_TOOLBOX_NAMES\s*=\s*new Set<string>\(\[([\s\S]*?)\]\)/.exec(source);
  if (!m) throw new Error('could not locate the edge GATED_TOOLBOX_NAMES Set literal');
  return [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]);
}

describe('gated toolbox name mirror', () => {
  it('the edge toggle_tools.ts mirror matches the browser GATED_TOOLBOX_NAMES', () => {
    const edgeNames = parseEdgeGatedNames(readFileSync(EDGE_FILE, 'utf8'));
    // Set-equal (order-independent): the edge accept loop only does
    // membership checks, so order doesn't matter there.
    expect([...edgeNames].sort()).toEqual([...GATED_TOOLBOX_NAMES].sort());
  });

  it('includes wiki_records (the reported regression)', () => {
    expect(GATED_TOOLBOX_NAMES).toContain('wiki_records');
    expect(parseEdgeGatedNames(readFileSync(EDGE_FILE, 'utf8'))).toContain('wiki_records');
  });
});
