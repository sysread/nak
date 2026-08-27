/**
 * Baseline coverage for forkThread (src/lib/supabase/threads.ts:472).
 *
 * forkThread is the single primitive every fork entry point delegates to:
 * the drawer's whole-conversation fork, the per-message card fork, and the
 * edit-fork path (delete-from-here and regenerate in a shared region). It
 * had zero test coverage. These tests pin its contract against a stubbed
 * SupabaseClient so the user-message-editing feature can lean on it
 * without re-deriving what it does.
 *
 * The stub is a chainable builder: every query method returns the builder
 * so forkThread's sequential awaits resolve. Each "table" gets its own
 * response set by table name, so a single client can serve both the
 * threads reads and the messages reads forkThread issues.
 */
import { describe, it, expect, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { forkThread } from '../src/lib/supabase/threads';
import { SupabaseError } from '../src/lib/supabase/error';

// A minimal thread row that coerceThread accepts.
function threadRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'thread-1',
    user_id: 'u-1',
    title: 'Probe thread',
    model: null,
    reasoning_effort: null,
    verbosity: null,
    toolboxes_enabled: [],
    archived: false,
    hidden: false,
    title_manually_set: false,
    forked_from_thread_id: null,
    forked_from_msg_id: null,
    ...overrides,
  };
}

// A minimal message row that isValidForkPoint accepts (user row by default).
function msgRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'msg-1',
    thread_id: 'thread-1',
    role: 'user',
    tool_calls: null,
    status: null,
    ...overrides,
  };
}

// A minimal session for auth.getSession.
const SESSION = {
  user: { id: 'u-1' },
};

/**
 * Build a stubbed SupabaseClient. The `tables` map controls per-table
 * responses: each table gets a function that receives the query's last
 * chainable state and returns { data, error }. The `insertReturn` is
 * what the threads INSERT .select().single() resolves to.
 *
 * The builder records every call so tests can assert on the request
 * shape (eq filters, insert payload).
 */
