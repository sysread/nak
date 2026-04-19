/**
 * Memory-recall agent. Runs one recall pass against a live
 * conversation: fetches the thread's messages, trims back to the last
 * user turn (dropping any in-flight assistant tool_calls row the
 * chat-loop just persisted on its way into the `memory_recall` tool),
 * appends the recall instruction as a final user turn, and runs the
 * headless tool-call loop with a memory_search-only toolbox. The
 * model settles on a structured JSON response — either
 * `{kind:'none'}` or `{kind:'note', note:'…'}` — which we parse and
 * hand back as the agent's output.
 *
 * Contrast with ReflectionAgent:
 *
 *   - Reflection runs in a background worker after a thread settles;
 *     recall runs inline, triggered by the `memory_recall` tool
 *     inside the main chat loop. The Agent interface doesn't care
 *     which — both return an AgentRunResult.
 *   - Reflection's toolbox can mutate memories (create / update /
 *     invalidate). Recall's toolbox is read-only (memory_search) so a
 *     bug in the recall prompt can't scribble over long-term memory.
 *   - Reflection discards its final text (side effects = tool calls);
 *     recall's final text IS the output, and we parse it into the
 *     typed RecallOutput shape.
 *
 * The agent does NOT persist anything. The tool that called it is
 * responsible for turning the structured note into a tool-result
 * message the main chat loop feeds back into the next round.
 */
import type { Agent, AgentRunRequest, AgentRunResult } from '../types';
import type { SupabaseService, Message } from '../../supabase';
import type { VeniceClient, VeniceMessage, ResponseFormat } from '../../venice';
// Import directly from the toolbox file rather than through
// `tools/index.ts` — memory_recall sits in that barrel and pulls
// RecallAgent back in, so an index-level import here would be a
// circular chain: agents/recall → tools → memory_recall → agents/recall.
import { recallToolbox } from '../../tools/recall_toolbox';
import { runHeadlessToolLoop } from '../../tools/run';
import { VENICE_RECALL_MODEL } from '../../models';
import { RECALL_PROMPT } from './prompt';

export interface RecallInput {
  /** Conversation to recall against — the tool passes its ctx.threadId. */
  threadId: string;
}

/**
 * Discriminated union matching the JSON shape the model is asked to
 * emit. `kind:'none'` is the explicit empty signal — the caller
 * should inject nothing into the conversation. `kind:'note'` carries
 * a short first-person paragraph ready to be surfaced as a tool
 * result. Malformed or unparsable output collapses to
 * `{kind:'none', raw}` so the main model never sees a stringly-typed
 * agent failure.
 */
export type RecallNote =
  | { kind: 'none' }
  | { kind: 'note'; note: string };

export interface RecallOutput {
  /** Parsed structured note. Always present, even on parse failure. */
  note: RecallNote;
  /**
   * The raw final text from the model, before JSON parsing. Useful
   * for logs and for surfacing the model's output in a debug panel
   * when parsing failed — we don't want to lose "the model said X
   * and we threw it away" in silent fallthrough.
   */
  rawText: string;
  /**
   * Number of messages fed to the model on round 1. Cheap
   * observability; a recall over a 50-turn thread is a different
   * cost profile than one over 3 turns.
   */
  inputMessageCount: number;
}

/**
 * Project a stored Message row onto the OpenAI wire format.
 * Duplicated from ReflectionAgent (and chat-loop) on purpose — the
 * three surfaces share the shape but not the imports, and a shared
 * helper would mean agents have to reach into the chat-loop module.
 * The projection must stay in lockstep across all three copies.
 */
function messageToVenice(m: Message): VeniceMessage {
  if (m.role === 'tool') {
    return {
      role: 'tool',
      content: m.content,
      tool_call_id: m.tool_call_id ?? undefined,
      name: m.name ?? undefined,
    };
  }
  const out: VeniceMessage = { role: m.role, content: m.content };
  if (m.role === 'assistant' && m.tool_calls && m.tool_calls.length > 0) {
    out.tool_calls = m.tool_calls;
  }
  return out;
}

/**
 * Trim the conversation so it ends cleanly for the recall model.
 *
 * The `memory_recall` tool is invoked mid-round: by the time it
 * runs, the chat-loop has already persisted the assistant row
 * carrying the memory_recall tool_call, but NOT the matching
 * tool-result row (that's what the tool is still computing). Sending
 * that partial state to the recall model is an API error — OpenAI
 * rejects a history where an assistant tool_calls row isn't followed
 * by a tool-result row per call.
 *
 * Simplest safe trim: walk back from the end until we hit a user
 * turn. Anything past that user turn belongs to the in-flight round
 * and isn't coherent context for recall anyway. An empty result
 * means the conversation had no user turn — caller treats that as
 * "nothing to recall for."
 */
