/**
 * ask_user content envelope - the persisted shapes and the parse/build
 * helpers for the clarifying-question UI flow.
 *
 * The `ask_user` TOOL itself dispatches server-side (its ToolDef is
 * schema-only in `./tools/ask_user.schema.ts`, registered via
 * `serverSideTool`); the edge function returns the pending sentinel.
 * What stays browser-side is everything that reads that sentinel off a
 * persisted tool-result row and drives the suspend/resume UI:
 * `chat-loop.ts` detects the suspended turn, `Chat.svelte` and
 * `AskUserCard.svelte` render the card and write the answer back. Those
 * consumers share these content shapes, so they live here in a non-tool
 * module rather than alongside the dead browser impl.
 *
 * Persistence shape - the JSON-encoded `content` string on the tool-
 * result row carries one of these two payloads, distinguished by a
 * dedicated flag key:
 *
 *   pending: { __ask_user_pending__: true, question, options }
 *   answer:  { __ask_user_answered__: true, answer, via, option_index? }
 *
 * Magic-flag keys (rather than shape sniffing) keep detection robust
 * if the option/answer schema ever grows additional fields. `via`
 * names which UI path produced the answer so the model and any future
 * replay logic can distinguish a deliberate pick from an abandonment.
 *
 * Cancellation cases ('via' values):
 *   - 'option' / 'free_form': normal answer paths
 *   - 'abandoned_on_refresh': user reloaded the tab without answering;
 *     Chat.svelte rewrites pending sentinels on mount
 *   - 'abandoned_on_new_send': user typed a new message into the
 *     composer instead of answering; the new send rewrites the
 *     sentinel and proceeds
 *   - 'cancelled_by_sibling_ask_user': the model issued multiple
 *     ask_user calls in one round; only the first suspends, the rest
 *     get rewritten to this state at write-time
 */

/**
 * Magic-flag key on the pending tool-result content. Detection sites
 * check for this exact key being literal `true` - more robust than
 * checking for shape because future option fields would not have a way
 * to confuse the discriminator.
 */
export const ASK_USER_PENDING_FLAG = '__ask_user_pending__';
export const ASK_USER_ANSWERED_FLAG = '__ask_user_answered__';

export interface AskUserOption {
  label: string;
  description: string;
}

export interface AskUserPendingContent {
  [ASK_USER_PENDING_FLAG]: true;
  question: string;
  options: AskUserOption[];
}

export type AskUserVia =
  | 'option'
  | 'free_form'
  | 'abandoned_on_refresh'
  | 'abandoned_on_new_send'
  | 'cancelled_by_sibling_ask_user';

export interface AskUserAnsweredContent {
  [ASK_USER_ANSWERED_FLAG]: true;
  /** Free-text answer or chosen option label. Null when abandoned/cancelled. */
  answer: string | null;
  via: AskUserVia;
  /** 0-based index into the original options array when via='option'. */
  option_index?: number;
}

/**
 * Type guards + content parser. Used by chat-loop.ts (to detect the
 * suspended state on a tool-result row) and by Chat.svelte (to project
 * the message into an AskUserCard block). Returns null for any other
 * content - regular tool results, error payloads, malformed JSON. The
 * caller treats null as "this row is not an ask_user surface; render it
 * as a normal tool result."
 */
export function parseAskUserContent(
  content: string
): AskUserPendingContent | AskUserAnsweredContent | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const obj = parsed as Record<string, unknown>;
  if (obj[ASK_USER_PENDING_FLAG] === true) {
    const question = typeof obj.question === 'string' ? obj.question : '';
    const rawOptions = Array.isArray(obj.options) ? obj.options : [];
    const options: AskUserOption[] = [];
    for (const o of rawOptions) {
      if (!o || typeof o !== 'object') continue;
      const oo = o as Record<string, unknown>;
      if (typeof oo.label !== 'string' || typeof oo.description !== 'string') continue;
      options.push({ label: oo.label, description: oo.description });
    }
    if (!question || options.length === 0) return null;
    return {
      [ASK_USER_PENDING_FLAG]: true,
      question,
      options,
    };
  }
  if (obj[ASK_USER_ANSWERED_FLAG] === true) {
    const answer = typeof obj.answer === 'string' ? obj.answer : null;
    const via = typeof obj.via === 'string' ? (obj.via as AskUserVia) : 'free_form';
    const option_index =
      typeof obj.option_index === 'number' ? obj.option_index : undefined;
    const out: AskUserAnsweredContent = {
      [ASK_USER_ANSWERED_FLAG]: true,
      answer,
      via,
    };
    if (option_index !== undefined) out.option_index = option_index;
    return out;
  }
  return null;
}

/**
 * Build the JSON-encoded answer payload that replaces a pending
 * sentinel when the user submits. Shared between Chat.svelte (the
 * normal answer path) and the abandonment paths (refresh / new send /
 * sibling cancel). Keeps the wire shape in one place so a future field
 * on the answer envelope only has to land here.
 */
export function buildAskUserAnswerContent(
  answer: string | null,
  via: AskUserVia,
  option_index?: number
): string {
  const payload: AskUserAnsweredContent = {
    [ASK_USER_ANSWERED_FLAG]: true,
    answer,
    via,
  };
  if (option_index !== undefined) payload.option_index = option_index;
  return JSON.stringify(payload);
}
