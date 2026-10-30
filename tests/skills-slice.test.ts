/**
 * Unit coverage for the skills data-layer slice
 * (src/lib/supabase/skills.ts): the index projection, the offset-page
 * probe, the single-row fetch, the ILIKE search, and the create /
 * update / delete surface. The supabase-js client is a hand-rolled
 * stub (the same shape as tests/recipe-records.test.ts) so the
 * assertions pin the request shape - select projection, .or logic
 * tree, range probe, insert/update payloads - without booting
 * Postgres. Pure vitest, no DOM.
 *
 * The .or assertions are load-bearing: the search leg rides the
 * QUOTED logic-tree pattern (ilikeLogicTreePattern). An unquoted comma
 * in the query splits the PostgREST logic tree and fails the whole
 * request, and a literal quote would terminate the value early - the
 * metachar case pins both escapes. The page-probe assertions pin the
 * pageSize+1 range shape the hasMore derivation depends on.
 */
import { describe, it, expect, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  deleteSkill,
  getSkill,
  listSkills,
  listSkillsPage,
  saveSkill,
  searchSkills,
} from '../src/lib/supabase/skills';
import { SupabaseError } from '../src/lib/supabase/error';
import { DEFAULT_LIST_PAGE_SIZE } from '../src/lib/supabase/types';
import type { Skill, SkillSummary } from '../src/lib/supabase/types';

// --- stub ----------------------------------------------------------------

/**
 * Chainable from()-builder stub capturing every method's args (in
 * order, so multi-call methods like order can be asserted per call).
 * `then` resolves the list paths; single/maybeSingle resolve their own
 * configured results so one builder serves every call shape the slice
 * issues. auth.getSession is stubbed for saveSkill's create path.
 */
function makeClient(opts: {
  fromData?: unknown[];
  fromError?: string | null;
  singleData?: Record<string, unknown> | null;
  singleError?: string | null;
  maybeData?: Record<string, unknown> | null;
  /** Defaults to a live session; pass null for the signed-out case. */
  session?: { user: { id: string } } | null;
} = {}) {
  const calls: Record<string, unknown[][]> = {};
  const builder: Record<string, unknown> = {};
  const chainable = [
    'select',
    'eq',
    'or',
    'order',
    'limit',
    'range',
    'insert',
    'update',
    'delete',
  ];
  for (const m of chainable) {
    builder[m] = vi.fn((...args: unknown[]) => {
      (calls[m] ??= []).push(args);
      return builder;
    });
  }
  builder.single = vi.fn(() => ({
    then: (resolve: (v: unknown) => void) => {
      resolve({ data: opts.singleData ?? null, error: opts.singleError ?? null });
      return undefined;
    },
  }));
  builder.maybeSingle = vi.fn(() => ({
    then: (resolve: (v: unknown) => void) => {
      resolve({ data: opts.maybeData ?? null, error: null });
      return undefined;
    },
  }));
  builder.then = (resolve: (v: unknown) => void) => {
    resolve({ data: opts.fromData ?? [], error: opts.fromError ?? null });
    return builder;
  };
  const getSession = vi.fn(async () => ({
    data: {
      session:
        opts.session === undefined ? { user: { id: 'u-1' } } : opts.session,
    },
    error: null,
  }));
  const client = {
    from: vi.fn(() => builder),
    auth: { getSession },
  } as unknown as SupabaseClient;
  return { client, calls, getSession };
}

const FULL_PROJECTION =
  'id, name, description, body, last_author, created_at, updated_at';
const SUMMARY_PROJECTION = 'id, name, description, updated_at, last_author';

function skillRow(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'sk-1',
    name: 'release-notes',
    description: 'How Jeff likes release notes drafted',
    body: '# Steps\n- lead with the answer',
    last_author: 'user',
    created_at: '2026-10-01T00:00:00Z',
    updated_at: '2026-10-02T00:00:00Z',
    ...over,
  };
}

function summaryRow(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'sk-1',
    name: 'release-notes',
    description: 'How Jeff likes release notes drafted',
    updated_at: '2026-10-02T00:00:00Z',
    last_author: 'user',
    ...over,
  };
}

// --- listSkills (the index projection) ------------------------------------

