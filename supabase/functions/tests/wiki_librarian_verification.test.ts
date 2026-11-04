// Characterization + guard tests for the librarian's self-report
// verification: the verified wrapper around runLibrarianReview counts
// the user's wiki_changelog rows before and after the run and
// annotates the final reply when it CLAIMS an edit (merges, deletes,
// consolidations) but the count did not move - the same false-success
// shape the article sweep and the extraction sweep already guard.
//
// Stub-admin pattern (wiki_records_sweep.test.ts / orchestrator.test.ts):
// RPC responses scripted by name, per-table FIFO row queues, and an
// injected `complete` that scripts one terminal text round - no
// network, no real Venice.
//
// Ports the shipped wiki_records_sweep.test.ts harness.
//
// Coverage map: the scheduled tick and the manual run are driven
// end-to-end here (both take the `complete` test seam). The chat
// dispatch (the wiki_librarian ToolDef) is a one-line consumer of the
// same verified wrapper but has no seam - threading one through would
// mean accepting a completion function from model-controlled tool
// args - so its behavior is pinned by the wrapper-level coverage here
// and the sweep tick's wiring test, plus deno check on the call site.

import { assertEquals } from '@std/assert';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  runWikiLibrarianManual,
  runWikiLibrarianSweepTick,
  __test,
} from '../venice/agents/wiki_librarian.ts';

const USER_ID = 'u-1';

interface QueueEntry {
  data?: unknown;
  error?: { message: string } | null;
  count?: number;
}

interface Harness {
  summary?: Awaited<ReturnType<typeof runWikiLibrarianSweepTick>>;
  manualResult?: Awaited<ReturnType<typeof runWikiLibrarianManual>>;
  agentLogInserts: Record<string, unknown>[];
  consoleWarns: string[];
  /** Ordering events: 'before-count' / 'run' / 'after-count' / 'log-insert'. */
  events: string[];
}

// Three rows so the tick's min-articles check (LIBRARIAN_MIN_ARTICLES)
// passes; content is irrelevant to the harness.
const ARTICLES = [
  { id: 'a-1', title: 'Household', content: 'The household article.', favorite: false },
  { id: 'a-2', title: 'Kermit protocol', content: 'The kermit article.', favorite: false },
  { id: 'a-3', title: 'Maya', content: 'The Maya article.', favorite: false },
];

// Script one librarian run (sweep tick or manual): user claim, in-
// flight guard, three-article wiki, seeded Venice key, one terminal
// model round, and FIFO queues for the tables the run reads.
// `changelogCounts` scripts the before/after head-counts IN ORDER; an
// entry with an error simulates a count failure (verification is
// skipped, the run proceeds). The console.warn spy lives only for the
// duration of the run.
async function makeEnv(opts: {
  finalText: string;
  changelogCounts: QueueEntry[];
  mode: 'sweep' | 'manual';
}): Promise<Harness> {
  const queues: Record<string, QueueEntry[]> = {
    wiki_changelog: [...opts.changelogCounts],
    app_config: [{ data: { venice_api_key: 'qa-key' }, error: null }],
    message_attachments: [{ data: [], error: null }],
    wiki_articles: [{ data: ARTICLES, error: null }],
    wiki_records: [{ data: [], error: null }],
    profiles: [{ data: null, error: null }],
  };
  const counters: Record<string, number> = {};
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
      const builder: Record<string, unknown> = {
        select: () => builder,
      };
      (builder as { then: unknown }).then = (resolve: (v: unknown) => unknown) => {
        if (name === 'claim_next_user_for_wiki_librarian') {
          return Promise.resolve({ data: USER_ID, error: null }).then(resolve);
        }
        if (name === 'claim_wiki_librarian_inflight') {
          return Promise.resolve({ data: true, error: null }).then(resolve);
        }
        if (name === 'release_wiki_librarian_inflight') {
          return Promise.resolve({ data: null, error: null }).then(resolve);
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
      const summary = await runWikiLibrarianSweepTick(adminClient, { complete });
      return { summary, agentLogInserts, consoleWarns, events };
    }
    const manualResult = await runWikiLibrarianManual(
      adminClient,
      USER_ID,
      null,
      undefined,
      { complete },
    );
    return { manualResult, agentLogInserts, consoleWarns, events };
  } finally {
    console.warn = originalWarn;
  }
}

const CLAIM = "Deleted 'Kermit protocol' as out-of-scope; merged the two 'Maya' articles into one.";

Deno.test('honest success: edits landed + claim -> reasoning stored unannotated', async () => {
  const h = await makeEnv({
    finalText: CLAIM,
    changelogCounts: [{ data: null, error: null, count: 4 }, { data: null, error: null, count: 5 }],
    mode: 'sweep',
  });
  assertEquals(h.summary!.outcome, 'reviewed');
  assertEquals(h.agentLogInserts.length, 1);
  assertEquals(h.agentLogInserts[0].agent, 'wiki-librarian');
  assertEquals(h.agentLogInserts[0].reasoning, CLAIM);
  // Ordering contract: the before-count precedes the run, the
  // after-count follows it, and both precede the audit insert - the
  // before/after comparison can never silently swap its two queue
  // entries.
  assertEquals(h.events, ['before-count', 'run', 'after-count', 'log-insert']);
});

