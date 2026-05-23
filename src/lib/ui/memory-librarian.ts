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
