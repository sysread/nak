// Characterization + guard tests for the wiki-records extraction
// sweep's self-report verification: the done branch compares a count
// of wiki_records rows tagged with the thread's
// source_conversation_id before and after the run, and annotates the
// stored reasoning when the agent CLAIMS a record was logged but the
// count did not move (the observed M8 failure: a 2-tool-call run that
// logged nothing yet reported "Logged one record").
//
// Stub-admin pattern (orchestrator.test.ts): RPC responses scripted by
// name, per-table FIFO row queues, and an injected `complete` that
// scripts one terminal text round - no network, no real Venice.

import { assertEquals } from '@std/assert';
import type { SupabaseClient } from '@supabase/supabase-js';
import { runWikiRecordsSweepTick, __test } from '../venice/agents/wiki_records.ts';

const THREAD_ID = 't-1';
const USER_ID = 'u-1';
const TERMINAL_MSG_ID = 'm-2';

interface QueueEntry {
  data?: unknown;
  error?: { message: string } | null;
  count?: number;
}

interface Harness {
  summary: Awaited<ReturnType<typeof runWikiRecordsSweepTick>>;
  agentLogInserts: Record<string, unknown>[];
  consoleWarns: string[];
  /** Ordering events: 'before-count' / 'after-count' / 'log-insert'. */
  events: string[];
}

// Script one sweep tick: one claim, a two-message transcript, a
// seeded Venice key, one terminal model round, and FIFO queues for the
// tables the tick reads. `wikiRecordCounts` scripts the before/after
// head-counts IN ORDER; an entry with an error simulates a count
// failure (verification is skipped, the run proceeds). The
// console.warn spy lives only for the duration of the tick.
async function makeEnv(opts: {
  finalText: string;
  wikiRecordCounts: QueueEntry[];
}): Promise<Harness> {
  const queues: Record<string, QueueEntry[]> = {
    wiki_records: [...opts.wikiRecordCounts],
    app_config: [{ data: { venice_api_key: 'qa-key' }, error: null }],
    message_attachments: [{ data: [], error: null }],
  };
  const counters: Record<string, number> = {};
  let claimCalls = 0;
  const agentLogInserts: Record<string, unknown>[] = [];
  const consoleWarns: string[] = [];
  // Ordering ledger: the two wiki_records head-counts and the
  // wiki_agent_log insert must land in the contract order - the
  // before-count first, both counts before the audit insert. Without
  // this guard the FIFO queues could silently swap before/after.
  const events: string[] = [];

  const builderMethods = [
    'eq', 'order', 'limit', 'select', 'single', 'maybeSingle', 'insert', 'update',
  ];
  const adminClient = {
    from: (table: string) => {
      let insertPayload: unknown = null;
      const c: Record<string, unknown> = {};
      for (const m of builderMethods) {
        c[m] = (...a: unknown[]) => {
          if (m === 'insert') insertPayload = a[0];
          return c;
        };
      }
      (c as { then: unknown }).then = (resolve: (v: unknown) => unknown) => {
        if (table === 'wiki_agent_log' && insertPayload !== null) {
          agentLogInserts.push(insertPayload as Record<string, unknown>);
          events.push('log-insert');
        }
        if (table === 'wiki_records') {
          // A head-count consume; label it by position relative to the
          // extraction run (the 'run' event).
          events.push(events.includes('run') ? 'after-count' : 'before-count');
        }
        const queue = queues[table] ?? [];
        const idx = counters[table] ?? 0;
        counters[table] = idx + 1;
        const entry = queue[Math.min(idx, queue.length - 1)];
        const res = entry
          ? { data: entry.data ?? null, error: entry.error ?? null, count: entry.count }
          : { data: [], error: null, count: undefined };
        return Promise.resolve(res).then(resolve);
      };
      return c;
    },
    rpc: (name: string) => {
      // Some rpc calls (thread_transcript) chain .select() postgrest-
      // style; every rpc returns a thenable builder that resolves to
      // the scripted response.
      let selectArgs: unknown[] = [];
      const builder: Record<string, unknown> = {
        select: (...a: unknown[]) => {
          selectArgs = a;
          return builder;
        },
      };
      (builder as { then: unknown }).then = (resolve: (v: unknown) => unknown) => {
        if (name === 'claim_next_thread_for_wiki_records') {
          // FIFO: one claim then the queue is empty - the tick's
          // maxThreads loop must drain after the first claim.
          const claimed = claimCalls++ === 0;
          return Promise.resolve({
            data: claimed ? [{
              thread_id: THREAD_ID,
              user_id: USER_ID,
              terminal_msg_id: TERMINAL_MSG_ID,
              title: 'QA sweep thread',
            }] : [],
            error: null,
          }).then(resolve);
        }
        if (name === 'mark_thread_wiki_record_processed_if_claimed') {
          return Promise.resolve({ data: true, error: null }).then(resolve);
        }
        if (name === 'thread_transcript') {
          void selectArgs;
          return Promise.resolve({
            data: [
              {
                id: 'm-1',
                thread_id: THREAD_ID,
                role: 'user',
                content: 'I baked my first loaf today and hit a 5K PR.',
                tool_calls: null,
                tool_call_id: null,
                name: null,
              },
              {
                id: TERMINAL_MSG_ID,
                thread_id: THREAD_ID,
                role: 'assistant',
                content: 'Great day - the loaf and the run both landed.',
                tool_calls: null,
                tool_call_id: null,
                name: null,
              },
            ],
            error: null,
          }).then(resolve);
        }
        return Promise.resolve({ data: null, error: null }).then(resolve);
      };
      return builder;
    },
  } as unknown as SupabaseClient;

  const originalWarn = console.warn;
  console.warn = (...args: unknown[]) => {
    consoleWarns.push(args.map(String).join(' '));
  };
  const complete = async () => {
    events.push('run');
    return {
      text: opts.finalText,
      reasoning: '',
      citations: [],
      finishReason: 'stop',
      usage: null,
      toolCalls: [],
    };
  };
  try {
    const summary = await runWikiRecordsSweepTick(adminClient, { complete });
    return { summary, agentLogInserts, consoleWarns, events };
  } finally {
    console.warn = originalWarn;
  }
}