function makeClient(opts: {
  threadRow?: Record<string, unknown> | null;
  msgRow?: Record<string, unknown> | null;
  tailRows?: Record<string, unknown>[] | null;
  forkCount?: number;
  insertRow?: Record<string, unknown>;
  session?: typeof SESSION | null;
  threadError?: string | null;
  msgError?: string | null;
  countError?: string | null;
  insertError?: string | null;
}): SupabaseClient {
  const captured: {
    eqCalls: Record<string, unknown[]>;
    orderArgs: unknown[];
    limitArgs: unknown[];
    insertPayload: Record<string, unknown> | null;
  } = {
    eqCalls: {},
    orderArgs: [],
    limitArgs: [],
    insertPayload: null,
  };

  // Build a chainable that resolves to a given {data, error} pair.
  function chain(result: { data: unknown; error: unknown }) {
    const builder: Record<string, unknown> = {};
    const methods = ['select', 'eq', 'ilike', 'gte', 'lt', 'or', 'order', 'limit', 'is', 'maybeSingle', 'single'];
    for (const m of methods) {
      builder[m] = vi.fn((...args: unknown[]) => {
        if (m === 'eq') {
          // Track the last eq filter per call chain.
          // args[0] = column, args[1] = value
          captured.eqCalls[String(args[0])] = args;
        }
        if (m === 'order') captured.orderArgs = args;
        if (m === 'limit') captured.limitArgs = args;
        if (m === 'maybeSingle') {
          // Return a thenable that resolves to the result.
          return {
            then: (resolve: (v: unknown) => void) => {
              resolve(result);
              return undefined;
            },
          };
        }
        if (m === 'single') {
          return {
            then: (resolve: (v: unknown) => void) => {
              resolve(result);
              return undefined;
            },
          };
        }
        return builder;
      });
    }
    // For count queries: .select('id', { count: 'exact', head: true }).eq(...)
    // needs .then to resolve to { count, error }.
    builder.then = (resolve: (v: unknown) => void) => {
      resolve(result);
      return undefined;
    };
    return builder;
  }

  const fromImpl = vi.fn((table: string) => {
    if (table === 'threads') {
      // The first call to threads is the source-thread SELECT.
      // If insertRow is set, a later call will be the INSERT; we
      // distinguish by checking whether the builder has been called
      // with 'insert'.
      const sourceResult = {
        data: opts.threadRow ?? null,
        error: opts.threadError ?? null,
      };
      // The count query: .select('id', { count, head }).eq().then
      const countResult = {
        count: opts.forkCount ?? 0,
        error: opts.countError ?? null,
      };
      // The insert: .insert({...}).select().single()
      const insertResult = {
        data: opts.insertRow ?? threadRow({ id: 'new-fork' }),
        error: opts.insertError ?? null,
      };

      const builder: Record<string, unknown> = {};
      let isCount = false;

      builder.select = vi.fn((...args: unknown[]) => {
        // If args[1] has { count: 'exact', head: true }, it's the count query.
        if (args.length > 1 && typeof args[1] === 'object' && args[1] !== null && 'count' in args[1]) {
          isCount = true;
        }
        return builder;
      });
      builder.eq = vi.fn((col: string, val: unknown) => {
        captured.eqCalls[col] = [col, val];
        if (isCount) {
          // Return a chainable that resolves to countResult
          return chain({ data: null, ...countResult });
        }
        return builder;
      });
      builder.maybeSingle = vi.fn(() => {
        return {
          then: (resolve: (v: unknown) => void) => {
            resolve(sourceResult);
            return undefined;
          },
        };
      });
      builder.insert = vi.fn((payload: Record<string, unknown>) => {
        captured.insertPayload = payload;
        return builder;
      });
      builder.single = vi.fn(() => {
        return {
          then: (resolve: (v: unknown) => void) => {
            resolve(insertResult);
            return undefined;
          },
        };
      });
      // Generic chainable methods that just return builder.
      for (const m of ['ilike', 'gte', 'lt', 'or', 'order', 'limit', 'is']) {
        builder[m] = vi.fn((...args: unknown[]) => {
          if (m === 'order') captured.orderArgs = args;
          if (m === 'limit') captured.limitArgs = args;
          return builder;
        });
      }
      // The count query needs a .then on the builder itself.
      builder.then = (resolve: (v: unknown) => void) => {
        if (isCount) {
          resolve(countResult);
        } else {
          resolve(sourceResult);
        }
        return undefined;
      };
      return builder;
    }

    if (table === 'messages') {
      const msgResult = {
        data: opts.msgRow ?? null,
        error: opts.msgError ?? null,
      };
      const tailResult = {
        data: opts.tailRows ?? [],
        error: opts.msgError ?? null,
      };

      // For messages, the first call is either .eq('id', forkMsgId).maybeSingle()
      // or .eq('thread_id', sourceThreadId).order().limit() (tail walk).
      const builder: Record<string, unknown> = {};

      builder.select = vi.fn(() => builder);
      builder.eq = vi.fn((col: string, val: unknown) => {
        captured.eqCalls[col] = [col, val];
        return builder;
      });
      builder.maybeSingle = vi.fn(() => {
        return {
          then: (resolve: (v: unknown) => void) => {
            resolve(msgResult);
            return undefined;
          },
        };
      });
      builder.order = vi.fn((...args: unknown[]) => {
        captured.orderArgs = args;
        return builder;
      });
      builder.limit = vi.fn((...args: unknown[]) => {
        captured.limitArgs = args;
        return builder;
      });
      builder.then = (resolve: (v: unknown) => void) => {
        resolve(tailResult);
        return undefined;
      };
      return builder;
    }

    // Unknown table: return a generic chainable.
    return chain({ data: null, error: null });
  });

  const authSession = opts.session === undefined ? SESSION : opts.session;

  return {
    from: fromImpl,
    auth: {
      getSession: vi.fn(async () => ({
        data: { session: authSession },
        error: null,
      })),
    },
    /** Captured query state for assertions. */
    _captured: captured,
  } as unknown as SupabaseClient;
}

