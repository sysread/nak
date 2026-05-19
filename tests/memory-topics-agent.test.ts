/**
 * Coverage for the memory-topics agent's parser + tag normaliser. The
 * production path is identical to the thread topics agent: "ask the
 * fast model, parse the JSON, hand the topics back to the loop." The
 * normaliser rules are intentionally duplicated rather than shared
 * (see ../src/lib/agents/memory_topics/agent.ts for why), so this
 * test file pins them independently of the thread topics tests - a
 * future divergence in one should not silently pass the other's
 * coverage.
 */
import { describe, it, expect } from 'vitest';
import { __test } from '../src/lib/agents/memory_topics/agent';
import { UNTAGGED_TOPIC_SENTINEL } from '../src/lib/supabase';

const { parseTopics, normaliseTag } = __test;

describe('memory-topics normaliseTag', () => {
  it('lowercases ASCII letters', () => {
    expect(normaliseTag('Allergies')).toBe('allergies');
    expect(normaliseTag('EDITOR')).toBe('editor');
  });

  it('strips non-alphanum-or-hyphen characters', () => {
    expect(normaliseTag('food!')).toBe('food');
    expect(normaliseTag('dietary restrictions')).toBe('dietary-restrictions');
    expect(normaliseTag('vim/neovim')).toBe('vim-neovim');
  });

  it('trims leading and trailing hyphens after stripping', () => {
    expect(normaliseTag('  -allergies-  ')).toBe('allergies');
    expect(normaliseTag('!!!food!!!')).toBe('food');
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
    // Mirror the thread-topics test rationale: the literal
    // "(untagged)" strips to "untagged" through the regex path, which
    // is itself a fine real topic. The explicit forbidden case is the
    // exact sentinel string post-normalisation - i.e. a model that
    // somehow emitted "(untagged)" verbatim would be rejected by the
    // sentinel guard before lowering, but normal "untagged" passes.
    expect(normaliseTag(UNTAGGED_TOPIC_SENTINEL)).toBe('untagged');
    expect(normaliseTag('untagged')).toBe('untagged');
  });
});

describe('memory-topics parseTopics', () => {
  it('parses a clean JSON object', () => {
    expect(parseTopics('{"topics": ["allergies", "food"]}')).toEqual([
      'allergies',
      'food',
    ]);
  });

  it('strips a ```json fence', () => {
    expect(parseTopics('```json\n{"topics": ["editor"]}\n```')).toEqual([
      'editor',
    ]);
  });

  it('strips a plain ``` fence', () => {
    expect(parseTopics('```\n{"topics": ["editor"]}\n```')).toEqual(['editor']);
  });

  it('dedupes after normalisation', () => {
    expect(
      parseTopics('{"topics": ["Allergies", "ALLERGIES", "allergies", "food"]}')
    ).toEqual(['allergies', 'food']);
  });

  it('caps the result at 4 items', () => {
    expect(
      parseTopics('{"topics": ["a", "b", "c", "d", "e", "f"]}')
    ).toEqual(['a', 'b', 'c', 'd']);
  });

  it('drops invalid items but keeps survivors', () => {
    expect(parseTopics('{"topics": ["food", "", "!!!", "allergies"]}')).toEqual([
      'food',
      'allergies',
    ]);
  });

  it('returns [] on unparseable JSON', () => {
    expect(parseTopics('not json')).toEqual([]);
    expect(parseTopics('')).toEqual([]);
    expect(parseTopics('null')).toEqual([]);
  });

  it('returns [] when topics is missing or wrong type', () => {
    expect(parseTopics('{"other": ["food"]}')).toEqual([]);
    expect(parseTopics('{"topics": "food"}')).toEqual([]);
    expect(parseTopics('{"topics": null}')).toEqual([]);
    expect(parseTopics('{"topics": 42}')).toEqual([]);
  });

  it('returns [] when every item fails normalisation', () => {
    expect(parseTopics('{"topics": ["", "!!!", null, 42]}')).toEqual([]);
  });
});
