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

// Hand-maintained MIRROR of GATED_TOOLBOX_NAMES in
// src/lib/tools/index.ts (the source of truth). Toggle dispatch is
// server-side, and this Deno module can't import the browser barrel, so
// the gated-toolbox names are duplicated here. A name the model toggles
// that is absent from this Set is silently dropped (the accept loop
// below filters on it), so a stale mirror manifests as "the toolbox
// can't be enabled" - the model toggles a real toolbox name and the
// toggle returns `enabled: []` because this Set never heard of it.
//
// DRIFT GUARD: tests/toggle-toolbox-mirror.test.ts (vitest) reads this
// literal as text and asserts it equals the browser GATED_TOOLBOX_NAMES,
// so adding a toolbox in only one place fails the gate. Keep the Set
// literal a flat list of quoted strings so that parser keeps working.
//
// DYNAMIC MCP TOOLBOXES: this Set only covers the STATIC built-in
// toolboxes. Connected MCP integrations become per-user toolboxes named
// `mcp:<integrationId>` (see src/lib/ui/mcp.ts mcpIntegrationToolboxName),
// which can't be enumerated here - the ids are runtime-discovered per
// user. The accept loop below additionally passes any `mcp:`-prefixed
// name through, so the model can toggle a connected integration on
// without this Set knowing about it. The integration must exist and be
// authorized for its tools to actually dispatch (performToolCall
// resolves `mcp:` names against mcp_integrations); a bogus id just
// yields an empty toolbox that ships no tools.
const GATED_TOOLBOX_NAMES = new Set<string>([
  'cooking',
  'memories',
  'wiki',
  'followups',
  'library',
  'images',
]);

// Mirror of alwaysOnToolbox.name in src/lib/tools/index.ts.
const ALWAYS_ON_NAME = 'always_on';

// Prefix for dynamic MCP-integration toolboxes (see the note above).
// Kept as a constant so the accept loop and any future audit grep the
// same token the browser uses in mcpIntegrationToolboxName.
const MCP_TOOLBOX_PREFIX = 'mcp:';

export const toggleToolbox: ToolDef = {
  name: 'toggle_toolbox',
  async execute(args: Record<string, unknown>, ctx: ToolContext) {
    const raw = Array.isArray(args.enabled) ? (args.enabled as unknown[]) : [];
    const seen = new Set<string>();
    const accepted: string[] = [];
    for (const item of raw) {
      if (typeof item !== 'string') continue;
      if (item === ALWAYS_ON_NAME) continue;
      // Static built-in toolbox, OR a dynamic `mcp:<id>` integration
      // toolbox. The static Set is the source of truth for built-ins;
      // the prefix check is the runtime-discovered hatch for MCP
      // integrations the static list can't enumerate.
      if (!GATED_TOOLBOX_NAMES.has(item) && !item.startsWith(MCP_TOOLBOX_PREFIX)) {
        continue;
      }
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
