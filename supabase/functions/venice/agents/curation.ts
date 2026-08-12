// Curation composition: drives the six claim-based housekeeping units
// (auto_title, thread_topics, summary, memory_topics, recipe_topics -
// the function-side ports of the browser's supervised worker fleet -
// plus rechunk, which has no browser ancestor) from the two
// server-side triggers that replaced the browser supervisor poll:
//
//   - curateOnTurnTail: fired from a chat turn's waitUntil tail, once
//     per completed turn, scoped to the turn's user. The primary
//     driver - a user who converses gets their queues drained within
//     seconds of producing new work.
//   - runCurationSweepTick: fired from the hourly cron sweep,
//     cross-user via the SECURITY DEFINER *_sweep claims. Drains
//     queues the tail can't reach (users who stopped conversing with
//     rows still pending).
//
// Double-driving is safe: the per-row claim columns are the mutual
// exclusion, so whichever driver claims first wins and the other sees
// an empty queue. Same posture as ./reflection.ts.
//
// Both drivers are best-effort by contract - one unit failing must
// not stop the rest, and nothing here may throw into the caller.

import type { SupabaseClient } from '@supabase/supabase-js';
import { createEdgeLogger, type EdgeLogger } from '../../_shared/edge-log.ts';
import { sweepClaimAndTitle, titleOneThread } from './auto_title.ts';
import { sweepClaimAndSummarise, summariseOneThread } from './summary.ts';
import { sweepClaimAndTagThread, tagOneThread } from './thread_topics.ts';
import { sweepClaimAndTagMemory, tagOneMemory } from './memory_topics.ts';
import { sweepClaimAndTagRecipe, tagOneRecipe } from './recipe_topics.ts';
import { rechunkOneThread, sweepClaimAndRechunk } from './thread_chunks.ts';

/**
 * Per-unit drain cap for the chat-turn tail. A turn produces at most
 * one new row per queue, so 3 covers the fresh row plus a small
 * backlog without letting one tail invocation monopolise the
 * function's background budget - the hourly sweep owns deep backlogs.
 */
const TAIL_DRAIN_CAP = 3;

/**
 * Default per-queue drain cap for one cron sweep tick. Bounds a tick's
 * worst-case Venice spend - one completion per row, per model-calling
 * queue - so raising it multiplies across all of them. A backlog deeper
 * than the cap drains across successive hourly ticks.
 */
const SWEEP_QUEUE_CAP = 25;

/**
 * Drain cap for a queue whose unit makes NO model call. Only rechunk
 * qualifies today: it is a read, a text transform, and a write, so its
 * per-row cost is a couple of DB round trips rather than a completion.
 * The sweep is hourly, which makes the cap - not the cadence - the
 * thing that decides whether a backlog measured in hundreds drains in
 * hours or days.
 *
 * Deliberately NOT folded into SWEEP_QUEUE_CAP: the two numbers bound
 * different resources (Venice spend vs. database time) and should move
 * independently. A unit that starts calling a model must drop back to
 * the default.
 */
const SWEEP_QUEUE_CAP_MODEL_FREE = 250;

/**
 * The outcome every unit returns when its cycle failed - a Venice
 * rejection, a Supabase error, a throw inside the unit. Named here
 * because the drain loops treat it differently from the other
 * non-progress outcomes: 'empty-queue' means the queue is genuinely
 * dry and 'empty-summary' means the row was deliberately released to
 * its TTL, but 'error' says nothing about the rows BEHIND the one
 * that failed.
 */
const ERROR_OUTCOME = 'error';

/**
 * Consecutive errored rows that end a drain pass.
 *
 * One deterministically-failing row must not stall its queue. An
 * errored row keeps its claim until the TTL expires, so the next
 * claim in the same pass skips past it and reaches the row behind -
 * but only if the loop keeps going. Treating a single error as
 * "stop draining" makes the head of the queue a single point of
 * failure, because claim order is `updated_at asc` and the same row
 * is therefore re-claimed first on every subsequent tick.
 *
 * That is not hypothetical: one thread that failed every summary
 * attempt held the head of the summary queue and produced 24 claims
 * and 0 saves across ten hours - every tick broke on the first row,
 * so nothing behind it was ever tried, and the backlog only drained
 * once that row's underlying failure was fixed.
 *
 * A RUN of errors is a different signal - a failing backend rather
 * than a bad row - and hammering it burns the tick's Venice budget
 * for nothing, so the pass still bails once errors come consecutively.
 */
const MAX_CONSECUTIVE_ERRORS = 3;

/** Per-tick tally returned to the sweep caller, one counter per queue. */
export interface CurationSweepSummary {
  titled: number;
  threadsTagged: number;
  summarised: number;
  memoriesTagged: number;
  recipesTagged: number;
  rechunked: number;
}

