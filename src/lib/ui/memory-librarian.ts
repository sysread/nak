/**
 * UI-behavior primitives for the memory librarian's manual-run
 * progress display. Same step-list pattern the wiki librarian's
 * panel uses, kept framework-agnostic so a port to a different UI
 * layer would not have to redo the bookkeeping. The Memories panel
 * (`src/screens/Memories.svelte`) holds the `$state<MemoryLibrarianStep[]>`
 * array and dispatches each runner progress event to `pushStep` /
 * `settleTrailingPending`.
 *
 * Two runners (deep-sleep and rem) share the step list because they
 * never run at the same time on the manual surface - the Memories
 * top-bar disables one button while the other is busy, and the
 * `manualBusy` flag in each runner is independent of the other so
 * the user can't kick a second run on top of a first.
 */

export interface MemoryLibrarianStep {
  label: string;
  status: 'pending' | 'ok' | 'error';
}

/**
 * The two librarian passes the manual buttons can trigger. Shared
 * with the runner module's progress event names, but a distinct type
 * because this one is the user-facing identity (confirm strip,
 * progress header) rather than an event tag.
 */
export type MemoryLibrarianPass = 'deep-sleep' | 'rem';

/**
 * Title + plain-language description for a pass, shown in the
 * confirmation strip before a manual run. Lives here rather than
 * inline in the markup because on mobile there's no hover-title to
 * fall back on - the confirm step IS how the user learns what the
 * button does, so the copy is load-bearing and worth a tested home.
 */
export interface MemoryLibrarianPassInfo {
  title: string;
  description: string;
}

export function librarianPassInfo(
  pass: MemoryLibrarianPass
): MemoryLibrarianPassInfo {
  if (pass === 'deep-sleep') {
    return {
      title: 'Run deep-sleep?',
      description:
        'Deep-sleep walks a cluster of similar memories and consolidates ' +
        'duplicates, links related ones, and flags anything that looks ' +
        'contradicted or stale. It picks the memory that has gone the ' +
        'longest without review as the starting point.',
    };
  }
  return {
    title: 'Run rem?',
    description:
      'Rem looks at memories that came up together while you were ' +
      'chatting and fills in the connections between them - drawing ' +
      'links in the memory graph, and occasionally merging a duplicate ' +
      'that slipped past deep-sleep.',
  };
}

/**
 * Discriminated union of the progress events the deep-sleep and rem
 * runners emit. Different `preparing` payload per runner (deep-sleep
 * carries `batchSize`, rem carries `conversationCount`); the rest of
 * the kinds are shared.
 */
export type MemoryLibrarianProgress =
  | { kind: 'deep-sleep-preparing'; batchSize: number }
  | { kind: 'rem-preparing'; conversationCount: number }
  | { kind: 'thinking'; round: number }
  | { kind: 'tool'; name: string; activity: string; ok: boolean; ms: number }
  | { kind: 'done'; ok: boolean };

/**
 * Settle the trailing pending row in the step list to 'ok'. Called
 * before pushing a new row, since the previous phase has by
 * definition finished when the next phase emits its first event.
 * Mutates the caller's array in place to match the wiki pattern.
 */
export function settleTrailingPending(steps: MemoryLibrarianStep[]): void {
  const last = steps[steps.length - 1];
  if (last && last.status === 'pending') last.status = 'ok';
}

/**
 * Translate a runner progress event into a step-list mutation. The
 * `preparing` event always opens a new pending row; `thinking` and
 * `tool` events settle the trailing pending row before pushing a new
 * one (`thinking` as a new pending row, `tool` as a status-resolved
 * row); `done` settles the trailing pending row without pushing a
 * new one.
 *
 * Mutates `steps` in place. Caller is responsible for triggering a
 * Svelte reactivity update (assigning back to the rune, or relying
 * on $state array methods to fire).
 */
