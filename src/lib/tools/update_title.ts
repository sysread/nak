/**
 * Rename the current conversation. Always on — the chat loop injects a
 * system-prompt note every turn telling the model what the current title
 * is and when to call this tool.
 *
 * When to call:
 *   - On the first turn, if the stored title is still the
 *     "New conversation" placeholder - pick a topical 3-6 word title.
 *   - On later turns, only when the topic has meaningfully shifted from
 *     the current title. Cosmetic drift is not a reason to rename.
 *
 * When NOT to call:
 *   - The chat loop suppresses the rename instruction entirely when the
 *     user has manually renamed the thread (title_manually_set=true on
 *     the row). The tool handler doesn't re-check the flag as a guard:
 *     the prompt-level suppression is the single point of control, and
 *     a double-guard would diverge on exactly the edge case where it
 *     mattered (new code path that skipped the suppression but hit the
 *     tool). If the model somehow calls this tool on a manually-named
 *     thread anyway, the user can always rename again.
 *
 * Failure model: mirrors the old autoTitle worker's silent-on-error
 * posture at the layer where it matters. A rename failure here surfaces
 * to the model as a tool-error result (chat-loop stringifies the thrown
 * error into the role='tool' row), but the user's main response still
 * streams normally because tool execution is decoupled from the
 * response text stream.
 *
 * Title sanitisation: same rules the old autoTitle worker used - trim,
 * strip surrounding quotes (including curly quotes), cap at 80 chars.
 * Kept in this file because the model's output is the only source;
 * anyone else renaming a thread (the user, via the title input) already
 * owns their own sanitisation at the UI layer.
 */
import type { ToolDef } from './types';
import { updateTitleSchema, TITLE_MAX_CHARS } from './update_title.schema';

/**
 * Trim, collapse to the first non-empty line, strip wrapping / trailing
 * punctuation, cap length, capitalize the first character. Extracted so
 * the main-chat auto-title path and any future caller that wants the
 * same shape can share the logic without a copy. The regex matches the
 * original autoTitle's - both ASCII and Unicode "smart" quotes, plus
 * trailing periods / exclamation / question marks that the model
 * sometimes adds despite the system-prompt saying not to.
 *
 * First-line split: the model sometimes ignores the "concise 3-6 word
 * title" instruction and stuffs its full response into the argument
 * ("Holy Spirit Origins in Christianity\n\nThe concept of the ..."). A
 * straight 80-char slice would then store a multi-line string whose
 * second line is a truncated paragraph - the sidebar renders that as
 * wrapped garbage. Taking only the first non-empty line recovers the
 * intended title in the common case (line 1 is the title, line 2+ is
 * spillover) and at worst yields a single truncated sentence rather
 * than a multi-line one.
 *
 * First-letter capitalization: the title-gen prompt says title-case is
 * fine but not required, so smaller / instruction-loose models routinely
 * emit lowercase ("troubleshooting the refrigerator", "how to bake
 * sourdough"). Those land in the sidebar looking unfinished and
 * inconsistent with manually-named threads. We force the first character
 * to uppercase here so every model-generated title - worker auto-title
 * and the `update_title` tool both flow through this helper - lands
 * looking the same. Only the first character is touched; "iOS upgrade"
 * style mid-word casing the model deliberately chose stays intact past
 * char 0.
 */
export function sanitizeTitle(raw: string): string {
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
  ...updateTitleSchema,
  async execute(args, ctx) {
    const raw = typeof args.title === 'string' ? args.title : '';
    const title = sanitizeTitle(raw);
    if (!title) throw new Error('title is required (non-empty after trim)');
    await ctx.supabase.renameThread(ctx.threadId, title);
    // Return the sanitised title so the model sees exactly what we
    // stored - not the raw argument it passed. Keeps the tool-result
    // row honest if the sanitiser stripped something, and the chat-
    // loop's onTitleChange handler reads this same field to drive the
    // optimistic UI update.
    return { title };
  },
};
