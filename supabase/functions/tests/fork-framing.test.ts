// Unit tests for the fork-framing helpers: boundary detection over
// resolved transcript slices and the preamble/marker splice. The
// framing is additive context for background agents, so the tests
// lean on the failure-toward-absence contract: anything ambiguous
// (no thread_id, no inherited rows) must produce NO framing.

import { assertEquals } from '@std/assert';
import {
  applyForkFraming,
  fetchParentTitle,
  forkBoundaryIndex,
  FORK_POINT_MARKER,
  forkPreamble,
  type TitleClient,
} from '../venice/agents/_fork_framing.ts';
import type { StoredMessage } from '../venice/agents/_recall_helpers.ts';

function msg(id: string, threadId: string | undefined, role = 'user'): StoredMessage {
  return {
    id,
    role: role as StoredMessage['role'],
    content: `content of ${id}`,
    tool_calls: null,
    tool_call_id: null,
    name: null,
    ...(threadId === undefined ? {} : { thread_id: threadId }),
  };
}

function titleClient(titles: Record<string, string>): TitleClient {
  return {
    from: (_table: string) => ({
      select: (_cols: string) => ({
        eq: (_col: string, val: string) => ({
          maybeSingle: () =>
            Promise.resolve({
              data: titles[val] !== undefined ? { title: titles[val] } : null,
              error: null,
            }),
        }),
      }),
    }),
  };
}

Deno.test('forkBoundaryIndex: no inherited rows -> null', () => {
  const rows = [msg('a', 'own'), msg('b', 'own')];
  assertEquals(forkBoundaryIndex(rows, 'own'), null);
});

Deno.test('forkBoundaryIndex: rows without thread_id read as own', () => {
  const rows = [msg('a', undefined), msg('b', undefined)];
  assertEquals(forkBoundaryIndex(rows, 'own'), null);
});

Deno.test('forkBoundaryIndex: boundary is the first own row', () => {
  const rows = [msg('p1', 'parent'), msg('p2', 'parent'), msg('o1', 'own')];
  assertEquals(forkBoundaryIndex(rows, 'own'), 2);
});

Deno.test('forkBoundaryIndex: all-inherited slice -> rows.length', () => {
  const rows = [msg('p1', 'parent'), msg('p2', 'parent')];
  assertEquals(forkBoundaryIndex(rows, 'own'), 2);
});

Deno.test('applyForkFraming: unforked slice passes through untouched', async () => {
  const rows = [msg('a', 'own'), msg('b', 'own')];
  const out = await applyForkFraming(titleClient({}), 'own', rows);
  assertEquals(out, rows);
});

Deno.test('applyForkFraming: preamble at head, marker at boundary', async () => {
  const rows = [msg('p1', 'parent'), msg('o1', 'own'), msg('o2', 'own')];
  const out = await applyForkFraming(
    titleClient({ parent: 'Sourdough basics' }),
    'own',
    rows,
  );
  assertEquals(out.length, 5);
  assertEquals(out[0].id, 'nak-fork-preamble');
  assertEquals(out[0].role, 'system');
  assertEquals(out[0].content.includes('"Sourdough basics"'), true);
  assertEquals(out[1].id, 'p1');
  assertEquals(out[2].id, 'nak-fork-marker');
  assertEquals(out[2].content, FORK_POINT_MARKER);
  assertEquals(out[3].id, 'o1');
  assertEquals(out[4].id, 'o2');
});

Deno.test('applyForkFraming: task clause rides the preamble', async () => {
  const rows = [msg('p1', 'parent'), msg('o1', 'own')];
  const out = await applyForkFraming(titleClient({ parent: 'T' }), 'own', rows, {
    taskClause: 'Summarize the whole conversation.',
  });
  assertEquals(out[0].content.endsWith('Summarize the whole conversation.'), true);
});

Deno.test('applyForkFraming: multi-level chain names the deepest surviving ancestor', async () => {
  // grandparent rows, then parent rows, then own - the preamble names
  // the parent (owner of the last inherited row).
  const rows = [
    msg('g1', 'grand'),
    msg('p1', 'parent'),
    msg('o1', 'own'),
  ];
  const out = await applyForkFraming(
    titleClient({ grand: 'Grand', parent: 'Parent title' }),
    'own',
    rows,
  );
  assertEquals(out[0].content.includes('"Parent title"'), true);
  assertEquals(out[3].id, 'nak-fork-marker');
});

Deno.test('applyForkFraming: all-inherited slice puts the marker at the tail', async () => {
  const rows = [msg('p1', 'parent'), msg('p2', 'parent')];
  const out = await applyForkFraming(titleClient({ parent: 'T' }), 'own', rows);
  assertEquals(out.length, 4);
  assertEquals(out[0].id, 'nak-fork-preamble');
  assertEquals(out[3].id, 'nak-fork-marker');
});

Deno.test('fetchParentTitle degrades to a generic phrase on any failure', async () => {
  assertEquals(await fetchParentTitle(titleClient({}), 'missing'), 'an earlier conversation');
  const throwing: TitleClient = {
    from: () => {
      throw new Error('boom');
    },
  };
  assertEquals(await fetchParentTitle(throwing, 'x'), 'an earlier conversation');
});

Deno.test('forkPreamble names nak and the parent', () => {
  const p = forkPreamble('My thread');
  assertEquals(p.startsWith('Note from nak'), true);
  assertEquals(p.includes('"My thread"'), true);
});
