/**
 * Unit tests for subscribeToMessages' channel lifecycle: back-to-back
 * subscriptions for the same thread must never share a channel topic.
 * realtime-js returns the existing channel for a repeated topic while
 * the old one is still leaving, and subscribe() on that channel is a
 * silent no-op, so a same-topic resubscribe would leave the thread
 * with no live echo stream (the destructive-edit replacement row is
 * delivered only by that stream).
 */
import { describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { subscribeToMessages } from '../src/lib/supabase/realtime';

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

describe('subscribeToMessages', () => {
  it('opens a fresh channel topic on every subscription for the same thread', () => {
    const { client, topics } = makeClient();
    const unsubscribe = subscribeToMessages(client, 'thread-1', () => {});
    unsubscribe();
    subscribeToMessages(client, 'thread-1', () => {});
    expect(topics).toHaveLength(2);
    expect(topics[0]).not.toBe(topics[1]);
    for (const topic of topics) expect(topic.startsWith('messages:thread-1:')).toBe(true);
  });
});
