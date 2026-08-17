// Return-shape guards for the memory write tools.
//
// Same regression as tests/recipe_update.test.ts, found by auditing the
// other tools for it: a write echoed the row's `topics` column, but the
// label/data edit that triggered the write also fires
// clear_memory_topics_on_change, which empties that column so the
// curation unit re-tags the row. RETURNING reads the row back after the
// trigger, so the field reported an empty list exactly when the model
// had just edited the text - and reads as "the edit dropped your tags"
// on a write that lost nothing.
//
// These assert on the SELECT column list, which is where the field
// enters the response. A stub that returned a fixed row would pass even
// if someone re-added `topics` to the select.

import { assert, assertEquals } from '@std/assert';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { ToolContext } from '../venice/performToolCall.ts';
import { memoryUpdate } from '../venice/tools/memory_update.ts';
import { memoryReshape } from '../venice/tools/memory_reshape.ts';

function fakeCtx(): { ctx: ToolContext; selects: string[] } {
  const selects: string[] = [];
  const row = {
    id: 'm-1',
    label: 'likes rye',
    data: 'Prefers rye bread.',
    confidence: 7,
    created_at: 't0',
    updated_at: 't1',
  };

  const adminClient = {
    from: () => {
      const c: Record<string, unknown> = {};
      for (const m of ['update', 'eq', 'insert', 'order', 'limit', 'in']) c[m] = () => c;
      c.select = (cols?: string) => {
        if (typeof cols === 'string') selects.push(cols);
        return c;
      };
      c.single = () => Promise.resolve({ data: row, error: null });
      c.maybeSingle = () => Promise.resolve({ data: row, error: null });
      c.then = (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) =>
        Promise.resolve({ data: [row], error: null }).then(res, rej);
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
    selects,
  };
}

/** The column list the tool reads its response row back with. */
function writeSelect(selects: string[]): string {
  const cols = selects.find((s) => s.includes('confidence'));
  assert(cols, `no response-row select found in ${JSON.stringify(selects)}`);
  return cols;
}

Deno.test('memory_update does not echo the re-queued topics column', async () => {
  const { ctx, selects } = fakeCtx();
  const out = (await memoryUpdate.execute(
    { id: 'm-1', data: 'Prefers rye bread.', message: 'tightened' },
    ctx,
  )) as Record<string, unknown>;
  assertEquals(writeSelect(selects).includes('topics'), false);
  assertEquals('topics' in out, false);
  // The fields the model actually needs still come back.
  assertEquals(out.id, 'm-1');
  assertEquals(out.confidence, 7);
});

Deno.test('memory_reshape does not echo the re-queued topics column', async () => {
  // A reshape always rewrites label or data, so it always fires the
  // re-tag trigger - this field could never be anything but empty.
  const { ctx, selects } = fakeCtx();
  const out = (await memoryReshape.execute(
    { id: 'm-1', data: 'Prefers rye.', message: 'de-narrated' },
    ctx,
  )) as Record<string, unknown>;
  assertEquals(writeSelect(selects).includes('topics'), false);
  assertEquals('topics' in out, false);
  assertEquals(out.label, 'likes rye');
});
