/**
 * Promote a file the user attached to the current conversation into a
 * persistent Library document. The model has no file of its own to upload;
 * "create" means "take this already-attached file and keep it forever, indexed
 * for search" - the answer to "save my insurance doc so you can reference it
 * later".
 *
 * Reuses the attachment's already-parsed `extracted_text` (the composer ran
 * the Venice text-parser at upload time) rather than re-extracting, and copies
 * the binary into the documents bucket when it is still live. An expired
 * attachment (binary reclaimed after 30 days) can still be promoted from its
 * surviving extracted_text - the doc is searchable, just without a downloadable
 * original.
 */
import type { ToolDef } from './types';
import { base64ToBlob } from '../attachments';
import { chunkText, MAX_DOCUMENT_TITLE_CHARS, MAX_DOCUMENT_DESCRIPTION_CHARS } from '../documents';
import { docCreateSchema } from './doc_create.schema';

export const docCreate: ToolDef = {
  ...docCreateSchema,
  async execute(args, ctx) {
    const filename = typeof args.filename === 'string' ? args.filename.trim() : '';
    if (!filename) throw new Error('filename is required');
    const description =
      typeof args.description === 'string' ? args.description.trim() : '';
    const title =
      typeof args.title === 'string' && args.title.trim().length > 0
        ? args.title.trim()
        : filename;

    const attachment = await ctx.supabase.findAttachmentByFilenameInThread(
      ctx.threadId,
      filename
    );
    if (!attachment) {
      return {
        created: false,
        reason: `No attachment named "${filename}" found in this conversation.`,
      };
    }
    const text = (attachment.extracted_text ?? '').trim();
    if (text.length === 0) {
      return {
        created: false,
        reason:
          `"${filename}" has no extractable text, so it can't be saved as a ` +
          'searchable document. The Library is for text-based files.',
      };
    }

    const doc = await ctx.supabase.createDocument({
      title: title.slice(0, MAX_DOCUMENT_TITLE_CHARS),
      description: description.slice(0, MAX_DOCUMENT_DESCRIPTION_CHARS),
      filename,
      mimeType: attachment.mime_type,
      sizeBytes: attachment.size_bytes,
    });

    // Copy the binary into the bucket only when it is still live; an expired
    // attachment leaves storage_path null but a fully searchable document.
    if (attachment.data_base64) {
      const blob = base64ToBlob(attachment.data_base64, attachment.mime_type);
      const path = await ctx.supabase.uploadDocumentFile({
        documentId: doc.id,
        filename,
        file: blob,
        contentType: attachment.mime_type,
      });
      await ctx.supabase.setDocumentStoragePath(doc.id, path);
    }

    await ctx.supabase.setDocumentExtraction(doc.id, { status: 'done', text });
    await ctx.supabase.insertDocumentChunks(doc.id, chunkText(text));

    return { created: true, document_id: doc.id, title: doc.title };
  },
};
