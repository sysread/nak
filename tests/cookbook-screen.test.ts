/**
 * Unit coverage for the Cookbook screen's UI primitives. Pure
 * functions - no runes, no DOM, no reactive state - tested via plain
 * vitest.
 *
 * The companion `src/screens/Cookbook.svelte` is the only caller that
 * wires these into Svelte reactivity; a port to another framework
 * would re-use this module untouched.
 */
import { describe, it, expect } from 'vitest';
import { MAX_RECIPE_COOKLANG_CHARS, MAX_RECIPE_TITLE_CHARS } from '../src/lib/recipe-limits';
import type { Recipe, RecipePhoto } from '../src/lib/supabase';
import {
  MAX_PHOTO_UPLOAD_MB,
  MAX_RECIPE_PHOTOS,
  bookmarkAriaLabel,
  bookmarkButtonTitle,
  editRecipeDraft,
  formatVersionDate,
  historySummaryLabel,
  modifyActionTitle,
  moveDraftPhoto,
  newRecipeDraft,
  photoDecodeErrorLine,
  photoLinkPayload,
  photoPickVerdict,
  ratingChangeMessage,
  recipeSaveError,
  resolveActiveRecipe,
  seedDraftPhotos,
  suggestedRevertMessage,
  trimmedOrNull,
  versionRowState,
  type DraftPhoto,
} from '../src/lib/ui/cookbook-screen';

function makeRecipe(over: Partial<Recipe> = {}): Recipe {
  return {
    id: 'r1',
    title: 'Mashed Potatoes',
    source: null,
    source_url: null,
    cooklang: 'Boil @potatoes{1%kg}.',
    rating: null,
    upcoming: false,
    favorite: false,
    topics: [],
    created_at: '2026-06-01T00:00:00Z',
    updated_at: '2026-06-01T00:00:00Z',
    ...over,
  };
}

function makeDraftPhoto(over: Partial<DraftPhoto> = {}): DraftPhoto {
  return {
    imageId: 'img-1',
    mimeType: 'image/jpeg',
    sizeBytes: 1024,
    src: 'data:image/jpeg;base64,x',
    label: '',
    ...over,
  };
}

describe('resolveActiveRecipe', () => {
  const inBrowse = makeRecipe({ id: 'b1' });
  const inUpcoming = makeRecipe({ id: 'u1' });
  const inFavorites = makeRecipe({ id: 'f1' });
  const fetched = makeRecipe({ id: 'x1' });

  it('returns null when nothing is routed', () => {
    expect(
      resolveActiveRecipe(null, [inBrowse], [inUpcoming], [inFavorites], fetched)
    ).toBeNull();
  });

  it('prefers the loaded store sets over the fallback fetch', () => {
    expect(
      resolveActiveRecipe('b1', [inBrowse], [inUpcoming], [inFavorites], fetched)
    ).toBe(inBrowse);
    expect(
      resolveActiveRecipe('u1', [inBrowse], [inUpcoming], [inFavorites], fetched)
    ).toBe(inUpcoming);
    expect(
      resolveActiveRecipe('f1', [inBrowse], [inUpcoming], [inFavorites], fetched)
    ).toBe(inFavorites);
  });

  it('falls back to the by-id fetch only when its id matches', () => {
    expect(resolveActiveRecipe('x1', [], [], [], fetched)).toBe(fetched);
    // A stale fetch for a previously-routed recipe must not render
    // under the new route.
    expect(resolveActiveRecipe('y1', [], [], [], fetched)).toBeNull();
  });

  it('answers "already loaded" when called with fetched: null', () => {
    expect(resolveActiveRecipe('b1', [inBrowse], [], [], null)).toBe(inBrowse);
    expect(resolveActiveRecipe('x1', [inBrowse], [], [], null)).toBeNull();
  });
});

