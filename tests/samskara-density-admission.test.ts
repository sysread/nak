/**
 * Density admission guards: the density RPC (samskara_density_check)
 * and the evidence reaper (samskara_reap_evidence) live in SQL
 * (supabase/schema.sql) and have no SQL test harness, so this file
 * pins them the way tests/samskara-dormancy.test.ts does - by reading
 * the schema file. It also pins the POPULATION_TRIPWIRE /
 * p_target_count parity across the edge module and the schema: drift
 * re-opens the collapse RPC's evidence-free overflow merge or keeps
 * the halt from arming. A drifted register, a dropped guard clause,
 * or a demoted constant pair failing to move together fails loud here.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const schema = readFileSync(join(process.cwd(), 'supabase', 'schema.sql'), 'utf8');
const edgeModule = readFileSync(
  join(process.cwd(), 'supabase', 'functions', 'venice', 'agents', 'samskara.ts'),
  'utf8',
);
const denoTest = readFileSync(
  join(process.cwd(), 'supabase', 'functions', 'tests', 'samskara.test.ts'),
  'utf8',
);

function fnBody(fn: string): string {
  const start = schema.indexOf(`create or replace function public.${fn}(`);
  if (start < 0) throw new Error(`function ${fn} not found`);
  // Slice to the FIRST `$$;` after the header: correct for both
  // plpgsql (`end $$;`) and language-sql (`$$;`) bodies, and neither
  // body contains nested dollar-quoting.
  const end = schema.indexOf('$$;', start);
  return schema.slice(start, end);
}

const density = fnBody('samskara_density_check');
const reaper = fnBody('samskara_reap_evidence');
const evict = fnBody('samskara_evict_for_mint');

describe('samskara_density_check register and gates', () => {
  it('centers with the CLAIM mean, never the substrate mean', () => {
    // The density question is claim-vs-claim; the substrate mean is
    // the fire path's message-vs-claim register. The measured
    // nearest-neighbor medians differ by 0.24 (0.404 claim-mean vs
    // 0.648 substrate-mean) - the wrong register rejects every mint.
    expect(density).toContain('public._samskara_claim_centering_mean(');
    expect(density).not.toContain('public._samskara_centering_mean(');
  });

  it('counts only ESTABLISHED claims: a genuine tally AND activation', () => {
    // The tally gate is the entrenchment mitigation (unproven
    // newcomers must not gate a genuinely new claim); activation
    // excludes quarantined rows (the warmup pool's domain).
    expect(density).toContain('s.confirm_count + s.disconfirm_count > 0');
    expect(density).toContain('s.activated_at is not null');
  });

  it('SKIPS on cold start instead of running on raw cosine', () => {
    // Raw claim-claim cosine never drops below ~0.76, so a raw-cosine
    // density count would read every pair as dense and reject
    // everything. Not-ready must yield count 0 + ready false.
    expect(density).toContain('public._samskara_claim_centering_ready(');
    expect(density).toMatch(/ready boolean/);
  });

  it('compares against the caller floor and returns the reinforce target', () => {
    expect(density).toContain('>= p_floor');
    expect(density).toMatch(/nearest_id uuid/);
  });
});

describe('samskara_reap_evidence passes and guards', () => {
  // Split the reaper body at its pass comments so each pass's guard
  // set can be pinned independently.
  const junkPass = reaper.slice(0, reaper.indexOf('-- STALE pass'));
  const stalePass = reaper.slice(
    reaper.indexOf('-- STALE pass'),
    reaper.indexOf('-- UNDERPERFORMER pass'),
  );
  const underperformerPass = reaper.slice(reaper.indexOf('-- UNDERPERFORMER pass'));

  it('declares the constants at the eviction-function values', () => {
    expect(reaper).toContain('junk_min_judged constant int := 10');
    expect(reaper).toContain('junk_min_age_days constant int := 14');
    expect(reaper).toContain('stale_max_tally constant real := 1.0');
    expect(reaper).toContain('stale_quiet_days constant int := 90');
    expect(reaper).toContain('underperformer_ratio constant real := 0.85');
    // Parity with the eviction function's literal copies (the
    // transition wiring). If either side moves, both must.
    expect(evict).toContain("interval '14 days'");
    expect(evict).toContain('>= 10');
    expect(evict).toContain('<= 1.0');
    expect(evict).toContain("interval '90 days'");
    expect(evict).toContain('0.85 * public.samskara_population_p0(');
  });

  it('gates the junk and stale passes on no pending fire, spares the underperformer pass', () => {
    // The pending guard spares a row whose in-flight fire may be its
    // first test. The underperformer standard is a demonstrated
    // failure - one more verdict cannot exonerate it - matching
    // samskara_evict_for_mint's deliberate divergence.
    const pendingGuard = (body: string) =>
      body.includes(
        'where f.samskara_id = s.id and f.verdict is null',
      );
    expect(pendingGuard(junkPass)).toBe(true);
    expect(pendingGuard(stalePass)).toBe(true);
    expect(pendingGuard(underperformerPass)).toBe(false);
  });

  it('only touches activated claims (quarantined rows belong to the warmup pool)', () => {
    expect(reaper).toContain('s.activated_at is not null');
  });

  it('the stale clock (last live genuine verdict, else activation) is pinned in all three mirrors', () => {
    // The reaper, the eviction copy, and the health snapshot's
    // evictable_stale column must agree: a drift makes one site
    // collect rows another reports as safe. The coalesce fallback is
    // what lets a backfill-established claim (tallies, no fire rows)
    // go stale at all - without it its max-live-genuine is NULL and
    // the comparison never fires.
    const fallback = (body: string) =>
      body.includes('coalesce(') &&
      body.includes('max(f.fired_at)') &&
      body.includes('s.activated_at');
    expect(fallback(reaper)).toBe(true);
    expect(fallback(evict)).toBe(true);
    expect(fallback(fnBody('samskara_health_snapshot'))).toBe(true);
  });

  it('runs on the :13 reap cron after the dormancy reaper', () => {
    const cron = schema.slice(schema.indexOf("'nak-samskara-reap'"));
    const statement = cron.slice(cron.indexOf('$job$'), cron.indexOf('$job$', cron.indexOf('$job$') + 5));
    expect(statement).toContain('public.samskara_reap_evidence()');
    expect(statement.indexOf('samskara_reap_dormant()'))
      .toBeLessThan(statement.indexOf('samskara_reap_evidence()'));
  });
});

describe('POPULATION_TRIPWIRE parity', () => {
  it('the edge module, the schema RPC, and the Deno pin all say 300', () => {
    expect(edgeModule).toContain('const POPULATION_TRIPWIRE = 300;');
    expect(edgeModule).not.toContain('SAMSKARA_POPULATION_CAP');
    expect(schema).toContain('p_target_count int default 300,');
    expect(schema).not.toContain('p_target_count int default 150,');
    expect(denoTest).toContain('assertEquals(POPULATION_TRIPWIRE, 300);');
  });

  it('the collapse sync comment names POPULATION_TRIPWIRE', () => {
    // The mirror-comment discipline: both sites must tell the reader
    // about the other, or the next editor drifts them silently.
    expect(schema).toContain('MUST stay in sync with POPULATION_TRIPWIRE in');
    expect(edgeModule).toContain('`p_target_count` on `samskara_collapse_by_cofiring`');
  });
});

describe('admission order in the mint path', () => {
  // The probes are not exported (they drive a live client), so the
  // order invariant is pinned structurally: within each probe the
  // dedup branch must precede the density gate, and the density
  // rejection must precede insertMint. Order is load-bearing: the
  // dedup bar adjudicates twins FIRST (reinforce), and the density
  // gate only sees candidates the twin check deliberately let
  // through - swap them and near-twins burn the density verdict.
  function probeOrder(fn: 'mintProbe' | 'assocHubOnce'): void {
    const start = edgeModule.indexOf(`async function ${fn}(`);
    expect(start).toBeGreaterThan(0);
    const body = edgeModule.slice(start, edgeModule.indexOf('\n}\n', start));
    const dedup = body.indexOf('MINT_DEDUP_COSINE');
    const density = body.indexOf('densityGate(');
    const insert = body.indexOf('insertMint(');
    expect(dedup).toBeGreaterThan(0);
    expect(density).toBeGreaterThan(dedup);
    if (insert >= 0) expect(insert).toBeGreaterThan(density);
  }

  it('the recency probe runs dedup -> density -> insert', () => {
    probeOrder('mintProbe');
    expect(edgeModule).toContain("outcome: 'density-rejected'");
  });

  it('the association probe runs dedup -> density, and a rejection stamps consumed', () => {
    probeOrder('assocHubOnce');
    const start = edgeModule.indexOf('async function assocHubOnce(');
    const body = edgeModule.slice(start, edgeModule.indexOf('\n}\n', start));
    const densityReject = body.indexOf("density.kind === 'density-reject'");
    const stamp = body.indexOf('stampConsumed(', densityReject);
    expect(densityReject).toBeGreaterThan(0);
    expect(stamp).toBeGreaterThan(densityReject);
  });
});
