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

function fakeCtx(): {
  ctx: ToolContext;
  rpcCalls: Array<Record<string, unknown>>;
} {
  const rpcCalls: Array<Record<string, unknown>> = [];
  const adminClient = {
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
    'rating is not settable by this tool',
  );
  assertEquals(rpcCalls.length, 0);
});

Deno.test('recipe_save always creates the recipe unrated', async () => {
  const { ctx, rpcCalls } = fakeCtx();
  await recipeSave.execute(ARGS, ctx);
  assertEquals(rpcCalls[0].p_rating, null);
});
