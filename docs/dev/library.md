# Library

Persistent, user-uploaded reference documents. A peer to chats,
memories, recipes, and the wiki. Unlike message attachments (which
expire on a 30-day sweep), Library documents are long-term reference
material the user curates and the LLM searches.

## Role

Two surfaces with deliberately different lifetimes:

- **Attachments** (`docs/dev/attachments.md`) - per-message files,
  base64 in Postgres, reclaimed after 30 days dormancy.
- **Library** (this doc) - whole uploaded documents kept forever. The
  original binary lives in a private Storage bucket; the extracted text
  is stored alongside and searched directly. Reached only through the
  `doc_*` tools - never auto-injected.

There is **no embedding / semantic layer**. An earlier design chunked
each document and embedded the chunks for cosine search; it was dropped
because it both underperformed (semantic ranking surfaced the table of
contents and definitions over the operative clauses) and cost a heavy
per-chunk backfill (thousands of chunks for a multi-MB upload, hours of
cron sweeps before a fresh doc was searchable). The corpus is a few
dozen documents, not millions, so the model works a document the way an
agent works a large source file:

- **`doc_list`** - pick which document (titles + descriptions).
- **`doc_grep`** - `grep -n` over the stored text (regex, line numbers,
  context) to find the exact clause. The primary search path.
- **`doc_read`** - read a line range around the hit.
- **`doc_get`** - a document's metadata + total line count (no text).

All grep/read runs in Postgres over `documents.extracted_text`; only
matching snippets or the requested line range cross the wire, and it
works the instant a document is uploaded (no backfill to wait on).

## Files

Schema:

