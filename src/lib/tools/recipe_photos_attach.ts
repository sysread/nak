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
    'set. Use `recipe_photos_remove` to drop photos and ' +
    '`recipe_photos_reorder` to change their order. `change_message` ' +
    'is REQUIRED and lands in the recipe history. Returns ' +
    '{recipe_id, photos: [{id, position}, ...]} - the post-attach ' +
    'full ordered set so you can chain into a follow-up call without ' +
    'a separate read.',
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
    // (dedup by sha256) and collect the resulting image_ids.
    const imageIds: string[] = [];
    for (const r of resolved) {
      const id = await ctx.supabase.upsertRecipeImage(
        r.sha256,
        r.mime,
        r.size,
        r.data
      );
      imageIds.push(id);
    }

    const photos = await ctx.supabase.attachRecipePhotos(
      recipeId,
      imageIds,
      changeMessage
    );
    notifyCookbookChanged();
    return { recipe_id: recipeId, photos };
  },
};
