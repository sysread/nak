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
import { toolComplete } from '../tools/_venice_complete.ts';
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
  threadId: string;
  signal: AbortSignal;
  /** Agent depth this call runs at. Set by the driver per-call. */
  depth: number;
}

function buildToolboxWireList(
  toolbox: Toolbox,
): AgentTool['wire'][] {
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

  for (let round = 0; round < maxRounds; round += 1) {
    if (signal.aborted) break;
    rounds += 1;

    const completion = await toolComplete({
      apiKey,
      model,
      // VeniceMessage's optional content vs ToolCompletionMessage's
      // required content: an assistant turn that emitted only
      // tool_calls has content null. Coerce here so the wire body the
      // helper builds carries a real string field for every row.
      messages: messages.map((m) => ({ ...m, content: m.content ?? '' })),
      tools: buildToolboxWireList(toolbox),
      reasoningEffort: opts.reasoningEffort,
      disableThinking: opts.disableThinking,
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
      let args: Record<string, unknown>;
      try {
        args = parseToolArguments(call.function.arguments);
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err));
        return { call, ok: false as const, error };
      }
      try {
        const value = await executeToolboxCall(toolbox, call.function.name, args, ctx);
        return { call, ok: true as const, value };
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err));
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
