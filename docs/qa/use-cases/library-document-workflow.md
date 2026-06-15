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
   then expand the assistant's `doc_grep` tool call and look for the
   matched document's title in its result.
8. Return to the document page and delete `Library QA Doc`.

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
  doc's title (`Library QA Doc`) appears inside the `doc_grep` tool-call
  result. There is no separate source/citation chip for library docs -
  CitationsPanel renders web-search citations only.
- (8) Delete removes the document from the Library list/search results and
  permanently removes its management surface.

## Cleanup

- Remove the local fixture:

  ```sh
  rm -f /tmp/nak-library-qa.txt
  ```

## Results log

| Date | Env | Commit | Result | Notes |
| ---- | --- | ------ | ------ | ----- |
