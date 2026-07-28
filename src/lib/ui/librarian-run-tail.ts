/**
 * Shared rule for the trailing "still working" row under a librarian
 * run's step list. Both manual-run strips use it - the memory
 * librarian's (`src/screens/Memories.svelte`) and the wiki
 * librarian's (`src/screens/Wiki.svelte`) - so the two stay in step.
 *
 * The problem it solves: a step row only animates while its status is
 * 'pending', and tool rows are pushed ALREADY SETTLED (ok or error,
 * since the event that creates them also reports their outcome). So
 * between a tool row landing and the next 'thinking' event opening a
 * fresh pending row, nothing on the strip moves. Users read that gap
 * as a dead run - especially right after a failed tool call, where the
 * last thing on screen is a cross and then stillness, even though the
 * agent is mid-retry and more steps are coming.
 */

/**
 * Whether to render a standalone spinner row beneath the steps.
 *
 * True whenever the run is live and the bottom row is not already
 * spinning on its own. That keeps one invariant the user can rely on -
 * *while a run is live, something at the bottom of the list is always
 * moving* - without ever stacking two spinners, which would read as a
 * rendering bug rather than two different facts.
 *
 * An empty step list counts: the strip appears the instant a run
 * starts, before the first progress event arrives, and that opening
 * gap needs the cue as much as the mid-run ones do.
 */
export function showsRunTail(
  steps: ReadonlyArray<{ status: 'pending' | 'ok' | 'error' }>,
  running: boolean
): boolean {
  if (!running) return false;
  const last = steps[steps.length - 1];
  return last === undefined || last.status !== 'pending';
}

/**
 * Label beside the tail spinner. Deliberately vague: in this gap the
 * agent is between reported steps, so naming a phase ("Thinking")
 * would be a guess that the next real row could contradict.
 */
export const RUN_TAIL_LABEL = 'Working';
