// Offline coverage for the mid-turn toolbox rearm helpers
// (venice/tool_catalog.ts): the envelope boundary coercion, the
// tools-array rebuild the orchestrator runs after a successful
// toggle_toolbox, and the toggle-result extraction that feeds it.
// Parity between a rebuild and the browser's buildToolList lives in
// the vitest suite (tests/tool-catalog-parity.test.ts), which can
// import both sides; these tests pin the server-local semantics.
import { assertEquals } from '@std/assert';
import {
  buildToolsFromCatalog,
  coerceToolCatalog,
  enabledSetFromToggleResult,
  type ToolCatalog,
} from '../venice/tool_catalog.ts';

function def(name: string): unknown {
  return { type: 'function', function: { name, description: name, parameters: {} } };
}

const CATALOG: ToolCatalog = {
  alwaysOn: [def('followup_list'), def('web_search')],
  gated: {
    followups: [def('followup_create'), def('followup_close')],
    cooking: [def('recipe_save')],
    'mcp:abc123': [def('mcp:abc123:send_email')],
  },
};

Deno.test('coerceToolCatalog accepts the browser shape', () => {
  const raw = JSON.parse(JSON.stringify(CATALOG));
  const coerced = coerceToolCatalog(raw);
  assertEquals(coerced, CATALOG);
});

Deno.test('coerceToolCatalog rejects malformed shapes with null', () => {
  assertEquals(coerceToolCatalog(undefined), null);
  assertEquals(coerceToolCatalog(null), null);
  assertEquals(coerceToolCatalog('nope'), null);
  assertEquals(coerceToolCatalog([]), null);
  assertEquals(coerceToolCatalog({}), null);
  assertEquals(coerceToolCatalog({ alwaysOn: [], gated: [] }), null);
  assertEquals(coerceToolCatalog({ alwaysOn: [], gated: { a: 'x' } }), null);
  assertEquals(coerceToolCatalog({ alwaysOn: {}, gated: {} }), null);
});

Deno.test('buildToolsFromCatalog: always-on only when nothing enabled', () => {
  const tools = buildToolsFromCatalog(CATALOG, []);
  assertEquals(tools, CATALOG.alwaysOn);
});

Deno.test('buildToolsFromCatalog: enabled boxes append in catalog order', () => {
  // Enabled order in the toggle result does not matter - catalog key
  // order wins, matching buildToolList's TOOLBOXES iteration.
  const tools = buildToolsFromCatalog(CATALOG, ['cooking', 'followups']);
  assertEquals(tools, [
    ...CATALOG.alwaysOn,
    ...CATALOG.gated.followups,
    ...CATALOG.gated.cooking,
  ]);
});

Deno.test('buildToolsFromCatalog: unknown enabled names are ignored', () => {
  const tools = buildToolsFromCatalog(CATALOG, ['no_such_box', 'followups']);
  assertEquals(tools, [...CATALOG.alwaysOn, ...CATALOG.gated.followups]);
});

Deno.test('buildToolsFromCatalog: mcp boxes rebuild like static ones', () => {
  const tools = buildToolsFromCatalog(CATALOG, ['mcp:abc123']);
  assertEquals(tools, [...CATALOG.alwaysOn, ...CATALOG.gated['mcp:abc123']]);
});

Deno.test('buildToolsFromCatalog: duplicate names dedupe first-seen', () => {
  const catalog: ToolCatalog = {
    alwaysOn: [def('shared')],
    gated: { box: [def('shared'), def('unique')] },
  };
  const tools = buildToolsFromCatalog(catalog, ['box']);
  assertEquals(tools, [def('shared'), def('unique')]);
});

Deno.test('buildToolsFromCatalog: nameless defs pass through undeduped', () => {
  const blob = { type: 'function' };
  const catalog: ToolCatalog = { alwaysOn: [blob, blob], gated: {} };
  assertEquals(buildToolsFromCatalog(catalog, []), [blob, blob]);
});

Deno.test('enabledSetFromToggleResult reads the toggle result shape', () => {
  assertEquals(enabledSetFromToggleResult({ enabled: ['followups'] }), [
    'followups',
  ]);
  assertEquals(enabledSetFromToggleResult({ enabled: [] }), []);
});

Deno.test('enabledSetFromToggleResult rejects other shapes with null', () => {
  assertEquals(enabledSetFromToggleResult(null), null);
  assertEquals(enabledSetFromToggleResult('enabled'), null);
  assertEquals(enabledSetFromToggleResult({}), null);
  assertEquals(enabledSetFromToggleResult({ enabled: 'followups' }), null);
  assertEquals(enabledSetFromToggleResult({ enabled: [1] }), null);
});