describe('draft seeds', () => {
  it('seeds a new recipe with the Cooklang scaffold, unrated, default message', () => {
    expect(newRecipeDraft()).toEqual({
      title: '',
      source: '',
      sourceUrl: '',
      cooklang: '>> servings: 4\n\n',
      rating: null,
      changeMessage: 'Created recipe.',
    });
  });

  it('seeds an edit from the row, mapping null fields to empty strings', () => {
    const r = makeRecipe({ rating: 4 });
    expect(editRecipeDraft(r)).toEqual({
      title: 'Mashed Potatoes',
      source: '',
      sourceUrl: '',
      cooklang: 'Boil @potatoes{1%kg}.',
      rating: 4,
      changeMessage: '',
    });
  });

  it('carries source fields through when the row has them', () => {
    const r = makeRecipe({ source: 'Grandma', source_url: 'https://x.test/r' });
    const seed = editRecipeDraft(r);
    expect(seed.source).toBe('Grandma');
    expect(seed.sourceUrl).toBe('https://x.test/r');
    // Always a blank change message - it describes what is about to
    // change, not the prior state.
    expect(seed.changeMessage).toBe('');
  });
});

describe('recipeSaveError', () => {
  const ok = {
    title: 'Soup',
    cooklang: 'Simmer @lentils{200%g}.',
    changeMessage: 'Created recipe.',
    photosUploading: false,
  };

  it('passes a complete draft', () => {
    expect(recipeSaveError(ok)).toBeNull();
  });

  it('reports fields in visual order, topmost first', () => {
    expect(recipeSaveError({ ...ok, title: '' })).toBe('Title is required.');
    expect(recipeSaveError({ ...ok, title: '', cooklang: '' })).toBe(
      'Title is required.'
    );
    expect(recipeSaveError({ ...ok, cooklang: '  \n ' })).toBe(
      'Recipe source is required.'
    );
    expect(recipeSaveError({ ...ok, changeMessage: '' })).toBe(
      'Describe what changed before saving.'
    );
  });

  it('enforces the shared char caps with the cap in the copy', () => {
    expect(
      recipeSaveError({ ...ok, title: 'x'.repeat(MAX_RECIPE_TITLE_CHARS + 1) })
    ).toBe(`Title exceeds ${MAX_RECIPE_TITLE_CHARS}-char limit.`);
    expect(
      recipeSaveError({
        ...ok,
        cooklang: 'x'.repeat(MAX_RECIPE_COOKLANG_CHARS + 1),
      })
    ).toBe(`Recipe source exceeds ${MAX_RECIPE_COOKLANG_CHARS}-char limit.`);
  });

  it('blocks saving while a photo upload is in flight', () => {
    expect(recipeSaveError({ ...ok, photosUploading: true })).toBe(
      'Wait for photo uploads to finish before saving.'
    );
  });
});

describe('trimmedOrNull', () => {
  it('trims real content', () => {
    expect(trimmedOrNull('  NYT Cooking  ')).toBe('NYT Cooking');
  });

  it('maps empty and whitespace-only input to the wire NULL', () => {
    expect(trimmedOrNull('')).toBeNull();
    expect(trimmedOrNull('   \n ')).toBeNull();
  });
});

describe('seedDraftPhotos', () => {
  it('maps loaded photos to drafts, keeping the resolved display url', () => {
    const loaded: RecipePhoto[] = [
      {
        id: 'p1',
        position: 0,
        mime_type: 'image/jpeg',
        size_bytes: 2048,
        url: 'https://signed.test/p1',
        label: 'Plated',
      },
    ];
    expect(seedDraftPhotos(loaded)).toEqual([
      {
        imageId: 'p1',
        mimeType: 'image/jpeg',
        sizeBytes: 2048,
        src: 'https://signed.test/p1',
        label: 'Plated',
      },
    ]);
  });

  it('turns a null label into the form`s empty-string sentinel', () => {
    const loaded: RecipePhoto[] = [
      {
        id: 'p1',
        position: 0,
        mime_type: 'image/png',
        size_bytes: 1,
        url: 'u',
        label: null,
      },
    ];
    expect(seedDraftPhotos(loaded)[0]!.label).toBe('');
  });
});

