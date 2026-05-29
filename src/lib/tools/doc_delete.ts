/**
 * Delete a Library document - its row, its chunks (FK cascade), and its
 * original file in the bucket. The destructive counterpart to doc_create;
 * gated in the `library` write toolbox so an autonomous turn can't wipe
 * reference material without a deliberate user-or-model gate. Returns
 * {deleted: false} for an unknown id rather than throwing.
 */
import type { ToolDef } from './types';
import { docDeleteSchema } from './doc_delete.schema';

export const docDelete: ToolDef = {
  ...docDeleteSchema,
  async execute(args, ctx) {
    const id = typeof args.id === 'string' ? args.id.trim() : '';
    if (!id) throw new Error('id is required');

    const existing = await ctx.supabase.getDocumentById(id);
    if (!existing) return { deleted: false, reason: 'No document with that id.' };

    await ctx.supabase.deleteDocument(id);
    return { deleted: true, document_id: id };
  },
};
