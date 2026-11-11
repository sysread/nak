import { beforeEach, describe, expect, it } from 'vitest';
import {
  grocery,
  loadGroceries,
  loadMoreAcquired,
  toggleGroceryProductOnList,
} from '../src/lib/grocery-store.svelte';
import type {
  GroceryProductView,
  GrocerySection,
  SupabaseService,
} from '../src/lib/supabase';

/**
 * Store-level coverage for the optimistic check-off flow. The
 * "client" is a stub with deferred promises so the tests control
 * resolve order directly - the generation-guard cases pin START
 * order beating RESOLVE order, which is the class of race that used
 * to un-do a check-off when a stale reload landed last.
 */

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function section(id: string, name: string, position: number): GrocerySection {
  return { id, name, position, created_at: '2026-01-01T00:00:00Z' };
}

function item(overrides: Partial<GroceryProductView> & { name: string }): GroceryProductView {
  return {
    id: overrides.name,
    note: null,
    section_id: null,
    section_source: null,
    recipe_id: null,
    image_id: null,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    recipe_title: null,
    image_url: null,
    entry_id: 'e-' + overrides.name,
    count: null,
    unit: null,
    acquired_at: null,
    on_list: true,
    ...overrides,
  };
}

function resetStore(): void {
  grocery.sections = [];
  grocery.onList = [];
  grocery.acquired = [];
  grocery.acquiredHasMore = false;
  grocery.loadingMore = false;
  grocery.loading = false;
  grocery.loaded = false;
  grocery.error = null;
  grocery.writeError = null;
  grocery.pendingToggles = new Map();
  grocery.classifying = new Set();
}

/**
 * A stub SupabaseService whose read and write methods record calls
 * and return caller-controlled deferreds. `onListDeferred` swaps in
 * a per-call deferred queue for listOnListGroceryProducts so tests
 * can resolve loads out of order; by default everything resolves
 * immediately with the current fixture rows.
 */
function makeStub(args: {
  onListQueue?: Array<Deferred<GroceryProductView[]>>;
  acquiredQueue?: Array<Deferred<{ rows: GroceryProductView[]; hasMore: boolean }>>;
  writeQueue?: Array<Deferred<void>>;
}) {
  const calls: Array<{ method: string; args: unknown[] }> = [];
  const signals: AbortSignal[] = [];
  const readRows = () => [...grocery.onList];
  const readAcquired = () => ({ rows: [...grocery.acquired], hasMore: false });
  const stub = {
    async listGrocerySections(opts?: { signal?: AbortSignal }) {
      calls.push({ method: 'listGrocerySections', args: [opts] });
      if (opts?.signal) signals.push(opts.signal);
      return [section('s1', 'Produce', 0)];
    },
    async seedGrocerySectionsIfEmpty() {
      calls.push({ method: 'seed', args: [] });
    },
    async listOnListGroceryProducts(opts?: { signal?: AbortSignal }) {
      calls.push({ method: 'listOnList', args: [opts] });
      if (opts?.signal) signals.push(opts.signal);
      const q = args.onListQueue?.shift();
      if (q) return q.promise;
      return readRows();
    },
    async listAcquiredGroceryProductsPage(opts: {
      offset: number;
      pageSize: number;
      signal?: AbortSignal;
    }) {
      calls.push({ method: 'listAcquired', args: [opts] });
      if (opts.signal) signals.push(opts.signal);
      const q = args.acquiredQueue?.shift();
      if (q) return q.promise;
      return readAcquired();
    },
    async setProductOnList(
      id: string,
      on: boolean,
      qty?: unknown,
      signal?: AbortSignal
    ) {
      calls.push({ method: 'setProductOnList', args: [id, on, qty, signal] });
      if (signal) signals.push(signal);
      const q = args.writeQueue?.shift();
      if (q) return q.promise;
    },
  };
  return { stub: stub as unknown as SupabaseService, calls, signals };
}

beforeEach(() => {
  resetStore();
});

