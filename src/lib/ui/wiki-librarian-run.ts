// Step-list state for the manual wiki-librarian run's live progress strip
// (src/screens/Wiki.svelte). The run executes server-side and narrates over
// the agent-runs Broadcast channel; appendProgressStep translates each event
// into a rendered row.
//
// The load-bearing piece is finalizeLibrarianSteps. The strip's spinner is
// per-row (a row with status 'pending' renders the rotating glyph), and the
// only event that settles the trailing pending row is the terminal `done`
// broadcast. But a run killed by a gateway timeout (the 504 case on a long
// run) returns or throws on the POST and may NEVER deliver `done` - the
// function was cut off before it could publish it. Without a fallback the
// trailing row spins forever even though the run is over. finalizeLibrarianSteps
// settles that row from the POST's own outcome, so the spinner can't outlive
// the request regardless of whether `done` arrived.

import type {
  AgentRunProgressEvent,
  ManualRunOutcome,
  WikiLibrarianRunResult,
} from '$lib/supabase';
import { recoveredOutcomeIsFresh } from './manual-run-recovery';

export type LibrarianStepStatus = 'pending' | 'ok' | 'error';

export interface LibrarianStep {
  label: string;
  status: LibrarianStepStatus;
}

// Shown alongside the error when a run ends in failure. The wiki write tools
// commit each edit immediately and independently (the rows are owned by the
// user, not the run), so a run that errored or timed out mid-loop may have
// already landed some edits. The strip refreshes the panel on these paths;
// this note tells the user those edits were kept rather than rolled back.
export const LIBRARIAN_PARTIAL_SAVE_NOTE =
  'Any edits the librarian saved before this point have been kept; the list has been refreshed.';

// Settle the trailing row IFF it is still pending - a settled row (a tool
// that already reported ok/error) keeps its status. Immutable: returns a new
// array so a Svelte $state reassignment picks up the change.
function settleTrailing(
  steps: LibrarianStep[],
  status: LibrarianStepStatus,
): LibrarianStep[] {
  if (steps.length === 0) return steps;
  const last = steps[steps.length - 1];
  if (last.status !== 'pending') return steps;
  return [...steps.slice(0, -1), { ...last, status }];
}

// Translate one progress event onto the step list. Each non-`done` event
// settles the previous (now-finished) pending phase to ok before pushing its
// own row; `done` only settles the trailing pending row, leaving no stray
// "Done." row below the result paragraph. Callers filter on runId before
// calling this.
export function appendProgressStep(
  steps: LibrarianStep[],
  event: AgentRunProgressEvent,
): LibrarianStep[] {
  switch (event.kind) {
    case 'preparing': {
      const n = event.articleCount ?? 0;
      return [
        ...steps,
        { label: `Loading ${n} article${n === 1 ? '' : 's'}`, status: 'pending' },
      ];
    }
    case 'thinking':
      return [
        ...settleTrailing(steps, 'ok'),
        { label: `Thinking (round ${event.round})`, status: 'pending' },
      ];
    case 'tool': {
      // Prefer the model's narration; fall back to the bare tool name when the
      // model emitted an empty activity (shouldn't happen - the runner marks
      // activity required when progress is wired - but render something rather
      // than a blank row).
      const label = event.activity.trim() || event.name;
      return [...settleTrailing(steps, 'ok'), { label, status: event.ok ? 'ok' : 'error' }];
    }
    case 'done':
      return settleTrailing(steps, event.ok ? 'ok' : 'error');
    default:
      return steps;
  }
}

// Shown when the server-side in-flight guard rejected the run - a
// scheduled or chat-dispatched run already holds the per-user lease, so
// nothing started, nothing was committed, and no steps were produced.
export const LIBRARIAN_BUSY_MESSAGE =
  'A librarian run is already in flight (scheduled or chat-driven). Try again in a moment.';

// Glyph for a SETTLED step row's status column. Pending rows have no
// glyph - the strip renders an animated AsciiSpinner in the cell
// instead, so the domain is the two settled statuses only.
export function librarianStepGlyph(status: 'ok' | 'error'): string {
  return status === 'ok' ? '✓' : '✗';
}

