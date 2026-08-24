/**
 * Conversation-recovery synthesis. When a thread's persisted history
 * lands in a wire-format-invalid shape — typically because a tool-using
 * exchange was interrupted before the assistant could reply to the
 * tool result — readers (the chat UI, the summary worker, the wiki
 * worker, the reflection worker, the recall agents) would otherwise
 * hand the broken sequence to the provider and get a 400 back. Two
 * provider errors drove this module:
 *
 *   Venice HTTP 400: Unexpected role 'user' after role 'tool'
 *   Venice HTTP 400: Not the same number of function calls and responses
 *
 * Three broken shapes show up in practice:
 *
 *   1. Trailing tool-result row(s) with no follow-up assistant. The
 *      provider expects an assistant turn after a tool-result fan-in.
 *      Adding the user's next prompt produces "user after tool".
 *
 *   2. Trailing assistant-with-tool_calls whose tool results never
 *      landed (one or more, or all). The provider's stricter rule
 *      here is "every tool_calls[].id MUST be answered by a matching
 *      tool row before any non-tool message follows" - the fan-in
 *      count must match.
 *
 *   3. Mid-conversation partial fan-in - an `asst_with_tool_calls`
 *      whose tool block is short by one or more results, followed
 *      eventually by another user/assistant turn. Same fan-in
 *      mismatch error as (2), just buried in the middle of the
 *      transcript instead of at the end. This shape arises when the
 *      chat-loop crashed (or the device went offline) between
 *      persisting some-but-not-all tool rows and persisting the
 *      assistant follow-up; the next user send creates a turn that
 *      hangs off a still-broken history.
 *
 * Every broken shape is repaired by walking the message list,
 * filling in synthetic tool-result rows for unanswered tool_call_ids,
 * and inserting a recovery assistant turn wherever the resulting tool
 * block would otherwise be followed by a non-assistant message (or
 * end of conversation). The synthesized rows carry a `synthetic: true`
 * flag so the chat-loop's persistence path can write them to the DB
 * on the next user send, healing the thread permanently.
 *
 * Idempotency: every synthesized row carries the `RECOVERY_MARKER`
 * inside its content (HTML-comment shape so the model treats it as
 * scratch — same trick the intuition-think and opening-recall blocks
 * use). The walking algorithm is naturally idempotent: a previously-
 * healed conversation walks to a fully-resolved tool block on every
 * pass, so no new rows get appended. Re-running synthesize on its own
 * output returns the same array by reference.
 *
 * False-positive posture: the walk only synthesizes when an
 * `asst_with_tool_calls` has tool_call_ids that do NOT appear in the
 * immediately-following consecutive tool block. A complete fan-in -
 * including a complete fan-in followed by a user turn (which IS
 * unusual but technically wire-valid as long as a recovery assistant
 * goes between the tool block and the user) - never gets phantom
 * tool rows added. The trickier case "complete fan-in followed by
 * user, no assistant in between" DOES get a recovery assistant
 * inserted, because `tool -> user` is itself a wire violation.
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
 * by `synthesizeRecoveryMessages` for fast-path no-ops, and available
 * to other readers that want to render or filter recovery rows
 * specially.
 */
export function isRecoveryMessage(m: Pick<Message, 'content'>): boolean {
  return typeof m.content === 'string' && m.content.includes(RECOVERY_MARKER);
}

/**
 * Build a synthetic assistant Message. `id` is a sentinel string so
 * the chat UI can key on it stably across re-renders within one
 * session; the persistence path replaces the row with the DB-issued
 * id when it writes. `created_at` is honestly "now" (when the heal
 * happened); transcript placement comes from `position`, which starts
 * null here and is assigned by the synthesizer's placement pass once
 * the row's neighbors are known.
 */
function makeRecoveryAssistant(threadId: string, idx: number): Message {
  return {
    id: `synthetic-recovery-asst-${idx}`,
    thread_id: threadId,
    role: 'assistant',
    content: recoveryAssistantContent(),
    created_at: new Date().toISOString(),
    position: null,
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
    position: null,
    tool_call_id: call.id,
    name: call.function.name,
    synthetic: true,
  };
}

/**
 * Give every synthetic row a transcript position: consecutive
 * synthetics in a gap get evenly-spaced fractions strictly between
 * the previous real row's position and the next real row's (or the
 * previous position plus one when the gap is at the end of the
 * transcript). Fractions keep the healed rows in their gap without
 * touching any real row, and stay below the next integer so the
 * insert trigger's tail assignment (floor(max)+1) can never collide
 * with them.
 *
 * A synthetic is never first in the list - every synthesis branch
 * pushes at least one real row (the tool block being healed) before
 * it - so the previous-real lookup always lands; the 0 fallback is
 * pure defense. A null neighbor position (possible only for rows
 * inserted in a schema apply's backfill-to-trigger window) falls back
 * the same way rather than producing NaN positions.
 *
 * Mutates the synthetic rows in place; only called on freshly-built
 * synthetics inside this module.
 */
