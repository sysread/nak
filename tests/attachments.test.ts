/**
 * Unit coverage for the attachment helpers: size validation, consumable
 * predicate, byte formatting, base64 round-trip, and the user-content
 * builder that's the bridge between stored attachments and the Venice
 * wire shape.
 *
 * Canvas-based `maybeDownscaleImage` isn't covered here — jsdom
 * doesn't implement Canvas 2D, so that function is exercised by the
 * end-to-end smoke test on the dev server instead.
 */
import { describe, it, expect } from 'vitest';
import {
  MAX_ATTACHMENT_BYTES,
  arrayBufferToBase64,
  base64ToBlob,
  buildUserVeniceContent,
  dataUrlFor,
  formatBytes,
  isConsumableBy,
  isImageMimeType,
  validateFile,
} from '../src/lib/attachments';

describe('formatBytes', () => {
  it('renders bytes under 1 KiB plainly', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(1023)).toBe('1023 B');
  });
  it('renders KB with one decimal under 100 KB', () => {
    expect(formatBytes(2048)).toBe('2.0 KB');
    expect(formatBytes(1536)).toBe('1.5 KB');
  });
  it('rounds KB at 100+ KB', () => {
    expect(formatBytes(200 * 1024)).toBe('200 KB');
  });
  it('renders MB with one decimal under 100 MB', () => {
    expect(formatBytes(2 * 1024 * 1024)).toBe('2.0 MB');
    expect(formatBytes(1024 * 1024 + 512 * 1024)).toBe('1.5 MB');
  });
});

describe('isImageMimeType', () => {
  it('matches common image types', () => {
    expect(isImageMimeType('image/png')).toBe(true);
    expect(isImageMimeType('image/jpeg')).toBe(true);
    expect(isImageMimeType('image/svg+xml')).toBe(true);
  });
  it('rejects non-image types', () => {
    expect(isImageMimeType('application/pdf')).toBe(false);
    expect(isImageMimeType('text/plain')).toBe(false);
    expect(isImageMimeType('')).toBe(false);
  });
});

function fakeFile(name: string, type: string, size: number): File {
  const f = new File([new Uint8Array(size)], name, { type });
  return f;
}

describe('validateFile', () => {
  it('rejects zero-byte files', () => {
    expect(validateFile(fakeFile('empty.txt', 'text/plain', 0))).toMatch(/Empty/i);
  });
  it('rejects files larger than the per-file cap', () => {
    expect(
      validateFile(fakeFile('big.bin', 'application/octet-stream', MAX_ATTACHMENT_BYTES + 1))
    ).toMatch(/Too large/i);
  });
  it('accepts files under the cap', () => {
    expect(validateFile(fakeFile('ok.txt', 'text/plain', 1024))).toBeNull();
    expect(
      validateFile(fakeFile('exact.txt', 'text/plain', MAX_ATTACHMENT_BYTES))
    ).toBeNull();
  });
});

describe('isConsumableBy', () => {
  const vision = { supportsVision: true };
  const noVision = { supportsVision: false };

  it('accepts an image on a vision tier even without extracted text', () => {
    expect(
      isConsumableBy({ mime_type: 'image/png', extracted_text: null }, vision)
    ).toBe(true);
  });

  it('accepts an image on a non-vision tier - analyze_image() handles it', () => {
    // Images are always consumable regardless of vision support: vision
    // tiers inline them; non-vision tiers get a note instructing the
    // model to call analyze_image().
    expect(
      isConsumableBy({ mime_type: 'image/png', extracted_text: null }, noVision)
    ).toBe(true);
  });

  it('accepts any attachment with non-empty extracted text', () => {
    expect(
      isConsumableBy(
        { mime_type: 'application/pdf', extracted_text: 'some pages' },
        noVision
      )
    ).toBe(true);
    expect(
      isConsumableBy(
        { mime_type: 'application/pdf', extracted_text: 'some pages' },
        vision
      )
    ).toBe(true);
  });

  it('rejects whitespace-only extracted text', () => {
    expect(
      isConsumableBy(
        { mime_type: 'application/pdf', extracted_text: '   \n  ' },
        noVision
      )
    ).toBe(false);
  });
});

