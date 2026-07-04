import { describe, it, expect } from 'vitest';
import {
  DIAGNOSTIC_PILLS,
  visibleDiagnosticPills,
  type DiagnosticPillContext,
} from '../src/lib/ui/diagnostic-pills';

// A context with every pill present and openable. Individual tests carve
// pieces away from this baseline.
function fullContext(): DiagnosticPillContext {
  return {
    recall: { v: 2, note: 'remembered something', citations: [] } as never,
    intuition: { v: 1, synthesis: 'a hunch' } as never,
    moodVisual: {
      id: 1,
      emoji: '\u{1F60A}',
      label: 'cheerful',
      tier: 1,
      isDefault: false,
    },
    intentsEnabled: true,
  };
}

const idsOf = (ctx: DiagnosticPillContext) =>
  visibleDiagnosticPills(ctx).map((p) => p.descriptor.id);

describe('DIAGNOSTIC_PILLS order', () => {
  it('is the canonical top-to-bottom sequence', () => {
    expect(DIAGNOSTIC_PILLS.map((p) => p.id)).toEqual([
      'recall',
      'intuition',
      'bias',
      'samskara',
      'intents',
    ]);
  });

  it('each pill points at a distinct diagnostics modal', () => {
    const modals = DIAGNOSTIC_PILLS.map((p) => p.modal);
    expect(new Set(modals).size).toBe(modals.length);
  });
});

describe('visibleDiagnosticPills presence', () => {
  it('shows all five when everything is present', () => {
    expect(idsOf(fullContext())).toEqual([
      'recall',
      'intuition',
      'bias',
      'samskara',
      'intents',
    ]);
  });

  it('keeps intents present when intents is off - the modal hosts follow-ups too', () => {
    // The seedling pill stopped being intents-gated when follow-ups
    // moved into the same modal: every account has follow-ups, so the
    // pill holds its slot and only the copy changes (see below).
    expect(idsOf({ ...fullContext(), intentsEnabled: false })).toEqual([
      'recall',
      'intuition',
      'bias',
      'samskara',
      'intents',
    ]);
  });

  it('drops samskara when no thread is active (moodVisual null)', () => {
    expect(idsOf({ ...fullContext(), moodVisual: null })).toEqual([
      'recall',
      'intuition',
      'bias',
      'intents',
    ]);
  });

  it('keeps recall and intuition present even with no payload', () => {
    // They render disabled, not absent - the slot is held.
    expect(idsOf({ ...fullContext(), recall: null, intuition: null })).toContain(
      'recall'
    );
    expect(idsOf({ ...fullContext(), recall: null, intuition: null })).toContain(
      'intuition'
    );
  });
});

describe('visibleDiagnosticPills positioning', () => {
  it('stacks bottom-up at a 2.5rem step, lowest at 3.6rem', () => {
    const positioned = visibleDiagnosticPills(fullContext());
    // Top-to-bottom: recall (highest), ..., intents (lowest at base).
    expect(positioned.map((p) => [p.descriptor.id, p.bottom])).toEqual([
      ['recall', '13.6rem'],
      ['intuition', '11.1rem'],
      ['bias', '8.6rem'],
      ['samskara', '6.1rem'],
      ['intents', '3.6rem'],
    ]);
  });

  it('collapses an absent pill rather than leaving a gap', () => {
    // Samskara absent (new-chat screen): the column drops one step and
    // the lowest pill (intents) sits flush at the base, no empty slot.
    const positioned = visibleDiagnosticPills({
      ...fullContext(),
      moodVisual: null,
    });
    expect(positioned.map((p) => [p.descriptor.id, p.bottom])).toEqual([
      ['recall', '11.1rem'],
      ['intuition', '8.6rem'],
      ['bias', '6.1rem'],
      ['intents', '3.6rem'],
    ]);
  });
});

describe('descriptor label/enabled logic', () => {
  const byId = (id: string) => DIAGNOSTIC_PILLS.find((p) => p.id === id)!;

  it('recall is disabled with an empty note, enabled with content', () => {
    const recall = byId('recall');
    expect(recall.enabled({ ...fullContext(), recall: null })).toBe(false);
    expect(
      recall.enabled({
        ...fullContext(),
        recall: { v: 2, note: '   ', citations: [] } as never,
      })
    ).toBe(false);
    expect(recall.enabled(fullContext())).toBe(true);
  });

  it('intuition is disabled with no payload', () => {
    const intuition = byId('intuition');
    expect(intuition.enabled({ ...fullContext(), intuition: null })).toBe(false);
    expect(intuition.enabled(fullContext())).toBe(true);
  });

  it('bias is always enabled', () => {
    expect(byId('bias').enabled({ ...fullContext(), recall: null })).toBe(true);
  });

  it('intents pill copy adapts to the intents toggle', () => {
    const intents = byId('intents');
    const on = fullContext();
    const off = { ...fullContext(), intentsEnabled: false };
    expect(intents.title(on)).toContain('working intentions and follow-ups');
    expect(intents.title(off)).toContain('follow-ups');
    expect(intents.title(off)).not.toContain('working intentions');
    expect(intents.ariaLabel(off)).toBe('Open follow-ups inspector');
  });

  it('samskara derives glyph and label from the live mood', () => {
    const samskara = byId('samskara');
    const ctx = fullContext();
    expect(samskara.emoji(ctx)).toBe('\u{1F60A}');
    expect(samskara.title(ctx)).toContain('cheerful');
  });

  it('samskara shows the placeholder glyph before real data lands', () => {
    const samskara = byId('samskara');
    const ctx: DiagnosticPillContext = {
      ...fullContext(),
      moodVisual: {
        id: 1,
        emoji: '\u{1F4A4}',
        label: 'idle',
        tier: 1,
        isDefault: true,
      },
    };
    expect(samskara.emoji(ctx)).toBe('\u{1F4A4}');
    expect(samskara.title(ctx)).toContain('no mood data');
  });
});
