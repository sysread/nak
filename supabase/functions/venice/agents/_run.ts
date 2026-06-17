// Headless tool-call loop - the agent-side counterpart to
// getStreamingResponse. Mirror of src/lib/tools/run.ts at the function
// side: drives a sequence of model turns and concurrent tool
// executions entirely in memory, no DB writes, no streaming callbacks,
// no catalog-prompt prepend. Returns the final text once the model
// settles into a text-only (no-tool-calls) response.
//
// Why separate from getStreamingResponse: the two surfaces are only
// superficially the same. getStreamingResponse persists every
// assistant + tool row, publishes events to the live Broadcast
// channel, tracks tool citations, runs the commit_assistant_message
// RPC at terminal. An agent doesn't want any of that - it has a fixed
// prompt it composed itself, its tools are always on, its conversation
// is ephemeral, and nothing reads token-level progress. Two focused
// functions are easier to read and easier to evolve independently.

import type { SupabaseClient } from '@supabase/supabase-js';
import {
  toolComplete,
  type ToolCompletionOptions,
  type ToolCompletionResult,
} from '../tools/_venice_complete.ts';
import {
  encodeToolContent,
  parseToolArguments,
  sanitizeToolCallIdForWire,
  sanitizeToolCallsForWire,
  type OpenAIToolCall,
} from './_wire.ts';

// Upper bound on rounds a headless run can take. Coarse backstop, not
// a per-task cap.
const DEFAULT_MAX_ROUNDS = 20;

// Maximum nested-agent depth allowed below the main chat. Main chat
// runs at depth 0; first agent at depth 1; etc. runHeadlessAgent
// rejects an agent run whose effective depth would exceed this so a
// runaway sub-agent chain can't lock the function.
export const MAX_AGENT_DEPTH = 3;

/**
 * One tool a headless agent can call. Mirrors the orchestrator's
 * ToolDef but pinned to the agent-side wire (the schema rides on the
 * Toolbox below; the agent driver only needs name + execute).
 */
export interface AgentTool {
  name: string;
  /** OpenAI-format tool schema for this entry. */
  wire: {
    type: 'function';
    function: {
      name: string;
      description?: string;
      parameters?: Record<string, unknown>;
    };
  };
  execute(
    args: Record<string, unknown>,
    ctx: AgentToolContext,
  ): Promise<unknown>;
}

/**
 * Agent-scoped tool dispatch. A toolbox is a frozen subset of tools
 * the agent's model can call. dispatch() refuses any name not in the
 * subset rather than falling through to the global registry - agents
 * are bounded contexts and accidental reach into another toolbox would
 * undermine the bound.
 */
export interface Toolbox {
  readonly name: string;
  readonly tools: readonly AgentTool[];
}

/**
 * Per-call context the agent driver passes into every tool's
 * execute(args, ctx). Distinct from the orchestrator's ToolContext
 * because the agent has no thread/realtime surface to publish to - it
 * just needs admin DB access + userId + cancel + depth.
 */
export interface AgentToolContext {
  adminClient: SupabaseClient;
  userId: string;
  /**
   * Thread the agent is working on, or null for the cross-thread
   * librarians (rem, deep-sleep, wiki-librarian), which have no
   * current thread. Mirrors ToolContext.threadId - see its docblock
   * in performToolCall.ts for the consumer contract.
   */
  threadId: string | null;
  signal: AbortSignal;
  /** Agent depth this call runs at. Set by the driver per-call. */
  depth: number;
}

/**
 * Schema for the `activity` parameter injected into every tool's
 * arguments when a progress listener is attached. The model fills it
 * with a short present-tense sentence narrating what this specific
 * call is doing; the listener surfaces the sentence in a live step
 * list (the Wiki librarian strip is the motivating consumer). Mirror
 * of the browser dispatch layer's ACTIVITY_PARAM_SCHEMA so the model
 * sees the same contract whichever side drives the loop.
 */
const ACTIVITY_PARAM_SCHEMA = {
  type: 'string',
  description:
    'REQUIRED. One short present-tense sentence, addressed to the user, ' +
    'narrating what you are doing with this specific call - e.g. ' +
    '"Searching your memories for notes about the dishwasher", ' +
    '"Saving that pancake recipe to your cookbook". Keep it under ' +
    '100 characters. Surfaced prominently in the UI above the tool ' +
    "name so the user can see what's happening without opening the " +
    'call details.',
} as const;

/**
 * Merge the shared `activity` property into a tool's wire schema
 * without mutating the original. Injected at the wire-projection
 * layer (not per-ToolDef) so tools never have to know the convention;
 * every execute() reads specific keys and ignores the extra one.
 */
function injectActivityParam(
  wire: AgentTool['wire'],
): AgentTool['wire'] {
  const parameters: Record<string, unknown> = { ...(wire.function.parameters ?? {}) };
  const existing = (parameters.properties as Record<string, unknown> | undefined) ?? {};
  parameters.properties = { ...existing, activity: ACTIVITY_PARAM_SCHEMA };
  const required = Array.isArray(parameters.required)
    ? [...(parameters.required as unknown[])]
    : [];
  if (!required.includes('activity')) required.push('activity');
  parameters.required = required;
  if (parameters.type === undefined) parameters.type = 'object';
  return {
    type: wire.type,
    function: { ...wire.function, parameters },
  };
}

