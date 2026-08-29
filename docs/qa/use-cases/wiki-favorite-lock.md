# Wiki: favorite-lock blocks agent edits on starred articles

## Covers

The agent-edit lock on favorited wiki articles
([dev: wiki](../../dev/wiki.md), "Favorited articles are locked from
agent edits"). The `wiki_articles.favorite` flag doubles as a lock:
when true, the `wiki_update` and `wiki_delete` tools refuse the call,
the `runWikiManualUpdate` per-article agent returns an error before
running, and the autonomous wiki agent and librarian are instructed
to skip locked articles. The user's own direct edits through the UI
bypass the tools (RLS), so the user can still edit a favorited article
themselves.

## Preconditions

- Local stack up (`mise run dev-start`), signed in as the dev user.
- A Venice key seeded in `app_config` (the chat turn and the wiki
  tools call Venice).
- Know how to open the composer **toolbox popover** to toggle the
  **Wiki** box.
- `SR` = service-role key, `JWT` = the dev user's access token
  (password grant against `/auth/v1/token`), for DB verification.
- If no safe test article exists, create `QA Lock Article` from the
  Wiki tab with a short body and change message `create qa lock
  article`.

## Steps

1. Open the `Wiki` tab, find `QA Lock Article`, and click the **lock**
   button (outline padlock, open shackle). Confirm the padlock closes
   and fills in.

2. Confirm the **Ask agent to update** button is disabled (greyed out)
   and its tooltip reads the lock message.

3. **Direct edit still works.** Click **Edit**, change the body, add a
   change message, and save. The article updates normally - the lock
   only blocks agent-driven writes, not the user's own edits.

4. **Chat-driven wiki_update is refused.** Open a chat thread, enable
   the **Wiki** toolbox, and ask: `Add a sentence to the QA Lock
   article noting it was tested.` Confirm the model calls `wiki_update`
   and the tool call fails with the "favorited (locked)" error. Verify
   the body was NOT changed:

   ```sql
   select left(content, 200) from wiki_articles
    where title = 'QA Lock Article';
   ```

5. **Chat-driven wiki_delete is refused.** In the same thread, ask:
   `Delete the QA Lock article.` Confirm `wiki_delete` fails with the
   "favorited (locked)" error. Verify the row still exists:

   ```sql
   select count(*) from wiki_articles
    where title = 'QA Lock Article';
   ```

6. **Manual agent update is refused.** The "Ask agent to update"
   button is disabled, so confirm the tooltip names the lock. The
   agent cannot run on a locked article.

7. **Unlock re-enables.** Click the lock again to unlock the article.
   The icon changes back to the open-shackle outline. Re-enable the Wiki
   toolbox in chat and ask: `Add a sentence to the QA Lock article
   saying the lock was lifted.` Confirm `wiki_update` succeeds this
   time and the body grew.

8. **Read tools surface the flag.** From a chat thread with the Wiki
   toolbox on, ask: `Search the wiki for "QA Lock".` Confirm the
   `wiki_search` results include a `favorite` field (true while
   locked, false after unlocking). The librarian's article list
   annotates locked articles with `[locked]` - this is covered by
   the Deno unit test in `wiki_librarian.test.ts`, not this case.

## Expected

- (1) The padlock icon changes from an open-shackle outline to a
  filled closed padlock, indicating the article is locked.
- (2) The "Ask agent to update" button is disabled with a tooltip
  naming the lock. The button must not be clickable.
- (3) The user's direct edit succeeds - the body updates and the
  rendered view reflects the change. The lock does not block the
  user.
- (4) The chat model's `wiki_update` tool call fails with an error
  containing "favorited (locked)". The article body is unchanged
  in the DB.
- (5) The chat model's `wiki_delete` tool call fails with an error
  containing "favorited (locked)". The article row still exists.
- (6) The "Ask agent to update" button is disabled with the lock
  tooltip; the agent cannot run on a locked article.
- (7) After unlocking, `wiki_update` succeeds - the body grows by
  the requested sentence. The lock is lifted.
- (8) The `wiki_search` tool returns a `favorite` boolean for each
  hit. While locked, the field is `true`; after unlocking, `false`.

## Cleanup

- If `QA Lock Article` still exists, delete it from the Wiki tab.
- Remove any QA chat threads created during the case.

## Results log

| Date | Env | Commit | Result | Notes |
| ---- | --- | ------ | ------ | ----- |
