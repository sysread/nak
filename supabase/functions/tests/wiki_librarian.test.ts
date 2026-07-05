// Guards for the wiki librarian's safety-critical composition and
// prompt-variant selection. The browser used to assert these against
// the librarian worker's toolbox and prompt module; both moved
// server-side when the fleet migrated, so the invariants live here:
//
//   - The toolbox is reads (wiki_search, conversation_search,
//     conversation_get, memory_search) plus the two wiki writes. NO
//     wiki_create (the librarian consolidates, never invents), no
//     memory writes, no ask_user. conversation_get is what lets the
//     attribution pass read who-said-what, not just a topic summary.
//   - Custom instructions swap the five-step sweep body for the
//     bounded "do this and the coherency fallout, nothing else"
//     variant; an empty/whitespace instructions string falls back to
//     the standard sweep.
//   - The profile block carries the librarian's CORRECTIVE name rules
//     (fixing fabricated names already on disk), and the prompt
//     advertises source_thread_ids rather than inline citations.

import { assertEquals, assertStringIncludes } from '@std/assert';
import { __test } from '../venice/agents/wiki_librarian.ts';

Deno.test('librarian toolbox is reads + wiki/record writes, in declared order', () => {
  const toolbox = __test.buildLibrarianToolbox();
  assertEquals(toolbox.name, 'wikiLibrarian');
  // record_list (read) lets the librarian promote durable learnings from
  // records into bodies and dedup before migrating; record_create is
  // scoped to MIGRATION (relocating inline dated body history into
  // records); record_update / record_delete clean up duplicate/outdated
  // records; record_link_create / record_link_delete wire up and prune
  // continuation chains during the wiki-wide pass. It still has NO
  // wiki_create - it never originates ARTICLES, only consolidates them.
  assertEquals(
    toolbox.tools.map((t) => t.name),
    [
      'wiki_search',
      'conversation_search',
      'conversation_get',
      'memory_search',
      'record_list',
      'wiki_update',
      'wiki_delete',
      'record_create',
      'record_update',
      'record_delete',
      'record_link_create',
      'record_link_delete',
    ],
  );
});

Deno.test('librarian toolbox excludes creation, memory writes, and the UI tool', () => {
  const names = __test.buildLibrarianToolbox().tools.map((t) => t.name);
  for (const forbidden of [
    'wiki_create',
    // File attach needs a conversation to pull the file from; the librarian
    // runs wiki-wide with no thread (asAgentToolNoThread blanks it), so the
    // file tools are unreachable here - they live on the per-thread worker
    // and extraction agents instead.
    'record_file_attach',
    'record_file_remove',
    'memory_create',
    'memory_update',
    'memory_invalidate',
    'memory_delete',
    'ask_user',
  ]) {
    assertEquals(names.includes(forbidden), false, `${forbidden} must not be reachable`);
  }
});

Deno.test('every librarian tool carries a wire schema whose name matches', () => {
  for (const tool of __test.buildLibrarianToolbox().tools) {
    assertEquals(tool.wire.type, 'function');
    assertEquals(tool.wire.function.name, tool.name);
  }
});

Deno.test('empty instructions select the standard five-step sweep body', () => {
  for (const instructions of [undefined, null, '', '   \n  ']) {
    const prompt = __test.buildWikiLibrarianPrompt({
      articleList: '- `Nak` - an app',
      customInstructions: instructions,
    });
    assertStringIncludes(prompt, 'reviewing the user\'s personal wiki as the librarian');
    assertStringIncludes(prompt, 'Scan for out-of-scope articles first');
    assertStringIncludes(prompt, 'from-scratch');
    assertEquals(prompt.includes('custom instructions for THIS run'), false);
  }
});

Deno.test('non-empty instructions select the bounded custom variant', () => {
  const prompt = __test.buildWikiLibrarianPrompt({
    articleList: '- `Nak` - an app',
    customInstructions: 'merge the two Maya articles',
    invokedFrom: 'the Wiki panel',
  });
  assertStringIncludes(prompt, 'custom instructions for THIS run');
  assertStringIncludes(prompt, 'merge the two Maya articles');
  assertStringIncludes(prompt, 'from the Wiki panel');
  // The custom variant must NOT carry the periodic sweep's workflow.
  assertEquals(prompt.includes('Scan for out-of-scope articles first'), false);
});

Deno.test('the chat-dispatched variant names its surface in the intro', () => {
  const prompt = __test.buildWikiLibrarianPrompt({
    articleList: '(the wiki is currently empty)',
    customInstructions: 'delete the kettle stub',
    invokedFrom: 'the main chat',
  });
  assertStringIncludes(prompt, 'from the main chat');
});

Deno.test('profile block carries the corrective name rules; suppressed when unset', () => {
  const named = __test.buildWikiLibrarianPrompt({
    articleList: '- `Nak` - an app',
    userProfile: { name: 'Jeff', location: null },
  });
  assertStringIncludes(named, 'The name is **Jeff** and ONLY Jeff.');
  // The librarian's distinguishing rule: FIX wrong names already on disk.
  assertStringIncludes(named, 'wiki_update it to replace the wrong name');

  const bare = __test.buildWikiLibrarianPrompt({ articleList: '- `Nak` - an app' });
  assertEquals(bare.includes('**About the user:**'), false);
});

Deno.test('prompt advertises source_thread_ids and carries no inline-citation guidance', () => {
  const prompt = __test.buildWikiLibrarianPrompt({
    articleList: '- `Nak` - an app',
  });
  assertStringIncludes(prompt, 'source_thread_ids');
  assertEquals(prompt.includes('?cid='), false);
  assertEquals(prompt.includes('[label](?cid'), false);
});

Deno.test('renderArticleList handles the empty wiki and squashes whitespace', () => {
  assertEquals(__test.renderArticleList([]), '(the wiki is currently empty)');
  const list = __test.renderArticleList([
    { id: '1', title: 'Nak', content: 'line one\n\nline   two' },
  ]);
  assertEquals(list, '- `Nak` - line one line two');
});

Deno.test('renderArticleList annotates record activity; zero-record articles stay bare', () => {
  const rows = [
    { id: 'a', title: 'Bread', content: 'body a' },
    { id: 'b', title: 'Dogs', content: 'body b' },
    { id: 'c', title: 'Quiet', content: 'body c' },
  ];
  const activity = new Map([
    ['a', { count: 3, latestDate: '2026-07-04' }],
    ['b', { count: 1, latestDate: null }],
  ]);
  const list = __test.renderArticleList(rows, activity);
  assertStringIncludes(list, '- `Bread` (3 records, latest 2026-07-04) - body a');
  // Singular form, and no dangling ", latest" when the date is unknown.
  assertStringIncludes(list, '- `Dogs` (1 record) - body b');
  assertStringIncludes(list, '- `Quiet` - body c');
});

Deno.test('standard sweep body carries the same-event record-dedup discipline', () => {
  const prompt = __test.buildWikiLibrarianPrompt({
    articleList: '- `Nak` - an app',
  });
  // The record-cleanup pass must target record-active articles (the
  // annotation makes this actionable), name the same-date same-event
  // duplicate shape, prefer the attachment-carrying record as keeper,
  // and protect cross-date continuation arcs from merging.
  assertStringIncludes(prompt, 'most recent record activity');
  assertStringIncludes(prompt, 'SAME date describing the SAME happening');
  assertStringIncludes(prompt, 'file attachment wins');
  assertStringIncludes(prompt, 'never merge them');
});
