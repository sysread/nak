// Characterization + guard tests for the wiki article sweep's and the
// manual retry's self-report verification: the done branches compare a
// count of the user's wiki_changelog rows before and after the run,
// and annotate the stored reasoning when the agent CLAIMS an article
// edit but the count did not move (the false-success shape shared with
// the extraction sweep's fix). Ports the shipped
// wiki_records_sweep.test.ts harness.
//
// Stub-admin pattern (wiki_records_sweep.test.ts / orchestrator.test.ts):
// RPC responses scripted by name, per-table FIFO row queues, and an
// injected `complete` that scripts one terminal text round - no
// network, no real Venice.

import { assertEquals } from '@std/assert';
import type { SupabaseClient } from '@supabase/supabase-js';
import { retryWikiThread, runWikiSweepTick, __test } from '../venice/agents/wiki.ts';

const THREAD_ID = 't-1';
const USER_ID = 'u-1';
const TERMINAL_MSG_ID = 'm-2';

interface QueueEntry {
  data?: unknown;
  error?: { message: string } | null;
  count?: number;
}

interface Harness {
  summary?: Awaited<ReturnType<typeof runWikiSweepTick>>;
  retryResult?: Awaited<ReturnType<typeof retryWikiThread>>;
  agentLogInserts: Record<string, unknown>[];
  consoleWarns: string[];
  /** Ordering events: 'before-count' / 'run' / 'after-count' / 'log-insert'. */
  events: string[];
}

