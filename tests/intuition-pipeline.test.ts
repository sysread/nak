/**
 * Coverage for the intuition pipeline assembly. Mocks Venice's
 * streamChat so the test stays offline and deterministic; verifies
 * the perception -> 5 drives -> synthesis fan-out, the
 * Classification: prefix normalisation, and the partial-failure
 * tolerance (a single-drive failure does not abort the pipeline).
 */
import { describe, it, expect } from 'vitest';
import { runIntuitionPipeline } from '../src/lib/intuition/pipeline';
import {
  buildIntuitionThinkMessage,
  INTUITION_THINK_MARKER,
} from '../src/lib/intuition/ephemeral';
import { coerceIntuitionPayload } from '../src/lib/intuition/types';
import type { VeniceClient, VeniceMessage, StreamEvent } from '../src/lib/venice';

/**
 * Build a fake VeniceClient whose streamChat returns a canned
 * response keyed off the system prompt. Tests pass a map of "system
 * prompt substring -> response text" so a single mock can serve
 * perception, every drive, and synthesis.
 */
function fakeVenice(responseFor: (systemPrompt: string) => string | Error): VeniceClient {
  const client = {
    streamChat: async function* (req: {
      messages: VeniceMessage[];
    }): AsyncGenerator<StreamEvent> {
      const sys = req.messages.find((m) => m.role === 'system');
      const sysText = typeof sys?.content === 'string' ? sys.content : '';
      const result = responseFor(sysText);
      if (result instanceof Error) throw result;
      yield { type: 'text', delta: result };
    },
  } as unknown as VeniceClient;
  return client;
}

const HISTORY: VeniceMessage[] = [
  { role: 'user', content: 'I have been thinking about quitting my job.' },
  {
    role: 'assistant',
    content:
      "That's a big consideration. What's pushing you toward it?",
  },
  {
    role: 'user',
    content: 'I just feel stuck. I do not know if I am being honest with myself.',
  },
];

describe('runIntuitionPipeline', () => {
  it('assembles all three stages and returns a complete payload', async () => {
    const venice = fakeVenice((sys) => {
      // The drive base prompt mentions "phantasia" too; the perception
      // prompt is the only one that contains "objective *perception*".
      if (sys.includes('objective *perception*')) {
        return 'Classification: venting\n\nThe user is uncertain about a major life decision and questioning their own self-knowledge.';
      }
      if (sys.includes('Drive: Attunement')) return 'Hold space, do not problem-solve.';
      if (sys.includes('Drive: Candor')) return 'Ask the harder question.';
      if (sys.includes('Drive: Curiosity')) return 'What is "stuck" actually pointing at?';
      if (sys.includes('Drive: Pragmatism')) return 'Do not jump to action items.';
      if (sys.includes('Drive: Standing')) return 'Respond thoughtfully; this matters.';
      if (sys.includes('synthesize') && sys.includes('Subconsciousness')) {
        // Synthesis
        return 'The user is venting and self-questioning. Reflect, do not solve.';
      }
      throw new Error(`unexpected prompt: ${sys.slice(0, 80)}`);
    });

    const payload = await runIntuitionPipeline({
      venice,
      model: 'fake-fast',
      history: HISTORY,
      signal: new AbortController().signal,
      round: 2,
      mood: { band: 3, column: 'tentative' },
      trigger: 'title',
    });

    expect(payload).not.toBeNull();
    expect(payload!.v).toBe(1);
    expect(payload!.perception).toMatch(/^Classification: venting/);
    expect(payload!.synthesis).toContain('Reflect, do not solve');
    expect(payload!.computed_at_round).toBe(2);
    expect(payload!.computed_at_band).toBe(3);
    expect(payload!.computed_at_column).toBe('tentative');
    expect(payload!.trigger).toBe('title');
    // All five drives responded.
    expect(Object.keys(payload!.drives).sort()).toEqual([
      'attunement',
      'candor',
      'curiosity',
      'pragmatism',
      'standing',
    ]);
  });

  it('prepends Classification: ambiguous when the model elides the prefix', async () => {
    const venice = fakeVenice((sys) => {
      if (sys.includes('objective *perception*')) {
        // Perception output without the prefix line.
        return 'The user is asking about something or other.';
      }
      if (sys.includes('Drive:')) return 'a reaction';
      if (sys.includes('synthesize')) return 'a synthesis';
      throw new Error('unexpected');
    });

    const payload = await runIntuitionPipeline({
      venice,
      model: 'fake-fast',
      history: HISTORY,
      signal: new AbortController().signal,
      round: 1,
      mood: null,
      trigger: 'cold',
    });
    expect(payload).not.toBeNull();
    expect(payload!.perception.startsWith('Classification: ambiguous')).toBe(true);
  });

  it('tolerates a single drive failure - synthesis still runs', async () => {
    const venice = fakeVenice((sys) => {
      if (sys.includes('objective *perception*')) {
        return 'Classification: research\n\nThe user is asking a factual question.';
      }
      if (sys.includes('Drive: Attunement')) return new Error('rate-limited');
      if (sys.includes('Drive: Candor')) return 'be honest';
      if (sys.includes('Drive: Curiosity')) return 'go deeper';
      if (sys.includes('Drive: Pragmatism')) return 'be brief';
      if (sys.includes('Drive: Standing')) return 'do well';
      if (sys.includes('synthesize')) return 'Be brief and accurate.';
      throw new Error('unexpected');
    });

    const payload = await runIntuitionPipeline({
      venice,
      model: 'fake-fast',
      history: HISTORY,
      signal: new AbortController().signal,
      round: 2,
      mood: null,
      trigger: 'mood',
    });
    expect(payload).not.toBeNull();
    expect(payload!.drives.attunement).toBeUndefined();
    expect(payload!.drives.candor).toBe('be honest');
    expect(payload!.synthesis).toBe('Be brief and accurate.');
  });

  it('returns null when perception fails entirely', async () => {
    const venice = fakeVenice((sys) => {
      if (sys.includes('objective *perception*')) return new Error('boom');
      return 'should not be reached';
    });
    const payload = await runIntuitionPipeline({
      venice,
      model: 'fake-fast',
      history: HISTORY,
      signal: new AbortController().signal,
      round: 1,
      mood: null,
      trigger: 'cold',
    });
    expect(payload).toBeNull();
  });

  it('returns null when every drive fails (nothing to synthesize)', async () => {
    const venice = fakeVenice((sys) => {
      if (sys.includes('objective *perception*')) {
        return 'Classification: chitchat\n\nthe user said hi';
      }
      if (sys.includes('# Your Drive:')) return new Error('all drives down');
      return 'unreached';
    });
    const payload = await runIntuitionPipeline({
      venice,
      model: 'fake-fast',
      history: HISTORY,
      signal: new AbortController().signal,
      round: 1,
      mood: null,
      trigger: 'cold',
    });
    expect(payload).toBeNull();
  });

  it('returns null on empty transcript', async () => {
    const venice = fakeVenice(() => 'unreached');
    const payload = await runIntuitionPipeline({
      venice,
      model: 'fake-fast',
      history: [],
      signal: new AbortController().signal,
      round: 0,
      mood: null,
      trigger: 'cold',
    });
    expect(payload).toBeNull();
  });
});

