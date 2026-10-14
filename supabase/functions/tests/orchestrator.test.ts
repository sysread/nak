// Orchestrator harness: drives getStreamingResponse end-to-end with
// scripted Venice completions and a stubbed adminClient - no network,
// no Supabase. The seam is OrchestratorOpts.complete (mirrors
// runHeadlessAgent's injectable `complete` seam), so the round loop
// itself stays inline and untested code paths are exercised the way
// production runs them: real dispatch, real persistence order, real
// terminal writes, everything asserted off the DB calls and the
// published event log.
//
// What this covers that the unit-level exports cannot: the runRowIds
// registration feeding the aborted-regenerate rollback, the catch
// guard's terminal assignment on an abort+throw co-timing, graceful
// wall-timeout during dispatch, the deferred-drain loop through
// re-issue, ask_user suspend + sibling cancel, and the insert-failure
// turn-kill.
//
// Harness shape modeled on recipe_record_tools.test.ts's
// stubbed-adminClient (per-table FIFO response queues + call
// recorder), extended with: minted row ids for .single() inserts,
// side-effect hooks fired when a queued response is consumed (the
// abort+throw co-timing needs the cancel to fire mid-persist), and
// fake realtime channels (join resolves instantly, sends are
// recorded - the END/tool_call_response assertions read that log).

import { assert, assertEquals, assertStringIncludes } from '@std/assert';
import type { SupabaseClient } from '@supabase/supabase-js';
import type {
  CompletionEvent,
  StreamEvent,
  StreamSignal,
  ToolCallRequest,
} from '../_shared/venice-stream.ts';
import {
  getStreamingResponse,
  DEFERRED_TOOL_MESSAGE,
  MAX_ROUNDS,
} from '../venice/getStreamingResponse.ts';
import { registerTool } from '../venice/performToolCall.ts';
import { MAX_EMPTY_COMPLETION_REROLLS } from '../venice/stream-guards.ts';

type RoundScript = (args: {
  signal: AbortSignal;
  body: Record<string, unknown>;
}) => AsyncGenerator<CompletionEvent | StreamSignal>;

// --- fake tools --------------------------------------------------------

// The registry is module-scoped and this test graph never imports the
// tools/index.ts barrel, so these names are the only registrations.
const echoCalls: Array<{ request: ToolCallRequest; round: number }> = [];
let echoRound = 0;
registerTool({
  name: 'qa_echo',
  execute(args) {
    echoCalls.push({ request: { id: '', name: 'qa_echo', args }, round: echoRound });
    return Promise.resolve({ echo: args });
  },
});

const slowCalls: string[] = [];
registerTool({
  name: 'qa_slow',
  execute() {
    slowCalls.push('start');
    return new Promise((resolve) => setTimeout(() => {
      slowCalls.push('done');
      resolve({ slow: true });
    }, 300));
  },
});

// The test sets this to a cancel-firing callback; the tool fires it
// mid-dispatch to simulate the user clicking Stop while tools are in
// flight (the browser sends the control-channel cancel; the
// orchestrator's abort fires inside the dispatch window).
let midflightCancel: (() => void) | null = null;
registerTool({
  name: 'qa_cancel_midflight',
  execute() {
    midflightCancel?.();
    return new Promise((resolve) => setTimeout(() => resolve({ done: true }), 50));
  },
});

registerTool({
  name: 'qa_ask',
  execute() {
    // Mirrors the real ask_user tool's pending sentinel - the
    // orchestrator's isAskUserPending checks this exact flag.
    return Promise.resolve({
      __ask_user_pending__: true,
      question: 'which one?',
    });
  },
});

// --- stub harness ------------------------------------------------------

interface QueueEntry {
  data?: unknown;
  error?: { message: string } | null;
  /** Fired when this queued response is handed out. */
  onConsume?: () => void;
}

interface RecordedQuery {
  table: string;
  calls: Array<{ method: string; args: unknown[] }>;
}

