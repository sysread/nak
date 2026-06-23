# Wiki: record files and cross-links

## Covers

Per-record file attachments and the directed, labelled record-to-record
link graph ([dev: wiki](../../dev/wiki.md), "Record files and
cross-links"), the persistent `wiki-record-files` bucket and its
`wiki-record-file-gc` orphan sweep ([dev:
file-storage](../../dev/file-storage.md)), the gated chat tools
`record_file_attach` / `record_file_remove` / `record_link_create` /
`record_link_delete` ([dev: tools](../../dev/tools.md)), and the
extraction agent's conservative auto-linking. The record_update changelog
rows that file/link mutations land are the audit anchor.

## Preconditions

- Local stack up (`mise run dev-start`), signed in as the dev user.
- A Venice key seeded in `app_config` (the file text-extract +
  `record_file_attach` paths and the agents call Venice).
- At least one wiki article with **two or more records** on it (create
  them by hand in the Wiki tab if needed - e.g. an article "Sourdough"
  with records dated for "attempt 2" and "attempt 3"). Note the article
  and the two record ids.
- An image file on disk to upload (a `.jpg`/`.png`), and a small `.pdf`
  or `.txt` for the document path.

## Steps

**Part A - in-app file attach + link (Wiki panel).**

1. Open the Wiki tab, open the article, scroll to **Records**, and click
   a record row to expand it.
2. In the expanded body's upload zone, attach the image (drop it on the
   zone or click to pick). Then attach the document the same way.
3. Confirm the rows + bucket objects landed:

   ```sql
   select f.filename, f.mime_type, f.storage_path is not null as live,
          f.extracted_text is not null as has_text
     from wiki_record_files f
    where f.record_id = '<record>'
    order by f.position;
   ```

4. In the same expanded record, use **"Link to a record..."**: pick the
   other record, type the label `based on`, click **Link**.
5. Confirm the edge + changelog:

   ```sql
   select from_record_id, to_record_id, label from wiki_record_links
    where from_record_id = '<record>';
   select kind, message from wiki_changelog
    where article_id = '<article>' order by created_at desc limit 4;
   ```

6. Expand the OTHER record; confirm the incoming link shows with a back
   arrow.
7. Remove the image (the **x** on its thumbnail) and the link (the **x**
   on the link row).
8. **Part B - chat tools (model-driven).** In a chat thread, upload the
   image (so it's a live thread attachment), then enable the
   **wiki_records** toolbox and ask: `Attach the image I just sent to the
   "<record content>" record, and link that record to the earlier attempt
   as "based on".`
9. Inspect the same two tables for the new file row (its bytes copied
   into `wiki-record-files`, a DISTINCT object key from the chat
   attachment) and the new edge.
10. Ask: `What files and links does that record have?` and confirm the
    model answers from `record_get` (it should name the file and the
    linked record, not guess).
11. **Part C - orphan GC.** Delete the record (Wiki panel, **Delete** on
    the expanded record). Its `wiki_record_files` rows cascade away but
    the bucket objects linger until the sweep.
12. Tick the GC sweep with the service-role key:

    ```sh
    curl -s -X POST "$SUPABASE_URL/functions/v1/wiki-record-file-gc" \
      -H "Authorization: Bearer $SERVICE_ROLE_KEY"
    ```

## Expected

- (2) Image attaches as a thumbnail; the document as a download link.
  No reload needed.
- (3) One row per file, `live = true`; the document row has
  `has_text = true`, the image `has_text = false`.
- (4-5) One `wiki_record_links` row `(record -> other, "based on")`; the
  changelog shows an `record_update`-kind row reading
  `Linked to (<date>) ... - based on` and, from step 2, two
  `Attached ...` rows.
- (6) The other record's expanded body lists the link with a `<-`
  (incoming) arrow and the same label.
- (7) The thumbnail and the link row disappear; a `record_update`
  changelog row records each removal; the file's bucket object is gone.
- (8-9) `record_file_attach` lands a new `wiki_record_files` row whose
  `storage_path` is a `wiki-record-files` key distinct from the chat
  attachment's `attachments` key (bytes copied, not referenced);
  `record_link_create` lands the edge. Both write `record_update`
  changelog rows.
- (10) The answer names the actual attached file + linked record,
  sourced from `record_get` (visible as a `record_get` tool call).
- (11-12) After the sweep, the deleted record's objects are gone from
  the bucket and the curl returns a JSON summary with a non-zero
  `reclaimed` count; the Logs drawer shows a `wiki-record-file-gc` line.

## Cleanup

- Delete the QA article (cascades its records, record files, and links;
  the next GC tick reclaims any objects). Remove the QA chat thread.

## Results log

| Date | Env | Commit | Result | Notes |
| ---- | --- | ------ | ------ | ----- |
