// Guards for the salvage re-roll helpers in venice/stream-guards.ts:
// the empty-completion predicate the orchestrator's round loop keys on,
// the shared retry temperature schedule, and the leak guard's use of
// that schedule. Pure: no DB, no network.

import { assertEquals, assertNotStrictEquals } from '@std/assert';
import {
  isEmptyCompletion,
  retryTemperatureBody,
  specialTokenLeakGuard,
} from '../venice/stream-guards.ts';

Deno.test('a round with no text and no tool call is empty', () => {
  assertEquals(isEmptyCompletion('', false), true);
});

Deno.test('whitespace-only text is still empty', () => {
  assertEquals(isEmptyCompletion(' \n\t', false), true);
});

Deno.test('any visible text makes the round usable', () => {
  assertEquals(isEmptyCompletion('ok', false), false);
});

Deno.test('a tool call makes the round usable even with no text', () => {
  // Tool rounds carry empty content by design - the calls are the
  // payload. They must never be re-rolled as empty.
  assertEquals(isEmptyCompletion('', true), false);
});

Deno.test('retryTemperatureBody walks the schedule and clamps past its end', () => {
  const body = { model: 'm', temperature: 0 };
  assertEquals(retryTemperatureBody(body, 1).temperature, 0.8);
  assertEquals(retryTemperatureBody(body, 2).temperature, 1.0);
  assertEquals(retryTemperatureBody(body, 3).temperature, 1.2);
  assertEquals(retryTemperatureBody(body, 4).temperature, 1.4);
  assertEquals(retryTemperatureBody(body, 9).temperature, 1.4);
});

Deno.test('retryTemperatureBody never mutates the input body', () => {
  const body = { model: 'm', temperature: 0 };
  const out = retryTemperatureBody(body, 1);
  assertNotStrictEquals(out, body);
  assertEquals(body.temperature, 0);
  assertEquals(out.model, 'm');
});

Deno.test('the leak guard re-rolls on the shared schedule', () => {
  const guard = specialTokenLeakGuard();
  const out = guard.prepareRetry({ model: 'm', temperature: 0.2 }, 2);
  assertEquals(out.temperature, 1.0);
});
