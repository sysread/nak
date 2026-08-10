/**
 * Attach generated images to a message row. Uploads each image to
 * the private 'attachments' Storage bucket and inserts a
 * message_attachments row per image. Extracted from
 * getStreamingResponse.ts so the orchestrator's round loop stays
 * focused on streaming state, not Storage IO.
 *
 * Generated images have no extracted text - analyze_image reads
 * pixels directly when the user wants the image inspected.
 *
 * RLS OFF: thread ownership is verified upstream; the explicit
 * message_id ties the attachment to a row whose authority has
 * already been checked.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  base64ToBytes,
  type GeneratedImagePayload,
} from './_generated_image.ts';

export async function attachGeneratedImages(
  admin: SupabaseClient,
  userId: string,
  messageId: string,
  images: readonly GeneratedImagePayload[],
): Promise<void> {
  interface InsertRow {
    id: string;
    message_id: string;
    position: number;
    filename: string;
    mime_type: string;
    size_bytes: number;
    storage_path: string;
    extracted_text: string | null;
  }
  const prepared: InsertRow[] = [];
  for (let i = 0; i < images.length; i += 1) {
    const img = images[i];
    const id = crypto.randomUUID();
    const path = `${userId}/${id}/${img.filename}`;
    try {
      const { error: upErr } = await admin.storage
        .from('attachments')
        .upload(path, base64ToBytes(img.data_base64), {
          contentType: img.mime_type,
          upsert: true,
        });
      if (upErr) {
        console.error(
          `[attachGeneratedImages] upload failed for ${img.filename}: ${upErr.message}`,
        );
        continue;
      }
    } catch (err) {
      console.error(
        `[attachGeneratedImages] upload threw for ${img.filename}:`,
        err instanceof Error ? err.message : String(err),
      );
      continue;
    }
    prepared.push({
      id,
      message_id: messageId,
      position: i,
      filename: img.filename,
      mime_type: img.mime_type,
      size_bytes: img.size_bytes,
      storage_path: path,
      extracted_text: null,
    });
  }
  if (prepared.length === 0) return;
  const { error: insErr } = await admin
    .from('message_attachments')
    .insert(prepared);
  if (insErr) {
    console.error(
      `[attachGeneratedImages] insert failed: ${insErr.message}`,
    );
  }
}
