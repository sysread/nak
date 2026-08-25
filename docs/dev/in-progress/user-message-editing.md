# User message editing (in progress)

> **Status: planning. No code written.** This doc records the design decisions and footguns found during planning. When the feature ships, graduate durable content into a permanent `docs/dev/user-message-editing.md` and retire this file per the in-progress doc rules in `CLAUDE.md`.

Read [`../forking.md`](../forking.md) and [`../chat.md`](../chat.md) first. This plan assumes their vocabulary: the fork primitive, the shared-region test, the exchange slot model, the supersededIds contract, and the edit-fork pattern (fork + hide + swap).

## SYNOPSIS

Add an edit button to user messages. Two choices in a dropdown: **Edit** (destructive, reopens the message in the composer, runs a new completion replacing the old turn) and **Fork and edit** (forks from the preceding message, opens the fork, pre-seeds the composer with a draft row).

## PURPOSE

Currently you can regenerate an assistant reply or delete from a user message onward. You cannot fix a typo in a prompt without retyping the whole thing. You also cannot tweak a prompt and explore the alternate answer while keeping the original conversation.

Edit gives you the typo-fix path. Fork and edit gives you the explore-alternate path. Both reuse the existing forking and exchange infrastructure.

## DESIGN

### Two modes, one dropdown

An edit button on user messages opens a small dropdown with two items:

- **Edit.** Reopens the message text in the composer. Highlights the old user message and everything after it in red. When the user sends, the old range is deleted and a new completion runs on the edited text. Destructive inside the private tail only.
- **Fork and edit.** Forks from the message before the user message, inserts a **draft** user message row carrying the old text, opens the fork, and loads the draft text into the composer. The user edits and sends normally.

The dropdown is the first per-message dropdown in the chat. The thread-row kebab menu (`Chat.svelte` `openMenuThreadId` pattern) is the closest existing template.

### Edit: the destructive path

Edit is a hybrid of delete-from-here and regenerate. Delete-from-here deletes the user message and everything after, but runs no completion. Regenerate runs a completion but keeps the user message. Edit needs both: delete the old user message and everything after, insert a new user message with the edited text, then run the completion.

The range is the same as delete-from-here: `computeDeleteFromRangeIds` (user message inclusive, everything after). The completion is the same as regenerate: `runExchange` with `userMessageId` pointing at the new user row and `supersededIds` pointing at the old range.

**Edit is only offered in the private tail.** If the old user message is in the shared region (other forks depend on it), the dropdown shows only "Fork and edit." This avoids silently forking on an edit, which the user did not ask for. The shared-region test is the same one delete-from-here and regenerate use: `sharedRowIds` fed by a fresh `listChildForkPointIds` fetch.

### Fork and edit: the fork path

The fork point is the message **before** the user message, not the user message itself. The existing `forkFromMessage` forks at the user message, which freezes the old text into the fork's inherited prefix. Forking there would give two user messages in a row: the inherited old one and the new edited one.

Forking before the user message means the edited text starts the fork's own segment. The old user message stays in the original conversation, untouched. The fork inherits one fewer message than `forkFromMessage` would.

The nearest anchorable row before the user message is found with `deleteForkAnchor` (`src/lib/ui/fork.ts:108`), which walks past unanchorable rows (dangling tool rows, mid-round assistants, synthetic recovery rows). If nothing before the user message qualifies, the fork is a fresh empty thread with no parent (same fallback `deleteFromViaFork` uses).

### Draft messages

A draft is a user message row with `status='draft'`. It exists only in the fork-and-edit flow, between the click and the send.

**Why drafts.** Without a draft, the fork is created and the composer is pre-populated from a `$state` string. Navigate away and the text is gone. A draft row makes the text durable. Come back to the fork later and the text is still there.

**Lifecycle.**

1. User clicks "Fork and edit."
2. Fork created at the preceding message (`deleteForkAnchor` walk).
3. Draft row inserted on the fork: `role=user`, `status='draft'`, `content=<old text>`.
4. Fork selected. Composer loads the draft text from the row, not from the click.
5. User edits in the composer (just `$state`, no DB writes per keystroke).
6. User sends. Draft row is promoted: content updated to the edited text, status set to null. Completion runs normally on the fork.

After promotion, the row is a normal user message. Agents, the transcript resolver, and the commit RPC see a normal user message. No filtering needed in any reader.

