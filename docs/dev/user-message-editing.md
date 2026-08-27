# User message editing

An edit button on every user message opens a dropdown with
two choices: **Edit** (destructive, reopens the message in the
composer, runs a new completion that replaces the old turn) and
**Fork and edit** (forks from the preceding message, inserts a
draft row carrying the old text, opens the fork). Edit fixes
typos in place; Fork and edit explores an alternate prompt
while keeping the original conversation. Both reuse the existing
forking and exchange infrastructure.

## Role in the app

Read [`./forking.md`](./forking.md) and [`./chat.md`](./chat.md)
first. This doc assumes their vocabulary: the fork primitive,
the shared-region test, the exchange slot model, the
`supersededIds` contract, and the edit-fork pattern (fork +
hide + swap).

## Files

- `src/lib/ui/draft-message.ts` - `findDraftMessage`, the pure
  scan that powers the reconnection `$effect`.
- `src/lib/ui/completion-status.ts` - `classifyTail`
  excludes `status='draft'` from the cut-off tail check.
- `src/lib/ui/message-blocks.ts` - `buildMessageBlocks` filters
  `status='draft'` rows from the render plan.
- `src/lib/ui/fork.ts` - `deleteForkAnchor`, reused to find the
  fork point before the user message.
- `src/lib/supabase/messages.ts` - `addMessage` (the `status`
  option), `promoteDraftMessage` (the UPDATE that clears
  `status='draft'` to null).
- `src/lib/supabase/threads.ts` - `forkThread` with
  `markTitle: false` (same as delete-from-here and regenerate
  edit-forks).
- `src/screens/Chat.svelte` - the `editFrom` and `forkAndEdit`
  handlers, the send-path branches (`pendingDraftId`,
  `pendingEdit`, fresh send), the reconnection `$effect`, the
  edit dropdown, and the thread-switch cleanup.
- `src/lib/chat/types.ts` - `replaceUserMessageContent` in
  `ChatLoopOptions`.
- `src/lib/chat/loop.ts` - forwards `replaceUserMessageContent`
  into `streamCtx`.
- `src/lib/chat/stream-transport.ts` - spreads
  `replaceUserMessageContent` onto the `/stream` POST body.
- `src/lib/venice.ts` - `replaceUserMessageContent` in
  `streamCtx`.
- `supabase/functions/venice/getStreamingResponse.ts` -
  `OrchestratorOpts.replaceUserMessageContent`, passed to the
  `commit_assistant_message` RPC as
  `p_replace_user_message_content`.
- `supabase/functions/venice/index.ts` - `StreamRequestBody`
  adds the field; `handleStreamFresh` validates and forwards
  it.
- `supabase/schema.sql` - `messages_status_check` (adds
  `'draft'`), the draft-promotion RLS UPDATE policy,
  `commit_assistant_message`'s `p_replace_user_message_content`
  parameter.

## Entry points

Two handlers in `Chat.svelte`, both triggered from the
per-message edit dropdown (a pencil button that opens a small
menu, modeled on the thread-row kebab pattern):

- **`editFrom(userMessageId)`** - the destructive path. Computes
  the range (user message inclusive, everything after), sets
  `pendingDeleteIds` for red highlighting, sets `pendingEdit`,
  loads the old text into the composer.
- **`forkAndEdit(userMessageId)`** - the fork path. Finds the
  preceding anchorable row via `deleteForkAnchor`, forks at it
  (or creates a fresh thread if nothing before the message
  qualifies), inserts a draft row on the fork, selects the fork,
  loads the draft text into the composer.

## Two modes

### Edit: the destructive path

Edit is a hybrid of delete-from-here and regenerate. The range
is the same as delete-from-here: `computeDeleteFromRangeIds`
(user message inclusive, everything after). The completion is
the same as regenerate: `runExchange` with `supersededIds`
pointing at the old range.

**Edit is only offered in the private tail.** If the old user
message is in a shared region (other forks depend on its rows),
the dropdown hides "Edit" and shows only "Fork and edit." The
shared-region test is `sharedRowSet`, fed by the cached
`listChildForkPointIds` - the same test delete-from-here and
regenerate use.

**The atomic edit.** The browser does NOT insert a new user
message before the exchange. Instead, the edited text rides the
`replaceUserMessageContent` field through the chat loop, the
stream transport, and the `/stream` POST body into the venice
edge function's orchestrator. At terminal commit, the
`commit_assistant_message` RPC inserts the new user message +
deletes the old range + commits the assistant reply in one
transaction. On failure (abort, error, guard exhaustion),
nothing was inserted - the edit is a clean no-op. The old
messages survive untouched.

The wire needs the edited text on it so the model sees the new
prompt. `buildEditHistoryOnWire` appends the edited text as a
synthetic user turn at the end of the wire. The real row is
inserted server-side by the commit RPC; this just puts the text
on the wire for the completion.

### Fork and edit: the fork path

