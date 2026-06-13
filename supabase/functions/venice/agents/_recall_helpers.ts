// Recall-agent helpers shared across memory_recall, conversation_recall,
// wiki_recall, and context (which composes the three). Match the
// browser-side implementations in src/lib/agents/recall/agent.ts -
// trimToLastUserTurn, trimToCharBudget, messageToVenice,
// parseRecallOutput - so the function and browser paths produce the
// same model context and parse the same response shapes.

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
  if (m.role === 'tool') {
    return {
      role: 'tool',
      content: m.content,
      ...(m.tool_call_id ? { tool_call_id: m.tool_call_id } : {}),
      ...(m.name ? { name: m.name } : {}),
    };
  }
  const out: VeniceWireMessage = { role: m.role, content: m.content };
  if (m.role === 'assistant' && Array.isArray(m.tool_calls) && m.tool_calls.length > 0) {
    out.tool_calls = m.tool_calls as VeniceWireMessage['tool_calls'];
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
 * Load the thread's messages from Supabase, trim to last user turn,
 * trim to char budget. Used by every recall agent as the first step
 * before composing the prompt + running the headless tool loop.
 */
export async function loadThreadSlice(
  adminClient: { from: (table: string) => unknown },
  threadId: string,
): Promise<StoredMessage[]> {
  type SupabaseQuery = {
    select: (cols: string) => SupabaseQuery;
    eq: (col: string, val: unknown) => SupabaseQuery;
    order: (col: string, opts: { ascending: boolean }) => Promise<{
      data: StoredMessage[] | null;
      error: { message: string } | null;
    }>;
  };
  const q = adminClient.from('messages') as SupabaseQuery;
  const { data, error } = await q
    .select('id, role, content, tool_calls, tool_call_id, name')
    .eq('thread_id', threadId)
    .order('created_at', { ascending: true });
  if (error) throw new Error(`listMessages failed: ${error.message}`);
  return trimToCharBudget(trimToLastUserTurn((data ?? []) as StoredMessage[]));
}