describe('buildIntuitionThinkMessage', () => {
  it('wraps the synthesis in <think> tags with the marker', () => {
    const msg = buildIntuitionThinkMessage({
      v: 1,
      perception: 'Classification: chitchat',
      drives: {},
      synthesis: 'short and warm.',
      computed_at_round: 1,
      computed_at_band: 2,
      computed_at_column: 'confident',
      computed_at_at: 1_700_000_000_000,
      trigger: 'cold',
    });
    expect(msg.role).toBe('assistant');
    expect(msg.content).toContain('<think>');
    expect(msg.content).toContain('</think>');
    expect(msg.content).toContain(INTUITION_THINK_MARKER);
    expect(msg.content).toContain('short and warm');
  });
});

describe('coerceIntuitionPayload', () => {
  it('passes through a well-formed payload', () => {
    const raw = {
      v: 1,
      perception: 'Classification: task\n\nThey want a recipe.',
      drives: { curiosity: 'consider variations' },
      synthesis: 'Suggest a balanced recipe with one twist.',
      computed_at_round: 4,
      computed_at_band: 1,
      computed_at_column: 'confident',
      computed_at_at: 1_700_000_000_000,
      trigger: 'mood',
    };
    expect(coerceIntuitionPayload(raw)).not.toBeNull();
  });

  it('rejects a payload with the wrong version', () => {
    expect(coerceIntuitionPayload({ v: 99, perception: 'x' })).toBeNull();
  });

  it('rejects a payload missing required fields', () => {
    expect(
      coerceIntuitionPayload({
        v: 1,
        perception: 'x',
        drives: {},
        synthesis: '',
        computed_at_round: 1,
        computed_at_band: 0,
        computed_at_column: 'confident',
        computed_at_at: 1,
        trigger: 'cold',
      })
    ).toBeNull(); // empty synthesis is rejected
  });

  it('drops drives with non-string values', () => {
    const raw = {
      v: 1,
      perception: 'Classification: chitchat\n\nhi',
      drives: { curiosity: 'good', attunement: 42 },
      synthesis: 'be warm',
      computed_at_round: 1,
      computed_at_band: 2,
      computed_at_column: 'confident',
      computed_at_at: 1,
      trigger: 'cold',
    };
    const out = coerceIntuitionPayload(raw)!;
    expect(out.drives.curiosity).toBe('good');
    expect(out.drives.attunement).toBeUndefined();
  });

  it('returns null on null/undefined', () => {
    expect(coerceIntuitionPayload(null)).toBeNull();
    expect(coerceIntuitionPayload(undefined)).toBeNull();
  });
});
