// Behavioral tests for the function-side `skills` combination tool
// (venice/tools/skills.ts) - the wiki_favorite_lock.test.ts stub
// shape: a fake admin client whose .from('skills') chains record
// every filter, patch, and payload, so the tests assert the exact
// query shapes (b-strict user_id discipline, the quoted search
// pattern, the escaped exact-name lookup) with no network and no
// Supabase.
//
// Covered per the milestone contract: save-op natural-key routing
// (exact lower-name match -> update, near match -> refusal with the
// candidates named, 23505 raced insert rephrased), per-op validation
// (create's required fields, unknown op), b-strict shape,
// last_author stamping, the get op's lower(name) lookup, search
// never selecting bodies, and the char limits with agent-readable
// errors.

import { assert, assertEquals, assertRejects } from '@std/assert';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { ToolContext } from '../venice/performToolCall.ts';
import { skillsTool } from '../venice/tools/skills.ts';

// One .from('skills') chain, recording what the tool did to it. The
// chain resolves through .then (list / probe / search / delete) or
// through .maybeSingle / .single (get, update, insert); the fake
// returns the configured row set for whichever terminator the tool
// reached.
interface ChainRecord {
  eqFilters: Array<[string, unknown]>;
  ilikeFilters: Array<[string, string]>;
  orClause: string | null;
  orderArgs: Array<[string, { ascending: boolean }]>;
  limitArg: number | null;
  selectCols: string | null;
  updatePatch: Record<string, unknown> | null;
  insertPayload: Record<string, unknown> | null;
  deleted: boolean;
}

interface StubConfig {
  // Rows the natural-key probe's containment ilike returns
  // (re-shaped by the tool into {id, key}).
  probeRows?: { id: string; name: string }[];
  // Rows a .then-resolved list query returns.
  listRows?: Record<string, unknown>[];
  // Rows a .then-resolved search query returns.
  searchRows?: Record<string, unknown>[];
  // Row a .maybeSingle() (get by id/name, update returning) yields.
  maybeRow?: Record<string, unknown> | null;
  // Error a .maybeSingle() on an UPDATE chain surfaces instead of a
  // row - how a rename onto an existing name bounces (23505).
  updateError?: { code?: string; message: string };
  // Rows a .then-resolved delete's returning select yields.
  deleteRows?: Record<string, unknown>[];
  // Error a .single() (insert) surfaces instead of a row.
  insertError?: { code?: string; message: string };
}

interface Fake {
  ctx: ToolContext;
  chains: ChainRecord[];
}

