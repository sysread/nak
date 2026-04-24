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
 * Schema for the `activity` parameter we inject into every tool's
 * arguments. The LLM fills it with a short present-tense sentence
 * narrating what this specific call is doing; the chat UI surfaces the
 * sentence above the tool name while the call is in flight and after
 * it completes, so the user sees a plain-language trace of the model's
 * moves instead of a wall of schema calls. Kept deliberately terse so
 * the model doesn't pad it into a paragraph.
 *
 * Parameter name `activity` rather than `note` to avoid colliding with
 * memory_relate's existing `note` argument (the edge annotation). Names
 * this module owns are invisible to tool handlers — injected into the
 * wire schema here, ignored by every handler that reads specific keys.
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
 * Merge the shared `activity` property into a tool's JSON Schema
 * without mutating the original. We inject at the wire-projection
 * layer rather than forcing every ToolDef to declare it, so adding a
 * new tool doesn't require remembering the convention. `activity` is
 * added to `required` so the model can't silently omit it, and the
 * rest of the schema (including `additionalProperties: false`) rides
 * through untouched.
 */
function injectActivityParam(
  parameters: Record<string, unknown>
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...parameters };
  const existing = (out.properties as Record<string, unknown> | undefined) ?? {};
  out.properties = { ...existing, activity: ACTIVITY_PARAM_SCHEMA };
  const required = Array.isArray(out.required)
    ? [...(out.required as unknown[])]
    : [];
  if (!required.includes('activity')) required.push('activity');
  out.required = required;
  // If the tool's schema didn't declare `type`, default it to 'object'
  // so `properties` / `required` are meaningful to the model. Tools in
  // this codebase all declare `type: 'object'`, but test fixtures
  // sometimes ship `parameters: {}` - keep them valid.
  if (out.type === undefined) out.type = 'object';
  return out;
}

/**
 * Translate a ToolDef into the OpenAI / Venice request shape. Venice
 * mirrors OpenAI's `/chat/completions` `tools` parameter exactly.
 *
 * We project an `activity` string into every tool's parameters at this
 * seam so the model must narrate what it's doing on every call; see
 * `injectActivityParam` above for the rationale.
 */
export function toOpenAIToolDef(t: ToolDef): OpenAIToolDef {
  return {
    type: 'function',
    function: {
      name: t.name,
      description: t.description,
      parameters: injectActivityParam(t.parameters),
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