export function pushStep(
  steps: MemoryLibrarianStep[],
  event: MemoryLibrarianProgress
): void {
  if (event.kind === 'deep-sleep-preparing') {
    const n = event.batchSize;
    steps.push({
      label: `Loading ${n} memor${n === 1 ? 'y' : 'ies'}`,
      status: 'pending',
    });
    return;
  }
  if (event.kind === 'rem-preparing') {
    const n = event.conversationCount;
    if (n === 0) {
      steps.push({ label: 'No conversations to process', status: 'ok' });
      return;
    }
    steps.push({
      label: `Loading ${n} conversation${n === 1 ? '' : 's'}`,
      status: 'pending',
    });
    return;
  }
  if (event.kind === 'thinking') {
    settleTrailingPending(steps);
    steps.push({
      label: `Thinking (round ${event.round})`,
      status: 'pending',
    });
    return;
  }
  if (event.kind === 'tool') {
    settleTrailingPending(steps);
    const label = event.activity.trim() || event.name;
    steps.push({ label, status: event.ok ? 'ok' : 'error' });
    return;
  }
  // event.kind === 'done'
  const last = steps[steps.length - 1];
  if (last && last.status === 'pending') {
    last.status = event.ok ? 'ok' : 'error';
  }
}

/**
 * Compose a short human-readable result line for the Memories
 * librarian strip. Mirrors the wiki librarian's "merged X, deleted
 * Y, considered Z" headline, but the two librarians have different
 * result shapes:
 *
 *   - deep-sleep returns one batch (seed + neighbors) with an agent
 *     summary covering the consolidation decisions
 *   - rem returns N processed conversations with a concatenated
 *     summary across them
 *
 * The result-line builder normalises both into "deep-sleep
 * reviewed N memories" / "rem reviewed N conversations" so the UI
 * doesn't branch on which runner just finished.
 */
export interface DeepSleepResultLineInput {
  kind: 'ok' | 'no-eligible' | 'too-small' | 'error';
  batchSize: number;
  toolCalls: number;
}
export function deepSleepResultLine(input: DeepSleepResultLineInput): string {
  if (input.kind === 'no-eligible') {
    return 'No eligible memories to review.';
  }
  if (input.kind === 'too-small') {
    return 'Seed memory had no similarity neighbors above the threshold; marked visited and moved on.';
  }
  if (input.kind === 'error') {
    return 'Deep-sleep run failed.';
  }
  const m = input.batchSize === 1 ? 'memory' : 'memories';
  const c = input.toolCalls === 1 ? 'call' : 'calls';
  return `Reviewed ${input.batchSize} ${m} with ${input.toolCalls} tool ${c}.`;
}

export interface RemResultLineInput {
  kind: 'ok' | 'empty-queue' | 'error';
  conversationsProcessed: number;
  toolCalls: number;
}
export function remResultLine(input: RemResultLineInput): string {
  if (input.kind === 'empty-queue') {
    return 'No conversations with new recall activity to process.';
  }
  if (input.kind === 'error') {
    return 'Rem run failed.';
  }
  const c = input.conversationsProcessed === 1 ? 'conversation' : 'conversations';
  const calls = input.toolCalls === 1 ? 'call' : 'calls';
  return `Processed ${input.conversationsProcessed} ${c} with ${input.toolCalls} tool ${calls}.`;
}

/**
 * The displayed shape of a memory-librarian run result - what the strip
 * renders once a run settles. The live run path in the librarianRun store
 * computes these fields inline from the result union; this is the same
 * derivation applied to a PERSISTED outcome recovered after a reload, so
 * a recovered run renders identically to one watched live.
 */
export interface MemoryLibrarianDisplay {
  pass: MemoryLibrarianPass;
  resultLine: string;
  resultText: string | null;
  error: string | null;
}

/**
 * Derive the displayed result fields from a persisted manual-run outcome
 * envelope (`{ source, result }`). Returns null when the outcome is not a
 * memory-librarian one (unknown source) or carries a non-terminal `busy`
 * result (which is never persisted, but guarded defensively). `source`
 * picks the pass and the matching result-line builder; the result union
 * supplies the counts.
 */
