/**
 * UI-behavior primitives for the Intuition diagnostics modal
 * (src/screens/Intuition.svelte). Display transforms only - the
 * framework-agnostic half of the modal, per the frontend-organization
 * split. Age / staleness formatting is shared with the Recall modal and
 * lives in ./payload-freshness.
 */
import type { IntuitionPayload } from '$lib/intuition';

/** Human label for a refresh trigger reason. 'title' is legacy-only
 *  (the mid-turn title trigger is retired) but still rendered for
 *  payloads persisted before that change. */
export function formatIntuitionTrigger(t: IntuitionPayload['trigger']): string {
  switch (t) {
    case 'title':
      return 'topic shift (title changed)';
    case 'mood':
      return 'mood shift';
    case 'stale':
      return 'staleness fuse';
    case 'cold':
      return 'first read on this thread';
  }
}

/** Absolute wall-clock label for when the payload was computed. Falls
 *  back to the raw ms on a value Date can't render. */
export function formatIntuitionTimestamp(ms: number): string {
  try {
    return new Date(ms).toLocaleString();
  } catch {
    return String(ms);
  }
}