Deno.test('honest success: record created + claim -> reasoning stored unannotated', async () => {
  const h = await makeEnv({
    finalText: 'Logged one record on Sourdough.',
    wikiRecordCounts: [{ data: null, error: null, count: 0 }, { data: null, error: null, count: 1 }],
  });
  assertEquals(h.summary.claimed, 1);
  assertEquals(h.summary.processed, 1);
  assertEquals(h.agentLogInserts.length, 1);
  assertEquals(h.agentLogInserts[0].reasoning, 'Logged one record on Sourdough.');
  // Ordering contract: the before-count precedes the run, the
  // after-count follows it, and both precede the audit insert - the
  // before/after comparison can never silently swap its two queue
  // entries.
  assertEquals(h.events, ['before-count', 'run', 'after-count', 'log-insert']);
});

Deno.test('honest no-op: zero records + no-claim reasoning -> stored unannotated', async () => {
  const h = await makeEnv({
    finalText: 'No record-worthy events found.',
    wikiRecordCounts: [{ data: null, error: null, count: 0 }, { data: null, error: null, count: 0 }],
  });
  assertEquals(h.summary.processed, 1);
  assertEquals(h.agentLogInserts.length, 1);
  assertEquals(h.agentLogInserts[0].reasoning, 'No record-worthy events found.');
});

Deno.test('false claim: zero records + claim reasoning -> warn + annotation stored', async () => {
  const h = await makeEnv({
    finalText: 'Logged one record on Sourdough.',
    wikiRecordCounts: [{ data: null, error: null, count: 0 }, { data: null, error: null, count: 0 }],
  });
  assertEquals(h.summary.processed, 1);
  assertEquals(h.agentLogInserts.length, 1);
  const reasoning = String(h.agentLogInserts[0].reasoning);
  assertEquals(
    reasoning.includes(
      '[unverified self-report: claimed record creation, but wiki_records rows for this thread went from 0 to 0]',
    ),
    true,
    `annotation missing from: ${reasoning}`,
  );
  assertEquals(h.consoleWarns.length > 0, true, 'expected a warn line');
});

Deno.test('count query failure: run completes normally, no annotation', async () => {
  const h = await makeEnv({
    finalText: 'Logged one record on Sourdough.',
    wikiRecordCounts: [{ data: null, error: { message: 'count boom' } }],
  });
  assertEquals(h.summary.processed, 1);
  assertEquals(h.agentLogInserts.length, 1);
  const reasoning = String(h.agentLogInserts[0].reasoning);
  assertEquals(reasoning.includes('unverified self-report'), false);
});

Deno.test('matcher: affirmative claims vs honest no-ops and reference-style past tense', () => {
  const claims = __test.claimsRecordCreation;
  // Affirmative claims.
  assertEquals(claims('Logged one record on Sourdough.'), true);
  assertEquals(claims('I logged a record for the bake.'), true);
  assertEquals(claims('Added a record about the promotion.'), true);
  // Honest no-ops never match.
  assertEquals(claims('Logged none.'), false);
  assertEquals(claims('No record-worthy events found.'), false);
  assertEquals(claims('(none)'), false);
  // Contracted negations: the n't alternative has NO leading word
  // boundary (none exists inside a contraction) - these must guard.
  assertEquals(claims("I haven't created any records."), false);
  assertEquals(claims("didn't log anything"), false);
  // Reference-style past tense: an honest no-op summarizing EXISTING
  // records - the verb follows the noun, so no claim.
  assertEquals(claims('One record on Sourdough was logged last week.'), false);
  // Mixed sentence with a negation anywhere: suppressed (miss
  // direction - never punish an honest no-op).
  assertEquals(claims('Logged one record; no links added.'), false);
  // Known miss shape (accepted, warn-only): passive phrasing with no
  // negation token still claims - the annotation carries both counts
  // so the audit row stays truthful.
  assertEquals(claims("The event was already added as a record by yesterday's conversation"), true);
});
