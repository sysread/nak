// Fork framing for transcripts that background agents read. A forked
// thread's resolved transcript opens with rows inherited from its
// fork ancestors; a model replaying it needs that boundary explained,
// and the explanation must be provenance-marked: an injection-hardened
// model that meets an unexplained instruction-shaped insertion inside
// conversation content flags it as prompt injection (see
// docs/dev/prompt-augmentation.md, "Provenance markers and fourth-wall
// framing"). Both lines here therefore name nak as their source and
// stay descriptive rather than imperative.
//
// Applied by the two shared transcript loaders (loadThreadSliceUpTo in
// ./_agent_tools.ts, loadThreadSlice in ./_recall_helpers.ts) so every
// transcript-replaying agent gets the same framing, and bespoke by the
// two readers that build their own payloads (bias, conversation_get).
// The live chat wire is deliberately NOT framed: to the user and the
// responding model, the fork IS the conversation.

import type { StoredMessage } from './_recall_helpers.ts';

/**
 * The boundary line, inserted between the last inherited row and the
 * first own-segment row. Self-attributing on purpose: this line can
 * survive transcript trimming that drops the preamble, so it must
 * authenticate itself.
 */
export const FORK_POINT_MARKER =
  '==== FORK POINT (marker inserted by nak, the chat app): ' +
  'messages above this line are inherited from the parent conversation; ' +
  'messages below it belong to this conversation ====';

/**
 * The preamble line placed above the transcript. `taskClause` lets a
 * worker append its own one-sentence reading instruction (summary:
 * "cover the whole conversation"; bias: "only cite below the marker");
 * without one the preamble stays purely descriptive.
 */
export function forkPreamble(parentTitle: string, taskClause?: string): string {
  const base =
    'Note from nak, the chat application: this conversation was forked from ' +
    `"${parentTitle}". Messages above the FORK POINT marker are inherited ` +
    'from that parent conversation - history the two conversations share ' +
    'up to the fork.';
  return taskClause ? `${base} ${taskClause}` : base;
}

/**
 * Index of the first own-segment row in a resolved transcript, or null
 * when the slice carries no inherited rows (a root thread, or a slice
 * whose trimming dropped the whole prefix - either way there is no
 * boundary to mark). The resolver's row order is (ancestor segments,
 * then own segment), so the first row whose thread_id matches the
 * requested thread is the boundary; rows.length means the slice is
 * inherited rows only (an empty own segment). Rows without a thread_id
 * (test stubs, projections that omit it) count as own - framing is
 * additive and must fail toward absence.
 */
export function forkBoundaryIndex(
  rows: ReadonlyArray<{ thread_id?: string | null }>,
  threadId: string,
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
 * Minimal client surface for the parent-title point read, structural
 * so test stubs satisfy it without pulling in the full supabase-js
 * types.
 */
export type TitleClient = {
  from: (table: string) => {
    select: (cols: string) => {
      eq: (
        col: string,
        val: string,
      ) => {
        maybeSingle: () => PromiseLike<{ data: unknown; error: unknown }>;
      };
    };
  };
};

/**
 * Title of the direct parent, for the preamble. Best-effort: framing
 * is additive context and must never fail an agent run, so any read
 * failure degrades to a generic phrase.
 */
export async function fetchParentTitle(
  client: TitleClient,
  parentThreadId: string,
): Promise<string> {
  try {
    const { data } = await client
      .from('threads')
      .select('title')
      .eq('id', parentThreadId)
      .maybeSingle();
    const title = (data as { title?: unknown } | null)?.title;
    if (typeof title === 'string' && title.trim().length > 0) return title;
  } catch {
    // Fall through to the generic phrase - a missing title only costs
    // the preamble its specificity.
  }
  return 'an earlier conversation';
}

/**
 * Frame a resolved transcript slice: preamble row at the head, marker
 * row at the inherited/own boundary. Returns the slice unchanged when
 * it carries no inherited rows, so root threads (the overwhelmingly
 * common case) pay one array scan and nothing else. The synthetic
 * rows ride as role='system' StoredMessages with non-uuid ids, which
 * every downstream consumer treats as inert content: the wire
 * projections pass system rows through, the condense/trim helpers
 * treat system as a valid turn boundary, and no caller looks up rows
 * by these ids.
 */
export async function applyForkFraming(
  client: TitleClient,
  threadId: string,
  rows: StoredMessage[],
  opts: { taskClause?: string } = {},
): Promise<StoredMessage[]> {
  const boundary = forkBoundaryIndex(rows, threadId);
  if (boundary === null) return rows;
  // The last inherited row belongs to the deepest ancestor segment in
  // the slice, which is the direct parent whenever the parent's rows
  // survived trimming - and a nearer ancestor otherwise, whose title
  // is still the honest "forked from" ancestor to name.
  const parentId = rows[boundary - 1]?.thread_id;
  const parentTitle =
    typeof parentId === 'string'
      ? await fetchParentTitle(client, parentId)
      : 'an earlier conversation';
  const preamble: StoredMessage = {
    id: 'nak-fork-preamble',
    role: 'system',
    content: forkPreamble(parentTitle, opts.taskClause),
    tool_calls: null,
    tool_call_id: null,
    name: null,
  };
  const marker: StoredMessage = {
    id: 'nak-fork-marker',
    role: 'system',
    content: FORK_POINT_MARKER,
    tool_calls: null,
    tool_call_id: null,
    name: null,
  };
  return [preamble, ...rows.slice(0, boundary), marker, ...rows.slice(boundary)];
}