Deno.test('honest no-op: unmoved count + no-claim reasoning -> stored unannotated', async () => {
  const h = await makeEnv({
    finalText: 'No edits - wiki is small and coherent.',
    changelogCounts: [{ data: null, error: null, count: 4 }, { data: null, error: null, count: 4 }],
    mode: 'sweep',
  });
  assertEquals(h.summary!.outcome, 'reviewed');
  assertEquals(h.agentLogInserts.length, 1);
  assertEquals(h.agentLogInserts[0].reasoning, 'No edits - wiki is small and coherent.');
});

Deno.test('false claim: unmoved count + claim reasoning -> warn + annotation stored', async () => {
  const h = await makeEnv({
    finalText: CLAIM,
    changelogCounts: [{ data: null, error: null, count: 4 }, { data: null, error: null, count: 4 }],
    mode: 'sweep',
  });
  assertEquals(h.summary!.outcome, 'reviewed');
  assertEquals(h.agentLogInserts.length, 1);
  const reasoning = String(h.agentLogInserts[0].reasoning);
  assertEquals(
    reasoning.includes(
      '[unverified self-report: claimed an edit, but wiki_changelog rows for this user went from 4 to 4]',
    ),
    true,
    `annotation missing from: ${reasoning}`,
  );
  assertEquals(h.consoleWarns.length > 0, true, 'expected a warn line');
});

Deno.test('count query failure: run completes normally, no annotation', async () => {
  const h = await makeEnv({
    finalText: CLAIM,
    changelogCounts: [{ data: null, error: { message: 'count boom' } }],
    mode: 'sweep',
  });
  assertEquals(h.summary!.outcome, 'reviewed');
  assertEquals(h.agentLogInserts.length, 1);
  const reasoning = String(h.agentLogInserts[0].reasoning);
  assertEquals(reasoning.includes('unverified self-report'), false);
});

Deno.test('manual run honest success: claim + moved count -> unannotated, carried on the result', async () => {
  const h = await makeEnv({
    finalText: CLAIM,
    changelogCounts: [{ data: null, error: null, count: 4 }, { data: null, error: null, count: 5 }],
    mode: 'manual',
  });
  assertEquals(h.manualResult!.kind, 'ok');
  const result = h.manualResult as { kind: 'ok'; finalText: string };
  assertEquals(result.finalText, CLAIM);
  assertEquals(h.agentLogInserts.length, 1);
  assertEquals(h.agentLogInserts[0].reasoning, CLAIM);
  assertEquals(h.events, ['before-count', 'run', 'after-count', 'log-insert']);
});

Deno.test('manual run false claim: annotation carried on the result the Wiki panel renders', async () => {
  const h = await makeEnv({
    finalText: CLAIM,
    changelogCounts: [{ data: null, error: null, count: 4 }, { data: null, error: null, count: 4 }],
    mode: 'manual',
  });
  assertEquals(h.manualResult!.kind, 'ok');
  const result = h.manualResult as { kind: 'ok'; finalText: string };
  assertEquals(
    result.finalText.includes('[unverified self-report: claimed an edit,'),
    true,
    `annotation missing from manual result: ${result.finalText}`,
  );
  assertEquals(h.consoleWarns.length > 0, true, 'expected a warn line');
});

Deno.test('matcher: affirmative edit claims vs honest no-ops and reference-style past tense', () => {
  const claims = __test.claimsLibrarianEdit;
  // Affirmative claims - the prompt's example summary shapes, noun and
  // quoted-title variants.
  assertEquals(claims(CLAIM), true);
  assertEquals(claims("Deleted 'Kermit protocol' as out-of-scope."), true);
  assertEquals(claims('Merged the two duplicate records.'), true);
  assertEquals(claims('Folded the sister page into household.'), true);
  assertEquals(claims('Renamed the Nak article.'), true);
  // Honest no-ops never match - the prompt's own example shapes.
  assertEquals(claims('No edits - wiki is small and coherent.'), false);
  assertEquals(
    claims("Left 'Maya' and 'household' separate - they overlap but cover different subjects."),
    false,
  );
  assertEquals(claims('(none)'), false);
  // The nothing guard: "merged" + filler + quoted title would claim,
  // so the nothing token (not the matcher) is what suppresses this
  // shape - the load-bearing case for the guard's nothing token.
  assertEquals(claims("Merged nothing and 'Maya' stays as is."), false);
  // Contracted negations: the n't alternative has NO leading word
  // boundary (none exists inside a contraction) - these must guard.
  assertEquals(claims("I haven't merged any articles."), false);
  assertEquals(claims("didn't delete anything"), false);
  // Reference-style past tense: an honest no-op summarizing EXISTING
  // work - the verb follows the noun, so no claim.
  assertEquals(claims('The Kermit entry was deleted last cycle.'), false);
  // Mixed sentence with a negation anywhere: suppressed (miss
  // direction - never punish an honest no-op).
  assertEquals(claims('Merged the Maya articles; no duplicates remain.'), false);
  // Known miss shape (accepted, warn-only): a reference-style summary
  // of PRE-EXISTING work whose verb still lands before a noun ("was
  // already merged into the Maya article") claims - the annotation
  // carries both counts so the audit row stays truthful.
  assertEquals(
    claims("One duplicate was already merged into the Maya article by yesterday's run"),
    true,
  );
});
