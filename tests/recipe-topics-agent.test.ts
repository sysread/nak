/**
 * Coverage for the recipe-topics agent's parser + tag normaliser.
 * Mirrors `memory-topics-agent.test.ts` but pins the 6-tag cap
 * (vs the 4-tag cap on threads / memories). The normaliser is
 * duplicated rather than shared - see the agent file for why - so
 * this suite stands alone from the sibling topics-agent suites.
 */
import { describe, it, expect } from 'vitest';
import { __test } from '../src/lib/agents/recipe_topics/agent';
import { UNTAGGED_TOPIC_SENTINEL } from '../src/lib/supabase';

const { parseTopics, normaliseTag, MAX_RECIPE_TOPICS } = __test;

describe('recipe-topics normaliseTag', () => {
  it('lowercases ASCII letters', () => {
    expect(normaliseTag('Italian')).toBe('italian');
    expect(normaliseTag('CHICKEN')).toBe('chicken');
  });

  it('strips non-alphanum-or-hyphen characters', () => {
    expect(normaliseTag('chicken!')).toBe('chicken');
    expect(normaliseTag('one pot')).toBe('one-pot');
    expect(normaliseTag('stir/fry')).toBe('stir-fry');
  });

  it('trims leading and trailing hyphens after stripping', () => {
    expect(normaliseTag('  -chicken-  ')).toBe('chicken');
    expect(normaliseTag('!!!italian!!!')).toBe('italian');
  });

  it('rejects empty strings', () => {
    expect(normaliseTag('')).toBeNull();
    expect(normaliseTag('   ')).toBeNull();
    expect(normaliseTag('!!!')).toBeNull();
  });

  it('rejects strings longer than 40 chars after normalisation', () => {
    expect(normaliseTag('a'.repeat(41))).toBeNull();
    expect(normaliseTag('a'.repeat(40))).toBe('a'.repeat(40));
  });

  it('rejects non-string input', () => {
    expect(normaliseTag(42)).toBeNull();
    expect(normaliseTag(null)).toBeNull();
    expect(normaliseTag(undefined)).toBeNull();
    expect(normaliseTag({})).toBeNull();
  });

  it('strips the parens off the (untagged) sentinel to plain "untagged"', () => {
    expect(normaliseTag(UNTAGGED_TOPIC_SENTINEL)).toBe('untagged');
    expect(normaliseTag('untagged')).toBe('untagged');
  });
});

describe('recipe-topics parseTopics', () => {
  it('parses a clean JSON object', () => {
    expect(parseTopics('{"topics": ["chicken", "italian"]}')).toEqual([
      'chicken',
      'italian',
    ]);
  });

  it('strips a ```json fence', () => {
    expect(parseTopics('```json\n{"topics": ["italian"]}\n```')).toEqual([
      'italian',
    ]);
  });

  it('strips a plain ``` fence', () => {
    expect(parseTopics('```\n{"topics": ["italian"]}\n```')).toEqual(['italian']);
  });

  it('dedupes after normalisation', () => {
    expect(
      parseTopics('{"topics": ["Chicken", "CHICKEN", "chicken", "italian"]}')
    ).toEqual(['chicken', 'italian']);
  });

  it('exposes a cap of 6 (vs 4 on threads/memories)', () => {
    expect(MAX_RECIPE_TOPICS).toBe(6);
  });

  it('caps the result at 6 items', () => {
    expect(
      parseTopics(
        '{"topics": ["a", "b", "c", "d", "e", "f", "g", "h"]}'
      )
    ).toEqual(['a', 'b', 'c', 'd', 'e', 'f']);
  });

  it('accepts a multi-dimensional tag set (ingredient + cuisine + course + technique)', () => {
    // The prompt asks the model to span four dimensions when they
    // apply; this pins that a six-tag output passes the parser
    // untruncated rather than getting trimmed back to four (which
    // would silently re-enforce the threads cap on recipes).
    expect(
      parseTopics(
        '{"topics": ["chicken", "shrimp", "thai", "dinner", "stir-fry", "spicy"]}'
      )
    ).toHaveLength(6);
  });

  it('drops invalid items but keeps survivors', () => {
    expect(
      parseTopics('{"topics": ["chicken", "", "!!!", "italian"]}')
    ).toEqual(['chicken', 'italian']);
  });

  it('returns [] on unparseable JSON', () => {
    expect(parseTopics('not json')).toEqual([]);
    expect(parseTopics('')).toEqual([]);
    expect(parseTopics('null')).toEqual([]);
  });

  it('returns [] when topics is missing or wrong type', () => {
    expect(parseTopics('{"other": ["chicken"]}')).toEqual([]);
    expect(parseTopics('{"topics": "chicken"}')).toEqual([]);
    expect(parseTopics('{"topics": null}')).toEqual([]);
    expect(parseTopics('{"topics": 42}')).toEqual([]);
  });

  it('returns [] when every item fails normalisation', () => {
    expect(parseTopics('{"topics": ["", "!!!", null, 42]}')).toEqual([]);
  });
});
