// Tool-level guards for the favorite-lock on wiki articles.
//
// A favorited article is locked from agent edits: wiki_update and
// wiki_delete must refuse the call with a clear error before any
// write reaches the DB. wiki_create must never set the favorite flag.
// These tests stub the admin client to verify the guard fires at the
// right point in the tool's query chain - before the write, after the
// read that surfaces the favorite flag.

import { assertRejects, assertEquals } from '@std/assert';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { ToolContext } from '../venice/performToolCall.ts';
import { wikiUpdate } from '../venice/tools/wiki_update.ts';
import { wikiDelete } from '../venice/tools/wiki_delete.ts';
import { wikiCreate } from '../venice/tools/wiki_create.ts';

interface FakeCtx {
  ctx: ToolContext;
  reachedWrite: () => boolean;
  insertedCols: () => string | null;
}

/**
 * Build a fake admin client whose `.from('wiki_articles')` chain
 * returns a row with the given `favorite` value from a `.maybeSingle()`
 * read, and captures whether `.update()`, `.delete()`, or `.insert()`
 * was reached. The `reachedWrite` accessor is the proof the guard did
 * NOT fire - if the tool threw before the write, the flag stays false.
 */
function fakeCtx(
  favorite: boolean | null,
  rowContent = 'body',
): FakeCtx {
  let reachedWrite = false;
  let insertedCols: string | null = null;
  const row = favorite === null
    ? null
    : { id: 'a-1', title: 'Test', content: rowContent, favorite };

  const adminClient = {
    from: (table: string) => {
      const c: Record<string, unknown> = {};
      for (const m of ['eq', 'order', 'limit']) c[m] = () => c;
      c.select = (cols?: string) => {
        if (table === 'wiki_articles') insertedCols = cols ?? null;
        return c;
      };
      c.maybeSingle = () => Promise.resolve({ data: row, error: null });
      c.single = () => {
        reachedWrite = true;
        return Promise.resolve({
          data: { id: 'a-1', title: 'Test', content: rowContent },
          error: null,
        });
      };
      c.update = () => {
        reachedWrite = true;
        return c;
      };
      c.delete = () => {
        reachedWrite = true;
        return c;
      };
      c.insert = (payload: Record<string, unknown>) => {
        reachedWrite = true;
        if ('favorite' in payload) {
          throw new Error(
            'wiki_create insert payload contains `favorite` - agents must not set the lock flag',
          );
        }
        return c;
      };
      c.then = (
        res: (v: unknown) => unknown,
        rej?: (e: unknown) => unknown,
      ) => Promise.resolve({ data: row ? [row] : [], error: null }).then(res, rej);
      return c;
    },
  } as unknown as SupabaseClient;

  return {
    ctx: {
      adminClient,
      userId: 'u-1',
      threadId: 't-1',
      signal: new AbortController().signal,
      depth: 0,
    } as ToolContext,
    reachedWrite: () => reachedWrite,
    insertedCols: () => insertedCols,
  };
}

Deno.test('wiki_update refuses to edit a favorited (locked) article', async () => {
  const fc = fakeCtx(true);
  await assertRejects(
    () =>
      wikiUpdate.execute(
        { id: 'a-1', content: 'new body', message: 'test edit' },
        fc.ctx,
      ),
    Error,
    'favorited (locked)',
  );
  assertEquals(fc.reachedWrite(), false);
});

Deno.test('wiki_delete refuses to delete a favorited (locked) article', async () => {
  const fc = fakeCtx(true);
  await assertRejects(
    () =>
      wikiDelete.execute({ id: 'a-1', message: 'test delete' }, fc.ctx),
    Error,
    'favorited (locked)',
  );
  assertEquals(fc.reachedWrite(), false);
});

Deno.test('wiki_update succeeds on a non-favorited article', async () => {
  const fc = fakeCtx(false);
  await wikiUpdate.execute(
    { id: 'a-1', content: 'new body', message: 'test edit' },
    fc.ctx,
  );
  assertEquals(fc.reachedWrite(), true);
});

Deno.test('wiki_delete succeeds on a non-favorited article', async () => {
  const fc = fakeCtx(false);
  await wikiDelete.execute({ id: 'a-1', message: 'test delete' }, fc.ctx);
  assertEquals(fc.reachedWrite(), true);
});

Deno.test('wiki_update on a missing article does not trip the lock guard', async () => {
  const fc = fakeCtx(null);
  // A null row (article not found) should not be mistaken for locked.
  // readArticleState returns favorite=false for a missing row, so the
  // guard does not fire. The tool falls through to the write chain
  // (against zero rows in a real DB; the stub returns a placeholder
  // row from .single()). The key assertion: no "locked" error.
  try {
    await wikiUpdate.execute(
      { id: 'a-1', content: 'new body', message: 'test edit' },
      fc.ctx,
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    assertEquals(msg.includes('locked'), false);
  }
});

Deno.test('wiki_delete on a missing article does not trip the lock guard', async () => {
  const fc = fakeCtx(null);
  const result = await wikiDelete.execute(
    { id: 'a-1', message: 'test delete' },
    fc.ctx,
  );
  assertEquals((result as { deleted: boolean }).deleted, true);
});

Deno.test('wiki_create never sets the favorite flag in the insert payload', async () => {
  const fc = fakeCtx(false);
  await wikiCreate.execute(
    { title: 'New Article', content: 'body', message: 'create test' },
    fc.ctx,
  );
  // The insert stub throws if `favorite` is in the payload. Reaching
  // this assertion means the payload was clean.
});

Deno.test('wiki_create does not select favorite from the returning row', async () => {
  const fc = fakeCtx(false);
  await wikiCreate.execute(
    { title: 'New Article', content: 'body', message: 'create test' },
    fc.ctx,
  );
  assertEquals(
    (fc.insertedCols() ?? '').includes('favorite'),
    false,
  );
});
