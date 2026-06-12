// update_title (function-side port)
//
// Renames the current thread. The wire schema (name, description,
// argument shape) is declared canonically in
// `src/lib/tools/update_title.schema.ts`; the browser builds the
// tools[] array against that schema and ships it to /stream, so this
// file only needs the runtime name and the execute logic.
//
// Sanitization rules mirror the browser version exactly - trim, first
// non-empty line, strip wrapping/trailing quotes and punctuation,
// 80-char cap, upper-case the first character. Keeping the rules in
// lock-step matters because both sides have to render the same final
// title back to the model on the next round; any divergence shows up
// as the model "thinking" it renamed the thread to something the
// drawer doesn't display.
//
// Auth model: b-strict per docs/dev/edge-function-auth.md. The
// /stream handler validated `ctx.threadId` against `ctx.userId` at
// entry; this UPDATE filters on both `id` and `user_id` as
// defense-in-depth so a future code path that constructs a
// ToolContext with a wrong userId can't write someone else's thread
// even if the threadId-binding logic upstream regresses.

import { requireThreadId, registerTool, type ToolContext, type ToolDef } from '../performToolCall.ts';

const TITLE_MAX_CHARS = 80;

/**
 * Trim, collapse to the first non-empty line, strip wrapping quotes
 * and trailing punctuation, cap at TITLE_MAX_CHARS, upper-case the
 * first character. The regex covers ASCII and Unicode "smart" quotes
 * because models alternate between the two unpredictably.
 *
 * First-line split rationale: models occasionally ignore the
 * "concise 3-6 word title" instruction and dump their whole reply
 * into the argument. The first non-empty line recovers the intended
 * title in the common case (line 1 is the title, line 2+ is
 * spillover); at worst we keep a single truncated sentence rather
 * than a multi-line garbage string.
 *
 * First-char upper-case: title-gen prompt accepts lower-case
 * ("troubleshooting the refrigerator"); we force the first character
 * so model-generated titles match the visual weight of
 * manually-named threads in the drawer.
 */
function sanitizeTitle(raw: string): string {
  const firstLine =
    raw
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find((line) => line.length > 0) ?? '';
  const trimmed = firstLine
    .replace(/^["'“”‘’]+|["'“”‘’.!?]+$/g, '')
    .trim()
    .slice(0, TITLE_MAX_CHARS);
  if (trimmed.length === 0) return trimmed;
  return trimmed.charAt(0).toLocaleUpperCase() + trimmed.slice(1);
}

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
