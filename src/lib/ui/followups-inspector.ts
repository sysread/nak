// Pure UI-behavior primitives for the follow-ups half of the seedling
// inspector modal. The modal (src/screens/Intents.svelte) hosts two
// features that read the same to the user - "notes Nak keeps to itself
// about the future" - working intentions (normative standing goals,
// $lib/ui/intents-inspector) and follow-ups (pending questions whose
// outcomes Nak does not know, docs/dev/followups.md). This module owns
// every follow-up-side decision: lifecycle grouping, the open-row
// status chip, headlines, and the modal title that adapts when the
// intents feature is off. Unit-tested in
// tests/followups-inspector.test.ts.
//
// Same read-only contract as intents ("surfaced, not steerable"): no
// write controls here - the user influences follow-ups by answering,
// postponing, or dismissing them in conversation.

/** One row from the `followups` table, as the inspector reads it. */
export interface FollowupInspectorRow {
  id: string;
  question: string;
  context: string;
  status: 'open' | 'answered' | 'dismissed' | 'expired';
  relevant_after: string | null;
  resolution: string | null;
  created_at: string;
  updated_at: string;
}

/** Follow-ups partitioned by lifecycle, each sorted most-recent first. */
export interface GroupedFollowups {
  open: FollowupInspectorRow[];
  answered: FollowupInspectorRow[];
  /** Dismissed + expired - questions Nak stopped holding, kept for the
   *  record. Merged into one group because the distinction (user veto
   *  vs the system's own decay) matters less to the reader than "no
   *  longer being asked". */
  letGo: FollowupInspectorRow[];
}

/**
 * Partition rows into open / answered / let-go, each sorted by
 * `updated_at` descending. Open leads: the pending questions are what
 * the user came to see; the closed groups are history.
 */
export function groupFollowups(
  rows: readonly FollowupInspectorRow[],
): GroupedFollowups {
  const byRecency = (a: FollowupInspectorRow, b: FollowupInspectorRow) =>
    b.updated_at.localeCompare(a.updated_at);
  return {
    open: rows.filter((r) => r.status === 'open').sort(byRecency),
    answered: rows.filter((r) => r.status === 'answered').sort(byRecency),
    letGo: rows
      .filter((r) => r.status === 'dismissed' || r.status === 'expired')
      .sort(byRecency),
  };
}

/**
 * The status chip on an open card - when Nak intends to raise the
 * question. Mirrors the surfacing rules (docs/dev/followups.md): a
 * dated question past its date is ask-ready; a future-dated one waits
 * for the date; an undated one is only raised when the topic comes up.
 */
export function openStatusChip(
  row: FollowupInspectorRow,
  now: number = Date.now(),
): string {
  if (!row.relevant_after) return 'when it comes up';
  const at = Date.parse(row.relevant_after);
  if (Number.isNaN(at)) return 'when it comes up';
  if (at <= now) return 'ready to ask';
  return `asking after ${formatShortDate(at)}`;
}

/** "Jul 6" style short date for the asking-after chip. Locale-stable
 *  (en-US) so output doesn't drift by machine locale, and rendered in
 *  UTC because relevant_after is a calendar date, not an instant: the
 *  followup tools accept bare dates ("2026-07-06") that Date.parse
 *  stores as midnight UTC, so local-time rendering shows the previous
 *  day to any user west of UTC - the chip read "asking after Jul 5"
 *  for a follow-up recorded as July 6 (and made the pinning test
 *  timezone-dependent: green on UTC CI, red on a local machine). */
function formatShortDate(ms: number): string {
  return new Date(ms).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  });
}

/** Headline for the follow-ups section, pluralized over OPEN rows. */
export function followupsHeadline(open: number): string {
  if (open === 0) return 'Nothing Nak is waiting to hear about';
  if (open === 1) return 'Nak is waiting to hear about 1 thing';
  return `Nak is waiting to hear about ${open} things`;
}

/**
 * The modal's title and dialog label. The seedling pill is always
 * present, but the intents feature is opt-in (off by default) - when it
 * is off the modal shows only follow-ups and must not advertise a
 * feature the user never enabled.
 */
export function inspectorTitle(intentsEnabled: boolean): string {
  return intentsEnabled ? 'Working intentions & follow-ups' : 'Follow-ups';
}
