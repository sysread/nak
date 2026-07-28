/**
 * Unit coverage for the PDF rasterizer's pure decision logic.
 *
 * `renderPdfPages` itself is not testable here - jsdom has neither a canvas
 * nor a Web Worker, the same reason `compressImage` is uncovered - so this
 * targets the scale math, which is what stands between legible scanned text
 * and a page the vision model can't read.
 */
import { describe, it, expect } from 'vitest';
import {
  isPdfMimeType,
  MAX_RENDERED_PDF_PAGES,
  PDF_PAGE_LONG_EDGE_PX,
  __test,
} from '../src/lib/pdf-pages';

const { fitScale } = __test;

describe('isPdfMimeType', () => {
  it('matches only the exact PDF type', () => {
    expect(isPdfMimeType('application/pdf')).toBe(true);
    expect(isPdfMimeType('image/png')).toBe(false);
    expect(isPdfMimeType('application/x-pdf')).toBe(false);
    // Nothing upstream normalizes case or strips parameters, so a browser
    // that hands us a decorated type simply isn't rasterized (it still gets
    // text extraction). Documented rather than silently coerced.
    expect(isPdfMimeType('application/pdf; charset=binary')).toBe(false);
    expect(isPdfMimeType('')).toBe(false);
  });
});

describe('fitScale', () => {
  it('scales an oversized page down to the long-edge cap', () => {
    // A 2000pt-tall page must land exactly on the cap, not near it.
    const scale = fitScale(1000, 2000);
    expect(scale).toBeCloseTo(PDF_PAGE_LONG_EDGE_PX / 2000);
    expect(2000 * scale).toBeCloseTo(PDF_PAGE_LONG_EDGE_PX);
  });

  it('keys on the LONG edge regardless of orientation', () => {
    // Landscape and portrait pages of the same extent get the same scale;
    // keying on height alone would render wide pages at double resolution.
    expect(fitScale(2000, 1000)).toBeCloseTo(fitScale(1000, 2000));
  });

  it('never upscales a page that already fits', () => {
    // Upscaling adds no detail the source has and only inflates the JPEG.
    expect(fitScale(600, 800)).toBe(1);
    expect(fitScale(PDF_PAGE_LONG_EDGE_PX, PDF_PAGE_LONG_EDGE_PX)).toBe(1);
  });

  it('falls back to 1:1 on a degenerate page box', () => {
    // A zero extent would divide to Infinity and hand pdf.js an unusable
    // viewport rather than failing loudly.
    expect(fitScale(0, 0)).toBe(1);
    expect(fitScale(-10, 0)).toBe(1);
  });
});

describe('render caps', () => {
  it('keeps the page cap positive and the long edge large enough to read', () => {
    // Tripwires for a careless retune: a zero cap would silently disable
    // rasterization everywhere, and dropping the long edge much below this
    // makes scanned body text illegible to the vision model.
    expect(MAX_RENDERED_PDF_PAGES).toBeGreaterThan(0);
    expect(PDF_PAGE_LONG_EDGE_PX).toBeGreaterThanOrEqual(1000);
  });
});
