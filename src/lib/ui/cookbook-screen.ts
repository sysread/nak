/**
 * UI-behavior primitives scoped to the Cookbook screen
 * (src/screens/Cookbook.svelte). Pure functions only - no runes, no
 * Svelte imports, no DOM. The screen composes these with its own
 * framework-native reactivity (the cookbook-store reads, the routing
 * sync, the supabase orchestration, and the markup).
 *
 * Sibling modules split the cookbook surface by feature:
 * `recipe-list.ts` owns the sidebar listing, `recipe-detail.ts` the
 * detail pane's source line / ToC threshold / lightbox carousel math.
 * This module owns the decisions that are the screen's own: which
 * loaded row the routed id resolves to, the edit-form draft seeds and
 * validation ladder, the photo-draft lifecycle (pick gates, reorder,
 * save payload), the auto-generated change messages, and the History
 * panel's row states and copy.
 *
 * Named `cookbook-screen.ts` (not `cookbook.ts`) because the cookbook
 * domain already owns nearby names - `cookbook-store.svelte.ts` is
 * the reactive store and `cooklang.ts` / `recipe-limits.ts` are the
 * domain modules.
 */

import { MAX_ATTACHMENT_BYTES } from '$lib/attachments';
import { MAX_RECIPE_COOKLANG_CHARS, MAX_RECIPE_TITLE_CHARS } from '$lib/recipe-limits';
import type { Recipe, RecipePhoto, RecipePhotoInput } from '../supabase';
import { findLoadedRecipe } from './recipe-list';

// ---------------------------------------------------------------
// Selected-recipe resolution
// ---------------------------------------------------------------

/**
 * Resolve the routed recipe id against the rows the screen can
 * render: every loaded set first (the paginated browse window plus
 * the complete Upcoming / Favorites buckets - the store row is the
 * freshest copy after an edit), then the by-id fallback fetch - but
 * only when that row actually matches the id, so a stale fetch for a
 * previously-routed recipe can't render under the new route. Returns
 * null when nothing matches (still fetching, offline and not saved,
 * or genuinely gone).
 *
 * The read-through effect calls this with `fetched: null` to ask the
 * narrower question "is the id already in the loaded sets" before
 * spending a fetch on it.
 */
export function resolveActiveRecipe(
  id: string | null,
  recipes: readonly Recipe[],
  upcoming: readonly Recipe[],
  favorites: readonly Recipe[],
  fetched: Recipe | null,
): Recipe | null {
  if (!id) return null;
  return (
    findLoadedRecipe(id, recipes, upcoming, favorites) ??
    (fetched && fetched.id === id ? fetched : null)
  );
}

// ---------------------------------------------------------------
// Edit-form draft seeds
// ---------------------------------------------------------------

/**
 * The editable content fields the edit pane drafts. Exported as the
 * named return shape of `newRecipeDraft` / `editRecipeDraft` - no
 * consumer imports it by name today; the screen spreads the fields
 * into its own $state runes. Not dead code.
 */
export type RecipeDraftSeed = {
  title: string;
  source: string;
  sourceUrl: string;
  cooklang: string;
  rating: number | null;
  changeMessage: string;
};

/**
 * Draft seed for a brand-new recipe.
 *
 * The cooklang field starts with a minimal Cooklang scaffold so the
 * user has a head start and a reminder of the syntax. A blank
 * textarea against "learn this DSL first" is hostile to the user
 * journey where they're typing a recipe in from a cookbook.
 *
 * New recipes start unrated. The user almost certainly hasn't cooked
 * it yet - rating belongs on the "did this work?" pass.
 *
 * The change message defaults to a sensible note for the initial
 * version - the user can replace it but doesn't have to invent
 * something on the very first save.
 */
export function newRecipeDraft(): RecipeDraftSeed {
  return {
    title: '',
    source: '',
    sourceUrl: '',
    cooklang: '>> servings: 4\n\n',
    rating: null,
    changeMessage: 'Created recipe.',
  };
}

