// Offline unit tests for the interrupted-marker helper. Pure string
// logic shared by the orchestrator's terminal abort write and the
// browser's history projection, so it runs under `deno test` with no
// network. The marker-alone case is load-bearing: the orchestrator
// always persists an 'aborted' row even when nothing streamed (so a
// deliberate stop is a first-class, cross-device-visible record), and
// that row's content is exactly withInterruptedMarker('').
import { assertEquals } from '@std/assert';
import {
  INTERRUPTED_MARKER,
  withInterruptedMarker,
} from '../_shared/venice-stream.ts';

Deno.test('withInterruptedMarker returns the marker alone when nothing streamed', () => {
  assertEquals(withInterruptedMarker(''), INTERRUPTED_MARKER);
});

Deno.test('withInterruptedMarker paragraph-spaces the marker after partial text', () => {
  assertEquals(
    withInterruptedMarker('half an answer'),
    `half an answer\n\n${INTERRUPTED_MARKER}`,
  );
});
