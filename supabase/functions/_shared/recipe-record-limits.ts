/**
 * Recipe-record char/count limits, shared across runtimes. Extends the
 * `_shared` limits pattern of wiki-limits.ts: constants both the edge
 * functions and the browser need live in one file under
 * supabase/functions/_shared/, which the browser imports through the
 * `$shared` Vite alias (same boundary as $shared/cooklang-validate).
 *
 * All three caps live here together, unlike the wiki file (which
 * consolidates only the content cap; its tag caps stayed scattered in
 * tools/_record_helpers.ts and the extraction agent). Recipe records
 * consolidate from the start so the tag caps never re-duplicate: the
 * write boundary that enforces them exists on both sides (the M2 add
 * form browser-side, the M3 recipe_record_* tools edge-side), and the
 * embed-input composer reads the content cap so a pre-cap row cannot
 * loop the backfill on a body the model rejects.
 *
 * This file is canonical - the direction is the opposite of the wiki
 * twin (there the browser-side src/lib/wiki.ts is canonical and this
 * directory mirrors it). The pointer comment in src/lib/recipe-limits.ts
 * records the split; do not "fix" either side back to mirroring.
 */

/** Length ceiling on a record's Markdown body (8000 chars). */
export const MAX_RECIPE_RECORD_CONTENT_CHARS = 8000;

/** Max number of tags per record - a filtering facet, not prose. */
export const MAX_RECIPE_RECORD_TAGS = 24;

/** Length ceiling on a single tag; keeps the chip UI legible. */
export const MAX_RECIPE_RECORD_TAG_CHARS = 40;
