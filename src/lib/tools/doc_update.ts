/**
 * Edit a Library document's user-facing metadata (title, description). The
 * extracted body and its chunks are bound to the uploaded file and are not
 * editable here - replacing content is a re-upload, a user action. Returns
 * {updated: false} for an unknown id or a no-op call rather than throwing.
 */
import type { ToolDef } from './types';
import { MAX_DOCUMENT_TITLE_CHARS, MAX_DOCUMENT_DESCRIPTION_CHARS } from '../documents';
import { docUpdateSchema } from './doc_update.schema';

export const docUpdate: ToolDef = {
  ...docUpdateSchema,
  async execute(args, ctx) {
    const id = typeof args.id === 'string' ? args.id.trim() : '';
    if (!id) throw new Error('id is required');

    const patch: { title?: string; description?: string } = {};
    if (typeof args.title === 'string' && args.title.trim().length > 0) {
      patch.title = args.title.trim().slice(0, MAX_DOCUMENT_TITLE_CHARS);
    }
    if (typeof args.description === 'string') {
      patch.description = args.description.trim().slice(0, MAX_DOCUMENT_DESCRIPTION_CHARS);
    }
    if (patch.title === undefined && patch.description === undefined) {
      return { updated: false, reason: 'Provide a title and/or description to change.' };
    }

    const existing = await ctx.supabase.getDocumentById(id);
    if (!existing) return { updated: false, reason: 'No document with that id.' };

    await ctx.supabase.updateDocument(id, patch);
    return { updated: true, document_id: id };
  },
};
