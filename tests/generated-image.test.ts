/**
 * Unit coverage for the generated-image UI primitives. Pure functions
 * - no runes, no DOM - tested via plain vitest. The companion
 * `src/components/GeneratedImageCard.svelte` owns the by-filename
 * resolution effect; these primitives decide which cards to emit and
 * how to size their placeholders.
 */
import { describe, it, expect } from 'vitest';
import type { OpenAIToolCall } from '../src/lib/tools';
import type { Message } from '../src/lib/supabase';
import {
  aspectRatioCss,
  generatedImagesForGroup,
  parseGeneratedImageResult,
} from '../src/lib/ui/generated-image';

function makeCall(
  id: string,
  name = 'generate_image'
): OpenAIToolCall {
  return { id, type: 'function', function: { name, arguments: '{}' } };
}

function makeResult(content: string): Message {
  return { content } as Message;
}

describe('parseGeneratedImageResult', () => {
  it('parses filename and dimensions off a successful result', () => {
    const out = parseGeneratedImageResult(
      JSON.stringify({ filename: 'generated-1.webp', width: 1280, height: 720, note: 'x' })
    );
    expect(out).toEqual({ filename: 'generated-1.webp', width: 1280, height: 720 });
  });

  it('defaults missing dimensions to zero so aspectRatioCss can fall back', () => {
    const out = parseGeneratedImageResult(JSON.stringify({ filename: 'g.webp' }));
    expect(out).toEqual({ filename: 'g.webp', width: 0, height: 0 });
  });

  it('returns null for an error result (no filename)', () => {
    expect(parseGeneratedImageResult(JSON.stringify({ error: 'boom' }))).toBeNull();
  });

  it('returns null for empty, malformed, or non-object content', () => {
    expect(parseGeneratedImageResult('')).toBeNull();
    expect(parseGeneratedImageResult('not json')).toBeNull();
    expect(parseGeneratedImageResult('null')).toBeNull();
    expect(parseGeneratedImageResult('42')).toBeNull();
    expect(parseGeneratedImageResult(JSON.stringify({ filename: '' }))).toBeNull();
  });
});

describe('aspectRatioCss', () => {
  it('formats positive dimensions as a CSS ratio', () => {
    expect(aspectRatioCss(1280, 720)).toBe('1280 / 720');
    expect(aspectRatioCss(1024, 1024)).toBe('1024 / 1024');
  });

  it('falls back to square when a dimension is missing or non-positive', () => {
    expect(aspectRatioCss(0, 0)).toBe('1 / 1');
    expect(aspectRatioCss(100, 0)).toBe('1 / 1');
    expect(aspectRatioCss(-5, 5)).toBe('1 / 1');
  });
});

describe('generatedImagesForGroup', () => {
  it('emits one descriptor per successful generate_image call, in call order', () => {
    const calls = [makeCall('a'), makeCall('b')];
    const results: Record<string, Message> = {
      a: makeResult(JSON.stringify({ filename: 'first.webp', width: 1024, height: 1024 })),
      b: makeResult(JSON.stringify({ filename: 'second.webp', width: 1280, height: 720 })),
    };
    expect(generatedImagesForGroup(calls, results)).toEqual([
      { key: 'a', filename: 'first.webp', aspectRatio: '1024 / 1024' },
      { key: 'b', filename: 'second.webp', aspectRatio: '1280 / 720' },
    ]);
  });

  it('ignores non-image tool calls', () => {
    const calls = [makeCall('a', 'memory_search')];
    const results: Record<string, Message> = {
      a: makeResult(JSON.stringify({ filename: 'nope.webp', width: 10, height: 10 })),
    };
    expect(generatedImagesForGroup(calls, results)).toEqual([]);
  });

  it('skips a call with no result row yet (still in flight)', () => {
    expect(generatedImagesForGroup([makeCall('a')], {})).toEqual([]);
  });

  it('skips a failed generate_image call', () => {
    const results: Record<string, Message> = {
      a: makeResult(JSON.stringify({ error: 'content policy' })),
    };
    expect(generatedImagesForGroup([makeCall('a')], results)).toEqual([]);
  });
});
