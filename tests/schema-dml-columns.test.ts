/**
 * Guardrail: every column a DML statement names in `supabase/schema.sql`
 * must be a column of the table it targets.
 *
 * The failure mode this guards shipped for real: PR #524 added a
 * `user_id` column to an INSERT inside the `commit_assistant_message`
 * function body without that column ever existing on `messages`.
 * Postgres does not resolve column references when a plpgsql function
 * is created, so `mise run sync` and the sync-supabase CI job both went
 * green and the break sat dormant until the first production call - a
 * destructive user-message edit - died with "column does not exist".
 * A green sync says nothing about function-body correctness; this scan
 * closes the gap in the gate.
 *
 * What it parses: the column set of every `public.*` table (CREATE
 * TABLE bodies plus `ALTER TABLE ... ADD COLUMN`), then validates the
 * column list of every `INSERT INTO public.* (...)`, the SET targets
 * of every `UPDATE public.* SET`, and every `ON CONFLICT ... DO UPDATE
 * SET` (whose target table is the enclosing INSERT's).
 *
 * The parser is deliberately a conservative scanner, not a SQL parser:
 * any clause fragment it cannot confidently read as a column target is
 * skipped rather than failed, so false positives cost nothing. The
 * sanity assertions at the bottom pin the scan volume so a refactor
 * that blinds the parser fails loudly instead of passing vacuously.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(__dirname, '..');
const SCHEMA = readFileSync(join(ROOT, 'supabase', 'schema.sql'), 'utf8');

/** Strip -- line comments and /* block comments *\/ so scanner text is SQL only. */
function stripComments(sql: string): string {
  // Line comments first: the schema's comments contain `/*` inside
  // path globs (e.g. `src/lib/agents/reflection/*`), and stripping
  // block comments first would open a bogus span that swallows real
  // DDL between it and the next `*/`.
  return sql
    .replace(/--[^\n]*/g, ' ')
    .replace(/\/\*[\s\S]*?\*\//g, ' ');
}

/** Words that open a table-level constraint line, not a column definition. */
const CONSTRAINT_KEYWORDS = new Set([
  'primary', 'unique', 'check', 'constraint', 'foreign', 'exclude', 'like',
  'period', 'with', 'inherits', 'partition', 'tablespace',
]);

/** Index of the paren closing the one open at `openIdx` (depth-aware). */
function matchingParen(text: string, openIdx: number): number {
  let depth = 0;
  for (let i = openIdx; i < text.length; i++) {
    const c = text[i];
    if (c === '(') depth++;
    else if (c === ')') {
      depth--;
      if (depth === 0) return i;
    } else if (c === "'" || c === '"') {
      // Skip string / quoted identifiers wholesale.
      const quote = c;
      i++;
      while (i < text.length && text[i] !== quote) i++;
    }
  }
  return -1;
}

/** Split a paren-delimited region on top-level commas only. */

/** Map of table name -> Set of known columns, from schema definitions. */
function collectTables(sql: string): Map<string, Set<string>> {
  const tables = new Map<string, Set<string>>();

  // CREATE TABLE bodies: first word of each top-level item, minus
  // constraint keywords.
  const createRe = /create\s+table\s+(?:if\s+not\s+exists\s+)?public\.(\w+)\s*\(/gi;
  for (const m of sql.matchAll(createRe)) {
    const name = m[1];
    const close = matchingParen(sql, m.index + m[0].length - 1);
    if (close < 0) continue;
    const cols = tables.get(name) ?? new Set<string>();
    for (const item of splitTopLevelCommas(sql.slice(m.index + m[0].length, close))) {
      const word = item.match(/^(\w+)/);
      if (!word) continue;
      if (CONSTRAINT_KEYWORDS.has(word[1].toLowerCase())) continue;
      cols.add(word[1]);
    }
    tables.set(name, cols);
  }

  // ALTER TABLE statements: every ADD COLUMN clause inside the
  // statement (a single ALTER can add several, comma-separated).
  for (const m of sql.matchAll(/alter\s+table\s+(?:if\s+exists\s+)?public\.(\w+)([^;]*);/gi)) {
    const cols = tables.get(m[1]) ?? new Set<string>();
    for (const add of m[2].matchAll(/add\s+column\s+(?:if\s+not\s+exists\s+)?(\w+)/gi)) {
      cols.add(add[1]);
    }
    tables.set(m[1], cols);
  }

  return tables;
}

function splitTopLevelCommas(text: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = '';
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '(') depth++;
    else if (c === ')') depth--;
    else if (c === ',' && depth === 0) {
      parts.push(current);
      current = '';
      continue;
    }
    current += c;
  }
  parts.push(current);
  // Callers match items against ^\w+ - leading whitespace from the
  // schema's indented column lists would otherwise defeat them.
  return parts.map((p) => p.trim()).filter(Boolean);
}

