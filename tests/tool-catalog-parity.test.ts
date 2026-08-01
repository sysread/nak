/**
 * Cross-runtime parity for mid-turn toolbox rearming.
 *
 * The browser builds the first round's wire `tools` array with
 * buildToolList and ships the full catalog (buildToolCatalog) in the
 * /stream envelope; the venice orchestrator rebuilds `tools` from that
 * catalog (buildToolsFromCatalog in
 * supabase/functions/venice/tool_catalog.ts) after a mid-turn
 * toggle_toolbox. The whole point of the rearm is that the rebuilt
 * array is what buildToolList WOULD have produced had the toggle
 * happened before the turn - so this suite pins that equivalence for
 * every enabled-set shape, plus the catalog invariants the server
 * relies on (key order, membership).
 *
 * The server module is deliberately dependency-free so it can be
 * imported here directly - no Deno-only imports to drag in, unlike the
 * toggle mirror (tests/toggle-toolbox-mirror.test.ts), which has to
 * parse its edge file as text.
 */
import { describe, it, expect } from 'vitest';
import {
  buildToolList,
  buildToolCatalog,
  GATED_TOOLBOX_NAMES,
  alwaysOnToolbox,
  type Toolbox,
} from '../src/lib/tools';
import { serverSideTool } from '../src/lib/tools/server_side';
import { buildToolsFromCatalog } from '../supabase/functions/venice/tool_catalog';

// A fake connected MCP integration, shaped the way buildMcpToolboxes
// produces them (name prefixed `mcp:`, schema-only tools).
const mcpBox: Toolbox = {
  name: 'mcp:fake-integration',
  description: 'Fake integration for parity coverage',
  tools: [
    serverSideTool({
      name: 'mcp:fake-integration:send_thing',
      description: 'Send a thing',
      shortDescription: 'send a thing',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
    }),
  ],
};

describe('buildToolCatalog', () => {
  it('carries every gated toolbox under its own name, in TOOLBOXES order', () => {
    const catalog = buildToolCatalog();
    expect(Object.keys(catalog.gated)).toEqual([...GATED_TOOLBOX_NAMES]);
  });

  it('appends MCP toolboxes after the static boxes', () => {
    const catalog = buildToolCatalog([mcpBox]);
    expect(Object.keys(catalog.gated)).toEqual([
      ...GATED_TOOLBOX_NAMES,
      mcpBox.name,
    ]);
  });

  it('always-on defs match the wire projection of alwaysOnToolbox', () => {
    const catalog = buildToolCatalog();
    expect(catalog.alwaysOn.map((d) => d.function.name)).toEqual(
      alwaysOnToolbox.tools.map((t) => t.name),
    );
    // The defs must be full wire projections (activity param included),
    // because the server puts them on `body.tools` verbatim.
    for (const def of catalog.alwaysOn) {
      const params = def.function.parameters as {
        properties?: Record<string, unknown>;
        required?: unknown[];
      };
      expect(params.properties).toHaveProperty('activity');
      expect(params.required).toContain('activity');
    }
  });
});

describe('server rebuild parity with buildToolList', () => {
  const enabledSets: readonly (readonly string[])[] = [
    [],
    ['followups'],
    ['cooking', 'memories'],
    [...GATED_TOOLBOX_NAMES],
    ['followups', 'no_such_box'],
    [mcpBox.name],
    ['wiki', mcpBox.name],
  ];

  for (const enabled of enabledSets) {
    it(`rebuild equals buildToolList for [${enabled.join(', ')}]`, () => {
      const catalog = buildToolCatalog([mcpBox]);
      expect(buildToolsFromCatalog(catalog, enabled)).toEqual(
        buildToolList(enabled, [mcpBox]),
      );
    });
  }
});
