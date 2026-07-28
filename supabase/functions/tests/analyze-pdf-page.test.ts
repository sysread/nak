// Offline unit tests for analyze_pdf_page's viewable-page describer.
//
// This string is what the model relays to the user when it can't see the
// page they asked about ("the document has 200 pages; viewable pages are
// 1-30"), so a wrong range reads as a confident lie about what was
// rendered. Ranges are not always contiguous: rendering is capped at the
// leading pages, and an individual page that fails to rasterize is skipped.
import { assertEquals } from '@std/assert';
import { __test } from '../venice/tools/analyze_pdf_page.ts';

const { describeRanges } = __test;

Deno.test('collapses a contiguous run into one range', () => {
  assertEquals(describeRanges([1, 2, 3, 4, 5]), '1-5');
});

Deno.test('renders a single page without a dash', () => {
  assertEquals(describeRanges([7]), '7');
});

Deno.test('splits on a gap left by a page that failed to render', () => {
  assertEquals(describeRanges([1, 2, 3, 5, 6]), '1-3, 5-6');
});

Deno.test('keeps isolated pages separate from runs', () => {
  assertEquals(describeRanges([1, 3, 4, 5, 9]), '1, 3-5, 9');
});

Deno.test('handles a fully non-contiguous set', () => {
  assertEquals(describeRanges([2, 4, 6]), '2, 4, 6');
});

Deno.test('describes the common capped-render case', () => {
  // A 200-page PDF renders its leading 30; this is the string the model
  // uses to tell the user which half of the document it can look at.
  assertEquals(
    describeRanges(Array.from({ length: 30 }, (_, i) => i + 1)),
    '1-30',
  );
});
