/**
 * Unit coverage for the Memories detail panel's UI primitives. Pure
 * functions - no runes, no DOM, no reactive state - tested via plain
 * vitest.
 *
 * The companion `src/screens/Memories.svelte` is the only caller
 * that wires these into Svelte reactivity; a port to another
 * framework would re-use this module untouched.
 */
import { describe, it, expect } from 'vitest';
import {
  MAX_MEMORY_CHANGELOG_MESSAGE_CHARS,
  MAX_MEMORY_DATA_CHARS,
} from '../src/lib/memories';
import {
  MAX_LABEL_CHARS,
  MAX_RELATION_NOTE_CHARS,
  RELATION_KINDS,
  type MemoryActionStatus,
  actionLabel,
  changelogMessageError,
  confidenceChipLabel,
  confidenceTooltip,
  isActionBusyForRow,
  isActionDoneFor,
  isActionSettledFor,
  isAnyActionBusyFor,
  isDuplicateRelationError,
  memoriesBodySurface,
  memoryActionNotice,
  memoryDataBudget,
  memoryEditError,
  panelEmptyMessage,
  relationNoteError,
  relativeTime,
  saveStateNotice,
} from '../src/lib/ui/memories';

describe('caps and sentinels', () => {
  it('pins the label cap the memory_create/update tool schemas enforce', () => {
    expect(MAX_LABEL_CHARS).toBe(80);
  });

  it('pins the relation-note cap the memory_relate tool schema enforces', () => {
    expect(MAX_RELATION_NOTE_CHARS).toBe(500);
  });

  it('offers exactly the relation kinds the DB check constraint accepts', () => {
    expect([...RELATION_KINDS]).toEqual([
      'supports',
      'contradicts',
      'generalises',
      'specialises',
    ]);
  });
});

describe('actionLabel', () => {
  it('returns the resting captions when not busy', () => {
    expect(actionLabel('reaffirm', false)).toBe('Reaffirm');
    expect(actionLabel('doubt', false)).toBe('Doubt');
    expect(actionLabel('delete', false)).toBe('Delete');
  });

  it('swaps to the progressive form while the RPC is in flight', () => {
    expect(actionLabel('reaffirm', true)).toBe('Reaffirming...');
    expect(actionLabel('doubt', true)).toBe('Doubting...');
    expect(actionLabel('delete', true)).toBe('Deleting...');
  });
});

describe('action-status predicates', () => {
  const busy: MemoryActionStatus = {
    kind: 'busy',
    action: 'doubt',
    memoryId: 'm1',
  };
  const done: MemoryActionStatus = {
    kind: 'done',
    action: 'reaffirm',
    memoryId: 'm1',
  };
  const error: MemoryActionStatus = {
    kind: 'error',
    action: 'delete',
    memoryId: 'm1',
    message: 'boom',
  };
  const idle: MemoryActionStatus = { kind: 'idle' };

  it('isAnyActionBusyFor matches only the busy row', () => {
    expect(isAnyActionBusyFor(busy, 'm1')).toBe(true);
    expect(isAnyActionBusyFor(busy, 'm2')).toBe(false);
    expect(isAnyActionBusyFor(done, 'm1')).toBe(false);
    expect(isAnyActionBusyFor(idle, 'm1')).toBe(false);
  });

  it('isActionBusyForRow requires the same action AND the same row', () => {
    expect(isActionBusyForRow(busy, 'm1', 'doubt')).toBe(true);
    expect(isActionBusyForRow(busy, 'm1', 'reaffirm')).toBe(false);
    expect(isActionBusyForRow(busy, 'm2', 'doubt')).toBe(false);
  });

  it('isActionDoneFor matches only the exact done pulse', () => {
    expect(isActionDoneFor(done, 'm1', 'reaffirm')).toBe(true);
    // A follow-up click replaced the pulse with a busy entry - the
    // auto-clear timer must not collapse the new in-flight state.
    expect(isActionDoneFor(busy, 'm1', 'doubt')).toBe(false);
    expect(isActionDoneFor(done, 'm1', 'doubt')).toBe(false);
    expect(isActionDoneFor(done, 'm2', 'reaffirm')).toBe(false);
  });

  it('isActionSettledFor treats done and error as settled, busy and idle as not', () => {
    expect(isActionSettledFor(done, 'm1')).toBe(true);
    expect(isActionSettledFor(error, 'm1')).toBe(true);
    expect(isActionSettledFor(busy, 'm1')).toBe(false);
    expect(isActionSettledFor(idle, 'm1')).toBe(false);
    expect(isActionSettledFor(done, 'm2')).toBe(false);
  });
});

