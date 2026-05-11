/**
 * Journal-recall agent. Fourth sibling of RecallAgent (memories),
 * ConversationRecallAgent (prior threads), and WikiRecallAgent
 * (encyclopedic articles), one layer over: the recall target is the
 * user's daily JOURNAL - dated reflective entries summarising what
 * they processed in a given day. Same run shape as the other recall
 * agents: trim conversation to the last user turn, append the recall
 * instruction, run the headless tool-loop with a journal-search-only
 * toolbox, parse the model's JSON output into a structured note.
 *
 * Why a fourth agent: each surface searches a different table, needs
 * a different prompt (memory vs. conversation vs. wiki vs. journal
 * framing), and could pin to a different model in the future. The
 * journal in particular wants different framing - it's the right
 * surface for reflective topics and the wrong surface for operational
 * ones, and the prompt reflects that.
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
// Import the toolbox directly - same circular-import dodge that the
// other recall agents use. See `tools/journal_recall_toolbox.ts` for
// the full explanation.
import { journalRecallToolbox } from '../../tools/journal_recall_toolbox';
import { runHeadlessToolLoop } from '../../tools/run';
import { sanitizeToolCallIdForWire, sanitizeToolCallsForWire } from '../../tools/wire';
import { agentModel } from '../../models';
import {
  trimToLastUserTurn,
  trimToCharBudget,
  parseRecallOutput,
  type RecallNote,
} from '../recall/agent';
import { buildJournalRecallPrompt } from './prompt';

export interface JournalRecallInput {
  /** Thread the agent is recalling for - the tool passes ctx.threadId. */
  threadId: string;
  /**
   * Optional topic hint from the main assistant. When set, appended
   * to the prompt so the agent biases its first `journal_search`
   * query toward this phrase. A plain string; `undefined` / empty
   * means "no hint, infer from the conversation."
   */
  topic?: string | null;
}

export interface JournalRecallOutput {
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
 * from the sibling recall agents on purpose - the four surfaces share
 * the shape but not the imports, and a shared helper would mean agents
 * reach into chat-loop. Update all four in lockstep if the shape
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

/** Pinned response format - see RecallAgent header for the why. */
const JOURNAL_RECALL_RESPONSE_FORMAT: ResponseFormat = { type: 'json_object' };

export class JournalRecallAgent
  implements Agent<JournalRecallInput, JournalRecallOutput>
{
  readonly name = 'journal-recall';
  readonly model: string;
  readonly toolbox = journalRecallToolbox;

  constructor(
    private venice: VeniceClient,
    private supabase: SupabaseService,
    /**
     * Optional model override for tests / future A/B. Defaults to
     * the registry's `journalRecall` slot (see AGENT_MODELS in
     * src/lib/models).
     */
    modelId?: string
  ) {
    this.model = modelId ?? agentModel('journalRecall').id;
  }

  async run(
    req: AgentRunRequest<JournalRecallInput>
  ): Promise<AgentRunResult<JournalRecallOutput>> {
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
        content: buildJournalRecallPrompt(req.input.topic ?? null),
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
        responseFormat: JOURNAL_RECALL_RESPONSE_FORMAT,
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
