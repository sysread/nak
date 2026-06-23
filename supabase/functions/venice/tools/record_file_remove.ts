// record_file_remove (function-side port)
//
// Detach a file from a record: delete the wiki_record_files row and its
// bucket object. Wire schema lives in
// src/lib/tools/record_file_remove.schema.ts. RLS OFF: every query filters
// by user_id, so a service-role call can only remove the caller's files.
// Returns {removed: false} for an unknown/non-owned id rather than
// throwing, so a probing caller can't distinguish miss from not-owned.

import { registerTool, type ToolContext, type ToolDef } from '../performToolCall.ts';
import {
  appendRecordChangelogMessage,
  buildRecordFileChangelogMessage,
  getOwnedRecord,
} from './_record_helpers.ts';

interface FileRow {
  id: string;
  record_id: string;
  filename: string;
  mime_type: string | null;
  storage_path: string | null;
}

export const recordFileRemove: ToolDef = {
  name: 'record_file_remove',
  async execute(args: Record<string, unknown>, ctx: ToolContext) {
    const id = typeof args.file_id === 'string' ? args.file_id.trim() : '';
    if (!id) throw new Error('file_id is required');

    const { data: file } = await ctx.adminClient
      .from('wiki_record_files')
      .select('id, record_id, filename, mime_type, storage_path')
      .eq('user_id', ctx.userId)
      .eq('id', id)
      .maybeSingle<FileRow>();
    if (!file) return { removed: false };

    const record = await getOwnedRecord(ctx.adminClient, ctx.userId, file.record_id);

    if (file.storage_path) {
      // Best-effort: a failed object remove is reclaimed by the daily
      // wiki-record-file-gc sweep.
      await ctx.adminClient.storage.from('wiki-record-files').remove([file.storage_path]);
    }
    const { data, error } = await ctx.adminClient
      .from('wiki_record_files')
      .delete()
      .eq('user_id', ctx.userId)
      .eq('id', id)
      .select('id');
    if (error) throw new Error(`record file delete failed: ${error.message}`);
    const removed = Array.isArray(data) && data.length > 0;

    if (removed && record) {
      try {
        await appendRecordChangelogMessage(
          ctx.adminClient,
          ctx.userId,
          record.article_id,
          'record_update',
          buildRecordFileChangelogMessage(
            'remove',
            record.date,
            file.filename,
            (file.mime_type ?? '').startsWith('image/'),
          ),
        );
      } catch {
        // swallow - best-effort audit row.
      }
    }
    return { removed };
  },
};

registerTool(recordFileRemove);