/**
 * Draft seed for editing an existing recipe. Nullable row fields
 * (source, source_url) become empty strings - the form's "absent"
 * sentinel, mapped back to null on save by `trimmedOrNull`.
 *
 * The change message starts empty to force the user to type a fresh
 * description for this edit; we intentionally don't carry the
 * previous message forward, since the message describes what's about
 * to change, not the prior state.
 */
export function editRecipeDraft(recipe: Recipe): RecipeDraftSeed {
  return {
    title: recipe.title,
    source: recipe.source ?? '',
    sourceUrl: recipe.source_url ?? '',
    cooklang: recipe.cooklang,
    rating: recipe.rating,
    changeMessage: '',
  };
}

// ---------------------------------------------------------------
// Save validation + wire mapping
// ---------------------------------------------------------------

/**
 * First validation error for the edit form's fields, or null when the
 * draft is saveable. Check order matches the form's visual order
 * (title, cooklang source, change message) with the photo-upload gate
 * last, so the reported error is always the topmost offending field.
 * Expects a pre-trimmed title and change message (the caller trims
 * because it also sends the trimmed text to the save RPC); cooklang
 * is taken verbatim - emptiness is checked against the trimmed text
 * but the length cap against the raw text the row would store. The
 * caps mirror the recipe tool schemas (see $lib/recipe-limits) so the
 * UI rejects early instead of bouncing off a Supabase error.
 *
 * The `photosUploading` gate exists so the user can't submit a stale
 * draft that's missing an in-flight photo (upload = downscale +
 * sha256 + upsert; the draft row only lands once the upsert returns
 * an image id).
 */
export function recipeSaveError(draft: {
  title: string;
  cooklang: string;
  changeMessage: string;
  photosUploading: boolean;
}): string | null {
  if (draft.title.length === 0) return 'Title is required.';
  if (draft.title.length > MAX_RECIPE_TITLE_CHARS) {
    return `Title exceeds ${MAX_RECIPE_TITLE_CHARS}-char limit.`;
  }
  if (draft.cooklang.trim().length === 0) return 'Recipe source is required.';
  if (draft.cooklang.length > MAX_RECIPE_COOKLANG_CHARS) {
    return `Recipe source exceeds ${MAX_RECIPE_COOKLANG_CHARS}-char limit.`;
  }
  if (draft.changeMessage.length === 0) return 'Describe what changed before saving.';
  if (draft.photosUploading) {
    return 'Wait for photo uploads to finish before saving.';
  }
  return null;
}

/**
 * Collapse an optional form field to its wire shape: trimmed text, or
 * null when the input is empty or whitespace-only. The form's "absent"
 * sentinel is the empty string (inputs can't hold null); the row's is
 * NULL - this is the seam where the two meet, for `source` and
 * `source_url` on save.
 */
