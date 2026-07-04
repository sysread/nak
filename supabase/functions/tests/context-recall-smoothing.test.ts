// Pure-logic coverage for the context-recall smoothing pass: source
// numbering, the rendered source block the model reads, citation
// projection, and `^N^` extraction. The Venice completion itself isn't
// unit-tested (no live model in the suite), same posture as web_search.
import { assert, assertEquals } from 'jsr:@std/assert';
import { __test } from '../venice/priming/context-recall-smoothing.ts';
import { type ContextIndex } from '../venice/priming/context-recall.ts';

const {
  citationsFromSources,
  extractCitedIndices,
  numberRecallSources,
  renderRecallSourceBlock,
  renderFollowupBlock,
} = __test;

function sampleIndex(): ContextIndex {
  return {
    memories: [
      {
        id: 'm1',
        label: 'Besan ratio',
        data: 'Uses 25g besan.',
        confidence_tag: null,
        created_at: '2026-05-27T10:00:00.000Z',
      },
      {
        id: 'm2',
        label: 'Hydration',
        data: 'Prefers high hydration.',
        confidence_tag: 'shaky',
        created_at: '2026-03-02T00:00:00.000Z',
      },
    ],
    conversations: [{ id: 'c1', title: 'Prior bake' }],
    wiki: [{ id: 'w1', title: 'Tangzhong' }],
    followups: [],
  };
}

Deno.test('numberRecallSources numbers memories, then conversations, then wiki', () => {
  const sources = numberRecallSources(sampleIndex());
  assertEquals(
    sources.map((s) => [s.index, s.kind, s.id]),
    [
      [1, 'memory', 'm1'],
      [2, 'memory', 'm2'],
      [3, 'conversation', 'c1'],
      [4, 'wiki', 'w1'],
    ],
  );
});

Deno.test('numberRecallSources anchors memory dates and carries confidence', () => {
  const sources = numberRecallSources(sampleIndex());
  assertEquals(sources[0].recordedDate, '2026-05-27');
  assertEquals(sources[1].recordedDate, '2026-03-02');
  assertEquals(sources[1].confidenceTag, 'shaky');
  // Refs carry no date or confidence.
  assertEquals(sources[2].recordedDate, null);
  assertEquals(sources[2].confidenceTag, null);
});

Deno.test('renderRecallSourceBlock formats each kind, flagging low confidence', () => {
  const block = renderRecallSourceBlock(numberRecallSources(sampleIndex()));
  assertEquals(
    block,
    [
      '[1] (memory, recorded 2026-05-27) Besan ratio: Uses 25g besan.',
      '[2] (memory, recorded 2026-03-02, shaky) Hydration: Prefers high hydration.',
      '[3] (prior conversation) Prior bake',
      '[4] (wiki article) Tangzhong',
    ].join('\n'),
  );
});

Deno.test('citationsFromSources projects to persisted citation rows', () => {
  const citations = citationsFromSources(numberRecallSources(sampleIndex()));
  assertEquals(citations, [
    { index: 1, kind: 'memory', id: 'm1', label: 'Besan ratio' },
    { index: 2, kind: 'memory', id: 'm2', label: 'Hydration' },
    { index: 3, kind: 'conversation', id: 'c1', label: 'Prior bake' },
    { index: 4, kind: 'wiki', id: 'w1', label: 'Tangzhong' },
  ]);
});

Deno.test('extractCitedIndices pulls and dedupes ^N^ superscripts', () => {
  const cited = extractCitedIndices('Recall A ^1^ and B ^3^, and again ^3^.');
  assertEquals([...cited].sort((a, b) => a - b), [1, 3]);
});

Deno.test('extractCitedIndices is empty when the note carries no markers', () => {
  assert(extractCitedIndices('plain prose, no citations').size === 0);
});

Deno.test('renderFollowupBlock labels the three epistemic states, uncited', () => {
  // Follow-ups never join the numbered source list - no citations, no
  // drill-down - and the state labels are computed by the gather, so
  // the render is a pure projection of (state, proactive).
  const block = renderFollowupBlock([
    {
      id: 'f1',
      question: 'Ask how the lasagna turned out',
      context: 'Planned a ricotta lasagna for Saturday',
      state: 'pending',
      proactive: true,
    },
    {
      id: 'f2',
      question: 'Ask how the VP meeting went',
      context: '',
      state: 'pending',
      proactive: false,
    },
    {
      id: 'f3',
      question: 'Ask about the half-marathon',
      context: 'Race is next month',
      state: 'upcoming',
      proactive: false,
    },
  ]);
  assertEquals(
    block,
    [
      '- [due - you have been meaning to ask] Ask how the lasagna turned out (Planned a ricotta lasagna for Saturday)',
      '- [outcome unknown] Ask how the VP meeting went',
      '- [upcoming - has not happened yet] Ask about the half-marathon (Race is next month)',
    ].join('\n'),
  );
});