describe('photoLinkPayload', () => {
  it('maps drafts to ordered {id, label} pairs, labels verbatim', () => {
    const photos = [
      makeDraftPhoto({ imageId: 'a', label: 'Crust' }),
      // Empty label passes through - the supabase wire helper owns the
      // empty-to-null normalisation.
      makeDraftPhoto({ imageId: 'b', label: '' }),
    ];
    expect(photoLinkPayload(photos)).toEqual([
      { id: 'a', label: 'Crust' },
      { id: 'b', label: '' },
    ]);
  });
});

describe('photoPickVerdict', () => {
  const okArgs = {
    name: 'dish.jpg',
    mimeType: 'image/jpeg',
    sizeError: null,
    draftCount: 0,
  };

  it('accepts a valid image under the cap', () => {
    expect(photoPickVerdict(okArgs)).toEqual({ kind: 'ok' });
  });

  it('aborts the batch at the photo cap', () => {
    expect(
      photoPickVerdict({ ...okArgs, draftCount: MAX_RECIPE_PHOTOS })
    ).toEqual({
      kind: 'cap',
      error: `Cannot add more than ${MAX_RECIPE_PHOTOS} photos to a recipe.`,
    });
  });

  it('rejects non-images by file name', () => {
    expect(
      photoPickVerdict({ ...okArgs, name: 'notes.pdf', mimeType: 'application/pdf' })
    ).toEqual({ kind: 'reject', error: 'notes.pdf: not an image.' });
  });

  it('rejects on the validator`s size error, not-an-image winning first', () => {
    expect(
      photoPickVerdict({ ...okArgs, sizeError: 'Too large (11 MB; max 10 MB).' })
    ).toEqual({
      kind: 'reject',
      error: 'dish.jpg: Too large (11 MB; max 10 MB).',
    });
    // An oversized non-image reads as "not an image" - the more
    // actionable message.
    expect(
      photoPickVerdict({
        ...okArgs,
        mimeType: 'video/mp4',
        sizeError: 'Too large.',
      })
    ).toEqual({ kind: 'reject', error: 'dish.jpg: not an image.' });
  });

  it('formats the decode-failure line for the post-gate path', () => {
    expect(photoDecodeErrorLine('dish.jpg')).toBe(
      'dish.jpg: could not decode image.'
    );
  });
});

describe('moveDraftPhoto', () => {
  const a = makeDraftPhoto({ imageId: 'a' });
  const b = makeDraftPhoto({ imageId: 'b' });
  const c = makeDraftPhoto({ imageId: 'c' });

  it('swaps a photo one slot in either direction', () => {
    expect(moveDraftPhoto([a, b, c], 1, -1)).toEqual([b, a, c]);
    expect(moveDraftPhoto([a, b, c], 1, 1)).toEqual([a, c, b]);
  });

  it('is a no-op at either edge - the strip is not a ring', () => {
    expect(moveDraftPhoto([a, b, c], 0, -1)).toEqual([a, b, c]);
    expect(moveDraftPhoto([a, b, c], 2, 1)).toEqual([a, b, c]);
  });

  it('does not mutate the input array', () => {
    const input = [a, b, c];
    moveDraftPhoto(input, 0, 1);
    expect(input).toEqual([a, b, c]);
  });
});

describe('auto-generated change messages', () => {
  it('pluralizes stars and names the clear', () => {
    expect(ratingChangeMessage(1)).toBe('Rated 1 star.');
    expect(ratingChangeMessage(4)).toBe('Rated 4 stars.');
    expect(ratingChangeMessage(null)).toBe('Cleared rating.');
  });

  it('prefills the revert prompt with the snapshot`s formatted date', () => {
    const iso = '2026-05-19T12:00:00Z';
    expect(suggestedRevertMessage(iso)).toBe(
      `Reverted to version from ${formatVersionDate(iso)}.`
    );
  });
});

