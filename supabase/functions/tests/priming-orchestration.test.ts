// Deno coverage for the priming orchestration (venice/priming.ts
// runServerPriming / runThinkChain). This is the new, load-bearing code
// the relocation introduced, and its bugs are behavioral (wrong <think>
// order, a missed event, a stale prime injected) - the type gate cannot
// catch them. We stub the Venice/RPC-coupled pipelines through the
// `deps` seam and drive the orchestration's pure logic: the splice
// order + index, the liveness/payload event sequence, and freshness
// suppression. The pipelines' own internals + the live timeout race are
// covered by docs/qa/use-cases/priming-disconnect-survival.md.
import { assert, assertEquals } from 'jsr:@std/assert';
import { type SupabaseClient } from '@supabase/supabase-js';
import {
  runServerPriming,
  type ServerPrimingDeps,
} from '../venice/priming.ts';
import { type BroadcastPublisher } from '../venice/broadcast.ts';
import {
  type IntuitionPayload,
  INTUITION_THINK_MARKER,
} from '../venice/priming/intuition-payload.ts';
import {
  type ContextRecallPayload,
  CONTEXT_RECALL_THINK_MARKER,
} from '../venice/priming/context-recall-payload.ts';
import { type FireResult } from '../venice/priming/samskara-format.ts';
import { STALE_FUSE_MS } from '../_shared/priming-triggers.ts';

interface Msg {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content?: string | null;
}

// Chainable fake admin client. readThreadCaches walks
// from().select().eq().eq().maybeSingle(); persistThreadCache walks
// from().update().eq().eq() and awaits the builder. The builder is
// thenable so the awaited persist path resolves {error:null}, and it
// records every update payload.
function makeAdmin(threadRow: Record<string, unknown> | null, updates: Record<string, unknown>[]) {
  // deno-lint-ignore no-explicit-any
  const builder: any = {
    select: () => builder,
    update: (obj: Record<string, unknown>) => {
      updates.push(obj);
      return builder;
    },
    eq: () => builder,
    maybeSingle: () => Promise.resolve({ data: threadRow, error: null }),
    then: (res: (v: { error: null }) => void) => res({ error: null }),
  };
  // deno-lint-ignore no-explicit-any
  const admin: any = { from: () => builder };
  return admin as SupabaseClient;
}

function makePublisher(events: Record<string, unknown>[]): BroadcastPublisher {
  // deno-lint-ignore no-explicit-any
  const pub: any = {
    publish: (e: Record<string, unknown>) => {
      events.push(e);
      return Promise.resolve();
    },
    flush: () => Promise.resolve(),
    dispose: () => {},
    currentTier: () => 0,
  };
  return pub as BroadcastPublisher;
}

function baseHistory(): Msg[] {
  return [
    { role: 'system', content: 'BASELINE' },
    { role: 'user', content: 'hello there' },
    { role: 'system', content: 'METADATA' },
  ];
}

function intuitionPayload(over: Partial<IntuitionPayload> = {}): IntuitionPayload {
  return {
    v: 1,
    perception: 'Classification: technical',
    drives: {},
    synthesis: 'SYNTH',
    computed_at_round: 1,
    computed_at_band: null,
    computed_at_column: null,
    computed_at_at: Date.now(),
    trigger: 'cold',
    ...over,
  };
}
function recallPayload(over: Partial<ContextRecallPayload> = {}): ContextRecallPayload {
  return {
    v: 2,
    note: 'NOTE',
    citations: [],
    computed_at_round: 1,
    computed_at_band: null,
    computed_at_column: null,
    computed_at_at: Date.now(),
    trigger: 'cold',
    ...over,
  };
}
function fireResult(): FireResult {
  return {
    cohortId: crypto.randomUUID(),
    fired: [
      { id: crypto.randomUUID(), prediction: 'PRED', innerVoice: null, valence: 0, confidence: 0.7, health: 0.9, score: 0.8 },
    ],
  };
}

// A deps set whose pipelines all produce content, with overridable bits.
function makeDeps(over: Partial<ServerPrimingDeps> = {}): ServerPrimingDeps {
  return {
    applyBiasPriming: () => Promise.resolve(),
    applyIntentPriming: () => Promise.resolve(),
    getCompoundSummary: () => Promise.resolve('COMPOUND PROSE'),
    fireSamskaras: () => Promise.resolve(fireResult()),
    runIntuitionPipeline: () => Promise.resolve(intuitionPayload()),
    runContextRecallPipeline: () => Promise.resolve(recallPayload()),
    ...over,
  };
}

function count(events: Record<string, unknown>[], type: string, op?: string): number {
  return events.filter((e) => e.type === type && (op === undefined || e.op === op)).length;
}

Deno.test('full chain: splices <think> in contracted order before the metadata row', async () => {
  const history = baseHistory();
  const events: Record<string, unknown>[] = [];
  const updates: Record<string, unknown>[] = [];
  await runServerPriming({
    adminClient: makeAdmin({ intuition_payload: null, context_recall_payload: null }, updates),
    userId: 'u',
    threadId: 't',
    apiKey: 'k',
    history,
    publisher: makePublisher(events),
    priming: { intuitionModelId: 'fast', intuitionMood: { band: 1, column: 'confident' }, contextRecallEnabled: true },
    runId: 'test',
    deps: makeDeps(),
  });

  // [BASELINE, user, CR, compound, fire, intuition, METADATA]
  assertEquals(history.length, 7);
  assertEquals(history[0].content, 'BASELINE');
  assertEquals(history[6].content, 'METADATA', 'metadata must stay last on the wire');
  assert(history[2].content!.includes(CONTEXT_RECALL_THINK_MARKER), 'row 4 = context-recall');
  assert(history[3].content!.includes('COMPOUND PROSE'), 'row 5 = samskara compound');
  assert(history[4].content!.includes("Some things I've come to expect"), 'row 6 = samskara fire');
  assert(history[5].content!.includes(INTUITION_THINK_MARKER), 'row 7 = intuition');
  assert(history[5].content!.includes('SYNTH'));
});

