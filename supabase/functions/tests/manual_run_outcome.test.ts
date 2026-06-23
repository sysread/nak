// Unit coverage for buildManualRunOutcome - the pure planner behind the
// detached-run outcome persistence. The DB write (persistManualRunOutcome)
// is a thin wrapper; the column mapping and skip rules are what matter, and
// they're all here so they can be checked without a Supabase client.

import { assertEquals } from '@std/assert';
import { buildManualRunOutcome } from '../_shared/manual-run-outcome.ts';

const NOW = '2026-06-23T12:00:00.000Z';

Deno.test('wiki-librarian maps to the wiki outcome column', () => {
  const planned = buildManualRunOutcome(
    'wiki-librarian',
    'run-1',
    { kind: 'ok', finalText: 'done', toolCalls: 2, articleCount: 5 },
    NOW,
  );
  assertEquals(planned?.column, 'wiki_librarian_last_run_outcome');
  assertEquals(planned?.payload, {
    runId: 'run-1',
    source: 'wiki-librarian',
    finishedAt: NOW,
    result: { kind: 'ok', finalText: 'done', toolCalls: 2, articleCount: 5 },
  });
});

Deno.test('both memory passes share the memory outcome column', () => {
  for (const source of ['rem', 'deep-sleep']) {
    const planned = buildManualRunOutcome(source, 'r', { kind: 'ok' }, NOW);
    assertEquals(planned?.column, 'memory_librarian_last_run_outcome');
    assertEquals(planned?.payload.source, source);
  }
});

Deno.test('a busy result is never persisted (no run happened)', () => {
  assertEquals(buildManualRunOutcome('rem', 'r', { kind: 'busy' }, NOW), null);
  assertEquals(buildManualRunOutcome('wiki-librarian', 'r', { kind: 'busy' }, NOW), null);
});

Deno.test('an error result IS persisted (it is a terminal outcome)', () => {
  const planned = buildManualRunOutcome(
    'deep-sleep',
    'r',
    { kind: 'error', error: 'boom' },
    NOW,
  );
  assertEquals(planned?.payload.result, { kind: 'error', error: 'boom' });
});

Deno.test('an unknown source is not recoverable and is skipped', () => {
  assertEquals(buildManualRunOutcome('reflection', 'r', { kind: 'ok' }, NOW), null);
});
