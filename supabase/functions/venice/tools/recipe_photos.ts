// recipe_photos_* tools (function-side port)
//
// Four tools for managing photos on a saved recipe:
//   - recipe_photos_attach    add image(s) from the conversation
//   - recipe_photos_remove    drop specific photo ids
//   - recipe_photos_reorder   set photo order to a permutation
//   - recipe_photo_label_set  update captions on existing photos
//
// All four delegate to a recipe_* RPC that creates a new
// recipe_versions row, so a photo edit shows in the History panel
// like any other change. The RPCs accept a p_user_id escape hatch so
// the function side (admin client, no auth.uid()) can call in with
// the orchestrator-validated userId rather than auth context.
//
// recipe_photos_attach extra work: resolve filenames against the
// thread's message_attachments, download each blob from the
// attachments bucket, hash + upload into the user's content-addressed
// recipe-images bucket at `<userId>/<sha256>`, dedup via
// recipe_image_upsert, then link the resulting image ids onto the
// recipe.

import { requireThreadId, registerTool, type ToolContext, type ToolDef } from '../performToolCall.ts';

interface AttachmentRow {
  id: string;
  filename: string;
  mime_type: string;
  size_bytes: number;
  storage_path: string | null;
}

interface PhotoMetaRow {
  image_id: string;
  position: number;
  label: string | null;
}

// The parameter is ArrayBuffer-backed by declaration because
// crypto.subtle.digest rejects SharedArrayBuffer-backed views, and
// TypeScript's generic Uint8Array<ArrayBufferLike> default would admit
// them. Callers construct fresh views over blob.arrayBuffer(), so the
// narrower type costs nothing.
async function sha256Hex(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  const view = new Uint8Array(digest);
  let out = '';
  for (let i = 0; i < view.length; i += 1) {
    out += view[i].toString(16).padStart(2, '0');
  }
  return out;
}

function projectPhotos(
  rows: readonly PhotoMetaRow[],
): Array<{ id: string; position: number; label: string | null }> {
  return rows.map((r) => ({
    id: r.image_id,
    position: r.position,
    label: r.label,
  }));
}

// ---------------------------------------------------------------------------
// recipe_photos_attach
// ---------------------------------------------------------------------------

