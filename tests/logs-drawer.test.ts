/**
 * Unit coverage for the logs-drawer UI primitives. Pure functions
 * - no runes, no DOM, no reactive state - tested via plain
 * vitest.
 *
 * The companion `src/components/LogsDrawer.svelte` is the only
 * caller that wires these into Svelte reactivity (the filter
 * runes, the three `$effect`s, the clipboard orchestration, the
 * scroll-pin DOM ref). A port to another framework would re-use
 * this module untouched.
 */
import { describe, it, expect } from 'vitest';
import type { LogEntry } from '../src/lib/logger.svelte';
import {
  availableSources,
  buildLogSnapshot,
  detailsHaystack,
  emptyMessage,
  entryMatches,
  formatStructured,
  formatTimestamp,
  hasStructuredDetails,
  highlightSegments,
  inlineStringDetails,
  nearBottom,
  normalizeDetail,
  splitNeedles,
  structuredDetails,
} from '../src/lib/ui/logs-drawer';

function entry(overrides: Partial<LogEntry> = {}): LogEntry {
  return {
    id: 1,
    timestamp: 0,
    level: 'info',
    source: null,
    message: '',
    details: [],
    ...overrides,
  } as LogEntry;
}

describe('splitNeedles', () => {
  it('drops empty tokens from leading / trailing / double spaces', () => {
    // Without the filter, hitting space would silently match every
    // entry by injecting an empty needle that every haystack
    // includes.
    expect(splitNeedles('  foo   bar  ')).toEqual(['foo', 'bar']);
  });

  it('returns an empty array for whitespace-only input', () => {
    expect(splitNeedles('')).toEqual([]);
    expect(splitNeedles('   ')).toEqual([]);
  });

  it('preserves case (case-folding happens at match time)', () => {
    expect(splitNeedles('FOO bar')).toEqual(['FOO', 'bar']);
  });
});

describe('detailsHaystack', () => {
  it('flattens strings through', () => {
    expect(detailsHaystack(['alpha', 'beta'])).toBe('alpha beta');
  });

  it('contributes Error message + stack', () => {
    const err = new Error('boom');
    err.stack = 'Error: boom\n    at foo';
    const hay = detailsHaystack([err]);
    expect(hay).toContain('boom');
    expect(hay).toContain('at foo');
  });

  it('contributes Error message even when no stack is set', () => {
    const err = new Error('boom');
    err.stack = undefined;
    expect(detailsHaystack([err])).toContain('boom');
  });

  it('contributes JSON for objects', () => {
    expect(detailsHaystack([{ rate: 'limited' }])).toContain('limited');
  });

  it('falls back to String() when JSON throws (circular)', () => {
    const a: Record<string, unknown> = {};
    a.self = a;
    // Circular ref - JSON.stringify throws; String() shape (e.g.
    // "[object Object]") still lands in the haystack so the entry
    // is at least matchable on something.
    const hay = detailsHaystack([a]);
    expect(hay.length).toBeGreaterThan(0);
  });
});

describe('entryMatches', () => {
  const baseFilter = {
    levelFilter: 'debug' as const,
    matchMode: 'or' as const,
    sourceFilter: '',
    needles: [] as string[],
  };

  it('passes everything through the empty filter', () => {
    expect(entryMatches(entry({ level: 'info' }), baseFilter)).toBe(true);
  });

  it('excludes entries below the level threshold', () => {
    expect(
      entryMatches(entry({ level: 'debug' }), {
        ...baseFilter,
        levelFilter: 'info',
      })
    ).toBe(false);
  });

  it('includes entries at or above the level threshold', () => {
    expect(
      entryMatches(entry({ level: 'warn' }), {
        ...baseFilter,
        levelFilter: 'info',
      })
    ).toBe(true);
  });

  it('places trace below debug so Trace+ widens the filter', () => {
    expect(
      entryMatches(entry({ level: 'trace' }), {
        ...baseFilter,
        levelFilter: 'trace',
      })
    ).toBe(true);
    expect(
      entryMatches(entry({ level: 'trace' }), {
        ...baseFilter,
        levelFilter: 'debug',
      })
    ).toBe(false);
  });

  it('requires exact source match when sourceFilter is set', () => {
    expect(
      entryMatches(entry({ source: 'embed-worker' }), {
        ...baseFilter,
        sourceFilter: 'embed-worker',
      })
    ).toBe(true);
    expect(
      entryMatches(entry({ source: 'summary-worker' }), {
        ...baseFilter,
        sourceFilter: 'embed-worker',
      })
    ).toBe(false);
  });

  it('OR mode matches when ANY needle hits the haystack', () => {
    const e = entry({ message: 'rate-limit on /chat/completions' });
    expect(
      entryMatches(e, { ...baseFilter, needles: ['rate', 'nomatch'] })
    ).toBe(true);
  });

  it('AND mode requires every needle to hit the haystack', () => {
    const e = entry({ message: 'rate-limit on /chat/completions' });
    expect(
      entryMatches(e, {
        ...baseFilter,
        matchMode: 'and',
        needles: ['rate', 'chat'],
      })
    ).toBe(true);
    expect(
      entryMatches(e, {
        ...baseFilter,
        matchMode: 'and',
        needles: ['rate', 'nomatch'],
      })
    ).toBe(false);
  });

  it('search is case-insensitive', () => {
    const e = entry({ message: 'Rate-Limit' });
    expect(
      entryMatches(e, { ...baseFilter, needles: ['rate-limit'] })
    ).toBe(true);
  });

  it('search hits the source tag and the details too', () => {
    const sourceMatch = entry({ source: 'embed-worker', message: 'idle' });
    expect(
      entryMatches(sourceMatch, { ...baseFilter, needles: ['embed'] })
    ).toBe(true);
    const detailMatch = entry({ message: 'idle', details: ['heartbeat'] });
    expect(
      entryMatches(detailMatch, { ...baseFilter, needles: ['heartbeat'] })
    ).toBe(true);
  });
});

