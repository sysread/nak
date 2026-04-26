/**
 * Coverage for the (valence, confidence) -> emoji + label mapping that
 * drives the samskara formation mood pill. Pure functions, so direct-
 * call tests. Two axes now: five valence bands x two confidence bands.
 * Keep an eye on the band boundaries: adjusting the bucket widths or
 * the confidence cut changes which emoji a minted samskara surfaces
 * for, and the widths were picked deliberately (0.3-wide valence
 * buckets centered on zero; confidence cut at 0.5 because the minter
 * outputs [0, 1] and 0.5 is the natural midpoint).
 *
 * The "confident" column is reached by passing confidence >= 0.5 OR
 * by omitting the confidence argument entirely; the latter behavior
 * is what keeps single-axis legacy callers working unchanged.
 */
import { describe, it, expect } from 'vitest';
import {
  valenceToEmoji,
  valenceToMoodLabel,
  MOOD_TABLE,
  CONFIDENCE_CUT,
} from '../src/lib/samskara/events';

describe('valenceToEmoji - confident column (default, confidence omitted)', () => {
  it('maps strongly positive valence to the smiling face', () => {
    expect(valenceToEmoji(1)).toBe('\u{1F60A}');
    expect(valenceToEmoji(0.6)).toBe('\u{1F60A}');
  });

  it('maps mildly positive valence to the slight smile', () => {
    expect(valenceToEmoji(0.59)).toBe('\u{1F642}');
    expect(valenceToEmoji(0.2)).toBe('\u{1F642}');
  });

  it('maps the neutral band to the neutral face', () => {
    expect(valenceToEmoji(0.19)).toBe('\u{1F610}');
    expect(valenceToEmoji(0)).toBe('\u{1F610}');
    expect(valenceToEmoji(-0.19)).toBe('\u{1F610}');
  });

  it('maps mildly negative valence to the confused face', () => {
    expect(valenceToEmoji(-0.2)).toBe('\u{1F615}');
    expect(valenceToEmoji(-0.59)).toBe('\u{1F615}');
  });

  it('maps strongly negative valence to the pensive face', () => {
    expect(valenceToEmoji(-0.6)).toBe('\u{1F614}');
    expect(valenceToEmoji(-1)).toBe('\u{1F614}');
  });

  it('clamps out-of-range values into the top / bottom bucket', () => {
    // Minter already clamps to [-1, 1]; this is defensive for anything
    // that slips past (e.g. a future provenance-weighted aggregate on
    // tier-2 that sums children without re-clamping).
    expect(valenceToEmoji(5)).toBe('\u{1F60A}');
    expect(valenceToEmoji(-5)).toBe('\u{1F614}');
  });
});

describe('valenceToEmoji - tentative column (confidence < 0.5)', () => {
  it('maps strongly positive + tentative to the slight smile', () => {
    expect(valenceToEmoji(0.8, 0.4)).toBe('\u{1F642}');
  });

  it('maps mildly positive + tentative to the thinking face', () => {
    expect(valenceToEmoji(0.3, 0.2)).toBe('\u{1F914}');
  });

  it('maps neutral + tentative to the raised-eyebrow skeptical face', () => {
    expect(valenceToEmoji(0, 0)).toBe('\u{1F928}');
    expect(valenceToEmoji(-0.1, 0.49)).toBe('\u{1F928}');
  });

  it('maps mildly negative + tentative to the grimacing face', () => {
    expect(valenceToEmoji(-0.4, 0.3)).toBe('\u{1F62C}');
  });

  it('maps strongly negative + tentative to the sad-but-relieved face', () => {
    expect(valenceToEmoji(-0.9, 0.1)).toBe('\u{1F625}');
  });
});

describe('valenceToEmoji - confidence cut boundary', () => {
  it('treats confidence === CONFIDENCE_CUT as confident', () => {
    // 0.5 is the inclusive boundary on the confident column - claims
    // exactly at the midpoint render as confident. Test pins this so
    // shifting CONFIDENCE_CUT later requires an explicit decision.
    expect(CONFIDENCE_CUT).toBe(0.5);
    expect(valenceToEmoji(0, 0.5)).toBe('\u{1F610}');
    expect(valenceToEmoji(0, 0.4999)).toBe('\u{1F928}');
  });
});

describe('valenceToMoodLabel', () => {
  it('returns confident-column labels at default confidence', () => {
    expect(valenceToMoodLabel(0.8)).toBe('cheerful');
    expect(valenceToMoodLabel(0.3)).toBe('content');
    expect(valenceToMoodLabel(0)).toBe('neutral');
    expect(valenceToMoodLabel(-0.4)).toBe('uneasy');
    expect(valenceToMoodLabel(-0.8)).toBe('pensive');
  });

  it('returns tentative-column labels when confidence < 0.5', () => {
    expect(valenceToMoodLabel(0.8, 0.3)).toBe('tentatively cheerful');
    expect(valenceToMoodLabel(0.3, 0.3)).toBe('thoughtful');
    expect(valenceToMoodLabel(0, 0.3)).toBe('skeptical');
    expect(valenceToMoodLabel(-0.4, 0.3)).toBe('wary');
    expect(valenceToMoodLabel(-0.8, 0.3)).toBe('rueful');
  });
});

describe('MOOD_TABLE shape', () => {
  it('has five rows in descending valence order', () => {
    expect(MOOD_TABLE.length).toBe(5);
    for (let i = 1; i < MOOD_TABLE.length; i++) {
      expect(MOOD_TABLE[i].valenceMin).toBeLessThan(MOOD_TABLE[i - 1].valenceMin);
    }
  });

  it('has -Infinity as the bottom row sentinel', () => {
    // The bottom row catches everything below the lowest cut
    // including out-of-range -1.2; -Infinity is the load-bearing
    // sentinel that makes the lookup branchless. Without it, a
    // valence below -0.6 would fall through bandFor() and throw.
    expect(MOOD_TABLE[MOOD_TABLE.length - 1].valenceMin).toBe(-Infinity);
  });

  it('every cell has a glyph and a label', () => {
    for (const row of MOOD_TABLE) {
      expect(row.confidentEmoji.length).toBeGreaterThan(0);
      expect(row.confidentLabel.length).toBeGreaterThan(0);
      expect(row.tentativeEmoji.length).toBeGreaterThan(0);
      expect(row.tentativeLabel.length).toBeGreaterThan(0);
    }
  });
});
