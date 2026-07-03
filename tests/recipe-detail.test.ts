/**
 * Unit coverage for the cookbook detail-pane UI primitives. Pure
 * functions - no runes, no DOM - tested via plain vitest. The
 * companion `src/screens/Cookbook.svelte` wires these into its
 * detail-header markup.
 */
import { describe, it, expect } from 'vitest';
import type { Recipe } from '../src/lib/supabase';
import {
  recipeSourceLine,
  recipeTocVisible,
  wrapIndex,
  swipeNavStep,
  isCommitAnimating,
  lightboxTrackStyle,
  photoOpenAriaLabel,
  LIGHTBOX_SLIDE_MS,
} from '../src/lib/ui/recipe-detail';
import { recipeToc, parseCooklang } from '../src/lib/cooklang';

function makeRecipe(overrides: Partial<Recipe> = {}): Recipe {
  return {
    id: 'r1',
    title: 'Recipe',
    source: null,
    source_url: null,
    cooklang: '',
    rating: null,
    upcoming: false,
    favorite: false,
    topics: [],
    created_at: '2026-05-19T12:00:00Z',
    updated_at: '2026-05-19T12:00:00Z',
    ...overrides,
  };
}

describe('recipeSourceLine', () => {
  it('omits the line when neither name nor url is present', () => {
    expect(recipeSourceLine(makeRecipe())).toEqual({ kind: 'none' });
  });

  it('renders plain text when only a source name is present', () => {
    expect(recipeSourceLine(makeRecipe({ source: 'Grandma' }))).toEqual({
      kind: 'text',
      text: 'Grandma',
    });
  });

  it('labels the link with the source name when both are present', () => {
    expect(
      recipeSourceLine(
        makeRecipe({ source: 'NYT Cooking', source_url: 'https://x.test/r' })
      )
    ).toEqual({ kind: 'link', label: 'NYT Cooking', url: 'https://x.test/r' });
  });

  it('falls back to "Source" when a url has no accompanying name', () => {
    expect(
      recipeSourceLine(makeRecipe({ source_url: 'https://x.test/r' }))
    ).toEqual({ kind: 'link', label: 'Source', url: 'https://x.test/r' });
  });

  it('treats a whitespace-only name as absent so the label is never blank', () => {
    expect(
      recipeSourceLine(makeRecipe({ source: '   ', source_url: 'https://x.test/r' }))
    ).toEqual({ kind: 'link', label: 'Source', url: 'https://x.test/r' });
  });

  it('trims surrounding whitespace off the url and label', () => {
    expect(
      recipeSourceLine(
        makeRecipe({ source: '  Bon Appetit  ', source_url: '  https://x.test/r  ' })
      )
    ).toEqual({ kind: 'link', label: 'Bon Appetit', url: 'https://x.test/r' });
  });
});

describe('wrapIndex', () => {
  it('steps forward within range', () => {
    expect(wrapIndex(0, 1, 3)).toBe(1);
    expect(wrapIndex(1, 1, 3)).toBe(2);
  });

  it('wraps forward past the last index to the first', () => {
    expect(wrapIndex(2, 1, 3)).toBe(0);
  });

  it('wraps backward past the first index to the last', () => {
    expect(wrapIndex(0, -1, 3)).toBe(2);
  });

  it('is a no-op on an empty list', () => {
    expect(wrapIndex(0, 1, 0)).toBe(0);
    expect(wrapIndex(5, -1, 0)).toBe(5);
  });

  it('stays put on a single-element ring', () => {
    expect(wrapIndex(0, 1, 1)).toBe(0);
    expect(wrapIndex(0, -1, 1)).toBe(0);
  });
});

