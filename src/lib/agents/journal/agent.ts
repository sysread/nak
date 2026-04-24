/**
 * Journaling agent for the Reflections feature. One run = one pass
 * over a completed conversation: fetch the thread's messages up to
 * the claimed terminal assistant message, read today's existing
 * automatic entry (so the prompt can tell the agent to extend rather
 * than duplicate), and run the headless tool-call loop with
 * `journalAgentToolbox`.
 *
 * Mirrors `../reflection/agent.ts` in structure but diverges in three
 * ways:
 *
 *   - Model + reasoning: runs on MODELS.balanced.id with
 *     reasoning_effort='medium' because "parse the emotional arc of
 *     a conversation and decide how to merge it into today's entry"
 *     is genuinely harder than "extract factual memories" and a
 *     lighter model regressed on nuance in review.
 *   - Prompt: custom `buildJournalPrompt` includes today's entry
 *     (when present) and instructs the agent to extend in place.
 *   - Toolbox: only `journal_upsert`. Read/search/delete are for the
 *     user-facing chat; the agent has the full context it needs.
 *
 * Does NOT touch leases, claims, or the thread-marking RPC - those
 * live in `./loop.ts` and `./worker.ts`. This class is pure logic.
 */
import type { Agent, AgentRunRequest, AgentRunResult } from '../types';
import type { SupabaseService, Message } from '../../supabase';
import type { VeniceClient, VeniceMessage } from '../../venice';
// Import from the leaf `./journal_agent_toolbox` rather than the barrel.
// The journaling agent runs inside a Web Worker and the tool barrel
// statically imports `research_docs` -> `src/lib/docs.ts` -> lazy glob,
// which is incompatible with Vite's default IIFE worker format. Same
// constraint as `../reflection/agent.ts`.
import { journalAgentToolbox } from '../../tools/journal_agent_toolbox';
import { runHeadlessToolLoop } from '../../tools/run';
import { sanitizeToolCallsForWire } from '../../tools/wire';
import { MODELS, type ReasoningEffort } from '../../models';
import { buildJournalPrompt } from './prompt';
import type { JournalInput, JournalOutput } from './types';

/**
 * Model the journaling agent runs against. Pinned to the balanced
 * tier because the task involves emotional-arc parsing and nuanced
 * merging with the existing entry. The fast tier regressed on
 * reframings and mood continuity in review; smart is overkill.
 *
 * Tracks the balanced tier automatically if the tier is retargeted,
 * which is usually what we want.
 */
export const VENICE_JOURNAL_MODEL = MODELS.balanced.id;

/**
 * Reasoning effort sent alongside the balanced-tier model. `medium` is
 * the intended band for this task - `low` produced flattened entries
 * that missed the user's reframings mid-conversation; `high` added
 * latency without a visible quality gain.
 */
export const JOURNAL_REASONING_EFFORT: ReasoningEffort = 'medium';

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
    // Sanitise the arguments JSON before it goes back on the wire. A
    // malformed arguments string from a previous round (e.g. unescaped
    // quotes inside the model-written `activity` sentence) is what
    // surfaces as the Venice 400 "Expecting ',' delimiter" error - and
    // it rides every replay until the row drops out of history. See
    // src/lib/tools/wire.ts for the full rationale.
    out.tool_calls = sanitizeToolCallsForWire(m.tool_calls);
  }
  return out;
}

export class JournalAgent implements Agent<JournalInput, JournalOutput> {
  readonly name = 'journal';
  readonly model: string;
  readonly toolbox = journalAgentToolbox;

  constructor(
    private venice: VeniceClient,
    private supabase: SupabaseService,
    /**
     * Optional override. Defaults to `VENICE_JOURNAL_MODEL` (balanced
     * tier). Useful for tests and for a future A/B where two
     * journaling models run against historical threads.
     */
    modelId?: string
  ) {
    this.model = modelId ?? VENICE_JOURNAL_MODEL;
  }

  async run(
    req: AgentRunRequest<JournalInput>
  ): Promise<AgentRunResult<JournalOutput>> {
    const signal = req.signal ?? new AbortController().signal;

    if (signal.aborted) {
      return {
        output: { finalText: '', inputMessageCount: 0, entryWritten: false },
        toolCalls: 0,
        stoppedReason: 'aborted',
      };
    }

    try {
      // Fetch the full thread and slice at the terminal message we
      // claimed against.
      const allMessages = await this.supabase.listMessages(req.input.threadId);
      const terminalIdx = allMessages.findIndex(
        (m) => m.id === req.input.terminalMsgId
      );
      const slice =
        terminalIdx >= 0 ? allMessages.slice(0, terminalIdx + 1) : allMessages;

      if (slice.length === 0) {
        return {
          output: { finalText: '', inputMessageCount: 0, entryWritten: false },
          toolCalls: 0,
          stoppedReason: 'done',
        };
      }

      // Today's existing automatic entry, if any. Passed into the
      // prompt so the agent can extend rather than clobber. A
      // Supabase failure here degrades to "no existing entry" - the
      // worker will re-run on the next cycle and the union-merge
      // inside the upsert RPC still preserves accumulated state.
      let existingEntry = null as
        | {
            content: string;
            topics: readonly string[];
            mood: string | null;
            people: readonly string[];
          }
        | null;
      try {
        const rows = await this.supabase.getJournalEntriesForDate(
          req.input.entryDate
        );
        const automatic = rows.find((e) => e.source === 'automatic');
        if (automatic) {
          existingEntry = {
            content: automatic.content,
            topics: automatic.topics,
            mood: automatic.mood,
            people: automatic.people,
          };
        }
      } catch {
        existingEntry = null;
      }

      const convo: VeniceMessage[] = slice.map(messageToVenice);
      convo.push({
        role: 'user',
        content: buildJournalPrompt({
          entryDate: req.input.entryDate,
          existingEntry,
          threadId: req.input.threadId,
        }),
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
        },
        signal,
        reasoningEffort: JOURNAL_REASONING_EFFORT,
      });

      return {
        output: {
          finalText: result.finalText,
          inputMessageCount: slice.length,
          // `successfulToolCalls`, not `toolCalls` - we don't want to
          // log "wrote=true" for a run whose only journal_upsert call
          // threw on the RPC and surfaced as an `{ok:false}` row to
          // the model. The pointer still advances either way (the loop
          // marks the thread journaled regardless), but the log line
          // should reflect what actually landed in the DB.
          entryWritten: result.successfulToolCalls > 0,
        },
        toolCalls: result.toolCalls,
        stoppedReason: signal.aborted ? 'aborted' : 'done',
      };
    } catch (err) {
      return {
        output: { finalText: '', inputMessageCount: 0, entryWritten: false },
        toolCalls: 0,
        stoppedReason: 'error',
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }
}