/**
 * Wrap a toolbox so every tool's wire schema carries the `activity`
 * narration parameter. Callers apply this EXPLICITLY on runs a user
 * watches live (the manual-run routes); narration costs the model a
 * few output tokens per call, so agents nobody is watching (the cron
 * sweeps, reflection) pass their toolbox bare. The runner itself
 * never alters schemas - attaching onProgress without this wrapper
 * just means tool events arrive with an empty `activity` string.
 */
export function withProgressNarration(toolbox: Toolbox): Toolbox {
  return {
    name: toolbox.name,
    tools: toolbox.tools.map((t) => ({ ...t, wire: injectActivityParam(t.wire) })),
  };
}

function buildToolboxWireList(toolbox: Toolbox): AgentTool['wire'][] {
  return toolbox.tools.map((t) => t.wire);
}

async function executeToolboxCall(
  toolbox: Toolbox,
  name: string,
  args: Record<string, unknown>,
  ctx: AgentToolContext,
): Promise<unknown> {
  const tool = toolbox.tools.find((t) => t.name === name);
  if (!tool) {
    throw new Error(
      `Tool "${name}" is not in toolbox "${toolbox.name}". ` +
        `Agents are bounded contexts; the model called a tool it does not have access to.`,
    );
  }
  return await tool.execute(args, ctx);
}

interface VeniceMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content?: string | null;
  name?: string;
  tool_call_id?: string;
  tool_calls?: OpenAIToolCall[];
}

/**
 * Live-progress events emitted when the caller supplies onProgress.
 * Mirror of the browser runHeadlessToolLoop's HeadlessToolLoopEvent:
 *   - `thinking`: a new Venice round is about to start (1-based).
 *   - `tool`: a single tool call settled. `activity` is the
 *     model-emitted narration (see ACTIVITY_PARAM_SCHEMA); empty when
 *     the args failed to parse.
 * No `done` event - the caller already knows the loop returned when
 * the Promise resolves.
 */
export type AgentProgressEvent =
  | { kind: 'thinking'; round: number }
  | { kind: 'tool'; name: string; activity: string; ok: boolean; ms: number };

/**
 * The completion call the loop drives each round with. Injectable so
 * unit tests can script model rounds (tool_calls then a terminal
 * text) without a network seam - the browser agents took this through
 * SupabaseService.complete and lost the seam in the migration; this
 * restores it at the runner.
 */
export type AgentCompleteFn = (
  opts: ToolCompletionOptions,
) => Promise<ToolCompletionResult>;

export interface RunHeadlessAgentOptions {
  /** Concrete Venice model id sent as `model` on every round. */
  model: string;
  /**
   * Initial conversation the model sees on round 1. Copied internally
   * so the caller's array stays untouched.
   */
  messages: readonly VeniceMessage[];
  toolbox: Toolbox;
  /**
   * Base context. The driver fills in `signal` per-call with a child
   * controller so parallel tool runs can be torn down under one outer
   * abort, and stamps `depth` to this agent's effective depth.
   */
  baseCtx: Omit<AgentToolContext, 'signal' | 'depth'>;
  /** Venice API key resolved by the caller (readVeniceKey). */
  apiKey: string;
  /** Outer cancel signal; aborted -> next round boundary short-circuits. */
  signal: AbortSignal;
  /** Upper bound on rounds; defaults to DEFAULT_MAX_ROUNDS. */
  maxRounds?: number;
  /** Optional reasoning_effort knob, forwarded verbatim to Venice. */
  reasoningEffort?: 'low' | 'medium' | 'high';
  /** Optional Venice-specific disable_thinking kill switch. */
  disableThinking?: boolean;
  /** Test seam; defaults to toolComplete (the live Venice call). */
  complete?: AgentCompleteFn;
  /**
   * Optional live-progress hook. Events only - the hook never alters
   * what the model sees; pair it with withProgressNarration() on the
   * toolbox when the run should also narrate its tool calls.
   * Best-effort: a listener that throws does not abort the loop.
   */
  onProgress?: (event: AgentProgressEvent) => void;
}

export interface RunHeadlessAgentResult {
  /** Final assistant text; empty when the loop hit maxRounds without settling. */
  finalText: string;
  /** Number of rounds that ran (>=1 on any non-aborted call). */
  rounds: number;
  /** Total number of tool calls issued across all rounds. */
  toolCalls: number;
  /** True iff we stopped because of maxRounds rather than a clean finish. */
  stoppedByLimit: boolean;
}

function childController(parent: AbortSignal): AbortController {
  const child = new AbortController();
  if (parent.aborted) {
    child.abort(parent.reason);
    return child;
  }
  const onAbort = (): void => child.abort(parent.reason);
  parent.addEventListener('abort', onAbort, { once: true });
  return child;
}

