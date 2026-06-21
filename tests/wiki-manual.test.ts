/**
 * Unit coverage for the wiki manual-update record-ops path:
 *   - the agent-side JSON parser and record-op validation
 *     (src/lib/agents/wiki/agent.ts __test), which is where the
 *     load-bearing safety logic lives - hallucinated-id rejection, the
 *     body-vs-records noop detection feeding off it, the per-op
 *     normalisation;
 *   - the preview-display primitives (src/lib/ui/wiki-manual.ts) the
 *     Svelte panel renders.
 * Pure functions - no Venice round-trip, no DOM.
 */
import { describe, it, expect } from 'vitest';
import type { WikiRecord } from '../src/lib/supabase';
import type { RecordOp } from '../src/lib/agents/wiki/agent';
import { __test } from '../src/lib/agents/wiki/agent';
import {
  describeRecordOp,
  describeRecordOps,
  recordOpsHeadline,
} from '../src/lib/ui/wiki-manual';

const { parseManualDecision, parseRecordOps, renderRecordsForPrompt } = __test;

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

describe('parseRecordOps', () => {
  const known = new Set(['rec-1', 'rec-2']);

  it('accepts a well-formed create and coerces its tags', () => {
    const ops = parseRecordOps(
      [{ op: 'create', date: '2026-06-21', content: 'A bake', tags: ['a', 'a', '', 'b'] }],
      known
    );
    expect(ops).toEqual([
      { op: 'create', date: '2026-06-21', content: 'A bake', tags: ['a', 'b'] },
    ]);
  });

  it('drops a create missing date or content', () => {
    expect(parseRecordOps([{ op: 'create', content: 'no date' }], known)).toEqual([]);
    expect(parseRecordOps([{ op: 'create', date: '2026-06-21', content: '   ' }], known)).toEqual(
      []
    );
  });

  it('keeps an update only for a known id with at least one changed field', () => {
    const ops = parseRecordOps(
      [{ op: 'update', id: 'rec-1', content: 'fixed text' }],
      known
    );
    expect(ops).toEqual([{ op: 'update', id: 'rec-1', content: 'fixed text' }]);
  });

  it('drops an update referencing an id the model was never shown', () => {
    // Hallucinated-id rejection: the whole reason knownIds is threaded
    // through the parser. A phantom id must never reach the preview.
    expect(parseRecordOps([{ op: 'update', id: 'ghost', content: 'x' }], known)).toEqual([]);
  });

  it('drops an update that changes nothing', () => {
    expect(parseRecordOps([{ op: 'update', id: 'rec-1' }], known)).toEqual([]);
  });

  it('keeps a delete for a known id, drops one for an unknown id', () => {
    expect(parseRecordOps([{ op: 'delete', id: 'rec-2' }], known)).toEqual([
      { op: 'delete', id: 'rec-2' },
    ]);
    expect(parseRecordOps([{ op: 'delete', id: 'ghost' }], known)).toEqual([]);
  });

  it('skips garbage entries and a non-array payload', () => {
    expect(parseRecordOps('nope', known)).toEqual([]);
    expect(parseRecordOps([null, 42, { op: 'frobnicate' }, {}], known)).toEqual([]);
  });
});

describe('parseManualDecision', () => {
  const known = new Set(['rec-1']);

  it('parses a body update plus record ops', () => {
    const text = JSON.stringify({
      action: 'update',
      title: 'New title',
      content: 'New body',
      reason: 'Did the thing',
      records: [{ op: 'delete', id: 'rec-1' }],
    });
    const decision = parseManualDecision(text, known);
    expect(decision).toEqual({
      action: 'update',
      title: 'New title',
      content: 'New body',
      reason: 'Did the thing',
      records: [{ op: 'delete', id: 'rec-1' }],
    });
  });

  it('parses a records-only noop (action noop, records present)', () => {
    const text = JSON.stringify({
      action: 'noop',
      reason: 'Just logging a bake',
      records: [{ op: 'create', date: '2026-06-21', content: 'A bake' }],
    });
    const decision = parseManualDecision(text, known);
    expect(decision?.action).toBe('noop');
    expect(decision?.records).toEqual([
      { op: 'create', date: '2026-06-21', content: 'A bake', tags: [] },
    ]);
  });

  it('tolerates a markdown code fence around the JSON', () => {
    const text = '```json\n{"action":"noop","reason":"fine","records":[]}\n```';
    const decision = parseManualDecision(text, known);
    expect(decision?.action).toBe('noop');
    expect(decision?.records).toEqual([]);
  });

  it('returns null on unparseable text', () => {
    expect(parseManualDecision('not json at all', known)).toBeNull();
    expect(parseManualDecision('', known)).toBeNull();
  });

  it('defaults a missing records field to an empty array', () => {
    const decision = parseManualDecision('{"action":"update","content":"x"}', known);
    expect(decision?.records).toEqual([]);
  });
});

describe('renderRecordsForPrompt', () => {
  it('names the empty case', () => {
    expect(renderRecordsForPrompt([])).toBe('This article has no records yet.');
  });

  it('lists each record with its id, date, tags, and body', () => {
    const text = renderRecordsForPrompt([makeRecord()]);
    expect(text).toContain('[id: rec-1]');
    expect(text).toContain('2026-06-17');
    expect(text).toContain('(tags: sourdough)');
    expect(text).toContain('Baked an 80% hydration loaf');
  });

  it('notes overflow when more records exist than it lists', () => {
    const many = Array.from({ length: 105 }, (_, i) => makeRecord({ id: `rec-${i}` }));
    const text = renderRecordsForPrompt(many);
    expect(text).toContain('not shown');
  });
});

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