export const recipePhotosAttach: ToolDef = {
  name: 'recipe_photos_attach',
  async execute(args: Record<string, unknown>, ctx: ToolContext) {
    const recipeId = typeof args.recipe_id === 'string' ? args.recipe_id : '';
    if (!recipeId) throw new Error('recipe_id is required');
    const filenames = Array.isArray(args.filenames)
      ? args.filenames.filter(
          (f): f is string => typeof f === 'string' && f.length > 0,
        )
      : [];
    if (filenames.length === 0) {
      throw new Error('filenames must contain at least one entry');
    }
    let labels: (string | null)[] | null = null;
    if (args.labels !== undefined && args.labels !== null) {
      if (!Array.isArray(args.labels)) {
        throw new Error('labels must be an array when provided');
      }
      if (args.labels.length !== filenames.length) {
        throw new Error(
          `labels length (${args.labels.length}) must match filenames length (${filenames.length})`,
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
    if (!changeMessage) throw new Error('change_message is required');

    // Resolve every filename to a live (storage_path != null) image
    // attachment in the thread. Either we have the full set or fail
    // fast with one readable error - half-attaching a batch leaves
    // the user reasoning about a partial state.
    const missing: string[] = [];
    const expired: string[] = [];
    const resolved: Array<{
      filename: string;
      attachment: AttachmentRow;
    }> = [];
    for (const filename of filenames) {
      const { data, error } = await ctx.adminClient
        .from('message_attachments')
        .select(
          'id, filename, mime_type, size_bytes, storage_path, messages!inner(thread_id)',
        )
        .eq('messages.thread_id', requireThreadId(ctx))
        .eq('filename', filename)
        .like('mime_type', 'image/%')
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle<AttachmentRow>();
      if (error) {
        throw new Error(
          `findImageByFilenameInThread failed for "${filename}": ${error.message}`,
        );
      }
      if (!data) {
        missing.push(filename);
        continue;
      }
      if (!data.storage_path) {
        expired.push(filename);
        continue;
      }
      resolved.push({ filename, attachment: data });
    }
    if (missing.length > 0 || expired.length > 0) {
      const parts: string[] = [];
      if (missing.length > 0) {
        parts.push(
          `not in this thread: ${missing.map((f) => `"${f}"`).join(', ')}`,
        );
      }
      if (expired.length > 0) {
        parts.push(
          `bytes expired (re-attach to refresh): ${expired
            .map((f) => `"${f}"`)
            .join(', ')}`,
        );
      }
      throw new Error(parts.join('; '));
    }

    // Download bytes, hash, upload into recipe-images bucket, upsert
    // the row. Each resolved attachment maps to one recipe_images
    // entry by content; running the same call again on the same
    // attachment is idempotent thanks to the (user_id, sha256)
    // conflict target.
    const imageIds: string[] = [];
    for (const { filename, attachment } of resolved) {
      if (!attachment.storage_path) continue; // already filtered above
      const { data: blob, error: dlErr } = await ctx.adminClient.storage
        .from('attachments')
        .download(attachment.storage_path);
      if (dlErr || !blob) {
        throw new Error(
          `download for "${filename}" failed: ${dlErr?.message ?? 'no blob'}`,
        );
      }
      const bytes = new Uint8Array(await blob.arrayBuffer());
      const sha = await sha256Hex(bytes);
      const path = `${ctx.userId}/${sha}`;
      const { error: upErr } = await ctx.adminClient.storage
        .from('recipe-images')
        .upload(path, bytes, {
          contentType: attachment.mime_type,
          upsert: true,
        });
      if (upErr) {
        throw new Error(
          `recipe-images upload for "${filename}" failed: ${upErr.message}`,
        );
      }
      const { data: imageId, error: imgErr } = await ctx.adminClient.rpc(
        'recipe_image_upsert',
        {
          p_sha256: sha,
          p_mime_type: attachment.mime_type,
          p_size_bytes: attachment.size_bytes,
          p_storage_path: path,
          p_user_id: ctx.userId,
        },
      );
      if (imgErr || typeof imageId !== 'string') {
        throw new Error(
          `recipe_image_upsert for "${filename}" failed: ${imgErr?.message ?? 'no id'}`,
        );
      }
      imageIds.push(imageId);
    }

    // Build the parallel arrays the RPC expects: [imageIds, labels].
    // labels is null when the model passed no labels at all (the
    // "additive captioning off" path); the elided form lets the RPC
    // skip the labels-length sanity check.
    const labelArray = labels ?? null;

    const { data: photoRows, error: attachErr } = await ctx.adminClient.rpc(
      'recipe_attach_photos',
      {
        p_recipe_id: recipeId,
        p_image_ids: imageIds,
        p_image_labels: labelArray,
        p_change_message: changeMessage,
        p_user_id: ctx.userId,
      },
    );
    if (attachErr) {
      throw new Error(`recipe_attach_photos failed: ${attachErr.message}`);
    }
    return {
      recipe_id: recipeId,
      photos: projectPhotos((photoRows ?? []) as PhotoMetaRow[]),
    };
  },
};

// ---------------------------------------------------------------------------
// recipe_photos_remove
// ---------------------------------------------------------------------------

export const recipePhotosRemove: ToolDef = {
  name: 'recipe_photos_remove',
  async execute(args: Record<string, unknown>, ctx: ToolContext) {
    const recipeId = typeof args.recipe_id === 'string' ? args.recipe_id : '';
    if (!recipeId) throw new Error('recipe_id is required');
    const photoIds = Array.isArray(args.photo_ids)
      ? args.photo_ids.filter(
          (p): p is string => typeof p === 'string' && p.length > 0,
        )
      : [];
    if (photoIds.length === 0) {
      throw new Error('photo_ids must contain at least one entry');
    }
    const changeMessage =
      typeof args.change_message === 'string' ? args.change_message.trim() : '';
    if (!changeMessage) throw new Error('change_message is required');

    const { data, error } = await ctx.adminClient.rpc('recipe_remove_photos', {
      p_recipe_id: recipeId,
      p_image_ids: photoIds,
      p_change_message: changeMessage,
      p_user_id: ctx.userId,
    });
    if (error) throw new Error(`recipe_remove_photos failed: ${error.message}`);
    return {
      recipe_id: recipeId,
      photos: projectPhotos((data ?? []) as PhotoMetaRow[]),
    };
  },
};

// ---------------------------------------------------------------------------
// recipe_photos_reorder
// ---------------------------------------------------------------------------

export const recipePhotosReorder: ToolDef = {
  name: 'recipe_photos_reorder',
  async execute(args: Record<string, unknown>, ctx: ToolContext) {
    const recipeId = typeof args.recipe_id === 'string' ? args.recipe_id : '';
    if (!recipeId) throw new Error('recipe_id is required');
    const photoIds = Array.isArray(args.photo_ids)
      ? args.photo_ids.filter(
          (p): p is string => typeof p === 'string' && p.length > 0,
        )
      : [];
    if (photoIds.length === 0) {
      throw new Error('photo_ids must contain at least one entry');
    }
    const changeMessage =
      typeof args.change_message === 'string' ? args.change_message.trim() : '';
    if (!changeMessage) throw new Error('change_message is required');

    const { data, error } = await ctx.adminClient.rpc('recipe_reorder_photos', {
      p_recipe_id: recipeId,
      p_image_ids: photoIds,
      p_change_message: changeMessage,
      p_user_id: ctx.userId,
    });
    if (error) {
      throw new Error(`recipe_reorder_photos failed: ${error.message}`);
    }
    return {
      recipe_id: recipeId,
      photos: projectPhotos((data ?? []) as PhotoMetaRow[]),
    };
  },
};

// ---------------------------------------------------------------------------
// recipe_photo_label_set
// ---------------------------------------------------------------------------

export const recipePhotoLabelSet: ToolDef = {
  name: 'recipe_photo_label_set',
  async execute(args: Record<string, unknown>, ctx: ToolContext) {
    const recipeId = typeof args.recipe_id === 'string' ? args.recipe_id : '';
    if (!recipeId) throw new Error('recipe_id is required');
    const photos = Array.isArray(args.photos) ? args.photos : [];
    if (photos.length === 0) {
      throw new Error('photos must contain at least one entry');
    }
    const imageIds: string[] = [];
    const imageLabels: (string | null)[] = [];
    for (const p of photos) {
      if (!p || typeof p !== 'object') {
        throw new Error('each photos entry must be an object with id + label');
      }
      const id = (p as Record<string, unknown>).id;
      if (typeof id !== 'string' || id.length === 0) {
        throw new Error('each photos entry must have a non-empty id');
      }
      imageIds.push(id);
      const rawLabel = (p as Record<string, unknown>).label;
      if (rawLabel === null || rawLabel === undefined) {
        imageLabels.push(null);
      } else if (typeof rawLabel === 'string') {
        const trimmed = rawLabel.trim();
        imageLabels.push(trimmed.length === 0 ? null : trimmed);
      } else {
        throw new Error('photos[].label must be a string or null');
      }
    }
    const changeMessage =
      typeof args.change_message === 'string' ? args.change_message.trim() : '';
    if (!changeMessage) throw new Error('change_message is required');

    const { data, error } = await ctx.adminClient.rpc(
      'recipe_set_photo_labels',
      {
        p_recipe_id: recipeId,
        p_image_ids: imageIds,
        p_image_labels: imageLabels,
        p_change_message: changeMessage,
        p_user_id: ctx.userId,
      },
    );
    if (error) {
      throw new Error(`recipe_set_photo_labels failed: ${error.message}`);
    }
    return {
      recipe_id: recipeId,
      photos: projectPhotos((data ?? []) as PhotoMetaRow[]),
    };
  },
};

registerTool(recipePhotosAttach);
registerTool(recipePhotosRemove);
registerTool(recipePhotosReorder);
registerTool(recipePhotoLabelSet);