- `supabase/schema.sql` - the "User Documents (Library)" block defines
  `documents` + its RLS, the exact-search RPCs `grep_documents` (regex
  over the text returning line numbers with context; its `lines` CTE is
  MATERIALIZED so a big doc's split runs once) and `read_document_lines`
  (a numbered line range plus the total count), the text-free
  `document_stat` (metadata + line count for `doc_get`), the private
  `documents` Storage bucket, and the three `storage.objects` RLS
  policies that scope the bucket to each user's `<user_id>/...` prefix.
  All three text RPCs split the text on the fly
  (`regexp_split_to_table ... with ordinality`), so line numbers are
  per-document and agree across grep, read, and stat. The block also
  carries idempotent `drop` statements that remove the legacy
  `document_chunks` table and its embedding RPCs from any project that
  applied the earlier chunked schema.

Data layer:

- `src/lib/supabase.ts` - `Document` / `DocumentGrepHit` /
  `DocumentStat` interfaces + coerce helpers, and the `SupabaseService`
  methods: `createDocument`, `setDocumentStoragePath`,
  `setDocumentExtraction`, `listDocuments`, `listDocumentsPage`,
  `getDocumentById`, `updateDocument`, `deleteDocument`,
  `searchDocuments` (the drawer's substring browse search), the
  grep/read pair `grepDocument` / `readDocumentLines`, the
  `getDocumentStat` overview, the Storage helpers `uploadDocumentFile` /
  `createDocumentDownloadUrl`, and `findAttachmentByFilenameInThread`
  (the any-mime attachment lookup `doc_create` promotes from).
- `src/lib/documents.ts` - `ingestDocument` (the browser upload
  pipeline: create row -> upload binary -> extract text -> store) and
  the length / size ceilings. No chunking; the extracted text is stored
  whole.
- `src/lib/documents-store.svelte.ts` - the shared `documentStore`
  (results, loading, query, offset, hasMore, ...), `runDocumentSearch`,
  `loadMoreDocuments`, and the `patchDocumentRow` / `removeDocumentRow`
  / `addDocumentRow` mutators. Browse is newest-first; search is a
  substring match returning whole documents (`searchDocuments`).
- `src/lib/document-events.ts` - the `nak:document-change` window-event
  bus, parallel to `wiki-events.ts`.

Tools:

- `src/lib/tools/doc_list.{schema.,}ts`, `doc_get.{schema.,}ts`,
  `doc_grep.{schema.,}ts`, `doc_read.{schema.,}ts` - the always-on read
  surfaces (registered in `alwaysOnToolbox`). `doc_list` picks the
  document; `doc_grep` + `doc_read` are the grep-then-read pair;
  `doc_get` is the text-free overview (metadata + total line count) that
  tells the model how many lines it can address.
- `src/lib/tools/doc_create.{schema.,}ts`,
  `doc_update.{schema.,}ts`, `doc_delete.{schema.,}ts` - the gated
  write tools, bundled in the `library` toolbox in
  `src/lib/tools/index.ts`.

Prompt:

- `src/lib/chat-prompt.ts` - `LIBRARY_BLOCK`, after `WIKI_BLOCK`.

UI:

- `src/components/LibraryList.svelte` - drawer listing (search +
  infinite-scroll), newest-first, with a per-row status chip.
- `src/lib/ui/library-list.ts` - pure UI primitives: `scannerLabel`,
  `emptyMessage`, `formatBytes`, `statusLabel`, `SEARCH_DEBOUNCE_MS`.
  Unit-tested at `tests/library-list.test.ts`.
- `src/screens/Library.svelte` - the main panel: upload form +
  per-document detail view with an Edit form (rename + description),
  download, extracted text, and delete.
- `src/lib/routing.svelte.ts` - `DrawerTab` gains `'library'`; `Route`
  gains `document_id`.
- `src/screens/Chat.svelte` - the tab button, lazy-load wiring, the
  drawer / panel / top-bar branches, and the change-event listener.

Docs:

- `docs/user/library.md` (user manual), `docs/dev/library.md` (this).

## Entry points

- **User uploads a file** - `Library.svelte`'s upload form calls
  `ingestDocument({ title, description, file })`, which writes the
  metadata row, uploads the original to the bucket, and extracts text
  via `VeniceClient.extractText`. The text is searchable immediately;
  there is no embedding step.
- **Assistant works a document** - the grep-then-read loop: `doc_list`
  picks the document, `doc_grep` (regex -> `grep_documents` RPC) finds
  the exact lines and their numbers, then `doc_read`
  (-> `read_document_lines`) pulls the surrounding range, capped at
  `DOC_READ_MAX_SPAN` lines per call so it pages rather than dumping the
  whole doc. `doc_get` (-> `document_stat`) gives the total line count.
- **Assistant saves a pasted file** - `doc_create` finds the named
  attachment in the current thread
  (`findAttachmentByFilenameInThread`), reuses its already-parsed
  `extracted_text`, and copies the binary into the bucket when still
  live. The model has no file of its own; it can only promote a file the
  user attached.

## Data model

`documents`:

- `id`, `user_id` (FK `auth.users` cascade)
- `title text`, `description text default ''` (the "what this is for"
  field)
- `filename`, `mime_type`, `size_bytes bigint` - upload metadata
- `storage_path text` - object key in the `documents` bucket
  (`<user_id>/<document_id>/<filename>`); null transiently between the
  row insert and the binary upload
- `extracted_text text` - Venice parser output; null until extraction
- `extraction_status text` - `pending` | `done` | `failed` (CHECK)
- `extraction_error text` - trimmed failure reason for the UI
- `created_at`, `updated_at`
- Index `(user_id, created_at desc)` for the newest-first listing.

There is no chunk table. `grep_documents` / `read_document_lines`
operate directly on `extracted_text`, splitting it into numbered lines
on the fly.

Storage bucket `documents`: `public = false`. Three `storage.objects`
policies (select / insert / delete) require
`(storage.foldername(name))[1] = auth.uid()::text`, mirroring the
per-row `user_id` scoping.

## Contracts

- **Two-phase upload.** `createDocument` writes the row first (status
  `pending`, `storage_path` null), then the binary uploads and
  `setDocumentStoragePath` records the path, then extraction runs.
  Steps are committed before extraction, so a parser failure leaves a
  downloadable doc marked `failed` rather than losing the upload.
- **grep / read agree on line numbers.** Both split `extracted_text` on
  `E'\n'` with `regexp_split_to_table ... with ordinality`, so a line
  number from `doc_grep` indexes the same line in `doc_read`.
  `doc_read` clamps its span to `DOC_READ_MAX_SPAN`; `doc_grep` caps
  matches and rephrases an invalid-regex error as `{error}` guidance.
- **doc_create requires extractable text.** A promoted attachment with
  empty `extracted_text` is rejected with actionable text rather than
  creating an unsearchable document. An expired attachment (binary
  reclaimed) can still be promoted from its surviving text - the doc is
  searchable, just without a downloadable original (`storage_path`
  null).
- **deleteDocument removes the bucket object first**, then the row. A
  leftover row whose object is already gone is the safer failure
  direction than an orphaned bucket object.

## Interactions

- **Attachments** (`docs/dev/attachments.md`) - `doc_create` promotes
  an attachment into a document, reusing its `extracted_text` and
  binary. FOLLOW-UP: attachments should migrate onto the same Storage
  bucket so there is one file-storage mechanism, not two.
- **Tools** (`docs/dev/tools.md`) - `doc_list` / `doc_get` / `doc_grep`
  / `doc_read` ride always-on; the `library` toolbox carries the writes.
- **Chat-prompt** (search `LIBRARY_BLOCK`) - tells the model the Library
  exists and teaches the list -> grep -> read loop.
- **Embeddings** (`docs/dev/embeddings.md`) - the Library is
  deliberately NOT a backfill source. It was one (a sixth
  `document_chunks` source) in the chunked design; the embeddings doc
  is back to five sources.

## Gotchas

- **No semantic search - and that was a deliberate removal.** Search is
  exact regex (`doc_grep`) plus metadata routing (`doc_list`). Before
  re-adding embeddings, read why they were dropped (Role section): they
  underperformed against the operative text and cost a heavy per-chunk
  backfill at a corpus size that doesn't need it. If large libraries
  ever make routing hard, a *single embedding per document* (routing
  only, not per-chunk) is the cheap thing to add - not chunk search.
- **`doc_get` does NOT return the text.** It's the text-free stat
  (metadata + line count). Pulling a multi-MB document's text into a
  tool result blows the context window; `doc_read` exists precisely so
  the model pages it in bounded line ranges. Don't add a text field to
  `doc_get`.
- **Line numbers are computed on the fly, not stored.** grep / read /
  stat each split `extracted_text` on `E'\n'` the same way, so their
  line numbers agree - but there is no persisted line index, so a future
  change to how extracted text is normalised shifts every line number.
  That's fine (the model always greps fresh before reading), just don't
  cache line numbers across an extraction change.
- **A bad regex from the model is not a tool failure.** `doc_grep`
  catches Postgres's "invalid regular expression" and returns it as
  `{error: ...}` guidance so the model fixes the pattern and retries,
  rather than the tool throwing.
- **The bucket and legacy-drop SQL must be idempotent.** `insert into
  storage.buckets ... on conflict do nothing`, `drop policy if exists` +
  recreate, and `drop table/function if exists` for the retired chunk
  objects, so re-applying `schema.sql` is a no-op once the state is
  reached.

## Verification

End-to-end manual smoke test:

1. `mise run sync` against a dev Supabase. Confirm `documents`, the
   `grep_documents` / `read_document_lines` / `document_stat` RPCs, the
   bucket, and the storage policies land, and that any old
   `document_chunks` table is dropped. Re-run for idempotency.
2. Upload a multi-page PDF. The row appears in the Library tab; the
   original is downloadable, and the text is searchable immediately (no
   embedding wait).
3. Ask the chat a question answered deep in the PDF -> the model uses
   `doc_list` -> `doc_grep` -> `doc_read` and answers from the right
   lines, citing the doc.
4. Drawer search by a phrase from the doc -> the doc appears in the
   listing.
5. Edit the description, download the original, then delete -> the row
   and the bucket object are gone.
6. Attach a text file to a chat and ask Nak to "save this to my
   library" -> `doc_create` promotes it; it appears in the tab.
7. `mise run check` green; no `(!)` build warnings.
