// Offline coverage for the bias-sweep module's pure surface: the
// observer prompt must embed the full catalog (the prompt renders
// from _shared/bias-catalog.ts at module load - a broken render
// would ship an agent that can only fabricate bias names), and the
// tick's tunables are load-bearing for Venice spend. The DB- and
// Venice-coupled paths (claim, save, aggregate) are exercised by
// docs/qa/use-cases/bias-pipeline.md against a live stack.
import { assert, assertEquals } from 'jsr:@std/assert';
import { __test } from '../venice/agents/bias.ts';
import { BIAS_KEYS, BIAS_CATALOG } from '../_shared/bias-catalog.ts';

Deno.test('observer prompt embeds every catalog key with its guidance', () => {
  for (const key of BIAS_KEYS) {
    assert(
      __test.BIAS_OBSERVER_PROMPT.includes(`- ${key} - `),
      `prompt is missing catalog entry ${key}`,
    );
    assert(
      __test.BIAS_OBSERVER_PROMPT.includes(BIAS_CATALOG[key].guidance),
      `prompt is missing compensation guidance for ${key}`,
    );
  }
});

Deno.test('observer prompt keeps the structural sections', () => {
  // The falsification ladder and the output contract are the
  // behavior-parity core of the verbatim port - if a future edit
  // drops a section, the agent's false-positive posture changes
  // silently.
  for (const marker of [
    '# OBSERVATIONS',
    '# REACTIONS',
    '## Falsification - before reporting any bias, ask in order',
    '{"observations": [ ... ], "reactions": [ ... ]}',
    'Never report below 0.40 or above 0.85.',
  ]) {
    assert(
      __test.BIAS_OBSERVER_PROMPT.includes(marker),
      `prompt is missing section marker: ${marker}`,
    );
  }
});

Deno.test('sweep tunables hold their designed values', () => {
  // 10 analyze claims/tick bounds Venice spend; 24h is the aggregate
  // freshness floor. Changing either is a deliberate cost/latency
  // decision - see the constants' comments in agents/bias.ts.
  assertEquals(__test.ANALYZE_SWEEP_CAP, 10);
  assertEquals(__test.SUMMARY_MAX_AGE_MS, 24 * 60 * 60 * 1000);
});

// --- B6 falsification verifier (pure parts) ---------------------------------

const { buildObserverMessages, buildObserverPayload, allowedEvidenceIds, checkProvenance } = __test;
const { judgeItems, buildVerifierRequest, applyVerifierDecisions, trimPayloadMessages } = __test;
const { VERIFIER_VETO_THRESHOLD, BIAS_VERIFIER_STATE_BUDGET_CHARS } = __test;

const FORK_NOTE = 'Only cite evidence from messages below the FORK POINT marker.';
const TRANSCRIPT = [
  { id: 'm1', role: 'user' as const, content: 'inherited user line' },
  { id: 'm2', role: 'assistant' as const, content: 'inherited assistant line' },
  { id: 'm3', role: 'user' as const, content: 'own user line' },
  { id: 'm4', role: 'assistant' as const, content: 'own assistant line' },
];

Deno.test('payload identity: marker spliced id-less at the boundary, fork_note only on forks', () => {
  const forked = buildObserverMessages(TRANSCRIPT, {
    note: FORK_NOTE,
    boundary: 2,
  });
  assertEquals(forked.length, 5);
  const markerIdx = forked.findIndex((m) => m.role === 'system');
  assertEquals(markerIdx, 2);
  assertEquals(forked[markerIdx].id, undefined);
  const forkedPayload = JSON.parse(buildObserverPayload(forked, ['sunk_cost_fallacy'], FORK_NOTE));
  assertEquals(forkedPayload.fork_note, FORK_NOTE);
  assertEquals(forkedPayload.messages[2].content.includes('FORK POINT'), true);

  const plain = buildObserverMessages(TRANSCRIPT);
  const plainPayload = JSON.parse(buildObserverPayload(plain, []));
  assertEquals('fork_note' in plainPayload, false);
  assertEquals(plainPayload.messages.length, 4);
});

Deno.test('allowedEvidenceIds: all user rows unforked; own rows only when forked', () => {
  const plain = allowedEvidenceIds(buildObserverMessages(TRANSCRIPT));
  assertEquals([...plain].sort(), ['m1', 'm3']);

  const forked = allowedEvidenceIds(buildObserverMessages(TRANSCRIPT, { note: FORK_NOTE, boundary: 2 }));
  assertEquals([...forked], ['m3']);
});

const OBS: import('../venice/agents/bias.ts').ObservationItem[] = [
  { bias: 'sunk_cost_fallacy', confidence: 0.7, reasoning: 'user insisted on the failing path', evidence_message_id: 'm3' },
  { bias: 'anchoring', confidence: 0.5, reasoning: 'user fixated on the first number', evidence_message_id: null },
];
const REACTIONS: import('../venice/agents/bias.ts').ReactionItem[] = [
  { bias: 'sunk_cost_fallacy', was_confirmed: false, reasoning: 'user said stop hedging' },
  { bias: 'anchoring', was_confirmed: null, reasoning: 'no clear signal' },
];

