// performToolCall ------------------------------------------------------------
//
// Function-side single-tool dispatcher. The orchestrator
// (getStreamingResponse) calls this with each ToolCallRequest the
// streaming Venice completion emits; the returned value becomes the
// content of the tool-result row persisted on the DB.
//
// Two concerns are intentionally NOT in this file:
//
//   - The concrete tool implementations. They live in sibling
//     tools/*.ts modules that self-register via registerTool() (pulled
//     in for side effect by tools/index.ts). This file is just the
//     dispatch shape the orchestrator calls against. The browser keeps
//     only schema modules under src/lib/tools/*.schema.ts - every
//     dispatch (streamed chat turns AND the background agents'
//     headless loops in agents/_run.ts) happens HERE; the browser's
//     role is composing the wire `tools` array the request carries.
//   - The model arming / toolbox catalog. Which tools a turn can
//     reach is decided at request-shape time (browser composes the
//     `tools` array against thread.toolboxes_enabled) and the chosen
//     set lands on Venice's `tools` request field. This dispatcher
//     just runs whatever the model called; the catalog gate is upstream.
//
// Why no shared ToolContext / ToolDef with the browser side: the
// browser's ToolContext carries `supabase: SupabaseService` (the
// session-JWT-scoped client wrapper). The function side has a service-
// role admin client and an explicit user id under b-strict (see
// docs/dev/edge-function-auth.md). The shapes diverge enough that
// muxing them under one interface would force one side to inherit the
// other's awkwardness; better to have two interfaces both honoring
// the same external contract (the tool's `execute(args, ctx)` signature).
//
// Each Deno-ported tool will need its browser equivalent's
// `ctx.supabase.foo()` calls rewritten as `ctx.adminClient.from('...')...`
// with `// RLS OFF: filter by userId` discipline on every direct query.
// Tools that go through SECURITY DEFINER RPCs (the rec*_recall family)
// migrate more cleanly because the RPC already owns the user-scope
// check.

import type { SupabaseClient } from '@supabase/supabase-js';
import type { ToolCallRequest } from '../_shared/venice-stream.ts';
// MCP-routed dispatch is a per-user concern resolved at call time
// from the mcp_integrations cache; imported here rather than
// self-registered into the static REGISTRY because there is no
// single impl - the wire name carries the integration id.
import { dispatchMcpTool, isMcpToolName } from './mcp/dispatch.ts';

/**
 * Per-tool execution context the function side passes into every
 * tool's `execute(args, ctx)`. The shape mirrors the browser's
 * ToolContext minus the SupabaseService wrapper - admin-client +
 * explicit userId is the b-strict equivalent.
 */
export interface ToolContext {
  /**
   * Service-role Supabase client. Bypasses RLS, so every direct query
   * MUST filter by userId. SECURITY DEFINER RPCs are the safer path;
   * use them when one exists for the operation.
   */
  adminClient: SupabaseClient;
  /**
   * Authenticated user id, extracted from the gateway-verified JWT at
   * /stream entry. Authoritative for the whole request lifetime,
   * including after the session JWT itself expires (the function
   * outlives the browser connection by design).
   */
  userId: string;
  /**
   * Thread in scope for this dispatch, or null when there is none.
   * Chat dispatch always carries the real (ownership-gated) thread
   * id. Background librarian agents pass null - they operate across
   * threads with no current one. Tools that genuinely need a thread
   * call requireThreadId(); tools with optional thread behavior
   * (wiki_update's source attribution, conversation_search's
   * self-exclusion) branch on the null.
   */
  threadId: string | null;
  signal: AbortSignal;
  /**
   * Agent-recursion depth. Mirrors the browser-side field; tools that
   * spawn sub-agents stamp incremented values onto the ctx the agent's
   * inner tools see. 0 / undefined = main chat depth. The hard cap
   * lives with the agent dispatcher (not in v1).
   */
  depth?: number;
}

