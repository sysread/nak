/**
 * Shared contract for handing a freshly generated image from the
 * generate_image tool up to the chat-loop, which attaches it to the
 * terminal assistant message as a `message_attachments` row (the same
 * storage + 30-day retention path user uploads use).
 *
 * Why the indirection rather than returning the base64 in the tool
 * result the model reads: a 1024px webp is roughly 700KB of base64.
 * Putting that on the role='tool' result row would replay the whole
 * blob into the model's context on every subsequent round (and every
 * thread reload) for zero benefit - the model cannot see pixels in a
 * tool string. So the tool stashes the heavy payload under
 * GENERATED_IMAGE_RESULT_KEY; the chat-loop harvests it for the DB
 * attach and strips it before encoding the model-visible tool result,
 * leaving only the compact descriptor (filename + dimensions) the
 * model needs to reference the image on later turns.
 *
 * This module is intentionally dependency-light (only the NewAttachment
 * type) so the chat-loop can import the harvest helpers without pulling
 * the lazy generate_image impl chunk into the main bundle.
 */
import type { NewAttachment } from '../supabase';

export const GENERATED_IMAGE_RESULT_KEY = '__generated_image';

export interface GeneratedImagePayload {
  filename: string;
  mime_type: string;
  /** Base64 image bytes, no `data:` prefix. */
  data_base64: string;
  size_bytes: number;
}

/**
 * Pull the stashed image payload off a tool return value, or null when
 * the value isn't a generate_image result. Structural check, not
 * name-based, so the harvest stays decoupled from the tool's identity.
 */
export function extractGeneratedImage(
  value: unknown
): GeneratedImagePayload | null {
  if (!value || typeof value !== 'object') return null;
  const raw = (value as Record<string, unknown>)[GENERATED_IMAGE_RESULT_KEY];
  if (!raw || typeof raw !== 'object') return null;
  const p = raw as Record<string, unknown>;
  if (
    typeof p.filename !== 'string' ||
    typeof p.mime_type !== 'string' ||
    typeof p.data_base64 !== 'string' ||
    typeof p.size_bytes !== 'number'
  ) {
    return null;
  }
  return {
    filename: p.filename,
    mime_type: p.mime_type,
    data_base64: p.data_base64,
    size_bytes: p.size_bytes,
  };
}

/**
 * Return a shallow clone of the tool value with the heavy image payload
 * removed, so the model-visible tool-result row carries only the
 * compact descriptor. No-op (returns the input) when the key is absent
 * so non-image tool results pass through untouched.
 */
export function stripGeneratedImage(value: unknown): unknown {
  if (!value || typeof value !== 'object') return value;
  if (!(GENERATED_IMAGE_RESULT_KEY in (value as Record<string, unknown>))) {
    return value;
  }
  const clone = { ...(value as Record<string, unknown>) };
  delete clone[GENERATED_IMAGE_RESULT_KEY];
  return clone;
}

/** Build the attachment insert row for a generated image at `position`. */
export function generatedImageToNewAttachment(
  img: GeneratedImagePayload,
  position: number
): NewAttachment {
  return {
    position,
    filename: img.filename,
    mime_type: img.mime_type,
    size_bytes: img.size_bytes,
    data_base64: img.data_base64,
    // Generated images have no extracted text; the analyze_image tool
    // reads the pixels directly if the user wants the image inspected.
    extracted_text: null,
  };
}
