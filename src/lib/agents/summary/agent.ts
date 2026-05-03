/**
 * Thread-summary agent. Runs one summarisation pass over a
 * conversation: fetches messages up to the claimed terminal assistant
 * message, appends the summary instruction as a final user turn, and
 * asks the fast model for a 2–3 sentence topical summary. No tool
 * calls — the output IS the final text, which the worker writes back
 * to `threads.summary`.
 *
 * Shape mirrors `../reflection/agent.ts` deliberately. The loop-
 * harness + worker-entry pattern in the parent directory expects an
 * `Agent<Input, Output>` it can `run()` against, and reusing the
 * same scaffold means anyone reading the reflection code has this
 * one's vocabulary for free.
 *
 * The agent does NOT acquire or release the lease, claim or save the
 * summary, or spawn its own worker. Those live in `./loop.ts` and
 * `./worker.ts` respectively. This class is pure logic: given a
 * claimed (threadId, terminalMsgId), produce a summary string.
 */
import type { Agent, AgentRunRequest, AgentRunResult } from '../types';
import type { SupabaseService, Message } from '../../supabase';
import type { VeniceClient, VeniceMessage } from '../../venice';
import type { Toolbox } from '../../tools/types';
import { sanitizeToolCallIdForWire, sanitizeToolCallsForWire } from '../../tools/wire';
import {
  trimToCompleteTurn,
  trimToFirstUserOrSystem,
} from '../../conversation-recovery';
import { VENICE_SUMMARY_MODEL } from '../../models';
import { SUMMARY_PROMPT } from './prompt';

/**
 * Empty toolbox — the summary agent's contract advertises a Toolbox
 * but it never actually invokes tools; the output is pure text. We
 * still expose the shape (satisfying the Agent interface) rather
 * than changing the interface, because every other agent does use
 * tools and narrowing the base type would just push the empty case
 * elsewhere. "summary produces nothing callable" is a perfectly
 * valid toolbox.
 */
const emptyToolbox: Toolbox = {
  name: 'summary',
  description: 'No tools — the summary agent produces plain text only.',
  tools: [],
};

export interface SummaryInput {
  /** Thread to summarise — claimed by the worker before this runs. */
  threadId: string;
  /**
   * Terminal assistant message the claim was made against. Slicing
   * the history at this id means a race where the user added turns
   * mid-summary simply queues the thread for the next cycle.
   */
  terminalMsgId: string;
}

export interface SummaryOutput {
  /**
   * The generated summary, post-trim. Empty string when the model
   * refused or produced only whitespace — the loop treats an empty
   * summary as a non-result and retries on the next cycle rather
   * than saving garbage.
   */
  summary: string;
  /** Message count fed to the model on round 1. Observability breadcrumb. */
  inputMessageCount: number;
}

/**
 * Project a stored Message row onto the Venice wire format. Kept
 * local so the summary subtree doesn't reach sideways into
 * chat-loop or reflection — the projection is tiny and copying it
 * once is less coupling than sharing a helper across three
 * subsystems.
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

/**
 * Trim the model's raw output. Strips trailing whitespace, wraps of
 * quote characters some models emit around "direct speech" outputs,
 * and caps length at 600 chars (safely beyond "2–3 sentences" and
 * well under the worst-case token inflation at bge-m3).
 */
function trimSummary(raw: string): string {
  const stripped = raw
    .trim()
    .replace(/^["'`]+|["'`]+$/g, '')
    .trim();
  return stripped.length > 600 ? stripped.slice(0, 600) : stripped;
}

/**
 * Cap the number of messages we feed to the model. Very long threads
 * (500+ messages) would stretch the fast model's context; a
 * conversation summary doesn't benefit from every turn, so we send
 * the earliest + most-recent messages and let a symmetric gap in the
 * middle carry the missing span. The first turns establish topic,
 * the last turns establish outcome — the middle is usually
 * refinement that the summary doesn't need.
 */
const MAX_INPUT_MESSAGES = 120;

function condenseHistory(all: Message[]): Message[] {
  if (all.length <= MAX_INPUT_MESSAGES) return all;
  // Take the first 40 and the last 80 — outcomes carry more summary
  // weight than origins, and the middle is dominated by iteration.
  //
  // The naive split lands the seam wherever index 40 / length-80 fall,
  // which on a tool-using thread can put a `tool` row at the end of
  // head and a `user` row at the start of tail - the wire then
  // serialises as `tool -> user`, which providers reject with
  // "Unexpected role 'user' after role 'tool'". Trim each half to a
  // safe boundary before concatenating: head ends at a complete turn
  // (no trailing tool / orphan-tool_calls assistant), tail starts at
  // a fresh user (or system) row.
  const head = trimToCompleteTurn(all.slice(0, 40));
  const tail = trimToFirstUserOrSystem(all.slice(-80));
  return [...head, ...tail];
}

export class SummaryAgent implements Agent<SummaryInput, SummaryOutput> {
  readonly name = 'summary';
  readonly model: string;
  readonly toolbox: Toolbox = emptyToolbox;

  constructor(
    private venice: VeniceClient,
    private supabase: SupabaseService,
    /**
     * Optional model override — defaults to VENICE_SUMMARY_MODEL.
     * Same rationale as the reflection override: useful for tests,
     * and a future A/B against a different model can pin a concrete
     * id without a call-site change.
     */
    modelId?: string
  ) {
    this.model = modelId ?? VENICE_SUMMARY_MODEL;
  }

  async run(
    req: AgentRunRequest<SummaryInput>
  ): Promise<AgentRunResult<SummaryOutput>> {
    const signal = req.signal ?? new AbortController().signal;

    if (signal.aborted) {
      return {
        output: { summary: '', inputMessageCount: 0 },
        toolCalls: 0,
        stoppedReason: 'aborted',
      };
    }

    try {
      const allMessages = await this.supabase.listMessages(req.input.threadId);
      const terminalIdx = allMessages.findIndex(
        (m) => m.id === req.input.terminalMsgId
      );
      const slice =
        terminalIdx >= 0 ? allMessages.slice(0, terminalIdx + 1) : allMessages;

      if (slice.length === 0) {
        return {
          output: { summary: '', inputMessageCount: 0 },
          toolCalls: 0,
          stoppedReason: 'done',
        };
      }

      const condensed = condenseHistory(slice);
      const convo: VeniceMessage[] = condensed.map(messageToVenice);
      convo.push({ role: 'user', content: SUMMARY_PROMPT });

      // Non-streaming call: we only want the final text. maxTokens
      // caps the response at ~150 tokens, which is plenty for 2-3
      // sentences and a safety net against a model that ignores the
      // length instruction.
      const result = await this.venice.completeChat({
        model: this.model,
        messages: convo,
        maxTokens: 180,
        signal,
      });

      return {
        output: {
          summary: trimSummary(result.text),
          inputMessageCount: condensed.length,
        },
        toolCalls: 0,
        stoppedReason: signal.aborted ? 'aborted' : 'done',
      };
    } catch (err) {
      return {
        output: { summary: '', inputMessageCount: 0 },
        toolCalls: 0,
        stoppedReason: 'error',
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }
}
