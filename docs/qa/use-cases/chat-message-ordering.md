# Chat: message ordering - display order, DB order, and the two forged-timestamp paths

## Covers

Transcript ordering end to end ([dev: chat](../../dev/chat.md);
recovery synthesis in `src/lib/conversation-recovery.ts`, recovery
persistence in `src/screens/Chat.svelte`). Today the canonical sort
is `created_at`. All rows get the DB clock at insert (the column
defaults to now() server-side); only two code paths write
runtime-clock values, forging timestamps to control placement:

1. **Recovery persistence** - synthetic rows healing an interrupted
   tool exchange are written with a forged
   `created_at = neighbor + 1ms` so they land mid-conversation.
2. **Round-boundary re-stamp** - the streaming assistant row is
   born before its tool rows and gets its `created_at` re-stamped
   so the terminal reply sorts after them.

This case is the BASELINE for the conversation-forking work's M1
(explicit message positions - see
`docs/dev/in-progress/conversation-forking.md`). Execute it against
unchanged code first; after M1 the same steps must produce the same
observable order, with the canonical sort switched to `position`.

## Preconditions

- Local stack up (`mise run dev-start`), signed in as the dev user
  (`dev@nak.local` / `devpass123`).
- A fresh thread for this case. Note its id (`<thread>`).
- One prompt known to trigger a tool call. A memory-recall ask
  fires reliably ("Search my memories for anything about X and tell
  me what you find" - `memory_search` is always-on). Do NOT use the
  venice-native web-search toggle to satisfy this: it produces
  citations with NO tool_calls rows, which silently breaks the
  step-3 forge (the subquery finds nothing and deletes nothing).
- SQL access via `mise run dev-sql` (or psql to 127.0.0.1:54322).

## Steps

1. **Normal append ordering.** Send three ordinary prompts (no
   tools) and let each reply finish. Run:

   ```sql
   select role, left(content, 30) as head,
          created_at
     from messages
    where thread_id = '<thread>'
    order by created_at, id;
   ```

   Compare the row order against the transcript on screen, top to
   bottom.

2. **Tool-round ordering.** Send the tool-triggering prompt and let
   the turn finish completely. Re-run the step-1 query.

3. **Forge an interrupted tool exchange.** Using the step-2 turn's
   rows, delete the tool result row(s) and the terminal assistant
   reply, leaving the assistant-with-tool_calls row as the thread
   tail:

   ```sql
   delete from messages
    where thread_id = '<thread>'
      and created_at > (select created_at from messages
                         where thread_id = '<thread>'
                           and tool_calls is not null
                           and jsonb_array_length(tool_calls) > 0
                         order by created_at desc limit 1);
   ```

   Reload the thread and read the transcript tail.

4. **Persist the healed shape.** Send one more ordinary prompt and
   let the reply finish. Re-run the step-1 query, adding the marker
   check:

   ```sql
   select role, left(content, 40) as head,
          content like '%nak:recovery%' as is_recovery,
          created_at
     from messages
    where thread_id = '<thread>'
    order by created_at, id;
   ```

5. **Cross-reader agreement.** With the thread now containing
   mid-transcript recovery rows, reload the app once more and
   confirm the on-screen transcript order still matches the step-4
   query order exactly.

## Expected

- (1) The query order and the on-screen order are identical:
  user/assistant alternating, three turns. No row renders in a
  different position than the query reports.
- (2) The tool turn reads, in both the query and on screen:
  user prompt, assistant row carrying tool_calls, one tool row per
  call, terminal assistant reply - in that order. The terminal
  reply's `created_at` is later than the tool rows' even though
  streaming began before them (the round-boundary re-stamp).
- (3) The reloaded tail shows the tool-group card with a
  synthesized "(tool execution was interrupted...)" result folded
  in - not an error, and not a raw dangling tool-call card. No
  separate recovery note renders: the UI deliberately filters
  recovery rows (see the block comment in
  `src/lib/ui/message-blocks.ts` - they read as noise to the user),
  so the synthesis is visible only through the healed tool card.
  Nothing new is in the DB yet - the step-1 query still shows the
  assistant-with-tool_calls row as the last row.
- (4) The recovery rows are now persisted (`is_recovery = true`)
  and sit BETWEEN the assistant-with-tool_calls row and the new
  user prompt in the query order - mid-conversation, not at the
  tail. The new user prompt and its reply follow them.
- (5) The visible transcript is the step-4 query order with the
  recovery rows omitted: every NON-recovery row renders, in the
  same relative order the query reports (a correct subsequence).
  The persisted recovery rows themselves never render - the same
  UI filter as (3) - and no error or incomplete-turn banner
  appears.

## Cleanup

Delete the thread (drawer kebab, Delete) - the forge left it with
synthetic content not worth keeping.

## Results log

| Date | Env | Commit | Result | Notes |
| ---- | --- | ------ | ------ | ----- |
| 2026-08-21 | local (mise run dev-start) | f5e6c90b | PARTIAL | Steps 1-4 pass (append order, tool-round re-stamp, forge + synthesis-on-read, neighbor+1ms persistence all verified). Step 5 fails as written: the UI deliberately filters recovery rows (message-blocks.ts), so on-screen order is a correct subsequence of query order, never an exact match - Expected (3)'s italicised-note disjunct and Expected (5) need restating to what renders. Env note: deepseek-v4-flash leaked glitch tokens repeatedly (guard retries visible); Mistral Small used for later turns. |
