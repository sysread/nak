// R1 guard: the squash-rebase artifact in 5eee96fa reverted the M9
// retired-name prose sweep and put dead tool names back into the wiki
// agents' model-facing surfaces - the prompt taught the model to call
// record_create / wiki_search while the toolbox registers the `wiki` /
// `records` op-enum combos, so a model following its instructions
// called tools that do not exist. This pin asserts every wiki agent's
// model-facing text (the FULL serialized wire schema, not just the
// top-level description - property descriptions have carried retired
// names too - plus the prompt bodies, each scanned whitespace-stripped
// so a retired name split across a line break is still caught) names
// no retired tool.
//
// This is a BLACKLIST, not an allowlist: it fails when a scanned
// surface names a retired verb tool. It cannot catch a NEW tool name
// drifting out of registration - the discipline is: when a tool
// retires into a combo, ADD its name here. A non-vacuity canary below
// keeps the scan meaningful if a toolbox builder ever comes back
// empty.
//
// Internal comments may still discuss the history; the model never
// reads them.

import { assertEquals } from '@std/assert';
import { __test as extraction } from '../venice/agents/wiki_records.ts';
import { __test as article } from '../venice/agents/wiki.ts';
import { __test as librarian } from '../venice/agents/wiki_librarian.ts';
import { __test as recall } from '../venice/agents/wiki_recall.ts';

// Retired verb-tool names. The wiki_* names were retired into the
// `wiki` combo (op=search / save / delete); the record_* names into
// the `records` combo (op=list / get / search / create / update /
// delete). record_link_create / record_link_delete / record_file_*
// are NOT retired - they remain registered verb tools.
const RETIRED_NAMES = [
  'wiki_search',
  'wiki_list',
  'wiki_save',
  'wiki_delete',
  'wiki_get',
  'wiki_create',
  'wiki_update',
  'record_list',
  'record_create',
  'record_get',
  'record_search',
  'record_update',
  'record_delete',
] as const;

// The full serialized wire schema (descriptions at every level) plus
// the prompt, whitespace-stripped so "wiki_" at a line end followed by
// "search" on the next still reads as the retired name.
function surfaces(texts: string[]): string[] {
  return texts.map((t) => t.replace(/\s+/g, ''));
}

Deno.test('canary: every scanned toolbox builder returns tools (non-vacuity)', () => {
  for (const [name, tools] of [
    ['extraction', extraction.buildWikiRecordsToolbox().tools],
    ['article', article.buildWikiToolbox().tools],
    ['librarian', librarian.buildLibrarianToolbox().tools],
  ] as const) {
    assertEquals(tools.length > 0, true, `${name} toolbox came back empty - the scan below would pass vacuously`);
  }
  // The recall agent's scan surface is its wire schema + prompt.
  assertEquals(typeof recall.BASE_PROMPT, 'string');
  assertEquals(recall.WIKI_SEARCH_WIRE_SCHEMA.function.name, 'wiki');
});

Deno.test('extraction agent: prompt + full wire schemas name no retired tool', () => {
  const texts = [
    ...extraction.buildWikiRecordsToolbox().tools.map((t) => JSON.stringify(t.wire)),
    extraction.WIKI_RECORDS_PROMPT,
  ];
  for (const text of surfaces(texts)) {
    for (const name of RETIRED_NAMES) {
      assertEquals(text.includes(name), false, `retired tool name "${name}" in extraction surface`);
    }
  }
});

Deno.test('article agent: prompt + full wire schemas name no retired tool', () => {
  const texts = [
    ...article.buildWikiToolbox().tools.map((t) => JSON.stringify(t.wire)),
    article.buildWikiAutonomousPrompt(),
  ];
  for (const text of surfaces(texts)) {
    for (const name of RETIRED_NAMES) {
      assertEquals(text.includes(name), false, `retired tool name "${name}" in article-agent surface`);
    }
  }
});

Deno.test('librarian agent: prompt + full wire schemas name no retired tool', () => {
  const prompt = librarian.buildWikiLibrarianPrompt({ articleList: '(test list)' });
  const texts = [
    ...librarian.buildLibrarianToolbox().tools.map((t) => JSON.stringify(t.wire)),
    prompt,
  ];
  for (const text of surfaces(texts)) {
    for (const name of RETIRED_NAMES) {
      assertEquals(text.includes(name), false, `retired tool name "${name}" in librarian surface`);
    }
  }
});

Deno.test('recall agent: prompt + wire schema name no retired tool', () => {
  const texts = surfaces([
    recall.BASE_PROMPT,
    JSON.stringify(recall.WIKI_SEARCH_WIRE_SCHEMA),
  ]);
  for (const text of texts) {
    for (const name of RETIRED_NAMES) {
      assertEquals(text.includes(name), false, `retired tool name "${name}" in recall surface`);
    }
  }
});
