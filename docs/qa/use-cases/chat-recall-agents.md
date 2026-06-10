# Chat: mid-turn recall agents

## Covers

The model-callable recall agents that spawn sub-agent loops inside
a chat turn - `memory_recall` (agents/recall.ts),
`conversation_recall`, `wiki_recall`, and the umbrella `context`
tool - plus their drawer sources and the `memory_conversation`
seeding that feeds rem's queue
([dev: memory](../../dev/memory.md),
[dev: logging](../../dev/logging.md)).

## Preconditions

- Local stack up, signed in as the dev user, with existing memories
  (any prior reflection/chat history provides them).
- Logs drawer open at `Debug+` to see the agents' input previews.

## Steps

1. Send a message that invites recall, e.g. "Search your memories:
   what do you know about my baking interests? Also check our other
   conversations for anything about flour."
2. Note which tools the model dispatched (the drawer's `stream`
   source lists them). The model often picks the DIRECT tools
   (memory_search / conversation_search / conversation_get); that
   exercises dispatch but not the recall agents.
3. Force an agent: "Use the memory_recall tool (not memory_search)
   to gather what you know about <topic>." Models follow explicit
   tool naming.
4. After the reply settles, check seeding:

   ```sql
   select count(*) from memory_conversation
    where last_seen_at > now() - interval '10 minutes';
   ```

## Expected

- (2) `stream` shows `dispatching 1 tool call(s): <name>` and
  `outcomes: <name>=ok` per round; tool-result rows persist on the
  thread.
- (3) The `recall` source shows a debug start line (message count +
  latest-user-turn preview) and an info summary
  (`recall finished (N tool call(s), M memories surfaced,
  outcome=<kind>)`); `stream` shows `outcomes: memory_recall=ok`.
  The agent's run can take a minute-plus - it is its own model loop.
- (4) `memory_conversation` rows upserted for the surfaced
  memories' source conversations (rem's hint queue).
- `outcome=none` with memories surfaced is VALID: the agent
  surfaced candidates but judged none worth a recall note for the
  topic. Plumbing health is the surfaced/seeded counts, not the
  note kind.

## Cleanup

None - seeded hint rows are rem's normal diet.

## Results log

| Date | Env | Commit | Result | Notes |
| ---- | --- | ------ | ------ | ----- |
| 2026-06-10 | local | 06e9271 | pass (2) | three direct-tool rounds (memory_search, conversation_search, conversation_get) each rendered dispatching/outcomes=ok in `stream` |
| 2026-06-10 | local | 06e9271 | pass (3,4) | forced memory_recall: `[recall]` start preview + `recall finished (7 tool call(s), 12 memories surfaced, outcome=none)` + outcomes=ok; 12 memory_conversation rows seeded |
