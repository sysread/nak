// toggle_toolbox (function-side port)
//
// Replaces threads.toolboxes_enabled with a new set of gated toolbox
// names the model wants armed. Wire schema lives in
// src/lib/tools/toggle_tools.schema.ts; the catalog itself lives in
// src/lib/tools/index.ts (TOOLBOXES + GATED_TOOLBOX_NAMES).
//
// Why the gated-toolbox name list is duplicated here: importing the
// browser catalog from a Deno function would drag the whole tool
// graph (schemas, definitions, sub-agent classes) across the
// boundary, which defeats the purpose of separate runtimes. The list
// is small and changes rarely; when it does change, both sides land
// in the same PR via the schema-sync deploy gate so there is no
// sync window.
//
// Validation rules mirror the browser: silently drop the always_on
// name (implicit, cannot be disabled), silently drop unknown names,
// silently dedupe. The tool's return value (the accepted set) lets
// the model self-correct on the next call - throwing on a typo would
// abort the chat turn for a recoverable mistake.

import { requireThreadId, registerTool, type ToolContext, type ToolDef } from '../performToolCall.ts';

// Mirror of GATED_TOOLBOX_NAMES in src/lib/tools/index.ts. Keep in
// sync when adding / removing a toolbox; same-PR landing is the
// expected discipline.
const GATED_TOOLBOX_NAMES = new Set<string>([
  'cooking',
  'memories',
  'wiki',
  'library',
  'images',
]);

// Mirror of alwaysOnToolbox.name in src/lib/tools/index.ts.
const ALWAYS_ON_NAME = 'always_on';

export const toggleToolbox: ToolDef = {
  name: 'toggle_toolbox',
  async execute(args: Record<string, unknown>, ctx: ToolContext) {
    const raw = Array.isArray(args.enabled) ? (args.enabled as unknown[]) : [];
    const seen = new Set<string>();
    const accepted: string[] = [];
    for (const item of raw) {
      if (typeof item !== 'string') continue;
      if (item === ALWAYS_ON_NAME) continue;
      if (!GATED_TOOLBOX_NAMES.has(item)) continue;
      if (seen.has(item)) continue;
      seen.add(item);
      accepted.push(item);
    }

    // RLS OFF: filter by userId. Service-role bypasses RLS so the
    // explicit user_id filter is the only guard against writing
    // another user's thread state. The threadId-belongs-to-userId
    // invariant from the /stream entry probe still holds; this is
    // belt-and-braces.
    //
    // Note: deliberately not touching updated_at - a toolbox flip
    // shouldn't promote the thread to the top of the drawer, same
    // rationale as the browser-side setThreadToolboxesEnabled.
    const { error } = await ctx.adminClient
      .from('threads')
      .update({ toolboxes_enabled: accepted })
      .eq('id', requireThreadId(ctx))
      .eq('user_id', ctx.userId);
    if (error) throw new Error(`setThreadToolboxesEnabled failed: ${error.message}`);

    return { enabled: accepted };
  },
};

registerTool(toggleToolbox);
