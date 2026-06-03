// doc_update (function-side port)
//
// Edit a Library document's title and/or description. The extracted
// body is bound to the uploaded file and is not editable here -
// replacing content would be a re-upload, a user action through the
// UI. Wire schema lives in src/lib/tools/doc_update.schema.ts.

import { registerTool, type ToolContext, type ToolDef } from '../performToolCall.ts';

// Mirror of MAX_DOCUMENT_TITLE_CHARS / MAX_DOCUMENT_DESCRIPTION_CHARS
// in src/lib/documents.ts.
const MAX_DOCUMENT_TITLE_CHARS = 200;
const MAX_DOCUMENT_DESCRIPTION_CHARS = 1000;

export const docUpdate: ToolDef = {
  name: 'doc_update',
  async execute(args: Record<string, unknown>, ctx: ToolContext) {
    const id = typeof args.id === 'string' ? args.id.trim() : '';
    if (!id) throw new Error('id is required');

    const patch: Record<string, unknown> = {};
    if (typeof args.title === 'string' && args.title.trim().length > 0) {
      patch.title = args.title.trim().slice(0, MAX_DOCUMENT_TITLE_CHARS);
    }
    if (typeof args.description === 'string') {
      patch.description = args.description.trim().slice(0, MAX_DOCUMENT_DESCRIPTION_CHARS);
    }
    if (Object.keys(patch).length === 0) {
      return { updated: false, reason: 'Provide a title and/or description to change.' };
    }
    patch.updated_at = new Date().toISOString();

    // RLS OFF: filter by userId. Existence check folded into the
    // UPDATE - 0 rows affected if id is unknown or non-owned.
    const { data, error } = await ctx.adminClient
      .from('documents')
      .update(patch)
      .eq('id', id)
      .eq('user_id', ctx.userId)
      .select('id')
      .maybeSingle();
    if (error) throw new Error(`updateDocument failed: ${error.message}`);
    if (!data) return { updated: false, reason: 'No document with that id.' };

    return { updated: true, document_id: id };
  },
};

registerTool(docUpdate);
