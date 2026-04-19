/**
 * Shared types for the tool-calling subsystem. The shape of `ToolDef` is
 * what the rest of the app reads from; `toOpenAIToolDef()` in `./index.ts`
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
import type { VeniceClient } from '../venice';

export interface ToolContext {
  supabase: SupabaseService;
  /**
   * Same VeniceClient the chat loop is using — tools that need to call
   * Venice directly (e.g. memory_search embeds the query before running
   * the similarity RPC) reach for this one rather than constructing a
   * second client with a duplicated API key in memory.
   */
  venice: VeniceClient;
  userId: string;
  threadId: string;
  signal: AbortSignal;
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
