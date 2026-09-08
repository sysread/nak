// Guards for venice/tools/recipe_save.ts.
//
// The star rating is a user evaluation of a cooked dish, so no tool
// writes it. These lock the refusal in: the model reaching for a
// rating (typically off conversational praise) must fail loudly, and
// the RPC must always be told the recipe starts unrated.

import { assertEquals, assertRejects } from '@std/assert';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { ToolContext } from '../venice/performToolCall.ts';
import { recipeSave } from '../venice/tools/recipe_save.ts';

function fakeCtx(opts: { existingTitle?: string } = {}): {
  ctx: ToolContext;
  rpcCalls: Array<Record<string, unknown>>;
} {
  const rpcCalls: Array<Record<string, unknown>> = [];
  // The dedup probe runs before the RPC on the create path; its ilike
  // chain resolves through .then to an empty row set, so a fresh title
  // proceeds to the create RPC.
  const adminClient = {
    from: (_table: string) => {
      const c: Record<string, unknown> = {};
      // order/maybeSingle: the edit form's readRecipePhotoMeta follow-up
      // read uses the same builder shape.
      for (const m of ['eq', 'ilike', 'limit', 'order', 'maybeSingle']) c[m] = () => c;
      c.select = () => c;
      // The awaited chain never leaves this object (every chained
      // method returns `c`), so `then` lives directly on it and
      // resolves exactly once with the probe's row set. A Proxy that
      // intercepts `then` does NOT work here: only the outer from()
      // call is proxied, and the chained calls run on the raw target,
      // bypassing the trap.
      const rows = opts.existingTitle
        ? [{ id: 'r-1', title: opts.existingTitle }]
        : [];
      (c as { then: unknown }).then = (resolve: (v: unknown) => unknown) =>
        Promise.resolve({ data: rows }).then(resolve);
      return c;
    },
    rpc: (_name: string, args: Record<string, unknown>) => {
      rpcCalls.push(args);
      return Promise.resolve({
        data: [{ id: 'r-1', title: 'Meatballs', updated_at: '2026-01-01T00:00:00Z' }],
        error: null,
      });
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
    rpcCalls,
  };
}

const ARGS = {
  title: 'Meatballs',
  cooklang: 'Mix @pork{500%g} and bake for ~{30%minutes}.',
};

Deno.test('recipe_save refuses to set the star rating', async () => {
  const { ctx, rpcCalls } = fakeCtx();
  await assertRejects(
    () => recipeSave.execute({ ...ARGS, rating: 5 }, ctx),
    Error,
    'rating is not editable by this tool',
  );
  assertEquals(rpcCalls.length, 0);
});

Deno.test('recipe_save create with an exact-title match routes to update', async () => {
  // The natural-key heuristic: a create whose title exactly matches
  // (ci) an existing recipe updates that recipe instead of bouncing
  // off the unique index or silently duplicating.
  const { ctx, rpcCalls } = fakeCtx({ existingTitle: 'Meatballs' });
  const result = await recipeSave.execute(
    { title: 'meatballs', cooklang: 'Mix @pork{500%g}.', change_message: 'fix salt' },
    ctx,
  );
  // The RPC bundle is the UPDATE shape (p_id present), and the result
  // carries the flag so the model can tell which path fired.
  assertEquals(rpcCalls.length, 1);
  assertEquals(rpcCalls[0].p_id, 'r-1');
  assertEquals(
    (result as { matched_existing?: boolean }).matched_existing,
    true,
  );
});

Deno.test('recipe_save create with a near-match title is refused', async () => {
  const { ctx, rpcCalls } = fakeCtx({ existingTitle: 'Weeknight Chili' });
  await assertRejects(
    () => recipeSave.execute({ title: 'Chili', cooklang: 'x' }, ctx),
    Error,
    'a similar row already exists',
  );
  assertEquals(rpcCalls.length, 0);
});

Deno.test('recipe_save always creates the recipe unrated', async () => {
  const { ctx, rpcCalls } = fakeCtx();
  await recipeSave.execute(ARGS, ctx);
  assertEquals(rpcCalls[0].p_rating, null);
});