describe('availableSources', () => {
  it('returns unique non-null sources alphabetised', () => {
    const entries = [
      entry({ source: 'embed-worker' }),
      entry({ source: 'summary-worker' }),
      entry({ source: 'embed-worker' }),
      entry({ source: null }),
    ];
    expect(availableSources(entries)).toEqual(['embed-worker', 'summary-worker']);
  });

  it('returns an empty array when no entry carries a source', () => {
    expect(availableSources([entry({ source: null })])).toEqual([]);
  });
});

describe('details partition', () => {
  it('hasStructuredDetails is true iff any detail is not a string', () => {
    expect(hasStructuredDetails([])).toBe(false);
    expect(hasStructuredDetails(['a', 'b'])).toBe(false);
    expect(hasStructuredDetails(['a', { x: 1 }])).toBe(true);
    expect(hasStructuredDetails([new Error('boom')])).toBe(true);
  });

  it('inlineStringDetails returns only the string members', () => {
    expect(inlineStringDetails(['a', { x: 1 }, 'b'])).toEqual(['a', 'b']);
  });

  it('structuredDetails returns the complementary non-string members', () => {
    const obj = { x: 1 };
    const err = new Error('boom');
    expect(structuredDetails(['a', obj, err])).toEqual([obj, err]);
  });
});

describe('formatStructured', () => {
  it('renders an Error stack when present', () => {
    const err = new Error('boom');
    err.stack = 'Error: boom\n    at foo';
    expect(formatStructured(err)).toContain('at foo');
  });

  it('falls back to name + message when no stack', () => {
    const err = new Error('boom');
    err.stack = undefined;
    expect(formatStructured(err)).toBe('Error: boom');
  });

  it('renders objects as pretty-printed JSON', () => {
    expect(formatStructured({ x: 1 })).toBe('{\n  "x": 1\n}');
  });

  it('falls back to String() for values JSON cannot serialise', () => {
    // BigInt is a common offender - JSON.stringify throws on it.
    expect(formatStructured(1n)).toBe('1');
  });
});

describe('normalizeDetail', () => {
  it('strips Error prototype but keeps the shape', () => {
    const err = new Error('boom');
    err.stack = 'STACK';
    const out = normalizeDetail(err) as Record<string, unknown>;
    expect(out).toEqual({ name: 'Error', message: 'boom', stack: 'STACK' });
  });

  it('passes primitives through', () => {
    expect(normalizeDetail(42)).toBe(42);
    expect(normalizeDetail('hello')).toBe('hello');
    expect(normalizeDetail(null)).toBe(null);
  });

  it('round-trips plain objects through JSON to strip functions / symbols', () => {
    const out = normalizeDetail({ x: 1, fn: () => 0 }) as Record<string, unknown>;
    expect(out).toEqual({ x: 1 });
  });

  it('catches circular refs and falls back to String()', () => {
    const a: Record<string, unknown> = {};
    a.self = a;
    const out = normalizeDetail(a);
    expect(typeof out).toBe('string');
  });
});

