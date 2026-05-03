/**
 * Append photos from the current conversation to a saved recipe. The
 * model passes filenames that exist in `<thread_attachments>` (live,
 * not expired); we copy each image's bytes into the user's recipe-image
 * library (deduped by sha256), then link them onto the recipe in array
 * order.
 *
 * Why filename-based and not by attachment id: filenames are the
 * stable handle the model already sees in the per-turn system block,
 * matching how `analyze_image` references images. The internal
 * `message_attachments.id` isn't surfaced to the model anywhere and
 * shouldn't be - filenames are the contract.
 *
 * Append-only by design: the only way to remove or reorder photos is
 * via the dedicated `recipe_photos_remove` / `recipe_photos_reorder`
 * tools. Splitting the verbs prevents the LLM from accidentally
 * clearing the existing photo set with a "set the photos to X" call
 * that forgot to enumerate the photos already on the recipe.
 *
 * Errors:
 *   - filename not in this thread -> tool error listing live images
 *   - filename present but expired -> tool error naming the offenders
 *     and prompting the user to re-attach
 *   - any other RPC failure -> propagate
 */
import type { ToolDef } from './types';
import { sha256HexFromBase64 } from '../attachments';
// See recipe_save.ts - plain-.ts import, not the rune-using store.
import { notifyCookbookChanged } from '../cookbook-events';

