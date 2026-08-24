// Guards for the leaked-think relocation at the persistence boundary
// (venice/think-leak.ts). Pure: no DB, no network.

import { assertEquals } from '@std/assert';
import { splitLeakedThink } from '../venice/think-leak.ts';

Deno.test('clean content passes through by reference', () => {
  const out = splitLeakedThink('A normal answer.', 'prior reasoning');
  assertEquals(out.content, 'A normal answer.');
  assertEquals(out.reasoning, 'prior reasoning');
});

Deno.test('a leading think block moves into reasoning', () => {
  const out = splitLeakedThink(
    '<think>secret scratch</think>The actual answer.',
    '',
  );
  assertEquals(out.content, 'The actual answer.');
  assertEquals(out.reasoning, 'secret scratch');
});

Deno.test('leaked scratch appends below existing reasoning', () => {
  const out = splitLeakedThink(
    '  <think>leak</think>Answer.',
    'channelled reasoning',
  );
  assertEquals(out.content, 'Answer.');
  assertEquals(out.reasoning, 'channelled reasoning\n\nleak');
});

Deno.test('back-to-back leading blocks all move', () => {
  const out = splitLeakedThink(
    '<think>one</think><think>two</think>Answer.',
    '',
  );
  assertEquals(out.content, 'Answer.');
  assertEquals(out.reasoning, 'one\n\ntwo');
});

Deno.test('a glitched bare opener (missing <) still relocates', () => {
  // Degraded backends that leak the span also drop characters -
  // content arriving as `think>...` was observed in QA on
  // deepseek-v4-flash.
  const out = splitLeakedThink('think>secret scratch</think>The answer.', '');
  assertEquals(out.content, 'The answer.');
  assertEquals(out.reasoning, 'secret scratch');
});

Deno.test('a span glitched on both ends still relocates', () => {
  const out = splitLeakedThink('think>scratch/think>The answer.', '');
  assertEquals(out.content, 'The answer.');
  assertEquals(out.reasoning, 'scratch');
});

Deno.test('a bare think tag mid-body is untouched, same as the full tag', () => {
  const body = 'On glitchy turns the opener arrives as think>this/think> instead.';
  const out = splitLeakedThink(body, '');
  assertEquals(out.content, body);
  assertEquals(out.reasoning, '');
});

Deno.test('a think tag mid-body is untouched - likely quoted text', () => {
  const body = 'The tag looks like <think>this</think> in the raw stream.';
  const out = splitLeakedThink(body, '');
  assertEquals(out.content, body);
  assertEquals(out.reasoning, '');
});

Deno.test('an unterminated leading think tag is left alone', () => {
  const body = '<think>never closed, no safe boundary';
  const out = splitLeakedThink(body, 'r');
  assertEquals(out.content, body);
  assertEquals(out.reasoning, 'r');
});