interface Env {
  opts: Parameters<typeof getStreamingResponse>[0];
  queries: RecordedQuery[];
  rpcCalls: Array<{ name: string; args: Record<string, unknown> }>;
  published: StreamEvent[];
  mintedIds: string[];
  fireCancel: () => void;
  deleteCalls: Array<string[]>;
}

interface EnvOpts {
  // `undefined` entries hand out the default response (minted id for
  // messages inserts, empty data otherwise) - the skip-one shape.
  rows?: Record<string, Array<QueueEntry | undefined>>;
  // Scripted RPC responses, keyed by rpc name (FIFO per name). The
  // turn calls other rpcs (bias_clear_thread, move_message_to_tail)
  // that must not consume the commit script.
  rpc?: Record<string, Array<{ data?: unknown; error?: { message: string } | null }>>;
  supersededIds?: readonly string[];
  wallDeadlineMs?: number;
  rounds: Array<
    (args: { signal: AbortSignal; body: Record<string, unknown> }) => AsyncGenerator<CompletionEvent | StreamSignal>
  >;
}

function makeEnv(envOpts: EnvOpts): Env {
  const queries: RecordedQuery[] = [];
  const rpcCalls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const published: StreamEvent[] = [];
  const mintedIds: string[] = [];
  const deleteCalls: Array<string[]> = [];
  const cancelHandlers: Array<() => void> = [];
  const tableCounters: Record<string, number> = {};
  const rpcCounters: Record<string, number> = {};
  let rowCounter = 0;

  const builderMethods = [
    'eq', 'neq', 'lt', 'lte', 'gte', 'ilike', 'contains', 'order', 'limit',
    'select', 'single', 'maybeSingle', 'insert', 'update', 'delete', 'in',
  ];

  const adminClient = {
    from: (table: string) => {
      const rec: RecordedQuery = { table, calls: [] };
      queries.push(rec);
      let sawSingle = false;
      const c: Record<string, unknown> = {};
      for (const m of builderMethods) {
        c[m] = (...a: unknown[]) => {
          if (m === 'single') sawSingle = true;
          rec.calls.push({ method: m, args: a });
          return c;
        };
      }
      (c as { then: unknown }).then = (
        resolve: (v: unknown) => unknown,
      ) => {
        const responses = envOpts.rows?.[table] ?? [];
        const queued = responses[Math.min(tableCounters[table] ?? 0, responses.length - 1)];
        tableCounters[table] = (tableCounters[table] ?? 0) + 1;
        const entry = queued as QueueEntry | undefined;
        let res: { data: unknown; error: { message: string } | null };
        if (entry) {
          entry.onConsume?.();
          res = { data: entry.data, error: entry.error ?? null };
        } else if (table === 'messages' && sawSingle) {
          // Mint a row id for every uns-scripted insert - the ids the
          // orchestrator tracks in runRowIds.
          const id = `row-${++rowCounter}`;
          mintedIds.push(id);
          res = { data: { id }, error: null };
        } else {
          res = { data: [], error: null };
        }
        return Promise.resolve(res).then(resolve);
      };
      return c;
    },
    rpc: (name: string, args: Record<string, unknown>) => {
      rpcCalls.push({ name, args });
      const queue = envOpts.rpc?.[name];
      const idx = rpcCounters[name] ?? 0;
      rpcCounters[name] = idx + 1;
      const scripted = queue?.[Math.min(idx, queue.length - 1)] ?? { data: null, error: null };
      return Promise.resolve(scripted);
    },
    channel: (name: string) => {
      const ch: Record<string, unknown> = {
        name,
        on: (_type: string, opts: { event?: string }, handler: () => void) => {
          if (opts?.event === 'cancel') cancelHandlers.push(handler);
          return ch;
        },
        subscribe: (cb: (status: string) => void) => {
          cb('SUBSCRIBED');
          return ch;
        },
        unsubscribe: () => Promise.resolve('ok'),
        send: (msg: { payload: StreamEvent }) => {
          published.push(msg.payload);
          return Promise.resolve('ok');
        },
      };
      return ch;
    },
  } as unknown as SupabaseClient;

  let round = 0;
  const complete = async function* (
    args: { signal: AbortSignal; body: Record<string, unknown> },
  ): AsyncGenerator<CompletionEvent | StreamSignal> {
    const script = envOpts.rounds[round++];
    if (!script) throw new Error(`unexpected round ${round} - script ran out`);
    yield* script(args);
  };

  return {
    opts: {
      apiKey: 'qa-key',
      threadId: 'thread-qa',
      userMessageId: 'user-qa',
      userId: 'user-qa-owner',
      ...(envOpts.supersededIds !== undefined ? { supersededIds: envOpts.supersededIds } : {}),
      bodyTemplate: {
        model: 'qa-model',
        messages: [{ role: 'user', content: 'qa prompt' }],
      },
      adminClient,
      wallDeadlineMs: envOpts.wallDeadlineMs ?? 5_000,
      heartbeatIntervalMs: 60_000,
      complete,
    } as Parameters<typeof getStreamingResponse>[0],
    queries,
    rpcCalls,
    published,
    mintedIds,
    fireCancel: () => {
      for (const h of cancelHandlers) h();
    },
    deleteCalls,
  };
}

