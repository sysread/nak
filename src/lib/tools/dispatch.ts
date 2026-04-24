/**
 * Toolbox-scoped dispatch helpers - the three pure functions that
 * project a `Toolbox` onto the Venice wire shape and execute a named
 * call against one. Factored out of `./index.ts` so agent workers
 * (reflection in particular) can import them without dragging in the
 * full tool catalog.
 *
 * The barrel `./index.ts` statically imports `research_docs`, which
 * reaches into `src/lib/docs.ts` whose non-eager `import.meta.glob`
 * over docs/user/**\/*.md forces code-splitting on the per-doc
 * chunks. That's incompatible with Vite's default IIFE worker output
 * format and crashes the production build with
 * `Invalid value "iife" for option "output.format" - UMD and IIFE
 * output formats are not supported for code-splitting builds.`
 *
 * Keeping these helpers in a file that reaches only for types lets
 * `./run.ts` (used by the reflection agent worker) stay on the
 * IIFE-safe side of the import graph.
 */
import type {
  ToolDef,
  Toolbox,
  OpenAIToolDef,
  ToolContext,
  ToolResult,
} from './types';

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
 * OpenAI / Venice wire shape for every tool in a toolbox, in declared
 * order. Order matters only for human readability - the model
 * addresses tools by name - but preserving it keeps diffs and logs
 * predictable.
 */
export function buildToolboxWireList(toolbox: Toolbox): OpenAIToolDef[] {
  return toolbox.tools.map(toOpenAIToolDef);
}

/**
 * Dispatch a tool call against a specific toolbox. Unknown names
 * throw with the toolbox name included so errors from e.g. the memory
 * agent don't look identical to errors from the main chat - useful
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
