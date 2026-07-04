/**
 * Unit coverage for the wiki-librarian-run UI primitives. Pure functions -
 * no runes, no DOM - tested via plain vitest. The companion
 * src/screens/Wiki.svelte composes these with the Broadcast subscription,
 * the POST, and the markup.
 *
 * The headline guarantee under test: finalizeLibrarianSteps settles a
 * still-spinning trailing row from the POST outcome, so a run whose terminal
 * `done` broadcast never arrived (gateway-timeout case) cannot leave the
 * spinner running forever.
 */
import { describe, it, expect } from 'vitest';
import type {
  AgentRunProgressEvent,
  ManualRunOutcome,
  WikiLibrarianRunResult,
} from '../src/lib/supabase';
import { MAX_RECOVERED_OUTCOME_AGE_MS } from '../src/lib/ui/manual-run-recovery';
import {
  appendProgressStep,
  finalizeLibrarianSteps,
  librarianRunButtonLabel,
  librarianRunElsewhere,
  librarianStepGlyph,
  librarianResultMeta,
  recoverLibrarianOutcome,
  LIBRARIAN_BUSY_MESSAGE,
  LIBRARIAN_PARTIAL_SAVE_NOTE,
  type LibrarianStep,
} from '../src/lib/ui/wiki-librarian-run';

// runId is filtered upstream; the transforms ignore it, but the type wants it.
// DistributiveOmit so the omit applies to each union member (a plain Omit over
// a union collapses to the members' common keys - here just `kind`).
type DistributiveOmit<T, K extends keyof T> = T extends unknown ? Omit<T, K> : never;
function ev(e: DistributiveOmit<AgentRunProgressEvent, 'runId'>): AgentRunProgressEvent {
  return { runId: 'r', ...e } as AgentRunProgressEvent;
}

describe('appendProgressStep', () => {
  it('preparing pushes a pending row with a pluralized count', () => {
    expect(appendProgressStep([], ev({ kind: 'preparing', articleCount: 1 }))).toEqual([
      { label: 'Loading 1 article', status: 'pending' },
    ]);
    expect(appendProgressStep([], ev({ kind: 'preparing', articleCount: 3 }))).toEqual([
      { label: 'Loading 3 articles', status: 'pending' },
    ]);
  });

  it('defaults a missing count to 0 rather than rendering undefined', () => {
    expect(appendProgressStep([], ev({ kind: 'preparing' }))).toEqual([
      { label: 'Loading 0 articles', status: 'pending' },
    ]);
  });

  it('thinking settles the prior pending row to ok before pushing its own', () => {
    const after = appendProgressStep(
      [{ label: 'Loading 2 articles', status: 'pending' }],
      ev({ kind: 'thinking', round: 1 }),
    );
    expect(after).toEqual([
      { label: 'Loading 2 articles', status: 'ok' },
      { label: 'Thinking (round 1)', status: 'pending' },
    ]);
  });

  it('tool prefers the model activity and records its own ok/error', () => {
    const base: LibrarianStep[] = [{ label: 'Thinking (round 1)', status: 'pending' }];
    expect(
      appendProgressStep(base, ev({ kind: 'tool', name: 'wiki_update', activity: 'Merging Maya articles', ok: true, ms: 5 })),
    ).toEqual([
      { label: 'Thinking (round 1)', status: 'ok' },
      { label: 'Merging Maya articles', status: 'ok' },
    ]);
    // Empty activity falls back to the bare tool name.
    expect(
      appendProgressStep([], ev({ kind: 'tool', name: 'wiki_delete', activity: '   ', ok: false, ms: 5 })),
    ).toEqual([{ label: 'wiki_delete', status: 'error' }]);
  });

  it('done settles the trailing pending row without pushing a new one', () => {
    const base: LibrarianStep[] = [
      { label: 'Loading 2 articles', status: 'ok' },
      { label: 'Thinking (round 2)', status: 'pending' },
    ];
    expect(appendProgressStep(base, ev({ kind: 'done', ok: true }))).toEqual([
      { label: 'Loading 2 articles', status: 'ok' },
      { label: 'Thinking (round 2)', status: 'ok' },
    ]);
  });

  it('does not mutate the input array', () => {
    const base: LibrarianStep[] = [{ label: 'Thinking (round 1)', status: 'pending' }];
    const snapshot = structuredClone(base);
    appendProgressStep(base, ev({ kind: 'thinking', round: 2 }));
    expect(base).toEqual(snapshot);
  });
});

