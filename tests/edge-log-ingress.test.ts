/**
 * Unit coverage for `appendFromEdge` - the browser ingress that feeds
 * edge-function log broadcasts into the shared Logs drawer ring buffer.
 * The edge logger (supabase/functions/_shared/edge-log.ts) publishes a
 * SerializableLogEntry over Realtime; SupabaseService.subscribeToUserLogs
 * hands the payload here. We assert the entry lands in the buffer with
 * its details reconstituted, identically to a relayed worker log.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  appendFromEdge,
  logs,
  type SerializableLogEntry,
} from '../src/lib/logger.svelte';

describe('appendFromEdge', () => {
  beforeEach(() => logs.clear());

  it('pushes an edge entry into the ring buffer with string details intact', () => {
    const entry: SerializableLogEntry = {
      timestamp: 123,
      level: 'info',
      source: 'reflection',
      message: 'finished thread t1',
      details: [{ kind: 'string', value: 'over 4 messages' }],
    };
    appendFromEdge(entry);

    const last = logs.entries.at(-1);
    expect(last?.message).toBe('finished thread t1');
    expect(last?.source).toBe('reflection');
    expect(last?.level).toBe('info');
    expect(last?.details).toEqual(['over 4 messages']);
  });

  it('reconstitutes an error detail into an Error-like object', () => {
    appendFromEdge({
      timestamp: 1,
      level: 'error',
      source: 'reflection',
      message: 'reflection cycle failed',
      details: [{ kind: 'error', name: 'Error', message: 'nope', stack: null }],
    });

    const last = logs.entries.at(-1);
    const detail = last?.details[0] as Error;
    expect(detail.name).toBe('Error');
    expect(detail.message).toBe('nope');
  });
});