describe('swipeNavStep', () => {
  it('returns 0 for a drag shorter than the threshold', () => {
    expect(swipeNavStep(100, 100, 130, 100)).toBe(0);
  });

  it('advances to the next photo on a leftward swipe', () => {
    expect(swipeNavStep(200, 100, 100, 110)).toBe(1);
  });

  it('goes to the previous photo on a rightward swipe', () => {
    expect(swipeNavStep(100, 100, 220, 90)).toBe(-1);
  });

  it('ignores a mostly-vertical drag even when it clears the threshold', () => {
    expect(swipeNavStep(100, 100, 160, 300)).toBe(0);
  });

  it('respects a custom threshold', () => {
    expect(swipeNavStep(100, 100, 170, 100, 100)).toBe(0);
    expect(swipeNavStep(100, 100, 230, 100, 100)).toBe(-1);
  });
});

describe('lightboxTrackStyle', () => {
  it('rests centered on the middle slide with no transition when idle', () => {
    const s = lightboxTrackStyle('idle', 0);
    expect(s).toContain('translateX(-100%)');
    expect(s).toContain('transition: none');
  });

  it('follows the finger by the drag offset and disables transition while dragging', () => {
    const s = lightboxTrackStyle('drag', -42);
    expect(s).toContain('calc(-100% + -42px)');
    expect(s).toContain('transition: none');
  });

  it('slides one viewport left toward the next slide on a forward commit', () => {
    const s = lightboxTrackStyle('to-next', 0);
    expect(s).toContain('translateX(-200%)');
    expect(s).toContain(`${LIGHTBOX_SLIDE_MS}ms`);
  });

  it('slides toward the previous slide on a backward commit', () => {
    const s = lightboxTrackStyle('to-prev', 0);
    expect(s).toContain('translateX(0%)');
    expect(s).toContain(`${LIGHTBOX_SLIDE_MS}ms`);
  });

  it('eases back to center on a cancelled drag', () => {
    const s = lightboxTrackStyle('cancel', 80);
    // The cancel target ignores the residual drag offset and animates
    // straight back to the centered resting transform.
    expect(s).toContain('translateX(-100%)');
    expect(s).not.toContain('80px');
    expect(s).toContain(`${LIGHTBOX_SLIDE_MS}ms`);
  });
});

describe('recipeTocVisible', () => {
  it('shows the TOC for a flat recipe with both blocks (two targets)', () => {
    const toc = recipeToc(parseCooklang('Stir in @flour{200%g}.'));
    expect(recipeTocVisible(toc)).toBe(true);
  });

  it('shows the TOC when section sub-entries add jump targets', () => {
    const src = `== Soup ==
Simmer @lentils{200%g}.

# Finishing
Stir in @butter{2%tbsp}.`;
    // 2 blocks + 2 sub-sections each = 6 jump targets.
    const toc = recipeToc(parseCooklang(src));
    expect(recipeTocVisible(toc)).toBe(true);
  });

  it('hides the TOC for a one-block recipe - a lone link is clutter', () => {
    // Declarations only - just an Ingredients entry, no Instructions.
    const toc = recipeToc(parseCooklang('@flour{200%g}'));
    expect(recipeTocVisible(toc)).toBe(false);
    expect(recipeTocVisible([])).toBe(false);
  });
});

describe('isCommitAnimating', () => {
  it('treats both slide directions and the ease-back as in-flight', () => {
    expect(isCommitAnimating('to-next')).toBe(true);
    expect(isCommitAnimating('to-prev')).toBe(true);
    expect(isCommitAnimating('cancel')).toBe(true);
  });

  it('leaves resting and finger-tracking phases interactive', () => {
    expect(isCommitAnimating('idle')).toBe(false);
    expect(isCommitAnimating('drag')).toBe(false);
  });
});

describe('photoOpenAriaLabel', () => {
  it('speaks a 1-based position over the strip total', () => {
    expect(photoOpenAriaLabel(0, 3, null)).toBe('Open photo 1 of 3');
    expect(photoOpenAriaLabel(2, 3, null)).toBe('Open photo 3 of 3');
  });

  it('appends the caption when the photo has one', () => {
    expect(photoOpenAriaLabel(1, 5, 'Crumb shot')).toBe(
      'Open photo 2 of 5: Crumb shot'
    );
  });
});
