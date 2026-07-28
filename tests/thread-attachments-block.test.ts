/**
 * Unit coverage for the `<thread_attachments>` per-turn system block.
 *
 * The block is the model's only thread-wide view of what files exist and
 * which tool reaches each one, so its failure mode is silent: a section that
 * doesn't render leaves the model with no lever and it concludes the file is
 * unreadable. The "Viewable pages" line in particular is the entire reason a
 * scanned PDF is answerable, since that document's inlined text is empty.
 */
import { describe, it, expect } from 'vitest';
import { buildThreadAttachmentsBlock } from '../src/lib/chat/prompt-assembly';
import type { ThreadAttachmentSummary } from '../src/lib/supabase/types/chat';

function summary(over: Partial<ThreadAttachmentSummary> = {}): ThreadAttachmentSummary {
  return {
    filename: 'file.txt',
    mime_type: 'text/plain',
    is_image: false,
    expired: false,
    page_count: null,
    created_at: '2026-01-01T00:00:00Z',
    ...over,
  };
}

describe('buildThreadAttachmentsBlock', () => {
  it('returns null for a thread with no attachments so a clean chat pays nothing', () => {
    expect(buildThreadAttachmentsBlock([])).toBeNull();
  });

  it('lists images against analyze_image and documents as inlined text', () => {
    const block = buildThreadAttachmentsBlock([
      summary({ filename: 'shot.png', mime_type: 'image/png', is_image: true }),
      summary({ filename: 'notes.txt' }),
    ]);
    expect(block).toContain('Live images: shot.png');
    expect(block).toContain('analyze_image(filename, query)');
    expect(block).toContain('Live documents: notes.txt');
    expect(block).not.toContain('Viewable pages');
  });

  it('advertises analyze_pdf_page with the page count for a rasterized PDF', () => {
    const block = buildThreadAttachmentsBlock([
      summary({ filename: 'scan.pdf', mime_type: 'application/pdf', page_count: 12 }),
    ]);
    expect(block).toContain('Viewable pages: scan.pdf (12 pages)');
    expect(block).toContain('analyze_pdf_page(filename, page, query)');
    // Still a document, so the inlined-text line stays - a text-native PDF
    // should be read from the inlined text, not rasterized page by page.
    expect(block).toContain('Live documents: scan.pdf');
  });

  it('omits the viewable line for a PDF that produced no pages', () => {
    const block = buildThreadAttachmentsBlock([
      summary({ filename: 'plain.pdf', mime_type: 'application/pdf', page_count: null }),
    ]);
    expect(block).toContain('Live documents: plain.pdf');
    expect(block).not.toContain('Viewable pages');
  });

  it('drops an expired PDF out of every live section', () => {
    // Deleting the attachment reclaims its page objects too, so a stale
    // page_count must not keep advertising a document whose bytes are gone.
    const block = buildThreadAttachmentsBlock([
      summary({
        filename: 'gone.pdf',
        mime_type: 'application/pdf',
        page_count: 5,
        expired: true,
      }),
    ]);
    expect(block).toContain('Expired');
    expect(block).toContain('gone.pdf');
    expect(block).not.toContain('Viewable pages');
    expect(block).not.toContain('Live documents');
  });

  it('lets a later expired row supersede an earlier live one of the same name', () => {
    const block = buildThreadAttachmentsBlock([
      summary({
        filename: 'dupe.pdf',
        mime_type: 'application/pdf',
        page_count: 3,
        created_at: '2026-01-01T00:00:00Z',
      }),
      summary({
        filename: 'dupe.pdf',
        mime_type: 'application/pdf',
        page_count: 3,
        expired: true,
        created_at: '2026-01-02T00:00:00Z',
      }),
    ]);
    expect(block).not.toContain('Viewable pages');
    expect(block).toContain('Expired');
  });

  it('lists several rasterized PDFs with their own page counts', () => {
    const block = buildThreadAttachmentsBlock([
      summary({ filename: 'a.pdf', mime_type: 'application/pdf', page_count: 2 }),
      summary({ filename: 'b.pdf', mime_type: 'application/pdf', page_count: 40 }),
    ]);
    expect(block).toContain('a.pdf (2 pages)');
    expect(block).toContain('b.pdf (40 pages)');
  });
});
