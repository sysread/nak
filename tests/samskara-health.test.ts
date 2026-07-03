/**
 * Unit coverage for the Samskara Health panel primitives. Pure
 * functions, no mount - drives the severity classification, the
 * regen-status derivation, and the health-side labels the panel
 * delegates to. The browse/detail primitives are covered in
 * tests/samskara-browse.test.ts.
 */
import { describe, it, expect } from 'vitest';
import {
  severityFor,
  compoundRegenStatus,
  worstSeverity,
  healthHeadline,
  verdictBreakdown,
  tier2CandidateLabel,
  samskaraCountPhrase,
  HEALTH_THRESHOLDS,
} from '../src/lib/ui/samskara-health';

describe('severityFor', () => {
  it('classifies against a [warn, alarm] pair', () => {
    expect(severityFor(0, HEALTH_THRESHOLDS.orphanFires)).toBe('ok');
    expect(severityFor(1, HEALTH_THRESHOLDS.orphanFires)).toBe('warn');
    expect(severityFor(5, HEALTH_THRESHOLDS.orphanFires)).toBe('alarm');
    expect(severityFor(49, HEALTH_THRESHOLDS.pendingAssimilate)).toBe('ok');
    expect(severityFor(50, HEALTH_THRESHOLDS.pendingAssimilate)).toBe('warn');
    expect(severityFor(500, HEALTH_THRESHOLDS.pendingAssimilate)).toBe('alarm');
  });
});

describe('compoundRegenStatus', () => {
  // threshold = max(3, ceil(5 * log10(total + 10))). At total=152 the bar
  // is ceil(5 * log10(162)) = ceil(11.04) = 12; alarm at 2x = 24.
  it('severity tracks the regen backlog, not the summary age', () => {
    expect(compoundRegenStatus(152, 152, true).sev).toBe('ok'); // 0 new
    expect(compoundRegenStatus(152, 145, true).sev).toBe('ok'); // 7 < 12
    expect(compoundRegenStatus(152, 140, true).sev).toBe('warn'); // 12 >= 12
    expect(compoundRegenStatus(152, 128, true).sev).toBe('alarm'); // 24 >= 24
  });
  it('exposes the delta and threshold for the readout', () => {
    expect(compoundRegenStatus(152, 145, true)).toMatchObject({ delta: 7, threshold: 12 });
  });
  it('floors the threshold at 3 for a small corpus', () => {
    // ceil(5 * log10(13)) = ceil(5.57) = 6, so the floor doesn't bind
    // here; a near-empty corpus (total=0 -> ceil(5*log10(10))=5) is still
    // above 3, so the floor only matters as a guard, never a false alarm.
    expect(compoundRegenStatus(3, 0, true).threshold).toBeGreaterThanOrEqual(3);
  });
  it('treats a missing summary as warn when any samskaras exist, else ok', () => {
    expect(compoundRegenStatus(5, 0, false).sev).toBe('warn');
    expect(compoundRegenStatus(0, 0, false).sev).toBe('ok');
  });
  it('clamps a negative delta to ok (count_at_regen above current count)', () => {
    // A regen stamped a higher count than the live total (e.g. reaping
    // dropped rows after the stamp) must not read as a backlog.
    expect(compoundRegenStatus(140, 152, true).sev).toBe('ok');
  });
});

describe('worstSeverity', () => {
  it('alarm dominates warn dominates ok', () => {
    expect(worstSeverity(['ok', 'warn', 'alarm'])).toBe('alarm');
    expect(worstSeverity(['ok', 'warn'])).toBe('warn');
    expect(worstSeverity(['ok', 'ok'])).toBe('ok');
    expect(worstSeverity([])).toBe('ok');
  });
});

describe('healthHeadline', () => {
  it('maps each severity tier to its headline phrase', () => {
    expect(healthHeadline('ok')).toBe('Pipeline healthy');
    expect(healthHeadline('warn')).toBe('Needs a look');
    expect(healthHeadline('alarm')).toBe('Something is stuck');
  });
});

describe('verdictBreakdown', () => {
  it('emits the four verdicts in the panel stack order', () => {
    const out = verdictBreakdown({ held: 5, contradicted: 2, notBorneOut: 3, notEngaged: 7 });
    expect(out.map((v) => v.label)).toEqual([
      'held',
      'contradicted',
      'not-borne-out',
      'not-engaged',
    ]);
    expect(out.map((v) => v.count)).toEqual([5, 2, 3, 7]);
  });
});

describe('tier2CandidateLabel', () => {
  it('reports none when nothing is offerable', () => {
    expect(tier2CandidateLabel(0)).toBe('none available');
    // Defensive: the RPC never returns negatives, but the floor holds.
    expect(tier2CandidateLabel(-1)).toBe('none available');
  });
  it('reports the member count, pluralizing', () => {
    // The minter's floor is 3, so 1 is the defensive-singular path.
    expect(tier2CandidateLabel(1)).toBe('available (1 member)');
    expect(tier2CandidateLabel(4)).toBe('available (4 members)');
  });
});

describe('samskaraCountPhrase', () => {
  it('pluralizes the coverage caption', () => {
    expect(samskaraCountPhrase(0)).toBe('0 samskaras');
    expect(samskaraCountPhrase(1)).toBe('1 samskara');
    expect(samskaraCountPhrase(14)).toBe('14 samskaras');
  });
});