// Recording helper for the rollback delete: the env's rows script for
// `messages` can't intercept .in() args, so wrap via a proxy - simpler
// to just read the recorded queries after the run.
function callsOf(env: Env, table: string, method: string): unknown[][] {
  return env.queries
    .filter((q) => q.table === table)
    .flatMap((q) => q.calls.filter((c) => c.method === method).map((c) => c.args));
}

function endEvent(env: Env): StreamEvent & { type: 'END' } {
  const end = env.published.find((e) => e.type === 'END');
  assert(end, 'END event was never published');
  return end as StreamEvent & { type: 'END' };
}

function toolResponses(env: Env): Array<StreamEvent & { type: 'tool_call_response' }> {
  return env.published.filter(
    (e): e is StreamEvent & { type: 'tool_call_response' } =>
      e.type === 'tool_call_response',
  );
}

function toolRowInserts(env: Env): Array<Record<string, unknown>> {
  return callsOf(env, 'messages', 'insert')
    .map((a) => a[0] as Record<string, unknown>)
    .filter((row) => row.role === 'tool');
}

function commitRpcs(env: Env): Array<{ name: string; args: Record<string, unknown> }> {
  return env.rpcCalls.filter((c) => c.name === 'commit_assistant_message');
}

// --- event helpers -----------------------------------------------------

function one(ev: CompletionEvent | StreamSignal): AsyncGenerator<CompletionEvent | StreamSignal> {
  return (async function* () {
    yield ev;
  })();
}

const request = (id: string, name: string, args: Record<string, unknown> = {}): CompletionEvent => ({
  type: 'tool_call_request',
  request: { id, name, args },
});

const text = (content: string): CompletionEvent => ({ type: 'response_text', content });

// --- tests -------------------------------------------------------------

Deno.test('graceful wall timeout during dispatch persists every settled result row and lands the wall_timeout terminal', async () => {
  slowCalls.length = 0;
  const env = makeEnv({
    wallDeadlineMs: 80, // fires while qa_slow's 300ms sleep is in flight
    rounds: [
      async function* () {
        yield request('t1', 'qa_slow');
        yield { type: 'usage', usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 } };
        yield { type: 'DONE', finishReason: 'tool_calls' };
      },
    ],
  });
  await getStreamingResponse(env.opts);

  // The tool ran exactly once - the abort must not double-dispatch.
  assertEquals(slowCalls, ['start', 'done']);
  // Its result row persisted despite the timeout striking mid-flight.
  const inserts = toolRowInserts(env);
  assertEquals(inserts.length, 1);
  assertStringIncludes(String(inserts[0].content), '"slow":true');
  // Terminal: error with the wall-timeout detail - not a user cancel.
  const end = endEvent(env);
  assertEquals(end.terminalKind, 'error');
  // last_error written (the browser's error card source), and the
  // commit RPC never ran.
  const lastError = callsOf(env, 'threads', 'update')
    .map((a) => a[0] as Record<string, unknown>)
    .filter((u) => u.last_error !== undefined);
  assertEquals(lastError.length, 1);
  assertEquals(commitRpcs(env).length, 0);
});

