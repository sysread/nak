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
  // records into article bodies; record_update / record_delete let it
  // clean up duplicate/outdated records. It still has NO wiki_create
  // (consolidation only) - records are the one thing it can create
  // indirectly via the extraction agent, not directly.
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
      'record_update',
      'record_delete',
    ],
  );
});

Deno.test('librarian toolbox excludes creation, memory writes, and the UI tool', () => {
  const names = __test.buildLibrarianToolbox().tools.map((t) => t.name);
  for (const forbidden of [
    'wiki_create',
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
