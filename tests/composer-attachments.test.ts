/**
 * Unit coverage for the composer chip-status primitive. The canvas-based
 * `compressImage` itself isn't covered here (jsdom has no Canvas 2D, same
 * as `maybeDownscaleImage`); this tests the pure state-resolution and
 * label logic that drives the chip.
 */
import { describe, it, expect } from 'vitest';
import { chipStatus, compressionLabel } from '../src/lib/ui/composer-attachments';

type ChipInput = Parameters<typeof chipStatus>[0];

function chip(overrides: Partial<ChipInput> = {}): ChipInput {
  return {
    compressing: false,
    pending: false,
    error: null,
    compression: null,
    ...overrides,
  };
}

describe('compressionLabel', () => {
  it('spells out the before/after sizes', () => {
    expect(
      compressionLabel({ beforeBytes: 2_852_126, afterBytes: 865_280 })
    ).toBe('Reduced from 2.7 MB to 845 KB');
  });
});

describe('chipStatus', () => {
  it('puts an error ahead of any in-flight flag', () => {
    expect(chipStatus(chip({ error: 'boom', compressing: true, pending: true })).kind).toBe(
      'error'
    );
  });

  it('shows the compressing state ahead of the generic pending spinner', () => {
    // compressing implies pending; the user-facing copy differs, so the
    // narrower state wins.
    expect(chipStatus(chip({ compressing: true, pending: true })).kind).toBe('compressing');
  });

  it('falls back to pending while text extraction is in flight', () => {
    expect(chipStatus(chip({ pending: true })).kind).toBe('pending');
  });

  it('reports a completed compression with its label', () => {
    const status = chipStatus(chip({ compression: { beforeBytes: 2_852_126, afterBytes: 865_280 } }));
    expect(status).toEqual({ kind: 'compressed', label: 'Reduced from 2.7 MB to 845 KB' });
  });

  it('is ready when nothing is pending and nothing was compressed', () => {
    expect(chipStatus(chip()).kind).toBe('ready');
  });
});