Deno.test('deferred drain: 12-call round dispatches 10, defers 2, re-issue completes the batch', async () => {
  echoCalls.length = 0;
  const ids = Array.from({ length: 12 }, (_, i) => `call-${i}`);
  let round2Fired = false;
  const env = makeEnv({
    rounds: [
      // Round 0: the model emits all 12 in one batch.
      async function* () {
        echoRound = 0;
        for (const id of ids) yield request(id, 'qa_echo', { id });
        yield { type: 'DONE', finishReason: 'tool_calls' };
      },
      // Round 1: the model re-issues the two deferred ids.
      async function* () {
        echoRound = 1;
        yield request('call-10', 'qa_echo', { id: 10 });
        yield request('call-11', 'qa_echo', { id: 11 });
        yield { type: 'DONE', finishReason: 'tool_calls' };
      },
      // Round 2: terminal text.
      async function* () {
        round2Fired = true;
        yield text('all twelve gone');
        yield { type: 'DONE', finishReason: 'stop' };
      },
    ],
  });
  await getStreamingResponse(env.opts);

  assert(round2Fired, 'the drain never reached the terminal round');
  // Round 0 executed exactly 10; round 1 the 2 re-issues.
  assertEquals(echoCalls.filter((c) => c.round === 0).length, 10);
  assertEquals(echoCalls.filter((c) => c.round === 1).length, 2);
  // 14 tool rows: 10 ok + 2 deferred (round 0) + 2 ok (round 1).
  const inserts = toolRowInserts(env);
  assertEquals(inserts.length, 14);
  const deferred = inserts.filter((r) => String(r.content).includes('Not executed'));
  assertEquals(deferred.length, 2);
  for (const d of deferred) {
    assertStringIncludes(String(d.content), 'Re-issue this call');
  }
  // Every one of the 14 calls got a tool_call_response event.
  assertEquals(toolResponses(env).length, 14);
  // The round rows carry the full 12- and 2-call lists (wire fan-in
  // stays valid even with deferrals).
  const roundRows = callsOf(env, 'messages', 'insert')
    .map((a) => a[0] as Record<string, unknown>)
    .filter((r) => r.role === 'assistant' && Array.isArray(r.tool_calls));
  assertEquals(roundRows.length, 2);
  assertEquals((roundRows[0].tool_calls as unknown[]).length, 12);
  assertEquals((roundRows[1].tool_calls as unknown[]).length, 2);
  // Terminal: completed via the commit RPC.
  assertEquals(endEvent(env).terminalKind, 'completed');
  assertEquals(commitRpcs(env).length, 1);
});

Deno.test('ask_user suspend: first pending carries the sentinel, sibling is pre-cancelled, placeholder deleted', async () => {
  const env = makeEnv({
    rounds: [
      async function* () {
        yield text('let me ask before continuing');
        yield request('ask-1', 'qa_ask');
        yield request('ask-2', 'qa_ask');
        yield { type: 'DONE', finishReason: 'tool_calls' };
      },
    ],
  });
  await getStreamingResponse(env.opts);

  const inserts = toolRowInserts(env);
  assertEquals(inserts.length, 2);
  assertStringIncludes(String(inserts[0].content), '__ask_user_pending__');
  const sibling = JSON.parse(String(inserts[1].content)) as Record<string, unknown>;
  assertEquals(sibling.__ask_user_answered__, true);
  assertEquals(sibling.via, 'cancelled_by_sibling_ask_user');
  // The streaming placeholder (born on the preamble text) was deleted
  // on suspend; the terminal is the suspend kind.
  const del = callsOf(env, 'messages', 'delete');
  assertEquals(del.length, 1);
  assertEquals(endEvent(env).terminalKind, 'suspended_for_ask_user');
  // The commit RPC never runs on suspend.
  assertEquals(commitRpcs(env).length, 0);
});

