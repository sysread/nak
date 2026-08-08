// doc_create (function-side port)
//
// Promote a file the user attached to the current conversation into a
// persistent Library document. Mirrors the browser path
// (src/lib/tools/doc_create.ts): find the attachment by filename in the
// thread, insert the documents row, copy the binary from the
// `attachments` bucket to the `documents` bucket if the original is
// still live, stamp extraction_status='done' with the attachment's
// already-parsed extracted_text.
//
// The composer ran the Venice text-parser at upload time so the
// extracted_text is already on the attachment row; the function never
// re-extracts. An attachment whose binary has been reclaimed (90-day
// expiry; storage_path null) can still be promoted - the resulting
// document is searchable through extracted_text even though the
// original isn't downloadable.
//
// Auth: b-strict. message_attachments inherits ownership from messages
// -> threads, and threadId was already validated against userId at
// /stream entry, so the thread-scoped join is the correct scope. The
// documents row carries an explicit user_id so the Library reads
// (which DO go through RLS) see only the caller's docs.

import { requireThreadId, registerTool, type ToolContext, type ToolDef } from '../performToolCall.ts';

// Mirror of src/lib/documents.ts. Keep in sync deliberately - the
// browser-side schema and the user-facing copy expect the same limits.
const MAX_DOCUMENT_TITLE_CHARS = 300;
const MAX_DOCUMENT_DESCRIPTION_CHARS = 2000;

interface AttachmentRow {
  id: string;
  filename: string;
  mime_type: string;
  size_bytes: number;
  storage_path: string | null;
  extracted_text: string | null;
}

interface DocumentRow {
  id: string;
  title: string;
}

export const docCreate: ToolDef = {
  name: 'doc_create',
  async execute(args: Record<string, unknown>, ctx: ToolContext) {
    const filename = typeof args.filename === 'string' ? args.filename.trim() : '';
    if (!filename) throw new Error('filename is required');
    const description =
      typeof args.description === 'string' ? args.description.trim() : '';
    // Required by the wire schema; an empty description defeats the
    // find-it-later purpose the schema description insists on.
    if (!description) throw new Error('description is required');
    const title =
      typeof args.title === 'string' && args.title.trim().length > 0
        ? args.title.trim()
        : filename;

    // RLS OFF: scoped via parent thread (validated upstream). Join
    // message_attachments to messages so the thread_id check rides on
    // the relationship. Take the most recent matching row regardless
    // of mime type or expiry state - the caller distinguishes "not
    // found" from "expired" off the storage_path nullity below.
    const { data: attachment, error: attachmentErr } = await ctx.adminClient
      .from('message_attachments')
      .select(
        'id, filename, mime_type, size_bytes, storage_path, extracted_text, messages!inner(thread_id)',
      )
      .eq('messages.thread_id', requireThreadId(ctx))
      .eq('filename', filename)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle<AttachmentRow>();
    if (attachmentErr) {
      throw new Error(
        `findAttachmentByFilenameInThread failed: ${attachmentErr.message}`,
      );
    }
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

    // RLS OFF: user_id stamped explicitly. The documents table's
    // SELECT/UPDATE/DELETE policies key off user_id = auth.uid(); the
    // Library UI uses the session JWT so it'll see only the caller's
    // rows. Service-role inserts bypass policies but the explicit
    // user_id keeps the row addressable through the regular UI path.
    const { data: doc, error: docErr } = await ctx.adminClient
      .from('documents')
      .insert({
        user_id: ctx.userId,
        title: title.slice(0, MAX_DOCUMENT_TITLE_CHARS),
        description: description.slice(0, MAX_DOCUMENT_DESCRIPTION_CHARS),
        filename,
        mime_type: attachment.mime_type,
        size_bytes: attachment.size_bytes,
      })
      .select('id, title')
      .single<DocumentRow>();
    if (docErr || !doc) {
      throw new Error(
        `createDocument failed: ${docErr?.message ?? 'no row returned'}`,
      );
    }

    // Copy the binary into the documents bucket only when the
    // attachment is still live. An expired attachment leaves
    // storage_path null on both rows; the doc is still fully
    // searchable through extracted_text. Convention for the documents
    // bucket key is `<user_id>/<document_id>/<filename>` (mirrors the
    // browser's uploadDocumentFile).
    if (attachment.storage_path) {
      const { data: blob, error: dlErr } = await ctx.adminClient.storage
        .from('attachments')
        .download(attachment.storage_path);
      if (dlErr || !blob) {
        throw new Error(
          `downloadAttachmentBlob failed: ${dlErr?.message ?? 'no blob returned'}`,
        );
      }
      const path = `${ctx.userId}/${doc.id}/${filename}`;
      const { error: upErr } = await ctx.adminClient.storage
        .from('documents')
        .upload(path, blob, {
          contentType: attachment.mime_type,
          upsert: true,
        });
      if (upErr) {
        throw new Error(`uploadDocumentFile failed: ${upErr.message}`);
      }
      const { error: pathErr } = await ctx.adminClient
        .from('documents')
        .update({ storage_path: path })
        .eq('id', doc.id);
      if (pathErr) {
        throw new Error(`setDocumentStoragePath failed: ${pathErr.message}`);
      }
    }

    const { error: extractErr } = await ctx.adminClient
      .from('documents')
      .update({
        extraction_status: 'done',
        extracted_text: text,
        extraction_error: null,
      })
      .eq('id', doc.id);
    if (extractErr) {
      throw new Error(`setDocumentExtraction failed: ${extractErr.message}`);
    }

    return { created: true, document_id: doc.id, title: doc.title };
  },
};

registerTool(docCreate);
