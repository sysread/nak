/**
 * Headless tool-call loop — the agent-side counterpart to the chat-loop
 * in `src/lib/chat-loop.ts`. Drives a sequence of model turns and
 * concurrent tool executions entirely in memory: no Supabase writes,
 * no streaming callbacks, no catalog-prompt prepend. Returns the final
 * text and a handful of observability counters once the model settles
 * into a text-only (no-tool-calls) response.
 *
 * Why separate from `chat-loop.ts`: the two surfaces are only
 * superficially the same. The chat loop persists every assistant and
 * tool row into `messages`, emits streaming callbacks for the UI,
 * tracks the per-thread `tools_enabled` gate, prepends a dynamic
 * catalog system message, and supports Venice's server-side web-
 * search augmentation. An agent doesn't want any of that — it has a
 * fixed prompt it composed itself, its tools are always on, its
 * "conversation" is ephemeral, and nothing reads token-level
 * progress. Forcing one abstraction to cover both grows a laundry
 * list of optional flags; two focused functions are easier to read
 * and easier to evolve independently.
 *
 * Cancellation: each tool execution gets a child AbortController
 * linked to `opts.signal`, same pattern as the chat loop, so aborting
 * the caller's signal tears down in-flight Venice and Supabase
 * requests across every tool in parallel.
 */
import type { Toolbox, ToolContext, OpenAIToolCall } from './types';
// Import from the leaf `./dispatch` rather than the `./index` barrel.
// `./index` statically imports `research_docs`, which reaches into
// `src/lib/docs.ts`. That module's non-eager `import.meta.glob` over
// docs/user/**/*.md forces code-splitting, which is incompatible with
// Vite's default IIFE worker format. The reflection agent uses
// `runHeadlessToolLoop` from inside a Web Worker, so this import has
// to stay on the IIFE-safe side of the graph.
import { buildToolboxWireList, executeToolboxCall } from './dispatch';
import {
  parseToolArguments,
  sanitizeToolCallIdForWire,
  sanitizeToolCallsForWire,
} from './wire';
import type { VeniceClient, VeniceMessage, ResponseFormat } from '../venice';
import type { ReasoningEffort } from '../models';

/**
 * Upper bound on rounds a headless run can take. Acts as a coarse
 * backstop, not a per-task cap - real protection against a runaway
 * agent-spawning chain comes from MAX_AGENT_DEPTH below. Set high
 * enough that a legitimately tool-heavy agent (the journal agent
 * sometimes wants several memory_search + conversation_search rounds
 * before settling on a JSON entry) doesn't bump into it under normal
 * use; if a run actually hits this, something is misbehaving.
 */
export const DEFAULT_MAX_ROUNDS = 20;

/**
 * Maximum nested-agent depth allowed below the main chat. The main
 * chat itself is depth 0; the first agent it spawns runs at depth 1;
 * an agent spawned by that agent's tool runs at depth 2; and so on.
 * `runHeadlessToolLoop` rejects an agent run whose effective depth
 * would exceed this cap, so the recursion main_chat -> agent -> agent
 * -> ... bottoms out at three levels of agents.
 *
 * In practice the registered toolboxes today don't expose a path that
 * recurses this deep (recall agents only get `*_search` tools, the
 * journal agent only gets `*_search`, the reflection agent gets the
 * memory CRUD tools without `memory_recall`). The cap exists as a
 * defensive backstop so a future toolbox change that accidentally
 * grants an agent a recursive tool can't hang the worker / chat tab.
 */
export const MAX_AGENT_DEPTH = 3;

/**
 * Compose a child AbortController whose `.abort()` fires whenever the
 * parent signal aborts. Used to scope per-tool cancellation under the
 * outer signal — aborting the outer cancels every in-flight tool
 * fetch as a side effect. Same shape as `chat-loop.ts`'s helper;
 * duplicated rather than shared to keep this file free of a chat-loop
 * import (agents shouldn't depend on the streaming chat infrastructure).
 */
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
 * Encode a tool's return value (or error) into the string `content`
 * field that OpenAI's tool-result messages expect. Always JSON so the
 * model sees structured data rather than a toString rendering. Matches
 * `chat-loop.ts`'s encoder — agent tool results and chat tool results
 * must be shaped identically so a future model swap between the two
 * doesn't have to relearn the result format.
 */