/**
 * What a Deno-side tool implementation looks like. Same external
 * contract as the browser's ToolDef.execute but bound to the function-
 * side ToolContext. The wire-facing name MUST match the browser's
 * tool definition, since both sides are building `tools` arrays
 * against the same model and the model emits whichever name the
 * upstream catalog declared.
 */
export interface ToolDef {
  name: string;
  execute(
    args: Record<string, unknown>,
    ctx: ToolContext,
  ): Promise<unknown>;
}

// Registry is module-scoped. Tools register themselves on module
// load via a side-effect call to registerTool(); the orchestrator
// imports them by symbol so the registration runs before the first
// dispatch. For v1 the registry starts empty - the migration
// inventory tracks which tools land here in what order.
const REGISTRY = new Map<string, ToolDef>();

/**
 * Register a tool. Throws on a duplicate name to surface registration
 * collisions at module-load time rather than as a confusing "wrong
 * tool ran" symptom later.
 */
export function registerTool(def: ToolDef): void {
  if (REGISTRY.has(def.name)) {
    throw new Error(
      `Tool "${def.name}" registered twice on the function side. ` +
        `Check the import graph for a duplicate registerTool() call.`,
    );
  }
  REGISTRY.set(def.name, def);
}

/**
 * The thread id, or a loud error when this dispatch has none. For
 * tools that are chat-only by nature (title renames, attachment
 * lookups scoped to the conversation): a null thread here means a
 * toolbox miswiring handed a thread-scoped tool to a background
 * agent, and a thrown error beats the silent empty-result queries
 * the old empty-string sentinel produced.
 */
export function requireThreadId(ctx: ToolContext): string {
  if (!ctx.threadId) {
    throw new Error(
      'this tool requires a chat-thread context, but the current run has no thread in scope',
    );
  }
  return ctx.threadId;
}

/**
 * Names of every tool registered on this Deno isolate. Used by the
 * /stream handler when it builds the response envelope so the
 * browser can warn (or refuse to send) when the model has tools
 * armed that the function cannot dispatch yet. Also used by tests.
 */
export function listRegisteredTools(): string[] {
  return Array.from(REGISTRY.keys());
}

/**
 * Thrown when the model called a tool whose impl has not been
 * registered on the function side. Distinct from a generic Error so
 * the orchestrator can render a specific "tool not implemented yet"
 * tool_result instead of treating it as an internal failure. During
 * the migration window this is the common case for any tool that
 * has not yet been ported.
 */
export class ToolNotImplementedError extends Error {
  readonly toolName: string;
  constructor(toolName: string) {
    super(
      `Tool "${toolName}" is not implemented on the function side. ` +
        `The tool catalog still lists it because the browser side has not ` +
        `dropped it from buildToolList yet; this is an in-flight migration ` +
        `gap, not a runtime bug.`,
    );
    this.name = 'ToolNotImplementedError';
    this.toolName = toolName;
  }
}

/**
 * Dispatch one ToolCallRequest. Looks up the registered impl, runs
 * its execute() with the parsed args and the ctx, and returns
 * whatever the tool returned. Throws ToolNotImplementedError when no
 * impl is registered for the name; throws whatever the tool's
 * execute() throws otherwise (the orchestrator's try/catch converts
 * both to terminal tool-result rows the model sees on the next round).
 *
 * Does NOT touch the DB itself - the orchestrator persists the
 * tool-result row after this returns. Keeping the dispatcher pure
 * means tests can exercise tool logic with no Supabase admin client
 * by stubbing adminClient on the ctx.
 */
export async function performToolCall(
  request: ToolCallRequest,
  ctx: ToolContext,
): Promise<unknown> {
  const tool = REGISTRY.get(request.name);
  if (tool) return await tool.execute(request.args, ctx);
  // MCP-routed tools are not in the static registry; dispatch via
  // the MCP client. The wire name `mcp:<integrationId>:<tool>`
  // carries the integration pointer; `dispatchMcpTool` resolves it
  // against `ctx.adminClient` + `ctx.userId` (b-strict service-role).
  if (isMcpToolName(request.name)) {
    return await dispatchMcpTool(request, ctx);
  }
  throw new ToolNotImplementedError(request.name);
}
