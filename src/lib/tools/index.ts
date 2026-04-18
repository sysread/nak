/**
 * Tool registry — the list of every function the LLM can invoke in this
 * app, plus the helpers that turn that list into wire-shaped payloads.
 *
 * Responsibility split:
 *   - Each tool file (./toggle_tools.ts, ./memory_*.ts, …) exports a
 *     single ToolDef describing what it does and how to run it.
 *   - This file composes them into TOOLS, resolves names to defs, and
 *     projects them into the OpenAI / Venice request shape.
 *   - The orchestration loop in `../chat-loop.ts` (next commit) is the
 *     only caller that invokes executeToolCall() — no other module
 *     should reach directly into a tool's execute() handler.
 *
 * Toggle semantics: `toggle_tools` is always included in the request; the
 * other tools are included only when the thread's `tools_enabled`
 * column is true. `buildToolList()` encodes that rule.
 */
import type { ToolDef, OpenAIToolDef, ToolContext, ToolResult } from './types';
import { toggleTools } from './toggle_tools';
import { memorySearch } from './memory_search';
import { memoryCreate } from './memory_create';
import { memoryUpdate } from './memory_update';
import { memoryDelete } from './memory_delete';

/** Every tool, including the always-on meta-tool at index 0. */
export const TOOLS: readonly ToolDef[] = [
  toggleTools,
  memorySearch,
  memoryCreate,
  memoryUpdate,
  memoryDelete,
];

/** Tools that are gated behind the `tools_enabled` master switch. */
const GATED_TOOLS: readonly ToolDef[] = TOOLS.filter((t) => t.name !== toggleTools.name);

/** The always-on tool, available in every request. */
const ALWAYS_ON: readonly ToolDef[] = [toggleTools];

function byName(name: string): ToolDef | undefined {
  return TOOLS.find((t) => t.name === name);
}

/**
 * Translate a ToolDef into the OpenAI / Venice request shape. Venice
 * mirrors OpenAI's `/chat/completions` `tools` parameter exactly.
 */
export function toOpenAIToolDef(t: ToolDef): OpenAIToolDef {
  return {
    type: 'function',
    function: {
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    },
  };
}

/**
 * The tools array we send with a request, respecting the thread's
 * enabled flag. When disabled, only toggle_tools rides along; when
 * enabled, the full set does.
 */
export function buildToolList(toolsEnabled: boolean): OpenAIToolDef[] {
  const active = toolsEnabled ? TOOLS : ALWAYS_ON;
  return active.map(toOpenAIToolDef);
}

/**
 * The system-prompt catalog fragment listing every tool by name plus a
 * short blurb. Built from the registry so adding a tool automatically
 * extends the advertised capability. Format tuned to be cheap in
 * tokens — one line per tool, no JSON ceremony.
 */
export function buildToolCatalog(): string {
  const lines = GATED_TOOLS.map((t) => `- ${t.name} : ${t.shortDescription}`);
  return [
    'You have access to tools, but they are disabled by default to keep',
    'your context window small. Call `toggle_tools({enable: true})` before',
    'using any of the tools below, and `toggle_tools({enable: false})` when',
    "you're done with them. If the user's request clearly doesn't need",
    "tools, don't enable them at all.",
    '',
    'Available tools (hidden until you toggle on):',
    ...lines,
  ].join('\n');
}

/**
 * Dispatch a single tool call by name. Unknown tools throw so the caller
 * can surface a clear error back to the model as a tool-result message.
 */
export async function executeToolCall(
  name: string,
  args: Record<string, unknown>,
  ctx: ToolContext
): Promise<ToolResult> {
  const tool = byName(name);
  if (!tool) throw new Error(`Unknown tool: ${name}`);
  return tool.execute(args, ctx);
}

export { toggleTools };
export type { ToolDef, OpenAIToolDef, ToolContext, ToolResult } from './types';
export type { OpenAIToolCall } from './types';
