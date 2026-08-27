// Unit coverage for the samskara formation pipeline's pure parts.
//
// The prompt assertions pin the structural contract each phase's
// parser depends on, so a prompt edit that breaks the JSON shape
// fails here instead of silently degrading formation. The
// cluster/vector helpers get direct behavioural coverage - they shape
// what the minter sees and what provenance records.
import { assert, assertEquals } from 'jsr:@std/assert';
import { __test } from '../venice/agents/samskara.ts';

const {
  ASSIMILATOR_PROMPT,
  RELATOR_PROMPT,
  MINTER_PROMPT,
  TIER2_MINTER_PROMPT,
  COMPOUND_SUMMARY_PROMPT,
  SAMSKARA_MODEL,
  TAIL_ASSIMILATE_CAP,
  SWEEP_ASSIMILATE_CAP,
  MINT_DEDUP_COSINE,
  MINT_CLUSTER_COSINE_FLOOR,
  MINT_CLUSTER_MAX,
  MINT_CLUSTER_MIN,
  TIER1_POPULATION_CAP,
  ASSOC_HUBS_PER_TICK,
  buildTopicalCluster,
  buildAssociationCluster,
  cosine,
  doubtForAssimilation,
  parseVector,
  stripJsonFence,
} = __test;

// --- prompt structural contracts ------------------------------------------

Deno.test('assimilator prompt names the three output fields', () => {
  for (const field of ['"situation"', '"outcome"', '"valence"']) {
    assert(ASSIMILATOR_PROMPT.includes(field), `missing ${field}`);
  }
  assert(ASSIMILATOR_PROMPT.includes('no markdown fence'));
});

Deno.test('assimilator prompt explains the optional second-thoughts doubt', () => {
  // The doubt payload field and its three dispositions must stay
  // named in the prompt - agentAssimilate attaches
  // `assistant_second_thoughts` and an unexplained field would read
  // as noise to the fast tier.
  assert(ASSIMILATOR_PROMPT.includes('assistant_second_thoughts'));
  for (const d of ['hedge', 'reframe', 'correct']) {
    assert(ASSIMILATOR_PROMPT.includes(`"${d}"`), `missing disposition ${d}`);
  }
  assert(ASSIMILATOR_PROMPT.includes('acted'));
});

Deno.test('doubtForAssimilation: doubts pass, conviction and junk read as null', () => {
  const doubt = doubtForAssimilation({
    v: 1,
    disposition: 'reframe',
    note: '  did they mean the other thing?  ',
    acted: true,
    model: 'm',
    computed_at: 1,
  });
  assert(doubt !== null);
  assertEquals(doubt!.disposition, 'reframe');
  assertEquals(doubt!.note, 'did they mean the other thing?');
  assertEquals(doubt!.acted, true);

  // Conviction is the base-rate no-op verdict - never forwarded.
  assertEquals(
    doubtForAssimilation({ v: 1, disposition: 'conviction', note: '', model: 'm', computed_at: 1 }),
    null,
  );
  // Absent / malformed / wrong-version shapes read as "no doubt".
  assertEquals(doubtForAssimilation(null), null);
  assertEquals(doubtForAssimilation('hedge'), null);
  assertEquals(doubtForAssimilation({ v: 2, disposition: 'hedge' }), null);
  assertEquals(doubtForAssimilation({ v: 1, disposition: 'unsure' }), null);
  // Missing note / acted coerce to safe defaults rather than dropping
  // the doubt.
  const bare = doubtForAssimilation({ v: 1, disposition: 'correct' });
  assert(bare !== null);
  assertEquals(bare!.note, '');
  assertEquals(bare!.acted, false);
});

Deno.test('relator prompt enumerates all five kinds', () => {
  for (const kind of ['pattern', 'contrast', 'prerequisite', 'consequence', 'orthogonal']) {
    assert(RELATOR_PROMPT.includes(`"${kind}"`), `missing kind ${kind}`);
  }
  assert(RELATOR_PROMPT.includes('Bias toward orthogonal'));
});

Deno.test('both minter prompts share the confirm-gated output shape', () => {
  for (const prompt of [MINTER_PROMPT, TIER2_MINTER_PROMPT]) {
    for (const field of [
      '"confirm"',
      '"prediction"',
      '"inner_voice"',
      '"valence"',
      '"confidence"',
    ]) {
      assert(prompt.includes(field), `missing ${field}`);
    }
    assert(prompt.includes('confirm:false'));
  }
  // The tier-2 prompt's distinguishing demand: generalize, never
  // enumerate the children.
  assert(TIER2_MINTER_PROMPT.includes('GENERALIZE'));
  assert(TIER2_MINTER_PROMPT.includes('children'));
});

Deno.test('compound summary prompt forbids the leaky failure modes', () => {
  assert(COMPOUND_SUMMARY_PROMPT.includes('Do not mention the word\n"samskara"'));
  assert(COMPOUND_SUMMARY_PROMPT.includes('third person'));
  assert(COMPOUND_SUMMARY_PROMPT.includes('Do not enumerate or list'));
});

// --- tuning constants -------------------------------------------------------