describe('memoryActionNotice', () => {
  it('renders the success pulse with the glyph', () => {
    const status: MemoryActionStatus = {
      kind: 'done',
      action: 'reaffirm',
      memoryId: 'm1',
    };
    expect(memoryActionNotice(status, 'm1')).toEqual({
      text: 'Reaffirmed ✓',
      className: 'action-ok',
    });
  });

  it('renders the failure banner naming the action that failed', () => {
    const status: MemoryActionStatus = {
      kind: 'error',
      action: 'doubt',
      memoryId: 'm1',
      message: 'network down',
    };
    expect(memoryActionNotice(status, 'm1')).toEqual({
      text: "Couldn't doubt - network down",
      className: 'error',
    });
  });

  it('returns null for idle, busy, and other-memory statuses', () => {
    expect(memoryActionNotice({ kind: 'idle' }, 'm1')).toBeNull();
    expect(
      memoryActionNotice(
        { kind: 'busy', action: 'delete', memoryId: 'm1' },
        'm1',
      ),
    ).toBeNull();
    expect(
      memoryActionNotice(
        { kind: 'done', action: 'delete', memoryId: 'other' },
        'm1',
      ),
    ).toBeNull();
  });
});

describe('saveStateNotice', () => {
  it('renders nothing when idle', () => {
    expect(saveStateNotice({ kind: 'idle' })).toBeNull();
  });

  it('renders the informational states as subtle text', () => {
    expect(saveStateNotice({ kind: 'dirty' })).toEqual({
      text: 'Unsaved changes',
      className: 'subtle',
    });
    expect(saveStateNotice({ kind: 'saving' })).toEqual({
      text: 'Saving…',
      className: 'subtle',
    });
  });

  it('renders the saved flash with the green cue', () => {
    expect(saveStateNotice({ kind: 'saved' })).toEqual({
      text: 'Saved ✓',
      className: 'subtle save-ok',
    });
  });

  it('renders errors with the message appended', () => {
    expect(saveStateNotice({ kind: 'error', message: 'RLS denied' })).toEqual({
      text: "Couldn't save - RLS denied",
      className: 'error',
    });
  });
});

describe('changelogMessageError', () => {
  it('nudges with the verb of the flow the user is in', () => {
    expect(changelogMessageError('', 'saving')).toBe(
      'Add a one-line change message before saving.',
    );
    expect(changelogMessageError('', 'deleting')).toBe(
      'Add a one-line change message before deleting.',
    );
  });

  it('rejects overlong messages with the cap named', () => {
    const long = 'x'.repeat(MAX_MEMORY_CHANGELOG_MESSAGE_CHARS + 1);
    expect(changelogMessageError(long, 'saving')).toBe(
      `Change message must be ${MAX_MEMORY_CHANGELOG_MESSAGE_CHARS} chars or fewer.`,
    );
  });

  it('accepts a message exactly at the cap', () => {
    const atCap = 'x'.repeat(MAX_MEMORY_CHANGELOG_MESSAGE_CHARS);
    expect(changelogMessageError(atCap, 'deleting')).toBeNull();
  });
});