function encodeToolContent(
  result: { ok: true; value: unknown } | { ok: false; error: Error }
): string {
  if (result.ok) {
    try {
      return JSON.stringify(result.value ?? null);
    } catch {
      return JSON.stringify({ error: 'result not serializable' });
    }
  }
  return JSON.stringify({ error: result.error.message || String(result.error) });
}

export interface HeadlessToolLoopOptions {
  venice: VeniceClient;
  /** Concrete Venice model id sent as `model` on every round. */
  model: string;
  /**
   * Initial conversation the model sees on round 1. The caller is
   * responsible for having appended its own instruction turn (system
   * or user) — we don't prepend anything. Copied internally so
   * in-place extensions across rounds don't mutate the caller's
   * array.
   */
  messages: VeniceMessage[];
  /**
   * Tools the model can call. The wire array is
   * `buildToolboxWireList(toolbox)` and dispatch goes through
   * `executeToolboxCall(toolbox, …)` — both calls strictly scope to
   * the tools this toolbox declares; no fall-through to the global
   * registry.
   */
  toolbox: Toolbox;
  /**
   * Base fields for the per-call ToolContext. We fill in `signal`
   * per-call with a child controller so parallel tool runs can be
   * torn down independently under one outer abort.
   */
  toolCtx: Omit<ToolContext, 'signal'>;
  signal: AbortSignal;
  /**
   * Upper bound on rounds; defaults to `DEFAULT_MAX_ROUNDS`. Acts as
   * a circuit breaker against a model that keeps asking for tools
   * without settling — the result's `stoppedByLimit` is the signal
   * the caller can surface in logs.
   */
  maxRounds?: number;
  /**
   * Optional OpenAI-compatible `response_format`. Forwarded on every
   * round. Providers only constrain the *text* part of a response to
   * the requested shape — tool_call rounds are unaffected, so asking
   * for `json_object` here doesn't block the model from going through
   * tool rounds before settling on a structured final answer.
   */
  responseFormat?: ResponseFormat;
  /**
   * Optional reasoning_effort knob. Forwarded verbatim to Venice on
   * every round. Omitted by default so callers that don't want to
   * spend reasoning budget get whatever default the model's provider
   * applies. Only honored on reasoning-capable models; non-reasoning
   * tiers silently ignore. The journaling agent sets this to 'medium'
   * because emotional-arc parsing benefits from the extra think time;
   * the memory-reflection agent leaves it unset and lets the fast
   * tier default.
   */
  reasoningEffort?: ReasoningEffort;
  /**
   * Optional Venice-specific `disable_thinking` kill switch. When
   * true, forwarded on every round so the model's reasoning pass is
   * skipped entirely - no `reasoning_content` tokens, no chain-of-
   * thought eating into the response budget. Distinct from
   * `reasoningEffort: 'low'`, which shrinks the CoT but doesn't
   * disable it. Used by background agents whose task is bounded
   * synthesis on a reasoning-capable model where the default CoT
   * preamble would just add latency without changing the answer
   * quality. The journaling agent sets this so a Venice GLM-4.7
   * variant doesn't burn its first few hundred tokens on internal
   * deliberation before emitting the structured JSON entry.
   */
  disableThinking?: boolean;
}

export interface HeadlessToolLoopResult {
  /** Final assistant text — empty when the loop hit maxRounds without settling. */
  finalText: string;
  /** Number of streaming rounds that ran (>=1 on any non-aborted call). */
  rounds: number;
  /** Total number of tool calls issued across all rounds. */
  toolCalls: number;
  /** True iff we stopped because of maxRounds rather than a clean finish. */
  stoppedByLimit: boolean;
}

/**
 * Drive the model → tool → model loop until it settles. Returns as
 * soon as the model produces a round with no `tool_calls`, or after
 * `maxRounds` rounds — whichever comes first. An aborted signal
 * short-circuits on the next round boundary.
 *
 * This function does NOT touch Supabase. Persistence is the caller's
 * problem (an agent may choose to persist nothing — the reflection
 * agent's side effects are entirely in the memory_* tool calls it
 * issues, so there's no transcript to save).
 */