// Meta line under the result card: run size in tool calls and articles,
// plus the pointer to the Logs drawer for the full trace.
export function librarianResultMeta(
  toolCalls: number,
  articleCount: number,
): string {
  return (
    `${toolCalls} tool call${toolCalls === 1 ? '' : 's'} ` +
    `over ${articleCount} article${articleCount === 1 ? '' : 's'}. ` +
    'See the Logs drawer for the full trace.'
  );
}

// A wiki-librarian run is in flight that this strip didn't start -
// another tab, another device, or a scheduled background run, detected
// via the shared in-flight lease. The strip disables its Run button and
// shows the low-fidelity "in progress" notice so a second run can't be
// kicked into the server-side guard's `busy`.
export function librarianRunElsewhere(
  leaseRunning: boolean,
  ownRunBusy: boolean,
): boolean {
  return leaseRunning && !ownRunBusy;
}

/**
 * Decide whether a persisted outcome should populate the strip after a
 * reload, and narrow it to the result card's shape when it should.
 * Returns null - leave the strip alone - when there is no outcome, a
 * live run in this tab is in flight (the live path keeps full step
 * fidelity), the outcome's runId is already on screen (so a profiles
 * realtime tick can't re-apply the same result), the outcome is stale
 * (the sticky `*_last_run_outcome` column never expires - without the
 * recency bound every cold load would resurface the last run ever),
 * or the envelope isn't a terminal wiki-librarian result.
 */
export function recoverLibrarianOutcome(
  outcome: ManualRunOutcome | null,
  ownRunBusy: boolean,
  shownRunId: string | null,
  nowMs: number,
): WikiLibrarianRunResult | null {
  if (!outcome || ownRunBusy || outcome.runId === shownRunId) return null;
  if (!recoveredOutcomeIsFresh(outcome.finishedAt, nowMs)) return null;
  return outcomeToLibrarianResult(outcome);
}

// Label for the "Run librarian" button across its three states: this
// client's own run in flight, someone else's run in flight (another tab,
// another device, or a scheduled background run - detected via the
// in-flight lease), or idle. Both in-flight states disable the button.
export function librarianRunButtonLabel(
  ownRunBusy: boolean,
  runInFlightElsewhere: boolean,
): string {
  if (ownRunBusy) return 'Working…';
  if (runInFlightElsewhere) return 'A run is in progress…';
  return 'Run librarian';
}

// Terminal finalize, driven by the POST outcome rather than the `done` event.
// 'ok' settles a still-spinning trailing row to ok (a no-op when `done`
// already settled it) and appends an explicit "Done" row; 'error' settles
// it to error so a timed-out or failed run shows an X instead of an eternal
// spinner. No-op when nothing is pending.
//
// Why "Done" only on success: a successful run otherwise reads as cut off
// when its last phase is a settled "Thinking (round N)" - the check alone
// doesn't say "finished." On the error/timeout paths the error message and
// the trailing X already mark the end, and a client-side inactivity timeout
// can mean the run is STILL going server-side, so we don't assert a
// misleading terminal row there.
export function finalizeLibrarianSteps(
  steps: LibrarianStep[],
  outcome: 'ok' | 'error',
): LibrarianStep[] {
  const settled = settleTrailing(steps, outcome);
  return outcome === 'ok' ? [...settled, { label: 'Done', status: 'ok' }] : settled;
}

// Narrow a persisted manual-run outcome envelope to a WikiLibrarianRunResult
// for the result card to render after a reload. Returns null when the outcome
// is not a wiki-librarian one (wrong source) or carries a non-terminal `busy`
// result (never persisted, but guarded). The strip pairs this with an empty
// step list - the live step rows are gone after a reload, but the result card
// is the part worth recovering.
export function outcomeToLibrarianResult(outcome: {
  source: string;
  result: unknown;
}): WikiLibrarianRunResult | null {
  if (outcome.source !== 'wiki-librarian') return null;
  const r = outcome.result as { kind?: string };
  if (!r || r.kind === 'busy') return null;
  if (r.kind === 'ok' || r.kind === 'error') return outcome.result as WikiLibrarianRunResult;
  return null;
}