describe('memoryEditError', () => {
  const ok = { label: 'a label', data: 'some data', message: 'why' };

  it('accepts a complete draft', () => {
    expect(memoryEditError(ok.label, ok.data, ok.message)).toBeNull();
  });

  it('reports fields in visual order - label before data before message', () => {
    expect(memoryEditError('', '', '')).toBe('Label is required.');
    expect(memoryEditError(ok.label, '', '')).toBe('Data is required.');
    expect(memoryEditError(ok.label, ok.data, '')).toBe(
      'Add a one-line change message before saving.',
    );
  });

  it('rejects an overlong label', () => {
    expect(memoryEditError('x'.repeat(MAX_LABEL_CHARS + 1), ok.data, ok.message)).toBe(
      `Label must be ${MAX_LABEL_CHARS} chars or fewer.`,
    );
  });

  it('rejects overlong data', () => {
    expect(
      memoryEditError(ok.label, 'x'.repeat(MAX_MEMORY_DATA_CHARS + 1), ok.message),
    ).toBe(`Data must be ${MAX_MEMORY_DATA_CHARS} chars or fewer.`);
  });

  // A row written under the old 8000-char cap must stay editable: its
  // current length is headroom, so the user can fix a typo without being
  // forced to condense, but cannot grow the body further.
  it('grants a legacy over-cap row its current length as headroom', () => {
    const legacy = MAX_MEMORY_DATA_CHARS + 3000;
    expect(memoryEditError(ok.label, 'x'.repeat(legacy), ok.message, legacy)).toBeNull();
    expect(
      memoryEditError(ok.label, 'x'.repeat(legacy + 1), ok.message, legacy),
    ).toBe(`Data must be ${legacy} chars or fewer.`);
  });
});

describe('memoryDataBudget', () => {
  it('floors at the cap and rises to an over-cap row length', () => {
    expect(memoryDataBudget(0)).toBe(MAX_MEMORY_DATA_CHARS);
    expect(memoryDataBudget(MAX_MEMORY_DATA_CHARS - 500)).toBe(MAX_MEMORY_DATA_CHARS);
    expect(memoryDataBudget(MAX_MEMORY_DATA_CHARS + 500)).toBe(
      MAX_MEMORY_DATA_CHARS + 500,
    );
  });
});

describe('relationNoteError', () => {
  it('accepts an empty note - the note is optional', () => {
    expect(relationNoteError('')).toBeNull();
  });

  it('rejects an overlong note', () => {
    expect(relationNoteError('x'.repeat(MAX_RELATION_NOTE_CHARS + 1))).toBe(
      `Note must be ${MAX_RELATION_NOTE_CHARS} chars or fewer.`,
    );
  });
});

describe('isDuplicateRelationError', () => {
  it('recognises both Postgres unique-violation phrasings', () => {
    expect(
      isDuplicateRelationError(
        'duplicate key value violates unique constraint "memory_relations_uniq"',
      ),
    ).toBe(true);
    expect(isDuplicateRelationError('violates unique constraint')).toBe(true);
  });

  it('does not swallow unrelated failures', () => {
    expect(isDuplicateRelationError('permission denied for table')).toBe(false);
  });
});

describe('relativeTime', () => {
  const t0 = Date.parse('2026-01-01T00:00:00Z');
  const iso = '2026-01-01T00:00:00Z';
  const MIN = 60_000;
  const HR = 60 * MIN;
  const DAY = 24 * HR;

  it('reads sub-minute ages as "just now"', () => {
    expect(relativeTime(iso, t0 + 30_000)).toBe('just now');
  });

  it('walks the unit ladder', () => {
    expect(relativeTime(iso, t0 + 5 * MIN)).toBe('5 min ago');
    expect(relativeTime(iso, t0 + 3 * HR)).toBe('3 hr ago');
    expect(relativeTime(iso, t0 + 26 * HR)).toBe('1 day ago');
    expect(relativeTime(iso, t0 + 3 * DAY)).toBe('3 days ago');
    expect(relativeTime(iso, t0 + 14 * DAY)).toBe('2 wk ago');
    expect(relativeTime(iso, t0 + 60 * DAY)).toBe('2 mo ago');
    expect(relativeTime(iso, t0 + 400 * DAY)).toBe('1 yr ago');
    expect(relativeTime(iso, t0 + 800 * DAY)).toBe('2 yrs ago');
  });

  it('renders unparseable timestamps as empty rather than "NaN ago"', () => {
    expect(relativeTime('not-a-date', t0)).toBe('');
  });
});