/** Every INSERT column list + UPDATE SET target in the schema. */
function collectDmlRefs(sql: string): {
  refs: { table: string; column: string; line: number; text: string }[];
  scanned: number;
} {
  const refs: { table: string; column: string; line: number; text: string }[] = [];
  let scanned = 0;

  const lineAt = (idx: number) => sql.slice(0, idx).split('\n').length;

  // INSERT INTO public.<t> (<cols>)
  for (const m of sql.matchAll(/insert\s+into\s+public\.(\w+)\s*\(/gi)) {
    const open = m.index! + m[0].length - 1;
    const close = matchingParen(sql, open);
    if (close < 0) continue;
    scanned++;
    for (const col of splitTopLevelCommas(sql.slice(open + 1, close))) {
      if (/^\w+$/.test(col)) {
        refs.push({ table: m[1], column: col, line: lineAt(m.index!), text: m[0] + col });
      }
    }
  }

  // UPDATE public.<t> [alias] SET <targets> - clause runs to the next
  // top-level WHERE or statement-terminating semicolon.
  for (const m of sql.matchAll(/update\s+public\.(\w+)(?:\s+\w+)?\s+set\s+/gi)) {
    scanned++;
    const rest = sql.slice(m.index! + m[0].length);
    const end = topLevelClauseEnd(rest);
    for (const item of splitTopLevelCommas(rest.slice(0, end))) {
      const target = item.match(/^\s*\(?\s*([\w.]+)\s*=/);
      if (!target) continue;
      const column = target[1].split('.').pop()!;
      refs.push({ table: m[1], column, line: lineAt(m.index!), text: `UPDATE ${m[1]} SET ${column}` });
    }
  }

  // ON CONFLICT ... DO UPDATE SET - the target table is the INSERT's.
  for (const m of sql.matchAll(/do\s+update\s+set\s+/gi)) {
    const before = sql.slice(0, m.index!);
    const ins = [...before.matchAll(/insert\s+into\s+public\.(\w+)/gi)].pop();
    if (!ins) continue;
    scanned++;
    const rest = sql.slice(m.index! + m[0].length);
    const end = topLevelClauseEnd(rest);
    for (const item of splitTopLevelCommas(rest.slice(0, end))) {
      const target = item.match(/^\s*\(?\s*([\w.]+)\s*=/);
      if (!target) continue;
      const column = target[1].split('.').pop()!;
      refs.push({ table: ins[1], column, line: lineAt(m.index!), text: `ON CONFLICT DO UPDATE SET ${column}` });
    }
  }

  return { refs, scanned };
}

/**
 * End of a SET clause: the next top-level WHERE keyword or semicolon,
 * whichever comes first. WHERE is only recognized at paren depth 0 so
 * a WHERE inside an expression (e.g. inside a CASE or a subselect)
 * does not terminate the clause early.
 */
function topLevelClauseEnd(text: string): number {
  let depth = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '(') depth++;
    else if (c === ')') depth--;
    else if (depth === 0 && c === ';') return i;
    else if (
      depth === 0 && c === ' ' &&
      /^where[\s(]/i.test(text.slice(i + 1))
    ) return i;
  }
  return text.length;
}

describe('schema DML column guardrail', () => {
  const sql = stripComments(SCHEMA);
  const tables = collectTables(sql);
  const { refs, scanned } = collectDmlRefs(sql);

  const unknown = refs.filter((r) => !tables.get(r.table)?.has(r.column));
  const report = unknown
    .map((r) => `  schema.sql:${r.line}  ${r.table}.${r.column}  (${r.text})`)
    .join('\n');

  it('every DML column reference names an existing column', () => {
    expect(
      unknown,
      `DML in supabase/schema.sql references columns that no table ` +
        `definition declares. Postgres only resolves these at first ` +
        `runtime call, so a green sync proves nothing - this is the ` +
        `exact failure mode of the commit_assistant_message user_id ` +
        `outage (2026-08-27):\n${report}`
    ).toEqual([]);
  });

  it('every DML target table is a known table', () => {
    const unknownTables = refs.filter((r) => !tables.has(r.table));
    const report = unknownTables
      .map((r) => `  schema.sql:${r.line}  ${r.table}  (${r.text})`)
      .join('\n');
    expect(
      unknownTables,
      `DML targets a table schema.sql never defines. Either the table ` +
        `name is misspelled or the table is defined in a form the ` +
        `scanner does not recognize:\n${report}`
    ).toEqual([]);
  });

  it('scanner actually sees the schema (parses non-vacuously)', () => {
    // If table-definition or DML parsing breaks, these floor values
    // drop and the guardrail above goes blind. The numbers pin the
    // scanner's reach as of the user_id fix; raise them as the schema
    // grows.
    expect(tables.size).toBeGreaterThanOrEqual(40);
    expect(refs.length).toBeGreaterThanOrEqual(400);
    expect(scanned).toBeGreaterThanOrEqual(140);
  });

  it('still sees the regressed site (scanner sanity)', () => {
    // Pin the exact insert the guardrail exists for: the destructive-
    // edit atomic insert inside commit_assistant_message. Located by
    // the insert's own `returning id into v_anchor_id` clause (the
    // only messages INSERT that returns into that variable; comments
    // are stripped from `sql`, so the anchor has to be code) and
    // walked back to the nearest preceding INSERT so the pin survives
    // line drift; if the insert moves or the parser goes blind, this
    // fails loudly instead of silently losing coverage of the one site
    // that shipped the outage.
    const marker = 'returning id into v_anchor_id';
    const markerIdx = sql.indexOf(marker);
    expect(markerIdx, 'commit_assistant_message destructive-edit insert not found').toBeGreaterThan(0);
    const before = sql.slice(0, markerIdx);
    const insRe = /insert\s+into\s+public\.messages\s*\(/gi;
    let ins: RegExpExecArray | null = null;
    for (let m = insRe.exec(before); m !== null; m = insRe.exec(before)) ins = m;
    expect(ins, 'destructive-edit branch no longer contains its messages INSERT').not.toBeNull();
    const open = ins!.index + ins![0].length - 1;
    const close = matchingParen(sql, open);
    const cols = splitTopLevelCommas(sql.slice(open + 1, close));
    expect(cols.sort()).toEqual(['content', 'position', 'role', 'status', 'thread_id']);
  });
});
