/**
 * Shared types for the tool-calling subsystem. The shape of `ToolDef` is
 * what the rest of the app reads from; `toOpenAIToolDef()` in `./wire.ts`
 * projects it down to the OpenAI / Venice wire format at send-time.
 *
 * Every tool is a function with:
 *   - name          : the string the model uses to invoke it
 *   - description   : the full description shipped in the `tools` array
 *   - shortDescription : <50-char line for the in-prompt catalog (system
 *                        message lists every tool by name + this blurb so
 *                        the model knows what's behind the toggle without
 *                        needing the full schema)
 *   - parameters    : JSON Schema for the args, shipped verbatim
 *   - execute       : nominally a browser-side handler. In practice
 *                     every ToolDef is a `serverSideTool` whose
 *                     execute() throws - all dispatch happens in the
 *                     venice edge function (`performToolCall`), and
 *                     the browser ships only the catalog + wire
 *                     schemas. The signature survives so the contract
 *                     tests (and any future browser-side dispatch)
 *                     have a shape to hold onto.
 */
import type { SupabaseService } from '../supabase';

export interface ToolContext {
  supabase: SupabaseService;
  userId: string;
  threadId: string;
  signal: AbortSignal;
  /**
   * Agent-recursion depth this tool is running at. 0 means the main
   * chat loop dispatched the call; N means we are N agents deep below
   * the main chat. The live recursion guard is server-side now (the
   * venice function's performToolCall / agents/_run.ts mirror this
   * field and enforce the depth cap); the browser field survives for
   * the ToolContext shape tests and any future browser-side dispatch.
   * Optional/undefined is treated as 0.
   */
  depth?: number;
}

/**
 * A tool's execute() returns whatever the handler wants to hand back to
 * the model. We JSON.stringify it at persist-time to fit the OpenAI
 * `content: string` contract on `role='tool'` messages.
 */
export type ToolResult = unknown;

export interface ToolDef {
  name: string;
  description: string;
  /** Short line for the in-prompt catalog. Keep under 50 chars. */
  shortDescription: string;
  /** JSON Schema for the args — shipped verbatim to the model. */
  parameters: Record<string, unknown>;
  execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult>;
  /**
   * Optional override: turn this tool's parsed argument object into
   * the markdown the detail panel renders for the "pretty" view.
   * The generic formatter in `src/lib/ui/tool-format.ts` covers the
   * common JSON-tree shape; supply this only when a tool has a
   * domain-specific payload that benefits from a hand-rolled
   * rendering (e.g. cooklang source belongs in a fenced block, not
   * a wrapping bullet). Lives on the schema half of the ToolDef so
   * the UI can reach it without resolving the lazy-loaded impl
   * chunk.
   */
  formatArgs?(args: Record<string, unknown>): string;
  /**
   * Optional override for the tool's result content. Same rationale
   * as `formatArgs`. Receives the parsed result (whatever the tool
   * returned from `execute`) - if the tool returned a string, that
   * raw string is the argument. Callers fall back to the generic
   * formatter when this is undefined.
   */
  formatResult?(result: unknown): string;
}

/**
 * OpenAI / Venice wire shape for a tool in the `tools` request array.
 * Derived from `ToolDef` via `toOpenAIToolDef`.
 */
export interface OpenAIToolDef {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

/**
 * OpenAI / Venice wire shape for one item in `choices[0].message.tool_calls`.
 * `arguments` is a JSON-encoded string (not a parsed object) — the model
 * may emit fragments across SSE deltas, so we accumulate then parse once.
 */
export interface OpenAIToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string;
  };
}

/**
 * A named bundle of tools that travel together. Agents and the main
 * chat loop both compose requests against a toolbox; the toolbox is
 * the unit of "here is the capability set this model can reach for".
 *
 * Deliberately spare: no toggle semantics, no prompt-catalog helper,
 * no per-tool enable flags. The main chat loop wraps its toolbox with
 * a gate (`toggle_tools`) and a prompt-catalog fragment because that's
 * chat-specific UX — an agent that always runs with its full kit
 * doesn't need either. Callers layer those concerns on top of the
 * primitive rather than fighting to unset them.
 *
 * `name` identifies the toolbox for error messages and debug logs;
 * `description` is human-readable prose an agent can stitch into its
 * own system prompt if it wants to advertise the capability set.
 */
export interface Toolbox {
  readonly name: string;
  readonly description: string;
  readonly tools: readonly ToolDef[];
}
