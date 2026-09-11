/**
 * Unit tests for the realtime helpers' channel-topic contract. Three
 * halves:
 *
 *   - postgres_changes helpers open a FRESH topic per subscription.
 *     realtime-js returns the existing channel for a repeated topic
 *     while the old one is still leaving, and subscribe() on that
 *     channel is a silent no-op, so a same-topic resubscribe would
 *     leave the caller with no live stream. The destructive-edit
 *     replacement row is the write with the most at stake: its live
 *     delivery is that stream, with only the post-commit transcript
 *     re-fetch behind it.
 *   - Broadcast helpers keep a STABLE topic. The topic is the address
 *     the edge functions publish to, so a suffix would silently detach
 *     the subscriber from its publisher.
 *   - The agent-runs Broadcast helper SHARES one channel per user
 *     across concurrent consumers, closing it only when the last one
 *     leaves, because a second same-topic subscriber would otherwise
 *     get the first's channel and lose it on the first's teardown.
 */
import { describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  subscribeToAgentRunProgress,
  subscribeToGroceryChanges,
  subscribeToInflightLease,
  subscribeToLastRunOutcome,
  subscribeToMemoryChanges,
  subscribeToMessages,
  subscribeToRecipeChanges,
  subscribeToThreads,
  subscribeToUserLogs,
  subscribeToWikiArticleChanges,
  subscribeToWikiRecordChanges,
} from '../src/lib/supabase/realtime';

type BroadcastHandler = (msg: { payload: unknown }) => void;

interface FakeClient {
  client: SupabaseClient;
  topics: string[];
  /** Every callback registered through channel.on(), in order. */
  handlers: BroadcastHandler[];
  removeChannel: ReturnType<typeof vi.fn>;
}

function makeClient(): FakeClient {
  const topics: string[] = [];
  const handlers: BroadcastHandler[] = [];
  const channel = {
    on: (_type: string, _filter: unknown, cb: BroadcastHandler) => {
      handlers.push(cb);
      return channel;
    },
    subscribe: () => channel,
  };
  const removeChannel = vi.fn(async () => 'ok');
  const client = {
    channel: (topic: string) => {
      topics.push(topic);
      return channel;
    },
    removeChannel,
  } as unknown as SupabaseClient;
  return { client, topics, handlers, removeChannel };
}

const noop = (): void => {};

/**
 * Every postgres_changes helper, wrapped to a common (client) => unsub
 * shape so one assertion loop covers the whole family. Adding a helper
 * to realtime.ts without adding it here leaves its topic contract
 * unpinned - the reviewer's list to check is this one.
 */
const POSTGRES_HELPERS: { name: string; prefix: string; subscribe: (c: SupabaseClient) => () => void }[] = [
  { name: 'subscribeToMessages', prefix: 'messages:thread-1:', subscribe: (c) => subscribeToMessages(c, 'thread-1', noop) },
  { name: 'subscribeToThreads', prefix: 'threads:user-1:', subscribe: (c) => subscribeToThreads(c, 'user-1', {}) },
  {
    name: 'subscribeToInflightLease',
    prefix: 'inflight_lease:wiki_librarian_inflight_expires_at:user-1:',
    subscribe: (c) => subscribeToInflightLease(c, 'user-1', 'wiki_librarian_inflight_expires_at', noop),
  },
  {
    name: 'subscribeToLastRunOutcome',
    prefix: 'last_run_outcome:wiki_librarian_last_run_outcome:user-1:',
    subscribe: (c) => subscribeToLastRunOutcome(c, 'user-1', 'wiki_librarian_last_run_outcome', noop),
  },
  { name: 'subscribeToWikiArticleChanges', prefix: 'wiki_articles:user-1:', subscribe: (c) => subscribeToWikiArticleChanges(c, 'user-1', noop) },
  { name: 'subscribeToWikiRecordChanges', prefix: 'wiki_records:user-1:', subscribe: (c) => subscribeToWikiRecordChanges(c, 'user-1', noop) },
  { name: 'subscribeToGroceryChanges', prefix: 'grocery:user-1:', subscribe: (c) => subscribeToGroceryChanges(c, 'user-1', noop) },
  { name: 'subscribeToMemoryChanges', prefix: 'memories:user-1:', subscribe: (c) => subscribeToMemoryChanges(c, 'user-1', noop) },
  { name: 'subscribeToRecipeChanges', prefix: 'recipes:user-1:', subscribe: (c) => subscribeToRecipeChanges(c, 'user-1', noop) },
];

describe('postgres_changes helpers', () => {
  for (const helper of POSTGRES_HELPERS) {
    it(`${helper.name} opens a fresh topic on every subscription for the same key`, () => {
      const { client, topics } = makeClient();
      const unsubscribe = helper.subscribe(client);
      unsubscribe();
      helper.subscribe(client);
      expect(topics).toHaveLength(2);
      expect(topics[0]).not.toBe(topics[1]);
      for (const topic of topics) expect(topic.startsWith(helper.prefix)).toBe(true);
    });
  }
});

describe('Broadcast helpers', () => {
  it('subscribeToUserLogs keeps the stable topic the edge functions publish to', () => {
    const { client, topics } = makeClient();
    const unsubscribe = subscribeToUserLogs(client, 'user-1', noop);
    unsubscribe();
    subscribeToUserLogs(client, 'user-1', noop);
    expect(topics).toEqual(['logs:user-1', 'logs:user-1']);
  });

  it('subscribeToAgentRunProgress shares one channel across concurrent consumers', async () => {
    const { client, topics, handlers, removeChannel } = makeClient();
    const first: unknown[] = [];
    const second: unknown[] = [];
    const unsubFirst = subscribeToAgentRunProgress(client, 'user-1', (e) => first.push(e));
    const unsubSecond = subscribeToAgentRunProgress(client, 'user-1', (e) => second.push(e));
    // One channel, one broadcast binding, both consumers fed.
    expect(topics).toEqual(['agent-runs:user-1']);
    expect(handlers).toHaveLength(1);
    handlers[0]({ payload: { runId: 'r1', kind: 'progress' } });
    expect(first).toHaveLength(1);
    expect(second).toHaveLength(1);
    // The first consumer leaving does not close the shared channel or
    // deafen the survivor.
    unsubFirst();
    expect(removeChannel).not.toHaveBeenCalled();
    handlers[0]({ payload: { runId: 'r1', kind: 'result' } });
    expect(first).toHaveLength(1);
    expect(second).toHaveLength(2);
    // The last consumer out closes it, once.
    unsubSecond();
    expect(removeChannel).toHaveBeenCalledTimes(1);
    // A consumer arriving after the leave settles opens a fresh channel.
    // The leave resolves through two promise hops (removeChannel, then
    // the registry cleanup), so yield a macrotask rather than one tick.
    await new Promise((resolve) => setTimeout(resolve, 0));
    subscribeToAgentRunProgress(client, 'user-1', noop);
    expect(topics).toEqual(['agent-runs:user-1', 'agent-runs:user-1']);
  });
});