describe('arrayBufferToBase64 / base64ToBlob', () => {
  it('round-trips arbitrary bytes', () => {
    const bytes = new Uint8Array([0, 1, 2, 0xff, 0xfe, 0x7f]);
    const b64 = arrayBufferToBase64(bytes.buffer);
    const blob = base64ToBlob(b64, 'application/octet-stream');
    expect(blob.type).toBe('application/octet-stream');
    expect(blob.size).toBe(bytes.byteLength);
  });

  it('dataUrlFor produces a well-formed data URI', () => {
    expect(dataUrlFor('image/png', 'AAAA')).toBe('data:image/png;base64,AAAA');
  });
});

describe('buildUserVeniceContent', () => {
  const vision = { supportsVision: true };
  const noVision = { supportsVision: false };
  const noUrls = new Map<string, string>();

  it('returns the plain text when there are no attachments', () => {
    expect(buildUserVeniceContent('hello', [], vision, noUrls)).toBe('hello');
    expect(buildUserVeniceContent('hello', null, vision, noUrls)).toBe('hello');
  });

  it('prepends fenced extracted-text blocks to the text', () => {
    const result = buildUserVeniceContent(
      'What does this say?',
      [
        {
          id: 'p1',
          mime_type: 'application/pdf',
          filename: 'report.pdf',
          extracted_text: 'page one\npage two',
          storage_path: 'u/p1/report.pdf',
        },
      ],
      noVision,
      noUrls
    );
    expect(typeof result).toBe('string');
    expect(result as string).toContain('```[report.pdf]');
    expect(result as string).toContain('page one');
    expect(result as string).toContain('What does this say?');
  });

  it('inlines image_url parts on a vision tier using the resolved signed URL', () => {
    const parts = buildUserVeniceContent(
      'look at this',
      [
        {
          id: 'img1',
          mime_type: 'image/png',
          filename: 'a.png',
          extracted_text: null,
          storage_path: 'u/img1/a.png',
        },
      ],
      vision,
      new Map([['img1', 'https://signed.example/a.png']])
    );
    expect(Array.isArray(parts)).toBe(true);
    const arr = parts as Array<{ type: string; image_url?: { url: string } }>;
    expect(arr[0].type).toBe('text');
    expect(arr[1].type).toBe('image_url');
    expect(arr[1].image_url?.url).toBe('https://signed.example/a.png');
  });

  it('skips an image whose signed URL could not be resolved', () => {
    // Live (storage_path set) but absent from the imageUrls map - e.g. the
    // batch signing dropped it. Defensive: no image_url part, no throw.
    const parts = buildUserVeniceContent(
      'look',
      [
        {
          id: 'img1',
          mime_type: 'image/png',
          filename: 'a.png',
          extracted_text: null,
          storage_path: 'u/img1/a.png',
        },
      ],
      vision,
      noUrls
    );
    expect(parts).toBe('look');
  });

  it('skips image inlining on non-vision tiers but prepends an analyze_image note', () => {
    // On non-vision tiers images are not inlined as image_url parts.
    // Instead, a one-line note listing the image filenames is prepended
    // so the model knows to call analyze_image(). Extracted text from
    // non-image files still appears as a fenced block.
    const result = buildUserVeniceContent(
      'check these',
      [
        {
          id: 'img1',
          mime_type: 'image/png',
          filename: 'a.png',
          extracted_text: null,
          storage_path: 'u/img1/a.png',
        },
        {
          id: 'b1',
          mime_type: 'application/pdf',
          filename: 'b.pdf',
          extracted_text: 'some text',
          storage_path: 'u/b1/b.pdf',
        },
      ],
      noVision,
      new Map([['img1', 'https://signed.example/a.png']])
    );
    expect(typeof result).toBe('string');
    expect(result as string).toContain('```[b.pdf]');
    expect(result as string).toContain('a.png');
    expect(result as string).toContain('analyze_image()');
    expect(result as string).not.toContain('image_url');
  });

  it('skips images whose object has been expired', () => {
    const parts = buildUserVeniceContent(
      'look',
      [
        {
          id: 'gone1',
          mime_type: 'image/png',
          filename: 'gone.png',
          extracted_text: null,
          storage_path: null,
        },
      ],
      vision,
      noUrls
    );
    expect(parts).toBe('look');
  });
});
