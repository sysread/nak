/**
 * Guardrail: the stale-summary catch-up lane's selection predicate in
 * supabase/schema.sql (samskara_stale_compound_regen_users) must keep
 * its eligibility arms ANDed in one WHERE - stale past the read side's
 * ceiling, conversation activity since the summary was generated, and
 * a live (activated) samskara corpus - ordered oldest-first and
 * capped.
 *
 * Like tests/schema-grants.test.ts, this is a conservative text
 * scanner, not a SQL parser: it pins the presence and shape of each
 * arm inside the function body so a refactor that drops one (or
 * un-ANDs it into an OR) fails the gate instead of silently widening
 * or narrowing who gets a regen.
 *
 * The staleness arm is pinned against the read side's own ceiling -
 * STALE_CEILING_HOURS in the Deno island's priming formatter - via the
 * same cross-island import tests/bias-catalog-parity.test.ts uses
 * (that module is self-contained, which is what lets vitest load it).
 * If either side drifts, this suite fails instead of the lane
 * regenerating at a different age than the prompt block disappears.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { STALE_CEILING_HOURS } from '../supabase/functions/venice/priming/samskara-format';

const ROOT = join(__dirname, '..');
const SCHEMA = readFileSync(join(ROOT, 'supabase', 'schema.sql'), 'utf8');

function selectorBlock(): string {
  const start = SCHEMA.indexOf(
    'create or replace function public.samskara_stale_compound_regen_users',
  );
  expect(start, 'the selector RPC exists in schema.sql').toBeGreaterThan(-1);
  const grantIdx = SCHEMA.indexOf(
    'grant execute on function public.samskara_stale_compound_regen_users',
    start,
  );
  expect(grantIdx, 'the selector RPC block ends at its grant line').toBeGreaterThan(start);
  // Slice through the END of the grant line so the discipline assertions
  // below see both the revoke and the grant.
  return SCHEMA.slice(start, SCHEMA.indexOf('\n', grantIdx));
}

/** SQL only: the body's -- comments name column words in prose, which
 *  would defeat the word-boundary structural assertions below. */
function selectorSql(): string {
  return selectorBlock().replace(/--[^\n]*/g, '');
}

describe('samskara_stale_compound_regen_users eligibility predicate', () => {
  it('exists as a definer RPC with the service-role-only grant discipline', () => {
    const body = selectorBlock();
    expect(body).toContain('language sql security definer');
    expect(body).toContain(
      'revoke all on function public.samskara_stale_compound_regen_users(int) from public, anon, authenticated',
    );
    expect(body).toContain(
      'grant execute on function public.samskara_stale_compound_regen_users(int) to service_role',
    );
  });

  it('stale arm: the summary must be older than the read side ceiling (fresh excluded)', () => {
    const sql = selectorSql();
    // Pinned against STALE_CEILING_HOURS so the lane regens exactly
    // when the prompt block would otherwise disappear.
    expect(STALE_CEILING_HOURS).toBe(24);
    expect(sql).toContain(`c.last_regen_at < now() - interval '${STALE_CEILING_HOURS} hours'`);
  });

  it('activity arm: a substantive message after the summary is required (quiet accounts excluded)', () => {
    const sql = selectorSql();
    expect(sql).toContain("m.role in ('user', 'assistant')");
    expect(sql).toContain("m.content <> ''");
    expect(sql).toContain('m.created_at > c.last_regen_at');
    // Ownership rides the threads join; messages has no user_id.
    expect(sql).toContain('join public.threads t on t.id = m.thread_id');
    expect(sql).toContain('t.user_id = c.user_id');
  });

  it('live-corpus arm: at least one activated samskara is required', () => {
    const sql = selectorSql();
    expect(sql).toContain('s.activated_at is not null');
    expect(sql).toContain('s.user_id = c.user_id');
  });

  it('the three arms are ANDed in one WHERE, oldest first, capped', () => {
    const sql = selectorSql();
    const where = sql.slice(sql.indexOf('where c.last_regen_at'), sql.indexOf('order by'));
    // Both exists gates must be ANDs of the staleness check: an OR
    // would select quiet accounts or fresh summaries. Zero standalone
    // "or" tokens in the WHERE body pins that ("order" does not match
    // the word boundary).
    expect(where).toContain('and exists (');
    expect(where.match(/\bor\b/g) ?? []).toHaveLength(0);
    expect(sql).toContain('order by c.last_regen_at asc');
    expect(sql).toContain('limit p_limit');
  });
});
