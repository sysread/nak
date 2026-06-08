/**
 * `serverSideTool` - wrap a schema into a ToolDef whose `execute`
 * throws. The dual of `./lazy.ts`'s `lazyTool`: lazyTool defers a
 * live browser impl, serverSideTool declares there is no browser impl
 * at all.
 *
 * A streamed chat turn dispatches its tools in the venice edge
 * function (`performToolCall`), not the browser - see
 * docs/dev/architecture.md "Production-path ownership". The browser
 * still composes the wire `tools` array (schemas) via `buildToolList`,
 * so every chat tool needs a ToolDef to ride that array. But the
 * impl half lives server-side under
 * `supabase/functions/venice/tools/<name>.ts`. This helper supplies
 * the schema-only ToolDef: it carries the catalog metadata the wire
 * payload and system prompt read, and an `execute()` that throws if
 * anything reaches it.
 *
 * The throw is the point. `execute()` never runs in production; if a
 * regression re-routes dispatch browser-side it surfaces loudly here
 * (naming the tool and its edge home) instead of silently running
 * stale logic that has drifted from the live edge implementation.
 *
 * Contrast `lazyTool`, used for the tools whose browser `execute()` is
 * still live (the background agent fleets dispatch their toolboxes
 * browser-side via `executeToolboxCall`). Those keep a real impl
 * module loaded on first dispatch; these have none to load.
 */
import type { ToolDef } from './types';

export function serverSideTool(schema: Omit<ToolDef, 'execute'>): ToolDef {
  return {
    ...schema,
    execute() {
      throw new Error(
        `${schema.name} executes server-side in the venice edge function ` +
          `(supabase/functions/venice/tools/${schema.name}.ts); the browser ` +
          'ToolDef is schema-only. Reaching this means tool dispatch was ' +
          'wrongly routed browser-side.'
      );
    },
  };
}
