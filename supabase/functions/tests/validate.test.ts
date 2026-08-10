// Unit tests for the central schema-based argument validator
// (validateToolArgs in venice/tools/_validate.ts). Covers each
// JSON Schema check in isolation, the combined-error behavior,
// the activity-param exemption, and the no-op cases.

import { assertThrows, assertStringIncludes } from '@std/assert';
import { validateToolArgs } from '../venice/tools/_validate.ts';

// Helper: a minimal object schema with the given properties, required
// fields, and additionalProperties: false (the shape every tool schema
// uses).
function schema(
  properties: Record<string, Record<string, unknown>>,
  required: string[] = [],
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    type: 'object',
    properties,
    required,
    additionalProperties: false,
    ...extra,
  };
}

Deno.test('validateToolArgs: rejects unknown keys when additionalProperties is false', () => {
  const s = schema(
    { name: { type: 'string' } },
    ['name'],
  );
  const err = assertThrows(
    () => validateToolArgs(s, { name: 'ok', bogus: true }),
    Error,
  );
  assertStringIncludes(err.message, 'unrecognized parameter: bogus');
});

Deno.test('validateToolArgs: allows unknown keys when additionalProperties is not false', () => {
  const s = schema(
    { name: { type: 'string' } },
    ['name'],
    { additionalProperties: true },
  );
  // Should not throw - extra key is allowed.
  validateToolArgs(s, { name: 'ok', extra: 1 });
});

Deno.test('validateToolArgs: rejects missing required field', () => {
  const s = schema(
    { name: { type: 'string' }, value: { type: 'number' } },
    ['name', 'value'],
  );
  const err = assertThrows(
    () => validateToolArgs(s, { name: 'ok' }),
    Error,
  );
  assertStringIncludes(err.message, 'missing required parameter: value');
});

Deno.test('validateToolArgs: rejects required field present but undefined', () => {
  const s = schema(
    { name: { type: 'string' } },
    ['name'],
  );
  const err = assertThrows(
    () => validateToolArgs(s, { name: undefined }),
    Error,
  );
  assertStringIncludes(err.message, 'missing required parameter: name');
});

Deno.test('validateToolArgs: rejects type mismatch - string expected, number found', () => {
  const s = schema({ label: { type: 'string' } }, ['label']);
  const err = assertThrows(
    () => validateToolArgs(s, { label: 42 }),
    Error,
  );
  assertStringIncludes(err.message, 'type error: label expects a string, but a number was found');
});

Deno.test('validateToolArgs: rejects type mismatch - number expected, string found', () => {
  const s = schema({ count: { type: 'number' } }, ['count']);
  const err = assertThrows(
    () => validateToolArgs(s, { count: 'five' }),
    Error,
  );
  assertStringIncludes(err.message, 'type error: count expects a number, but a string was found');
});

Deno.test('validateToolArgs: rejects type mismatch - boolean expected, string found', () => {
  const s = schema({ active: { type: 'boolean' } }, ['active']);
  const err = assertThrows(
    () => validateToolArgs(s, { active: 'yes' }),
    Error,
  );
  assertStringIncludes(err.message, 'type error: active expects a boolean, but a string was found');
});

Deno.test('validateToolArgs: rejects type mismatch - array expected, object found', () => {
  const s = schema({ items: { type: 'array' } }, ['items']);
  const err = assertThrows(
    () => validateToolArgs(s, { items: { a: 1 } }),
    Error,
  );
  assertStringIncludes(err.message, 'type error: items expects a array, but an object was found');
});

Deno.test('validateToolArgs: rejects type mismatch - object expected, array found', () => {
  const s = schema({ meta: { type: 'object' } }, ['meta']);
  const err = assertThrows(
    () => validateToolArgs(s, { meta: [1, 2] }),
    Error,
  );
  assertStringIncludes(err.message, 'type error: meta expects a object, but an array was found');
});

Deno.test('validateToolArgs: rejects null as object', () => {
  const s = schema({ meta: { type: 'object' } }, ['meta']);
  const err = assertThrows(
    () => validateToolArgs(s, { meta: null }),
    Error,
  );
  assertStringIncludes(err.message, 'type error: meta expects a object, but null was found');
});

