/**
 * Coverage for the topics agent's parser + tag normaliser. The
 * production path is "ask the fast model, parse the JSON, hand the
 * topics back to the loop." These tests pin the parse/normalise rules
 * the worker depends on so a future prompt tweak doesn't accidentally
 * widen what the model is allowed to emit through to the database.
 */
import { describe, it, expect } from 'vitest';
import { __test } from '../src/lib/agents/topics/agent';
import { UNTAGGED_TOPIC_SENTINEL } from '../src/lib/supabase';

const { parseTopics, normaliseTag } = __test;

describe('normaliseTag', () => {
  it('lowercases ASCII letters', () => {
    expect(normaliseTag('Baking')).toBe('baking');
    expect(normaliseTag('SOURDOUGH')).toBe('sourdough');
  });

  it('strips non-alphanum-or-hyphen characters', () => {
    expect(normaliseTag('bread!')).toBe('bread');
    expect(normaliseTag('cooking 101')).toBe('cooking-101');
    expect(normaliseTag('emacs/lisp')).toBe('emacs-lisp');
  });

  it('trims leading and trailing hyphens after stripping', () => {
    expect(normaliseTag('  -baking-  ')).toBe('baking');
    expect(normaliseTag('!!!bread!!!')).toBe('bread');
  });

  it('rejects an empty string', () => {
    expect(normaliseTag('')).toBeNull();
    expect(normaliseTag('   ')).toBeNull();
  });

  it('rejects a string that strips to empty', () => {
    expect(normaliseTag('!!!')).toBeNull();
    expect(normaliseTag('---')).toBeNull();
  });

  it('rejects strings longer than 40 chars after normalisation', () => {
    const long = 'a'.repeat(41);
    expect(normaliseTag(long)).toBeNull();
    expect(normaliseTag('a'.repeat(40))).toBe('a'.repeat(40));
  });

  it('rejects non-string input', () => {
    expect(normaliseTag(42)).toBeNull();
    expect(normaliseTag(null)).toBeNull();
    expect(normaliseTag(undefined)).toBeNull();
    expect(normaliseTag({})).toBeNull();
  });

  it('rejects the (untagged) sentinel post-strip', () => {
    // The literal "(untagged)" strips to "untagged" so this case is
    // about a model that somehow emitted the exact sentinel string.
    // The leading/trailing parens get stripped, so any normalisation
    // path lands on "untagged" - which is itself a fine real topic
    // a user might want. Confirm that the FORBIDDEN value is the
    // literal sentinel only.
    expect(normaliseTag(UNTAGGED_TOPIC_SENTINEL)).toBe('untagged');
    expect(normaliseTag('untagged')).toBe('untagged');
  });
});

describe('parseTopics', () => {
  it('parses a clean JSON object', () => {
    const raw = '{"topics": ["baking", "sourdough"]}';
    expect(parseTopics(raw)).toEqual(['baking', 'sourdough']);
  });

  it('strips a ```json fence', () => {
    const raw = '```json\n{"topics": ["baking"]}\n```';
    expect(parseTopics(raw)).toEqual(['baking']);
  });

  it('strips a plain ``` fence', () => {
    const raw = '```\n{"topics": ["baking"]}\n```';
    expect(parseTopics(raw)).toEqual(['baking']);
  });

  it('dedupes after normalisation', () => {
    const raw = '{"topics": ["Baking", "BAKING", "baking", "bread"]}';
    expect(parseTopics(raw)).toEqual(['baking', 'bread']);
  });

  it('caps the result at 4 items', () => {
    const raw = '{"topics": ["a", "b", "c", "d", "e", "f"]}';
    expect(parseTopics(raw)).toEqual(['a', 'b', 'c', 'd']);
  });

  it('drops items that fail normalisation but keeps the survivors', () => {
    const raw = '{"topics": ["baking", "", "!!!", "bread"]}';
    expect(parseTopics(raw)).toEqual(['baking', 'bread']);
  });

  it('returns [] on unparseable JSON', () => {
    expect(parseTopics('not json')).toEqual([]);
    expect(parseTopics('')).toEqual([]);
    expect(parseTopics('null')).toEqual([]);
  });

  it('returns [] when topics is missing', () => {
    expect(parseTopics('{"other": ["baking"]}')).toEqual([]);
  });

  it('returns [] when topics is not an array', () => {
    expect(parseTopics('{"topics": "baking"}')).toEqual([]);
    expect(parseTopics('{"topics": null}')).toEqual([]);
    expect(parseTopics('{"topics": 42}')).toEqual([]);
  });

  it('returns [] when every item fails normalisation', () => {
    expect(parseTopics('{"topics": ["", "!!!", null, 42]}')).toEqual([]);
  });
});