Deno.test('catch guard: an abort co-timed with a round-row insert failure lands aborted, not completed', async () => {
  // The round-row insert fires the user cancel (so the signal is
  // aborted before the throw) and then errors - the throw reaches the
  // orchestrator's catch with NO inline abort-check site having seen
  // the abort. terminalKind must not survive as 'completed'.
  const env = makeEnv({
    rounds: [
      async function* () {
        yield request('t1', 'qa_echo');
        yield { type: 'DONE', finishReason: 'tool_calls' };
      },
    ],
    rows: {
      messages: [
        {
          data: null,
          error: { message: 'scripted round-row failure' },
          onConsume: () => env.fireCancel(),
        },
        // The finally's marker-row insert (best-effort) gets the
        // default minted response - without this slot the queue would
        // repeat the error entry above.
        undefined,
      ],
    },
  });
  await getStreamingResponse(env.opts);

  const end = endEvent(env);
  assertEquals(end.terminalKind, 'aborted');
  // The marker-only aborted row was persisted (ensureAssistantRow in
  // the finally), carrying the interrupted marker - not a committed
  // 'complete'.
  const finalUpdate = callsOf(env, 'messages', 'update')
    .map((a) => a[0] as Record<string, unknown>)
    .filter((u) => u.status === 'aborted');
  assertEquals(finalUpdate.length, 1);
  assertStringIncludes(String(finalUpdate[0].content), 'user interrupted response');
  assertEquals(commitRpcs(env).length, 0);
});

Deno.test('aborted regenerate rolls back every row the run inserted, including per-call tool rows', async () => {
  const env = makeEnv({
    supersededIds: ['old-1', 'old-2'],
    rounds: [
      // Round 0: two dispatched tool calls -> two per-call rows.
      async function* () {
        yield request('t1', 'qa_echo', { n: 1 });
        yield request('t2', 'qa_echo', { n: 2 });
        yield { type: 'DONE', finishReason: 'tool_calls' };
      },
      // Round 1: the user clicks Stop mid-stream.
      async function* ({ }) {
        yield text('writing the final answer');
        env.fireCancel();
        yield text(' more text after the cancel');
        yield { type: 'DONE', finishReason: 'stop' };
      },
    ],
  });
  await getStreamingResponse(env.opts);

  assertEquals(endEvent(env).terminalKind, 'aborted');
  // The rollback's bulk delete covers: the round-0 assistant row, the
  // two per-call tool rows, and the streaming row (born on round 1's
  // text). Round 1's round row never persisted - the post-stream
  // abort check breaks BEFORE persistRoundAssistantRow runs - so four
  // ids is the complete set. Missing ids would strand orphan rows
  // below the restored originals. The id list rides the .in('id',
  // ids) builder call.
  const inArgs = callsOf(env, 'messages', 'in').map((a) => a as unknown[]).find((a) => a[0] === 'id');
  assert(inArgs, 'no rollback delete ran');
  const deletedIds = new Set(inArgs[1] as string[]);
  assertEquals(deletedIds.size, 4);
  assertEquals(
    [...deletedIds].every((id) => id.startsWith('row-')),
    true,
  );
  // The commit RPC never runs on the rollback path.
  assertEquals(commitRpcs(env).length, 0);
});

