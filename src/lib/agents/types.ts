/**
 * Interfaces for background agents.
 *
 * An agent bundles a model (Venice model id), a toolbox (the tools it's
 * allowed to reach for), and private orchestration logic — one prompt,
 * staged prompts, a decision tree, whatever the agent implementation
 * needs. The outside world only sees the method on this interface:
 * `run(request) => Promise<result>`. The internals are the agent's
 * business.
 *
 * Mental model: each agent is analogous to a named GenServer. One
 * long-lived process per agent type, serialised per-process via its
 * own mailbox. On the web that's a dedicated Web Worker (mirroring
 * `src/lib/embeddings/worker.ts`), but the `Agent` contract is
 * worker-agnostic — an implementation is free to run on the main
 * thread if that's ever useful (tests, ad-hoc scripts).
 *
 * Notably NOT on this interface:
 *   - Streaming. Agents return a single final result; token-level
 *     events aren't surfaced. The reflection use case doesn't need
 *     them, and keeping the contract simple means the worker's
 *     outbound messages stay to `{type: 'result' | 'log'}` — no
 *     progress channel to keep in lock-step across refactors.
 *   - Queueing / concurrency policy. Whether a second `run()` while
 *     one is in flight queues, coalesces, or rejects is an
 *     implementation concern. The interface just promises that
 *     `run()` eventually returns a result.
 *
 * The main LLM that answers user turns is intentionally NOT an agent
 * in this sense. That flow is interactive, streams tokens, and lives
 * on the main thread because the UI depends on its output. Agents are
 * the reflective, background, non-streaming counterpart.
 */
import type { Toolbox } from '../tools/types';

/**
 * Inputs every agent run needs plus an agent-specific payload.
 *
 * `userId` is mandatory because every tool ctx is RLS-scoped to a user
 * and every agent eventually calls tools. `threadId` is optional
 * because some agents aren't thread-scoped (e.g. a future "summarise
 * my whole memory graph" agent); thread-scoped agents can narrow the
 * type parameter or assert the field themselves.
 *
 * `signal` lets callers cancel a run in flight — fire-and-forget use
 * can omit it. Implementations should thread it through to Venice and
 * Supabase so an abort cascades all the way down.
 */
export interface AgentRunRequest<Req = unknown> {
  input: Req;
  userId: string;
  threadId?: string;
  signal?: AbortSignal;
  /**
   * Agent-recursion depth of the caller. A tool spawning an agent
   * passes its own `ctx.depth` (from the ToolContext it received) so
   * the agent's `runHeadlessToolLoop` can compute the next depth
   * level and enforce `MAX_AGENT_DEPTH`. Worker entrypoints
   * (reflection, journal) leave it undefined - they have no parent
   * tool, so they start at depth 0 and their internal loop runs
   * at depth 1. Optional/undefined behaves the same as 0.
   */
  depth?: number;
}

/**
 * Why a run ended. Callers that care (observability, retry logic) read
 * this; the common fire-and-forget path ignores it. `'aborted'` means
 * the caller's signal fired, not that the agent chose to stop.
 */
export type AgentStoppedReason = 'done' | 'aborted' | 'error';

export interface AgentRunResult<Res = unknown> {
  output: Res;
  /** How many tool calls the agent issued — cheap observability. */
  toolCalls: number;
  stoppedReason: AgentStoppedReason;
  /** Populated iff stoppedReason === 'error'. */
  error?: string;
}

/**
 * The public contract. An agent implementation provides a concrete
 * class with its own constructor (for dependency injection —
 * SupabaseService, VeniceClient, etc.) and supplies the three readonly
 * fields plus `run()`.
 *
 * Parameterised on both the request and response shapes so
 * typed agents (e.g. `Agent<ThreadId, MemoryDiff>`) can be consumed
 * end-to-end without casting. The defaults are `unknown`, which forces
 * a cast at use-sites that don't bother to narrow — a deliberate nudge
 * toward declaring the input/output types at the agent boundary.
 */
export interface Agent<Req = unknown, Res = unknown> {
  readonly name: string;
  readonly model: string;
  readonly toolbox: Toolbox;
  run(req: AgentRunRequest<Req>): Promise<AgentRunResult<Res>>;
}