Deno.test('validateToolArgs: rejects string exceeding maxLength', () => {
  const s = schema({ label: { type: 'string', maxLength: 5 } }, ['label']);
  const err = assertThrows(
    () => validateToolArgs(s, { label: 'abcdef' }),
    Error,
  );
  assertStringIncludes(err.message, 'label exceeds maximum length of 5 characters (got 6)');
});

Deno.test('validateToolArgs: rejects string below minLength', () => {
  const s = schema({ label: { type: 'string', minLength: 3 } }, ['label']);
  const err = assertThrows(
    () => validateToolArgs(s, { label: 'ab' }),
    Error,
  );
  assertStringIncludes(err.message, 'label is shorter than minimum length of 3 characters');
});

Deno.test('validateToolArgs: rejects number below minimum', () => {
  const s = schema({ score: { type: 'number', minimum: 1.0 } }, ['score']);
  const err = assertThrows(
    () => validateToolArgs(s, { score: 0.5 }),
    Error,
  );
  assertStringIncludes(err.message, 'score is below the minimum of 1');
});

Deno.test('validateToolArgs: rejects number above maximum', () => {
  const s = schema({ score: { type: 'number', maximum: 10.0 } }, ['score']);
  const err = assertThrows(
    () => validateToolArgs(s, { score: 11 }),
    Error,
  );
  assertStringIncludes(err.message, 'score exceeds the maximum of 10');
});

Deno.test('validateToolArgs: rejects value not in enum', () => {
  const s = schema({
    color: { type: 'string', enum: ['red', 'green', 'blue'] },
  }, ['color']);
  const err = assertThrows(
    () => validateToolArgs(s, { color: 'purple' }),
    Error,
  );
  assertStringIncludes(err.message, 'color must be one of: red, green, blue');
});

Deno.test('validateToolArgs: accepts value in enum', () => {
  const s = schema({
    color: { type: 'string', enum: ['red', 'green', 'blue'] },
  }, ['color']);
  validateToolArgs(s, { color: 'red' });
});

Deno.test('validateToolArgs: collects multiple errors in one throw', () => {
  const s = schema(
    {
      name: { type: 'string', minLength: 3 },
      count: { type: 'number', minimum: 1 },
    },
    ['name', 'count'],
  );
  // Three problems: bogus unknown key, name too short, count below minimum.
  const err = assertThrows(
    () => validateToolArgs(s, { name: 'ab', count: 0, bogus: true }),
    Error,
  );
  assertStringIncludes(err.message, 'unrecognized parameter: bogus');
  assertStringIncludes(err.message, 'name is shorter than minimum length of 3 characters');
  assertStringIncludes(err.message, 'count is below the minimum of 1');
});

Deno.test('validateToolArgs: skips activity in the required check', () => {
  // The wire schema injects `activity` into properties and required, but
  // the dispatcher strips it from args before calling the validator.
  // Without the skip, every call would fail with "missing required
  // parameter: activity".
  const s = schema(
    { name: { type: 'string' }, activity: { type: 'string' } },
    ['name', 'activity'],
  );
  // activity is in required but absent from args - should NOT throw.
  validateToolArgs(s, { name: 'ok' });
});

Deno.test('validateToolArgs: no-op when schema is undefined', () => {
  // Should not throw.
  validateToolArgs(undefined, { anything: true });
});

Deno.test('validateToolArgs: no-op when schema has no properties', () => {
  // Should not throw.
  validateToolArgs({ type: 'object' }, { anything: true });
});

Deno.test('validateToolArgs: passes valid args without throwing', () => {
  const s = schema(
    {
      label: { type: 'string', minLength: 1, maxLength: 80 },
      confidence: { type: 'number', minimum: 1.0, maximum: 10.0 },
      category: { type: 'string', enum: ['note', 'task', 'idea'] },
    },
    ['label'],
  );
  validateToolArgs(s, {
    label: 'my memory',
    confidence: 5.0,
    category: 'note',
  });
});

Deno.test('validateToolArgs: does not coerce quoted numbers - rejects type mismatch', () => {
  // The validator rejects type mismatches; tools that want coercion
  // (like requireFiniteNumber) keep their own logic.
  const s = schema({ score: { type: 'number' } }, ['score']);
  const err = assertThrows(
    () => validateToolArgs(s, { score: '5.0' }),
    Error,
  );
  assertStringIncludes(err.message, 'type error: score expects a number, but a string was found');
});