describe('forkThread', () => {
  // ---- Explicit forkMsgId branch ----

  it('forks at the given message with the message owner as parent', async () => {
    const client = makeClient({
      threadRow: threadRow({ id: 'P', title: 'Original' }),
      msgRow: msgRow({ id: 'm1', thread_id: 'P', role: 'user' }),
      forkCount: 0,
      insertRow: threadRow({ id: 'F', title: 'marked', forked_from_thread_id: 'P', forked_from_msg_id: 'm1' }),
    });
    const fork = await forkThread(client, "P", "m1");
    expect(fork.id).toBe("F");
    expect(fork.forked_from_thread_id).toBe("P");
    expect(fork.forked_from_msg_id).toBe("m1");
    const cap = (client as unknown as { _captured: { insertPayload: Record<string, unknown> | null } })._captured;
    expect(cap.insertPayload?.forked_from_thread_id).toBe('P');
    expect(cap.insertPayload?.forked_from_msg_id).toBe('m1');
  });

  it('applies the reparent rule: parent is the thread that OWNS the fork-point message, not the source thread', async () => {
    // The user forks from thread E, but the fork-point message is
    // owned by P (E's ancestor). The new fork's parent should be P.
    const client = makeClient({
      threadRow: threadRow({ id: 'E', title: 'Edit fork' }),
      // The message lives in P's segment, not E's.
      msgRow: msgRow({ id: 'm1', thread_id: 'P', role: 'user' }),
      forkCount: 0,
      insertRow: threadRow({ id: 'F', forked_from_thread_id: 'P', forked_from_msg_id: 'm1' }),
    });
    const fork = await forkThread(client, 'E', 'm1');
    expect(fork.forked_from_thread_id).toBe('P');
    expect(fork.forked_from_msg_id).toBe('m1');
    // The reparent rule: the insert payload's parent is the message
    // owner's thread (P), not the source thread (E).
    const cap2 = (client as unknown as { _captured: { insertPayload: Record<string, unknown> | null } })._captured;
    expect(cap2.insertPayload?.forked_from_thread_id).toBe('P');
  });

  it('markTitle: false carries the title verbatim with no sigil or ordinal', async () => {
    const client = makeClient({
      threadRow: threadRow({ id: 'P', title: 'Original title' }),
      msgRow: msgRow({ id: 'm1', thread_id: 'P' }),
      forkCount: 3,
      insertRow: threadRow({ id: 'F', title: 'Original title' }),
    });
    const fork = await forkThread(client, 'P', 'm1', { markTitle: false });
    expect(fork.title).toBe('Original title');
    // The insert payload's title is verbatim - no sigil, no ordinal.
    const cap = (client as unknown as { _captured: { insertPayload: Record<string, unknown> | null } })._captured;
    expect(cap.insertPayload?.title).toBe('Original title');
  });

  it('markTitle: true (default) marks the title with the sigil and ordinal', async () => {
    const client = makeClient({
      threadRow: threadRow({ id: 'P', title: 'Original title' }),
      msgRow: msgRow({ id: 'm1', thread_id: 'P' }),
      forkCount: 2, // 2 existing forks -> ordinal 3
      insertRow: threadRow({ id: 'F', title: 'placeholder' }),
    });
    await forkThread(client, 'P', 'm1');
    // sigil + subscript-3 + ' Original title'. Not the verbatim title.
    const cap = (client as unknown as { _captured: { insertPayload: Record<string, unknown> | null } })._captured;
    expect(cap.insertPayload?.title).not.toBe('Original title');
    expect(cap.insertPayload?.title).toMatch(/Original title/);
  });

  // ---- Whole-conversation fork (no forkMsgId) ----

  it('whole-conversation fork walks the segment tail to find the fork point', async () => {
    const tailRows = [
      msgRow({ id: 'm5', role: 'assistant', tool_calls: null, status: 'complete' }),
      msgRow({ id: 'm4', role: 'user' }),
    ];
    const client = makeClient({
      threadRow: threadRow({ id: 'P', title: 'Original' }),
      tailRows,
      forkCount: 0,
      insertRow: threadRow({ id: 'F', forked_from_thread_id: 'P', forked_from_msg_id: 'm5' }),
    });
    const fork = await forkThread(client, 'P');
    // pickForkPoint walks newest-first and returns the first valid row,
    // which is m5 (the assistant reply at the tail).
    expect(fork.forked_from_msg_id).toBe('m5');
    expect(fork.forked_from_thread_id).toBe('P');
  });

  it('whole-conversation fork walks past invalid tail rows (streaming, tool rows)', async () => {
    const tailRows = [
      msgRow({ id: 'm-tool', role: 'tool', tool_calls: null, status: null }),
      msgRow({ id: 'm-stream', role: 'assistant', tool_calls: [], status: 'streaming' }),
      msgRow({ id: 'm-user', role: 'user' }),
    ];
    const client = makeClient({
      threadRow: threadRow({ id: 'P', title: 'Original' }),
      tailRows,
      forkCount: 0,
      insertRow: threadRow({ id: 'F', forked_from_thread_id: 'P', forked_from_msg_id: 'm-user' }),
    });
    const fork = await forkThread(client, 'P');
    // pickForkPoint skips the streaming row and the tool row, landing
    // on the user row.
    expect(fork.forked_from_msg_id).toBe('m-user');
  });

  it('whole-conversation fork on an empty own segment falls back to the source own fork point (sibling fork)', async () => {
    // A fork E has no own messages. Its own segment is empty.
    // forkThread should fall back to E's own forked_from_msg_id and
    // forked_from_thread_id, making the new thread a sibling of E.
    const client = makeClient({
      threadRow: threadRow({
        id: 'E',
        title: 'Empty fork',
        forked_from_thread_id: 'P',
        forked_from_msg_id: 'm1',
      }),
      tailRows: [], // empty own segment
      forkCount: 0,
      insertRow: threadRow({ id: 'F', forked_from_thread_id: 'P', forked_from_msg_id: 'm1' }),
    });
    const fork = await forkThread(client, 'E');
    expect(fork.forked_from_thread_id).toBe('P');
    expect(fork.forked_from_msg_id).toBe('m1');
  });

  // ---- Error cases ----

  it('throws SupabaseError when the source thread is not found', async () => {
    const client = makeClient({
      threadRow: null,
      msgRow: msgRow(),
    });
    await expect(forkThread(client, 'missing', 'm1')).rejects.toThrow(SupabaseError);
    await expect(forkThread(client, 'missing', 'm1')).rejects.toThrow('Conversation not found.');
  });

  it('throws SupabaseError when the fork-point message is not found', async () => {
    const client = makeClient({
      threadRow: threadRow({ id: 'P' }),
      msgRow: null,
    });
    await expect(forkThread(client, 'P', 'missing-msg')).rejects.toThrow(SupabaseError);
    await expect(forkThread(client, 'P', 'missing-msg')).rejects.toThrow('Fork point message not found.');
  });

  it('throws SupabaseError when the fork-point message is invalid (streaming)', async () => {
    const client = makeClient({
      threadRow: threadRow({ id: 'P' }),
      msgRow: msgRow({ id: 'm1', thread_id: 'P', role: 'assistant', status: 'streaming' }),
    });
    await expect(forkThread(client, 'P', 'm1')).rejects.toThrow(SupabaseError);
    await expect(forkThread(client, 'P', 'm1')).rejects.toThrow('A fork can only start at');
  });

  it('throws SupabaseError when the fork-point message is invalid (mid-round assistant with tool_calls)', async () => {
    const client = makeClient({
      threadRow: threadRow({ id: 'P' }),
      msgRow: msgRow({
        id: 'm1',
        thread_id: 'P',
        role: 'assistant',
        tool_calls: [{ type: 'function', function: { name: 'foo', arguments: '{}' } }],
        status: 'complete',
      }),
    });
    await expect(forkThread(client, 'P', 'm1')).rejects.toThrow('A fork can only start at');
  });

  it('throws SupabaseError when not authenticated', async () => {
    const client = makeClient({
      threadRow: threadRow({ id: 'P' }),
      msgRow: msgRow({ id: 'm1' }),
      session: null,
    });
    await expect(forkThread(client, 'P', 'm1')).rejects.toThrow(SupabaseError);
    await expect(forkThread(client, 'P', 'm1')).rejects.toThrow('Not authenticated.');
  });

  it('throws SupabaseError when the whole-conversation fork has no messages and no inherited fork point', async () => {
    // A root thread with no messages. No tail rows, no forked_from.
    const client = makeClient({
      threadRow: threadRow({ id: 'P', forked_from_thread_id: null, forked_from_msg_id: null }),
      tailRows: [],
    });
    await expect(forkThread(client, 'P')).rejects.toThrow('This conversation has no messages to fork yet.');
  });

  // ---- Inherited pins ----

  it('inherits model, reasoning, verbosity, and toolboxes from the source', async () => {
    const client = makeClient({
      threadRow: threadRow({
        id: 'P',
        title: 'Original',
        model: 'venice/llama-3.3-70b',
        reasoning_effort: 'high',
        verbosity: 'low',
        toolboxes_enabled: ['cooking', 'mcp-fastmail'],
        title_manually_set: true,
      }),
      msgRow: msgRow({ id: 'm1', thread_id: 'P' }),
      forkCount: 0,
      insertRow: threadRow({
        id: 'F',
        model: 'venice/llama-3.3-70b',
        reasoning_effort: 'high',
        verbosity: 'low',
        toolboxes_enabled: ['cooking', 'mcp-fastmail'],
        title_manually_set: true,
      }),
    });
    const fork = await forkThread(client, 'P', 'm1', { markTitle: false });
    expect(fork.model).toBe('venice/llama-3.3-70b');
    expect(fork.reasoning_effort).toBe('high');
    expect(fork.verbosity).toBe('low');
    expect(fork.toolboxes_enabled).toEqual(['cooking', 'mcp-fastmail']);
    expect(fork.title_manually_set).toBe(true);
  });
});
