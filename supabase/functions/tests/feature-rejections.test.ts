// Offline unit tests for the model_feature_rejections helpers: the
// pure body strip, and the best-effort read/record against a stubbed
// Supabase client. Zero network.
import { assert, assertEquals } from '@std/assert';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  fetchRejectedFeatures,
  recordRejectedFeature,
  stripRejectedFeatures,
} from '../venice/feature-rejections.ts';

Deno.test('stripRejectedFeatures removes recorded droppable fields in place', () => {
  const body: Record<string, unknown> = {
    model: 'zai-org-glm-5-2',
    messages: [],
    text: { verbosity: 'low' },
  };
  const stripped = stripRejectedFeatures(body, new Set(['text']));
  assertEquals(stripped, ['text']);
  assert(!('text' in body));
  assert('messages' in body);
});

Deno.test('stripRejectedFeatures never strips non-droppable fields', () => {
  // A stray DB row naming a semantic field must not reshape the body -
  // the droppable allowlist is the trust boundary, not the table.
  const body: Record<string, unknown> = {
    model: 'zai-org-glm-5-2',
    messages: [],
    tools: [],
  };
  const stripped = stripRejectedFeatures(body, new Set(['tools', 'messages']));
  assertEquals(stripped, []);
  assert('tools' in body);
  assert('messages' in body);
});

Deno.test('stripRejectedFeatures skips fields absent from the body', () => {
  const body: Record<string, unknown> = { model: 'm', messages: [] };
  assertEquals(stripRejectedFeatures(body, new Set(['text'])), []);
});

function stubClient(overrides: {
  selectResult?: { data: unknown; error: unknown };
  onUpsert?: (row: unknown, opts: unknown) => { error: unknown };
}): SupabaseClient {
  return {
    from(_table: string) {
      return {
        select(_cols: string) {
          return {
            eq(_col: string, _val: string) {
              return Promise.resolve(
                overrides.selectResult ?? { data: [], error: null },
              );
            },
          };
        },
        upsert(row: unknown, opts: unknown) {
          return Promise.resolve(
            overrides.onUpsert?.(row, opts) ?? { error: null },
          );
        },
      };
    },
  } as unknown as SupabaseClient;
}

Deno.test('fetchRejectedFeatures returns the recorded feature set', async () => {
  const client = stubClient({
    selectResult: {
      data: [{ feature: 'text' }, { feature: 42 }, { feature: 'other' }],
      error: null,
    },
  });
  const rejected = await fetchRejectedFeatures(client, 'zai-org-glm-5-2');
  // Non-string rows are dropped defensively; valid ones survive.
  assertEquals(rejected, new Set(['text', 'other']));
});

Deno.test('fetchRejectedFeatures fails open to an empty set', async () => {
  const client = stubClient({
    selectResult: { data: null, error: { message: 'relation missing' } },
  });
  assertEquals(await fetchRejectedFeatures(client, 'm'), new Set());
});

Deno.test('recordRejectedFeature upserts on the composite key and never throws', async () => {
  let captured: { row: unknown; opts: unknown } | null = null;
  const client = stubClient({
    onUpsert: (row, opts) => {
      captured = { row, opts };
      return { error: null };
    },
  });
  await recordRejectedFeature(client, 'zai-org-glm-5-2', 'text');
  assertEquals(captured!.row, { model_id: 'zai-org-glm-5-2', feature: 'text' });
  assertEquals(
    (captured!.opts as { onConflict: string }).onConflict,
    'model_id,feature',
  );

  // A failing write is swallowed - the discovery is re-made on a
  // future turn instead of failing this one.
  const failing = stubClient({
    onUpsert: () => ({ error: { message: 'nope' } }),
  });
  await recordRejectedFeature(failing, 'm', 'text');
});