Deno.test('tool-result insert failure fails the turn instead of leaving a fan-in hole', async () => {
  let round1Fired = false;
  const env = makeEnv({
    rounds: [
      async function* () {
        yield request('t1', 'qa_echo');
        yield { type: 'DONE', finishReason: 'tool_calls' };
      },
      async function* () {
        round1Fired = true;
        yield text('never reached');
        yield { type: 'DONE', finishReason: 'stop' };
      },
    ],
    rows: {
      // The round row inserts fine (minted); the tool-result insert
      // fails. The next round must not run on a broken fan-in.
      messages: [undefined, { data: null, error: { message: 'scripted row failure' } }],
    },
  });
  await getStreamingResponse(env.opts);

  assertEquals(round1Fired, false, 'the next round ran despite the broken fan-in');
  assertEquals(endEvent(env).terminalKind, 'error');
  const lastError = callsOf(env, 'threads', 'update')
    .map((a) => a[0] as Record<string, unknown>)
    .filter((u) => u.last_error !== undefined);
  assertEquals(lastError.length, 1);
  assertEquals(commitRpcs(env).length, 0);
});

Deno.test('commit conflict (newer user message) flips the terminal to error and writes last_error', async () => {
  const env = makeEnv({
    rounds: [
      async function* () {
        yield text('the reply that lost the race');
        yield { type: 'DONE', finishReason: 'stop' };
      },
    ],
    rpc: {
      commit_assistant_message: [{ data: { conflict: true, reason: 'newer_user_message' }, error: null }],
    },
  });
  await getStreamingResponse(env.opts);

  const end = endEvent(env);
  assertEquals(end.terminalKind, 'error');
  assertEquals((end as unknown as { conflict?: string }).conflict, 'newer_user_message');
  // The losing row was transitioned to 'error' (not left 'streaming').
  const errUpdate = callsOf(env, 'messages', 'update')
    .map((a) => a[0] as Record<string, unknown>)
    .filter((u) => u.status === 'error');
  assertEquals(errUpdate.length, 1);
  const lastError = callsOf(env, 'threads', 'update')
    .map((a) => a[0] as Record<string, unknown>)
    .filter((u) => u.last_error !== undefined);
  assertEquals(lastError.length, 1);
  // The translator writes the kind + humane prose; the raw conflict
  // reason rides the END event, not the error payload.
  assertStringIncludes(
    JSON.stringify(lastError[0].last_error),
    'commit_conflict',
  );
});

Deno.test('user cancel during dispatch: tools keep running server-side, rows persist, terminal is aborted with the marker', async () => {  // Stop only kills the browser's view - the server-side dispatch
  // finishes and its rows land. The round after sees the abort at the
  // top-of-round check.
  let round1Fired = false;
  const env = makeEnv({
    rounds: [
      async function* () {
        yield text('starting the batch');
        yield request('t1', 'qa_cancel_midflight');
        yield { type: 'DONE', finishReason: 'tool_calls' };
      },
      async function* () {
        round1Fired = true;
        yield text('should not get here');
        yield { type: 'DONE', finishReason: 'stop' };
      },
    ],
  });
  midflightCancel = env.fireCancel;
  try {
    await getStreamingResponse(env.opts);
  } finally {
    midflightCancel = null;
  }

  // The cancelled turn never advances to the next round.
  assertEquals(round1Fired, false);
  // The mid-flight tool's result row STILL persisted - the
  // server-side dispatch runs to completion through a stop.
  const inserts = toolRowInserts(env);
  assertEquals(inserts.length, 1);
  assertStringIncludes(String(inserts[0].content), '"done":true');
  // Terminal: aborted. The aborted row is marker-only by design - the
  // round's text was archived onto the round row at the boundary, and
  // the accumulator was reset there (the marker must not append after
  // a text that already lives elsewhere).
  assertEquals(endEvent(env).terminalKind, 'aborted');
  const abortedUpdate = callsOf(env, 'messages', 'update')
    .map((a) => a[0] as Record<string, unknown>)
    .filter((u) => u.status === 'aborted');
  assertEquals(abortedUpdate.length, 1);
  assertStringIncludes(String(abortedUpdate[0].content), 'user interrupted response');
});

// --- more negative paths the harness unlocked ---------------------------

