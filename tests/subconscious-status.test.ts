/**
 * Unit coverage for the subconscious-priming checklist UI primitives.
 * Pure functions - no runes, no DOM - tested via plain vitest.
 *
 * The companion wiring (a SvelteMap on ExchangeSlot, populated by the
 * chat-loop's onSubconsciousStart/End handlers and rendered as a
 * spinner/checkmark checklist in the streaming bubble) lives in
 * Chat.svelte and exchange-slot.svelte.ts; a port to another framework
 * would reuse this module untouched.
 */
import { describe, it, expect } from 'vitest';
import type { SubconsciousOp } from '../src/lib/chat-loop';
import {
  orderedSubconsciousRows,
  subconsciousLabel,
  type SubconsciousStatus,
} from '../src/lib/ui/subconscious-status';

function statusMap(
  entries: [SubconsciousOp, SubconsciousStatus][]
): Map<SubconsciousOp, SubconsciousStatus> {
  return new Map(entries);
}

describe('subconsciousLabel', () => {
  it('maps each op to its felt-activity status line', () => {
    expect(subconsciousLabel('samskara')).toBe('Reacting');
    expect(subconsciousLabel('intuition')).toBe('Predicting');
    expect(subconsciousLabel('recall')).toBe('Recalling');
  });
});

describe('orderedSubconsciousRows', () => {
  it('returns rows in the stable fire -> intuition -> recall order', () => {
    // Insertion order deliberately scrambled to prove the output order
    // comes from the canonical ORDER, not the map's iteration order.
    const rows = orderedSubconsciousRows(
      statusMap([
        ['recall', 'running'],
        ['samskara', 'done'],
        ['intuition', 'running'],
      ])
    );
    expect(rows).toEqual([
      { op: 'samskara', status: 'done' },
      { op: 'intuition', status: 'running' },
      { op: 'recall', status: 'running' },
    ]);
  });

  it('carries each row its current running/done status', () => {
    expect(orderedSubconsciousRows(statusMap([['recall', 'done']]))).toEqual([
      { op: 'recall', status: 'done' },
    ]);
    expect(
      orderedSubconsciousRows(statusMap([['samskara', 'running']]))
    ).toEqual([{ op: 'samskara', status: 'running' }]);
  });

  it('omits ops that have not fired', () => {
    const rows = orderedSubconsciousRows(statusMap([['intuition', 'done']]));
    expect(rows).toEqual([{ op: 'intuition', status: 'done' }]);
  });

  it('is empty when nothing has fired', () => {
    expect(orderedSubconsciousRows(statusMap([]))).toEqual([]);
  });
});
