/**
 * Drift tripwire between the browser bias modules and their Deno
 * mirrors. The two runtimes cannot share an import (Deno requires
 * .ts-suffixed relative specifiers; the vite/tsc side forbids them),
 * so the catalog and the math tuning constants exist twice by
 * design - the established mirror-with-pointer-comment convention
 * (embed-input, edge-log, error-translate). This suite is what makes
 * the duplication safe: a one-sided edit to either copy fails the
 * gate.
 *
 * The mirrors are self-contained (no relative imports), which is the
 * property that lets vitest load them at all.
 */
import { describe, it, expect } from 'vitest';
import { BIAS_KEYS } from '../src/lib/bias/catalog-keys';
import { BIAS_CATALOG as BROWSER_CATALOG } from '../src/lib/bias/catalog';
import {
  ALPHA_PRIOR,
  BETA_PRIOR,
  CI_LB_SOFT,
  CI_LB_STRONG,
  CONFIDENCE_CAP,
  CONFIDENCE_FLOOR,
  FEEDBACK_HALF_LIFE_DAYS,
  FEEDBACK_PRIOR_WEIGHT,
  FEEDBACK_THRESHOLD_DELTA,
  HALF_LIFE_DAYS,
  MIN_USER_MESSAGES,
  N_EFF_FLOOR,
  PER_CONV_CAP,
} from '../src/lib/bias/types';
import {
  BIAS_KEYS as MIRROR_KEYS,
  BIAS_CATALOG as MIRROR_CATALOG,
} from '../supabase/functions/_shared/bias-catalog';
import * as mirrorMath from '../supabase/functions/_shared/bias-math';

describe('bias catalog mirror parity', () => {
  it('key lists match exactly, in order', () => {
    expect(MIRROR_KEYS).toEqual(BIAS_KEYS);
  });

  it('catalog entries match exactly', () => {
    expect(MIRROR_CATALOG).toEqual(BROWSER_CATALOG);
  });
});

describe('bias math constant mirror parity', () => {
  it('tuning constants match the browser values', () => {
    expect(mirrorMath.ALPHA_PRIOR).toBe(ALPHA_PRIOR);
    expect(mirrorMath.BETA_PRIOR).toBe(BETA_PRIOR);
    expect(mirrorMath.CI_LB_SOFT).toBe(CI_LB_SOFT);
    expect(mirrorMath.CI_LB_STRONG).toBe(CI_LB_STRONG);
    expect(mirrorMath.CONFIDENCE_CAP).toBe(CONFIDENCE_CAP);
    expect(mirrorMath.CONFIDENCE_FLOOR).toBe(CONFIDENCE_FLOOR);
    expect(mirrorMath.FEEDBACK_HALF_LIFE_DAYS).toBe(FEEDBACK_HALF_LIFE_DAYS);
    expect(mirrorMath.FEEDBACK_PRIOR_WEIGHT).toBe(FEEDBACK_PRIOR_WEIGHT);
    expect(mirrorMath.FEEDBACK_THRESHOLD_DELTA).toBe(FEEDBACK_THRESHOLD_DELTA);
    expect(mirrorMath.HALF_LIFE_DAYS).toBe(HALF_LIFE_DAYS);
    expect(mirrorMath.MIN_USER_MESSAGES).toBe(MIN_USER_MESSAGES);
    expect(mirrorMath.N_EFF_FLOOR).toBe(N_EFF_FLOOR);
    expect(mirrorMath.PER_CONV_CAP).toBe(PER_CONV_CAP);
  });
});