describe('formatVersionDate', () => {
  it('renders a compact locale timestamp', () => {
    const out = formatVersionDate('2026-05-19T12:00:00Z');
    // Locale-dependent, so assert on stable fragments rather than the
    // full string.
    expect(out).toContain('2026');
    expect(out).not.toBe('2026-05-19T12:00:00Z');
  });

  it('falls back to the raw string when Date parsing fails', () => {
    expect(formatVersionDate('not-a-date')).toBe('not-a-date');
  });
});

describe('historySummaryLabel', () => {
  it('omits the count until the first load resolves', () => {
    expect(historySummaryLabel(null)).toBe('History');
  });

  it('shows the count once loaded, including a real zero', () => {
    expect(historySummaryLabel(3)).toBe('History (3)');
    expect(historySummaryLabel(0)).toBe('History (0)');
  });
});

describe('versionRowState', () => {
  it('marks the newest row as the current-state anchor', () => {
    const row = versionRowState(0, 'v1', null);
    expect(row.isCurrent).toBe(true);
    expect(row.isCurrentShown).toBe(true);
    expect(row.isViewing).toBe(false);
  });

  it('highlights an older row only while its snapshot is on display', () => {
    expect(versionRowState(1, 'v2', 'v2')).toEqual({
      isCurrent: false,
      isViewing: true,
      isCurrentShown: false,
    });
    expect(versionRowState(1, 'v2', 'v3')).toEqual({
      isCurrent: false,
      isViewing: false,
      isCurrentShown: false,
    });
  });

  it('drops the anchor highlight while a snapshot is being viewed', () => {
    const row = versionRowState(0, 'v1', 'v2');
    expect(row.isCurrent).toBe(true);
    expect(row.isCurrentShown).toBe(false);
    // The newest row never reads as "viewing" - clicking it exits
    // version-viewing instead.
    expect(versionRowState(0, 'v1', 'v1').isViewing).toBe(false);
  });
});

describe('action-bar copy', () => {
  it('explains disabled bookmarks offline with shared copy', () => {
    expect(bookmarkButtonTitle(false, false, 'upcoming')).toBe(
      'Reconnect to change bookmarks'
    );
    expect(bookmarkButtonTitle(false, true, 'favorite')).toBe(
      'Reconnect to change bookmarks'
    );
  });

  it('names the toggle action per bookmark kind and state', () => {
    expect(bookmarkButtonTitle(true, false, 'upcoming')).toBe('Mark as upcoming');
    expect(bookmarkButtonTitle(true, true, 'upcoming')).toBe('Remove from upcoming');
    expect(bookmarkButtonTitle(true, false, 'favorite')).toBe('Mark as favorite');
    expect(bookmarkButtonTitle(true, true, 'favorite')).toBe('Remove from favorites');
  });

  it('keeps the aria label to the click action, no offline framing', () => {
    expect(bookmarkAriaLabel(false, 'upcoming')).toBe('Mark as upcoming');
    expect(bookmarkAriaLabel(true, 'upcoming')).toBe('Remove from upcoming');
    expect(bookmarkAriaLabel(false, 'favorite')).toBe('Mark as favorite');
    expect(bookmarkAriaLabel(true, 'favorite')).toBe('Remove from favorites');
  });

  it('titles edit and delete per connectivity', () => {
    expect(modifyActionTitle(true, 'edit')).toBe('Edit recipe');
    expect(modifyActionTitle(false, 'edit')).toBe('Reconnect to edit');
    expect(modifyActionTitle(true, 'delete')).toBe('Delete recipe');
    expect(modifyActionTitle(false, 'delete')).toBe('Reconnect to delete');
  });
});

describe('photo upload hint cap', () => {
  it('quotes the shared attachment cap in whole megabytes', () => {
    // 10 MiB cap today - if the attachments cap moves, this moves with
    // it by construction; the assertion pins the derivation, not the
    // policy.
    expect(MAX_PHOTO_UPLOAD_MB).toBe(10);
  });
});
