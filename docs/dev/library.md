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
  is chunked and embedded so the model can find an answer inside a long
  PDF. Reached only through the `doc_*` tools - never auto-injected.

Two complementary search paths, mirroring how an agent works a large
file - fuzzy find, then exact grep, then read a range:

- **Semantic** (`doc_search`) - passage-level, on purpose. A long
  contract is useless as a single embedding (truncation throws most of
  it away, and one vector can't localise "what is the late fee"). The
  extracted text is split into chunks at upload, each chunk gets its
  own embedding, and search embeds the query once and cosine-ranks
  every chunk, returning the best-matching passages grouped by their
  source document. Use it when the wording is unknown.
- **Exact** (`doc_grep` + `doc_read`) - the deterministic grep-then-
  read loop. `doc_grep` is `grep -n` over the stored text (regex, line
  numbers, context); `doc_read` reads a line range. This is the
  reliable path for a known keyword/clause, and - unlike semantic
  search - it works the instant a document is uploaded, with no
  dependence on the embedding backfill having caught up (which for a
  multi-MB document is hours of cron sweeps). All of it runs in
  Postgres over `documents.extracted_text`; only matching snippets or
  the requested line range cross the wire.

## Files

Schema:

- `supabase/schema.sql` - the "User Documents (Library)" block defines
  `documents`, `document_chunks`, RLS on both, the
  `claim_next_pending_document_chunk` /
  `save_document_chunk_embedding_if_claimed` embedding-pipeline RPCs,
  the `search_document_chunks_by_embedding` semantic-search RPC, the
  exact-search RPCs `grep_documents` (regex over the text returning line
  numbers with context; its `lines` CTE is MATERIALIZED so a big doc's
  split runs once) and `read_document_lines` (a numbered line range plus
  the total count), the
  text-free `document_stat` (metadata + line count for `doc_get`), the
  private `documents` Storage bucket, and the three `storage.objects`
  RLS policies that scope the bucket to each user's `<user_id>/...`
  prefix. All three text RPCs split the text on the fly
  (`regexp_split_to_table ... with ordinality`), so line numbers are
  per-document and agree across grep, read, and stat.

Data layer:

- `src/lib/supabase.ts` - `Document` / `DocumentChunkHit` /
  `DocumentGrepHit` / `DocumentStat` interfaces + coerce helpers, and
  the `SupabaseService` methods: `createDocument`,
  `setDocumentStoragePath`, `setDocumentExtraction`, `listDocuments`,
  `listDocumentsPage`, `getDocumentById`, `getDocumentsByIds`,
  `updateDocument`, `deleteDocument`, `insertDocumentChunks`,
  `searchDocumentChunks`, the exact-search pair `grepDocument` /
  `readDocumentLines` and the `getDocumentStat` overview, the Storage
  helpers `uploadDocumentFile` / `createDocumentDownloadUrl`, and
  `findAttachmentByFilenameInThread` (the any-mime attachment lookup
  `doc_create` promotes from).
- `src/lib/documents.ts` - the pure `chunkText` splitter (paragraph
  packing + overlap), `ingestDocument` (the browser upload pipeline:
  create row -> upload binary -> extract -> chunk -> insert chunks),
  `searchDocumentsSemantic` (query embedding + chunk search with ILIKE
  fallback), and the length / size ceilings. Mirrors `wiki.ts`.
- `src/lib/documents-store.svelte.ts` - the shared `documentStore`
  (results, snippets, loading, query, offset, hasMore, ...),
  `runDocumentSearch`, `loadDocumentsFirstPage`, `loadMoreDocuments`,
  and the `patchDocumentRow` / `removeDocumentRow` / `addDocumentRow`
  mutators. Browse is newest-first; search dedupes chunk hits to unique
  documents in relevance order via `getDocumentsByIds`, keeping the
  best passage per document in `snippets`.
- `src/lib/document-events.ts` - the `nak:document-change` window-event
  bus, parallel to `wiki-events.ts`.

Embeddings:

- `supabase/functions/_shared/embed-input.ts` - the `document-chunks`
  entry in `EMBED_SOURCES` (the sixth source). Chunk content embeds
  verbatim - no title prefix, since repeating the title across every
  chunk of a long doc would dilute the passage's own signal.

Tools:

- `src/lib/tools/doc_search.{schema.,}ts`,
  `doc_list.{schema.,}ts`, `doc_get.{schema.,}ts`,
  `doc_grep.{schema.,}ts`, `doc_read.{schema.,}ts` - the always-on read
  surfaces (registered in `alwaysOnToolbox`). `doc_search` is semantic;
  `doc_grep` + `doc_read` are the exact grep-then-read pair; `doc_get`
  is the text-free overview (metadata + total line count) that tells the
  model how many lines it can address; `doc_read` owns all text
  retrieval.
- `src/lib/tools/doc_create.{schema.,}ts`,
  `doc_update.{schema.,}ts`, `doc_delete.{schema.,}ts` - the gated
  write tools, bundled in the `library` toolbox in
  `src/lib/tools/index.ts`.

Prompt:

- `src/lib/chat-prompt.ts` - `LIBRARY_BLOCK`, after `WIKI_BLOCK`.

UI:

- `src/components/LibraryList.svelte` - drawer listing (search +
  infinite-scroll), newest-first, with per-row status chip and (in
  search mode) the matching-passage snippet.
- `src/lib/ui/library-list.ts` - pure UI primitives: `scannerLabel`,
  `emptyMessage`, `formatBytes`, `statusLabel`, `SEARCH_DEBOUNCE_MS`.
  Unit-tested at `tests/library-list.test.ts`.
- `src/screens/Library.svelte` - the main panel: upload form +
  per-document detail view (editable description, download, extracted
  text, delete).
- `src/lib/routing.svelte.ts` - `DrawerTab` gains `'library'`; `Route`
  gains `document_id`.
- `src/screens/Chat.svelte` - the tab button, lazy-load wiring, the
  drawer / panel / top-bar branches, and the change-event listener.

Docs:

- `docs/user/library.md` (user manual), `docs/dev/library.md` (this).

## Entry points

- **User uploads a file** - `Library.svelte`'s upload form calls
  `ingestDocument({ title, description, file })`, which writes the
  metadata row, uploads the original to the bucket, extracts text via
  `VeniceClient.extractText`, chunks it, and inserts the chunk rows
  (`embedding is null`). The cron backfill embeds them on its next
  sweep (~5 min).
- **Assistant searches (semantic)** - `doc_search` calls
  `searchDocumentsSemantic`, returning the best passages with their
  source document.
- **Assistant works a large document (exact)** - the grep-then-read
  loop: `doc_grep` (regex -> `grep_documents` RPC) finds the exact lines
  and their numbers, then `doc_read` (-> `read_document_lines`) pulls
  the surrounding range, capped at `DOC_READ_MAX_SPAN` lines per call so
  it pages rather than dumping the whole doc. `doc_get`
  (-> `document_stat`) gives the total line count up front. This path is
  independent of the embedding backfill, so it works immediately after
  upload.
- **Assistant saves a pasted file** - `doc_create` finds the named
  attachment in the current thread
  (`findAttachmentByFilenameInThread`), reuses its already-parsed
  `extracted_text`, copies the binary into the bucket when still live,
  and inserts the chunk rows. The model has no file of its own; it can
  only promote a file the user attached.

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

`document_chunks`:

- `id`, `document_id` (FK `documents` cascade), `user_id` (FK cascade,
  denormalised so the search RPC and RLS scope without a join)
- `chunk_index int` - 0-based position; `unique (document_id,
  chunk_index)`
- `content text` - the passage
- `embedding vector(2048)` + the standard `embedding_model` /
  `embedding_claim_holder` / `embedding_claim_expires` claim columns
  (note: `_expires`, no `_at`, matching memories / wiki)
- Partial index `(user_id) where embedding is null` drives the backfill
  claim scan; `(document_id, chunk_index)` keeps a doc's chunks
  contiguous.
- No self-update RLS policy: chunks are immutable once written (a
  re-upload replaces the doc and its chunks via cascade); the backfill
  writes embeddings through the service-definer save RPC.

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
- **Chunking.** `chunkText` packs whole paragraphs up to
  `DOCUMENT_CHUNK_CHARS` (2000), hard-splitting a paragraph that
  exceeds it, and prefixes each chunk after the first with
  `DOCUMENT_CHUNK_OVERLAP_CHARS` (200) of its predecessor so a phrase
  straddling a boundary stays retrievable in one chunk. The
  server-side embed-input builder caps at 4000 as a defensive backstop.
- **Search merge.** `searchDocumentChunks` runs the cosine RPC and an
  ILIKE fallback in parallel, semantic first, deduped by chunk id - so
  a just-uploaded doc participates before the backfill reaches its
  chunks. Same contract as `searchWikiArticles`.
- **doc_create requires extractable text.** A promoted attachment with
  empty `extracted_text` is rejected with actionable text rather than
  creating an unsearchable document. An expired attachment (binary
  reclaimed) can still be promoted from its surviving text - the doc is
  searchable, just without a downloadable original (`storage_path`
  null).
- **deleteDocument removes the bucket object first**, then the row
  (chunks cascade). A leftover row whose object is already gone is the
  safer failure direction than an orphaned bucket object.

## Interactions

- **Embeddings** (`docs/dev/embeddings.md`) - `document_chunks` is the
  sixth backfill source; one registry entry plus the claim/save RPC
  pair. The query-time embedding stays in the browser at the
  `doc_search` / drawer call sites, like every other search surface.
- **Attachments** (`docs/dev/attachments.md`) - `doc_create` promotes
  an attachment into a document, reusing its `extracted_text` and
  binary. FOLLOW-UP: attachments should migrate onto the same Storage
  bucket so there is one file-storage mechanism, not two.
- **Tools** (`docs/dev/tools.md`) - `doc_search` / `doc_list` /
  `doc_get` / `doc_grep` / `doc_read` ride always-on; the `library`
  toolbox carries the writes.
- **Chat-prompt** (search `LIBRARY_BLOCK`) - tells the model the
  Library exists and teaches the search/grep/read loop.

## Gotchas

- **Passage-level search, not document-level.** The unit of semantic
  retrieval is the chunk, not the document. `doc_search` returns
  passages; for whole-document reading the model uses `doc_grep` to
  find lines and `doc_read` to pull a range. Don't "simplify" search to
  one-vector-per-document - that reintroduces the truncation problem the
  chunking exists to solve.
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
- **`embedding_claim_expires` (no `_at`).** Matches the memories / wiki
  embedding-claim convention. Easy to flip when cloning.
- **The bucket SQL must be idempotent.** `insert into storage.buckets
  ... on conflict do nothing` and `drop policy if exists` + recreate,
  so re-applying `schema.sql` is a no-op once the bucket exists.

## Verification

End-to-end manual smoke test:

1. `mise run sync` against a dev Supabase. Confirm `documents`,
   `document_chunks`, the RPCs, the bucket, and the storage policies
   land. Re-run for idempotency.
2. Upload a multi-page PDF. The row appears in the Library tab marked
   **Processing**; the original is downloadable immediately.
3. ~5 min later, the chunks' embeddings fill (cron backfill).
4. Ask the chat a question answered deep in the PDF -> the model calls
   `doc_search` and answers from the right passage, citing the doc.
5. Drawer search by a phrase from the doc -> the doc appears with the
   matching snippet.
6. Edit the description, download the original, then delete -> the row,
   its chunks, and the bucket object are all gone.
7. Attach a text file to a chat and ask Nak to "save this to my
   library" -> `doc_create` promotes it; it appears in the tab.
8. `mise run check` green; no `(!)` build warnings.