/**
 * One curation work unit as the drivers see it: a per-user cycle fn, a
 * cross-user sweep cycle fn, and the outcome vocabulary the drain
 * loops act on. The unit modules own claims, completions, validation,
 * and saves; this descriptor only carries what composition needs.
 */
interface CurationUnit {
  /** Edge-logger source tag - the drawer's grouping label for this unit's lines. */
  source: string;
  /** Sweep-tally counter this unit increments on a successful save. */
  tallyKey: keyof CurationSweepSummary;
  /** The outcome that means "claimed, worked, saved". */
  savedOutcome: string;
  /**
   * Per-tick sweep cap for this queue. Omitted means SWEEP_QUEUE_CAP,
   * which is sized against Venice spend; a model-free unit overrides it
   * with SWEEP_QUEUE_CAP_MODEL_FREE.
   */
  sweepCap?: number;
  /**
   * Outcomes after which the drain loop should claim again: the cycle
   * consumed a row (saved it, lost it to a racing run, or released it
   * for retry) and the queue may hold more. Everything else - empty
   * queue, empty model output left to TTL - stops the drain; this
   * mirrors the browser supervisor's progress/nap classification
   * (src/lib/agents/supervisor/loop.ts), where only these outcomes
   * counted as 'progress'.
   *
   * ERROR_OUTCOME is deliberately absent from every unit's set and is
   * NOT classified here: it is neither progress nor a reason to stop,
   * so drainUnit handles it separately (see MAX_CONSECUTIVE_ERRORS).
   */
  drainOn: ReadonlySet<string>;
  runForUser(
    admin: SupabaseClient,
    userId: string,
    log: EdgeLogger,
  ): Promise<string>;
  sweepOnce(admin: SupabaseClient): Promise<string>;
}

/**
 * Ordered unit list both drivers walk. auto_title runs FIRST on
 * purpose: a brand-new conversation sits on the 'New conversation'
 * placeholder until this unit names it, and that latency is
 * user-visible in the sidebar - every other unit's output (tags,
 * summaries) only surfaces on later interactions.
 */
const UNITS: readonly CurationUnit[] = [
  {
    source: 'auto-title',
    tallyKey: 'titled',
    savedOutcome: 'titled',
    // 'no-title' counts as drain-worthy for auto-title (unlike the
    // topics units' 'empty-topics') for parity with the browser
    // supervisor, which classified it as progress: the claim was
    // released and an immediate retry is the historical behavior for
    // a transient title failure. The drain cap bounds the worst case
    // of a deterministically failing row.
    drainOn: new Set(['titled', 'no-title', 'claim-lost']),
    runForUser: titleOneThread,
    sweepOnce: sweepClaimAndTitle,
  },
  {
    source: 'topics',
    tallyKey: 'threadsTagged',
    savedOutcome: 'tagged',
    drainOn: new Set(['tagged', 'claim-lost']),
    runForUser: tagOneThread,
    sweepOnce: sweepClaimAndTagThread,
  },
  {
    source: 'summary',
    tallyKey: 'summarised',
    savedOutcome: 'summarised',
    // 'empty-summary' stops the drain: the claim is deliberately left
    // to expire via TTL (see ./summary.ts), so claiming again right
    // away would just skip past the row to deeper backlog the sweep
    // already covers.
    drainOn: new Set(['summarised', 'claim-lost']),
    runForUser: summariseOneThread,
    sweepOnce: sweepClaimAndSummarise,
  },
  {
    source: 'memory-topics',
    tallyKey: 'memoriesTagged',
    savedOutcome: 'tagged',
    drainOn: new Set(['tagged', 'claim-lost']),
    runForUser: tagOneMemory,
    sweepOnce: sweepClaimAndTagMemory,
  },
  {
    source: 'recipe-topics',
    tallyKey: 'recipesTagged',
    savedOutcome: 'tagged',
    drainOn: new Set(['tagged', 'claim-lost']),
    runForUser: tagOneRecipe,
    sweepOnce: sweepClaimAndTagRecipe,
  },
  {
    // The one unit that makes no model call - pure text processing plus
    // a write - so it costs the tail nothing but a round trip. Runs
    // last because its output feeds the embed backfill on a separate
    // (5-minute) cron, not this walk: being a few seconds later into
    // the chunk queue changes nothing downstream.
    source: 'rechunk',
    tallyKey: 'rechunked',
    savedOutcome: 'rechunked',
    sweepCap: SWEEP_QUEUE_CAP_MODEL_FREE,
    drainOn: new Set(['rechunked', 'claim-lost']),
    runForUser: rechunkOneThread,
    sweepOnce: sweepClaimAndRechunk,
  },
];

