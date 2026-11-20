// The write-side scrub for the B8 clarity key: updateSettings'
// whitelist decides which keys reach the merge RPC - a key missing
// from the whitelist is silently dropped (the round-trip trap). The
// read-side coercer is pinned in user-settings.test.ts; this file
// pins the write side, which had no coverage before B8.
import { describe, expect, it } from 'vitest';
import { updateSettings } from '../src/lib/supabase/settings';
import type { SupabaseClient } from '@supabase/supabase-js';

function fakeClient(): {
  client: SupabaseClient;
  rpcCalls: Array<{ name: string; args: Record<string, unknown> }>;
} {
  const rpcCalls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const client = {
    auth: {
      getSession: async () => ({
        data: { session: { user: { id: 'user-qa' } } },
        error: null,
      }),
    },
    rpc: (name: string, args: Record<string, unknown>) => {
      rpcCalls.push({ name, args });
      return Promise.resolve({ data: null, error: null });
    },
  } as unknown as SupabaseClient;
  return { client, rpcCalls };
}

function mergeArgs(rpcCalls: Array<{ name: string; args: Record<string, unknown> }>): {
  p_set: Record<string, unknown>;
  p_remove: string[];
} {
  const call = rpcCalls.find((c) => c.name === 'merge_profile_settings');
  expect(call, 'merge_profile_settings never ran').toBeTruthy();
  return call!.args as { p_set: Record<string, unknown>; p_remove: string[] };
}

describe('updateSettings scrub (write side)', () => {
  it('persists a boolean clearWritingEnabled through the merge RPC', async () => {
    const { client, rpcCalls } = fakeClient();
    await updateSettings(client, { clearWritingEnabled: true });
    const { p_set, p_remove } = mergeArgs(rpcCalls);
    expect(p_set.clearWritingEnabled).toBe(true);
    expect(p_remove).not.toContain('clearWritingEnabled');
  });

  it('routes an undefined patch value to the remove list', async () => {
    const { client, rpcCalls } = fakeClient();
    await updateSettings(client, {
      clearWritingEnabled: undefined,
    } as Partial<{ clearWritingEnabled: boolean }>);
    const { p_set, p_remove } = mergeArgs(rpcCalls);
    expect('clearWritingEnabled' in p_set).toBe(false);
    expect(p_remove).toContain('clearWritingEnabled');
  });

  it('never persists an unknown key', async () => {
    const { client, rpcCalls } = fakeClient();
    await updateSettings(client, {
      hackyKey: 'pwn',
    } as unknown as Partial<{ clearWritingEnabled: boolean }>);
    const { p_set, p_remove } = mergeArgs(rpcCalls);
    expect('hackyKey' in p_set).toBe(false);
    expect(p_remove).not.toContain('hackyKey');
  });
});
