/**
 * Unit coverage for the topic-filter UI primitives. These are pure
 * functions - no runes, no DOM, no reactive state - so the tests
 * just import them and assert on return values. No Svelte mount and
 * no `$effect.root` harness required.
 *
 * The companion `src/components/TopicsFilter.svelte` is the only
 * caller that wires these into Svelte reactivity; a port to another
 * framework would re-use this module untouched.
 */
import { describe, it, expect } from 'vitest';
import { UNTAGGED_TOPIC_SENTINEL } from '../src/lib/supabase';
import {
  computeOptions,
  isUntagged,
  labelFor,
  selectionAfterClearOne,
  selectionAfterToggle,
} from '../src/lib/ui/topics-filter';

describe('computeOptions', () => {
  it('always prepends the (untagged) sentinel, even when vocabulary is empty', () => {
    expect(computeOptions([])).toEqual([UNTAGGED_TOPIC_SENTINEL]);
  });

  it('preserves vocabulary order, sentinel-first', () => {
    expect(computeOptions(['baking', 'bread', 'pasta'])).toEqual([
      UNTAGGED_TOPIC_SENTINEL,
      'baking',
      'bread',
      'pasta',
    ]);
  });

  it('does not mutate the input array', () => {
    const input = ['baking', 'bread'];
    computeOptions(input);
    expect(input).toEqual(['baking', 'bread']);
  });
});

describe('labelFor', () => {
  it('renders the sentinel as plain "untagged" without parens', () => {
    expect(labelFor(UNTAGGED_TOPIC_SENTINEL)).toBe('untagged');
  });

  it('passes real topic names through unchanged', () => {
    expect(labelFor('baking')).toBe('baking');
    expect(labelFor('home renovation')).toBe('home renovation');
  });
});

describe('isUntagged', () => {
  it('is true only for the sentinel', () => {
    expect(isUntagged(UNTAGGED_TOPIC_SENTINEL)).toBe(true);
  });

  it('is false for a normal topic', () => {
    expect(isUntagged('baking')).toBe(false);
  });

  it('is false for a topic that shares the label spelling', () => {
    // A real topic that happens to spell out "untagged" must still
    // come back false - the check has to be string equality with
    // the parens-wrapped sentinel, not a substring or label compare.
    expect(isUntagged('untagged')).toBe(false);
  });
});

describe('selectionAfterToggle', () => {
  it('adds an unselected topic to the end of the selection', () => {
    expect(selectionAfterToggle(['baking'], 'bread')).toEqual([
      'baking',
      'bread',
    ]);
  });

  it('removes a selected topic and leaves the rest in original order', () => {
    expect(
      selectionAfterToggle(['baking', 'bread', 'pasta'], 'bread')
    ).toEqual(['baking', 'pasta']);
  });

  it('treats the sentinel like any other option', () => {
    expect(selectionAfterToggle([], UNTAGGED_TOPIC_SENTINEL)).toEqual([
      UNTAGGED_TOPIC_SENTINEL,
    ]);
    expect(
      selectionAfterToggle([UNTAGGED_TOPIC_SENTINEL, 'baking'], UNTAGGED_TOPIC_SENTINEL)
    ).toEqual(['baking']);
  });

  it('returns a new array, leaving the input untouched', () => {
    const input = ['baking'];
    selectionAfterToggle(input, 'bread');
    expect(input).toEqual(['baking']);
  });
});

describe('selectionAfterClearOne', () => {
  it('removes the named topic from the selection', () => {
    expect(selectionAfterClearOne(['baking', 'bread'], 'baking')).toEqual([
      'bread',
    ]);
  });

  it('is tolerant of a topic that is not selected', () => {
    // The X click on a pill that has already been removed by some
    // other path (URL restore, parallel mutation) must resolve to a
    // no-op-shaped array rather than throw.
    expect(selectionAfterClearOne(['baking'], 'bread')).toEqual(['baking']);
  });

  it('returns a new array, leaving the input untouched', () => {
    const input = ['baking', 'bread'];
    selectionAfterClearOne(input, 'baking');
    expect(input).toEqual(['baking', 'bread']);
  });

  it('clears the sentinel like any other topic', () => {
    expect(
      selectionAfterClearOne(['baking', UNTAGGED_TOPIC_SENTINEL], UNTAGGED_TOPIC_SENTINEL)
    ).toEqual(['baking']);
  });
});
