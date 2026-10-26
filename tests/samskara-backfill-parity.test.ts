/**
 * Evidence-backfill parity guard: samskara_apply_backfill (the warmup
 * pool's reduced-weight fold) must fold with the SAME posterior
 * constants as samskara_apply_evaluation (the live judge) - the two
 * RPCs write the same tallies the fire score and the population prior
 * read, so a drifted constant would make backfill evidence and live
 * evidence disagree invisibly. The plan's MIRROR PIN lives here
 * because schema.sql has no SQL test harness; this reads the function
 * bodies out of the schema file the same way tests/schema-grants.test.ts
 * does. A deliberate recalibration edits BOTH functions in one commit
 * and bumps both expectations here.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const schema = readFileSync(join(process.cwd(), 'supabase', 'schema.sql'), 'utf8');

/** Extract the `constant real := <literal>` value for one binding inside one function body. */
function constantFor(fn: string, binding: string): number {
  const start = schema.indexOf(`create or replace function public.${fn}(`);
  if (start < 0) throw new Error(`function ${fn} not found in schema.sql`);
  // Bodies end at the matching `end $$;` - take the slice up to it.
  const end = schema.indexOf('end $$;', start);
  const body = schema.slice(start, end);
  const m = body.match(new RegExp(`${binding} constant real := ([0-9.]+)`));
  if (!m) throw new Error(`binding ${binding} not found in ${fn}`);
  return Number(m[1]);
}

// Both functions carry the identical four-constant block. w_soft's
// comment in apply_evaluation records why it is hand-chosen; the
// backfill fold reuses it untouched.
const live = {
  k: constantFor('samskara_apply_evaluation', 'k'),
  l: constantFor('samskara_apply_evaluation', 'l_halflife'),
  wSoft: constantFor('samskara_apply_evaluation', 'w_soft'),
};
const backfill = {
  k: constantFor('samskara_apply_backfill', 'k'),
  l: constantFor('samskara_apply_backfill', 'l_halflife'),
  wSoft: constantFor('samskara_apply_backfill', 'w_soft'),
};

describe('samskara_apply_backfill / apply_evaluation constant parity', () => {
  it('prior strength k matches', () => {
    expect(backfill.k).toBe(live.k);
    expect(live.k).toBe(5.0);
  });
  it('evidence half-life l_halflife matches', () => {
    expect(backfill.l).toBe(live.l);
    expect(live.l).toBe(10.0);
  });
  it('soft-miss weight w_soft matches', () => {
    expect(backfill.wSoft).toBe(live.wSoft);
    expect(live.wSoft).toBe(0.25);
  });
  it('the backfill weight scales held/contradicted to 0.5 and not-borne-out to w_soft * 0.5', () => {
    // The worker's p_weight default lives in the fold signature; the
    // plan (docs/dev/in-progress/samskara-backfill-plan.md, M1) pins
    // 0.5 and the RPC's default must carry it.
    const m = schema.match(
      /create or replace function public\.samskara_apply_backfill\([\s\S]*?p_weight real default ([0-9.]+)/
    );
    expect(m).not.toBeNull();
    expect(Number(m![1])).toBe(0.5);
  });
});