function assignSyntheticPositions(rows: Message[]): void {
  let i = 0;
  while (i < rows.length) {
    if (!rows[i].synthetic) {
      i++;
      continue;
    }
    let j = i;
    while (j < rows.length && rows[j].synthetic) j++;
    const prev = i > 0 ? (rows[i - 1].position ?? 0) : 0;
    const next = j < rows.length ? (rows[j].position ?? prev + 1) : prev + 1;
    const count = j - i;
    for (let k = 0; k < count; k++) {
      rows[i + k].position = prev + ((next - prev) * (k + 1)) / (count + 1);
    }
    i = j;
  }
}

/**
 * Walk the message list and append recovery rows wherever the wire
 * shape would be rejected by the provider. Pure: takes an array,
 * returns an array (the original array when no recovery is needed -
 * reference equality preserved so callers can short-circuit on
 * identity).
 *
 * Algorithm:
 *
 *   For each `assistant` row whose `tool_calls` array is non-empty:
 *     - Read the immediately-following consecutive `tool` rows and
 *       collect their `tool_call_id`s as the "answered" set.
 *     - For each `tool_calls[].id` not in the answered set, append a
 *       synthetic tool-result row right after the existing tool
 *       block.
 *     - Inspect the next non-tool row (or EOF). If the tool block
 *       has any content AND the next row isn't an assistant, append
 *       a synthetic recovery assistant. This handles:
 *         * EOF after the tool block (no follow-up assistant landed).
 *         * `tool -> user` mid-conversation (the next user turn
 *           hanging off a still-incomplete tool block).
 *
 *   For each `tool` row not anchored to an `assistant` parent (an
 *   orphan run that the chat-loop wouldn't normally write but might
 *   appear from corrupted state):
 *     - Walk past consecutive orphan tool rows.
 *     - If the next row isn't an assistant, append a recovery
 *       assistant. This preserves the previous module's
 *       end-of-conversation behaviour for the trailing-tool case.
 *
 * Idempotency: a previously-healed conversation walks to fully-
 * resolved tool blocks on every pass, so the missing-set is empty
 * and the next non-tool row is the existing recovery assistant - no
 * synthesis fires. Reference equality is preserved on the no-op
 * pass.
 */
export function synthesizeRecoveryMessages(messages: Message[]): Message[] {
  if (messages.length === 0) return messages;

  const threadId = messages[0].thread_id;
  const result: Message[] = [];
  let synthIdx = 0;
  let modified = false;

  let i = 0;
  while (i < messages.length) {
    const m = messages[i];

    if (m.role === 'assistant' && m.tool_calls && m.tool_calls.length > 0) {
      // Asst-with-tool_calls: process the tool block that follows it.
      result.push(m);
      const answered = new Set<string>();
      let j = i + 1;
      while (j < messages.length && messages[j].role === 'tool') {
        const tcid = messages[j].tool_call_id;
        if (tcid) answered.add(tcid);
        result.push(messages[j]);
        j++;
      }
      const missing = m.tool_calls.filter((c) => !answered.has(c.id));
      for (const call of missing) {
        result.push(makeRecoveryTool(threadId, call, synthIdx++));
        modified = true;
      }
      const toolBlockLength = j - i - 1 + missing.length;
      const next = j < messages.length ? messages[j] : null;
      // Only inject a recovery assistant when the tool block has any
      // content. An asst with empty tool_calls (length-zero array)
      // never reaches this branch, but a tool_calls list whose every
      // id was already answered AND that's followed by an assistant
      // is a complete normal turn and gets nothing added.
      if (
        toolBlockLength > 0 &&
        (next === null || next.role !== 'assistant')
      ) {
        result.push(makeRecoveryAssistant(threadId, synthIdx++));
        modified = true;
      }
      i = j;
      continue;
    }

    if (m.role === 'tool') {
      // Orphan tool run (no asst_with_tool_calls anchor before it).
      // Chat-loop wouldn't normally write this; treat it
      // conservatively - keep the rows, but make sure the wire
      // shape after the run is valid. Specifically: a `tool -> user`
      // or a `tool -> EOF` transition needs a recovery assistant in
      // between.
      let j = i;
      while (j < messages.length && messages[j].role === 'tool') {
        result.push(messages[j]);
        j++;
      }
      const next = j < messages.length ? messages[j] : null;
      if (next === null || next.role !== 'assistant') {
        result.push(makeRecoveryAssistant(threadId, synthIdx++));
        modified = true;
      }
      i = j;
      continue;
    }

    result.push(m);
    i++;
  }

  if (!modified) return messages;
  assignSyntheticPositions(result);
  return result;
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

