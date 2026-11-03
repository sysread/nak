# Library: upload, searchability, and document management

## Covers

Library upload and extracted-text storage ([dev: library](../../dev/library.md),
[dev: file-storage](../../dev/file-storage.md)), document-backed search and
assistant answers ([dev: library](../../dev/library.md),
[dev: tools](../../dev/tools.md)), and Library metadata management.

## Preconditions

- Local stack up (`mise run dev-start`), signed in as the dev user.
- A local text fixture ready to upload:

  ```sh
  printf 'Library QA fixture about apricot tea and copper kettles.\n' > /tmp/nak-library-qa.txt
  ```

- The `Library` tab is reachable.

## Steps

1. Open the `Library` tab and start a new upload.
2. Choose `/tmp/nak-library-qa.txt`, set the title to `Library QA Doc`,
   set a short description, and save.
3. Wait for the new document to leave `Processing`.
4. Search the Library for `apricot tea` and open `Library QA Doc`.
5. Edit the document metadata, change only the description, and save.
6. Download the original file from the document page.
7. In chat, ask a question whose answer depends on the uploaded document,
   then expand the assistant's docs (op=grep) tool call and look for the
   matched document's title in its result.
8. With `Library QA Doc` still open, click the top-bar **Upload
   document** button, then reopen `Library QA Doc` from the list.
9. Delete `Library QA Doc`.

## Expected

- (1-2) The Library upload flow accepts the file, title, and description,
  then creates a new document row/page for `Library QA Doc`.
- (3) The new document shows a visible processing/searchability state, and
  then becomes searchable when extraction finishes.
- (4) Searching for `apricot tea` finds `Library QA Doc`; opening it shows
  the stored metadata and document surface.
- (5) Metadata edits save without replacing the underlying file.
- (6) Download returns the original uploaded file, not only extracted
  text.
- (7) The assistant can answer from the Library document; the matched
  doc's title (Library QA Doc) appears inside the op=grep tool-call
  result. There is no separate source/citation chip for library docs -
  CitationsPanel renders web-search citations only.
- (8) The upload button swaps the document page for the empty upload
  form (the list row loses its highlight); reopening the row brings the
  document page back.
- (9) Delete removes the document from the Library list/search results and
  permanently removes its management surface.

## Cleanup

- Remove the local fixture:

  ```sh
  rm -f /tmp/nak-library-qa.txt
  ```

## Results log

| Date | Env | Commit | Result | Notes |
| ---- | --- | ------ | ------ | ----- |
| 2026-11-03 | local (dev@nak.local) | ea60d19 (pre-M5 baseline) | PASS 9/9 | Baseline before doc_* -> `docs` combo. All 9 steps pass. Processing chip not observable on a 57 B text file. Fixture injected in-memory (no /tmp write). Title prefixed ZZQA-TC. All six verbs mapped (grep-then-read loop, promotion + refusal shapes). The model fanned out doc_list + doc_get + doc_read in ONE parallel round. |
| 2026-11-03 | local (dev@nak.local) | 3e9807cf (post-M5, `docs` combo) | PASS 9/9 | Attempt 1 BLOCKED (serve down - the process died in the mid-application file changes and was not restarted; not code rot). Attempt 2: all six ops verified through the combo with op-specific plain-English activity labels. Fan-out watch item: parallel calls to the same combo still fan out (3 calls, one round, 23-26ms). ZERO op-omissions (6/6 first-try) - the REQUIRED-on-every-call schema phrasing credits. Stale dev-doc framing fixed in the same landing (docs/dev/README.md's chunked-Library description). |
