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
import type { ToolDef, OpenAIToolDef, ToolContext, ToolResult, Toolbox } from './types';
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
 * Catalog options. `webSearch` controls whether the prompt mentions
 * Venice's server-side web-search augmentation; without that hint the
 * model reads the gated-tool list as exhaustive and refuses requests
 * like "look up X online" even when `venice_parameters.enable_web_search`
 * is set to 'auto' on the wire. In `auto` mode Venice only runs the
 * search if the model decides to — which it won't, if it thinks it
 * can't.
 */
export interface ToolCatalogOptions {
  webSearch?: boolean;
}

/**
 * The system-prompt catalog fragment listing every tool by name plus a
 * short blurb. Built from the registry so adding a tool automatically
 * extends the advertised capability. Format tuned to be cheap in
 * tokens — one line per tool, no JSON ceremony.
 *
 * The optional `webSearch` hint is additive — the Venice server runs
 * the search itself when the model signals intent, so we don't list
 * web search alongside our own tools (there's no function name or
 * JSON schema to emit for it). We just tell the model the capability
 * is available.
 */
export function buildToolCatalog(opts: ToolCatalogOptions = {}): string {
  const lines = GATED_TOOLS.map((t) => `- ${t.name} : ${t.shortDescription}`);
  const out: string[] = [
    'You have access to tools, but they are disabled by default to keep',
    'your context window small. Call `toggle_tools({enable: true})` before',
    'using any of the tools below, and `toggle_tools({enable: false})` when',
    "you're done with them. If the user's request clearly doesn't need",
    "tools, don't enable them at all.",
    '',
    'Available tools (hidden until you toggle on):',
    ...lines,
  ];
  if (opts.webSearch) {
    out.push(
      '',
      'You can also search the live web for up-to-date information.',
      'When a question benefits from current facts (news, prices, releases,',
      'anything past your training cutoff), answer as if you have live',
      'web access — the Venice platform runs the search for you and feeds',
      'the results back in with citations. Do NOT say you lack internet',
      'access. There is no tool to call for this; just answer normally.'
    );
  }
  return out.join('\n');
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

/**
 * The toolbox the memory-reflection agent (and any future memory-only
 * agent) will ship to its model. Same four CRUD handlers the main chat
 * exposes — minus `toggle_tools`, which is a chat-UX concern: agents
 * don't need a context-window gate because their prompts and tool
 * schemas aren't shared with the user-facing conversation.
 */
export const memoryToolbox: Toolbox = {
  name: 'memory',
  description:
    'Create, read, update, and delete the signed-in user\'s memories. ' +
    'Vector + text search is available via memory_search.',
  tools: [memorySearch, memoryCreate, memoryUpdate, memoryDelete],
};

/**
 * OpenAI / Venice wire shape for every tool in a toolbox, in declared
 * order. Order matters only for human readability — the model
 * addresses tools by name — but preserving it keeps diffs and logs
 * predictable.
 */
export function buildToolboxWireList(toolbox: Toolbox): OpenAIToolDef[] {
  return toolbox.tools.map(toOpenAIToolDef);
}

/**
 * Dispatch a tool call against a specific toolbox. Unknown names
 * throw with the toolbox name included so errors from e.g. the memory
 * agent don't look identical to errors from the main chat — useful
 * when two surfaces share tool names but not toolboxes.
 */
export async function executeToolboxCall(
  toolbox: Toolbox,
  name: string,
  args: Record<string, unknown>,
  ctx: ToolContext
): Promise<ToolResult> {
  const tool = toolbox.tools.find((t) => t.name === name);
  if (!tool) throw new Error(`Unknown tool in toolbox '${toolbox.name}': ${name}`);
  return tool.execute(args, ctx);
}

export { toggleTools };
export type { ToolDef, OpenAIToolDef, ToolContext, ToolResult, Toolbox } from './types';
export type { OpenAIToolCall } from './types';