function fake(config: StubConfig = {}): Fake {
  const chains: ChainRecord[] = [];

  const adminClient = {
    from: (table: string) => {
      if (table !== 'skills') {
        throw new Error(`unexpected table queried: ${table}`);
      }
      const rec: ChainRecord = {
        eqFilters: [],
        ilikeFilters: [],
        orClause: null,
        orderArgs: [],
        limitArg: null,
        selectCols: null,
        updatePatch: null,
        insertPayload: null,
        deleted: false,
      };
      chains.push(rec);
      const c: Record<string, unknown> = {};
      c.eq = (col: string, val: unknown) => {
        rec.eqFilters.push([col, val]);
        return c;
      };
      c.ilike = (col: string, val: string) => {
        rec.ilikeFilters.push([col, val]);
        return c;
      };
      c.or = (clause: string) => {
        rec.orClause = clause;
        return c;
      };
      c.order = (col: string, opts: { ascending: boolean }) => {
        rec.orderArgs.push([col, opts]);
        return c;
      };
      c.limit = (n: number) => {
        rec.limitArg = n;
        return c;
      };
      c.select = (cols?: string) => {
        rec.selectCols = cols ?? null;
        return c;
      };
      c.update = (patch: Record<string, unknown>) => {
        rec.updatePatch = patch;
        return c;
      };
      c.insert = (payload: Record<string, unknown>) => {
        rec.insertPayload = payload;
        return c;
      };
      c.delete = () => {
        rec.deleted = true;
        return c;
      };
      c.maybeSingle = () =>
        Promise.resolve(
          rec.updatePatch !== null && config.updateError
            ? { data: null, error: config.updateError }
            : { data: config.maybeRow ?? null, error: null },
        );
      c.single = () =>
        Promise.resolve(
          config.insertError
            ? { data: null, error: config.insertError }
            : { data: config.maybeRow ?? null, error: null },
        );
      // .then resolves whichever thenable query the chain built:
      // delete > search (.or) > natural-key probe (ilike + limit) >
      // list. Discriminated by the recorded chain state, so one stub
      // config serves every op.
      c.then = (
        res: (v: unknown) => unknown,
        rej?: (e: unknown) => unknown,
      ) => {
        let data: unknown[];
        if (rec.deleted) data = config.deleteRows ?? [];
        else if (rec.orClause !== null) data = config.searchRows ?? [];
        else if (rec.ilikeFilters.length > 0 && rec.limitArg !== null) {
          data = config.probeRows ?? [];
        } else data = config.listRows ?? [];
        return Promise.resolve({ data, error: null }).then(res, rej);
      };
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
    chains,
  };
}

// The single chain a one-query op produced, or the last chain for
// multi-query ops.
function onlyChain(f: Fake): ChainRecord {
  assertEquals(f.chains.length, 1);
  return f.chains[0];
}

function writeChains(f: Fake): ChainRecord[] {
  return f.chains.filter(
    (ch) => ch.updatePatch !== null || ch.insertPayload !== null || ch.deleted,
  );
}

const FULL_ROW = {
  id: 's-1',
  name: 'release-notes',
  description: 'How to draft the release notes',
  body: '1. Gather merged PRs\n2. Group by area',
  last_author: 'user',
  created_at: '2026-10-01T00:00:00Z',
  updated_at: '2026-10-28T00:00:00Z',
};

Deno.test('save create with an exact lower-name match routes to update, not insert', async () => {
  // The natural-key heuristic: a create whose name exactly matches
  // (case-insensitively) an existing skill updates that skill instead
  // of bouncing with 23505 or silently duplicating.
  const f = fake({
    probeRows: [{ id: 's-1', name: 'Release Notes' }],
    maybeRow: FULL_ROW,
  });
  const result = (await skillsTool.execute(
    {
      op: 'save',
      name: 'release notes',
      description: 'How to draft the release notes',
      body: '1. Gather merged PRs',
    },
    f.ctx,
  )) as { matched_existing?: boolean };
  assertEquals(result.matched_existing, true);
  // Exactly one write chain, and it is an update.
  const writes = writeChains(f);
  assertEquals(writes.length, 1);
  const update = writes[0];
  assertEquals(update.insertPayload, null);
  assertEquals(update.deleted, false);
  // Tool writes stamp last_author 'assistant'...
  assertEquals((update.updatePatch as Record<string, unknown>).last_author, 'assistant');
  // ...and never set updated_at manually - the touch_skill_updated_at
  // trigger owns it on the edge path. The browser save slice does
  // stamp it explicitly (request-shape consistency with its sibling
  // update slices), and the trigger overwrites that stamp server-side
  // (pinned in tests/skills-slice.test.ts).
  assertEquals('updated_at' in (update.updatePatch as object), false);
  assertEquals((update.updatePatch as Record<string, unknown>).name, 'release notes');
  // b-strict: the update is scoped to the owner.
  assert(
    update.eqFilters.some(([col, val]) => col === 'user_id' && val === 'u-1'),
  );
  assert(update.eqFilters.some(([col, val]) => col === 'id' && val === 's-1'));
});

Deno.test('save create with a near match is refused with the candidates named', async () => {
  // "release-notes" against existing "release-notes-v2" is a
  // containment case: neither silent merge nor silent duplicate.
  const f = fake({ probeRows: [{ id: 's-1', name: 'release-notes-v2' }] });
  await assertRejects(
    () =>
      skillsTool.execute(
        { op: 'save', name: 'release-notes', description: 'd', body: 'b' },
        f.ctx,
      ),
    Error,
    'release-notes-v2',
  );
  // The refusal fires before any write.
  assertEquals(writeChains(f).length, 0);
});

Deno.test('save create racing a concurrent insert gets a 23505 rephrased agent-readable', async () => {
  const f = fake({
    probeRows: [],
    insertError: {
      code: '23505',
      message: 'duplicate key value violates unique constraint',
    },
  });
  const err = await assertRejects(() =>
    skillsTool.execute(
      { op: 'save', name: 'fresh', description: 'd', body: 'b' },
      f.ctx,
    ),
  );
  const msg = err instanceof Error ? err.message : String(err);
  assert(msg.includes('already exists'), msg);
  assert(msg.includes('op=list'), msg);
  // b-strict on the insert too: user_id stamped, last_author
  // 'assistant', no manual updated_at.
  const writes = writeChains(f);
  assertEquals(writes.length, 1);
  const insert = writes[0].insertPayload as Record<string, unknown>;
  assertEquals(insert.user_id, 'u-1');
  assertEquals(insert.last_author, 'assistant');
  assertEquals('updated_at' in insert, false);
});

Deno.test('save by id renaming onto another skill\'s name gets the same 23505 rephrase', async () => {
  // The update path hits the same unique (user_id, lower(name))
  // constraint the raced create does: a save-by-id renaming a skill
  // onto an existing name. The sniff + rephrase is shared, so both
  // paths tell the model how to recover instead of surfacing a raw
  // constraint error.
  const f = fake({
    updateError: {
      code: '23505',
      message: 'duplicate key value violates unique constraint',
    },
  });
  const err = await assertRejects(() =>
    skillsTool.execute(
      { op: 'save', id: 's-1', name: 'taken-name', description: 'd' },
      f.ctx,
    ),
  );
  const msg = err instanceof Error ? err.message : String(err);
  assert(msg.includes('already exists'), msg);
  assert(msg.includes('taken-name'), msg);
  assert(msg.includes('op=list'), msg);
  // The attempted update was still b-strict.
  const update = writeChains(f)[0];
  assert(update.eqFilters.some(([col, val]) => col === 'user_id' && val === 'u-1'));
  assert(update.eqFilters.some(([col, val]) => col === 'id' && val === 's-1'));
});

Deno.test('the natural-key probe escapes ILIKE metacharacters in the requested name', async () => {
  // A literal % or _ in the name must not act as a wildcard inside
  // the containment prefilter - the same escape the exact-name
  // lookup applies, wrapped in the probe's deliberate % wildcards.
  const f = fake({ probeRows: [], maybeRow: FULL_ROW });
  await skillsTool.execute(
    { op: 'save', name: '50%_off', description: 'd', body: 'b' },
    f.ctx,
  );
  // Chain 0 is the natural-key probe; chain 1 is the insert it fell
  // through to.
  assertEquals(f.chains.length, 2);
  assertEquals(f.chains[0].ilikeFilters[0], ['name', '%50\\%\\_off%']);
});

Deno.test('save create requires name, description, and body - all named in one error', async () => {
  const f = fake();
  const err = await assertRejects(() =>
    skillsTool.execute({ op: 'save' }, f.ctx)
  );
  const msg = err instanceof Error ? err.message : String(err);
  assert(msg.includes('name is required'), msg);
  assert(msg.includes('description is required'), msg);
  assert(msg.includes('body is required'), msg);
});

Deno.test('save update with nothing to change is rejected', async () => {
  const f = fake();
  await assertRejects(
    () => skillsTool.execute({ op: 'save', id: 's-1' }, f.ctx),
    Error,
    'nothing to change',
  );
});

Deno.test('an unknown op is rejected with the valid ops named', async () => {
  const f = fake();
  await assertRejects(
    () => skillsTool.execute({ op: 'frobnicate' }, f.ctx),
    Error,
    'op must be one of: list, get, search, save, delete',
  );
});

Deno.test('list filters by user_id, orders name asc, and selects no bodies', async () => {
  const f = fake({
    listRows: [
      { id: 's-1', name: 'a', description: 'da', updated_at: 't', last_author: 'user' },
      { id: 's-2', name: 'b', description: 'db', updated_at: 't', last_author: 'assistant' },
    ],
  });
  const result = (await skillsTool.execute({ op: 'list' }, f.ctx)) as {
    skills: unknown[];
  };
  assertEquals(result.skills.length, 2);
  const ch = onlyChain(f);
  assert(ch.eqFilters.some(([col, val]) => col === 'user_id' && val === 'u-1'));
  assert(ch.orderArgs.some(([col, o]) => col === 'name' && o.ascending === true));
  // The body-less projection: no body column on the list select.
  const cols = (ch.selectCols ?? '').split(',').map((s) => s.trim());
  assert(!cols.includes('body'), `list select carries body: ${ch.selectCols}`);
});

Deno.test('get by id returns the full body; a miss returns the honest found:false shape', async () => {
  const f = fake({ maybeRow: FULL_ROW });
  const hit = (await skillsTool.execute({ op: 'get', id: 's-1' }, f.ctx)) as {
    found: boolean;
    skill: { body: string };
  };
  assertEquals(hit.found, true);
  assertEquals(hit.skill.body, FULL_ROW.body);
  const ch = onlyChain(f);
  assert(ch.eqFilters.some(([col, val]) => col === 'user_id' && val === 'u-1'));
  assert(ch.eqFilters.some(([col, val]) => col === 'id' && val === 's-1'));

  const miss = fake({ maybeRow: null });
  const out = (await skillsTool.execute(
    { op: 'get', id: 'nope' },
    miss.ctx,
  )) as { found: boolean };
  assertEquals(out.found, false);
});

Deno.test('get by name matches lower(name) via an escaped exact ILIKE', async () => {
  const f = fake({ maybeRow: FULL_ROW });
  const out = (await skillsTool.execute(
    { op: 'get', name: 'Release Notes' },
    f.ctx,
  )) as { found: boolean };
  assertEquals(out.found, true);
  const ch = onlyChain(f);
  // Case-insensitive exact match, no wildcards in the pattern.
  assertEquals(ch.ilikeFilters[0], ['name', 'Release Notes']);
  assert(ch.eqFilters.some(([col, val]) => col === 'user_id' && val === 'u-1'));

  // ILIKE metacharacters in the caller's name are escaped so a
  // literal % or _ cannot widen the exact match.
  const meta = fake({ maybeRow: FULL_ROW });
  await skillsTool.execute({ op: 'get', name: '50%_off' }, meta.ctx);
  assertEquals(onlyChain(meta).ilikeFilters[0], ['name', '50\\%\\_off']);
});

Deno.test('search uses the quoted logic-tree pattern and never selects bodies', async () => {
  const f = fake({
    searchRows: [
      { id: 's-1', name: 'release-notes', description: 'd', updated_at: 't', last_author: 'user' },
    ],
  });
  const out = (await skillsTool.execute(
    { op: 'search', query: 'release, notes' },
    f.ctx,
  )) as { skills: unknown[] };
  assertEquals(out.skills.length, 1);
  const ch = onlyChain(f);
  // The comma in the query rides inside the double-quoted pattern;
  // unquoted, it would split the PostgREST logic tree and fail the
  // whole request.
  assertEquals(
    ch.orClause,
    'name.ilike."%release, notes%",description.ilike."%release, notes%",body.ilike."%release, notes%"',
  );
  // Bodies load only through get - the search select omits the
  // column even though the OR scans it.
  const cols = (ch.selectCols ?? '').split(',').map((s) => s.trim());
  assert(!cols.includes('body'), `search select carries body: ${ch.selectCols}`);
  assert(ch.eqFilters.some(([col, val]) => col === 'user_id' && val === 'u-1'));
});

Deno.test('search without a query is rejected', async () => {
  const f = fake();
  await assertRejects(
    () => skillsTool.execute({ op: 'search' }, f.ctx),
    Error,
    'query is required for op=search',
  );
});

Deno.test('delete by name resolves through lower(name) and reports the honest miss', async () => {
  const f = fake({ maybeRow: FULL_ROW, deleteRows: [{ id: 's-1' }] });
  const out = (await skillsTool.execute(
    { op: 'delete', name: 'Release Notes' },
    f.ctx,
  )) as { deleted: boolean; id: string };
  assertEquals(out.deleted, true);
  assertEquals(out.id, 's-1');
  const del = writeChains(f)[0];
  assert(del.eqFilters.some(([col, val]) => col === 'user_id' && val === 'u-1'));
  assert(del.eqFilters.some(([col, val]) => col === 'id' && val === 's-1'));

  // A name that matches nothing never reaches the delete.
  const miss = fake({ maybeRow: null });
  const missed = (await skillsTool.execute(
    { op: 'delete', name: 'ghost' },
    miss.ctx,
  )) as { deleted: boolean; reason: string };
  assertEquals(missed.deleted, false);
  assertEquals(writeChains(miss).length, 0);
});

Deno.test('delete by id reports the honest miss on a zero-row match', async () => {
  const f = fake({ deleteRows: [] });
  const out = (await skillsTool.execute(
    { op: 'delete', id: 's-1' },
    f.ctx,
  )) as { deleted: boolean };
  assertEquals(out.deleted, false);
});

Deno.test('char limits are enforced with agent-readable errors naming the actual length', async () => {
  const f = fake();
  const err = await assertRejects(() =>
    skillsTool.execute(
      {
        op: 'save',
        name: 'x'.repeat(65),
        description: 'd'.repeat(301),
        body: 'b'.repeat(32001),
      },
      f.ctx,
    ),
  );
  const msg = err instanceof Error ? err.message : String(err);
  assert(msg.includes('name exceeds 64-char limit (got 65)'), msg);
  assert(msg.includes('description exceeds 300-char limit (got 301)'), msg);
  assert(msg.includes('body exceeds 32000-char limit (got 32001)'), msg);
});
