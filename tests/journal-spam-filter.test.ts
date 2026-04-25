import { describe, it, expect } from 'vitest';
import {
  SPAM_FILTER_COLD_START_MIN,
  renderSpamHint,
  scoreSpamFilter,
  tokenizeConversation,
  tokenizeUserEntry,
  trainSpamFilter,
  untrainSpamFilter,
} from '../src/lib/agents/journal/spam_filter';
import type { Message, SupabaseService } from '../src/lib/supabase';

// Lightweight stand-in for SupabaseService. Only the methods the
// spam filter calls are wired; everything else throws if touched,
// which keeps the surface area honest.
function mockSupabase(opts: {
  hamTotal: number;
  spamTotal: number;
  rows?: { token: string; hamCount: number; spamCount: number }[];
  onTrain?: (tokens: readonly string[], label: 'ham' | 'spam') => void;
  onUntrain?: (tokens: readonly string[], label: 'ham' | 'spam') => void;
}): SupabaseService {
  const stub = {
    getJournalSpamStats: async () => ({
      hamTotal: opts.hamTotal,
      spamTotal: opts.spamTotal,
    }),
    scoreJournalSpamTokens: async (tokens: readonly string[]) => {
      const set = new Set(tokens);
      return (opts.rows ?? []).filter((r) => set.has(r.token));
    },
    trainJournalSpam: async (tokens: readonly string[], label: 'ham' | 'spam') => {
      opts.onTrain?.(tokens, label);
    },
    untrainJournalSpam: async (
      tokens: readonly string[],
      label: 'ham' | 'spam'
    ) => {
      opts.onUntrain?.(tokens, label);
    },
  };
  return stub as unknown as SupabaseService;
}

function msg(role: Message['role'], content: string): Message {
  return {
    id: 'x',
    thread_id: 't',
    role,
    content,
    created_at: '2024-01-01T00:00:00Z',
  };
}

describe('tokenizeConversation', () => {
  it('skips system and tool messages', () => {
    const tokens = tokenizeConversation([
      msg('system', 'system instruction with secret marker'),
      msg('tool', 'tool result with another marker'),
      msg('user', 'hello world'),
      msg('assistant', 'hi back'),
    ]);
    expect(tokens).toContain('hello');
    expect(tokens).toContain('world');
    expect(tokens).not.toContain('marker');
    expect(tokens).not.toContain('instruction');
  });

  it('lowercases and dedupes across messages', () => {
    const tokens = tokenizeConversation([
      msg('user', 'Hello HELLO hello'),
      msg('assistant', 'HELLO again'),
    ]);
    // Naive Bayes counts presence not frequency, so duplicates collapse.
    expect(tokens.filter((t) => t === 'hello')).toHaveLength(1);
  });

  it('drops tokens shorter than 2 chars', () => {
    const tokens = tokenizeConversation([msg('user', 'a I we go up to')]);
    expect(tokens).not.toContain('a');
    expect(tokens).not.toContain('i');
    expect(tokens).toContain('we');
    expect(tokens).toContain('go');
    // "to" stems to "to", still 2 chars - kept
    expect(tokens).toContain('to');
  });

  it('drops absurdly long tokens (likely URLs / hashes)', () => {
    const url = 'a'.repeat(60);
    const tokens = tokenizeConversation([msg('user', `look at ${url} please`)]);
    expect(tokens).not.toContain(url);
    expect(tokens).toContain('look');
    expect(tokens).toContain('pleas'); // "please" -> stem
  });

  it('stems inflections to a shared root', () => {
    const tokens = tokenizeConversation([
      msg('user', 'running runs run runner'),
    ]);
    // All four collapse onto one stem under Snowball English.
    const runStems = tokens.filter((t) => t.startsWith('run'));
    expect(runStems.length).toBeLessThan(4);
    expect(runStems.length).toBeGreaterThan(0);
  });

  it('returns an empty list when nothing remains after filtering', () => {
    const tokens = tokenizeConversation([
      msg('system', 'invisible to the filter'),
      msg('tool', 'also invisible'),
      msg('user', ''),
    ]);
    expect(tokens).toEqual([]);
  });

  it('handles punctuation, numbers, and unicode word boundaries', () => {
    const tokens = tokenizeConversation([
      msg('user', "User's worried about Mom's birthday (the 50th)."),
    ]);
    expect(tokens).toContain('worri'); // "worried" -> stem
    expect(tokens).toContain('mom'); // possessive 's drops at boundary
    expect(tokens).toContain('birthday');
  });
});

describe('tokenizeUserEntry', () => {
  it('tokenizes plain content with the same pipeline as conversations', () => {
    const fromConv = tokenizeConversation([
      msg('user', 'Running and runs through the woods'),
    ]);
    const fromEntry = tokenizeUserEntry('Running and runs through the woods');
    expect(fromEntry.sort()).toEqual(fromConv.sort());
  });

  it('returns an empty list on empty content', () => {
    expect(tokenizeUserEntry('')).toEqual([]);
  });

  it('drops too-short tokens and stems inflections', () => {
    const tokens = tokenizeUserEntry('I went running today and felt happiness');
    expect(tokens).not.toContain('i');
    expect(tokens).toContain('run'); // running -> run
    expect(tokens).toContain('happi'); // happiness -> happi
  });

  it('dedupes within a single content string', () => {
    const tokens = tokenizeUserEntry('hello hello HELLO Hello');
    expect(tokens.filter((t) => t === 'hello')).toHaveLength(1);
  });
});

