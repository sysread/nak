# Background maintenance: backfill, expiry, GC, and their drawer lines

## Covers

The embed backfill sweep, the attachment-expiry function, the
recipe-image GC function, and each one's per-user drawer summary
([dev: embeddings](../../dev/embeddings.md),
[dev: attachments](../../dev/attachments.md),
[dev: logging](../../dev/logging.md) sources `embeddings`,
`attachment-expiry`, `recipe-image-gc`).

## Preconditions

- Local stack up, signed in (drawer open for the summary
  expectations); `SR` = service-role key.
- Backfill work: null one embedding to re-arm the queue:

  ```sql
  update memories set embedding = null, embedding_claim_holder = null,
         embedding_claim_expires = null
   where id = (select id from memories limit 1);
  ```

- Expiry work: an attachment row whose owning thread has been
  dormant past the window (forge by backdating the thread's newest
  message); GC work: an orphaned recipe_images row (delete its
  version links).

## Steps

1. Backfill: POST `/backfill` (venice function, service bearer).
2. Expiry: POST the `expire-attachments` function root.
3. GC: POST the `recipe-image-gc` function root.

## Expected

- (1) Synchronous summary
  `{"embedded":N,"rejected":0,...}` with N >= 1; the nulled row's
  embedding repopulates; the drawer shows one
  `[embeddings] embedded N item(s) in the background` info line for
  the affected user. A tick with an empty queue emits no drawer
  line.
- (2) Expired rows flip (`storage_path` nulled / marked), bucket
  objects removed, and the drawer shows
  `[attachment-expiry] expired N dormant attachment(s)` for each
  affected user.
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
| pending | local | - | - | (2),(3) not yet exercised live - the unit suites cover the drivers; the drawer lines and the user_id-bearing RPC columns want one live pass |
