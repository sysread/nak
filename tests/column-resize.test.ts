import { describe, it, expect, beforeEach } from 'vitest';
import {
  clampColumnWidth,
  readColumnWidth,
  storeColumnWidth,
  __storageKey,
} from '../src/lib/ui/column-resize';

describe('clampColumnWidth', () => {
  // A roomy desktop where the 40vw cap never bites, so the per-column
  // min/max bounds are what's under test.
  const wide = 4000;

  it('floors the sidebar at its minimum', () => {
    expect(clampColumnWidth('sidebar', 50, wide)).toBe(180);
  });
  it('caps the sidebar at its maximum', () => {
    expect(clampColumnWidth('sidebar', 9999, wide)).toBe(560);
  });
  it('floors the logs panel at its minimum', () => {
    expect(clampColumnWidth('logs', 0, wide)).toBe(240);
  });
  it('caps the logs panel at its maximum', () => {
    expect(clampColumnWidth('logs', 9999, wide)).toBe(680);
  });
  it('passes through a value inside the bounds (rounded)', () => {
    expect(clampColumnWidth('sidebar', 300.6, wide)).toBe(301);
  });

  it('applies the 40vw viewport cap before the per-column max', () => {
    // 40% of 1000 = 400, below the sidebar's 560 ceiling, so the
    // viewport cap wins.
    expect(clampColumnWidth('sidebar', 9999, 1000)).toBe(400);
  });

  it('lets the minimum win when the viewport cap falls below it', () => {
    // 40% of 300 = 120, under the sidebar's 180 floor; the floor must
    // still hold so the panel never collapses past usability.
    expect(clampColumnWidth('sidebar', 9999, 300)).toBe(180);
    expect(clampColumnWidth('sidebar', 50, 300)).toBe(180);
  });
});

describe('storeColumnWidth / readColumnWidth', () => {
  beforeEach(() => localStorage.clear());

  it('returns null with no stored preference', () => {
    expect(readColumnWidth('sidebar')).toBeNull();
    expect(readColumnWidth('logs')).toBeNull();
  });

  it('round-trips a single column without disturbing the other', () => {
    storeColumnWidth('sidebar', 320);
    expect(readColumnWidth('sidebar')).toBe(320);
    expect(readColumnWidth('logs')).toBeNull();
  });

  it('keeps both columns independent', () => {
    storeColumnWidth('sidebar', 320);
    storeColumnWidth('logs', 440);
    expect(readColumnWidth('sidebar')).toBe(320);
    expect(readColumnWidth('logs')).toBe(440);
  });

  it('overwrites a prior value for the same column', () => {
    storeColumnWidth('sidebar', 320);
    storeColumnWidth('sidebar', 500);
    expect(readColumnWidth('sidebar')).toBe(500);
  });

  it('rounds on the way in', () => {
    storeColumnWidth('logs', 412.7);
    expect(readColumnWidth('logs')).toBe(413);
  });

  it('treats malformed JSON as no preference', () => {
    localStorage.setItem(__storageKey, 'not json');
    expect(readColumnWidth('sidebar')).toBeNull();
  });

  it('ignores non-numeric stored fields', () => {
    localStorage.setItem(__storageKey, JSON.stringify({ sidebar: 'wide' }));
    expect(readColumnWidth('sidebar')).toBeNull();
  });
});