Deno.test('checkProvenance nulls unresolvable and above-boundary ids, keeps the row', () => {
  const fabricated = [{ ...OBS[0], evidence_message_id: 'nope' }];
  const allowed = new Set(['m3']);
  const { observations, nulled } = checkProvenance(fabricated, allowed);
  assertEquals(nulled, 1);
  assertEquals(observations[0].evidence_message_id, null);
  assertEquals(observations[0].reasoning, OBS[0].reasoning);
  // A null id is tolerated untouched (the deleted-message case).
  const { observations: kept, nulled: n2 } = checkProvenance([OBS[1]], allowed);
  assertEquals(n2, 0);
  assertEquals(kept[0].evidence_message_id, null);
});

Deno.test('judgeItems caps at the shared item cap, observations first', () => {
  const manyObs = Array.from({ length: 14 }, (_, i) => ({ ...OBS[0], reasoning: `r${i}` }));
  const items = judgeItems(manyObs, REACTIONS);
  assertEquals(items.length, __test.DECISION_ITEM_CAP);
  assertEquals(items[items.length - 1].kind, 'obs');
});

Deno.test('verifier request: decision model, payload state, per-emission nouls with the catalog entry', () => {
  const messages = buildObserverMessages(TRANSCRIPT);
  const state = buildObserverPayload(messages, ['sunk_cost_fallacy']);
  const req = buildVerifierRequest(state, OBS, [REACTIONS[0]], new Set(['obs-0', 're-0']));
  assertEquals(req.model, 'clef-api');
  assertEquals(req.state, state);
  const questions = req.questions as Record<string, { type: string; instructions: string }>;
  assertEquals(Object.keys(questions).length, 2);
  const obsQ = questions['obs-0'];
  assertEquals(obsQ.type, 'noul');
  assert(obsQ.instructions.includes('sunk_cost_fallacy'));
  assert(obsQ.instructions.includes(BIAS_CATALOG.sunk_cost_fallacy.definition));
  assert(obsQ.instructions.includes(BIAS_CATALOG.sunk_cost_fallacy.nearMiss));
  assert(obsQ.instructions.includes(OBS[0].reasoning));
  const reQ = questions['re-0'];
  assertEquals(reQ.type, 'noul');
  assert(reQ.instructions.includes('DISCONFIRMED'));
  assert(reQ.instructions.includes(BIAS_CATALOG.sunk_cost_fallacy.guidance));
  // A not-asked key gets no question.
  const filtered = buildVerifierRequest(state, OBS, [REACTIONS[0]], new Set(['obs-0']));
  assertEquals(Object.keys((filtered as { questions: Record<string, unknown> }).questions), ['obs-0']);
});

Deno.test('veto table: observation dropped below the cut, kept at/above; reaction downgraded', () => {
  const answers = {
    'obs-0': { noul: 0.3 },
    'obs-1': { noul: 0.9 },
    're-0': { noul: 0.2 },
  };
  const out = applyVerifierDecisions(OBS, REACTIONS, answers, new Set(['obs-0', 'obs-1', 're-0']));
  assertEquals(out.observations.map((o) => o.bias), ['anchoring']);
  assertEquals(out.reactions[0].was_confirmed, null);
  assertEquals(out.reactions[0].reasoning, REACTIONS[0].reasoning);
  assertEquals(out.reactions[1].was_confirmed, null);
  assertEquals(out.vetoes, 1);
  assertEquals(out.downgrades, 1);
});

Deno.test('fail-open: not-asked, malformed, and at-threshold emissions stand', () => {
  const out = applyVerifierDecisions(
    OBS,
    REACTIONS,
    { 'obs-0': { noul: 'high' }, 're-0': { noul: 0.5 } },
    new Set(['obs-0', 're-0']),
  );
  assertEquals(out.observations.length, 2);
  assertEquals(out.reactions[0].was_confirmed, false);
  assertEquals(out.vetoes, 0);
  assertEquals(out.downgrades, 0);
  // Nothing asked at all.
  const untouched = applyVerifierDecisions(OBS, REACTIONS, null, new Set());
  assertEquals(untouched.observations.length, 2);
  assertEquals(untouched.reactions.length, 2);
});

Deno.test('payload trim: keep-newest inside the envelope', () => {
  const messages = buildObserverMessages(TRANSCRIPT);
  const payload = buildObserverPayload(messages, ['anchoring'], FORK_NOTE);
  const trimmed = trimPayloadMessages(payload, 80);
  const parsed = JSON.parse(trimmed) as {
    fork_note?: string;
    messages: Array<{ id?: string }>;
    active_biases: string[];
  };
  assertEquals(parsed.fork_note, FORK_NOTE);
  assertEquals(parsed.active_biases, ['anchoring']);
  assertEquals(parsed.messages.length, 1);
  assertEquals(parsed.messages[0].id, 'm4');
});

Deno.test('verifier tunables', () => {
  assertEquals(VERIFIER_VETO_THRESHOLD, 0.5);
  assertEquals(BIAS_VERIFIER_STATE_BUDGET_CHARS, 80_000);
});