The fork point is the message **before** the user message, not
the user message itself. The existing `forkFromMessage` forks
at the user message, which freezes the old text into the fork's
inherited prefix - that would give two user messages in a row
(the inherited old one and the new edited one). Forking before
the user message means the edited text starts the fork's own
segment. The old user message stays in the original
conversation, untouched.

The preceding anchorable row is found with `deleteForkAnchor`
(`src/lib/ui/fork.ts`), which walks past unanchorable rows
(dangling tool rows, mid-round assistants, synthetic recovery
rows). If nothing before the user message qualifies, the fork
is a fresh empty thread with no parent (same fallback
`deleteFromViaFork` uses).

The fork is created with `markTitle: false`, so it inherits the
parent's title verbatim - no sigil, no ordinal. This matches
delete-from-here and regenerate edit-forks: the fork replaces
its source in the UI, so nothing downstream reads it as
provisional.

## Draft messages

A draft is a user message row with `status='draft'`. It exists
only in the fork-and-edit flow, between the click and the send.

**Why drafts.** Without a draft, the fork is created and the
composer is pre-populated from a `$state` string. Navigate away
and the text is gone. A draft row makes the text durable. Come
back to the fork later and the text is still there.

**Lifecycle:**

1. User clicks "Fork and edit."
2. Fork created at the preceding message (`deleteForkAnchor`
   walk).
3. Draft row inserted on the fork: `role=user`,
   `status='draft'`, `content=<old text>`.
4. Fork selected. Composer loads the draft text from the row.
5. User edits in the composer (just `$state`, no DB writes per
   keystroke).
6. User sends. Draft row is promoted: content updated to the
   edited text, status set to null. Completion runs normally on
   the fork.

After promotion, the row is a normal user message. Agents, the
transcript resolver, and the commit RPC see a normal user
message. No filtering needed in any reader.

**Rendering.** Draft rows never render as cards.
`buildMessageBlocks` (`src/lib/ui/message-blocks.ts`) filters
them out, the same way it filters recovery rows. The draft is
invisible in the transcript. The composer is the only surface
that shows the draft text.

**Reconnection.** A `$effect` in `Chat.svelte` watches
`messages.length`. When the user navigates to a thread that has
a draft row (from a previous fork-and-edit they abandoned), the
effect calls `findDraftMessage`. If a draft exists and the
composer is empty, it loads the draft text and sets
`pendingDraftId`. The guard on `pendingDraftId` (early return if
already set) and on `composer.length` (skip if the user is
already typing) prevents wiping in-progress edits. The effect
runs on `messages` change rather than on `activeThreadId`
directly because `selectThread` clears messages to `[]` before
the async fetch resolves - the draft only appears once the fetch
lands.

**Realtime.** The draft INSERT fires a realtime event. Another
tab sees it, but `buildMessageBlocks` filters it, so it is
invisible in the transcript. If both tabs have the fork open,
both composers show the draft text and edits do not sync. Fine
for a single-user app.

The draft promotion UPDATE also fires a realtime event. The
`appendMessage` handler in `Chat.svelte` detects the promotion
(existing row had `status='draft'`, incoming has `status=null`)
and merges the new content + status into the in-memory row.
Without this merge, another tab viewing the fork keeps a stale
draft row in memory (invisible in the transcript, but
`findDraftMessage` keeps matching it).

**The fork exists from the click, not from the send.** If the
user abandons, an empty fork with a draft row is left in the
drawer. This is the same property as the existing
`forkFromMessage`: the user can delete the fork if they do not
want it. Auto-deleting a thread the user might come back to is
riskier than leaving an empty one.

## Send path branches

The `send()` function in `Chat.svelte` has three branches:

- **Pending draft** (`pendingDraftId` set): promote the draft
  row via `promoteDraftMessage` (UPDATE content, clear status),
  then run the completion with `userMessageId` pointing at the
  promoted row. No `supersededIds`. No new user message insert
  (the draft row IS the user message). On pre-exchange failure,
  the catch restores the composer text and clears
  `pendingDraftId`.
- **Pending edit** (`pendingEdit` set): do NOT insert a new
  user message. Set `userMessageId` to the old message id (the
  commit RPC will insert the replacement), set
  `editSupersededIds` from `persistedRowIds` of the old range,
  set `replaceUserMessageContent` to the composer text. Hand off
  to `runExchange`. The `buildHistoryOnWire` filter already
  excludes `pendingDeleteSet` rows from the wire;
  `buildEditHistoryOnWire` appends the edited text as a
  synthetic user turn so the model sees the new prompt.
- **No pending state**: existing fresh send path (insert user
  message, run completion).

These are mutually exclusive. Starting one clears the other's
state: `editFrom` clears `pendingDraftId`; `forkAndEdit` clears
`pendingEdit` and `pendingDeleteIds`.

## Schema changes

Three additions to `supabase/schema.sql`:

1. **`messages_status_check`** adds `'draft'` to the allowed
   status values. Backward-compatible: the old frontend never
   creates drafts, and a draft row in the old frontend renders
   as a normal user message (cosmetic, not broken).

2. **Draft-promotion RLS UPDATE policy.** A second UPDATE policy
   on `messages` (the first covers the `ask_user` suspend/
   resume path on `role='tool'` rows). This one allows UPDATE on
   `role='user' AND status='draft'` rows owned by the user. The
   `USING` clause (entry gate) requires `status='draft'`; the
   `WITH CHECK` clause (exit gate) does NOT gate on status,
   because the promoting UPDATE clears status to null - a
   symmetric check would reject the promotion. This is the
   schema's only asymmetric UPDATE policy: a one-way door built
   in RLS. Settled user messages are client-immutable.

3. **`commit_assistant_message` gains
   `p_replace_user_message_content`** (text, default null). When
   set, the RPC inserts the new user message before doing
   anything else and uses its id as the anchor for the rest of
   the function. The old user message (in `p_superseded_ids`)
   is deleted below. This keeps the insert + delete + commit in
   one transaction so an abort/error before the RPC fires leaves
   nothing in the DB.

## Contracts

- **Drafts are always at the tail.** Only `forkAndEdit` creates
  drafts, and it always creates them at the end of the fork's
  transcript. `findDraftMessage` does a defensive full scan
  rather than assuming the draft is last, but the invariant is
  maintained by construction.

- **`buildHistoryOnWire` filters drafts.** The wire builder
  excludes `status='draft'` rows (alongside
  `pendingDeleteSet` rows) so the model never sees a draft on
  the wire. On the edit path, `buildEditHistoryOnWire` appends
  the edited text as a synthetic user turn instead.

- **`classifyTail` excludes drafts.** A user row
  with `status='draft'` at the tail is an expected state (the
  fork-and-edit flow waiting for the user to send), not a failed
  completion. Without this exclusion, every fork-and-edit fork
  shows a false "response appears to have been cut off" banner.

- **Edit is not regenerate.** Regenerate keeps the user message
  and replaces everything after. Edit replaces the user message
  too. The range is delete-from-here inclusive, not regenerate
  exclusive. The completion runs on a new user message row
  (inserted by the commit RPC), not the old one.

- **Attachments are dropped in v1.** Editing pre-populates text
  only. The old attachments stay linked to the old message. When
  the old message is deleted (destructive edit) or the old
  thread is hidden (fork and edit), the attachments go with it.
  The user can re-attach.

## Interactions

- **Forking** ([`./forking.md`](./forking.md)) - Fork-and-edit
  uses `forkThread` with `markTitle: false` (same as
  delete-from-here and regenerate edit-forks). The fork point is
  `deleteForkAnchor` (the message before the user message, not
  at it). Edit (destructive) uses the shared-region test to gate
  the dropdown.
- **Chat** ([`./chat.md`](./chat.md)) - the send-path branches
  (`pendingDraftId`, `pendingEdit`, fresh send), the edit
  dropdown, `buildHistoryOnWire`'s draft filter,
  `buildEditHistoryOnWire` for the atomic edit.
- **Exchange** ([`./exchange.md`](./exchange.md)) -
  `runExchange` is called the same way for edit as for
  regenerate; `supersededIds` carries the old range;
  `replaceUserMessageContent` rides through the exchange context
  to the commit RPC.
- **Conversation recovery**
  ([`./architecture.md`](./architecture.md),
  "Conversation-recovery synthesis on read") - synthetic
  recovery rows in the edit range are handled by
  `persistedRowIds` (filtered from `supersededIds`) and
  `pendingDeleteIds` (included for in-memory prune). No new
  handling needed.

## Gotchas

- **Name collision with draft threads.** Nak already has "draft
  threads" (URL-only, not in the DB). "Draft messages" are a
  different concept (a `status='draft'` row in the `messages`
  table). Annoying but not blocking.

- **Normal send while a draft exists.** The user clears the
  composer and types something new. The send path checks
  `pendingDraftId`. If set, it promotes the draft with whatever
  text is in the composer. The draft is a vessel. The old text
  was a starting point.

- **Abandoning an edit.** Navigating to another thread clears
  `pendingEdit` and `pendingDeleteIds` (in `selectThread`). The
  old messages are still in the DB. No cleanup needed.

- **Abandoning a fork-and-edit.** The fork stays in the drawer
  with a draft row. The user can delete it. No auto-cleanup.

- **Draft-mode send drops attachments.** The draft-promotion
  branch in `send()` does not link attachments to the message
  row. The attachment upload bytes orphan in Storage until the
  attachment-GC sweep reclaims them. There is no gating that
  disables the attach button during draft mode.

- **The messages table has two UPDATE RLS policies.** The first
  covers the `ask_user` suspend/resume path (`role='tool'` rows).
  The second covers draft promotion (`role='user' AND
  status='draft'` rows). Modifying messages UPDATE policies
  affects both features.