describe('confidenceTooltip', () => {
  it('shows the raw number alone for neutral (untagged) confidence', () => {
    expect(confidenceTooltip(2)).toBe('confidence 2.00');
  });

  it('appends the qualitative tag when one applies', () => {
    expect(confidenceTooltip(6.13)).toBe('confidence 6.13 (corroborated)');
    expect(confidenceTooltip(0.3)).toBe('confidence 0.30 (shaky)');
  });
});

describe('confidenceChipLabel', () => {
  it('marks the value as approximate with one decimal', () => {
    expect(confidenceChipLabel(1.75)).toBe('~1.8');
    expect(confidenceChipLabel(3)).toBe('~3.0');
  });
});

describe('panelEmptyMessage', () => {
  it('names the query when a search excluded everything', () => {
    expect(panelEmptyMessage('dishwasher')).toBe(
      'No memories match "dishwasher".',
    );
  });

  it('trims the query before quoting it', () => {
    expect(panelEmptyMessage('  cats  ')).toBe('No memories match "cats".');
  });

  it('explains where memories come from on a cold account', () => {
    expect(panelEmptyMessage('')).toBe(
      "Nothing here yet. Memories accumulate as you chat - see the Help modal's Memory page for details.",
    );
  });

  it('treats whitespace-only queries as the cold-account case', () => {
    expect(panelEmptyMessage('   ')).toBe(panelEmptyMessage(''));
  });
});

describe('memoriesBodySurface', () => {
  const base = {
    librarianStripVisible: false,
    selectedInResults: false,
    hasRoutedSelection: false,
    loading: false,
    resultCount: 5,
  };

  it('lets the librarian strip own the body when nothing is selected', () => {
    // Even loading and empty states yield - the strip the user just
    // summoned is the whole content until dismissed.
    expect(
      memoriesBodySurface({
        ...base,
        librarianStripVisible: true,
        loading: true,
        resultCount: 0,
      }),
    ).toBe('librarian-strip-only');
  });

  it('keeps the selected card visible alongside the strip', () => {
    expect(
      memoriesBodySurface({
        ...base,
        librarianStripVisible: true,
        hasRoutedSelection: true,
        selectedInResults: true,
      }),
    ).toBe('card');
  });

  it('shows the loading hint only while there is nothing to render', () => {
    expect(
      memoriesBodySurface({ ...base, loading: true, resultCount: 0 }),
    ).toBe('loading');
    // A refetch with rows already on screen falls through to the
    // regular surfaces - blanking the panel on every refresh would
    // flicker.
    expect(memoriesBodySurface({ ...base, loading: true })).toBe('changelog');
  });

  it('reports empty once the fetch settles on zero rows', () => {
    expect(memoriesBodySurface({ ...base, resultCount: 0 })).toBe('empty');
  });

  it('defaults to the changelog when no memory is selected', () => {
    expect(memoriesBodySurface(base)).toBe('changelog');
  });

  it('flags a routed selection that fell out of the result set', () => {
    expect(
      memoriesBodySurface({ ...base, hasRoutedSelection: true }),
    ).toBe('selection-missing');
  });

  it('renders the card when the routed selection resolves', () => {
    expect(
      memoriesBodySurface({
        ...base,
        hasRoutedSelection: true,
        selectedInResults: true,
      }),
    ).toBe('card');
  });
});
