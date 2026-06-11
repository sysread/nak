// Curation composition: drives the five claim-based housekeeping units
// (auto_title, thread_topics, summary, memory_topics, recipe_topics -
// the function-side ports of the browser's supervised worker fleet)
// from the two server-side triggers that replaced the browser
// supervisor poll:
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

/**
 * Per-unit drain cap for the chat-turn tail. A turn produces at most
 * one new row per queue, so 3 covers the fresh row plus a small
 * backlog without letting one tail invocation monopolise the
 * function's background budget - the hourly sweep owns deep backlogs.
 */
const TAIL_DRAIN_CAP = 3;

/**
 * Per-queue drain cap for one cron sweep tick. Bounds a tick's
 * worst-case Venice spend (5 queues x 10 completions); a backlog
 * deeper than the cap drains across successive hourly ticks.
 */
const SWEEP_QUEUE_CAP = 10;

/** Per-tick tally returned to the sweep caller, one counter per queue. */
export interface CurationSweepSummary {
  titled: number;
  threadsTagged: number;
  summarised: number;
  memoriesTagged: number;
  recipesTagged: number;
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
   * Outcomes after which the drain loop should claim again: the cycle
   * consumed a row (saved it, lost it to a racing run, or released it
   * for retry) and the queue may hold more. Everything else - empty
   * queue, empty model output left to TTL, error - stops the drain;
   * this mirrors the browser supervisor's progress/nap classification
   * (src/lib/agents/supervisor/loop.ts), where only these outcomes
   * counted as 'progress'.
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
];

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
      for (let i = 0; i < TAIL_DRAIN_CAP; i++) {
        const outcome = await unit.runForUser(adminClient, userId, log);
        if (!unit.drainOn.has(outcome)) break;
      }
    } catch (err) {
      // The unit fns are non-throwing by contract; this guard exists
      // so a contract violation in one unit still cannot starve the
      // units after it.
      log.error(
        `${unit.source} tail drain failed`,
        err instanceof Error ? err : new Error(String(err)),
      );
    } finally {
      await log.flush();
    }
  }
}

/**
 * One cron sweep tick: walk the five queues cross-user, draining each
 * up to SWEEP_QUEUE_CAP rows via the SECURITY DEFINER *_sweep claims.
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
  };
  for (const unit of UNITS) {
    let drained = 0;
    let stillDraining = true;
    while (drained < SWEEP_QUEUE_CAP) {
      let outcome: string;
      try {
        outcome = await unit.sweepOnce(adminClient);
      } catch (err) {
        // Same contract guard as the tail driver: sweep fns are
        // non-throwing, but one queue blowing up must not stop the
        // remaining queues from draining this tick.
        console.error(
          `[curation-sweep] ${unit.source} sweep cycle threw:`,
          err instanceof Error ? err.message : String(err),
        );
        stillDraining = false;
        break;
      }
      drained++;
      if (outcome === unit.savedOutcome) tally[unit.tallyKey]++;
      if (!unit.drainOn.has(outcome)) {
        stillDraining = false;
        break;
      }
    }
    // No silent caps: when the loop exhausted its budget while the
    // queue was still producing claimable rows, say so - a queue that
    // hits the cap every tick is growing faster than the sweep
    // drains it and someone should notice.
    if (stillDraining && drained >= SWEEP_QUEUE_CAP) {
      console.log(
        `[curation-sweep] ${unit.source} queue cap (${SWEEP_QUEUE_CAP}) reached with rows still pending`,
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
export const __test = { UNITS, TAIL_DRAIN_CAP, SWEEP_QUEUE_CAP };
