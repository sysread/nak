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
 *   - execute       : browser-side handler; receives parsed args + context
 *
 * The context is assembled in `chat-loop.ts` at call-time and carries the
 * things a tool might need: the Supabase client (scoped by the signed-in
 * user's JWT, so RLS handles isolation), the user id for explicit writes,
 * the containing thread id (for per-thread toggles), and an AbortSignal
 * that cascades from the outer send() cancellation.
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
  /**
   * Opt-in filter for `wiki_search`: when true, the tool drops any
   * article whose ONLY source row in `wiki_article_sources` is
   * `ctx.threadId`. Articles linked to multiple threads (or to no
   * thread at all) still come through. Set by callers that should not
   * see this thread's own synthesised output echoed back as recall -
   * the main chat-loop and `WikiRecallAgent`'s inner tool loop. Left
   * unset by the autonomous wiki agent and the wiki librarian, both
   * of which need to FIND articles derived from the thread they are
   * processing in order to decide update-vs-create.
   *
   * Carried on the ctx (not in the LLM-visible args schema) so the
   * model cannot pass or strip it - the harness owns the decision.
   * `memories` has no equivalent flag because it lacks source-thread
   * tracking; if a future schema change adds one, the equivalent ctx
   * flag goes here.
   */
  wikiExcludeOwnThreadSoleSources?: boolean;
  /**
   * Opt-in filter for `conversation_search`: when true, the tool
   * drops any hit whose `thread.id` equals `ctx.threadId`. Set by
   * every caller that should be searching OTHER conversations rather
   * than the live one - the main chat-loop and `ConversationRecallAgent`'s
   * inner tool loop. Left unset by callers that are not thread-scoped
   * (e.g. the wiki librarian, which runs over the whole wiki and
   * passes `threadId: ''` - the empty id matches nothing so the
   * filter would be a no-op even if set).
   *
   * Same ctx-vs-args rationale as the wiki flag: the model does not
   * get to control whether its own conversation echoes back as a
   * search hit; the harness makes the call per caller.
   */
  conversationExcludeOwnThread?: boolean;
  /**
   * Opt-in hook for the recall agent's memory_search calls: when set,
   * memory_search invokes it with the ids of every memory it
   * returned. The recall path uses this to feed the rem librarian's
   * hint queue (`memory_conversation`) - memories the recall agent
   * surfaces during a conversation are evidence that they belong
   * together from the user's perspective, even when their similarity
   * neighborhoods don't make that obvious.
   *
   * Best-effort: memory_search wraps the call in a try/catch so a
   * misbehaving recorder can't tear down the search. Carried on the
   * ctx (not in the LLM-visible args schema) so the harness owns the
   * tracking; the model has no signal that a recorder is attached.
   */
  recordRecalledMemoryIds?: (ids: readonly string[]) => void;
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
