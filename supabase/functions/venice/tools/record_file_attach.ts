// record_file_attach (function-side port)
//
// Promote a file the conversation already holds (a user upload OR a
// generate_image output - both are message_attachments rows) onto a wiki
// record. The model can't upload bytes of its own; it names a file by its
// filename in the current thread and this copies those bytes into the
// PERSISTENT wiki-record-files bucket so they outlive the chat
// attachment's ~30-day expiry. Wire schema lives in
// src/lib/tools/record_file_attach.schema.ts.
//
// Auth: b-strict. The record is ownership-checked (getOwnedRecord), and
// the source attachment is resolved thread-scoped against the validated
// threadId - so a service-role write can only touch the caller's own rows.

import { requireThreadId, registerTool, type ToolContext, type ToolDef } from '../performToolCall.ts';
import {
  appendRecordChangelogMessage,
  buildRecordFileChangelogMessage,
  getOwnedRecord,
} from './_record_helpers.ts';

interface SourceAttachment {
  filename: string;
  mime_type: string | null;
  size_bytes: number | null;
  storage_path: string | null;
  extracted_text: string | null;
}

export const recordFileAttach: ToolDef = {
  name: 'record_file_attach',
  async execute(args: Record<string, unknown>, ctx: ToolContext) {
    const recordId = typeof args.record_id === 'string' ? args.record_id.trim() : '';
    const filename = typeof args.filename === 'string' ? args.filename.trim() : '';
    if (!recordId) throw new Error('record_id is required');
    if (!filename) throw new Error('filename is required');

    const record = await getOwnedRecord(ctx.adminClient, ctx.userId, recordId);
    if (!record) {
      throw new Error(
        `No record with id "${recordId}" found for this user. Use record_list or record_search to find a valid record id.`,
      );
    }

    // Thread-scoped attachment lookup (any mime - images AND documents),
    // most recent match. Same resolver shape as analyze_image; the
    // thread was validated against userId at /stream entry.
    const { data, error } = await ctx.adminClient
      .from('message_attachments')
      .select('filename, mime_type, size_bytes, storage_path, extracted_text, messages!inner(thread_id)')
      .eq('messages.thread_id', requireThreadId(ctx))
      .eq('filename', filename)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle<SourceAttachment>();
    if (error) throw new Error(`attachment lookup failed: ${error.message}`);
    if (!data) throw new Error(`No file named "${filename}" in this thread.`);
    if (!data.storage_path) {
      throw new Error(
        `File "${filename}" has expired and its data is no longer available, so it can't be attached.`,
      );
    }

    // Copy the bytes from the chat-attachments bucket into the persistent
    // record-files bucket. Download-then-reupload because Storage has no
    // server-side copy across buckets in this client.
    const { data: blob, error: dlErr } = await ctx.adminClient.storage
      .from('attachments')
      .download(data.storage_path);
    if (dlErr || !blob) {
      throw new Error(`File "${filename}" could not be read for attaching. Try again.`);
    }
    const bytes = new Uint8Array(await blob.arrayBuffer());

    const id = crypto.randomUUID();
    const path = `${ctx.userId}/${id}/${filename}`;
    const { error: upErr } = await ctx.adminClient.storage
      .from('wiki-record-files')
      .upload(path, bytes, { contentType: data.mime_type ?? undefined, upsert: true });
    if (upErr) throw new Error(`record file upload failed: ${upErr.message}`);

    // Append at the end of the record's current file order.
    const { count } = await ctx.adminClient
      .from('wiki_record_files')
      .select('id', { count: 'exact', head: true })
      .eq('record_id', recordId);

    const { data: row, error: insErr } = await ctx.adminClient
      .from('wiki_record_files')
      .insert({
        id,
        user_id: ctx.userId,
        record_id: recordId,
        position: count ?? 0,
        filename,
        mime_type: data.mime_type,
        size_bytes: data.size_bytes,
        storage_path: path,
        // Carry the source doc's extracted text so record_get can show it
        // (images have none).
        extracted_text: data.extracted_text ?? null,
      })
      .select('id, record_id, position, filename, mime_type, size_bytes, created_at')
      .single();
    if (insErr) {
      // Roll back the just-uploaded object so a failed insert doesn't
      // leave an orphan (the GC sweep would also reclaim it, eventually).
      await ctx.adminClient.storage.from('wiki-record-files').remove([path]);
      throw new Error(`record file insert failed: ${insErr.message}`);
    }

    try {
      await appendRecordChangelogMessage(
        ctx.adminClient,
        ctx.userId,
        record.article_id,
        'record_update',
        buildRecordFileChangelogMessage(
          'attach',
          record.date,
          filename,
          (data.mime_type ?? '').startsWith('image/'),
        ),
      );
    } catch {
      // swallow - audit row is a convenience, the file is attached.
    }
    return { attached: true, file: row };
  },
};

registerTool(recordFileAttach);
