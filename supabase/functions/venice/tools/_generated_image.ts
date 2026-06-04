// Shared contract for handing a freshly generated image from the
// generate_image tool up to the orchestrator (getStreamingResponse),
// which attaches it to the terminal assistant message as a
// message_attachments row. Mirror of src/lib/tools/generated-image.ts
// on the function side.
//
// Why the indirection rather than returning the base64 in the tool
// result the model reads: a 1024px webp is roughly 700KB of base64.
// Putting that on the role='tool' result row would replay the whole
// blob into the model's context on every subsequent round (and every
// thread reload) for zero benefit - the model cannot see pixels in a
// tool string. So the tool stashes the heavy payload under
// GENERATED_IMAGE_RESULT_KEY; the orchestrator harvests it for the DB
// attach and strips it before encoding the model-visible tool result,
// leaving only the compact descriptor (filename + dimensions) the
// model needs to reference the image on later turns.

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
  value: unknown,
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

/**
 * Decode a base64 string (no `data:` prefix) into a Uint8Array. Deno's
 * standard library exposes encoding helpers but the function side
 * keeps to platform globals to avoid the import-map dance; `atob`
 * lives on globalThis and works fine for the size of payloads the
 * image tool returns.
 */
export function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    out[i] = binary.charCodeAt(i);
  }
  return out;
}
