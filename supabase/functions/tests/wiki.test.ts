// Guards for the autonomous wiki agent's safety-critical composition.
//
// The browser used to assert these against the wiki worker's toolbox,
// agent, and prompt; those moved server-side when the wiki fleet
// migrated into the edge function, so the invariants live here now:
//
//   - The toolbox is wiki CRUD plus READ-ONLY memory access. The wiki
//     agent grounds articles in facts the reflection agent extracted,
//     but memory mutations stay owned by reflection and the user - no
//     memory write tools, and never memory_delete.
//   - ask_user is absent: a background agent has no UI surface to
//     render a clarifying question to.
//   - The content-classifier sentinel match stays narrow: only
//     Venice's "inappropriate content" rejection triggers the
//     uncensored-fallback retry; generic 400s/500s must not.
//   - The prompt's "About the user" block carries the
//     anti-name-fabrication rules (production regression: the model
//     once named the user after a friend mentioned in conversation).
//
// Pure: every helper under test assembles strings/objects from
// already-registered ToolDefs, no DB or network.

import { assertEquals, assertStringIncludes } from '@std/assert';
import { __test } from '../venice/agents/wiki.ts';

Deno.test('wiki toolbox is wiki CRUD + full record management + memory_search, in declared order', () => {
  const toolbox = __test.buildWikiToolbox();
  assertEquals(toolbox.name, 'wiki');
  // record_list reads the journey (to promote learnings into the body and
  // to dedup before migrating); record_create is scoped to MIGRATION only
  // (relocating inline dated history out of a body into records - new-event
  // capture stays with the extraction agent); record_update / record_delete
  // are opportunistic cleanup on the records of articles the worker is
  // already touching (correct/merge/dedup), same discipline as the
  // librarian.
  assertEquals(
    toolbox.tools.map((t) => t.name),
    [
      'wiki_search',
      'wiki_create',
      'wiki_update',
      'wiki_delete',
      'record_list',
      'record_create',
      'record_update',
      'record_delete',
      'memory_search',
    ],
  );
});

Deno.test('wiki toolbox manages records (list/create/update/delete) but never extracts new events', () => {
  const names = __test.buildWikiToolbox().tools.map((t) => t.name);
  for (const expected of ['record_list', 'record_create', 'record_update', 'record_delete']) {
    assertEquals(names.includes(expected), true, `${expected} must be reachable`);
  }
});

Deno.test('wiki toolbox excludes memory writes, hard-deletes, and the UI tool', () => {
  const names = __test.buildWikiToolbox().tools.map((t) => t.name);
  for (const forbidden of [
    'memory_create',
    'memory_update',
    'memory_invalidate',
    'memory_reaffirm',
    'memory_doubt',
    'memory_relate',
    'memory_unrelate',
    'memory_delete',
    'ask_user',
  ]) {
    assertEquals(names.includes(forbidden), false, `${forbidden} must not be reachable`);
  }
});

Deno.test('every wiki tool carries a wire schema whose name matches', () => {
  // The agent driver ships toolbox.tools[].wire to Venice; a wire whose
  // function.name disagreed with the dispatch name would 400 the round
  // or silently never match the model's call.
  for (const tool of __test.buildWikiToolbox().tools) {
    assertEquals(tool.wire.type, 'function');
    assertEquals(tool.wire.function.name, tool.name);
  }
});

Deno.test('content-filter sentinel matches the Venice classifier rejection only', () => {
  const { isContentFilterRejection } = __test;
  assertEquals(
    isContentFilterRejection(
      new Error(
        'Venice chat/completions 400: {"error":"Input text data may contain inappropriate content.","request_id":"abc"}',
      ),
    ),
    true,
  );
  // Embedded in a longer message still matches.
  assertEquals(
    isContentFilterRejection(
      'something Input text data may contain inappropriate content something',
    ),
    true,
  );
  // A generic 400, a 500, and a network error must stay on the normal
  // failure path - retrying them on the uncensored model would be a
  // wasted call at best and mask a real bug at worst.
  assertEquals(
    isContentFilterRejection(new Error('Venice chat/completions 400: {"error":"unknown param"}')),
    false,
  );
  assertEquals(isContentFilterRejection(new Error('Venice chat/completions 500: upstream')), false);
  assertEquals(isContentFilterRejection(new Error('ECONNRESET')), false);
  assertEquals(isContentFilterRejection(null), false);
  assertEquals(isContentFilterRejection(undefined), false);
});

Deno.test('prompt renders the named-profile block with both name rules', () => {
  const prompt = __test.buildWikiAutonomousPrompt({
    userProfile: { name: 'Jeff', location: 'Raleigh' },
  });
  // Positive rule: prefer the configured name over "the user".
  assertStringIncludes(prompt, '**Use "Jeff" by default when an article refers to the user.**');
  // Negative rule: HARD anti-fabrication wording.
  assertStringIncludes(prompt, 'NEVER invent another name for the user');
  assertStringIncludes(prompt, 'Their location is Raleigh.');
});

Deno.test('prompt suppresses the profile block entirely when unset', () => {
  const bare = __test.buildWikiAutonomousPrompt({ userProfile: null });
  const empty = __test.buildWikiAutonomousPrompt({
    userProfile: { name: '  ', location: '' },
  });
  // The block opens with the literal '**About the user:**' header;
  // the prompt BODY also mentions the block by name (telling the
  // model to consult it "when present"), so the header marker is the
  // thing whose absence proves suppression.
  assertEquals(bare.includes('**About the user:**'), false);
  // Whitespace-only fields are the "not set" sentinel, same as null.
  assertEquals(empty, bare);
});

Deno.test('prompt keeps the anti-fabrication rule on the unknown-name path', () => {
  // Location set, name not: the model must not be told to "use their
  // name" (it has none) but must still be barred from inventing one.
  const prompt = __test.buildWikiAutonomousPrompt({
    userProfile: { name: null, location: 'Raleigh' },
  });
  assertStringIncludes(prompt, 'has not supplied a name');
  assertStringIncludes(prompt, 'NEVER invent a name');
  assertStringIncludes(prompt, 'Their location is Raleigh.');
});

Deno.test('prompt carries no inline-citation guidance', () => {
  // Twin of the browser-side librarian-prompt assertion
  // (tests/wiki-tools.test.ts): wiki articles link sources through the
  // bibliography (wiki_article_sources), not inline ?cid= markdown.
  const prompt = __test.buildWikiAutonomousPrompt({ userProfile: null });
  assertEquals(prompt.includes('?cid='), false);
  assertEquals(prompt.includes('[label](?cid'), false);
  assertEquals(prompt.includes('source-conversation link'), false);
});
