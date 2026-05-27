import { describe, it, expect } from 'vitest';
import {
  GENERATED_IMAGE_RESULT_KEY,
  extractGeneratedImage,
  generatedImageToNewAttachment,
  stripGeneratedImage,
} from '../src/lib/tools/generated-image';
import { partitionAttachments } from '../src/lib/ui/message-attachments';
import type { Attachment } from '../src/lib/supabase';

const payload = {
  filename: 'generated-123.webp',
  mime_type: 'image/webp',
  data_base64: 'AAAA',
  size_bytes: 3,
};

function toolValue(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    filename: payload.filename,
    width: 1024,
    height: 1024,
    note: 'attached',
    [GENERATED_IMAGE_RESULT_KEY]: payload,
    ...extra,
  };
}

describe('generated-image harvest', () => {
  it('extracts a well-formed payload', () => {
    expect(extractGeneratedImage(toolValue())).toEqual(payload);
  });

  it('returns null for values without the key', () => {
    expect(extractGeneratedImage({ answer: 'hi' })).toBeNull();
    expect(extractGeneratedImage(null)).toBeNull();
    expect(extractGeneratedImage('string')).toBeNull();
  });

  it('returns null when the payload is malformed', () => {
    const bad = { [GENERATED_IMAGE_RESULT_KEY]: { filename: 'x' } };
    expect(extractGeneratedImage(bad)).toBeNull();
  });

  it('strips the heavy key, leaving the model-visible descriptor', () => {
    const stripped = stripGeneratedImage(toolValue()) as Record<string, unknown>;
    expect(stripped[GENERATED_IMAGE_RESULT_KEY]).toBeUndefined();
    expect(stripped.filename).toBe(payload.filename);
    expect(stripped.width).toBe(1024);
    // Stripping must not mutate the source object - the harvest reads
    // the original after this in the chat-loop ordering.
    expect(
      (toolValue() as Record<string, unknown>)[GENERATED_IMAGE_RESULT_KEY]
    ).toBeDefined();
  });

  it('passes non-image tool results through untouched', () => {
    const value = { answer: 'hi', citations: [] };
    expect(stripGeneratedImage(value)).toBe(value);
  });

  it('builds an attachment row with no extracted text', () => {
    const row = generatedImageToNewAttachment(payload, 2);
    expect(row).toEqual({
      position: 2,
      filename: payload.filename,
      mime_type: payload.mime_type,
      size_bytes: payload.size_bytes,
      data_base64: payload.data_base64,
      extracted_text: null,
    });
  });
});

function att(over: Partial<Attachment>): Attachment {
  return {
    id: 'a',
    message_id: 'm',
    position: 0,
    filename: 'f',
    mime_type: 'image/webp',
    size_bytes: 1,
    data_base64: 'AAAA',
    extracted_text: null,
    expired_at: null,
    created_at: '2026-01-01T00:00:00Z',
    ...over,
  };
}

describe('partitionAttachments', () => {
  it('routes live images to the preview group and files to chips', () => {
    const liveImage = att({ id: 'img', mime_type: 'image/png' });
    const pdf = att({ id: 'pdf', mime_type: 'application/pdf' });
    const { images, files } = partitionAttachments([liveImage, pdf]);
    expect(images.map((a) => a.id)).toEqual(['img']);
    expect(files.map((a) => a.id)).toEqual(['pdf']);
  });

  it('treats an expired image as a chip, not a preview', () => {
    // No bytes to show, so it falls back to the filename + expired
    // badge row rather than a broken large preview.
    const expiredImage = att({
      id: 'exp',
      mime_type: 'image/png',
      data_base64: null,
      expired_at: '2026-02-01T00:00:00Z',
    });
    const { images, files } = partitionAttachments([expiredImage]);
    expect(images).toEqual([]);
    expect(files.map((a) => a.id)).toEqual(['exp']);
  });

  it('preserves order within each group', () => {
    const a1 = att({ id: 'i1', mime_type: 'image/png' });
    const f1 = att({ id: 'f1', mime_type: 'text/plain' });
    const a2 = att({ id: 'i2', mime_type: 'image/jpeg' });
    const { images, files } = partitionAttachments([a1, f1, a2]);
    expect(images.map((a) => a.id)).toEqual(['i1', 'i2']);
    expect(files.map((a) => a.id)).toEqual(['f1']);
  });
});
