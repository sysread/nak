# Wiki records: manual CRUD, extraction sweep, librarian promotion, export

## Covers

The `wiki_records` table and its full lifecycle
([dev: wiki](../../dev/wiki.md) - Records data model, Record toolbox
split, the extraction entry point; and [user: wiki](../../user/wiki.md),
the Records and Automatic records extraction sections). Specifically: the
article-view Records section (add / edit / filter / tag / semantic
search / expand / export), the record chat tools, the background
extraction sweep (`/wiki-records-sweep`), the article/records
separation enforced by the worker + librarian prompts, the embedding
backfill for records, and the `wikiRecordExtractionEnabled` toggle.

## Preconditions

- Local stack up (`mise run dev-start`), signed in with the dev
  login, drawer open for the log expectations. `SR` = service-role
  key.
- At least one wiki article exists (records need a home). If the
  wiki is empty, create one from the Wiki tab ("New article") or let
  the wiki sweep land one first. Note its `id`:

  ```sql
  select id, title from wiki_articles order by created_at desc limit 5;
  ```

- For the extraction-sweep step: a settled thread (newest message on
  a prior calendar day, in the display timezone) that describes a
  discrete dated event tied to that article's topic (e.g. "baked an
  80% hydration loaf today, crumb was gummy"). Force eligibility by
  backdating and clearing the record pointer:

  ```sql
  update messages set created_at = now() - interval '2 days'
   where thread_id = '<THREAD>';
  update threads set last_wiki_record_processed_msg_id = null,
         wiki_record_claim_holder = null,
         wiki_record_claim_expires_at = null
   where id = '<THREAD>';
  ```

## Steps

1. Open the article in the Wiki tab. In the **Records** section,
   click **Add record**, pick a date, type Markdown content, add two
   comma-separated tags, **Save**.
2. Click the record row to expand it; click **Edit**, change the
   content, **Save**. Collapse and re-expand to confirm.
3. Add a second record on a different date with a different tag. Use
   the **From**/**To** date filter to show only one; use the **Tag**
   dropdown to filter by a tag. Clear both.
4. Type a natural-language phrase matching one record into the
   **search** bar and run it. Clear the search.
5. Expand a record, click **Export**; then click **Export all** in
   the Records header.
6. Extraction sweep: `POST /wiki-records-sweep` (venice function,
   service bearer) - or let the dev cron shim tick it.
7. Embedding: `POST /backfill` (service bearer) once, after a record
   exists.
8. Librarian: run the librarian (Wiki panel sparkles button, or
   `POST /wiki-librarian-sweep`) against a topic that has records
   establishing a settled outcome.
9. Toggle **Settings -> Wiki -> Automatic records** off, re-arm the
   thread pointer (precondition SQL), and `POST /wiki-records-sweep`
   again.

## Expected

- (1) The record appears at the top of the list, date formatted
  "Mon D, YYYY", tags shown as chips, content preview truncated. A
  new `wiki_records` row exists with `article_id` set and
  `source_conversation_id` null (manual add).
- (2) The edit persists; `updated_at` advances (trigger) and
  `embedding` is nulled (content change re-arms the backfill).
- (3) Date-range and tag filters narrow the list correctly (filters
  hit `wiki_records` via `gte`/`lte`/`contains`); clearing restores
  the full list.
- (4) Semantic search returns the matching record ranked first; a
  hit on another article is tagged "(other article)". With the
  embedder reachable it ranks by meaning; offline it falls back to
  ILIKE without erroring.
- (5) Single export downloads `yyyy-mm-dd-<slug>.md` with a
  date/tags front-matter header; **Export all** downloads
  `<article-slug>.zip` containing `article.md` + one
  `records/yyyy-mm-dd-<slug>.md` per record.
- (6) The drawer shows a `[wiki-records]` line; a new record is
  created on the matching article with `source_conversation_id` =
  the thread, deduped against any existing record. A thread with no
  discrete event produces zero records (correct no-op) and still
  advances `last_wiki_record_processed_msg_id`.
- (7) The record's `embedding` populates (vector(2048)); the drawer
  shows the `[embeddings] embedded N` line. Semantic search now hits
  it via the vector path.
- (8) The librarian folds the records' settled learning into the
  **article body** (a dated current-state sentence) and may merge or
  tidy records - but every promoted record still exists afterward
  (records survive promotion). The open article's body refreshes via
  the realtime relay.
- (9) With extraction off, the sweep claims nothing for that user
  (the claim predicate gates on `wikiRecordExtractionEnabled`); no
  new record appears. Manual add (step 1) still works.

## Cleanup

- Delete the test records from the UI (expand -> Delete) or
  `delete from wiki_records where article_id = '<ARTICLE>';`.
- Re-enable the **Automatic records** toggle if you turned it off.
- The backdated message timestamps can be left; they only affect
  eligibility windows.

## Results log

| Date | Env | Commit | (1) | (2) | (3) | (4) | (5) | (6) | (7) | (8) | (9) | Notes |
|------|-----|--------|-----|-----|-----|-----|-----|-----|-----|-----|-----|-------|
| *pending* | | | | | | | | | | | | first run after feature lands |
