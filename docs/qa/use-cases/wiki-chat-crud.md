# Wiki: direct article + record CRUD from the chat

## Covers

The chat model's direct write access to the wiki, gated behind the
single **`wiki`** toolbox ([dev: tools](../../dev/tools.md), "The gated
write boxes"; [dev: wiki](../../dev/wiki.md), "Tool toolbox split").
Specifically the chat-dispatched `wiki_create` / `wiki_update` /
`wiki_delete` article tools and the record write tools that now share
the same toolbox (`record_create` / `record_update` / `record_delete`).
Also covers the gating contract - none of these writes are on the wire
until the `wiki` toolbox is enabled - and the changelog rows every
chat-driven write lands. The `wiki_librarian` delegation living
alongside the direct tools is exercised by
[wiki-fleet](./wiki-fleet.md); this case is the direct-write path.

## Preconditions

- Local stack up (`mise run dev-start`), signed in as the dev user.
- A Venice key seeded in `app_config` (the chat turn and the wiki write
  tools call Venice).
- Know how to open the composer **toolbox popover** (the toolbox icon in
  the composer toolbar) to toggle the **Wiki** box.

## Steps

1. **Gating off (control).** In a fresh chat thread with NO toolboxes
   enabled, ask: `Create a wiki article titled "QA Sandbox" about this
   test.` Confirm the model does NOT write - it has no `wiki_create` on
   the wire, so it should say it cannot or offer to enable the toolbox,
   and no row lands:

   ```sql
   select count(*) from wiki_articles where title = 'QA Sandbox';
   ```

2. **Create.** Open the toolbox popover, check **Wiki**, then ask:
   `Create a wiki article titled "QA Sandbox" describing this as a
   throwaway test article.` Confirm the model calls `wiki_create` and a
   row lands:

   ```sql
   select id, title, left(content, 60) as body
     from wiki_articles where title = 'QA Sandbox';
   ```

3. Confirm the create wrote a changelog row with the model's reason:

   ```sql
   select kind, message from wiki_changelog
    where article_id = '<article>' order by created_at desc limit 4;
   ```

4. **Update.** Ask: `Add a sentence to the QA Sandbox article noting it
   was created during a QA run.` Confirm `wiki_update` fires and the
   body grew (re-run the step-2 query), and a `update`-kind changelog
   row landed.

5. **Source attribution.** Confirm the current chat thread was attached
   as the article's source automatically (the chat schemas omit
   `source_thread_ids`; the tool attaches `ctx.threadId`):

   ```sql
   select source_thread_ids from wiki_articles where title = 'QA Sandbox';
   ```

6. **Record CRUD (same toolbox).** Ask: `Log a record dated today on the
   QA Sandbox article saying the QA pass ran.` Confirm `record_create`
   fires against the article and a `record_create` changelog row lands:

   ```sql
   select r.date, left(r.content, 60) as body
     from wiki_records r
     join wiki_articles a on a.id = r.article_id
    where a.title = 'QA Sandbox' order by r.date desc;
   ```

7. **Delete.** Ask: `Delete the QA Sandbox article.` Confirm
   `wiki_delete` fires, the row is gone, its records cascade away, and a
   `delete`-kind changelog row survives with the title snapshot:

   ```sql
   select count(*) from wiki_articles where title = 'QA Sandbox';
   select kind, title_at_change, message from wiki_changelog
    where title_at_change = 'QA Sandbox' order by created_at desc limit 1;
   ```

8. **Model self-enable.** In a fresh thread with the Wiki box OFF, ask a
   write-shaped request: `Start a wiki article about my QA workflow.`
   Confirm the model flips the Wiki toolbox on itself via
   `toggle_toolbox` (the toolbox button pulses) and then writes, rather
   than refusing.

## Expected

- (1) No `wiki_articles` row for "QA Sandbox"; the model has no write
  tool and says so / offers to enable the toolbox. This is the gating
  tripwire - a write landing here means the toolbox split leaked.
- (2) One `wiki_articles` row, title "QA Sandbox", with the model's
  prose body; the tool-call panel shows a `wiki_create` call.
- (3) A `create`-kind `wiki_changelog` row whose `message` is the
  model's one-line reason (imperative voice), not the article body.
- (4) The body gains the requested sentence; a `update`-kind changelog
  row records the edit. Existing content is preserved, not rewritten.
- (5) `source_thread_ids` contains the current chat thread's id - the
  current thread auto-attaches as a source even though the chat schema
  exposes no `source_thread_ids` param.
- (6) One `wiki_records` row on the article dated today; a
  `record_create` changelog row scoped to the article. Record writes
  share the one `wiki` toggle with the article writes - no separate box.
- (7) No `wiki_articles` row; the records cascaded; a `delete`-kind
  changelog row remains with `title_at_change = 'QA Sandbox'` (the
  audit trail survives the article).
- (8) The toolbox button pulses as the model enables Wiki, then the
  write lands - the same self-enable reflex the cooking/memory boxes
  have.

## Cleanup

- If step 7 didn't run (test aborted earlier), delete the QA Sandbox
  article by hand from the Wiki tab (cascades its records). Remove the
  QA chat threads.

## Results log

| Date | Env | Commit | Result | Notes |
| ---- | --- | ------ | ------ | ----- |