Deno.test('caps and thresholds hold their designed relationships', () => {
  assertEquals(SAMSKARA_MODEL, 'z-ai-glm-5-3-flash');
  // Tail cap stays small (the chain runs before reflection); the
  // sweep cap matches the fleet's per-tick queue convention.
  assert(TAIL_ASSIMILATE_CAP < SWEEP_ASSIMILATE_CAP);
  // The dedup threshold must sit ABOVE the cluster floor: rows that
  // merely share a topic (>= floor) must not auto-collapse as
  // duplicates (>= dedup).
  assert(MINT_DEDUP_COSINE > MINT_CLUSTER_COSINE_FLOOR);
  assert(MINT_CLUSTER_MIN >= 3);
  assert(MINT_CLUSTER_MAX >= MINT_CLUSTER_MIN);
  // Pinned to the exact value because it MUST mirror p_target_count on
  // samskara_collapse_by_cofiring (schema.sql). Drift re-opens the
  // mint/cap-merge treadmill (cap here higher) or freezes minting
  // permanently (cap here lower) - change both together.
  assertEquals(TIER1_POPULATION_CAP, 150);
  // Bounded small on purpose: each hub is one minter call and the
  // probe runs every sweep tick - the cap IS the spend ceiling.
  assert(ASSOC_HUBS_PER_TICK >= 1 && ASSOC_HUBS_PER_TICK <= 5);
});

// --- helpers ----------------------------------------------------------------

function unit(...vals: number[]): number[] {
  const norm = Math.sqrt(vals.reduce((s, v) => s + v * v, 0));
  return vals.map((v) => v / norm);
}

Deno.test('cosine: orthogonal, identical, and zero-norm inputs', () => {
  assertEquals(cosine([1, 0], [0, 1]), 0);
  assert(Math.abs(cosine([1, 2, 3], [1, 2, 3]) - 1) < 1e-9);
  // Zero-norm signals an unusable embedding and must read as
  // "maximally dissimilar", not NaN.
  assertEquals(cosine([], [1, 2]), -1);
  assertEquals(cosine([0, 0], [1, 2]), -1);
});

Deno.test('buildTopicalCluster keeps same-topic rows and drops strays', () => {
  const seedEmb = unit(1, 0, 0);
  const near = unit(0.9, 0.1, 0); // cosine ~0.99 vs seed
  const far = unit(0, 1, 0); // cosine 0 vs seed
  const rows = [
    { id: 'seed', situation: 's', outcome: 'o', embedding: seedEmb },
    { id: 'near', situation: 's', outcome: 'o', embedding: near },
    { id: 'far', situation: 's', outcome: 'o', embedding: far },
    { id: 'broken', situation: 's', outcome: 'o', embedding: [] },
  ];
  const cluster = buildTopicalCluster(rows);
  assertEquals(
    cluster.map((r) => r.id),
    ['seed', 'near'],
  );
});

Deno.test('buildTopicalCluster caps the cluster at MINT_CLUSTER_MAX', () => {
  const emb = unit(1, 0);
  const rows = Array.from({ length: MINT_CLUSTER_MAX + 3 }, (_, i) => ({
    id: `r${i}`,
    situation: 's',
    outcome: 'o',
    embedding: emb,
  }));
  assertEquals(buildTopicalCluster(rows).length, MINT_CLUSTER_MAX);
});

Deno.test('buildAssociationCluster: hub first, distinct partners, all labels, summed reinforcement', () => {
  const edge = (
    association_id: string,
    partner_id: string,
    label: string,
    reinforcement: number,
  ) => ({
    association_id,
    label,
    kind: 'pattern',
    reinforcement,
    hub_id: 'hub',
    hub_situation: 'hub-sit',
    partner_id,
    partner_situation: `sit-${partner_id}`,
  });
  // Two edges to partner A (different labels) + one to partner B.
  const edges = [
    edge('e1', 'A', 'both seek mechanisms', 3),
    edge('e2', 'A', 'both are terse', 2),
    edge('e3', 'B', 'both reference cost', 1),
  ];
  const cluster = buildAssociationCluster(edges);
  // Members dedup on partner: hub + A + B = 3 member rows / situations.
  assertEquals(cluster.memberIds, ['hub', 'A', 'B']);
  assertEquals(cluster.situations, ['hub-sit', 'sit-A', 'sit-B']);
  // Labels are per-edge, partner-duplicates kept (A contributes two).
  assertEquals(cluster.labels, [
    'both seek mechanisms',
    'both are terse',
    'both reference cost',
  ]);
  // Reinforcement sums across every edge, not deduped.
  assertEquals(cluster.reinforcementSum, 6);
});

Deno.test('parseVector handles pgvector text, arrays, and garbage', () => {
  assertEquals(parseVector('[0.5,1.5]'), [0.5, 1.5]);
  assertEquals(parseVector([1, 2]), [1, 2]);
  assertEquals(parseVector('not json'), []);
  assertEquals(parseVector(null), []);
  assertEquals(parseVector('{"a":1}'), []);
});

Deno.test('stripJsonFence unwraps fenced and bare payloads alike', () => {
  assertEquals(stripJsonFence('```json\n{"a":1}\n```'), '{"a":1}');
  assertEquals(stripJsonFence('```\n{"a":1}\n```'), '{"a":1}');
  assertEquals(stripJsonFence('  {"a":1}  '), '{"a":1}');
});
