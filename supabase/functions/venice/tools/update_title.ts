// update_title (function-side port)
//
// Renames the current thread. The wire schema (name, description,
// argument shape) is declared canonically in
// `src/lib/tools/update_title.schema.ts`; the browser builds the
// tools[] array against that schema and ships it to /stream, so this
// file only needs the runtime name and the execute logic.
//
// Sanitization is the shared rule in tools/_title.ts, run by both this tool
// and the background auto-title unit. Keeping it in one place matters
// because both paths have to render the same final title back to the model
// on the next round; any divergence shows up as the model "thinking" it
// renamed the thread to something the drawer doesn't display.
//
// Auth model: b-strict per docs/dev/edge-function-auth.md. The
// /stream handler validated `ctx.threadId` against `ctx.userId` at
// entry; this UPDATE filters on both `id` and `user_id` as
// defense-in-depth so a future code path that constructs a
// ToolContext with a wrong userId can't write someone else's thread
// even if the threadId-binding logic upstream regresses.

import { requireThreadId, registerTool, type ToolContext, type ToolDef } from '../performToolCall.ts';
import { sanitizeTitle } from './_title.ts';

export const updateTitle: ToolDef = {
  name: 'update_title',
  async execute(args: Record<string, unknown>, ctx: ToolContext) {
    const raw = typeof args.title === 'string' ? args.title : '';
    const title = sanitizeTitle(raw);
    if (!title) throw new Error('title is required (non-empty after trim)');

    // RLS OFF: filter by userId. Service-role client bypasses RLS,
    // so the explicit user_id filter prevents a rogue ToolContext
    // from writing another user's thread row.
    const { error } = await ctx.adminClient
      .from('threads')
      .update({ title, updated_at: new Date().toISOString() })
      .eq('id', requireThreadId(ctx))
      .eq('user_id', ctx.userId);
    if (error) throw new Error(`renameThread failed: ${error.message}`);

    // Returning the sanitized title (not the raw arg) so the next
    // round's tool-result row matches what landed in the DB. The
    // browser also reads this field to fire its onTitleChange UI
    // patch on `tool_call_response`.
    return { title };
  },
};

registerTool(updateTitle);
