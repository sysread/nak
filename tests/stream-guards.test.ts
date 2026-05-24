/**
 * Unit tests for the pure stream-guard logic - the verdict transitions
 * (where the subtle edge cases live: split delta prefixes, empty
 * completions, short-but-legitimate replies) and the model->guard
 * arming. The async wrapper that drives these verdicts is tested
 * separately in chat-loop-guards.test.ts.
 */
import { describe, it, expect } from 'vitest';
import {
  combineVerdicts,
  specialTokenLeakGuard,
  startsWithSpecialTokenLeak,
  streamGuardsFor,
  RETRY_TEMPERATURE_SCHEDULE,
  type AttemptProgress,
} from '../src/lib/stream-guards';
import type { ChatRequest } from '../src/lib/venice';

function progress(over: Partial<AttemptProgress> = {}): AttemptProgress {
  return {
    visibleText: '',
    sawReasoning: false,
    sawToolCall: false,
    ended: false,
    ...over,
  };
}

describe('startsWithSpecialTokenLeak', () => {
  it('flags the DeepSeek wide-pipe opener', () => {
    expect(startsWithSpecialTokenLeak('<｜begin▁of▁sentence｜>')).toBe(true);
  });
  it('flags the llama ascii-pipe opener', () => {
    expect(startsWithSpecialTokenLeak('<|eot_id|>')).toBe(true);
  });
  it('does not flag ordinary text or HTML-ish openers', () => {
    expect(startsWithSpecialTokenLeak('Hello there')).toBe(false);
    expect(startsWithSpecialTokenLeak('<div>')).toBe(false);
    expect(startsWithSpecialTokenLeak('```go')).toBe(false);
  });
});

describe('combineVerdicts', () => {
  it('lets any retry win', () => {
    expect(combineVerdicts(['keep', 'retry', 'undecided'])).toBe('retry');
  });
  it('holds open on undecided when nothing retries', () => {
    expect(combineVerdicts(['keep', 'undecided'])).toBe('undecided');
  });
  it('keeps only when every guard is satisfied', () => {
    expect(combineVerdicts(['keep', 'keep'])).toBe('keep');
  });
  it('keeps on an empty guard list', () => {
    expect(combineVerdicts([])).toBe('keep');
  });
});

describe('specialTokenLeakGuard.verdict', () => {
  const guard = specialTokenLeakGuard();

  it('keeps as soon as reasoning arrives (a leak has none)', () => {
    expect(guard.verdict(progress({ sawReasoning: true }))).toBe('keep');
  });

  it('keeps as soon as a tool call arrives', () => {
    expect(guard.verdict(progress({ sawToolCall: true }))).toBe('keep');
  });

  it('retries on a wide-pipe leak opener', () => {
    expect(
      guard.verdict(progress({ visibleText: '<｜begin▁of▁sentence｜>' }))
    ).toBe('retry');
  });

  it('retries on an ascii-pipe leak opener even mid-stream', () => {
    expect(guard.verdict(progress({ visibleText: '<|python_tag|>' }))).toBe('retry');
  });

  it('sees through leading whitespace before the leak', () => {
    expect(guard.verdict(progress({ visibleText: '\n  <｜end｜>' }))).toBe('retry');
  });

  it('stays undecided on an empty stream that has not ended', () => {
    expect(guard.verdict(progress({ visibleText: '' }))).toBe('undecided');
  });

  it('retries an empty completion once the stream ends (server-side stop fired)', () => {
    expect(guard.verdict(progress({ visibleText: '', ended: true }))).toBe('retry');
  });

  it('waits one more delta on a bare "<" that could still become a leak', () => {
    expect(guard.verdict(progress({ visibleText: '<' }))).toBe('undecided');
  });

  it('keeps a bare "<" if that is the whole (ended) reply', () => {
    expect(guard.verdict(progress({ visibleText: '<', ended: true }))).toBe('keep');
  });

  it('keeps once real non-leak text arrives', () => {
    expect(guard.verdict(progress({ visibleText: 'Sure, here is' }))).toBe('keep');
  });

  it('keeps a short legitimate reply that has ended', () => {
    expect(guard.verdict(progress({ visibleText: 'Yes.', ended: true }))).toBe('keep');
  });
});

describe('specialTokenLeakGuard.prepareRetry', () => {
  const guard = specialTokenLeakGuard();
  const base: ChatRequest = { model: 'm', messages: [] };

  it('forces the scheduled retry temperature and does not mutate the input', () => {
    const next = guard.prepareRetry(base, 1);
    expect(next.temperature).toBe(RETRY_TEMPERATURE_SCHEDULE[0]);
    expect(base.temperature).toBeUndefined();
    expect(next).not.toBe(base);
  });

  it('clamps the schedule index for retries past its length', () => {
    const last = RETRY_TEMPERATURE_SCHEDULE[RETRY_TEMPERATURE_SCHEDULE.length - 1];
    expect(guard.prepareRetry(base, 99).temperature).toBe(last);
  });
});

describe('streamGuardsFor', () => {
  it('arms the special-token guard for the leaky DeepSeek model', () => {
    const guards = streamGuardsFor('deepseek-v4-flash');
    expect(guards.map((g) => g.name)).toEqual(['special-token-leak']);
  });

  it('arms nothing for a model with no configured gotchas', () => {
    expect(streamGuardsFor('mistral-small-3-2-24b-instruct')).toEqual([]);
    expect(streamGuardsFor('does-not-exist')).toEqual([]);
  });
});
