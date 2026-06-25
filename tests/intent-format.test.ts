/**
 * Coverage for the intents system-prompt renderer. Pure function, no
 * DB / no LLM / no Deno globals - a future applyIntentPriming will
 * compose this server-side, and this suite is the module's current
 * consumer.
 *
 * The assertions pin the two load-bearing design decisions the block
 * encodes: dispositional framing (intents are leans, not turn
 * commands) and explicit precedence (user instructions win, intents
 * are last). A future edit that turned the preamble into imperative
 * phrasing, or dropped the precedence statement, would reintroduce the
 * exact conflict the framing was chosen to avoid - so these are
 * tripwires, not cosmetic checks.
 */
import { describe, it, expect } from 'vitest';
import {
  formatIntentsBlock,
  pickRenderable,
  INTENT_RENDER_CAP,
  COMBINED_APPENDIX_CEILING,
  type IntentRenderRow,
} from '../supabase/functions/_shared/intent-format';

const active = (statement: string): IntentRenderRow => ({ statement, status: 'active' });

describe('pickRenderable', () => {
  it('keeps only active rows', () => {
    const rows: IntentRenderRow[] = [
      active('a'),
      { statement: 'b', status: 'dormant' },
      { statement: 'c', status: 'retired' },
      active('d'),
    ];
    expect(pickRenderable(rows).map((r) => r.statement)).toEqual(['a', 'd']);
  });

  it('caps at INTENT_RENDER_CAP by default, preserving input order', () => {
    const rows = ['a', 'b', 'c', 'd', 'e'].map(active);
    const picked = pickRenderable(rows).map((r) => r.statement);
    expect(picked.length).toBe(INTENT_RENDER_CAP);
    expect(picked).toEqual(['a', 'b', 'c']); // freshest survive; stable order
  });

  it('honors a caller-supplied smaller cap (intents yielding to bias)', () => {
    const rows = ['a', 'b', 'c'].map(active);
    expect(pickRenderable(rows, 1).map((r) => r.statement)).toEqual(['a']);
  });

  it('yields nothing when the cap is non-positive (bias took the whole ceiling)', () => {
    const rows = ['a', 'b'].map(active);
    expect(pickRenderable(rows, 0)).toEqual([]);
    expect(pickRenderable(rows, -1)).toEqual([]);
  });
});

describe('formatIntentsBlock', () => {
  it('returns null when there are no active intents (omit, do not placeholder)', () => {
    expect(formatIntentsBlock([])).toBeNull();
    expect(
      formatIntentsBlock([
        { statement: 'x', status: 'dormant' },
        { statement: 'y', status: 'retired' },
      ]),
    ).toBeNull();
  });

  it('returns null when the bias-aware cap squeezes intents out', () => {
    expect(formatIntentsBlock(['a'].map(active), { cap: 0 })).toBeNull();
  });

  it('renders each active statement as a bullet, verbatim', () => {
    const block = formatIntentsBlock([
      active('help them test beliefs rather than seek confirmation'),
      active('lean on their strength at reframing when they are stuck'),
    ])!;
    expect(block).toContain('- help them test beliefs rather than seek confirmation');
    expect(block).toContain('- lean on their strength at reframing when they are stuck');
  });

  it('frames intents as dispositional leans, not turn commands', () => {
    const block = formatIntentsBlock([active('x')])!.toLowerCase();
    // The preamble must mark these as leans and forbid forcing them.
    expect(block).toContain('dispositional');
    expect(block).toContain('not instructions for this turn');
    expect(block).toContain('never force');
  });

  it('states explicit precedence with the user on top and intents last', () => {
    const block = formatIntentsBlock([active('x')])!;
    expect(block.toLowerCase()).toContain("user's explicit instructions come first");
    // Intents must be named as the lowest-precedence layer.
    expect(block.toLowerCase()).toContain('these intentions, last');
    // And the whimsy/register suspension carries over, matching bias.
    expect(block.toLowerCase()).toContain('suspended in jokes');
  });

  it('trims whitespace on statements so a sloppy mint does not break the bullet', () => {
    const block = formatIntentsBlock([active('  padded statement  ')])!;
    expect(block).toContain('- padded statement\n');
  });
});

describe('budget constants', () => {
  it('the per-feature cap fits within the shared ceiling', () => {
    // A sanity tripwire: if someone raises INTENT_RENDER_CAP past the
    // combined ceiling the bias doc established, intents could crowd
    // out bias entirely. They should leave room for at least some bias.
    expect(INTENT_RENDER_CAP).toBeLessThan(COMBINED_APPENDIX_CEILING);
  });
});
