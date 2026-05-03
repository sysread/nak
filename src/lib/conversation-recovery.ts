/**
 * Conversation-recovery synthesis. When a thread's persisted history
 * ends in a wire-format-invalid shape — typically because a tool-using
 * exchange was interrupted before the assistant could reply to the
 * tool result — readers (the chat UI, the summary worker, the journal
 * worker, the reflection worker, the recall agents) would otherwise
 * hand the broken sequence to the provider and get a 400 back. The
 * specific failure mode that drove this module:
 *
 *   Venice HTTP 400: Unexpected role 'user' after role 'tool'
 *
 * Two broken end-shapes show up in practice:
 *
 *   1. Trailing tool-result row(s) with no follow-up assistant. The
 *      provider expects an assistant turn after a tool-result fan-in.
 *      Adding the user's next prompt directly produces the
 *      role='user' after role='tool' error above.
 *
 *   2. Trailing assistant-with-tool_calls whose tool results never
 *      landed (one or more, or all). The provider's stricter rule
 *      here is "every tool_calls[].id MUST be answered by a matching
 *      tool row before any non-tool message follows" — so the fix
 *      needs to synthesize tool-result rows for the missing ids
 *      AND a follow-up assistant.
 *
 * Both cases are repaired by appending synthesized rows that read
 * naturally to the model and tell the user what happened. The
 * synthesized rows carry a `synthetic: true` flag so the chat-loop's
 * persistence path can write them to the DB on the next user send,
 * healing the thread permanently. Background workers see the same
 * coherent shape but don't write — they just regenerate the synthesis
 * each cycle until the user revisits and sends again.
 *
 * Idempotency: every synthesized row carries the `RECOVERY_MARKER`
 * inside its content (HTML-comment shape so the model treats it as
 * scratch — same trick the intuition-think and opening-recall blocks
 * use). When `synthesizeRecoveryMessages` sees the trailing row is
 * already a recovery row, it skips synthesis. That covers the case
 * where a previous session persisted recovery rows and a fresh read
 * rolls past them.
 */

import type { Message } from './supabase';
import type { OpenAIToolCall } from './tools/types';

/**
 * Marker placed in the content of every synthesized recovery row.
 * HTML-comment shape so it rides through to the model as inert
 * scratch (mirrors INTUITION_THINK_MARKER's reasoning - models trained
 * on web text treat HTML comments as noise). Detect a recovery row by
 * substring-matching this constant against the row's content.
 */
export const RECOVERY_MARKER = '<!-- nak:recovery -->';

/**
 * Visible body for the synthesized assistant turn that closes out an
 * interrupted exchange. Italicised so it reads as a meta-note rather
 * than a normal reply, and phrased in first person so the model picks
 * it up as its own prior statement on the next round.
 */
const RECOVERY_ASSISTANT_BODY =
  '*(The previous response was interrupted before I finished. Picking up from here.)*';

/**
 * Visible body for synthesized tool-result rows. Plain parens (not
 * markdown italic) because tool content goes onto the wire as a JSON
 * string in many providers' implementations, and italic underscores
 * inside that string have caused render glitches in the tool-call
 * card when read back.
 */
const RECOVERY_TOOL_BODY =
  '(tool execution was interrupted - no result available)';

function recoveryAssistantContent(): string {
  return `${RECOVERY_ASSISTANT_BODY}\n\n${RECOVERY_MARKER}`;
}

function recoveryToolContent(): string {
  return `${RECOVERY_TOOL_BODY} ${RECOVERY_MARKER}`;
}

/**
 * Detect whether a stored or synthesized row is a recovery row. Used
 * by `synthesizeRecoveryMessages` for idempotency, and available to
 * other readers that want to render or filter recovery rows
 * specially.
 */
export function isRecoveryMessage(m: Pick<Message, 'content'>): boolean {
  return typeof m.content === 'string' && m.content.includes(RECOVERY_MARKER);
}

/**
 * Build a synthetic assistant Message. `id` is a sentinel string so
 * the chat UI can key on it stably across re-renders within one
 * session; the persistence path replaces the row with the DB-issued
 * id when it writes. `created_at` is "now" - the row will sit at the
 * end of the timeline, which matches what the user sees.
 */
function makeRecoveryAssistant(threadId: string, idx: number): Message {
  return {
    id: `synthetic-recovery-asst-${idx}`,
    thread_id: threadId,
    role: 'assistant',
    content: recoveryAssistantContent(),
    created_at: new Date().toISOString(),
    synthetic: true,
  };
}

/**
 * Build a synthetic tool-result Message keyed to a specific
 * unanswered tool_call_id. Includes the original call's name so the
 * tool-card UI can render the call/result pair coherently and the
 * model sees which tool it was that didn't run.
 */
function makeRecoveryTool(
  threadId: string,
  call: OpenAIToolCall,
  idx: number
): Message {
  return {
    id: `synthetic-recovery-tool-${idx}-${call.id}`,
    thread_id: threadId,
    role: 'tool',
    content: recoveryToolContent(),
    created_at: new Date().toISOString(),
    tool_call_id: call.id,
    name: call.function.name,
    synthetic: true,
  };
}