Deno.test('bias and intent appendices are sequenced: intent renders after bias on row 0', async () => {
  // Both append to the row-0 system message; running them concurrently
  // would race and drop one. The orchestration must chain them, bias
  // first so the intent block's "guidance above" precedence resolves.
  const history = baseHistory();
  await runServerPriming({
    adminClient: makeAdmin({ intuition_payload: null, context_recall_payload: null }, []),
    userId: 'u',
    threadId: 't',
    apiKey: 'k',
    history,
    publisher: makePublisher([]),
    priming: { intuitionModelId: 'fast', intuitionMood: { band: 1, column: 'confident' }, contextRecallEnabled: true },
    runId: 'test',
    deps: makeDeps({
      applyBiasPriming: ({ history }) => {
        history[0].content += '\n\nBIAS';
        return Promise.resolve();
      },
      applyIntentPriming: ({ history }) => {
        history[0].content += '\n\nINTENT';
        return Promise.resolve();
      },
    }),
  });
  const row0 = history[0].content!;
  assert(row0.startsWith('BASELINE'));
  assert(row0.indexOf('BIAS') < row0.indexOf('INTENT'), 'intent must append after bias');
});

Deno.test('full chain: 1:1 liveness pairs + payload events, and caches persisted', async () => {
  const events: Record<string, unknown>[] = [];
  const updates: Record<string, unknown>[] = [];
  await runServerPriming({
    adminClient: makeAdmin({ intuition_payload: null, context_recall_payload: null }, updates),
    userId: 'u',
    threadId: 't',
    apiKey: 'k',
    history: baseHistory(),
    publisher: makePublisher(events),
    priming: { intuitionModelId: 'fast', intuitionMood: { band: 1, column: 'confident' }, contextRecallEnabled: true },
    runId: 'test',
    deps: makeDeps(),
  });

  for (const op of ['samskara', 'intuition', 'recall']) {
    assertEquals(count(events, 'priming_start', op), 1, `one start for ${op}`);
    assertEquals(count(events, 'priming_end', op), 1, `one end for ${op}`);
  }
  assertEquals(count(events, 'intuition_payload'), 1);
  assertEquals(count(events, 'context_recall_payload'), 1);
  // Both fresh payloads were persisted to the thread row.
  assert(updates.some((u) => 'intuition_payload' in u), 'intuition cache persisted');
  assert(updates.some((u) => 'context_recall_payload' in u), 'context-recall cache persisted');
});

Deno.test('disabled pipelines never run, never flash a spinner; samskara still fires', async () => {
  const history = baseHistory();
  const events: Record<string, unknown>[] = [];
  const updates: Record<string, unknown>[] = [];
  await runServerPriming({
    adminClient: makeAdmin({ intuition_payload: null, context_recall_payload: null }, updates),
    userId: 'u',
    threadId: 't',
    apiKey: 'k',
    history,
    publisher: makePublisher(events),
    // No intuition model, context recall off.
    priming: {},
    runId: 'test',
    // Samskara has no signal this turn (cold corpus).
    deps: makeDeps({
      getCompoundSummary: () => Promise.resolve(null),
      fireSamskaras: () => Promise.resolve(null),
    }),
  });

  assertEquals(count(events, 'priming_start', 'intuition'), 0);
  assertEquals(count(events, 'priming_start', 'recall'), 0);
  assertEquals(count(events, 'intuition_payload'), 0);
  assertEquals(count(events, 'context_recall_payload'), 0);
  // Samskara always attempts (its start/end bracket the fire).
  assertEquals(count(events, 'priming_start', 'samskara'), 1);
  assertEquals(count(events, 'priming_end', 'samskara'), 1);
  // Nothing to inject, nothing persisted.
  assertEquals(history.length, 3);
  assertEquals(updates.length, 0);
});

Deno.test('a stale cached payload that did not refresh is suppressed from the splice', async () => {
  // Intuition disabled (no model) -> no trigger -> no refresh. The thread
  // carries a payload older than the fuse; it must NOT be injected (a
  // stale prime steers the model wrong).
  const stale = intuitionPayload({ computed_at_at: Date.now() - 2 * STALE_FUSE_MS });
  const history = baseHistory();
  const events: Record<string, unknown>[] = [];
  const updates: Record<string, unknown>[] = [];
  await runServerPriming({
    adminClient: makeAdmin({ intuition_payload: stale, context_recall_payload: null }, updates),
    userId: 'u',
    threadId: 't',
    apiKey: 'k',
    history,
    publisher: makePublisher(events),
    priming: {},
    runId: 'test',
    deps: makeDeps({
      getCompoundSummary: () => Promise.resolve(null),
      fireSamskaras: () => Promise.resolve(null),
    }),
  });

  assert(
    !history.some((m) => (m.content ?? '').includes(INTUITION_THINK_MARKER)),
    'stale intuition payload must not be spliced',
  );
  assertEquals(history.length, 3);
});
