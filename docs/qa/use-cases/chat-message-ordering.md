# Chat: message ordering - display order, DB order, and the two explicit-placement paths

## Covers

Transcript ordering end to end ([dev: chat](../../dev/chat.md);
recovery synthesis in `src/lib/conversation-recovery.ts`, recovery
persistence in `src/screens/Chat.svelte`). The canonical sort is the
explicit per-thread `position` column: a before-insert trigger
assigns the next tail position when the caller omits one, and
`created_at` is display metadata only. Two code paths place rows
explicitly instead of appending:

1. **Recovery persistence** - synthetic rows healing an interrupted
   tool exchange are written at fractional positions strictly
   between their real neighbors, so they land mid-conversation.
2. **Round-boundary move-to-tail** - the streaming assistant row is
   born before its tool rows and is moved to the thread's tail
   position at the round boundary so the terminal reply sorts after
   them. Its `created_at` keeps the birth time.

This case was the M0 BASELINE for the conversation-forking work's
M1 (explicit message positions - see
[dev: forking](../../dev/forking.md)), executed against
pre-position code with `created_at` as the sort (first results row).
Post-M1 runs must produce the SAME observable transcript order from
the same steps; the queries below read `position` order, which is
what the app now sorts by.

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
          position, created_at
     from messages
    where thread_id = '<thread>'
    order by position, id;
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
      and position > (select position from messages
                       where thread_id = '<thread>'
                         and tool_calls is not null
                         and jsonb_array_length(tool_calls) > 0
                       order by position desc limit 1);
   ```

   Reload the thread and read the transcript tail.

4. **Persist the healed shape.** Send one more ordinary prompt and
   let the reply finish. Re-run the step-1 query, adding the marker
   check:

   ```sql
   select role, left(content, 40) as head,
          content like '%nak:recovery%' as is_recovery,
          position, created_at
     from messages
    where thread_id = '<thread>'
    order by position, id;
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
  reply's `position` is greater than the tool rows' even though
  streaming began before them (the round-boundary move-to-tail).
  Its `created_at` may be EARLIER than the tool rows' - that is the
  honest birth time, deliberately no longer re-stamped, and it must
  not affect the rendered order.
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
  tail. Their `position` values are fractional (strictly between
  the neighbors' integers) while their `created_at` is the heal
  time (recent, later than the rows around them) - position wins.
  The new user prompt and its reply follow them.
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
| 2026-08-21 | local (mise run dev-start) | 8abfe2bc | PASS (1-5) | All five steps pass at the M1 head. Position-based ordering produces the same observable transcript as the M0 baseline. Step 2 confirms the M1 contract: terminal reply position (13) exceeds its tool rows (12) while its created_at (08.43) precedes them - the honest birth time, no longer re-stamped. Step 4 confirms fractional recovery positions (11.333, 11.667) sitting mid-conversation with recent created_at - position wins. Step 5: visible transcript is a correct subsequence of query order (recovery rows filtered by the UI), no error or incomplete-turn banner. Model: Mistral Small (deepseek-v4-flash still leaking think blocks and glitch tokens). |
