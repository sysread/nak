/**
 * Wiki-recall agent. Third sibling of RecallAgent (memories) and
 * ConversationRecallAgent (prior threads), one layer over: the
 * recall target is the user's WIKI - flat encyclopedic articles
 * ABOUT topics in their life, never auto-injected, only reachable
 * via `wiki_search`. Same run shape as the other two recall agents:
 * trim conversation to the last user turn, append the recall
 * instruction, run the headless tool-loop with a wiki_search-only
 * toolbox, parse the model's JSON output into a structured note.
 *
 * Why a third agent instead of overloading either of the existing
 * two: each surface searches a different table, needs a different
 * prompt (memory vs. conversation vs. wiki framing), and could pin
 * to a different model in the future. Keeping them parallel-but-
 * separate costs a little code duplication and buys clean A/B and
 * per-surface tuning.
 *
 * Imports directly from `../recall/agent` for the generic helpers
 * (`trimToLastUserTurn`, `trimToCharBudget`, `parseRecallOutput`,
 * `RecallNote`) rather than hoisting them to a shared module - they're
 * small, the shapes won't diverge, and avoiding another shared module
 * keeps the import graph flat.
 */
import type { Agent, AgentRunRequest, AgentRunResult } from '../types';
import type { SupabaseService, Message } from '../../supabase';
import type { VeniceClient, VeniceMessage, ResponseFormat } from '../../venice';
// Import the toolbox directly - same circular-import dodge that
// memory recall and conversation recall use. See
// `tools/wiki_recall_toolbox.ts` for the full explanation.
import { wikiRecallToolbox } from '../../tools/wiki_recall_toolbox';
import { runHeadlessToolLoop } from '../../tools/run';
import { sanitizeToolCallIdForWire, sanitizeToolCallsForWire } from '../../tools/wire';
import { agentModel } from '../../models';
import {
  trimToLastUserTurn,
  trimToCharBudget,
  parseRecallOutput,
  type RecallNote,
} from '../recall/agent';
import { buildWikiRecallPrompt } from './prompt';

export interface WikiRecallInput {
  /** Thread the agent is recalling for - the tool passes ctx.threadId. */
  threadId: string;
  /**
   * Optional topic hint from the main assistant. When set, appended
   * to the prompt so the agent biases its first `wiki_search` query
   * toward this phrase. A plain string; `undefined` / empty means
   * "no hint, infer from the conversation."
   */
  topic?: string | null;
}

export interface WikiRecallOutput {
  /** Parsed structured note. Always present, even on parse failure. */
  note: RecallNote;
  /** Raw model output before JSON parsing - preserved for debug logs. */
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
 * from RecallAgent and ConversationRecallAgent on purpose - the three
 * surfaces share the shape but not the imports, and a shared helper
 * would mean agents reach into chat-loop. Update all three in
 * lockstep if the shape changes.
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

/** Pinned response format - see RecallAgent header for the why. */
const WIKI_RECALL_RESPONSE_FORMAT: ResponseFormat = { type: 'json_object' };

export class WikiRecallAgent
  implements Agent<WikiRecallInput, WikiRecallOutput>
{
  readonly name = 'wiki-recall';
  readonly model: string;
  readonly toolbox = wikiRecallToolbox;

  constructor(
    private venice: VeniceClient,
    private supabase: SupabaseService,
    /**
     * Optional model override for tests / future A/B. Defaults to
     * the registry's `wikiRecall` slot (see AGENT_MODELS in
     * src/lib/models).
     */
    modelId?: string
  ) {
    this.model = modelId ?? agentModel('wikiRecall').id;
  }

  async run(
    req: AgentRunRequest<WikiRecallInput>
  ): Promise<AgentRunResult<WikiRecallOutput>> {
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
        // No user turn in the thread - nothing to recall for. Skip the
        // Venice round-trip; same short-circuit the other recall
        // agents use.
        return {
          output: { note: { kind: 'none' }, rawText: '', inputMessageCount: 0 },
          toolCalls: 0,
          stoppedReason: 'done',
        };
      }

      const convo: VeniceMessage[] = slice.map(messageToVenice);
      convo.push({
        role: 'user',
        content: buildWikiRecallPrompt(req.input.topic ?? null),
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
          // Forward the caller's depth; runHeadlessToolLoop bumps and
          // enforces MAX_AGENT_DEPTH internally.
          depth: req.depth,
        },
        signal,
        responseFormat: WIKI_RECALL_RESPONSE_FORMAT,
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
