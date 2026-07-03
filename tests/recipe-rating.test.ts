/**
 * Unit coverage for the recipe-rating UI primitives. Pure functions
 * - no runes, no DOM - tested via plain vitest. The companion
 * `src/components/RecipeRating.svelte` composes these with its own
 * hover rune and markup.
 */
import { describe, it, expect } from 'vitest';
import {
  effectiveRating,
  ratingAfterStarClick,
  ratingAfterKey,
  rateStarLabel,
  ratingAriaLabel,
} from '../src/lib/ui/recipe-rating';

describe('effectiveRating', () => {
  it('lets the hover preview win over the persisted value', () => {
    expect(effectiveRating(2, 5)).toBe(5);
    expect(effectiveRating(null, 3)).toBe(3);
  });

  it('passes through an in-range persisted value when not hovering', () => {
    expect(effectiveRating(4, null)).toBe(4);
  });

  it('renders null/undefined as unrated', () => {
    expect(effectiveRating(null, null)).toBeNull();
    expect(effectiveRating(undefined, null)).toBeNull();
  });

  it('renders out-of-range and non-finite values without breaking the strip', () => {
    // Below 1 reads as unrated (zero is not a valid rating in the
    // schema); above 5 pins to a full strip; NaN/Infinity read as
    // unrated rather than painting garbage.
    expect(effectiveRating(0, null)).toBeNull();
    expect(effectiveRating(-3, null)).toBeNull();
    expect(effectiveRating(9, null)).toBe(5);
    expect(effectiveRating(Number.NaN, null)).toBeNull();
    expect(effectiveRating(Number.POSITIVE_INFINITY, null)).toBeNull();
  });

  it('rounds fractional persisted values to a whole star', () => {
    expect(effectiveRating(3.6, null)).toBe(4);
  });
});

describe('ratingAfterStarClick', () => {
  it('sets the clicked star', () => {
    expect(ratingAfterStarClick(null, 3)).toBe(3);
    expect(ratingAfterStarClick(2, 5)).toBe(5);
  });

  it('clears when the clicked star is the current rating (toggle off)', () => {
    // Without this, the only way to remove a rating from a 1-star
    // recipe would be to set it to a different value first.
    expect(ratingAfterStarClick(3, 3)).toBeNull();
    expect(ratingAfterStarClick(1, 1)).toBeNull();
  });
});

describe('ratingAfterKey', () => {
  it('increments on ArrowRight, capped at 5', () => {
    expect(ratingAfterKey(2, 'ArrowRight')).toEqual({ next: 3 });
    expect(ratingAfterKey(5, 'ArrowRight')).toEqual({ next: 5 });
  });

  it('starts at 1 on ArrowRight from unrated', () => {
    expect(ratingAfterKey(null, 'ArrowRight')).toEqual({ next: 1 });
  });

  it('decrements on ArrowLeft, clearing below 1', () => {
    expect(ratingAfterKey(3, 'ArrowLeft')).toEqual({ next: 2 });
    expect(ratingAfterKey(1, 'ArrowLeft')).toEqual({ next: null });
    expect(ratingAfterKey(null, 'ArrowLeft')).toEqual({ next: null });
  });

  it('clears on 0, Backspace, and Delete', () => {
    expect(ratingAfterKey(4, '0')).toEqual({ next: null });
    expect(ratingAfterKey(4, 'Backspace')).toEqual({ next: null });
    expect(ratingAfterKey(4, 'Delete')).toEqual({ next: null });
  });

  it('returns null for keys it does not own', () => {
    // Enter/Space route through the click path in the component so
    // the toggle-off rule applies; everything else is left alone.
    expect(ratingAfterKey(4, 'Enter')).toBeNull();
    expect(ratingAfterKey(4, ' ')).toBeNull();
    expect(ratingAfterKey(4, 'Escape')).toBeNull();
    expect(ratingAfterKey(4, 'a')).toBeNull();
  });
});

describe('rateStarLabel', () => {
  it('uses the singular for one star and the plural otherwise', () => {
    expect(rateStarLabel(1)).toBe('Rate 1 star');
    expect(rateStarLabel(4)).toBe('Rate 4 stars');
  });
});

describe('ratingAriaLabel', () => {
  it('announces the rating once for the whole read-only strip', () => {
    expect(ratingAriaLabel(4)).toBe('Rating: 4 of 5 stars');
  });

  it('announces Unrated for null', () => {
    expect(ratingAriaLabel(null)).toBe('Unrated');
  });
});