/**
 * Drain one unit's queue, up to `cap` rows, reporting every outcome to
 * `onOutcome` and every contract-violating throw to `onThrow`. Shared
 * by both drivers so the progress classification and the error
 * tolerance cannot drift apart between the tail and the sweep.
 *
 * Returns true when the pass used its whole cap with the queue still
 * producing claimable rows - the caller decides whether that is worth
 * reporting.
 */
async function drainUnit(
  unit: CurationUnit,
  cap: number,
  runOnce: () => Promise<string>,
  onOutcome: (outcome: string) => void,
  onThrow: (err: unknown) => void,
): Promise<boolean> {
  let consecutiveErrors = 0;
  for (let i = 0; i < cap; i++) {
    let outcome: string;
    try {
      outcome = await runOnce();
    } catch (err) {
      // The unit fns are non-throwing by contract; this guard exists so
      // a contract violation in one unit still cannot starve the units
      // after it.
      onThrow(err);
      return false;
    }
    onOutcome(outcome);
    if (outcome === ERROR_OUTCOME) {
      // The failed row holds its claim until the TTL expires, so the
      // next claim in this pass steps over it and reaches the row
      // behind. That step-over is the whole point: it is what keeps a
      // single bad row from wedging the queue head.
      consecutiveErrors++;
      if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) return false;
      continue;
    }
    consecutiveErrors = 0;
    if (!unit.drainOn.has(outcome)) return false;
  }
  return true;
}

/**
 * Run the curation units for `userId`, sequentially in UNITS order,
 * draining each queue up to TAIL_DRAIN_CAP rows. Fired from
 * getStreamingResponse's terminal tail (via edgeWaitUntil) once per
 * completed chat turn. Best-effort and NON-throwing by contract - a
 * curation failure must not touch the turn's recorded outcome, so
 * each unit's failures are contained to that unit and the rest still
 * run. One edge logger per unit source, each flushed before the next
 * unit starts so the drawer lines land even if the tail is torn down
 * mid-walk.
 */
export async function curateOnTurnTail(
  adminClient: SupabaseClient,
  userId: string,
): Promise<void> {
  for (const unit of UNITS) {
    const log = createEdgeLogger(userId, unit.source);
    try {
      await drainUnit(
        unit,
        TAIL_DRAIN_CAP,
        () => unit.runForUser(adminClient, userId, log),
        () => {},
        (err) =>
          log.error(
            `${unit.source} tail drain failed`,
            err instanceof Error ? err : new Error(String(err)),
          ),
      );
    } finally {
      await log.flush();
    }
  }
}

/**
 * One cron sweep tick: walk every queue cross-user, draining each up to
 * its own cap (SWEEP_QUEUE_CAP, or the unit's `sweepCap` override) via
 * the SECURITY DEFINER *_sweep claims.
 * Per-claim drawer logging lives inside the unit sweep fns (each
 * claim names its own user); this level logs only composition-scoped
 * events - cap truncation and contract violations - to the function
 * console. Returns the per-queue tally for the sweep route's
 * response/log line. Non-throwing.
 */
export async function runCurationSweepTick(
  adminClient: SupabaseClient,
): Promise<CurationSweepSummary> {
  const tally: CurationSweepSummary = {
    titled: 0,
    threadsTagged: 0,
    summarised: 0,
    memoriesTagged: 0,
    recipesTagged: 0,
    rechunked: 0,
  };
  for (const unit of UNITS) {
    const cap = unit.sweepCap ?? SWEEP_QUEUE_CAP;
    const cappedOut = await drainUnit(
      unit,
      cap,
      () => unit.sweepOnce(adminClient),
      (outcome) => {
        if (outcome === unit.savedOutcome) tally[unit.tallyKey]++;
      },
      // Same contract guard as the tail driver: sweep fns are
      // non-throwing, but one queue blowing up must not stop the
      // remaining queues from draining this tick.
      (err) =>
        console.error(
          `[curation-sweep] ${unit.source} sweep cycle threw:`,
          err instanceof Error ? err.message : String(err),
        ),
    );
    // No silent caps: when the pass exhausted its budget while the
    // queue was still producing claimable rows, say so - a queue that
    // hits the cap every tick is growing faster than the sweep drains
    // it and someone should notice.
    if (cappedOut) {
      console.log(
        `[curation-sweep] ${unit.source} queue cap (${cap}) reached with rows still pending`,
      );
    }
  }
  return tally;
}

// Test-only surface: the unit ORDER is a UX invariant (auto_title
// first - title latency on a brand-new conversation is load-bearing)
// and the drain sets encode the browser supervisor's progress/nap
// classification, so both get asserted in
// supabase/functions/tests/curation.test.ts.
export const __test = {
  UNITS,
  TAIL_DRAIN_CAP,
  SWEEP_QUEUE_CAP,
  SWEEP_QUEUE_CAP_MODEL_FREE,
  ERROR_OUTCOME,
  MAX_CONSECUTIVE_ERRORS,
  drainUnit,
};