/**
 * Drive the model -> tool -> model loop until it settles. Returns as
 * soon as the model produces a round with no tool_calls, or after
 * maxRounds rounds. An aborted signal short-circuits on the next
 * round boundary.
 *
 * Recursion-depth check: baseCtx implicitly carries the caller's
 * depth via the outer call site (the orchestrator passes 0 for the
 * main chat; an agent's own tool execute() bumps the depth when it
 * spawns another agent). The agent we are starting runs at one level
 * deeper than the orchestrator's depth; if that would exceed
 * MAX_AGENT_DEPTH we refuse before the first Venice call.
 */
export async function runHeadlessAgent(
  opts: RunHeadlessAgentOptions,
  parentDepth: number,
): Promise<RunHeadlessAgentResult> {
  const { model, toolbox, baseCtx, apiKey, signal } = opts;
  const maxRounds = opts.maxRounds ?? DEFAULT_MAX_ROUNDS;

  const effectiveDepth = parentDepth + 1;
  if (effectiveDepth > MAX_AGENT_DEPTH) {
    throw new Error(
      `agent depth limit (${MAX_AGENT_DEPTH}) exceeded; ` +
        `would run at depth ${effectiveDepth}`,
    );
  }

  const messages: VeniceMessage[] = [...opts.messages];
  let finalText = '';
  let rounds = 0;
  let toolCalls = 0;
  let stoppedByLimit = false;

  const complete = opts.complete ?? toolComplete;
  // Best-effort progress dispatch - a listener that throws must not
  // perturb the loop (we own the contract, not the listener).
  const emit = (event: AgentProgressEvent): void => {
    if (!opts.onProgress) return;
    try {
      opts.onProgress(event);
    } catch {
      // swallow; progress is observability, not control flow.
    }
  };
  const wireList = buildToolboxWireList(toolbox);

  for (let round = 0; round < maxRounds; round += 1) {
    if (signal.aborted) break;
    rounds += 1;
    emit({ kind: 'thinking', round: rounds });

    const completion = await complete({
      apiKey,
      model,
      // VeniceMessage's optional content vs ToolCompletionMessage's
      // required content: an assistant turn that emitted only
      // tool_calls has content null. Coerce here so the wire body the
      // helper builds carries a real string field for every row.
      messages: messages.map((m) => ({ ...m, content: m.content ?? '' })),
      tools: wireList,
      reasoningEffort: opts.reasoningEffort,
      disableThinking: opts.disableThinking,
      // Headless agents (wiki, reflection, the librarians) run in the
      // background with no browser rate-limit loop, so ride out a
      // transient 429 rather than aborting the whole agent round.
      retryRateLimit: true,
    });

    const roundText = completion.text;
    const roundCalls: OpenAIToolCall[] = completion.toolCalls.map((c) => ({
      id: c.id,
      type: 'function',
      function: { name: c.function.name, arguments: c.function.arguments },
    }));

    if (roundCalls.length === 0) {
      finalText = roundText;
      break;
    }

    toolCalls += roundCalls.length;

    const executions = roundCalls.map(async (call) => {
      const ctl = childController(signal);
      const ctx: AgentToolContext = {
        ...baseCtx,
        signal: ctl.signal,
        depth: effectiveDepth,
      };
      const startedAt = performance.now();
      let args: Record<string, unknown>;
      try {
        args = parseToolArguments(call.function.arguments);
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err));
        emit({
          kind: 'tool',
          name: call.function.name,
          activity: '',
          ok: false,
          ms: performance.now() - startedAt,
        });
        return { call, ok: false as const, error };
      }
      // The model-emitted narration the wire schema requires when a
      // progress listener is attached; absent otherwise. Tools read
      // specific keys and never see it.
      const activity = typeof args.activity === 'string' ? args.activity : '';
      try {
        const value = await executeToolboxCall(toolbox, call.function.name, args, ctx);
        emit({
          kind: 'tool',
          name: call.function.name,
          activity,
          ok: true,
          ms: performance.now() - startedAt,
        });
        return { call, ok: true as const, value };
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err));
        emit({
          kind: 'tool',
          name: call.function.name,
          activity,
          ok: false,
          ms: performance.now() - startedAt,
        });
        return { call, ok: false as const, error };
      }
    });
    const settled = await Promise.all(executions);

    // Push the assistant-with-tool-calls row + one tool-result row per
    // call. OpenAI rejects a message list where a tool_call doesn't
    // have a matching subsequent `role: 'tool'` with the same
    // tool_call_id, so the assistant row must come first and every
    // call gets a result, even on failure.
    messages.push({
      role: 'assistant',
      content: roundText,
      tool_calls: sanitizeToolCallsForWire(roundCalls),
    });
    for (const r of settled) {
      const content = r.ok
        ? encodeToolContent({ ok: true, value: r.value })
        : encodeToolContent({ ok: false, error: r.error });
      messages.push({
        role: 'tool',
        content,
        tool_call_id: sanitizeToolCallIdForWire(r.call.id),
        name: r.call.function.name,
      });
    }

    if (round === maxRounds - 1) {
      stoppedByLimit = true;
    }
  }

  return { finalText, rounds, toolCalls, stoppedByLimit };
}