// Script one sweep tick (or one retry): one claim, a two-message
// transcript, a seeded Venice key, one terminal model round, and FIFO
// queues for the tables the run reads. `changelogCounts` scripts the
// before/after head-counts IN ORDER; an entry with an error simulates
// a count failure (verification is skipped, the run proceeds). The
// console.warn spy lives only for the duration of the run.
async function makeEnv(opts: {
  finalText: string;
  changelogCounts: QueueEntry[];
  mode: 'sweep' | 'retry';
}): Promise<Harness> {
  const queues: Record<string, QueueEntry[]> = {
    wiki_changelog: [...opts.changelogCounts],
    app_config: [{ data: { venice_api_key: 'qa-key' }, error: null }],
    message_attachments: [{ data: [], error: null }],
    profiles: [{ data: [], error: null }],
  };
  const counters: Record<string, number> = {};
  let claimCalls = 0;
  const agentLogInserts: Record<string, unknown>[] = [];
  const consoleWarns: string[] = [];
  // Ordering ledger: the two wiki_changelog head-counts and the
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
        if (table === 'wiki_changelog') {
          // A head-count consume; label it by position relative to the
          // run (the 'run' event).
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
      // thread_transcript chains .select() postgrest-style; every rpc
      // returns a thenable builder that resolves to the scripted
      // response.
      let selectArgs: unknown[] = [];
      const builder: Record<string, unknown> = {
        select: (...a: unknown[]) => {
          selectArgs = a;
          return builder;
        },
      };
      (builder as { then: unknown }).then = (resolve: (v: unknown) => unknown) => {
        if (name === 'claim_next_thread_for_wiki') {
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
        if (name === 'mark_thread_wiki_processed_if_claimed') {
          return Promise.resolve({ data: true, error: null }).then(resolve);
        }
        if (name === 'claim_wiki_thread_for_retry') {
          return Promise.resolve({ data: true, error: null }).then(resolve);
        }
        if (name === 'compute_wiki_terminal_msg_id') {
          return Promise.resolve({ data: TERMINAL_MSG_ID, error: null }).then(resolve);
        }
        if (name === 'manual_advance_wiki_pointer') {
          return Promise.resolve({ data: true, error: null }).then(resolve);
        }
        if (name === 'release_wiki_thread_retry_claim') {
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
                content: 'We picked a new logo for Nak after the March brainstorm.',
                tool_calls: null,
                tool_call_id: null,
                name: null,
              },
              {
                id: TERMINAL_MSG_ID,
                thread_id: THREAD_ID,
                role: 'assistant',
                content: 'The logo decision is in - updating the wiki makes sense.',
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
    if (opts.mode === 'sweep') {
      const summary = await runWikiSweepTick(adminClient, { complete });
      return { summary, agentLogInserts, consoleWarns, events };
    }
    const retryResult = await retryWikiThread(adminClient, USER_ID, THREAD_ID, { complete });
    return { retryResult, agentLogInserts, consoleWarns, events };
  } finally {
    console.warn = originalWarn;
  }
}

const CLAIM = 'Updated the Nak article with March 2026 logo-brainstorm details.';

Deno.test('honest success: article edited + claim -> reasoning stored unannotated', async () => {
  const h = await makeEnv({
    finalText: CLAIM,
    changelogCounts: [{ data: null, error: null, count: 5 }, { data: null, error: null, count: 6 }],
    mode: 'sweep',
  });
  assertEquals(h.summary!.claimed, 1);
  assertEquals(h.summary!.processed, 1);
  assertEquals(h.agentLogInserts.length, 1);
  assertEquals(h.agentLogInserts[0].reasoning, CLAIM);
  // Ordering contract: the before-count precedes the run, the
  // after-count follows it, and both precede the audit insert - the
  // before/after comparison can never silently swap its two queue
  // entries.
  assertEquals(h.events, ['before-count', 'run', 'after-count', 'log-insert']);
});

Deno.test('honest no-op: unmoved count + no-claim reasoning -> stored unannotated', async () => {
  const h = await makeEnv({
    finalText: 'No edits - the conversation was generic technical Q&A about regex.',
    changelogCounts: [{ data: null, error: null, count: 5 }, { data: null, error: null, count: 5 }],
    mode: 'sweep',
  });
  assertEquals(h.summary!.processed, 1);
  assertEquals(h.agentLogInserts.length, 1);
  assertEquals(
    h.agentLogInserts[0].reasoning,
    'No edits - the conversation was generic technical Q&A about regex.',
  );
});

Deno.test('false claim: unmoved count + claim reasoning -> warn + annotation stored', async () => {
  const h = await makeEnv({
    finalText: CLAIM,
    changelogCounts: [{ data: null, error: null, count: 5 }, { data: null, error: null, count: 5 }],
    mode: 'sweep',
  });
  assertEquals(h.summary!.processed, 1);
  assertEquals(h.agentLogInserts.length, 1);
  const reasoning = String(h.agentLogInserts[0].reasoning);
  assertEquals(
    reasoning.includes(
      '[unverified self-report: claimed an edit, but wiki_changelog rows for this user went from 5 to 5]',
    ),
    true,
    `annotation missing from: ${reasoning}`,
  );
  assertEquals(h.consoleWarns.length > 0, true, 'expected a warn line');
});

Deno.test('retry false claim: annotation carried on the result the Skipped panel renders', async () => {
  const h = await makeEnv({
    finalText: CLAIM,
    changelogCounts: [{ data: null, error: null, count: 5 }, { data: null, error: null, count: 5 }],
    mode: 'retry',
  });
  assertEquals(h.retryResult!.kind, 'ok');
  const result = h.retryResult as { kind: 'ok'; reasoning: string };
  assertEquals(
    result.reasoning.includes('[unverified self-report: claimed an edit,'),
    true,
    `annotation missing from retry result: ${result.reasoning}`,
  );
  assertEquals(h.consoleWarns.length > 0, true, 'expected a warn line');
});

Deno.test('count query failure: run completes normally, no annotation', async () => {
  const h = await makeEnv({
    finalText: CLAIM,
    changelogCounts: [{ data: null, error: { message: 'count boom' } }],
    mode: 'sweep',
  });
  assertEquals(h.summary!.processed, 1);
  assertEquals(h.agentLogInserts.length, 1);
  const reasoning = String(h.agentLogInserts[0].reasoning);
  assertEquals(reasoning.includes('unverified self-report'), false);
});

Deno.test('manual retry honest success: claim + moved count -> unannotated, carried on the result', async () => {
  const h = await makeEnv({
    finalText: CLAIM,
    changelogCounts: [{ data: null, error: null, count: 5 }, { data: null, error: null, count: 6 }],
    mode: 'retry',
  });
  assertEquals(h.retryResult!.kind, 'ok');
  const result = h.retryResult as { kind: 'ok'; reasoning: string };
  assertEquals(result.reasoning, CLAIM);
  assertEquals(h.agentLogInserts.length, 1);
  assertEquals(h.agentLogInserts[0].reasoning, CLAIM);
  assertEquals(h.events, ['before-count', 'run', 'after-count', 'log-insert']);
});

Deno.test('matcher: affirmative edit claims vs honest no-ops and reference-style past tense', () => {
  const claims = __test.claimsArticleEdit;
  // Affirmative claims - the prompt's example summary shapes.
  assertEquals(claims('Updated the Nak article with March details.'), true);
  assertEquals(claims('Created a new article on Sourdough.'), true);
  assertEquals(claims('Deleted the Kermit protocol entry as out-of-scope.'), true);
  // The article agent also writes records; its matcher covers them.
  assertEquals(claims('Added a record about the promotion.'), true);
  // Honest no-ops never match.
  assertEquals(claims('No edits - the conversation was generic technical Q&A.'), false);
  assertEquals(claims('(none)'), false);
  assertEquals(claims('Logged none.'), false);
  // Contracted negations: the n't alternative has NO leading word
  // boundary (none exists inside a contraction) - these must guard.
  assertEquals(claims("I haven't updated any articles."), false);
  assertEquals(claims("didn't save anything"), false);
  // The nothing guard: "saved" + filler + "article" would claim, so
  // the nothing token (not the matcher) is what suppresses this shape.
  assertEquals(claims('Saved nothing and the article stays as is.'), false);
  // Reference-style past tense: an honest no-op summarizing EXISTING
  // work - the verb follows the noun, so no claim.
  assertEquals(claims('The Nak article was updated in March 2026.'), false);
  // Mixed sentence with a negation anywhere: suppressed (miss
  // direction - never punish an honest no-op).
  assertEquals(claims('Updated the Nak article; no other edits.'), false);
  // Known miss shape (accepted, warn-only): passive phrasing with no
  // negation token still claims - the annotation carries both counts
  // so the audit row stays truthful.
  assertEquals(claims('A logo section was added to the Nak article last cycle'), true);
});
