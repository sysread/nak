# Wiki: direct article + record CRUD from the chat

## Covers

The chat model's direct write access to the wiki
([dev: tools](../../dev/tools.md), "The write toolboxes";
[dev: wiki](../../dev/wiki.md), "Tool toolbox split").
Specifically the chat-dispatched `wiki_create` / `wiki_update` /
`wiki_delete` article tools and the record write tools grouped with
them (`record_create` / `record_update` / `record_delete`), and the
changelog rows every chat-driven write lands. The `wiki_librarian`
delegation living alongside the direct tools is exercised by
[wiki-fleet](./wiki-fleet.md); this case is the direct-write path.

## Preconditions

- Local stack up (`mise run dev-start`), signed in as the dev user.
- A Venice key seeded in `app_config` (the chat turn and the wiki write
  tools call Venice).

## Steps

1. **Create.** Ask:
   `Create a wiki article titled "QA Sandbox" describing this as a
   throwaway test article.` Confirm the model calls `wiki_create` and a
   row lands:

   ```sql
   select id, title, left(content, 60) as body
     from wiki_articles where title = 'QA Sandbox';
   ```

2. Confirm the create wrote a changelog row with the model's reason:

   ```sql
   select kind, message from wiki_changelog
    where article_id = '<article>' order by created_at desc limit 4;
   ```

3. **Update.** Ask: `Add a sentence to the QA Sandbox article noting it
   was created during a QA run.` Confirm `wiki_update` fires and the
   body grew (re-run the step-1 query), and a `update`-kind changelog
   row landed.

4. **Source attribution.** Confirm the current chat thread was attached
   as the article's source automatically (the chat schemas omit
   `source_thread_ids`; the tool attaches `ctx.threadId`):

   ```sql
   select source_thread_ids from wiki_articles where title = 'QA Sandbox';
   ```

5. **Record CRUD.** Ask: `Log a record dated today on the
   QA Sandbox article saying the QA pass ran.` Confirm `record_create`
   fires against the article and a `record_create` changelog row lands:

   ```sql
   select r.date, left(r.content, 60) as body
     from wiki_records r
     join wiki_articles a on a.id = r.article_id
    where a.title = 'QA Sandbox' order by r.date desc;
   ```

6. **Delete.** Ask: `Delete the QA Sandbox article.` Confirm
   `wiki_delete` fires, the row is gone, its records cascade away, and a
   `delete`-kind changelog row survives with the title snapshot:

   ```sql
   select count(*) from wiki_articles where title = 'QA Sandbox';
   select kind, title_at_change, message from wiki_changelog
    where title_at_change = 'QA Sandbox' order by created_at desc limit 1;
   ```

## Expected

- (1) One `wiki_articles` row, title "QA Sandbox", with the model's
  prose body; the tool-call panel shows a `wiki_create` call.
- (2) A `create`-kind `wiki_changelog` row whose `message` is the
  model's one-line reason (imperative voice), not the article body.
- (3) The body gains the requested sentence; a `update`-kind changelog
  row records the edit. Existing content is preserved, not rewritten.
- (4) `source_thread_ids` contains the current chat thread's id - the
  current thread auto-attaches as a source even though the chat schema
  exposes no `source_thread_ids` param.
- (5) One `wiki_records` row on the article dated today; a
  `record_create` changelog row scoped to the article.
- (6) No `wiki_articles` row; the records cascaded; a `delete`-kind
  changelog row remains with `title_at_change = 'QA Sandbox'` (the
  audit trail survives the article).

## Cleanup

- If step 7 didn't run (test aborted earlier), delete the QA Sandbox
  article by hand from the Wiki tab (cascades its records). Remove the
  QA chat threads.

## Results log

| Date | Env | Commit | Result | Notes |
| ---- | --- | ------ | ------ | ----- |
