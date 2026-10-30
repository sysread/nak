// Barrel-membership net for the function-side tool registry.
//
// A tool module forgotten in venice/tools/index.ts's side-effect
// imports produces no load-time error anywhere: the browser still
// declares the tool on the wire, the model still calls it, and
// performToolCall throws ToolNotImplementedError at dispatch - a gap
// no other gate stage catches (vitest never sees Deno code, and
// `supabase functions deploy` bundles without type-checking). This
// test imports the barrel - the same side-effect surface the venice
// function's orchestrator pulls in - and asserts the registrations
// landed, with the skills combination tool as the pinned member.
//
// Pure: importing the barrel runs only module-load registrations; no
// DB, no network.

import { assert } from '@std/assert';
import '../venice/tools/index.ts';
import { listRegisteredTools } from '../venice/performToolCall.ts';

Deno.test('the tool barrel registers the skills combination tool', () => {
  const names = listRegisteredTools();
  assert(
    names.includes('skills'),
    `skills missing from the registry; the barrel import line was probably forgotten. Registered: ${names.join(', ')}`,
  );
});

// Floor count, not an exact match. The registry total is the
// barrel's import lines plus the modules that register several tools
// under one line (recipe_photos.ts registers four), so equality with
// the line count never holds. The floor still catches the failure
// class this net exists for: registrations going missing (a module
// edited to drop its registerTool call, or a barrel line whose
// import resolves to nothing). Bump the floor alongside any change
// that removes tools; additions need nothing.
const MIN_REGISTERED_TOOLS = 68;

Deno.test(`the registry carries at least ${MIN_REGISTERED_TOOLS} registrations`, () => {
  const names = listRegisteredTools();
  assert(
    names.length >= MIN_REGISTERED_TOOLS,
    `registry holds ${names.length} tools, below the floor of ${MIN_REGISTERED_TOOLS}; registrations have gone missing`,
  );
});