export function outcomeToMemoryDisplay(outcome: {
  source: string;
  result: unknown;
}): MemoryLibrarianDisplay | null {
  const result = outcome.result as { kind?: string; finalText?: string; error?: string };
  const kind = result?.kind;
  if (!kind || kind === 'busy') return null;

  if (outcome.source === 'deep-sleep') {
    const r = result as {
      kind: 'ok' | 'no-eligible' | 'too-small' | 'error';
      finalText?: string;
      error?: string;
      batchSize?: number;
      toolCalls?: number;
    };
    return {
      pass: 'deep-sleep',
      resultLine: deepSleepResultLine({
        kind: r.kind,
        batchSize: r.batchSize ?? 0,
        toolCalls: r.toolCalls ?? 0,
      }),
      resultText:
        r.kind === 'ok' && (r.finalText ?? '').trim().length > 0
          ? (r.finalText ?? '').trim()
          : null,
      error: r.kind === 'error' ? (r.error ?? 'Deep-sleep run failed.') : null,
    };
  }

  if (outcome.source === 'rem') {
    const r = result as {
      kind: 'ok' | 'empty-queue' | 'error';
      finalText?: string;
      error?: string;
      conversationsProcessed?: number;
      toolCalls?: number;
    };
    return {
      pass: 'rem',
      resultLine: remResultLine({
        kind: r.kind,
        conversationsProcessed: r.conversationsProcessed ?? 0,
        toolCalls: r.toolCalls ?? 0,
      }),
      resultText:
        r.kind === 'ok' && (r.finalText ?? '').trim().length > 0
          ? (r.finalText ?? '').trim()
          : null,
      error: r.kind === 'error' ? (r.error ?? 'Rem run failed.') : null,
    };
  }

  return null;
}

// How recently a recovered run must have finished to auto-pop the result
// strip. The `*_last_run_outcome` profiles column is a sticky last-value
// with no expiry, so without this bound the bridge would resurface the
// strip on EVERY cold app load - hiding the changelog default surface
// behind a stale "Rem finished" card from a run that ran hours or days
// ago. The recovery only exists for the reload-after-finish case (kick a
// run, reload, land back and see the summary), so a short window is right:
// 10 min comfortably covers a reload round-trip plus the longest plausible
// run, while a genuinely new session never trips it. A fresh realtime
// outcome (a run finishing while the tab is open) has finishedAt ~= now,
// so it always passes.
export const MAX_RECOVERED_OUTCOME_AGE_MS = 10 * 60 * 1000;

/**
 * Decide whether a recovered manual-run outcome should overwrite the
 * librarian strip's current display, and if so what to show. The guard
 * the `librarianRun` store applies when a persisted outcome arrives (on
 * mount or via the profiles realtime UPDATE), lifted out of the store so
 * it's testable without driving module-level runes:
 *  - a live run in this tab owns the display (`running`) -> skip;
 *  - the outcome we already show (`shownRunId`) -> skip, since the
 *    subscription re-fires on every profiles tick;
 *  - a stale outcome (finished longer ago than MAX_RECOVERED_OUTCOME_AGE_MS)
 *    -> skip, so a sticky last-run value can't bury the changelog on a
 *    cold load; an absent/unparseable finishedAt is treated as fresh so a
 *    legacy envelope without the field still recovers;
 *  - a non-memory outcome (wrong source / busy) -> skip (null display).
 * Returns the display to apply, or null to leave the strip untouched.
 */
export function recoveredOutcomeUpdate(
  outcome: { runId: string; source: string; finishedAt?: string; result: unknown },
  ctx: { running: boolean; shownRunId: string | null; nowMs: number }
): MemoryLibrarianDisplay | null {
  if (ctx.running) return null;
  if (outcome.runId === ctx.shownRunId) return null;
  if (outcome.finishedAt) {
    const finishedMs = Date.parse(outcome.finishedAt);
    if (!Number.isNaN(finishedMs) && ctx.nowMs - finishedMs > MAX_RECOVERED_OUTCOME_AGE_MS) {
      return null;
    }
  }
  return outcomeToMemoryDisplay(outcome);
}
