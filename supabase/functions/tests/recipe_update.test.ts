// Return-shape guards for venice/tools/recipe_update.ts.
//
// The regression these exist for: a scalar edit (title / cooklang /
// source / rating) inherits the recipe's photo links onto the new
// version, but the tool answered with a hardcoded `photos: []` and
// echoed the `topics` column that the re-tag trigger had just emptied.
// The model read both as data loss and told the user its edit had
// dropped three photos and every topic tag. Nothing had been dropped.

import { assertEquals, assertRejects } from '@std/assert';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { ToolContext } from '../venice/performToolCall.ts';
import { recipeUpdate } from '../venice/tools/recipe_update.ts';

interface PhotoLink {
  position: number;
  image_id: string;
  label: string | null;
}

interface Scenario {
  /** Row the RPC echoes back, read AFTER the re-tag trigger fires. */
  rpcRow?: Record<string, unknown>;
  /** Links hanging off the recipe's newest version row. */
  links?: PhotoLink[] | null;
  /** No version row at all - the defensive branch. */
  noVersionRow?: boolean;
}

/**
 * Thenable PostgREST-builder stub over the one read recipe_update makes
 * (newest recipe_versions row + its recipe_version_images links), plus
 * the recipe_update_with_version RPC.
 */
function fakeCtx(scenario: Scenario): {
  ctx: ToolContext;
  rpcCalls: Array<Record<string, unknown>>;
} {
  const rpcCalls: Array<Record<string, unknown>> = [];
  const versionRow = scenario.noVersionRow
    ? null
    : { id: 'v-2', recipe_version_images: scenario.links ?? [] };

  const adminClient = {
    rpc: (_name: string, args: Record<string, unknown>) => {
      rpcCalls.push(args);
      return Promise.resolve({
        data: [scenario.rpcRow ?? { id: 'r-1', title: 'Meatballs', topics: [] }],
        error: null,
      });
    },
    from: () => {
      const c: Record<string, unknown> = {};
      for (const m of ['select', 'eq', 'order', 'limit']) c[m] = () => c;
      c.maybeSingle = () => Promise.resolve({ data: versionRow, error: null });
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
    rpcCalls,
  };
}

const ARGS = { id: 'r-1', title: 'Meatballs', change_message: 'Retitled' };

Deno.test('recipe_update reports the photos it carried forward', async () => {
  const { ctx } = fakeCtx({
    links: [
      { position: 1, image_id: 'img-b', label: 'crumb shot' },
      { position: 0, image_id: 'img-a', label: null },
      { position: 2, image_id: 'img-c', label: null },
    ],
  });
  const out = (await recipeUpdate.execute(ARGS, ctx)) as {
    photos: Array<{ id: string; position: number; label: string | null }>;
  };
  // Sorted by position, not by the order the join happened to return.
  assertEquals(out.photos, [
    { id: 'img-a', position: 0, label: null },
    { id: 'img-b', position: 1, label: 'crumb shot' },
    { id: 'img-c', position: 2, label: null },
  ]);
});

Deno.test('recipe_update omits the re-queued topics column', async () => {
  // The trigger empties `topics` on every content edit so the curation
  // unit re-tags the row, and the RPC reads the row back after it fires.
  // An empty array here is bookkeeping, not the recipe's tags, so the
  // field must not reach the model at all.
  const { ctx } = fakeCtx({
    rpcRow: { id: 'r-1', title: 'Meatballs', rating: 4, topics: [] },
  });
  const out = (await recipeUpdate.execute(ARGS, ctx)) as Record<string, unknown>;
  assertEquals('topics' in out, false);
  assertEquals(out.rating, 4);
});

Deno.test('recipe_update reports no photos when the recipe has none', async () => {
  const { ctx } = fakeCtx({ links: [] });
  const out = (await recipeUpdate.execute(ARGS, ctx)) as { photos: unknown[] };
  assertEquals(out.photos, []);
});

Deno.test('recipe_update survives a recipe with no version row', async () => {
  const { ctx } = fakeCtx({ noVersionRow: true });
  const out = (await recipeUpdate.execute(ARGS, ctx)) as { photos: unknown[] };
  assertEquals(out.photos, []);
});

Deno.test('recipe_update leaves the photo set alone', async () => {
  // The photo-editing verbs are the recipe_photos_* tools. A scalar
  // edit must reach the RPC with p_set_image_ids false so the previous
  // version's links are inherited rather than cleared.
  const { ctx, rpcCalls } = fakeCtx({
    links: [{ position: 0, image_id: 'img-a', label: null }],
  });
  await recipeUpdate.execute(ARGS, ctx);
  assertEquals(rpcCalls.length, 1);
  assertEquals(rpcCalls[0].p_set_image_ids, false);
  assertEquals(rpcCalls[0].p_image_ids, null);
});

Deno.test('recipe_update still rejects a patch with nothing to change', async () => {
  const { ctx } = fakeCtx({});
  await assertRejects(
    () => recipeUpdate.execute({ id: 'r-1', change_message: 'noop' }, ctx),
    Error,
    'provide at least one of',
  );
});