Deno.test('empty-completion reroll bumps the temperature per attempt, then fails with the guard-exhausted terminal', async () => {
  const bodies: Array<Record<string, unknown>> = [];
  let round = 0;
  const env = makeEnv({
    rounds: [
      ...Array.from(
        { length: MAX_EMPTY_COMPLETION_REROLLS + 1 },
        (): RoundScript =>
          async function* ({ body }: { signal: AbortSignal; body: Record<string, unknown> }) {
            bodies.push(body);
            void round;
            yield { type: 'DONE', finishReason: 'stop' };
          },
      ),
    ],
  });
  await getStreamingResponse(env.opts);

  // Rerolls: the first attempt + MAX_EMPTY_COMPLETION_REROLLS re-rolls.
  assertEquals(bodies.length, MAX_EMPTY_COMPLETION_REROLLS + 1);
  // Each re-roll bumps the temperature above the prior round's - the
  // salvage-mode ladder (stream-guards.ts retryTemperatureBody).
  const temps = bodies.map((b) => (b.temperature as number | undefined) ?? 0);
  for (let i = 1; i < temps.length; i++) {
    assert(temps[i] > (temps[i - 1] || 0), `temperature did not bump at reroll ${i}`);
  }
  // Past the budget the turn fails with the guard_exhausted kind so
  // the browser renders the retry-exhausted card (not a generic
  // internal error).
  assertEquals(endEvent(env).terminalKind, 'error');
  const lastError = callsOf(env, 'threads', 'update')
    .map((a) => a[0] as Record<string, unknown>)
    .filter((u) => u.last_error !== undefined);
  assertEquals(lastError.length, 1);
  assertStringIncludes(JSON.stringify(lastError[0].last_error), 'guard_exhausted');
});

Deno.test('cancel during round 0 with no tools: partial preserved under the marker, nothing to roll back', async () => {
  const env = makeEnv({
    rounds: [
      async function* () {
        // The cancel fires while round 0 is still streaming. Events
        // already yielded still process - the partial text is kept -
        // and the post-stream abort check ends the turn.
        env.fireCancel();
        yield text('never lands');
        yield { type: 'DONE', finishReason: 'stop' };
      },
    ],
  });
  await getStreamingResponse(env.opts);

  const end = endEvent(env);
  assertEquals(end.terminalKind, 'aborted');
  // An aborted terminal ALWAYS creates its marker row (the
  // deliberate-stop record other devices read); a plain send has no
  // supersededIds, so there is nothing to roll back and no delete
  // fires.
  assertEquals(env.mintedIds.length, 1);
  assertEquals(env.mintedIds[0], 'row-1');
  const del = callsOf(env, 'messages', 'delete');
  assertEquals(del.length, 0);
  const markerUpdate = callsOf(env, 'messages', 'update')
    .map((a) => a[0] as Record<string, unknown>)
    .filter((u) => u.status === 'aborted');
  assertEquals(markerUpdate.length, 1);
  assertStringIncludes(String(markerUpdate[0].content), 'never lands');
  assertStringIncludes(String(markerUpdate[0].content), 'user interrupted response');
});

Deno.test('MAX_ROUNDS runaway: every round calls tools, terminal is the round-limit error', async () => {
  let count = 0;
  const toolRound = (): RoundScript =>
    async function* () {
      count++;
      yield request(`t-${count}`, 'qa_echo', { n: count });
      yield { type: 'DONE', finishReason: 'tool_calls' };
    };
  const env = makeEnv({
    rounds: Array.from({ length: MAX_ROUNDS }, () => toolRound()),
  });
  await getStreamingResponse(env.opts);

  // Every round ran; the turn ended in the round-limit terminal (not
  // a silent empty commit).
  assertEquals(count, MAX_ROUNDS);
  const end = endEvent(env);
  assertEquals(end.terminalKind, 'error');
  assertEquals((end as unknown as { conflict?: string }).conflict, 'round_limit');
  assertEquals(commitRpcs(env).length, 0);
  const lastError = callsOf(env, 'threads', 'update')
    .map((a) => a[0] as Record<string, unknown>)
    .filter((u) => u.last_error !== undefined);
  assertEquals(lastError.length, 1);
});