describe('loadGroceries generation guard', () => {
  it('start order beats resolve order: a stale-started load resolving last is discarded', async () => {
    const d1 = deferred<GroceryProductView[]>();
    const d2 = deferred<GroceryProductView[]>();
    const { stub } = makeStub({ onListQueue: [d1, d2] });
    const load1 = loadGroceries(stub);
    const load2 = loadGroceries(stub);
    // load2 resolves first with itemA; load1 resolves later with a
    // snapshot missing it - exactly the shape that un-did check-offs.
    d2.resolve([item({ name: 'kept' })]);
    await load2;
    expect(grocery.onList.map((i) => i.name)).toEqual(['kept']);
    expect(grocery.loading).toBe(false);
    d1.resolve([item({ name: 'stale' })]);
    await load1;
    expect(grocery.onList.map((i) => i.name)).toEqual(['kept']);
    expect(grocery.loading).toBe(false);
  });

  it('a superseded load cannot write an error or pin loading', async () => {
    const d1 = deferred<GroceryProductView[]>();
    const d2 = deferred<GroceryProductView[]>();
    const { stub } = makeStub({ onListQueue: [d1, d2] });
    const load1 = loadGroceries(stub);
    const load2 = loadGroceries(stub);
    d2.resolve([item({ name: 'kept' })]);
    await load2;
    d1.reject(new Error('stale failure'));
    await load1;
    expect(grocery.error).toBeNull();
    expect(grocery.loading).toBe(false);
  });

  it('a latest load that fails writes the error and clears loading', async () => {
    const d1 = deferred<GroceryProductView[]>();
    const { stub } = makeStub({ onListQueue: [d1] });
    const load1 = loadGroceries(stub);
    d1.reject(new Error('boom'));
    await load1;
    expect(grocery.error).toBe('boom');
    expect(grocery.loading).toBe(false);
  });

  it('passes an abort signal into every query (the timeout plumbing)', async () => {
    const { stub, calls, signals } = makeStub({});
    await loadGroceries(stub);
    const methodNames = calls.map((c) => c.method);
    expect(methodNames).toContain('listGrocerySections');
    expect(methodNames).toContain('listOnList');
    expect(methodNames).toContain('listAcquired');
    // One shared, not-yet-aborted signal across the batch's queries.
    // (The 15s timer itself is platform behavior; the rejection path
    // a timed-out load takes is the same catch as any failing load,
    // covered above.)
    expect(signals.length).toBeGreaterThanOrEqual(3);
    expect(new Set(signals).size).toBe(1);
    expect(signals[0]).toBeInstanceOf(AbortSignal);
    expect(signals[0].aborted).toBe(false);
  });
});

describe('toggleGroceryProductOnList', () => {
  it('applies the optimistic purchase synchronously - the row moves before any await', async () => {
    const w = deferred<void>();
    const { stub } = makeStub({ writeQueue: [w] });
    grocery.onList = [item({ name: 'eggs' })];
    const p = toggleGroceryProductOnList(stub, grocery.onList[0], false);
    expect(grocery.onList).toHaveLength(0);
    expect(grocery.acquired[0]).toMatchObject({
      name: 'eggs',
      on_list: false,
      entry_id: null,
    });
    expect(grocery.acquired[0].acquired_at).toBeTruthy();
    expect(grocery.pendingToggles.get('eggs')).toBe(false);
    w.resolve();
    await p;
    expect(grocery.pendingToggles.size).toBe(0);
  });

  it('applies the optimistic revival synchronously', async () => {
    const w = deferred<void>();
    const { stub } = makeStub({ writeQueue: [w] });
    grocery.acquired = [item({ name: 'eggs', on_list: false, acquired_at: '2026-11-10T00:00:00Z' })];
    const p = toggleGroceryProductOnList(stub, grocery.acquired[0], true);
    expect(grocery.acquired).toHaveLength(0);
    expect(grocery.onList[0]).toMatchObject({ name: 'eggs', on_list: true, entry_id: null });
    w.resolve();
    await p;
    expect(grocery.pendingToggles.size).toBe(0);
  });

  it('a failed write reverts the row, clears pending, and surfaces writeError', async () => {
    const w = deferred<void>();
    const { stub } = makeStub({ writeQueue: [w] });
    grocery.onList = [item({ name: 'eggs' })];
    const p = toggleGroceryProductOnList(stub, grocery.onList[0], false);
    w.reject(new Error('store wifi'));
    await p;
    expect(grocery.pendingToggles.size).toBe(0);
    expect(grocery.writeError).toBe('store wifi');
    // Reverted: the resync reload serves the stub's current fixture
    // (onList as-is), so eggs reads back on the list either way.
    expect(grocery.onList.map((i) => i.name)).toContain('eggs');
  });

  it('writeError is NOT cleared by a successful load (the resync would flash it away)', async () => {
    grocery.writeError = 'store wifi';
    const { stub } = makeStub({});
    await loadGroceries(stub);
    expect(grocery.writeError).toBe('store wifi');
  });

  it('writeError clears on the next successful toggle', async () => {
    grocery.writeError = 'store wifi';
    const { stub } = makeStub({});
    grocery.onList = [item({ name: 'eggs' })];
    await toggleGroceryProductOnList(stub, grocery.onList[0], false);
    expect(grocery.writeError).toBeNull();
  });

  it('ignores a second tap on a row whose write is already in flight', async () => {
    const w = deferred<void>();
    const { stub, calls } = makeStub({ writeQueue: [w] });
    grocery.onList = [item({ name: 'eggs' })];
    const p1 = toggleGroceryProductOnList(stub, grocery.onList[0], false);
    const row = grocery.acquired[0];
    const p2 = toggleGroceryProductOnList(stub, row, true);
    await p2;
    expect(
      calls.filter((c) => c.method === 'setProductOnList')
    ).toHaveLength(1);
    expect(grocery.pendingToggles.size).toBe(1);
    w.resolve();
    await p1;
    expect(grocery.pendingToggles.size).toBe(0);
  });

  it('one settle-reload when the LAST write lands - not one per write', async () => {
    const w1 = deferred<void>();
    const w2 = deferred<void>();
    const { stub, calls } = makeStub({ writeQueue: [w1, w2] });
    grocery.onList = [item({ name: 'eggs' }), item({ name: 'flour' })];
    // Capture rows BEFORE the first toggle: it synchronously removes
    // eggs from onList, so positional reads afterwards would miss.
    const [eggs, flour] = grocery.onList;
    const p1 = toggleGroceryProductOnList(stub, eggs, false);
    const p2 = toggleGroceryProductOnList(stub, flour, false);
    w1.resolve();
    await p1;
    expect(calls.filter((c) => c.method === 'listOnList')).toHaveLength(0);
    w2.resolve();
    await p2;
    expect(calls.filter((c) => c.method === 'listOnList')).toHaveLength(1);
  });

  it('passes an abort signal to the write (the timeout plumbing)', async () => {
    const { stub, calls } = makeStub({});
    grocery.onList = [item({ name: 'eggs' })];
    await toggleGroceryProductOnList(stub, grocery.onList[0], false);
    const write = calls.find((c) => c.method === 'setProductOnList');
    expect(write?.args[3]).toBeInstanceOf(AbortSignal);
  });
});

