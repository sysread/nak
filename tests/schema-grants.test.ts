/**
 * Guardrail: the Data API grant block at the bottom of
 * `supabase/schema.sql` must be the last table-affecting DDL in the
 * file.
 *
 * Supabase stopped auto-granting Data API access to new tables in
 * the public schema on 2026-10-30. The schema restores that default
 * with one idempotent block at the end of the file - grant DML on
 * all tables (plus usage/select on all sequences) to anon,
 * authenticated, and service_role - so a new table needs no grant
 * statements of its own. That only holds while every table and view
 * is created ABOVE the block: schema.sql applies start to finish,
 * so a table created after the block comes into existence with no
 * grants at all. `mise run sync` and the sync-supabase CI job both
 * go green (the GRANT statements succeeded; the new table simply
 * never received them), and the failure surfaces later as Data API
 * "permission denied" - in production for a newly added table, and
 * everywhere for a fresh project, preview branch, or local
 * `supabase db reset`.
 *
 * Also pinned: the block grants `on all tables in schema public`
 * (the shape that makes end-placement sufficient), covers all three
 * Data API roles, keeps the defensive sequences grant, and the
 * schema contains no materialized views (`GRANT ... ON ALL TABLES`
 * skips matviews, so one added anywhere would silently stay
 * un-granted).
 *
 * Like tests/schema-dml-columns.test.ts, this is a conservative
 * scanner, not a SQL parser; floor and canary assertions keep a
 * refactor that blinds the scanner failing loudly instead of
 * passing vacuously.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(__dirname, '..');
const SCHEMA = readFileSync(join(ROOT, 'supabase', 'schema.sql'), 'utf8');

/** Strip -- line comments and /* block comments *\/ so scanner text is SQL only. */
function stripComments(sql: string): string {
  return sql
    .replace(/--[^\n]*/g, ' ')
    .replace(/\/\*[\s\S]*?\*\//g, ' ');
}

const ROLES = ['anon', 'authenticated', 'service_role'];

describe('schema Data API grant guardrail', () => {
  const sql = stripComments(SCHEMA);

  const tables = [...sql.matchAll(/create\s+table\s+(?:if\s+not\s+exists\s+)?public\.(\w+)\s*\(/gi)]
    .map((m) => ({ name: m[1], idx: m.index! }));
  const views = [...sql.matchAll(/create\s+(?:or\s+replace\s+)?view\s+(?:if\s+not\s+exists\s+)?public\.(\w+)/gi)]
    .map((m) => ({ name: m[1], idx: m.index! }));
  const matviews = [...sql.matchAll(/create\s+(?:or\s+replace\s+)?materialized\s+view/gi)];

  // Match any privilege list - the invariant is the shape
  // (`on all tables in schema public`), not the exact columns
  // granted, so widening the list to restore TRUNCATE etc. stays
  // green.
  const grantBlocks = [...sql.matchAll(/grant\s+[^;]*?on\s+all\s+tables\s+in\s+schema\s+public/gi)];
  const seqGrants = [...sql.matchAll(/grant\s+[^;]*?on\s+all\s+sequences\s+in\s+schema\s+public/gi)];

  it('data api grant block exists exactly once and reaches all three roles', () => {
    expect(
      grantBlocks.length,
      'expected exactly one `grant ... on all tables in schema public` block in ' +
        'supabase/schema.sql - the Data API reachability block',
    ).toBe(1);
    const block = grantBlocks[0];
    const stmt = sql.slice(block.index, sql.indexOf(';', block.index));
    const missing = ROLES.filter((r) => !stmt.includes(r));
    expect(
      missing,
      `the grant block does not reach: ${missing.join(', ')}. Every Data API ` +
        'role needs the grant or supabase-js/PostgREST cannot see the tables',
    ).toEqual([]);
  });

  it('sequences grant block exists (self-sufficiency for future identity columns)', () => {
    expect(
      seqGrants.length,
      'the sequences grant is gone from the end of supabase/schema.sql. No ' +
        'sequence-backed columns exist today; the grant is defensive so the ' +
        'block stays self-sufficient if one is added',
    ).toBe(1);
  });

  it('every table and view is created above the grant block', () => {
    const blockIdx = grantBlocks[0].index;
    const after = [...tables, ...views].filter((x) => x.idx > blockIdx);
    const report = after
      .map((x) => `  ${x.name}  (created after the grant block)`)
      .join('\n');
    expect(
      after,
      'objects created below the Data API grant block receive none of its ' +
        'grants: schema.sql applies start to finish, so they come into ' +
        'existence un-granted and the Data API cannot reach them. Move the ' +
        'create statement above the block. A table that must stay ' +
        'Data-API-unreachable is a change to the block itself (exclusion), ' +
        'not placement below it:\n' + report,
    ).toEqual([]);
  });

  it('no materialized views (GRANT ... ON ALL TABLES skips them)', () => {
    expect(
      matviews.length,
      'a materialized view appeared in supabase/schema.sql. `grant ... on ' +
        'all tables in schema public` does not cover matviews, so it would ' +
        'silently stay un-granted - give it an explicit grant and teach ' +
        'this test about it',
    ).toBe(0);
  });

  it('scanner actually sees the schema (parses non-vacuously)', () => {
    // If table/view scanning breaks, the position guardrail above goes
    // blind. The floors pin the scanner's reach as of the grant-block
    // fix; raise them as the schema grows. The canaries pin a
    // long-established name and the most recently added table, so a
    // scanner that only matches some subset still fails loudly.
    expect(tables.length).toBeGreaterThanOrEqual(52);
    expect(views.length).toBeGreaterThanOrEqual(1);
    const names = new Set(tables.map((t) => t.name));
    expect(names.has('profiles'), 'scanner lost the profiles create-table').toBe(true);
    expect(names.has('mcp_integration_tools'), 'scanner lost the mcp_integration_tools create-table').toBe(true);
    // The tier-2 (compound) layer was retired 2026-10-25; its declines
    // table must not re-appear (e.g. via a partial revert).
    expect(names.has('samskara_tier2_declines'), 'retired samskara_tier2_declines must not re-appear').toBe(false);
  });
});