**Rendering.** Draft rows never render as cards. `buildMessageBlocks` (`src/lib/ui/message-blocks.ts`) filters them out, the same way it filters recovery rows. The draft is invisible in the transcript. The composer is the only surface that shows the draft text.

**Reconnection on thread switch.** When the user navigates to a thread that has a draft row, the composer loads the draft text and sets `pendingDraftId`. This is a scan on thread switch, not on every messages change (that would wipe the user's edits). The scan runs in a `$effect` that watches `activeThreadId`.

**Realtime.** The draft INSERT fires a realtime event. Another tab sees it. The rendering layer filters it, so it is invisible in the transcript. If both tabs have the fork open, both composers show the draft text and edits do not sync. Fine for a single-user app.

### Schema change

Add `'draft'` to the `messages_status_check` constraint in `schema.sql`:

```sql
alter table public.messages drop constraint if exists messages_status_check;
alter table public.messages
  add constraint messages_status_check
  check (
    status is null
    or status in (
      'streaming',
      'complete',
      'aborted',
      'error',
      'suspended_for_ask_user',
      'draft'
    )
  );
```

Backward-compatible. The old frontend never creates drafts. A draft row in the old frontend renders as a normal user message (cosmetic, not broken). The deploy pipeline's mixed-version window is safe.

No other schema changes. The draft reuses the existing `messages` table, `status` column, and `position` column. No new tables, no new columns.

### Send path branches

The `send()` function currently always does a fresh send. It needs three branches:

- **Pending draft** (`pendingDraftId` set): promote the draft row (update content, clear status), then run the completion. No supersededIds. No new user message insert (the draft row IS the user message).
- **Pending edit** (`pendingEdit` set): insert a new user message with the edited text, set `pendingDeleteIds` to the old range, run the completion with `supersededIds`. The `buildHistoryOnWire` filter already excludes `pendingDeleteSet` rows from the wire.
- **No pending state**: existing fresh send path.

These are mutually exclusive. Starting one clears the other's state.

### Edit state management

A `pendingEdit` object tracks the destructive edit in progress:

```ts
interface PendingEdit {
  /** The user message being replaced. */
  oldMessageId: string;
  /** Everything from the old message onward. */
  rangeIds: string[];
}
```

Set on "Edit" click. Cleared on send, on abandon (navigate away, clear composer and type something new), or on starting a different edit.

The red highlighting uses the existing `pendingDeleteIds` channel. The old user message is included in the range and gets the same `.regen-target` class as everything after it. One highlight language, same as regenerate and delete-from-here.

### The fork-and-edit fork is created immediately

The fork exists from the click, not from the send. If the user abandons, an empty fork with a draft row is left in the drawer.

This is the same property as the existing `forkFromMessage`: a pure fork creates a thread immediately. The user can delete the fork if they do not want it. Auto-deleting a thread the user might come back to is riskier than leaving an empty one.

### Attachments

Editing pre-populates text only in v1. The old attachments stay linked to the old message. When the old message is deleted (destructive edit) or the old thread is hidden (fork and edit), the attachments go with it.

Restoring attachments would mean copying attachment rows to the new message id or re-uploading the files. Both are extra work for v1. The user can re-attach.

## Decisions made

1. **Edit in shared region: disable, offer only Fork and edit.** Edit is destructive and can only run in the private tail. When the old message is shared, the dropdown shows one item. This is more explicit than silently forking and matches the user's mental model: "edit" means "change this in place," and if that is not possible, say so.

2. **Old user message gets red highlight too.** The old message is being deleted. It gets the same `.regen-target` class as everything after it. The composer shows the new text. The transcript shows the old text marked as going away. Clearer than leaving it looking normal.

3. **Fork and edit forks before the user message.** The old user message stays in the original conversation. The edited text starts the fork's own segment. Forking at the user message would freeze the old text into the fork's inherited prefix, giving two user messages in a row.

4. **Drafts for fork-and-edit only.** The destructive edit path uses the pre-populate-and-highlight approach (no draft). Drafts require "always at the end of the conversation," which breaks if the red-highlighted range is after the draft's position. Fork-and-edit has no red range, so the draft sits cleanly at the tail.

## Footguns

- **Edit is not regenerate.** Regenerate keeps the user message and replaces everything after. Edit replaces the user message too. The range is delete-from-here inclusive, not regenerate exclusive. The completion runs on a new user message row, not the old one.

- **Synthetic recovery rows in the edit range.** `persistedRowIds` filters them from `supersededIds` (sentinel ids are not uuids). They stay in `pendingDeleteIds` for the in-memory prune. Same handling as regenerate. No new issue, but worth knowing.

- **The supersede range includes the old user message.** `commit_assistant_message` already excludes the anchor (`id <> p_user_message_id`) from the delete. The RPC handles this correctly. No change needed.

- **Name collision with draft threads.** Nak already has "draft threads" (URL-only, not in the DB). "Draft messages" are a different concept. Annoying but not blocking.

- **Normal send while a draft exists.** The user clears the composer and types something new. The send path checks `pendingDraftId`. If set, it promotes the draft with whatever text is in the composer. The draft is a vessel. The old text was a starting point.

- **Mutual exclusivity.** Edit sets `pendingEdit`. Fork-and-edit sets `pendingDraftId`. The send path has three branches. Clicking one clears the other's state.

- **Abandoning an edit.** Navigating to another thread clears `pendingEdit` and the red highlighting. The old messages are still in the DB. No cleanup needed.

- **Abandoning a fork-and-edit.** The fork stays in the drawer with a draft row. The user can delete it. No auto-cleanup.

## Interactions

- **Forking** ([`../forking.md`](../forking.md)) - Fork-and-edit uses the `forkThread` primitive with `markTitle: false` (same as delete-from-here and regenerate edit-forks). The fork point is the message before the user message, found by `deleteForkAnchor`. Edit (destructive) uses the shared-region test to gate the dropdown. The test is `sharedRowIds` fed by a fresh `listChildForkPointIds` fetch.
- **Chat** ([`../chat.md`](../chat.md)) - the send path branches, the composer pre-population, the red highlighting channel (`pendingDeleteIds`), and the `buildHistoryOnWire` filter.
- **Exchange** ([`../exchange.md`](../exchange.md)) - `runExchange` is called the same way for edit as for regenerate. `supersededIds` carries the old range. The slot lifecycle is unchanged.
- **Conversation recovery** ([`../architecture.md`](../architecture.md), "Conversation-recovery synthesis on read") - synthetic recovery rows in the edit range are handled by `persistedRowIds` (filtered from supersededIds) and `pendingDeleteIds` (included for in-memory prune). No new handling needed.

## Baseline tests

The feature touches code at two layers. The pure UI primitives (range computation, fork-point validation, shared-region test) are already well covered by vitest. The data-layer fork primitive (`forkThread`) has zero coverage. That is the gap to close before building.

### Already covered (no baseline needed)

These exports are tested and their contracts are pinned. The feature reuses them as-is:

- `computeRegenerateRangeIds`, `persistedRowIds` - `tests/regenerate.test.ts` (5 tests)
- `computeDeleteFromRangeIds` - `tests/message-delete.test.ts` (4 tests)
- `sharedRowIds`, `deleteForkAnchor`, `canForkAtMessage`, `computeForkRangeIds`, `deleteFromTitle`, `regenerateTitle` - `tests/fork-range.test.ts` (16 tests)
- `isValidForkPoint`, `pickForkPoint`, `forkTitle` - `tests/forking.test.ts` + `tests/fork-wire-marker.test.ts` (16 tests)
- `buildMessageBlocks` - `tests/message-blocks.test.ts` (comprehensive: tool folding, recovery-row hiding, hidden tools, rename, generated-image, ask-user)

### Uncovered: forkThread (`src/lib/supabase/threads.ts:472`)

Zero test coverage. The function takes a `SupabaseClient` and is testable against a stubbed client the same way `tests/thread-search-and-pagination.test.ts` stubs the facade. Baseline tests needed before M2:

1. Explicit `forkMsgId` branch: forks at the given message, parent is the message's owning thread.
2. `markTitle: false` branch: title is verbatim, no sigil, no ordinal count query.
3. Reparent rule: when the fork-point message is owned by an ancestor (not the source thread), the parent is the ancestor.
4. Whole-conversation fork (no `forkMsgId`): walks the segment tail via `pickForkPoint`, falls back to the source's own fork point when the segment is empty.
5. Error cases: source thread not found, fork-point message not found, invalid fork point (streaming, mid-round, tool row).

### Uncovered: Chat.svelte send path

No test mounts `Chat.svelte`. The established pattern is to extract pure logic into `src/lib/ui/<feature>.ts` and test there (the "Svelte components are glue" rule in CLAUDE.md). The edit feature will add logic to the send path and the thread-switch effect. Extract the testable parts:

- A `findDraftMessage(messages)` primitive that scans a message list for a `status='draft'` row. Tested in `tests/`. Used by the thread-switch `$effect` in Chat.svelte.
- A `computeEditRangeIds(messages, userMessageId)` primitive (wraps `computeDeleteFromRangeIds`, which already exists and is tested). If the range is identical to delete-from-here, this may not need a new function. But the edit handler also needs to compute the supersede range (same range) and check the shared-region gate. If any of that logic is non-trivial, extract and test it.

## Milestones

### M1: Baseline tests + schema + draft type

Land the foundation: tests for `forkThread`, the schema change, the draft status on the Message type, and the draft-row filter in `buildMessageBlocks`.

**Baseline tests for forkThread.** Write `tests/fork-thread.test.ts` stubbing the `SupabaseClient` (same pattern as `tests/thread-search-and-pagination.test.ts`). Cover the five cases above. This pins the contract M2 leans on.

**Schema.** Add `'draft'` to `messages_status_check` in `schema.sql`. Backward-compatible (old frontend never creates drafts; a draft row renders as a normal user message in the old frontend).

**Message type.** Add `'draft'` to the `status` union in `src/lib/supabase/types/chat.ts`.

**Draft-row filter in buildMessageBlocks.** Add a filter branch parallel to the recovery-row filter at `src/lib/ui/message-blocks.ts:180`. Mirror the recovery-row test block in `tests/message-blocks.test.ts`: a draft row does not emit a block, and a non-draft row after a draft row still renders normally.

**Tests.** New test block in `tests/message-blocks.test.ts` for the draft filter: single draft at tail, draft mid-conversation (should not happen but the filter should still work), no draft in a normal list.

### M2: Fork and edit

Land the fork-and-edit flow end to end. This is the simpler path: no supersededIds, no pendingEdit state, no red highlighting. The send is a normal fresh send on the fork.

**forkAndEdit handler in Chat.svelte.** On "Fork and edit" click:
1. Find the preceding anchorable row via `deleteForkAnchor`.
2. Fork at that row via `app.supabase.forkThread(active.id, anchor.id, { markTitle: false })`. If no anchor (first message), create a fresh thread via `createThread` with the parent's title and pins (same fallback as `deleteFromViaFork`).
3. Insert a draft row on the fork: `app.supabase.addMessage(fork.id, 'user', oldText)` with `status='draft'`. This needs `addMessage` to accept an optional `status` parameter, or a new `addDraftMessage` method.
4. Select the fork.
5. Load the draft text into the composer and set `pendingDraftId`.

**findDraftMessage primitive.** Extract to `src/lib/ui/`. A pure function that scans a message list for a row with `status='draft'` and returns it (or null). Tested in `tests/`.

**Reconnection on thread switch.** A `$effect` watching `activeThreadId` calls `findDraftMessage(messages)`. If a draft exists and the composer is empty, load the draft text and set `pendingDraftId`. If the composer already has text (the user is mid-edit), do nothing.

**Send path: pending draft branch.** In `send()`, check `pendingDraftId` before the fresh-send path. If set, promote the draft: `UPDATE messages SET content = <composer text>, status = null WHERE id = <pendingDraftId>`. Then call `runExchange` with `userMessageId = pendingDraftId`. No `supersededIds`. Clear `pendingDraftId`.

**Clear pendingEdit.** Starting a fork-and-edit clears any pending edit state. Mutually exclusive.

### M3: Edit (destructive)

Land the destructive edit flow. This is the more complex path: pendingEdit state, red highlighting, supersededIds, and the shared-region gate on the dropdown.

**Edit dropdown UI.** Add an edit button to the user-message action row in `Chat.svelte` (lines 7979-8079). The button opens a small dropdown with two items: "Edit" and "Fork and edit." Model the dropdown on the thread-row kebab menu pattern (`openMenuThreadId` -> `openEditMenuMsgId`).

**Shared-region gate.** Before showing the dropdown, check if the user message is in the shared region. Use the cached `sharedRowSet` for the tooltip-level gate (same as delete-from-here and regenerate). If shared, show only "Fork and edit." If not, show both.

**editFrom handler in Chat.svelte.** On "Edit" click:
1. Compute the range: `computeDeleteFromRangeIds(messages, userMessageId)`.
2. Set `pendingDeleteIds` to the range (drives the red highlighting).
3. Set `pendingEdit = { oldMessageId, rangeIds }`.
4. Load the old message text into the composer.
5. Focus the composer.

**Send path: pending edit branch.** In `send()`, check `pendingEdit` before the fresh-send path. If set:
1. Insert a new user message via `persistUserTurn(threadId, composerText, [])`.
2. Call `runExchange` with `userMessageId = newMsg.id` and `supersededIds = persistedRowIds(messages, pendingEdit.rangeIds)`.
3. The `buildHistoryOnWire` filter already excludes `pendingDeleteSet` from the wire.
4. Clear `pendingEdit` and `pendingDeleteIds` on success (same fade-out-and-prune path as regenerate).

**Clear pendingDraftId.** Starting an edit clears any pending draft state. Mutually exclusive.

**Abandon.** Navigating to another thread clears `pendingEdit` and `pendingDeleteIds`. The old messages are still in the DB.

### M4: QA use cases

Write and execute QA use cases. Baseline discipline: re-execute existing cases first to confirm zero behavior change, then execute the new cases.

**Baselines to re-execute (confirm zero regression):**
- `chat-delete-from-here.md` - destructive delete in the private tail. The edit path reuses the same range. Must not change.
- `chat-regenerate-from-here.md` - regenerate. The edit path reuses `runExchange` and `supersededIds`. Must not change.
- `threads-edit-fork.md` - shared-region delete and regenerate fork. The edit dropdown's shared-region gate must not change this behavior.
- `threads-fork-from-message.md` - per-message fork button. The edit button sits in the same action row. Must not change fork behavior.

**New use case: `chat-edit-user-message.md`**
- Covers: the edit dropdown on user messages, "Edit" in a private tail (composer pre-population, red highlighting of old message + everything after, send replaces the range), shared-region gate (only "Fork and edit" shown), abort/error restore, edit on a message with attachments (attachments dropped in v1).
- Preconditions: local stack, a thread with at least three completed turns.
- Key steps: click Edit on a middle user message, observe red highlighting, edit the text, send, verify the old range is gone from DB and the new completion landed. Click Edit on a shared message, verify only "Fork and edit" is offered. Abandon an edit (navigate away), verify red highlighting clears and old messages survive.

**New use case: `chat-fork-and-edit.md`**
- Covers: "Fork and edit" from the dropdown, fork creation at the preceding message, draft row inserted (invisible in transcript), composer pre-populated from draft, send promotes the draft and runs completion, navigate-away-and-return preserves draft text, abandoning leaves an empty fork in the drawer.
- Preconditions: local stack, a thread with at least two completed turns.
- Key steps: click "Fork and edit" on a middle user message, verify a new thread appears in the drawer, verify the composer has the old text, verify the transcript shows the inherited prefix only (no draft card). Edit the text and send. Verify the completion runs on the fork. Verify the fork owns one user message (the promoted draft) plus the assistant reply. Navigate away before sending, come back, verify the draft text is still in the composer.

## Open questions

- **Per-keystroke draft persistence.** Should the draft row update on every keystroke (durable but chatty) or only on send (less durable but simpler)? v1: only on send. The draft text in the composer is a `$state` string. If the user navigates away mid-edit, the draft row still has the original text and the composer reloads from it on return. Keystroke-level edits are lost on navigate.

- **Discard draft button.** Should the composer show a "discard draft" affordance when `pendingDraftId` is set? v1: no. The user can delete the fork from the drawer. Adding a discard button is a nice-to-have.

- **Edit on a message with attachments.** v1 drops the attachments. The user can re-attach. A v2 could copy attachment rows to the new message or re-upload. Not blocking.

- **addMessage with status.** The draft row insert needs `addMessage` to accept an optional `status` parameter, or a new `addDraftMessage` method on the facade. The existing `addMessage` in `src/lib/supabase/messages.ts` inserts with `status: null` by default. Adding a status parameter is a small change but touches the messages slice. Decide during M2 implementation.
