// Guards for the wiki-record extraction agent's safety-critical
// composition.
//
//   - The toolbox is read-heavy with exactly TWO write tools,
//     record_create + record_link_create. The extraction agent finds the
//     right article (wiki_search / wiki_list), checks for duplicates
//     (record_list), grounds with READ-ONLY memory_search, logs a record,
//     and conservatively cross-links a continuation. It never touches
//     article bodies (no wiki_create / wiki_update / wiki_delete), never
//     writes memory, and never promotes conversation files autonomously
//     (no record_file_attach).
//   - The prompt draws the article-body (current state) vs records
//     (journey) line and tells the agent to skip non-events.
//
// Pure: assembles objects/strings from already-registered ToolDefs.

import { assertEquals, assertStringIncludes } from '@std/assert';
import { __test } from '../venice/agents/wiki_records.ts';

Deno.test('extraction toolbox is reads + record_create/link/attach + analyze_image, in declared order', () => {
  const toolbox = __test.buildWikiRecordsToolbox();
  assertEquals(toolbox.name, 'wiki_records');
  // analyze_image rides so the text-tier model can verify what an image
  // shows before record_file_attach hangs it on a record (it cannot see
  // images directly).
  assertEquals(
    toolbox.tools.map((t) => t.name),
    [
      'wiki_search',
      'wiki_list',
      'record_list',
      'record_create',
      'record_link_create',
      'record_file_attach',
      'analyze_image',
      'memory_search',
    ],
  );
});

Deno.test('extraction toolbox excludes article writes, record edit/delete, and memory writes', () => {
  const names = __test.buildWikiRecordsToolbox().tools.map((t) => t.name);
  for (const forbidden of [
    'wiki_create',
    'wiki_update',
    'wiki_delete',
    'record_update',
    'record_delete',
    // It attaches the user's photos but never DETACHES - removal is a
    // user/maintenance act, not part of event capture.
    'record_file_remove',
    'record_link_delete',
    'memory_create',
    'memory_update',
    'memory_delete',
    'ask_user',
  ]) {
    assertEquals(names.includes(forbidden), false, `${forbidden} must not be reachable`);
  }
});

Deno.test('every extraction tool carries a wire schema whose name matches', () => {
  for (const tool of __test.buildWikiRecordsToolbox().tools) {
    assertEquals(tool.wire.type, 'function');
    assertEquals(tool.wire.function.name, tool.name);
  }
});

Deno.test('extraction prompt draws the body-vs-records line and excludes non-events', () => {
  const p = __test.WIKI_RECORDS_PROMPT;
  assertStringIncludes(p, 'current state');
  assertStringIncludes(p, 'journey');
  // It must tell the model to attach to an EXISTING article only.
  assertStringIncludes(p, 'EXISTING article');
  // And to dedupe via record_list before creating.
  assertStringIncludes(p, 'record_list');
});

Deno.test('extraction prompt carries the one-event-one-record dedup discipline', () => {
  const p = __test.WIKI_RECORDS_PROMPT;
  // The observed production failure: the same event re-captured as a
  // sibling record when a second conversation covered it, or when an
  // ongoing conversation met it again in the next day's slice. The
  // prompt must forbid the second record, allow attaching a photo to
  // the EXISTING record instead, and collapse multi-aspect coverage
  // within one pass to a single record.
  assertStringIncludes(p, 'One event, one record');
  assertStringIncludes(p, 'no matter which conversation produced the first one');
  assertStringIncludes(p, 'attach the photo to the EXISTING record');
  assertStringIncludes(p, 'ONE record, not one record per aspect');
});
