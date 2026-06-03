// doc_delete (function-side port)
//
// Delete a Library document - its row, its chunks (FK cascade), and
// its original file in the `documents` storage bucket. Wire schema
// lives in src/lib/tools/doc_delete.schema.ts.
//
// The bucket object is removed first; if that fails we still throw
// before deleting the row, so we never orphan a bucket object behind
// a deleted row. A leftover row whose object is already gone is the
// safer failure direction (UI can retry).

import { registerTool, type ToolContext, type ToolDef } from '../performToolCall.ts';

export const docDelete: ToolDef = {
  name: 'doc_delete',
  async execute(args: Record<string, unknown>, ctx: ToolContext) {
    const id = typeof args.id === 'string' ? args.id.trim() : '';
    if (!id) throw new Error('id is required');

    // RLS OFF: filter by userId. Snapshot the storage_path so we
    // can remove the bucket object before dropping the row.
    const { data: existing, error: readErr } = await ctx.adminClient
      .from('documents')
      .select('storage_path')
      .eq('id', id)
      .eq('user_id', ctx.userId)
      .maybeSingle<{ storage_path: string | null }>();
    if (readErr) throw new Error(`getDocumentById failed: ${readErr.message}`);
    if (!existing) return { deleted: false, reason: 'No document with that id.' };

    if (existing.storage_path) {
      const { error: rmErr } = await ctx.adminClient.storage
        .from('documents')
        .remove([existing.storage_path]);
      if (rmErr) throw new Error(`document storage remove failed: ${rmErr.message}`);
    }

    // RLS OFF: filter by userId on the delete itself.
    const { error: delErr } = await ctx.adminClient
      .from('documents')
      .delete()
      .eq('id', id)
      .eq('user_id', ctx.userId);
    if (delErr) throw new Error(`deleteDocument failed: ${delErr.message}`);

    return { deleted: true, document_id: id };
  },
};

registerTool(docDelete);
