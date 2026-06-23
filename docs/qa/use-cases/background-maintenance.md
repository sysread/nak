# Background maintenance: backfill, orphan GC, and their drawer lines

## Covers

The embed backfill sweep, the attachment orphan-object GC function, the
recipe-image GC function, and each one's per-user drawer summary
([dev: embeddings](../../dev/embeddings.md),
[dev: attachments](../../dev/attachments.md),
[dev: logging](../../dev/logging.md) sources `embeddings`,
`attachment-gc`, `recipe-image-gc`).

## Preconditions

- Local stack up, signed in (drawer open for the summary
  expectations); `SR` = service-role key.
- Backfill work: null one embedding to re-arm the queue:

  ```sql
  update memories set embedding = null, embedding_claim_holder = null,
         embedding_claim_expires = null
   where id = (select id from memories limit 1);
  ```

- Attachment GC work: an orphaned attachments-bucket object - a bucket
  object with no `message_attachments` row. Forge by deleting an
  attachment's row in SQL while leaving its object in place (its object
  is older than the GC grace window, so the sweep won't mistake it for
  an in-flight upload). Recipe GC work: an orphaned recipe_images row
  (delete its version links).

## Steps

1. Backfill: POST `/backfill` (venice function, service bearer).
2. Attachment GC: POST the `attachment-gc` function root.
3. Recipe GC: POST the `recipe-image-gc` function root.

## Expected

- (1) Synchronous summary
  `{"embedded":N,"rejected":0,...}` with N >= 1; the nulled row's
  embedding repopulates; the drawer shows one
  `[embeddings] embedded N item(s) in the background` info line for
  the affected user. A tick with an empty queue emits no drawer
  line.
- (2) The orphaned bucket object is removed, and the drawer shows
  `[attachment-gc] reclaimed N orphaned attachment object(s)` for each
  affected user. A run with no orphans emits no drawer line.
- (3) Orphan rows deleted with their bucket objects, and
  `[recipe-image-gc] reclaimed N orphaned recipe image(s)` per
  user. Rows re-linked between list and delete are skipped (the
  delete RPC re-checks).

## Cleanup

None - all three are idempotent janitors; re-running on a clean
state is a no-op.

## Results log

| Date | Env | Commit | Result | Notes |
| ---- | --- | ------ | ------ | ----- |
| 2026-06-10 | local | b66385f | pass (1) | nulled memory re-embedded, summary embedded=1, per-user tally fed the drawer publish |
| 2026-06-10 | local | 7da4293 | pass (2,3) | forged 40-day-dormant attachment expired (storage_path nulled, expired=1); forged orphan recipe image reclaimed (row + object delete, reclaimed=1); per-user tallies non-empty so both drawer publishes fired |