export function trimmedOrNull(value: string): string | null {
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

// ---------------------------------------------------------------
// Photo drafts
// ---------------------------------------------------------------

/**
 * Cap on photos per recipe. Belt-and-suspenders with the editor's
 * file picker - the input is `multiple` but `photoPickVerdict`
 * rejects inserts that would push the draft over this. Tens of
 * photos per recipe is more than anyone reasonably wants on a single
 * dish; the cap exists to keep the version-snapshot link rows
 * bounded.
 */
export const MAX_RECIPE_PHOTOS = 12;

/**
 * The downscale ceiling, in whole megabytes, quoted in the edit
 * form's photo hint. Derived from the shared attachment byte cap so
 * the copy can never drift from what `validateFile` actually
 * enforces.
 */
export const MAX_PHOTO_UPLOAD_MB = Math.round(MAX_ATTACHMENT_BYTES / 1024 / 1024);

/**
 * Working photo entry for the edit pane. Each entry carries the
 * server-side `image_id` (already created via `upsertRecipeImage`
 * before being added to the draft) plus a display source for inline
 * preview, plus an in-memory `label` that the user is editing.
 * Label changes do NOT save until the user clicks Save - they
 * ride along on the same versioned write as title/cooklang/etc.
 * so the History panel shows one row per overall save, not a row
 * per keystroke. The save path forwards `{id, label}` pairs to
 * the update RPC as `photos` (see `photoLinkPayload`), so adds,
 * removes, reorders, AND label edits land in the version snapshot
 * together.
 */
export interface DraftPhoto {
  imageId: string;
  mimeType: string;
  sizeBytes: number;
  // Display-only source: a `data:` URI for a just-picked upload (bytes
  // in memory) or the resolved `url` for a photo loaded from the DB.
  // Save re-links by imageId, so the draft never carries bytes.
  src: string;
  label: string;
}

/**
 * Seed the edit pane's photo drafts from the loaded photo cache. The
 * saved label (or empty when there isn't one) seeds the caption
 * input - empty string is the "no caption" sentinel in the form; the
 * wire mapper trims it back to null on save.
 */
export function seedDraftPhotos(loaded: readonly RecipePhoto[]): DraftPhoto[] {
  return loaded.map((p) => ({
    imageId: p.id,
    mimeType: p.mime_type,
    sizeBytes: p.size_bytes,
    // Display source only - the resolved URL (signed bucket URL or
    // legacy data: URI) from listRecipePhotos. Save re-links by
    // imageId, so the draft never needs the bytes.
    src: p.url,
    label: p.label ?? '',
  }));
}

/**
 * Map the draft photo set to the ordered `{id, label}` pairs the
 * versioned save RPCs take. Labels pass through verbatim - the wire
 * helper (`splitPhotoInputs` in the supabase layer) normalises
 * empty / whitespace-only captions to null, so the form's empty-string
 * sentinel doesn't need translating here.
 */
export function photoLinkPayload(photos: readonly DraftPhoto[]): RecipePhotoInput[] {
  return photos.map((p) => ({ id: p.imageId, label: p.label }));
}

/**
 * Verdict for one user-picked file before the upload pipeline runs.
 * `cap` aborts the whole batch (every later file would hit the same
 * ceiling); `reject` skips just this file so a partial batch still
 * lets the good ones through. Exported as the named return shape of
 * `photoPickVerdict` - no consumer imports it by name today; the
 * screen dispatches on the string literals. Not dead code.
 */
export type PhotoPickVerdict =
  | { kind: 'cap'; error: string }
  | { kind: 'reject'; error: string }
  | { kind: 'ok' };

/**
 * Gate a picked file against the draft's photo cap, the images-only
 * rule, and the per-file size cap, in that order - so an oversized
 * non-image reads as "not an image", the more actionable message.
 * `sizeError` is `validateFile`'s result, passed in rather than
 * computed here so this stays free of the browser `File` type.
 */
export function photoPickVerdict(args: {
  name: string;
  mimeType: string;
  sizeError: string | null;
  draftCount: number;
}): PhotoPickVerdict {
  if (args.draftCount >= MAX_RECIPE_PHOTOS) {
    return {
      kind: 'cap',
      error: `Cannot add more than ${MAX_RECIPE_PHOTOS} photos to a recipe.`,
    };
  }
  if (!args.mimeType.startsWith('image/')) {
    return { kind: 'reject', error: `${args.name}: not an image.` };
  }
  if (args.sizeError) {
    return { kind: 'reject', error: `${args.name}: ${args.sizeError}` };
  }
  return { kind: 'ok' };
}

/**
 * Error line for a file that passed the pick gates but could not be
 * decoded by the canvas downscaler (corrupt bytes, or a format the
 * browser's image decoder doesn't support despite the image/* MIME).
 */
export function photoDecodeErrorLine(name: string): string {
  return `${name}: could not decode image.`;
}

/**
 * Move the photo at `index` one slot left (`dir` -1) or right (+1),
 * returning a new array; returns the input untouched when the move
 * would fall off either end, so the edge buttons are no-ops rather
 * than wrap-arounds (the strip is an ordered strip, not a ring - the
 * lightbox is the ring).
 */
export function moveDraftPhoto(
  photos: readonly DraftPhoto[],
  index: number,
  dir: -1 | 1,
): DraftPhoto[] {
  const target = index + dir;
  if (target < 0 || target >= photos.length) return [...photos];
  const next = [...photos];
  const [moved] = next.splice(index, 1);
  next.splice(target, 0, moved!);
  return next;
}

// ---------------------------------------------------------------
// Auto-generated change messages
// ---------------------------------------------------------------

/**
 * Change message for a click-to-rate edit on the detail pane. A
 * one-step gesture, so we don't ask the user for a message; we
 * generate a parseable one that lands in the History panel like any
 * other version.
 */
export function ratingChangeMessage(next: number | null): string {
  return next === null
    ? 'Cleared rating.'
    : `Rated ${next} ${next === 1 ? 'star' : 'stars'}.`;
}

/**
 * Prefilled change message for the revert prompt - a sensible
 * "reverted to <date>" string so the user can hit Enter and move on.
 */
export function suggestedRevertMessage(createdAt: string): string {
  return `Reverted to version from ${formatVersionDate(createdAt)}.`;
}

// ---------------------------------------------------------------
// History panel
// ---------------------------------------------------------------

/**
 * Compact human-readable timestamp for History rows. Locale-aware
 * and falls back to the raw string if Date parsing fails.
 */
export function formatVersionDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/**
 * The History panel's summary line. `count` is null until the first
 * listRecipeVersions resolves - the count only renders once there is
 * a real number to show, so the summary doesn't flash "(0)" during
 * the load.
 */
export function historySummaryLabel(count: number | null): string {
  return count === null ? 'History' : `History (${count})`;
}

/**
 * Render state for one History row. The list is newest-first and the
 * newest row doubles as the "current state" anchor: clicking it exits
 * version-viewing instead of entering it, it carries the "current"
 * badge, and it highlights only when no snapshot is being viewed.
 * Older rows highlight when they are the snapshot on display.
 * Exported as the named return shape of `versionRowState` - no
 * consumer imports it by name today; the screen reads the fields
 * directly. Not dead code.
 */
export type VersionRowState = {
  /** Newest row - the live recipe's anchor, not a snapshot. */
  isCurrent: boolean;
  /** Row is the snapshot currently shown read-only (class:is-active). */
  isViewing: boolean;
  /** Anchor row highlighted because the live recipe is on display
   *  (class:is-current). */
  isCurrentShown: boolean;
};

export function versionRowState(
  index: number,
  versionId: string,
  viewingVersionId: string | null,
): VersionRowState {
  const isCurrent = index === 0;
  return {
    isCurrent,
    isViewing: !isCurrent && viewingVersionId === versionId,
    isCurrentShown: isCurrent && viewingVersionId === null,
  };
}

// ---------------------------------------------------------------
// Detail action-bar copy
// ---------------------------------------------------------------

/**
 * Hover-title for the upcoming / favorite bookmark toggles. Both are
 * server writes, hence the shared offline variant explaining the
 * greyed-out button instead of letting the click fail.
 */
export function bookmarkButtonTitle(
  online: boolean,
  active: boolean,
  kind: 'upcoming' | 'favorite',
): string {
  if (!online) return 'Reconnect to change bookmarks';
  if (kind === 'upcoming') {
    return active ? 'Remove from upcoming' : 'Mark as upcoming';
  }
  return active ? 'Remove from favorites' : 'Mark as favorite';
}

/** Screen-reader label for a bookmark toggle - the action the click
 *  performs, without the offline framing the sighted-user title
 *  carries (aria-pressed already conveys the current state). */
export function bookmarkAriaLabel(
  active: boolean,
  kind: 'upcoming' | 'favorite',
): string {
  if (kind === 'upcoming') {
    return active ? 'Remove from upcoming' : 'Mark as upcoming';
  }
  return active ? 'Remove from favorites' : 'Mark as favorite';
}

/**
 * Hover-title for the edit / delete buttons. Both write to Supabase,
 * so they disable offline - the title explains the greyed-out button
 * instead of letting the click fail on submit.
 */
export function modifyActionTitle(
  online: boolean,
  action: 'edit' | 'delete',
): string {
  if (action === 'edit') return online ? 'Edit recipe' : 'Reconnect to edit';
  return online ? 'Delete recipe' : 'Reconnect to delete';
}
