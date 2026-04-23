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

/** Upper bound on stored title length. Matches the old autoTitle worker. */
const TITLE_MAX_CHARS = 80;

/**
 * Trim, strip wrapping / trailing punctuation, cap length. Extracted so
 * the main-chat auto-title path and any future caller that wants the
 * same shape can share the logic without a copy. The regex matches the
 * original autoTitle's - both ASCII and Unicode "smart" quotes, plus
 * trailing periods / exclamation / question marks that the model
 * sometimes adds despite the system-prompt saying not to.
 */
export function sanitizeTitle(raw: string): string {
  return raw
    .trim()
    .replace(/^["'“”‘’]+|["'“”‘’.!?]+$/g, '')
    .trim()
    .slice(0, TITLE_MAX_CHARS);
}

export const updateTitle: ToolDef = {
  name: 'update_title',
  description:
    'Rename the current conversation. Call this when the topic has ' +
    'meaningfully shifted from the current title, or on the first turn ' +
    'when the title is still the default placeholder. Pass a concise ' +
    '3-6 word title describing the real topic of the conversation. ' +
    'No trailing punctuation, no quotes, plain text.',
  shortDescription: 'rename this conversation',
  parameters: {
    type: 'object',
    properties: {
      title: {
        type: 'string',
        minLength: 1,
        maxLength: TITLE_MAX_CHARS,
        description:
          'New 3-6 word title. No trailing punctuation, no quotes, plain text.',
      },
    },
    required: ['title'],
    additionalProperties: false,
  },
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
