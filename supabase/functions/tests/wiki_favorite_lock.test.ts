// Tool-level guards for the favorite-lock on wiki articles.
//
// A favorited article is locked from agent edits: wiki_save (both the
// update form and the natural-key-matched create form) and wiki_delete
// must refuse the call with a clear error before any write reaches the
// DB. wiki_save must never set the favorite flag. These tests stub the
// admin client to verify the guard fires at the right point in the
// tool's query chain - before the write, after the read that surfaces
// the favorite flag.

import { assertRejects, assertEquals } from '@std/assert';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { ToolContext } from '../venice/performToolCall.ts';
import { wikiSave } from '../venice/tools/wiki_save.ts';
import { wikiDelete } from '../venice/tools/wiki_delete.ts';

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
  // `key` mirrors the natural-key probe's select alias (`title as key`);
  // the dedup heuristic reads it to detect an exact-title match.
  const row = favorite === null
    ? null
    : { id: 'a-1', title: 'Test', key: 'Test', content: rowContent, favorite };

  const adminClient = {
    from: (table: string) => {
      const c: Record<string, unknown> = {};
      for (const m of ['eq', 'order', 'limit', 'ilike']) c[m] = () => c;
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

Deno.test('wiki_save (update form) refuses to edit a favorited (locked) article', async () => {
  const fc = fakeCtx(true);
  await assertRejects(
    () =>
      wikiSave.execute(
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

Deno.test('wiki_save (update form) succeeds on a non-favorited article', async () => {
  const fc = fakeCtx(false);
  await wikiSave.execute(
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

Deno.test('wiki_save (update form) on a missing article does not trip the lock guard', async () => {
  const fc = fakeCtx(null);
  // A null row (article not found) should not be mistaken for locked.
  // readArticleState returns favorite=false for a missing row, so the
  // guard does not fire. The tool falls through to the write chain
  // (against zero rows in a real DB; the stub returns a placeholder
  // row from .single()). The key assertion: no "locked" error.
  try {
    await wikiSave.execute(
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

Deno.test('wiki_save (create form) never sets the favorite flag in the insert payload', async () => {
  const fc = fakeCtx(false);
  await wikiSave.execute(
    { title: 'Brand New Topic', content: 'body', message: 'create test' },
    fc.ctx,
  );
  // The insert stub throws if `favorite` is in the payload. Reaching
  // this assertion means the payload was clean. (The create form with
  // a fresh title runs the natural-key probe first; the stub's ilike
  // chain resolves through .then to an empty row set, so the create
  // proceeds.)
});

Deno.test('wiki_save (create form) does not select favorite from the returning row', async () => {
  const fc = fakeCtx(false);
  await wikiSave.execute(
    { title: 'Brand New Topic', content: 'body', message: 'create test' },
    fc.ctx,
  );
  assertEquals(
    (fc.insertedCols() ?? '').includes('favorite'),
    false,
  );
});

Deno.test('wiki_save create with an exact-title match routes to update (no duplicate)', async () => {
  // The natural-key heuristic: a create whose title exactly matches
  // (case-insensitively) an existing article updates that article
  // instead of bouncing with 23505 or silently duplicating.
  const fc = fakeCtx(false);
  const result = await wikiSave.execute(
    { title: 'Test', content: 'new body', message: 'intended edit, forgot the id' },
    fc.ctx,
  );
  // The stub's read returns the existing row (title 'Test'), so the
  // tool should have routed to update and flagged the match.
  assertEquals(
    (result as { matched_existing?: boolean }).matched_existing,
    true,
  );
});