describe('seed storm guard', () => {
  it('concurrent loads over an empty section table seed exactly ONCE', async () => {
    // The storm this pins: an external wipe of the sections table
    // makes every realtime echo trigger a reload, and each reload
    // that observes zero sections used to re-seed - 10 insert echoes
    // per seed, each fanning out to more loads. Without the
    // non-reentrancy guard this test observes two seed calls.
    let seedCalls = 0;
    const stub = {
      async listGrocerySections() {
        // Empty until the seed has run once, then populated - the
        // shape the storm fed on.
        return seedCalls > 0 ? [section('s1', 'Produce', 0)] : [];
      },
      async seedGrocerySectionsIfEmpty() {
        seedCalls++;
        await new Promise((r) => setTimeout(r, 20));
      },
      async listOnListGroceryProducts() {
        return [];
      },
      async listAcquiredGroceryProductsPage() {
        return { rows: [], hasMore: false };
      },
    } as unknown as SupabaseService;
    const loads = [loadGroceries(stub), loadGroceries(stub), loadGroceries(stub)];
    await Promise.all(loads);
    expect(seedCalls).toBe(1);
  });
});

describe('loadMoreAcquired', () => {
  it('is blocked while an optimistic toggle is pending (the offset cursor would lie)', async () => {
    const { stub, calls } = makeStub({});
    grocery.acquiredHasMore = true;
    grocery.pendingToggles = new Map([['eggs', false]]);
    await loadMoreAcquired(stub);
    expect(calls.filter((c) => c.method === 'listAcquired')).toHaveLength(0);
  });

  it('appends the next page when idle', async () => {
    const page = {
      rows: [item({ name: 'old', on_list: false, acquired_at: '2026-11-01T00:00:00Z' })],
      hasMore: true,
    };
    const stub = {
      async listAcquiredGroceryProductsPage() {
        return page;
      },
    } as unknown as SupabaseService;
    grocery.acquired = [item({ name: 'newer', on_list: false, acquired_at: '2026-11-10T00:00:00Z' })];
    grocery.acquiredHasMore = true;
    await loadMoreAcquired(stub);
    expect(grocery.acquired.map((i) => i.name)).toEqual(['newer', 'old']);
    expect(grocery.acquiredHasMore).toBe(true);
  });
});
