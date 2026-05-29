/**
 * Unit coverage for the chunkText document-splitting primitive. Pure
 * transform - no DB, no Venice - tested via plain vitest. The companion
 * ingest/search flows in `src/lib/documents.ts` do the I/O.
 */
import { describe, it, expect } from 'vitest';
import {
  chunkText,
  DOCUMENT_CHUNK_CHARS,
  DOCUMENT_CHUNK_OVERLAP_CHARS,
} from '../src/lib/documents';

describe('chunkText', () => {
  it('returns no chunks for empty or whitespace-only input', () => {
    expect(chunkText('')).toEqual([]);
    expect(chunkText('   \n\n  \t ')).toEqual([]);
  });

  it('keeps a short document as a single chunk', () => {
    const text = 'The HOA late fee is $50 per occurrence.';
    expect(chunkText(text)).toEqual([text]);
  });

  it('packs paragraphs up to the chunk ceiling', () => {
    const para = 'x'.repeat(800);
    const text = [para, para, para].join('\n\n');
    const chunks = chunkText(text);
    // 3 * 800 + separators > 2000, so it cannot be one chunk.
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) {
      // First chunk has no overlap prefix; later ones carry up to the overlap
      // budget on top of the chunk ceiling.
      expect(c.length).toBeLessThanOrEqual(
        DOCUMENT_CHUNK_CHARS + DOCUMENT_CHUNK_OVERLAP_CHARS + 8
      );
    }
  });

  it('hard-splits a single paragraph longer than the chunk ceiling', () => {
    const huge = 'a'.repeat(DOCUMENT_CHUNK_CHARS * 2 + 500);
    const chunks = chunkText(huge);
    expect(chunks.length).toBeGreaterThanOrEqual(3);
    // The base (first) chunk is exactly the ceiling for a hard-split run.
    expect(chunks[0].length).toBe(DOCUMENT_CHUNK_CHARS);
  });

  it('carries overlap from the previous chunk into the next', () => {
    const a = 'A'.repeat(1500);
    const b = 'B'.repeat(1500);
    const chunks = chunkText(`${a}\n\n${b}`);
    expect(chunks.length).toBe(2);
    // The second chunk begins with the tail of the first (the overlap window).
    expect(chunks[1].startsWith('A'.repeat(DOCUMENT_CHUNK_OVERLAP_CHARS))).toBe(true);
  });
});
