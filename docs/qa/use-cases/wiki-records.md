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
8a. Migration: hand-author an article body that contains an inline
   dated log (e.g. "March 2026: started starter. April: first sour
   loaf."), then run the worker on a thread touching that topic (or
   the librarian). Pre-seed one of those entries as an existing
   record to exercise the dedup path.
9. Toggle **Settings -> Wiki -> Automatic records** off, re-arm the
   thread pointer (precondition SQL), and `POST /wiki-records-sweep`
   again.

## Expected

- (1) The record appears at the top of the list, date formatted
  "Mon D, YYYY", tags shown as chips, content preview truncated. The
  wiki **changelog** (Wiki tab, no article selected) gains an "Added
  record" row scoped to the parent article (linking through to it);
  editing/deleting a record adds "Edited record" / "Removed record"
  rows. A new `wiki_records` row exists with `article_id` set and
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
- (8a) The inline dated entries are **migrated** into `wiki_records`
  rows and the body is trimmed to current-state prose. The entry that
  was pre-seeded as a record is NOT duplicated (dedup via record_list);
  no dated line is removed from the body without a matching record
  existing first.
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
| 2026-10-12 | local (recipe-records wt) | recipe-records@0dcca4e6+ | P | P | P | P | - | - | - | - | - | Partial re-run (steps 1-4) as the twin-fix QA: the jsonb tag-filter fix (`ilikeFilterPattern`-style serialization fix, tags=cs.["..."] now 200) and the revived ILIKE leg (proved by a null-embedding row returning through the standalone ilike). Steps 5-9 unaffected by the two fixes; full first run still pending. |
| 2026-11-03 | local stack, wt-nak/tool-combos | f1241512+ (pre-M8 baseline) | P | P | P | P | P | F | P | partial | Full walkthrough as the pre-combo baseline (steps 8/8a partial: budget; step 8's per-conversation worker DID fold the event into the body + both records survived). Tool ledger captured: all six record verbs mapped with their changelog shapes (create 0->80, update 80->110, delete 110->0; each carries article_id + title_at_change). Update semantics pinned: field-level patch, full replacement WITHIN the tags array. FINDING A (filed with intake; CORRECTED by their verdict): the extraction sweep claimed a thread, created NO record, advanced the pointer, and the dated event appeared in the ARTICLE BODY. Intake's investigation: the pointer advance is the documented no-op contract (zero-event threads must not pin the queue); the body fold was the ARTICLE worker's legitimate date-anchored update (the extraction agent has no wiki_save - the separation HELD); the REAL defect is the agent's false success self-report stored verbatim as the audit trail with zero post-run verification (a count-before/after check in the sweep's done branch is the proposed fix - routed to Jeff as a batch item). FINDING B (doc gap): claim_next_thread_for_wiki_records requires >= 2 user messages - undocumented. |
| 2026-11-03 | local (tool-combos wt) | post-M8 head | P | P | P | BLOCKED | BLOCKED | BLOCKED | P | BLOCKED | UI-only steps PASS at parity (manual add, edit, filters incl. the jsonb tag fix, single + all export, delete via UI x2, the toggle's settings write). Chat-capture steps + backfill + librarian BLOCKED: the edge serve died during the M8 application (rule-9 miss - the restart is supposed to precede this dispatch) and the run's 15 probes never recovered it. Changelog templates compared character-for-character (UI-written rows): identical to baseline. Superseded by the follow-up focused run. |
