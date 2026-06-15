# Memories: browse, edit, relate, and recall visibility

## Covers

Memory browse/search/filter UI ([dev: memory](../../dev/memory.md),
[dev: topics](../../dev/topics.md)), memory action tools
([dev: memory](../../dev/memory.md)), and the recall disclosure surfaces
([dev: context-recall](../../dev/context-recall.md),
[dev: conversation-recall](../../dev/conversation-recall.md)).

## Preconditions

- Local stack up (`mise run dev-start`), signed in as the dev user.
- At least two existing memories for the account. If the account has none,
  create them with SQL:

  ```sql
  insert into memories (user_id, label, data, topics)
  select id, 'QA memory alpha', 'Prefers concise, direct answers.', array['qa-memory']
    from auth.users where email = 'dev@nak.local';

  insert into memories (user_id, label, data, topics)
  select id, 'QA memory beta', 'Works late; has a cat named Pixel.', array['qa-memory']
    from auth.users where email = 'dev@nak.local';
  ```

- A chat thread available for the recall-lightbulb check.

## Steps

1. Open the `Memories` tab and search for `QA memory`.
2. Open one matching memory and reload the page.
3. In `Memories`, open `Topics`, select `qa-memory`, then remove the
   filter with its pill `×`.
4. Click `Edit` on the opened memory, change the body text, and try to
   save without a change message.
5. Add a change message, save, and wait for the save state to settle.
6. Click `Reaffirm`, then click `Doubt` after the first action settles.
7. Click `+ Relate`, search for the other QA memory, create a
   `supports` relation, then remove that relation.
8. Expand `Similar memories`.
9. In a chat thread, ask the assistant about `QA memory alpha` in a way
   likely to trigger recall, then click the recall light-bulb icon on the
   resulting assistant message.
10. Return to `Memories`, click `Delete` on the edited QA memory, supply
    `QA cleanup` as the reason, and confirm the delete.

## Expected

- (1-2) Search returns semantic / substring matches for the QA memory; the
  opened memory remains selected after reload.
- (3) The topic picker filters the list, selection appears as a pill, and
  removing the pill restores the unfiltered list.
- (4-5) Save is blocked without a change message; after adding one, the
  UI passes through `Saving…` to `Saved ✓`, and the edited body persists.
- (6) `Reaffirm` and `Doubt` run one at a time, show in-flight button
  states, and update the memory's visible confidence treatment.
- (7) The new relation appears inline under the memory body, then
  disappears after removal.
- (8) `Similar memories` lazy-loads only when expanded; it either shows
  neighbors with score pills or an explicit empty state.
- (9) The light-bulb opens a recall modal showing the injected recall text
  and trigger metadata for that turn.
- (10) Delete requires the reason, removes the row from the list, and does
  not delete unrelated memories.

## Cleanup

- Delete any leftover `QA memory alpha` / `QA memory beta` rows if they
  were created only for this case.

  ```sql
  delete from memories
   where label like 'QA memory %';
  ```

## Results log

| Date | Env | Commit | Result | Notes |
| ---- | --- | ------ | ------ | ----- |