export async function runHeadlessToolLoop(
  opts: HeadlessToolLoopOptions
): Promise<HeadlessToolLoopResult> {
  const { venice, model, toolbox, toolCtx, signal } = opts;
  const maxRounds = opts.maxRounds ?? DEFAULT_MAX_ROUNDS;

  // Recursion-depth check. `toolCtx.depth` is the agent depth of the
  // tool that spawned us (0 when the caller is the main chat). The
  // agent we are starting runs at one level deeper; if that would
  // exceed the cap we refuse before the first Venice call so the
  // calling tool surfaces the failure as a tool-result error and the
  // model can adapt rather than the worker silently hanging on an
  // ever-growing stack of in-flight Venice streams.
  const incomingDepth = toolCtx.depth ?? 0;
  const effectiveDepth = incomingDepth + 1;
  if (effectiveDepth > MAX_AGENT_DEPTH) {
    throw new Error(
      `agent depth limit (${MAX_AGENT_DEPTH}) exceeded; ` +
        `would run at depth ${effectiveDepth}`
    );
  }

  // Local copy — we extend with assistant+tool turns each round but
  // must not mutate the caller's array.
  const messages: VeniceMessage[] = [...opts.messages];

  let finalText = '';
  let rounds = 0;
  let toolCalls = 0;
  let stoppedByLimit = false;

  for (let round = 0; round < maxRounds; round++) {
    if (signal.aborted) break;
    rounds++;

    // Non-streaming: each round is a single POST + parsed response.
    // Background agents don't have a UI surface to render tokens
    // incrementally into, and the multi-round tool loop already
    // serialises rounds anyway - streaming would only add latency.
    const completion = await venice.completeChat({
      model,
      messages,
      signal,
      tools: buildToolboxWireList(toolbox),
      responseFormat: opts.responseFormat,
      reasoningEffort: opts.reasoningEffort,
      disableThinking: opts.disableThinking,
    });

    const roundText = completion.text;
    const roundCalls: OpenAIToolCall[] = completion.toolCalls;
    // `completion.usage` is intentionally ignored - headless runs
    // don't surface per-turn token usage to the caller. If an agent
    // ever cares, add a `onUsage` callback rather than putting it on
    // the return shape.

    // No tool calls → this is the terminal response. We're done.
    if (roundCalls.length === 0) {
      finalText = roundText;
      break;
    }

    toolCalls += roundCalls.length;

    // Execute every call concurrently — each promise catches
    // internally so Promise.all never rejects. OpenAI requires a
    // tool-result row for every tool_call in the assistant message,
    // so we need all of them settled (success or failure) before
    // composing the next round's message list.
    const executions = roundCalls.map(async (call) => {
      const ctl = childController(signal);
      // Stamp the per-call ctx with this agent's depth so a tool that
      // tries to spawn yet another agent sees an incremented value
      // and the next runHeadlessToolLoop's depth check is computed
      // off the right base.
      const ctx: ToolContext = {
        ...toolCtx,
        signal: ctl.signal,
        depth: effectiveDepth,
      };
      let args: Record<string, unknown>;
      try {
        // OpenAI streams `arguments` as a JSON string, one fragment
        // at a time; Venice's streamChat concatenates the fragments
        // and hands us the final assembled string. An invalid JSON
        // blob is a model error - surface it back as a tool result
        // so the next round sees the failure and can retry with a
        // valid argument. parseToolArguments also recovers from a
        // known LLM double-escape bug on multi-line free-form
        // fields; see ./wire.ts.
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

    // Extend the in-memory conversation with the assistant-with-
    // tool-calls turn and one tool-result turn per call, in the
    // order the model returned them. OpenAI's API rejects a
    // message list where a tool_call doesn't have a matching
    // subsequent `role: 'tool'` with the same tool_call_id — that's
    // why the assistant row must come first and every call gets a
    // result, even on failure.
    //
    // Arguments are sanitised before going back on the wire: a model
    // that emits a malformed arguments JSON (unescaped quotes inside
    // the free-form `activity` sentence is the usual offender) would
    // fail Venice's server-side json.loads check on the next round
    // and 400 the whole request. See `./wire.ts`.
    messages.push({
      role: 'assistant',
      content: roundText,
      tool_calls: sanitizeToolCallsForWire(roundCalls),
    });
    for (const r of settled) {
      const content = r.ok
        ? encodeToolContent({ ok: true, value: r.value })
        : encodeToolContent({ ok: false, error: r.error });
      // Mirror the id rewrite that sanitizeToolCallsForWire just
      // applied to the assistant row's tool_calls above. The two have
      // to agree by id - OpenAI-compatible providers reject a message
      // list where a tool result doesn't pair with a preceding
      // assistant call.
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