describe('listSkills', () => {
  it('selects the body-less projection ordered name asc with no row limit', async () => {
    const { client, calls } = makeClient({ fromData: [summaryRow()] });
    const out = await listSkills(client);
    expect(calls.select).toEqual([[SUMMARY_PROJECTION]]);
    expect(calls.order).toEqual([['name', { ascending: true }]]);
    // No limit: the per-turn index caps are computed in JS from the
    // full fetched set, so a server-side limit would break the
    // overflow count.
    expect(calls.limit).toBeUndefined();
    expect(out).toHaveLength(1);
    expect(out[0]).toEqual(summaryRow() as unknown as SkillSummary);
  });

  it('coerces an assistant-authored row and survives an empty store', async () => {
    const { client } = makeClient({
      fromData: [summaryRow({ last_author: 'assistant' })],
    });
    expect((await listSkills(client))[0].last_author).toBe('assistant');
    const empty = makeClient({ fromData: [] });
    expect(await listSkills(empty.client)).toEqual([]);
  });

  it('wraps a query error in SupabaseError', async () => {
    const { client } = makeClient({ fromError: 'boom' });
    await expect(listSkills(client)).rejects.toBeInstanceOf(SupabaseError);
  });
});

// --- listSkillsPage (the browse probe) ------------------------------------

describe('listSkillsPage', () => {
  it('fetches full rows, name asc with id tiebreak, over the pageSize+1 range probe', async () => {
    const { client, calls } = makeClient({ fromData: [skillRow()] });
    await listSkillsPage(client, { offset: 100, pageSize: 50 });
    expect(calls.select).toEqual([[FULL_PROJECTION]]);
    expect(calls.order).toEqual([
      ['name', { ascending: true }],
      ['id', { ascending: true }],
    ]);
    // range is inclusive, so the probe asks for one extra row.
    expect(calls.range).toEqual([[100, 150]]);
  });

  it('derives hasMore from the extra row and strips it', async () => {
    const page = Array.from({ length: 51 }, (_, i) =>
      skillRow({ id: `sk-${i}` })
    );
    const { client } = makeClient({ fromData: page });
    const out = await listSkillsPage(client, { offset: 0, pageSize: 50 });
    expect(out.hasMore).toBe(true);
    expect(out.rows).toHaveLength(50);
  });

  it('reports hasMore false on a short page', async () => {
    const { client } = makeClient({ fromData: [skillRow()] });
    const out = await listSkillsPage(client, { offset: 0, pageSize: 50 });
    expect(out.hasMore).toBe(false);
    expect(out.rows).toHaveLength(1);
    expect(out.rows[0].body).toBe('# Steps\n- lead with the answer');
  });
});

// --- getSkill --------------------------------------------------------------

describe('getSkill', () => {
  it('fetches the full row by id and coerces it', async () => {
    const { client, calls } = makeClient({ maybeData: skillRow() });
    const out = await getSkill(client, 'sk-1');
    expect(calls.select).toEqual([[FULL_PROJECTION]]);
    expect(calls.eq).toEqual([['id', 'sk-1']]);
    expect(out).toEqual(skillRow() as unknown as Skill);
  });

  it('returns null for a missing (or not-owned) row', async () => {
    const { client } = makeClient({ maybeData: null });
    expect(await getSkill(client, 'sk-404')).toBeNull();
  });
});

// --- searchSkills ----------------------------------------------------------

