/**
 * Pure fork primitives for conversation forking (see
 * docs/dev/forking.md): fork-point selection rules and fork-title
 * construction. The Supabase slice (./supabase/threads.ts) queries
 * candidate rows and delegates the decisions to these functions so
 * the rules are unit-testable without a client; M5's
 * fork-from-message card buttons will reuse the same validity
 * predicate to decide which rows get a fork button.
 */

/**
 * MATHEMATICAL FRAKTUR SMALL F (U+1D523), the fork-title sigil. A
 * fork's title is the source's title behind `<sigil><subscript-n> `,
 * where n is the ordinal of the fork among all forks minted from the
 * same fork-point message. Escaped rather than literal so the source
 * file stays ASCII per repo convention.
 */
export const FORK_TITLE_SIGIL = '\u{1D523}';

/**
 * Threads are created with this placeholder and the auto-title worker
 * claims rows whose title still EQUALS it exactly - which is why
 * forkTitle passes it through unmarked: a prefixed placeholder would
 * fall out of auto-title's net forever. Chat.svelte and
 * prompt-assembly.ts carry their own local copies of the same string;
 * they predate this one and consolidation was not worth the churn.
 */
export const PLACEHOLDER_TITLE = 'New conversation';

/** Render a positive integer with Unicode subscript digits (U+2080..U+2089). */
export function subscriptNumber(n: number): string {
  return String(Math.max(1, Math.trunc(n)))
    .split('')
    .map((d) => String.fromCharCode(0x2080 + Number(d)))
    .join('');
}

/**
 * Matches a leading fork marker (`<sigil><subscript digits> `). The
 * `u` flag is required: the sigil is outside the BMP and would
 * otherwise be matched as two surrogate halves.
 */
const FORK_TITLE_PREFIX_RE = /^\u{1D523}[\u2080-\u2089]+\s+/u;

/** The title without its fork marker, for re-marking a fork of a fork. */
export function stripForkTitlePrefix(title: string): string {
  return title.replace(FORK_TITLE_PREFIX_RE, '');
}

/**
 * True while a title still carries the fork marker - the signal that
 * the fork has not been renamed for its own direction yet. The chat
 * turn keys its fork framing (the retitle nudge in the metadata
 * message and the wire FORK POINT marker) off this, so both
 * disappear the moment the fork gets a real title.
 */
export function hasForkTitleMarker(title: string): boolean {
  return FORK_TITLE_PREFIX_RE.test(title);
}

/**
 * The FORK POINT line spliced into the chat wire at the inherited/own
 * boundary while the fork's title is still marked. Twin of
 * FORK_POINT_MARKER in supabase/functions/venice/agents/_fork_framing.ts
 * (the browser and Deno islands cannot share modules) - keep the copy
 * in step: it is self-attributing on purpose, because an unexplained
 * instruction-shaped insertion inside conversation content reads as
 * prompt injection to hardened models (see
 * docs/dev/prompt-augmentation.md).
 */
export const FORK_POINT_WIRE_MARKER =
  '==== FORK POINT (marker inserted by nak, the chat app): ' +
  'messages above this line are inherited from the parent conversation; ' +
  'messages below it belong to this conversation ====';

/**
 * Index of the first own-segment row in a resolved transcript, or
 * null when the list carries no inherited rows. Browser twin of the
 * helper in _fork_framing.ts (same island split as the marker above).
 * Rows without a thread_id count as own - framing is additive and
 * must fail toward absence.
 */
export function forkBoundaryIndex(
  rows: ReadonlyArray<{ thread_id?: string | null }>,
  threadId: string
): number | null {
  let sawInherited = false;
  for (let i = 0; i < rows.length; i++) {
    const tid = rows[i].thread_id;
    if (typeof tid === 'string' && tid !== threadId) {
      sawInherited = true;
      continue;
    }
    return sawInherited ? i : null;
  }
  return sawInherited ? rows.length : null;
}

/**
 * Where the chat wire should splice the FORK POINT marker for this
 * turn, or null for "no marker": the title no longer carries the
 * fork marker (the fork has been named - a settled fork reads as
 * fully its own conversation), or the message list holds no
 * inherited rows to demarcate.
 */
export function forkWireMarkerIndex(
  rows: ReadonlyArray<{ thread_id?: string | null }>,
  threadId: string,
  title: string
): number | null {
  if (!hasForkTitleMarker(title)) return null;
  return forkBoundaryIndex(rows, threadId);
}

/**
 * Title for the nth fork minted from one fork point: the source's
 * base title behind the sigil + subscript ordinal. Forking a fork
 * re-marks the BASE title rather than stacking sigils - the marker
 * says "this is a fork, the nth from its point", not the lineage
 * depth (the drawer glyph plus the fork columns carry lineage). The
 * placeholder title passes through unmarked so the auto-title worker
 * still recognizes and names the fork.
 */
export function forkTitle(sourceTitle: string, nthFork: number): string {
  if (sourceTitle === PLACEHOLDER_TITLE) return sourceTitle;
  const base = stripForkTitlePrefix(sourceTitle);
  return `${FORK_TITLE_SIGIL}${subscriptNumber(nthFork)} ${base}`;
}

/** The projection of a message row the fork-point rules need. */
export interface ForkPointCandidate {
  id: string;
  role: string;
  tool_calls: unknown[] | null;
  status: string | null;
}

/**
 * A message can anchor a fork iff the transcript up to and including
 * it is a coherent conversation prefix: a user row, or an assistant
 * row that ends its round. Mid-round assistant rows (carrying
 * tool_calls, whose results come after them) and tool rows would
 * leave the fork's inherited prefix dangling mid-exchange, and a
 * still-streaming assistant row's content is not settled yet - the
 * fork would freeze a partial reply into its shared prefix.
 */
export function isValidForkPoint(m: ForkPointCandidate): boolean {
  if (m.status === 'streaming') return false;
  if (m.role === 'user') return true;
  if (m.role !== 'assistant') return false;
  return !Array.isArray(m.tool_calls) || m.tool_calls.length === 0;
}

/**
 * Pick the fork point for a whole-conversation fork from the thread's
 * own-segment tail, given rows in DESCENDING transcript order (newest
 * first). Walks past invalid tail rows (an in-flight streaming row, a
 * dangling tool row from an interrupted turn) to the most recent row
 * a fork can anchor on. Returns null when no candidate qualifies -
 * the caller falls back to the thread's own inherited fork point (an
 * empty-own-segment fork forks as a sibling) or reports there is
 * nothing to fork.
 */
export function pickForkPoint(
  rowsNewestFirst: readonly ForkPointCandidate[]
): ForkPointCandidate | null {
  for (const m of rowsNewestFirst) {
    if (isValidForkPoint(m)) return m;
  }
  return null;
}
