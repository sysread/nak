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
// Body slicing assumes neither function gains a nested dollar-quoted
// block (which would end the slice early); that would fail loud on the
// constant regex, not wrong.
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
  it('the discount formula is identical in both bodies (0.5 ^ (1 / l_halflife))', () => {
    // l_halflife is pinned above; d is derived from it, but a one-body
    // edit to the formula itself would slip past a constant-only pin.
    const occurrences = schema.match(/d constant real := 0\.5 \^ \(1\.0 \/ l_halflife\)/g);
    expect(occurrences).not.toBeNull();
    expect(occurrences!.length).toBe(2);
  });

  it('the attempt budget 8 is identical across the claim RPC, the fold gate, and the worker constant', () => {
    // The worker's ATTEMPT_BUDGET (agents/samskara_backfill.ts) drives
    // both SQL sites through p_budget/default; the fold's gate also
    // hardcodes the pin threshold. All three must move together.
    const worker = readFileSync(
      join(process.cwd(), 'supabase', 'functions', 'venice', 'agents', 'samskara_backfill.ts'),
      'utf8'
    );
    const m = worker.match(/const ATTEMPT_BUDGET = (\d+);/);
    expect(m).not.toBeNull();
    const budget = Number(m![1]);
    expect(budget).toBe(8);
    const claim = schema.match(/samskara_claim_quarantined_samskara\([\s\S]*?p_budget int default (\d+)/);
    expect(claim).not.toBeNull();
    expect(Number(claim![1])).toBe(budget);
    expect(schema.match(/v_attempts >= (\d+)/)![1]).toBe(String(budget));
    expect(schema.match(/set backfill_attempts = (\d+)/)![1]).toBe(String(budget));
    // The UI's mirror constant (the detail pane's "n of 8" copy).
    const browse = readFileSync(
      join(process.cwd(), 'src', 'lib', 'ui', 'samskara-browse.ts'),
      'utf8'
    );
    const bm = browse.match(/BACKFILL_ATTEMPT_BUDGET = (\d+)/);
    expect(bm).not.toBeNull();
    expect(Number(bm![1])).toBe(budget);
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
