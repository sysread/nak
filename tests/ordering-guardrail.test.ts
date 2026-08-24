/**
 * Guardrail: per-thread message ordering must use `position`, not
 * `created_at`. See docs/dev/in-progress/conversation-forking.md (M1).
 *
 * The failure mode this guards is invisible on fresh data: created_at
 * order and position order coincide for normally-appended rows, so a
 * reader that slips back to created_at works in every demo and
 * misorders exactly the transcripts that needed healing (recovery
 * rows carry honest "now" timestamps but fractional mid-transcript
 * positions). A one-time manual sweep can't hold that line; this scan
 * runs in the gate forever.
 *
 * Contract: every ordering of the `messages` table by created_at -
 * `.order('created_at', ...)` on a `.from('messages')` query in TS,
 * `order by <alias>.created_at` where <alias> is a public.messages
 * alias in schema.sql - must carry a nearby comment containing
 * "wall-clock" or "legacy order", naming why transcript order is the
 * wrong tool there (cross-thread day windows, the backfill's
 * reconstruction of pre-position order). Everything else must order
 * by position.
 *
 * The association heuristics are deliberately simple (nearest
 * `.from(...)` within a fixed window; nearest alias declaration in
 * SQL). The sanity assertions at the bottom pin the KNOWN allowed
 * sites, so if a refactor moves code out of the heuristics' reach the
 * counts drop and the test fails loudly instead of going blind.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(__dirname, '..');

/** Marker a deliberate created_at ordering must carry nearby. */
const MARKER = /wall-clock|legacy order/i;

/** How far above the ordering line the marker comment may sit. */
const MARKER_WINDOW = 8;

/** How far above an `.order(...)` call its `.from(...)` may sit. */
const FROM_WINDOW = 12;

function walkTsFiles(dir: string, out: string[]): string[] {
  for (const entry of readdirSync(dir)) {
    // _generated holds vendored corpus text, not queries.
    if (entry === 'node_modules' || entry === '_generated' || entry.startsWith('.')) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      walkTsFiles(full, out);
    } else if (/\.(ts|svelte)$/.test(entry)) {
      out.push(full);
    }
  }
  return out;
}

interface Hit {
  file: string;
  line: number; // 1-based
  text: string;
  hasMarker: boolean;
}

function hasNearbyMarker(lines: string[], idx: number): boolean {
  for (let j = Math.max(0, idx - MARKER_WINDOW); j <= idx; j++) {
    if (MARKER.test(lines[j])) return true;
  }
  return false;
}

/**
 * TS side: flag `.order('created_at' ...)` whose nearest preceding
 * `.from('<table>')` names the messages table.
 */
function scanTsFile(path: string): Hit[] {
  const lines = readFileSync(path, 'utf8').split('\n');
  const hits: Hit[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (!/\.order\(\s*['"]created_at['"]/.test(lines[i])) continue;
    let table: string | null = null;
    for (let j = i; j >= Math.max(0, i - FROM_WINDOW); j--) {
      const m = lines[j].match(/\.from\(\s*['"](\w+)['"]\s*\)/);
      if (m) {
        table = m[1];
        break;
      }
    }
    if (table !== 'messages') continue;
    hits.push({
      file: path.slice(ROOT.length + 1),
      line: i + 1,
      text: lines[i].trim(),
      hasMarker: hasNearbyMarker(lines, i),
    });
  }
  return hits;
}

/**
 * SQL side: flag `order by <alias>.created_at` where <alias> is
 * declared as a public.messages alias. The declaration can sit above
 * (laterals, plain selects) or below (an `over (order by ...)` window
 * whose FROM follows), so the alias search looks both ways.
 */
function scanSchema(path: string): Hit[] {
  const lines = readFileSync(path, 'utf8').split('\n');
  const hits: Hit[] = [];
  for (let i = 0; i < lines.length; i++) {
    const om = lines[i].match(/order by\s+(\w+)\.created_at/i);
    if (!om) continue;
    const alias = om[1];
    const decl = new RegExp(`(?:from|join)\\s+public\\.(\\w+)\\s+${alias}\\b`, 'i');
    let table: string | null = null;
    for (let d = 1; d <= 40 && table === null; d++) {
      for (const j of [i - d, i + d]) {
        if (j < 0 || j >= lines.length) continue;
        const m = lines[j].match(decl);
        if (m) {
          table = m[1];
          break;
        }
      }
    }
    if (table !== 'messages') continue;
    hits.push({
      file: 'supabase/schema.sql',
      line: i + 1,
      text: lines[i].trim(),
      hasMarker: hasNearbyMarker(lines, i),
    });
  }
  return hits;
}

describe('message-ordering guardrail', () => {
  const tsHits = walkTsFiles(join(ROOT, 'src'), [])
    .concat(walkTsFiles(join(ROOT, 'supabase', 'functions'), []))
    .flatMap(scanTsFile);
  const sqlHits = scanSchema(join(ROOT, 'supabase', 'schema.sql'));

  it('every created_at ordering of messages carries a wall-clock / legacy-order comment', () => {
    const unmarked = [...tsHits, ...sqlHits].filter((h) => !h.hasMarker);
    const report = unmarked
      .map((h) => `  ${h.file}:${h.line}  ${h.text}`)
      .join('\n');
    expect(
      unmarked,
      `messages must be ordered by position, not created_at. Either switch ` +
        `the ordering to position, or - if this site genuinely compares wall ` +
        `clocks (a cross-thread window, a staleness check, the backfill's ` +
        `legacy-order reconstruction) - say so in a comment containing ` +
        `"wall-clock" or "legacy order" within ${MARKER_WINDOW} lines above ` +
        `it:\n${report}`
    ).toEqual([]);
  });

  it('still sees the known deliberate sites (scanner sanity)', () => {
    // If a refactor moves these out of the association heuristics'
    // reach, the scan goes blind without this pin: 5 day-gate newest
    // laterals + the backfill's legacy-order reconstruction in
    // schema.sql, and the digest's cross-thread day window in TS.
    expect(sqlHits.filter((h) => h.hasMarker).length).toBe(6);
    expect(tsHits.filter((h) => h.hasMarker).length).toBe(1);
  });
});
