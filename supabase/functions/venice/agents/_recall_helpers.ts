// Recall-agent helpers shared across memory_recall, conversation_recall,
// wiki_recall, and context (which composes the three): transcript
// loading + trimming, the Venice wire projection, and recall-output
// parsing. The wire projection mirrors the browser's messageToVenice
// in src/lib/tools/wire.ts so both paths hand models the same shape.

import {
  type OpenAIToolCall,
  sanitizeToolCallIdForWire,
  sanitizeToolCallsForWire,
  sanitizeToolNameForWire,
} from './_wire.ts';

export interface StoredMessage {
  id: string;
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string;
  tool_calls: unknown[] | null;
  tool_call_id: string | null;
  name: string | null;
}

export interface VeniceWireMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  tool_call_id?: string;
  name?: string;
  tool_calls?: Array<{
    id: string;
    type: 'function';
    function: { name: string; arguments: string };
  }>;
}

// ~50k tokens at 4 chars/token - well under deepseek-v4-flash's 1M
// window (the recall models) while covering long threads. Same budget
// the browser uses.
export const MAX_RECALL_CHARS = 200_000;

/**
 * Trim the conversation so it ends cleanly for the recall model.
 * memory_recall / conversation_recall / wiki_recall are invoked mid-
 * round: by the time they run the orchestrator has already persisted
 * the assistant row carrying the recall tool_call, but NOT the
 * matching tool-result row (that's what the tool is still computing).
 * Sending that partial state to the recall model is an API error -
 * OpenAI rejects a history where an assistant tool_calls row isn't
 * followed by a tool-result row per call.
 *
 * Simplest safe trim: walk back from the end until we hit a user
 * turn. Anything past that user turn belongs to the in-flight round
 * and isn't coherent context for recall anyway.
 */
export function trimToLastUserTurn(messages: StoredMessage[]): StoredMessage[] {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (messages[i].role === 'user') return messages.slice(0, i + 1);
  }
  return [];
}

/**
 * Trim a message list to fit within a character budget, keeping the
 * most recent messages. Iterates from the end backward, accumulating
 * character counts (content + tool_calls JSON), and drops everything
 * older than what fits. Always keeps at least the last message - the
 * final user turn from trimToLastUserTurn - even if it alone exceeds
 * the budget; recall needs something to work with.
 */
export function trimToCharBudget(
  messages: StoredMessage[],
  budget = MAX_RECALL_CHARS,
): StoredMessage[] {
  if (messages.length === 0) return [];
  let chars = 0;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const m = messages[i];
    chars +=
      (m.content?.length ?? 0) +
      (m.tool_calls ? JSON.stringify(m.tool_calls).length : 0);
    if (chars > budget && i < messages.length - 1) {
      return messages.slice(i + 1);
    }
  }
  return messages;
}

/**
 * Project a stored Message row onto the Venice wire format. tool_calls
 * are forwarded only when present + non-empty; tool rows carry their
 * tool_call_id + name; assistant rows without tool calls reduce to
 * {role, content}.
 */
export function messageToVenice(m: StoredMessage): VeniceWireMessage {
  // Ids, names, and argument blobs all go through the _wire
  // sanitizers: replayed transcripts carry whatever the original turn
  // persisted, including MCP tool names (`mcp:<id>:<tool>`) whose
  // colons strict backends 400 on when no tools array declares them,
  // and tool-call ids some backends reject by length/alphabet. The
  // sanitizers are idempotent and deterministic, so the assistant
  // row's call and the paired tool row land at matching values.
  if (m.role === 'tool') {
    return {
      role: 'tool',
      content: m.content,
      ...(m.tool_call_id
        ? { tool_call_id: sanitizeToolCallIdForWire(m.tool_call_id) }
        : {}),
      ...(m.name ? { name: sanitizeToolNameForWire(m.name) } : {}),
    };
  }
  const out: VeniceWireMessage = { role: m.role, content: m.content };
  if (m.role === 'assistant' && Array.isArray(m.tool_calls) && m.tool_calls.length > 0) {
    out.tool_calls = sanitizeToolCallsForWire(
      m.tool_calls as OpenAIToolCall[],
    ) as VeniceWireMessage['tool_calls'];
  }
  return out;
}

export type RecallNote =
  | { kind: 'none'; reason?: string }
  | { kind: 'note'; note: string };

/**
 * Parse the recall agent's final text into a RecallNote. Tolerant:
 * strips markdown code fences first because prompt-only JSON
 * discipline sometimes leaks ```json wrappers, and falls through to
 * the empty signal on any parse failure rather than throwing - the
 * main model should never see a recall agent crash as a tool error;
 * it should see "nothing to inject" and move on.
 */
export function parseRecallOutput(text: string): RecallNote {
  const trimmed = text.trim();
  if (trimmed.length === 0) {
    return { kind: 'none', reason: 'empty model output' };
  }
  const fence = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
  const payload = fence ? fence[1] : trimmed;
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch {
    return { kind: 'none', reason: 'JSON parse failed' };
  }
  if (!parsed || typeof parsed !== 'object') {
    return { kind: 'none', reason: 'response was not a JSON object' };
  }
  const obj = parsed as Record<string, unknown>;
  if (obj.kind === 'none') {
    const reason =
      typeof obj.reason === 'string' && obj.reason.trim().length > 0
        ? obj.reason.trim()
        : undefined;
    return reason ? { kind: 'none', reason } : { kind: 'none' };
  }
  if (
    obj.kind === 'note' &&
    typeof obj.note === 'string' &&
    obj.note.trim().length > 0
  ) {
    return { kind: 'note', note: obj.note.trim() };
  }
  return { kind: 'none', reason: 'response did not match expected schema' };
}

/**
 * Single-line preview of free text for log breadcrumbs: collapse
 * whitespace and cap the length so a long user turn or derived query
 * doesn't flood the drawer entry it rides on.
 */
export function logPreview(text: string, max = 120): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length <= max ? flat : flat.slice(0, max) + '...';
}

/**
 * Load the thread's transcript from Supabase, trim to last user turn,
 * trim to char budget. Used by every recall agent as the first step
 * before composing the prompt + running the headless tool loop.
 *
 * Reads via the thread_transcript resolver, which folds in rows
 * inherited from fork ancestors (in transcript order - the function's
 * contract; never re-sort by position, which restarts per segment)
 * and degenerates to the plain per-thread query when the thread has
 * no fork ancestry.
 */
export async function loadThreadSlice(
  adminClient: { rpc: (fn: string, args: Record<string, unknown>) => unknown },
  threadId: string,
): Promise<StoredMessage[]> {
  type SupabaseRpc = {
    select: (cols: string) => Promise<{
      data: StoredMessage[] | null;
      error: { message: string } | null;
    }>;
  };
  const q = adminClient.rpc('thread_transcript', {
    p_thread_id: threadId,
  }) as SupabaseRpc;
  const { data, error } = await q.select(
    'id, role, content, tool_calls, tool_call_id, name',
  );
  if (error) throw new Error(`listMessages failed: ${error.message}`);
  return trimToCharBudget(trimToLastUserTurn((data ?? []) as StoredMessage[]));
}
