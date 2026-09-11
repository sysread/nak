/**
 * Unit tests for the realtime helpers' channel-topic contract. Two
 * halves:
 *
 *   - postgres_changes helpers open a FRESH topic per subscription.
 *     realtime-js returns the existing channel for a repeated topic
 *     while the old one is still leaving, and subscribe() on that
 *     channel is a silent no-op, so a same-topic resubscribe would
 *     leave the caller with no live stream (the destructive-edit
 *     replacement row is delivered only by that stream).
 *   - Broadcast helpers keep a STABLE topic. The topic is the address
 *     the edge functions publish to, so a suffix would silently detach
 *     the subscriber from its publisher.
 */
import { describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  subscribeToMessages,
  subscribeToThreads,
  subscribeToUserLogs,
} from '../src/lib/supabase/realtime';

function makeClient(): { client: SupabaseClient; topics: string[] } {
  const topics: string[] = [];
  const channel = {
    on: () => channel,
    subscribe: () => channel,
  };
  const client = {
    channel: (topic: string) => {
      topics.push(topic);
      return channel;
    },
    removeChannel: vi.fn(async () => 'ok'),
  } as unknown as SupabaseClient;
  return { client, topics };
}

describe('postgres_changes helpers', () => {
  it('subscribeToMessages opens a fresh topic on every subscription for the same thread', () => {
    const { client, topics } = makeClient();
    const unsubscribe = subscribeToMessages(client, 'thread-1', () => {});
    unsubscribe();
    subscribeToMessages(client, 'thread-1', () => {});
    expect(topics).toHaveLength(2);
    expect(topics[0]).not.toBe(topics[1]);
    for (const topic of topics) expect(topic.startsWith('messages:thread-1:')).toBe(true);
  });

  it('subscribeToThreads opens a fresh topic on every subscription for the same user', () => {
    const { client, topics } = makeClient();
    const unsubscribe = subscribeToThreads(client, 'user-1', {});
    unsubscribe();
    subscribeToThreads(client, 'user-1', {});
    expect(topics).toHaveLength(2);
    expect(topics[0]).not.toBe(topics[1]);
    for (const topic of topics) expect(topic.startsWith('threads:user-1:')).toBe(true);
  });
});

describe('Broadcast helpers', () => {
  it('subscribeToUserLogs keeps the stable topic the edge functions publish to', () => {
    const { client, topics } = makeClient();
    const unsubscribe = subscribeToUserLogs(client, 'user-1', () => {});
    unsubscribe();
    subscribeToUserLogs(client, 'user-1', () => {});
    expect(topics).toEqual(['logs:user-1', 'logs:user-1']);
  });
});
