/**
 * Conversation-recall agent. Mirror of RecallAgent, but the target of
 * recall is prior CONVERSATIONS (threads) rather than saved memories.
 * Same run shape, same trim/parse/json_object discipline, same
 * error-collapse-to-none semantics — the only real differences are
 * the toolbox (read-only `conversation_search` instead of
 * `memory_search`) and the prompt.
 *
 * Why a second agent instead of overloading RecallAgent: the two
 * surfaces search different tables, need different prompts (memory vs.
 * conversation framing), and could pin to different models in the
 * future. Keeping them parallel-but-separate costs a little code
 * duplication and buys clean A/B and per-surface tuning.
 *
 * Imports directly from `../recall/agent` for the three generic
 * helpers (`messageToVenice`, `trimToLastUserTurn`, `parseRecallOutput`)
 * rather than hoisting them to a shared module — they're small, the
 * shapes won't diverge, and avoiding another shared module keeps the
 * import graph flat.
 */
import type { Agent, AgentRunRequest, AgentRunResult } from '../types';
import type { SupabaseService, Message } from '../../supabase';
import type { VeniceClient, VeniceMessage, ResponseFormat } from '../../venice';
// Import the toolbox directly — same circular-import dodge that
// memory recall uses. See `tools/conversation_recall_toolbox.ts` for
// the full explanation.
import { conversationRecallToolbox } from '../../tools/conversation_recall_toolbox';
import { runHeadlessToolLoop } from '../../tools/run';
import { sanitizeToolCallIdForWire, sanitizeToolCallsForWire } from '../../tools/wire';
import { VENICE_CONVERSATION_RECALL_MODEL } from '../../models';
import {
  trimToLastUserTurn,
  trimToCharBudget,
  parseRecallOutput,
  type RecallNote,
} from '../recall/agent';
import { buildConversationRecallPrompt } from './prompt';

export interface ConversationRecallInput {
  /** Thread the agent is recalling for — the tool passes ctx.threadId. */
  threadId: string;
  /**
   * Optional topic hint from the main assistant. When set, appended
   * to the prompt so the agent biases its first
   * `conversation_search` query toward this phrase. A plain string;
   * `undefined` / empty means "no hint, infer from the conversation."
   */
  topic?: string | null;
}

export interface ConversationRecallOutput {
  /** Parsed structured note. Always present, even on parse failure. */
  note: RecallNote;
  /** Raw model output before JSON parsing — preserved for debug logs. */
  rawText: string;
  /**
   * Number of messages fed to the model on round 1. A recall over a
   * 50-turn thread is a different cost profile than one over 3 turns;
   * keeping this visible at the result layer is cheap observability.
   */
  inputMessageCount: number;
}

/**
 * Project a stored Message row onto the Venice wire format. Duplicated
 * from RecallAgent (and chat-loop) on purpose — the surfaces share the
 * shape but not the imports, and a shared helper would mean agents
 * reach into chat-loop. Update all three in lockstep if the shape
 * changes.
 *
 * The arguments-string sanitiser is shared via tools/wire.ts - see
 * that module for the rationale.
 */
function messageToVenice(m: Message): VeniceMessage {
  if (m.role === 'tool') {
    return {
      role: 'tool',
      content: m.content,
      tool_call_id:
        m.tool_call_id != null
          ? sanitizeToolCallIdForWire(m.tool_call_id)
          : undefined,
      name: m.name ?? undefined,
    };
  }
  const out: VeniceMessage = { role: m.role, content: m.content };
  if (m.role === 'assistant' && m.tool_calls && m.tool_calls.length > 0) {
    out.tool_calls = sanitizeToolCallsForWire(m.tool_calls);
  }
  return out;
}

/** Pinned response format — see RecallAgent header for the why. */
const CONVERSATION_RECALL_RESPONSE_FORMAT: ResponseFormat = { type: 'json_object' };

export class ConversationRecallAgent
  implements Agent<ConversationRecallInput, ConversationRecallOutput>
{
  readonly name = 'conversation-recall';
  readonly model: string;
  readonly toolbox = conversationRecallToolbox;

  constructor(
    private venice: VeniceClient,
    private supabase: SupabaseService,
    /**
     * Optional model override for tests / future A/B. Defaults to
     * `VENICE_CONVERSATION_RECALL_MODEL` (tracks the fast tier).
     */
    modelId?: string
  ) {
    this.model = modelId ?? VENICE_CONVERSATION_RECALL_MODEL;
  }

  async run(
    req: AgentRunRequest<ConversationRecallInput>
  ): Promise<AgentRunResult<ConversationRecallOutput>> {
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
      const slice = trimToCharBudget(trimToLastUserTurn(allMessages));

      if (slice.length === 0) {
        // No user turn in the thread — nothing to recall for. Skip the
        // Venice round-trip; same short-circuit RecallAgent uses.
        return {
          output: { note: { kind: 'none' }, rawText: '', inputMessageCount: 0 },
          toolCalls: 0,
          stoppedReason: 'done',
        };
      }

      const convo: VeniceMessage[] = slice.map(messageToVenice);
      convo.push({
        role: 'user',
        content: buildConversationRecallPrompt(req.input.topic ?? null),
      });

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
          // Forward the caller's depth; runHeadlessToolLoop bumps
          // and enforces MAX_AGENT_DEPTH internally.
          depth: req.depth,
        },
        signal,
        responseFormat: CONVERSATION_RECALL_RESPONSE_FORMAT,
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