/**
 * Inspect the tail of a message list and append recovery rows when
 * the trailing shape would be rejected by the provider. Pure: takes
 * an array, returns an array (the original array when no recovery is
 * needed - reference equality preserved so callers can short-circuit
 * on identity).
 *
 * The two trailing shapes that get repaired:
 *
 *   - Last row is `tool`. Walk back through trailing tool rows to
 *     find their `assistant`-with-tool_calls parent; synthesize
 *     tool-result rows for any of the parent's `tool_calls[]` whose
 *     id wasn't answered, then append a recovery assistant row.
 *
 *   - Last row is `assistant` with non-empty `tool_calls`. None of
 *     the calls are answered (no tool rows after); synthesize a
 *     tool-result row per call_id, then a recovery assistant.
 *
 * Anything else (last row is `user`, `assistant` without tool_calls,
 * `system`, or already a recovery row) is returned untouched.
 */
export function synthesizeRecoveryMessages(messages: Message[]): Message[] {
  if (messages.length === 0) return messages;
  const last = messages[messages.length - 1];

  // Idempotency: if the prior session already wrote a recovery row to
  // the DB and we're now reading it back, the shape is healed — don't
  // double-stack synthetic rows on top.
  if (isRecoveryMessage(last)) return messages;

  const threadId = last.thread_id;

  if (last.role === 'tool') {
    // Walk back across trailing tool rows to find which tool_call_ids
    // are already answered, and where the assistant-with-tool_calls
    // parent sits.
    let i = messages.length - 1;
    const answeredIds = new Set<string>();
    while (i >= 0 && messages[i].role === 'tool') {
      const tc = messages[i].tool_call_id;
      if (tc) answeredIds.add(tc);
      i--;
    }
    // i is now the first non-tool row scanning backward — the parent
    // assistant turn if the data is well-formed. If we ran off the
    // start of the array (no parent) just append the recovery
    // assistant; the provider tolerates a tool row without a paired
    // assistant if no further turns reference it.
    const recovery: Message[] = [];
    let synthIdx = 0;
    if (i >= 0) {
      const parent = messages[i];
      if (
        parent.role === 'assistant' &&
        parent.tool_calls &&
        parent.tool_calls.length > 0
      ) {
        for (const call of parent.tool_calls) {
          if (!answeredIds.has(call.id)) {
            recovery.push(makeRecoveryTool(threadId, call, synthIdx++));
          }
        }
      }
    }
    recovery.push(makeRecoveryAssistant(threadId, synthIdx));
    return [...messages, ...recovery];
  }

  if (
    last.role === 'assistant' &&
    last.tool_calls &&
    last.tool_calls.length > 0
  ) {
    // Trailing assistant-with-tool_calls; nothing answered any of the
    // calls. Synthesize one tool row per call, then the recovery
    // assistant.
    const recovery: Message[] = [];
    let synthIdx = 0;
    for (const call of last.tool_calls) {
      recovery.push(makeRecoveryTool(threadId, call, synthIdx++));
    }
    recovery.push(makeRecoveryAssistant(threadId, synthIdx));
    return [...messages, ...recovery];
  }

  return messages;
}

/**
 * Trim a slice of messages so the last row is "complete" - i.e. not a
 * trailing `tool` row and not an `assistant` with unanswered
 * tool_calls. Returns a fresh array (or the original when no trim is
 * needed). Counterpart to `synthesizeRecoveryMessages` for the
 * head-half of `condenseHistory`-style splits, where we'd rather drop
 * a partial turn than synthesize one (the head only needs to set up
 * the topic, not present a coherent finished exchange).
 *
 * Walks backward, dropping trailing `tool` rows and any preceding
 * `assistant` with tool_calls (which is now orphaned because we just
 * dropped its results). Stops at the first row that's a complete
 * `user`, `system`, or `assistant`-without-tool_calls.
 */
export function trimToCompleteTurn(messages: Message[]): Message[] {
  let end = messages.length;
  while (end > 0) {
    const m = messages[end - 1];
    if (m.role === 'tool') {
      end--;
      continue;
    }
    if (m.role === 'assistant' && m.tool_calls && m.tool_calls.length > 0) {
      end--;
      continue;
    }
    break;
  }
  if (end === messages.length) return messages;
  return messages.slice(0, end);
}

/**
 * Trim a slice of messages so the first row is the start of a fresh
 * round — i.e. a `user` or `system` message. Drops any leading
 * orphan `tool` rows or `assistant` rows that would otherwise begin
 * the slice mid-turn. Counterpart for the tail-half of a
 * `condenseHistory`-style split, where the slice can land partway
 * through an exchange.
 *
 * Returns the original array when no trim is needed.
 */
export function trimToFirstUserOrSystem(messages: Message[]): Message[] {
  let start = 0;
  while (start < messages.length) {
    const m = messages[start];
    if (m.role === 'user' || m.role === 'system') break;
    start++;
  }
  if (start === 0) return messages;
  return messages.slice(start);
}
