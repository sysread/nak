/**
 * Unit coverage for the wiki manual-update preview-display primitives
 * (src/lib/ui/wiki-manual.ts) the Svelte panel renders. The agent-side
 * JSON parser + record-op validation moved server-side with the agent;
 * its coverage now lives in supabase/functions/tests/wiki_manual.test.ts
 * (Deno). Pure functions - no Venice round-trip, no DOM.
 */
import { describe, it, expect } from 'vitest';
import type { WikiRecord, RecordOp } from '../src/lib/supabase';
import {
  describeRecordOp,
  describeRecordOps,
  recordOpsHeadline,
} from '../src/lib/ui/wiki-manual';

function makeRecord(over: Partial<WikiRecord> = {}): WikiRecord {
  return {
    id: 'rec-1',
    article_id: 'art-1',
    date: '2026-06-17',
    content: 'Baked an 80% hydration loaf',
    tags: ['sourdough'],
    source_conversation_id: null,
    created_at: '2026-06-17T00:00:00Z',
    updated_at: '2026-06-17T00:00:00Z',
    ...over,
  };
}

describe('describeRecordOp / describeRecordOps', () => {
  const records = [makeRecord({ id: 'rec-1', date: '2026-06-17', content: 'Old body', tags: ['t'] })];
  const byId = new Map(records.map((r) => [r.id, r]));

  it('projects a create from the proposed values', () => {
    const op: RecordOp = { op: 'create', date: '2026-06-21', content: 'New', tags: ['x'] };
    expect(describeRecordOp(op, byId)).toMatchObject({
      kind: 'create',
      label: 'Add record',
      content: 'New',
      tags: ['x'],
    });
  });

  it('fills an update unchanged fields from the existing record', () => {
    // Only content changes; date + tags fall back to what is on file so
    // the preview shows the record as it would stand, not just the patch.
    const op: RecordOp = { op: 'update', id: 'rec-1', content: 'Patched' };
    const view = describeRecordOp(op, byId);
    expect(view).toMatchObject({ kind: 'update', label: 'Edit record', content: 'Patched', tags: ['t'] });
    expect(view.date).not.toBe('');
  });

  it('shows the existing body for a delete', () => {
    const op: RecordOp = { op: 'delete', id: 'rec-1' };
    expect(describeRecordOp(op, byId)).toMatchObject({
      kind: 'delete',
      label: 'Delete record',
      content: 'Old body',
    });
  });

  it('degrades gracefully when a delete/update id is missing from the map', () => {
    const op: RecordOp = { op: 'delete', id: 'gone' };
    expect(describeRecordOp(op, new Map())).toMatchObject({ kind: 'delete', content: '', date: '' });
  });

  it('maps a whole op list and short-circuits the empty case', () => {
    expect(describeRecordOps([], records)).toEqual([]);
    const views = describeRecordOps(
      [
        { op: 'create', date: '2026-06-21', content: 'New', tags: [] },
        { op: 'delete', id: 'rec-1' },
      ],
      records
    );
    expect(views.map((v) => v.kind)).toEqual(['create', 'delete']);
  });
});

describe('recordOpsHeadline', () => {
  it('pluralizes and drops the zero case', () => {
    expect(recordOpsHeadline(0)).toBe('');
    expect(recordOpsHeadline(1)).toBe('1 record change');
    expect(recordOpsHeadline(3)).toBe('3 record changes');
  });
});