describe('finalizeLibrarianSteps', () => {
  it('settles a still-pending trailing row to error when the run failed/timed out', () => {
    // This is the gateway-timeout case: steps stopped at a pending row
    // because `done` never arrived. Finalize must stop the spinner.
    const stuck: LibrarianStep[] = [
      { label: 'Loading 5 articles', status: 'ok' },
      { label: 'Thinking (round 3)', status: 'pending' },
    ];
    expect(finalizeLibrarianSteps(stuck, 'error')).toEqual([
      { label: 'Loading 5 articles', status: 'ok' },
      { label: 'Thinking (round 3)', status: 'error' },
    ]);
  });

  it('settles a still-pending trailing row to ok and appends Done on a clean finish', () => {
    const pending: LibrarianStep[] = [{ label: 'Thinking (round 1)', status: 'pending' }];
    expect(finalizeLibrarianSteps(pending, 'ok')).toEqual([
      { label: 'Thinking (round 1)', status: 'ok' },
      { label: 'Done', status: 'ok' },
    ]);
  });

  it('appends Done even when the trailing row already settled', () => {
    const settled: LibrarianStep[] = [{ label: 'Merging Maya articles', status: 'ok' }];
    expect(finalizeLibrarianSteps(settled, 'ok')).toEqual([
      { label: 'Merging Maya articles', status: 'ok' },
      { label: 'Done', status: 'ok' },
    ]);
  });

  it('does not append a terminal row on the error/timeout path', () => {
    // The error message + the trailing X already mark the end; a
    // client-side timeout may mean the run is still going server-side.
    const settled: LibrarianStep[] = [{ label: 'Merging Maya articles', status: 'ok' }];
    expect(finalizeLibrarianSteps(settled, 'error')).toEqual(settled);
  });

  it('is a no-op on an empty list (e.g. a busy rejection)', () => {
    expect(finalizeLibrarianSteps([], 'error')).toEqual([]);
  });
});

describe('LIBRARIAN_PARTIAL_SAVE_NOTE', () => {
  it('tells the user partial edits were kept', () => {
    expect(LIBRARIAN_PARTIAL_SAVE_NOTE).toMatch(/kept/i);
  });
});

describe('librarianRunButtonLabel', () => {
  it('reports this client own run first', () => {
    expect(librarianRunButtonLabel(true, false)).toBe('Working…');
    // own-run wins even if the lease also reads as in-flight (it will -
    // our own run holds it).
    expect(librarianRunButtonLabel(true, true)).toBe('Working…');
  });
  it('reports another in-flight run (lease held, not ours)', () => {
    expect(librarianRunButtonLabel(false, true)).toBe('A run is in progress…');
  });
  it('is idle otherwise', () => {
    expect(librarianRunButtonLabel(false, false)).toBe('Run librarian');
  });
});

describe('librarianStepGlyph', () => {
  it('maps each status to its row glyph', () => {
    expect(librarianStepGlyph('pending')).toBe('↻');
    expect(librarianStepGlyph('ok')).toBe('✓');
    expect(librarianStepGlyph('error')).toBe('✗');
  });
});

describe('librarianResultMeta', () => {
  it('pluralizes both counts independently', () => {
    expect(librarianResultMeta(1, 1)).toBe(
      '1 tool call over 1 article. See the Logs drawer for the full trace.',
    );
    expect(librarianResultMeta(5, 3)).toBe(
      '5 tool calls over 3 articles. See the Logs drawer for the full trace.',
    );
  });
});

describe('librarianRunElsewhere', () => {
  it('is true only when the lease is held by a run this strip did not start', () => {
    expect(librarianRunElsewhere(true, false)).toBe(true);
    // Our own run holds the lease too - that is not "elsewhere".
    expect(librarianRunElsewhere(true, true)).toBe(false);
    expect(librarianRunElsewhere(false, false)).toBe(false);
  });
});

describe('LIBRARIAN_BUSY_MESSAGE', () => {
  it('names the colliding trigger paths and invites a retry', () => {
    expect(LIBRARIAN_BUSY_MESSAGE).toMatch(/already in flight/);
    expect(LIBRARIAN_BUSY_MESSAGE).toMatch(/Try again/);
  });
});

describe('recoverLibrarianOutcome', () => {
  const okResult: WikiLibrarianRunResult = {
    kind: 'ok',
    finalText: 'Merged the Maya duplicates.',
    toolCalls: 4,
    articleCount: 7,
  };
  const now = Date.parse('2026-07-03T12:00:00Z');
  function makeOutcome(over: Partial<ManualRunOutcome> = {}): ManualRunOutcome {
    return {
      runId: 'run-1',
      source: 'wiki-librarian',
      finishedAt: new Date(now - 1000).toISOString(),
      result: okResult,
      ...over,
    };
  }

  it('recovers a fresh terminal outcome', () => {
    expect(recoverLibrarianOutcome(makeOutcome(), false, null, now)).toEqual(okResult);
  });

  it('leaves the strip alone with no outcome or a live run in this tab', () => {
    expect(recoverLibrarianOutcome(null, false, null, now)).toBeNull();
    // The live path keeps full step fidelity; recovery must not clobber it.
    expect(recoverLibrarianOutcome(makeOutcome(), true, null, now)).toBeNull();
  });

  it('does not re-apply the runId already on screen', () => {
    // The profiles realtime UPDATE re-delivers the same envelope on
    // every tick; the shown-run guard keeps it from looping.
    expect(recoverLibrarianOutcome(makeOutcome(), false, 'run-1', now)).toBeNull();
    expect(recoverLibrarianOutcome(makeOutcome(), false, 'run-0', now)).toEqual(okResult);
  });

  it('drops a stale outcome - the sticky column never expires', () => {
    const stale = makeOutcome({
      finishedAt: new Date(now - MAX_RECOVERED_OUTCOME_AGE_MS - 1000).toISOString(),
    });
    expect(recoverLibrarianOutcome(stale, false, null, now)).toBeNull();
  });

  it('rejects foreign sources and non-terminal results', () => {
    expect(
      recoverLibrarianOutcome(makeOutcome({ source: 'rem' }), false, null, now),
    ).toBeNull();
    expect(
      recoverLibrarianOutcome(makeOutcome({ result: { kind: 'busy' } }), false, null, now),
    ).toBeNull();
  });
});
