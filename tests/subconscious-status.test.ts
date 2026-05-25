/**
 * Unit coverage for the subconscious-priming throbber UI primitives.
 * Pure functions - no runes, no DOM - tested via plain vitest.
 *
 * The companion wiring (a SvelteSet on ExchangeSlot, populated by the
 * chat-loop's onSubconsciousStart/End handlers and rendered in the
 * streaming bubble) lives in Chat.svelte and exchange-slot.svelte.ts;
 * a port to another framework would reuse this module untouched.
 */
import { describe, it, expect } from 'vitest';
import type { SubconsciousOp } from '../src/lib/chat-loop';
import { orderedOps, subconsciousLabel } from '../src/lib/ui/subconscious-status';

describe('subconsciousLabel', () => {
  it('maps each op to its felt-activity status line', () => {
    expect(subconsciousLabel('samskara')).toBe('Reacting to the situation');
    expect(subconsciousLabel('intuition')).toBe('Predicting outcomes');
    expect(subconsciousLabel('recall')).toBe('Remembering past interactions');
  });
});

describe('orderedOps', () => {
  it('returns the active ops in the stable fire -> intuition -> recall order', () => {
    // Insertion order deliberately scrambled to prove the output order
    // comes from the canonical ORDER, not the set's iteration order.
    const active = new Set<SubconsciousOp>(['recall', 'samskara', 'intuition']);
    expect(orderedOps(active)).toEqual(['samskara', 'intuition', 'recall']);
  });

  it('filters to only the in-flight ops', () => {
    expect(orderedOps(new Set<SubconsciousOp>(['recall']))).toEqual(['recall']);
    expect(orderedOps(new Set<SubconsciousOp>(['intuition', 'samskara']))).toEqual([
      'samskara',
      'intuition',
    ]);
  });

  it('is empty when nothing is in flight', () => {
    expect(orderedOps(new Set<SubconsciousOp>())).toEqual([]);
  });
});