export const recipePhotosAttach: ToolDef = {
  name: 'recipe_photos_attach',
  description:
    'Add one or more photos from the current conversation to a saved ' +
    'recipe. `filenames` lists the conversation-attachment filenames ' +
    'in display order (the same names you see in the ' +
    '<thread_attachments> system block, case-sensitive). Each must be ' +
    'live (not expired). Photos already on the recipe are not ' +
    'duplicated; the array appends to the end of the existing photo ' +
    'set. `labels` is OPTIONAL and parallel-indexed with `filenames` ' +
    '(labels[i] is the caption for filenames[i]); pass empty string ' +
    'or null for photos that should have no caption, and omit the ' +
    'array entirely when no photo gets a caption. Captions are ' +
    'rendered below the thumbnail and beside the lightbox image. ' +
    'When attaching a filename whose image is already on the recipe ' +
    "and `labels[i]` is non-empty, the existing photo's caption is " +
    'updated. Use `recipe_photos_remove` to drop photos, ' +
    '`recipe_photos_reorder` to change their order, and ' +
    '`recipe_photo_label_set` to change captions on photos already ' +
    'on the recipe. `change_message` is REQUIRED and lands in the ' +
    'recipe history. Returns {recipe_id, photos: [{id, position, ' +
    'label}, ...]} - the post-attach full ordered set so you can ' +
    'chain into a follow-up call without a separate read.',
  shortDescription: 'attach conversation images to a recipe',
  parameters: {
    type: 'object',
    properties: {
      recipe_id: {
        type: 'string',
        description: 'UUID of the recipe to attach photos to.',
      },
      filenames: {
        type: 'array',
        minItems: 1,
        items: { type: 'string', minLength: 1 },
        description:
          'Conversation-attachment filenames to copy onto the recipe, ' +
          'in display order. Must match the names in ' +
          '<thread_attachments> exactly (case-sensitive).',
      },
      labels: {
        type: 'array',
        items: { type: ['string', 'null'], maxLength: 200 },
        description:
          'Optional captions for the photos, parallel-indexed with ' +
          '`filenames`. labels[i] is the caption for filenames[i]; ' +
          'pass empty string or null when a photo should have no ' +
          'caption. Length MUST match `filenames` when provided. ' +
          'Omit the field entirely (do not pass an empty array) ' +
          'when none of the photos being attached get a caption.',
      },
      change_message: {
        type: 'string',
        minLength: 1,
        maxLength: 500,
        description:
          "One-line note describing what's being added and why. " +
          "Stored in the recipe's version history. Examples: " +
          '"Added a photo of the finished plate", "Saved the user\'s ' +
          'progress photo of the dough".',
      },
    },
    required: ['recipe_id', 'filenames', 'change_message'],
    additionalProperties: false,
  },
  async execute(args, ctx) {
    const recipeId = typeof args.recipe_id === 'string' ? args.recipe_id : '';
    if (!recipeId) throw new Error('recipe_id is required');
    const filenames = Array.isArray(args.filenames)
      ? args.filenames.filter((f): f is string => typeof f === 'string' && f.length > 0)
      : [];
    if (filenames.length === 0) {
      throw new Error('filenames must contain at least one entry');
    }
    // Labels are optional and parallel-indexed. If the model passes
    // a length-mismatch, fail loud rather than silently using the
    // wrong caption for the wrong photo - that's worse than no
    // caption.
    let labels: (string | null)[] | null = null;
    if (args.labels !== undefined && args.labels !== null) {
      if (!Array.isArray(args.labels)) {
        throw new Error('labels must be an array when provided');
      }
      if (args.labels.length !== filenames.length) {
        throw new Error(
          `labels length (${args.labels.length}) must match filenames length (${filenames.length})`
        );
      }
      labels = args.labels.map((l) => {
        if (l === null || l === undefined) return null;
        if (typeof l !== 'string') {
          throw new Error('labels must contain strings or null');
        }
        const trimmed = l.trim();
        return trimmed.length === 0 ? null : trimmed;
      });
    }
    const changeMessage =
      typeof args.change_message === 'string' ? args.change_message.trim() : '';
    if (!changeMessage) {
      throw new Error('change_message is required');
    }

    // Resolve every filename before doing any inserts. Either we have
    // the full set or the call fails fast with a single readable error
    // - half-attaching a batch leaves the user reasoning about a
    // partial state, which is worse than a clean rejection.
    const missing: string[] = [];
    const expired: string[] = [];
    const resolved: Array<{
      sha256: string;
      mime: string;
      size: number;
      data: string;
    }> = [];
    for (const filename of filenames) {
      const a = await ctx.supabase.findImageByFilenameInThread(
        ctx.threadId,
        filename
      );
      if (!a) {
        missing.push(filename);
        continue;
      }
      if (!a.data_base64) {
        expired.push(filename);
        continue;
      }
      const sha = await sha256HexFromBase64(a.data_base64);
      resolved.push({
        sha256: sha,
        mime: a.mime_type,
        size: a.size_bytes,
        data: a.data_base64,
      });
    }
    if (missing.length > 0 || expired.length > 0) {
      const parts: string[] = [];
      if (missing.length > 0) {
        parts.push(`not in this thread: ${missing.map((f) => `"${f}"`).join(', ')}`);
      }
      if (expired.length > 0) {
        parts.push(
          `expired (binary reclaimed): ${expired.map((f) => `"${f}"`).join(', ')}`
        );
      }
      throw new Error(
        `Cannot attach the requested photos - ${parts.join('; ')}. Ask the user to re-attach the image(s) and try again.`
      );
    }

    // Bytes are good. Upsert each into the recipe-image library
    // (dedup by sha256) and collect the resulting (id, label) pairs
    // in input order so the attach call sees them parallel to the
    // filenames the model passed.
    const photoInputs: Array<{ id: string; label: string | null }> = [];
    for (let i = 0; i < resolved.length; i++) {
      const r = resolved[i]!;
      const id = await ctx.supabase.upsertRecipeImage(
        r.sha256,
        r.mime,
        r.size,
        r.data
      );
      photoInputs.push({ id, label: labels ? (labels[i] ?? null) : null });
    }

    const photos = await ctx.supabase.attachRecipePhotos(
      recipeId,
      photoInputs,
      changeMessage
    );
    notifyCookbookChanged();
    return { recipe_id: recipeId, photos };
  },
};