export function trimToLastUserTurn(messages: Message[]): Message[] {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'user') return messages.slice(0, i + 1);
  }
  return [];
}

/**
 * Parse the model's final text into a RecallNote. Tolerant: we strip
 * markdown code fences first because prompt-only JSON discipline
 * sometimes leaks ```json wrappers, and we fall through to the empty
 * signal on any parse failure rather than throwing — the main model
 * should never see a recall agent crash as a tool error; it should
 * see "nothing to inject" and move on.
 */
export function parseRecallOutput(text: string): RecallNote {
  const trimmed = text.trim();
  if (trimmed.length === 0) return { kind: 'none' };
  // Strip a ```json … ``` or ``` … ``` wrapper if the model added one.
  const fence = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
  const payload = fence ? fence[1] : trimmed;
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch {
    return { kind: 'none' };
  }
  if (!parsed || typeof parsed !== 'object') return { kind: 'none' };
  const obj = parsed as Record<string, unknown>;
  if (obj.kind === 'none') return { kind: 'none' };
  if (obj.kind === 'note' && typeof obj.note === 'string' && obj.note.trim().length > 0) {
    return { kind: 'note', note: obj.note.trim() };
  }
  return { kind: 'none' };
}

/**
 * Response format pinned on every round — json_object is the broadly
 * supported variant across OpenAI-compatible providers. We pair it
 * with a schema spelled out in the prompt because json_object alone
 * means "any valid JSON," not "JSON matching this shape."
 */
const RECALL_RESPONSE_FORMAT: ResponseFormat = { type: 'json_object' };

export class RecallAgent implements Agent<RecallInput, RecallOutput> {
  readonly name = 'recall';
  readonly model: string;
  readonly toolbox = recallToolbox;

  constructor(
    private venice: VeniceClient,
    private supabase: SupabaseService,
    /**
     * Optional model override, mirroring ReflectionAgent. Defaults to
     * `VENICE_RECALL_MODEL` (tracks the fast tier). Tests pin a
     * specific id; a future A/B could run recall on two models
     * side-by-side against the same thread.
     */
    modelId?: string
  ) {
    this.model = modelId ?? VENICE_RECALL_MODEL;
  }

  async run(
    req: AgentRunRequest<RecallInput>
  ): Promise<AgentRunResult<RecallOutput>> {
    const signal = req.signal ?? new AbortController().signal;

    if (signal.aborted) {
      return {
        output: { note: { kind: 'none' }, rawText: '', inputMessageCount: 0 },
        toolCalls: 0,
        stoppedReason: 'aborted',
      };
    }

    try {
      const allMessages = await this.supabase.listMessages(req.input.threadId);
      const slice = trimToLastUserTurn(allMessages);

      if (slice.length === 0) {
        // No user turn in the thread — nothing to recall for.
        return {
          output: { note: { kind: 'none' }, rawText: '', inputMessageCount: 0 },
          toolCalls: 0,
          stoppedReason: 'done',
        };
      }

      const convo: VeniceMessage[] = slice.map(messageToVenice);
      // Recall instruction as the final user turn. Matches the
      // reflection agent's "switch modes" idiom — a user turn after a
      // long assistant response reads as "now do this instead" on
      // every model that's been through instruction-tuning.
      convo.push({ role: 'user', content: RECALL_PROMPT });

      const result = await runHeadlessToolLoop({
        venice: this.venice,
        model: this.model,
        messages: convo,
        toolbox: this.toolbox,
        toolCtx: {
          supabase: this.supabase,
          venice: this.venice,
          userId: req.userId,
          threadId: req.input.threadId,
        },
        signal,
        responseFormat: RECALL_RESPONSE_FORMAT,
      });

      const note = parseRecallOutput(result.finalText);

      return {
        output: {
          note,
          rawText: result.finalText,
          inputMessageCount: slice.length,
        },
        toolCalls: result.toolCalls,
        stoppedReason: signal.aborted ? 'aborted' : 'done',
      };
    } catch (err) {
      return {
        output: { note: { kind: 'none' }, rawText: '', inputMessageCount: 0 },
        toolCalls: 0,
        stoppedReason: 'error',
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }
}
