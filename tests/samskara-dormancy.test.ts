/**
 * Dormancy reaper guard: the standard lives in SQL (samskara_reap_dormant
 * in supabase/schema.sql) and has no SQL test harness, so this file pins
 * the reaper body the same way tests/schema-grants.test.ts and
 * tests/samskara-backfill-parity.test.ts do - by reading the schema file.
 * A drifted constant or a dropped guard clause fails loud here.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const schema = readFileSync(join(process.cwd(), 'supabase', 'schema.sql'), 'utf8');

function fnBody(fn: string): string {
  const start = schema.indexOf(`create or replace function public.${fn}(`);
  if (start < 0) throw new Error(`function ${fn} not found`);
  // Slice to the FIRST `$$;` after the header: correct for both
  // plpgsql (`end $$;`) and language-sql (`$$;`) bodies, and neither
  // body contains nested dollar-quoting.
  const end = schema.indexOf('$$;', start);
  return schema.slice(start, end);
}

const reaper = fnBody('samskara_reap_dormant');

describe('samskara_reap_dormant constants and guards', () => {
  it('the streak length is 15 as a named SQL constant, mirroring the UI', () => {
    expect(reaper).toContain('dormant_streak constant int := 15');
    expect(reaper).toContain('dormant_cohort_floor constant int := 5');
    const browse = readFileSync(
      join(process.cwd(), 'src', 'lib', 'ui', 'samskara-browse.ts'),
      'utf8'
    );
    const m = browse.match(/DORMANT_STREAK = (\d+);/);
    expect(m).not.toBeNull();
    expect(Number(m![1])).toBe(15);
    expect(reaper).toContain('st.in_window = dormant_streak');
    expect(reaper).toContain('st.threads >= dormant_cohort_floor');
  });

  it('the thread floor is 5 and counts THREADS, not cohorts', () => {
    // cohort_id is per-turn: five cohorts can sit inside one thread on
    // one afternoon. The floor must count conversations.
    expect(reaper).toContain('threads >= dormant_cohort_floor');
    expect(reaper).toContain('count(distinct thread_id)');
    expect(reaper).not.toContain('distinct cohort_id');
  });

  it('the window is all-not-engaged (zero genuine among the 15)', () => {
    expect(reaper).toContain("verdict <> 'not-engaged'");
    expect(reaper).toContain('genuine_in_window = 0');
  });

  it('the pending-fire guard is present (a verdict in flight spares the claim)', () => {
    expect(reaper).toMatch(/not exists \(\s*select 1 from public\.samskara_fires f\s*where f\.samskara_id = s\.id and f\.verdict is null/);
  });

  it('the reaper only touches activated claims', () => {
    expect(reaper).toContain('s.activated_at is not null');
  });

  it('the reaper runs on the :13 reap cron AFTER expire_unjudgeable_fires', () => {
    // Statement order is load-bearing: freshly expired stamps must count
    // toward the streak, so the dormancy pass runs after the expiry.
    const reapStart = schema.indexOf("'nak-samskara-reap'");
    const jobOpen = schema.indexOf('$job$', reapStart);
    const reapBlock = schema.slice(jobOpen, schema.indexOf('$job$', jobOpen + 5) + 5);
    const job = reapBlock.match(/select (.*?) \$job\$/);
    expect(job).not.toBeNull();
    const chain = job![1];
    const expire = chain.indexOf('samskara_expire_unjudgeable_fires');
    const dormant = chain.indexOf('samskara_reap_dormant');
    const dead = chain.indexOf('samskara_reap_dead');
    expect(expire).toBeGreaterThanOrEqual(0);
    expect(dormant).toBeGreaterThan(expire);
    expect(dead).toBeGreaterThan(dormant);
  });

  it('the verdict_counts streak field computes the TRUE run length', () => {
    const vc = fnBody('samskara_verdict_counts');
    // min(rn) of non-not-engaged minus 1, falling back to total+1 - 1
    // when every verdict is not-engaged: a genuine verdict anywhere
    // resets the run; the newest-genuine case reads 0.
    expect(vc).toContain("min(rn) filter (where verdict <> 'not-engaged')");
  });

  it('the verdict_counts thread span is WINDOW-scoped (the reaper is)', () => {
    // A run longer than 15 is judged by its newest 15 - the reaper's
    // predicate is window-scoped, so the UI's thread span must be too.
    const vc = fnBody('samskara_verdict_counts');
    expect(vc).toContain('recent_not_engaged_threads int');
    expect(vc).toContain('count(distinct thread_id) from v where rn <= 15');
    // Deterministic window boundary (fired_at ties exist in practice).
    expect(vc).toContain('f.id desc');
  });

  it('the browser mappers coalesce the new fields for mixed-version windows', () => {
    // New frontend against a pre-streak schema: the RPC returns no
    // such columns and the mappers must read 0, not undefined.
    const { samskaraVerdictCounts } = {} as Record<string, never>; // shape-only guard below
    void samskaraVerdictCounts;
    const slice = readFileSync(
      join(process.cwd(), 'src', 'lib', 'supabase', 'samskara.ts'),
      'utf8'
    );
    expect(slice).toContain("recentNotEngagedStreak: (r?.recent_not_engaged_streak as number) ?? 0");
    expect(slice).toContain("recentNotEngagedThreads: (r?.recent_not_engaged_threads as number) ?? 0");
    expect(slice).toContain('dormant: r?.dormant ?? 0');
  });

  it('the health snapshot carries the dormancy pool in lockstep', () => {
    const snap = schema.slice(
      schema.indexOf('create or replace function public.samskara_health_snapshot()'),
      schema.indexOf('$$;', schema.indexOf('dormant int'))
    );
    expect(snap).toContain('dormant int');
    expect(snap).toContain('in_window = 15');
    expect(snap).toContain('genuine_in_window = 0');
    expect(snap).toContain('threads >= 5');
    // The snapshot window uses the same deterministic tiebreak.
    expect(snap).toContain('f.id desc');
  });
});