describe('scoreSpamFilter', () => {
  it('returns coldStart=true when ham total is below threshold', async () => {
    const supabase = mockSupabase({
      hamTotal: SPAM_FILTER_COLD_START_MIN - 1,
      spamTotal: SPAM_FILTER_COLD_START_MIN + 5,
    });
    const score = await scoreSpamFilter(supabase, ['hello']);
    expect(score.coldStart).toBe(true);
    expect(score.spamProbability).toBe(0.5);
  });

  it('returns coldStart=true when spam total is below threshold', async () => {
    const supabase = mockSupabase({
      hamTotal: SPAM_FILTER_COLD_START_MIN + 10,
      spamTotal: SPAM_FILTER_COLD_START_MIN - 1,
    });
    const score = await scoreSpamFilter(supabase, ['hello']);
    expect(score.coldStart).toBe(true);
  });

  it('falls back to the prior when no tokens match the vocabulary', async () => {
    const supabase = mockSupabase({
      hamTotal: 80,
      spamTotal: 20,
      rows: [], // no token rows whatsoever
    });
    const score = await scoreSpamFilter(supabase, ['unknownword']);
    expect(score.coldStart).toBe(false);
    // Empty match falls back to the prior: 20 / 100 = 0.2
    expect(score.spamProbability).toBeCloseTo(0.2, 2);
  });

  it('ranks a strongly-spam vocabulary as high spam probability', async () => {
    const rows = [
      // Extreme imbalance: every token appears almost exclusively in spam.
      { token: 'spammy1', hamCount: 0, spamCount: 50 },
      { token: 'spammy2', hamCount: 0, spamCount: 50 },
      { token: 'spammy3', hamCount: 0, spamCount: 50 },
      { token: 'neutral', hamCount: 25, spamCount: 25 },
    ];
    const supabase = mockSupabase({ hamTotal: 50, spamTotal: 50, rows });
    const score = await scoreSpamFilter(supabase, [
      'spammy1',
      'spammy2',
      'spammy3',
      'neutral',
    ]);
    expect(score.coldStart).toBe(false);
    expect(score.spamProbability).toBeGreaterThan(0.95);
  });

  it('ranks a strongly-ham vocabulary as low spam probability', async () => {
    const rows = [
      { token: 'hammy1', hamCount: 50, spamCount: 0 },
      { token: 'hammy2', hamCount: 50, spamCount: 0 },
      { token: 'hammy3', hamCount: 50, spamCount: 0 },
    ];
    const supabase = mockSupabase({ hamTotal: 50, spamTotal: 50, rows });
    const score = await scoreSpamFilter(supabase, [
      'hammy1',
      'hammy2',
      'hammy3',
    ]);
    expect(score.coldStart).toBe(false);
    expect(score.spamProbability).toBeLessThan(0.05);
  });

  it('reports the totals on every score', async () => {
    const supabase = mockSupabase({ hamTotal: 30, spamTotal: 25, rows: [] });
    const score = await scoreSpamFilter(supabase, ['x']);
    expect(score.hamTotal).toBe(30);
    expect(score.spamTotal).toBe(25);
  });
});

describe('renderSpamHint', () => {
  it('returns null on cold start', () => {
    expect(
      renderSpamHint({
        spamProbability: 0.5,
        hamTotal: 5,
        spamTotal: 5,
        coldStart: true,
      })
    ).toBeNull();
  });

  it('includes the percentage and sample sizes', () => {
    const hint = renderSpamHint({
      spamProbability: 0.73,
      hamTotal: 47,
      spamTotal: 12,
      coldStart: false,
    });
    expect(hint).not.toBeNull();
    expect(hint).toContain('73%');
    expect(hint).toContain('47 ham');
    expect(hint).toContain('12 spam');
    expect(hint).toContain('soft signal');
  });
});

describe('trainSpamFilter', () => {
  it('passes tokens and label through to the supabase RPC', async () => {
    let received: { tokens: readonly string[]; label: 'ham' | 'spam' } | null = null;
    const supabase = mockSupabase({
      hamTotal: 0,
      spamTotal: 0,
      onTrain: (tokens, label) => {
        received = { tokens, label };
      },
    });
    await trainSpamFilter(supabase, ['hello', 'world'], 'ham');
    expect(received).not.toBeNull();
    expect(received!.tokens).toEqual(['hello', 'world']);
    expect(received!.label).toBe('ham');
  });
});

describe('untrainSpamFilter', () => {
  it('passes tokens and label through to the untrain RPC', async () => {
    let received: { tokens: readonly string[]; label: 'ham' | 'spam' } | null = null;
    const supabase = mockSupabase({
      hamTotal: 0,
      spamTotal: 0,
      onUntrain: (tokens, label) => {
        received = { tokens, label };
      },
    });
    await untrainSpamFilter(supabase, ['hello', 'world'], 'ham');
    expect(received).not.toBeNull();
    expect(received!.tokens).toEqual(['hello', 'world']);
    expect(received!.label).toBe('ham');
  });

  it('does not call the train RPC', async () => {
    let trainCalls = 0;
    let untrainCalls = 0;
    const supabase = mockSupabase({
      hamTotal: 0,
      spamTotal: 0,
      onTrain: () => {
        trainCalls += 1;
      },
      onUntrain: () => {
        untrainCalls += 1;
      },
    });
    await untrainSpamFilter(supabase, ['x'], 'spam');
    expect(trainCalls).toBe(0);
    expect(untrainCalls).toBe(1);
  });
});
