/**
 * Memory-reflection agent. Drives one reflection pass over a
 * completed conversation: fetches the thread's messages up to the
 * claimed terminal assistant message, appends the reflection
 * instruction as a final user turn, and runs the headless tool-call
 * loop with `memoryToolbox`. The loop's side effects — calls to
 * memory_search / _create / _update / _invalidate — ARE the output;
 * the model's final text is discarded after being captured for logs.
 *
 * The agent does NOT acquire or release the lease, claim or mark the
 * thread, or spawn its own worker. Those live in `./loop.ts` and
 * `./worker.ts` respectively. This class is pure logic: given a
 * claimed (threadId, terminalMsgId) pair, do the LLM work and
 * return. Runs inside a Web Worker in production; runs on the main
 * thread in tests. The separation keeps the LLM path unit-testable
 * without faking a lease coordinator or a Postgres claim.
 *
 * Why a class implementing `Agent<ReflectionInput, ReflectionOutput>`
 * rather than a plain async function: the `Agent` contract advertises
 * the toolbox and model on the public surface, so anything that lists
 * or introspects agents (a future debug panel, say) can see the
 * capability set without invoking `run()`.
 */
import type { Agent, AgentRunRequest, AgentRunResult } from '../types';
import type { SupabaseService, Message } from '../../supabase';
import type { VeniceClient, VeniceMessage } from '../../venice';
// Import from the leaf file rather than the `../../tools` barrel.
// This file runs inside the reflection Web Worker, and the barrel
// statically imports `research_docs`, which reaches into
// `src/lib/docs.ts`. That module's non-eager `import.meta.glob` over
// docs/user/**/*.md forces code-splitting on the per-doc chunks,
// which is incompatible with Vite's default IIFE worker format and
// fails the production build with "Invalid value 'iife' for option
// 'output.format'". See `../../tools/memory_toolbox.ts`.
import { memoryToolbox } from '../../tools/memory_toolbox';
import { runHeadlessToolLoop } from '../../tools/run';
import { sanitizeToolCallsForWire } from '../../tools/wire';
import { VENICE_REFLECTION_MODEL } from '../../models';
import { REFLECTION_PROMPT } from './prompt';

export interface ReflectionInput {
  /** Thread to reflect on — claimed by the worker before this runs. */
  threadId: string;
  /**
   * Terminal assistant message the claim was made against. We slice
   * the fetched history at this id so a race where the user added
   * more turns mid-reflection simply queues the thread for the next
   * cycle rather than letting us reflect on a half-captured round.
   */
  terminalMsgId: string;
}

export interface ReflectionOutput {
  /**
   * The model's final (post-tool-loop) text. Always discarded by
   * production callers — "reply with a single word" per the prompt —
   * but returned here for debug logs and test assertions.
   */
  finalText: string;
  /**
   * Number of messages fed to the model on round 1, before the
   * model's own turns extended the conversation. Surface it for
   * observability — a reflection over 50 messages is meaningfully
   * different from one over 5, and the distinction is worth the
   * breadcrumb.
   */
  inputMessageCount: number;
}

/**
 * Project a stored Message row onto the OpenAI wire format. Mirrors
 * `toVeniceMessage` in `chat-loop.ts`; kept as a private helper here
 * rather than a shared import so the agents subtree doesn't reach
 * sideways into the chat-loop module. The two copies must stay in
 * sync — the projection is what makes history → API a direct
 * mapping for both surfaces.
 *
 * The arguments-string sanitiser is shared - see
 * src/lib/tools/wire.ts for the rationale (Venice 400s on a malformed
 * arguments JSON and the failure rides every replay until normalised).
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
    out.tool_calls = sanitizeToolCallsForWire(m.tool_calls);
  }
  return out;
}

export class ReflectionAgent implements Agent<ReflectionInput, ReflectionOutput> {
  readonly name = 'reflection';
  readonly model: string;
  readonly toolbox = memoryToolbox;

  constructor(
    private venice: VeniceClient,
    private supabase: SupabaseService,
    /**
     * Optional model override. Defaults to `VENICE_REFLECTION_MODEL`
     * (tracks the fast tier). Useful for tests that want to pin a
     * specific id, and for a future A/B where two reflection agents
     * with different models might run side-by-side against historical
     * threads.
     */
    modelId?: string
  ) {
    this.model = modelId ?? VENICE_REFLECTION_MODEL;
  }

  async run(
    req: AgentRunRequest<ReflectionInput>
  ): Promise<AgentRunResult<ReflectionOutput>> {
    const signal = req.signal ?? new AbortController().signal;

    if (signal.aborted) {
      return {
        output: { finalText: '', inputMessageCount: 0 },
        toolCalls: 0,
        stoppedReason: 'aborted',
      };
    }

    try {
      // Fetch the full thread history, then slice at the terminal
      // message we claimed against. A user racing more turns in
      // between claim and fetch — unlikely under the claim TTL, but
      // possible — shouldn't change what we reflect on.
      const allMessages = await this.supabase.listMessages(req.input.threadId);
      const terminalIdx = allMessages.findIndex(
        (m) => m.id === req.input.terminalMsgId
      );
      const slice =
        terminalIdx >= 0 ? allMessages.slice(0, terminalIdx + 1) : allMessages;

      if (slice.length === 0) {
        // Pathological case: thread exists but has no messages. Nothing
        // to reflect on; return a no-op result so the loop marks the
        // thread and moves on rather than retrying forever.
        return {
          output: { finalText: '', inputMessageCount: 0 },
          toolCalls: 0,
          stoppedReason: 'done',
        };
      }

      const convo: VeniceMessage[] = slice.map(messageToVenice);
      // Reflection instruction as the final user turn. The model
      // sees the whole prior conversation in its native shape
      // (assistant text, tool_calls arrays, tool-result rows) and
      // reads this as "now do this different task."
      convo.push({ role: 'user', content: REFLECTION_PROMPT });

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
      });

      return {
        output: {
          finalText: result.finalText,
          inputMessageCount: slice.length,
        },
        toolCalls: result.toolCalls,
        stoppedReason: signal.aborted ? 'aborted' : 'done',
      };
    } catch (err) {
      return {
        output: { finalText: '', inputMessageCount: 0 },
        toolCalls: 0,
        stoppedReason: 'error',
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }
}