describe('searchSkills', () => {
  it('short-circuits an empty query without touching the client', async () => {
    const { client } = makeClient();
    expect(await searchSkills(client, { query: '   ' })).toEqual([]);
    expect(client.from).not.toHaveBeenCalled();
  });

  it('searches name + description + body with the quoted logic-tree pattern', async () => {
    const { client, calls } = makeClient({ fromData: [summaryRow()] });
    const out = await searchSkills(client, { query: 'release' });
    // The pattern must be double-quoted: inside a .or() logic tree an
    // unquoted comma splits the tree and fails the whole request.
    expect(calls.or).toEqual([
      [
        'name.ilike."%release%",description.ilike."%release%",body.ilike."%release%"',
      ],
    ]);
    expect(calls.select).toEqual([[SUMMARY_PROJECTION]]);
    expect(calls.order).toEqual([['name', { ascending: true }]]);
    expect(out[0]).toEqual(summaryRow() as unknown as SkillSummary);
  });

  it('escapes a comma and a literal quote in the query', async () => {
    const { client, calls } = makeClient();
    await searchSkills(client, { query: 'lasagna, "wet"' });
    expect(calls.or?.[0]?.[0]).toBe(
      'name.ilike."%lasagna, \\"wet\\"%",' +
        'description.ilike."%lasagna, \\"wet\\"%",' +
        'body.ilike."%lasagna, \\"wet\\"%"',
    );
  });

  it('defaults the limit to the browse page size and honors an explicit one', async () => {
    const def = makeClient();
    await searchSkills(def.client, { query: 'x' });
    expect(def.calls.limit).toEqual([[DEFAULT_LIST_PAGE_SIZE]]);
    const explicit = makeClient();
    await searchSkills(explicit.client, { query: 'x', limit: 7 });
    expect(explicit.calls.limit).toEqual([[7]]);
  });
});

// --- saveSkill -------------------------------------------------------------

describe('saveSkill', () => {
  it('creates when no id: stamps user_id from the session and last_author user', async () => {
    const { client, calls, getSession } = makeClient({
      singleData: skillRow({ id: 'sk-new' }),
    });
    const out = await saveSkill(client, {
      name: 'release-notes',
      description: 'How Jeff likes release notes drafted',
      body: '# Steps\n- lead with the answer',
    });
    expect(getSession).toHaveBeenCalled();
    expect(calls.insert).toEqual([
      [
        {
          user_id: 'u-1',
          name: 'release-notes',
          description: 'How Jeff likes release notes drafted',
          body: '# Steps\n- lead with the answer',
          last_author: 'user',
        },
      ],
    ]);
    expect(out.id).toBe('sk-new');
  });

  it('refuses to create without a session', async () => {
    const { client } = makeClient({ session: null });
    await expect(
      saveSkill(client, {
        name: 'x',
        description: 'y',
        body: 'z',
      })
    ).rejects.toBeInstanceOf(SupabaseError);
  });

  it('updates by id: stamps last_author user and updated_at, never user_id', async () => {
    const { client, calls, getSession } = makeClient({
      singleData: skillRow({ name: 'renamed' }),
    });
    const out = await saveSkill(client, {
      id: 'sk-1',
      name: 'renamed',
      description: 'How Jeff likes release notes drafted',
      body: '# Steps',
    });
    expect(getSession).not.toHaveBeenCalled();
    expect(calls.insert).toBeUndefined();
    expect(calls.update).toHaveLength(1);
    const payload = calls.update![0][0] as Record<string, unknown>;
    expect(payload.name).toBe('renamed');
    expect(payload.last_author).toBe('user');
    // The browser write stamps the edit time for consistency with
    // the sibling update slices; the schema trigger re-stamps it
    // authoritatively, and the edge tool never stamps at all - the
    // trigger owns it there (pinned in the Deno skills tool tests).
    expect(typeof payload.updated_at).toBe('string');
    expect(payload.updated_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect('user_id' in payload).toBe(false);
    expect(calls.eq).toEqual([['id', 'sk-1']]);
    expect(out.name).toBe('renamed');
  });

  it('wraps a write error in SupabaseError', async () => {
    const { client } = makeClient({ singleError: 'duplicate key' });
    await expect(
      saveSkill(client, { id: 'sk-1', name: 'x', description: 'y', body: 'z' })
    ).rejects.toBeInstanceOf(SupabaseError);
  });
});

// --- deleteSkill -----------------------------------------------------------

describe('deleteSkill', () => {
  it('deletes by id under RLS', async () => {
    const { client, calls } = makeClient();
    await deleteSkill(client, 'sk-1');
    expect(calls.delete).toHaveLength(1);
    expect(calls.eq).toEqual([['id', 'sk-1']]);
  });

  it('wraps a delete error in SupabaseError', async () => {
    const { client } = makeClient({ fromError: 'boom' });
    await expect(deleteSkill(client, 'sk-1')).rejects.toBeInstanceOf(SupabaseError);
  });
});
