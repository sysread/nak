// Deno coverage for the priming payload coercers - the drift guards the
// orchestration runs thread-cache rows through and the browser runs the
// wire payloads through. A malformed / older-version row must coerce to
// null (treated as "no cache"), and the known-valid edge cases (empty
// context-recall note; the intuition synthesis-echo regression) must be
// handled exactly.
import { assert, assertEquals } from 'jsr:@std/assert';
import { coerceIntuitionPayload } from '../venice/priming/intuition-payload.ts';
import { coerceContextRecallPayload } from '../venice/priming/context-recall-payload.ts';

const intuition = {
  v: 1,
  perception: 'Classification: technical',
  drives: { curiosity: 'I want to know more', pragmatism: 'what is the goal' },
  synthesis: 'I should answer tersely.',
  computed_at_round: 3,
  computed_at_band: 2,
  computed_at_column: 'confident',
  computed_at_at: 1_000,
  trigger: 'cold',
};

Deno.test('intuition: a well-formed payload coerces through', () => {
  const out = coerceIntuitionPayload(intuition);
  assert(out !== null);
  assertEquals(out!.synthesis, 'I should answer tersely.');
  assertEquals(out!.drives.curiosity, 'I want to know more');
});

Deno.test('intuition: wrong version / missing fields -> null', () => {
  assertEquals(coerceIntuitionPayload({ ...intuition, v: 2 }), null);
  assertEquals(coerceIntuitionPayload({ ...intuition, perception: '' }), null);
  assertEquals(coerceIntuitionPayload({ ...intuition, computed_at_at: 'soon' }), null);
  assertEquals(coerceIntuitionPayload(null), null);
});

Deno.test('intuition: rejects a synthesis that echoed the system prompt', () => {
  // The fast-tier echo regression shipped the prompt body in synthesis;
  // the guard treats such a row as cold so the next turn recomputes.
  assertEquals(
    coerceIntuitionPayload({ ...intuition, synthesis: 'You are the Subconsciousness of an AI agent...' }),
    null,
  );
});

Deno.test('intuition: drops drive entries that are not known names / non-string', () => {
  const out = coerceIntuitionPayload({
    ...intuition,
    drives: { curiosity: 'ok', bogus: 'x', candor: 42 },
  });
  assert(out !== null);
  assertEquals(out!.drives.curiosity, 'ok');
  assertEquals('bogus' in out!.drives, false);
  assertEquals('candor' in out!.drives, false);
});

Deno.test('context-recall: a well-formed payload coerces through', () => {
  const out = coerceContextRecallPayload({
    v: 2,
    note: 'I remember we discussed X ^1^.',
    citations: [{ index: 1, kind: 'memory', id: 'm1', label: 'X' }],
    computed_at_round: 2,
    computed_at_band: null,
    computed_at_column: null,
    computed_at_at: 1_000,
    trigger: 'stale',
  });
  assert(out !== null);
  assertEquals(out!.note, 'I remember we discussed X ^1^.');
  assertEquals(out!.citations.length, 1);
  assertEquals(out!.citations[0].id, 'm1');
});

Deno.test('context-recall: an empty note is a VALID cached state (not null)', () => {
  // note === '' means "nothing relevant surfaced this round" - a real
  // cached negative the trigger debounce relies on; it must NOT coerce
  // to null.
  const out = coerceContextRecallPayload({
    v: 2,
    note: '',
    citations: [],
    computed_at_round: 2,
    computed_at_band: null,
    computed_at_column: null,
    computed_at_at: 1_000,
    trigger: 'cold',
  });
  assert(out !== null);
  assertEquals(out!.note, '');
});

Deno.test('context-recall: the pre-smoothing v1 shape coerces to null', () => {
  // v1 (note only, no citations) must read as "no cache" so the next
  // trigger recomputes into the v2 smoothed shape.
  assertEquals(
    coerceContextRecallPayload({ v: 1, note: 'x', computed_at_round: 1, computed_at_at: 1 }),
    null,
  );
});

Deno.test('context-recall: wrong version / non-string note -> null', () => {
  assertEquals(coerceContextRecallPayload({ v: 9, note: 'x', computed_at_round: 1, computed_at_at: 1 }), null);
  assertEquals(coerceContextRecallPayload({ v: 2, note: 123, citations: [], computed_at_round: 1, computed_at_at: 1 }), null);
});

Deno.test('context-recall: malformed citations degrade to [] without dropping the payload', () => {
  const out = coerceContextRecallPayload({
    v: 2,
    note: 'recollection ^1^',
    citations: 'not-an-array',
    computed_at_round: 2,
    computed_at_band: null,
    computed_at_column: null,
    computed_at_at: 1_000,
    trigger: 'cold',
  });
  assert(out !== null);
  assertEquals(out!.citations, []);
});