describe('highlightSegments', () => {
  it('returns one unmatched run for empty needles', () => {
    expect(highlightSegments('hello world', [])).toEqual([
      { text: 'hello world', match: false },
    ]);
  });

  it('returns one unmatched run for empty text', () => {
    expect(highlightSegments('', ['foo'])).toEqual([
      { text: '', match: false },
    ]);
  });

  it('marks a single needle hit', () => {
    expect(highlightSegments('hello world', ['world'])).toEqual([
      { text: 'hello ', match: false },
      { text: 'world', match: true },
    ]);
  });

  it('case-folds the needle but preserves the text run casing', () => {
    expect(highlightSegments('Hello World', ['hello'])).toEqual([
      { text: 'Hello', match: true },
      { text: ' World', match: false },
    ]);
  });

  it('marks every non-adjacent occurrence of a needle', () => {
    expect(highlightSegments('a-b-a', ['a'])).toEqual([
      { text: 'a', match: true },
      { text: '-b-', match: false },
      { text: 'a', match: true },
    ]);
  });

  it('coalesces adjacent occurrences into one run', () => {
    // Three adjacent matches of `a` in `aaa` produce one merged
    // range over the whole string. Without the merge, the
    // rendered DOM would have three `<mark>` siblings with no
    // whitespace between them - the visual effect is identical
    // but the diff produces one less node.
    expect(highlightSegments('aaa', ['a'])).toEqual([
      { text: 'aaa', match: true },
    ]);
  });

  it('merges overlapping needles into one run', () => {
    // 'abc' + 'cd' overlap at index 2. The merged range is 0-4 so
    // the entire substring 'abcd' is one match.
    expect(highlightSegments('xabcdy', ['abc', 'cd'])).toEqual([
      { text: 'x', match: false },
      { text: 'abcd', match: true },
      { text: 'y', match: false },
    ]);
  });

  it('drops empty needles silently', () => {
    expect(highlightSegments('hello', ['', 'lo'])).toEqual([
      { text: 'hel', match: false },
      { text: 'lo', match: true },
    ]);
  });
});

describe('formatTimestamp', () => {
  it('pads to HH:MM:SS.mss in the local zone', () => {
    // Build a Date with a known local-time shape so the padding
    // is observable across timezones.
    const d = new Date();
    d.setHours(3, 5, 9, 7);
    const out = formatTimestamp(d.getTime());
    expect(out).toBe('03:05:09.007');
  });
});

describe('nearBottom', () => {
  it('is true when scroll position is within the default 16px tolerance', () => {
    expect(nearBottom(984, 200, 1200)).toBe(true);
  });

  it('is false when the user has scrolled up past the tolerance', () => {
    expect(nearBottom(100, 200, 1200)).toBe(false);
  });

  it('accepts an explicit tolerance override', () => {
    expect(nearBottom(100, 200, 1200, 1000)).toBe(true);
  });

  it('handles the "shorter than the viewport" edge case', () => {
    // Tiny buffer that fully fits - scrollTop is 0, scrollHeight
    // equals clientHeight, so any positive tolerance yields true.
    expect(nearBottom(0, 500, 500)).toBe(true);
  });
});

describe('emptyMessage', () => {
  it('says "no log entries yet" when the buffer is empty', () => {
    expect(emptyMessage(0, 0)).toBe('No log entries yet.');
  });

  it('says "no entries match" when entries exist but the filter excludes them', () => {
    expect(emptyMessage(42, 0)).toBe(
      'No entries match the current filter.'
    );
  });
});

describe('buildLogSnapshot', () => {
  const args = {
    capturedAt: '2026-05-19T20:00:00.000Z',
    buildCommit: 'abcdef0',
    buildTime: '2026-05-19T18:00:00.000Z',
    levelFilter: 'info' as const,
    matchMode: 'or' as const,
    sourceFilter: '',
    search: '',
    visibleEntries: [
      entry({
        id: 1,
        timestamp: Date.parse('2026-05-19T19:59:00.000Z'),
        level: 'info',
        source: 'embed-worker',
        message: 'idle',
        details: ['heartbeat'],
      }),
    ],
  };

  it('rewrites the empty sourceFilter sentinel to null in the payload', () => {
    // The component uses '' for the "All sources" UI sentinel; the
    // snapshot uses null so a downstream consumer can distinguish
    // "no filter active" from "filter set to literal empty string"
    // unambiguously.
    expect(buildLogSnapshot(args).sourceFilter).toBeNull();
  });

  it('preserves a real source filter', () => {
    expect(
      buildLogSnapshot({ ...args, sourceFilter: 'embed-worker' }).sourceFilter
    ).toBe('embed-worker');
  });

  it('reports the count of visible entries', () => {
    // The snapshot deliberately omits the unfiltered buffer total -
    // the request "copy what is visible" means the metadata
    // describes only the displayed slice.
    const out = buildLogSnapshot(args);
    expect(out.shownEntries).toBe(1);
  });

  it('renders each entry timestamp as an ISO string', () => {
    const out = buildLogSnapshot(args);
    expect(out.entries[0].timestamp).toBe('2026-05-19T19:59:00.000Z');
  });

  it('normalizes details (Error stripped of prototype, etc.)', () => {
    const err = new Error('boom');
    err.stack = 'STACK';
    const out = buildLogSnapshot({
      ...args,
      visibleEntries: [entry({ details: [err] })],
    });
    expect(out.entries[0].details[0]).toEqual({
      name: 'Error',
      message: 'boom',
      stack: 'STACK',
    });
  });
});
