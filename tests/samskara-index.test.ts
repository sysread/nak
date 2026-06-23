/**
 * Coverage for the samskara chat-loop surface (src/lib/samskara/index.ts).
 *
 * recordSubstrateStub is the ONLY client-side samskara write the chat
 * loop performs since pre-turn priming moved server-side. Its
 * load-bearing contract is the error-swallow: a samskara failure must
 * never block a user's chat turn (see chat.md and the index.ts
 * preamble). supabase-js re-throws the raw fetch TypeError ("Failed to
 * fetch") on a network blip rather than returning it in the { error }
 * envelope, so without the swallow a transient offline moment would
 * paint an error banner at turn-start. That swallow is exactly what
 * this suite pins.
 *
 * Drives the real function against a mock SupabaseService, the same
 * shape samskara-browse-store.test.ts uses.
 */
import { describe, it, expect, vi } from 'vitest';
import { recordSubstrateStub } from '../src/lib/samskara/index';
import type { SupabaseService } from '../src/lib/supabase';

function fakeSupabase(overrides: Partial<SupabaseService> = {}): SupabaseService {
  return {
    samskaraRecordSubstrate: vi.fn(async () => 'substrate-id'),
    ...overrides,
  } as unknown as SupabaseService;
}

describe('recordSubstrateStub', () => {
  it('forwards the thread and message ids to the substrate write', async () => {
    const recordSubstrate = vi.fn(async () => 'sid');
    const sb = fakeSupabase({
      samskaraRecordSubstrate: recordSubstrate,
    } as unknown as Partial<SupabaseService>);

    await recordSubstrateStub(sb, 'thread', 'user-msg', 'assistant-msg');
    expect(recordSubstrate).toHaveBeenCalledWith('thread', 'user-msg', 'assistant-msg');
  });

  it('swallows a write failure without throwing (fire-and-forget)', async () => {
    const sb = fakeSupabase({
      samskaraRecordSubstrate: vi.fn(async () => {
        throw new TypeError('Failed to fetch');
      }),
    } as unknown as Partial<SupabaseService>);
    await expect(recordSubstrateStub(sb, 'thread', 'user-msg', null)).resolves.toBeUndefined();
  });
});
