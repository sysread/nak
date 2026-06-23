# Wiki record files + cross-links (in progress)

Status: **PLAN - not started**. Milestone tracker for adding two
relations to `wiki_records`: per-record file attachments and directed,
labelled record-to-record links. Scope confirmed with the user as
**full agent integration** (UI + chat tools + extraction/librarian
agent awareness).

Graduate the durable design into `docs/dev/wiki.md` (the records
section) and `docs/dev/file-storage.md` (the new bucket row) as each
milestone lands; retire this doc when the last milestone ships.

## Motivation

`wiki_records` is the dated "journey" layer under each wiki article
(experiments, observations, attempts). Two gaps:

1. A record can't carry files - the user's bread-baking crumb photos,
   a scanned recipe card, a PDF - so the visual/document evidence of an
   experiment lives only in chat and is lost to the record.
2. Records can't reference each other, so "attempt #3 is based on
   attempt #2 with more hydration" is only expressible as prose, not as
   a navigable, labelled relationship.

## Data model

### `wiki_record_files` (new table)

Per-record file metadata; bytes in the new `wiki-record-files` bucket.
Follows the `documents` / attachments pattern in `file-storage.md`
(metadata + `storage_path` pointer, signed-URL reads), but the bucket
is **persistent** (records are forever) - NOT the 30-day-expiry
`attachments` bucket.

- `id uuid pk default gen_random_uuid()` (minted client-side so upload
  + insert share the key, like attachments)
- `user_id uuid not null references auth.users on delete cascade`
- `record_id uuid not null references wiki_records on delete cascade`
- `position int not null default 0` - render order within the record
- `filename text not null`
- `mime_type text`
- `size_bytes int`
- `storage_path text not null` - key `<user_id>/<file_id>/<filename>`
  in `wiki-record-files`
- `extracted_text text` - Venice text-parser output for non-image docs
  (so the model can read an attached PDF via `record_get`, same as
  message attachments). NULL for images.
- `created_at timestamptz default now()`
- Index `(record_id, position)`.
- RLS: direct `user_id = auth.uid()` (4 policies), matching
  `wiki_records` (which also carries its own `user_id`).
- `supabase_realtime` member + `(id, user_id)` replica-identity index
  so DELETE events reach the user-filtered browser subscription (same
  gotcha as `wiki_records` / `wiki_articles`).

Bucket `wiki-record-files`: `public = false`, three `storage.objects`
policies scoped to `(storage.foldername(name))[1] = auth.uid()::text`,
created idempotently (`on conflict do nothing`). Persistent.

GC sweep `wiki-record-file-gc` (edge function, daily): deletes bucket
objects with no `wiki_record_files` row - the orphans a record/article
delete cascade leaves behind (SQL can't drop Storage objects). Backed
by `list_orphan_wiki_record_file_objects` + a deploy.yml line. Clone of
`attachment-gc`. The browser's record-delete path best-effort removes
the objects inline; this sweep is the backstop.

### `wiki_record_links` (new table)

Directed many-to-many between records, with a freeform label.

- `id uuid pk default gen_random_uuid()`
- `user_id uuid not null references auth.users on delete cascade`
- `from_record_id uuid not null references wiki_records on delete cascade`
- `to_record_id uuid not null references wiki_records on delete cascade`
- `label text` - freeform, char-capped (e.g. `MAX_RECORD_LINK_LABEL_CHARS`,
  120) - "based on", "iteration of", "supersedes"
- `created_at timestamptz default now()`
- `check (from_record_id <> to_record_id)` - no self-links
- `unique (from_record_id, to_record_id)` - one directed edge per pair;
  the label is the edge's editable attribute. (A<-B and A->B are two
  distinct rows; both directions allowed.)
- Indexes `(from_record_id)`, `(to_record_id)` (forward + reverse
  lookup; a record's view shows outgoing AND incoming links).
- RLS direct `user_id = auth.uid()`. Both endpoints belong to the same
  user; b-strict write paths (service role) validate both record ids
  against the user explicitly since RLS is bypassed there.
- `supabase_realtime` member + `(id, user_id)` replica identity.

### Out of scope (non-goals)

- No changelog rows for file/link mutations (the `wiki_changelog`
  `kind` check stays as-is). Records themselves still changelog;
  sub-record attachments don't. Revisit if the user wants it.
- Record embedding input stays `date + content` - attached-file
  `extracted_text` does NOT feed the record vector (a noisy OCR dump
  shouldn't dominate retrieval). Files reach the model through
  `record_get`, not through search ranking.

## Edge function: reads, write tools, agents

### Widened reads

- `record_get` (`tools/record_get.ts`) returns, alongside the record:
  attached files (filename, mime, `size_bytes`, a freshly-minted signed
  URL for images, inline `extracted_text` for docs) and links (outgoing
  + incoming, each `{ record_id, label, date, content-excerpt }`). This
  is how the chat model "sees" a record's photos and relationships.
- `record_list` gains a lightweight per-row `file_count` / `link_count`
  so a timeline read can tell which entries carry evidence without N
  round-trips. (Counts only; full hydration via `record_get`.)

### New gated write tools (`wikiRecordsToolbox`)

- `record_link_create(from_record_id, to_record_id, label)` -
  validates both records belong to the caller, upserts the edge
  (unique-pair violation rephrased to "edge exists, use
  record_link_update" or just updates the label).
- `record_link_delete(from_record_id, to_record_id)` (or by link id).
- `record_file_attach(record_id, filename)` - resolves an image the
  conversation already produced/holds (thread-scoped
  `message_attachments` lookup by filename, same resolver
  `analyze_image` / generated images use), copies the bytes into
  `wiki-record-files`, inserts the row. This is the "attach the crumb
  photo I posted in chat" path - the model can't upload arbitrary
  bytes, but it CAN promote a thread image/doc onto a record.
- `record_file_remove(file_id)`.

All b-strict (explicit `user_id`), membership-tripwired in
`tests/tools.test.ts` + the function-side toolbox test.

### Agent awareness

- **Extraction agent** (`agents/wiki_records.ts`): toolbox gains
  `record_link_create`. Prompt update: after creating a record for a
  new dated event, conservatively cross-link it to the most-recent
  prior record of the same article when the conversation frames it as a
  continuation ("attempt 3, same as last time but..."). Dedup-first
  (`record_list` to find the prior), conservative-by-default (no link
  when the relationship is not explicit). It already has
  `record_create` + `record_list`; this adds the one link verb. NOT
  file attach (the extraction agent shouldn't be promoting images
  autonomously - too easy to attach the wrong one).
- **Librarian** (`agents/wiki_librarian.ts`): gains
  `record_link_delete` for opportunistic repair (a link to a record
  that was merged/deleted, a duplicate edge). No new file power.
- **Article worker**: unchanged (no record-link verbs - keeps its
  surface narrow).

Toolbox membership assertions updated in
`supabase/functions/tests/wiki_records.test.ts` and
`wiki_librarian.test.ts`.

## Browser data layer (`src/lib/supabase.ts`)

- Types `WikiRecordFile`, `WikiRecordLink` + coercers.
- `wiki-record-files` bucket I/O: `uploadWikiRecordFile` (+ signed-URL
  resolution), `listWikiRecordFiles(recordId)` (projects `storage_path`,
  mints batched signed URLs for images on demand),
  `downloadWikiRecordFileBlob`, `removeWikiRecordFiles`.
- `attachWikiRecordFile` (insert row post-upload, with `extractText`
  for non-images), `deleteWikiRecordFile`.
- `createWikiRecordLink`, `updateWikiRecordLink`, `deleteWikiRecordLink`,
  `listWikiRecordLinks(recordId)` (outgoing + incoming).
- Realtime: extend the existing `wiki_records` change subscription, or
  add sibling subscriptions for the two new tables, relayed onto the
  existing `onWikiRecordChange` bus.
- `deleteThread` analog: nothing (records don't cascade from threads),
  but the record-delete path collects live file keys before the cascade
  and best-effort removes the objects (GC backstop covers misses).

## UI (`src/components/WikiRecords.svelte` + `src/lib/ui/wiki-records.ts`)

Per the components CLAUDE.md, all decision logic goes in the primitives
module; the `.svelte` file stays glue.

- **Compose/edit form**: a file drop zone (drag/drop/paste/picker)
  mirroring `Chat.svelte`'s composer; pending-file chips; images
  downscaled via the existing `maybeDownscaleImage`. On save: upload +
  attach rows.
- **Expanded record body**: a file strip - image thumbnails (click ->
  lightbox, reuse the cookbook lightbox primitives if cheap) + document
  download chips - and a "Linked records" list (label + dated title;
  click navigates/expands the target). A "Link to record..." control: a
  small typeahead over the article's other records (+ optional
  cross-article search) plus a freeform label input.
- New primitives: `partitionRecordFiles` (image vs doc),
  `linkDirectionLabel`, link-form validation, etc. Unit-tested in
  `tests/wiki-records.test.ts`.

## Docs

- `docs/dev/wiki.md` - extend the `wiki_records` section with the two
  relations, the new tools, the agent behavior, the bucket + GC sweep.
- `docs/dev/file-storage.md` - add the `wiki-record-files` bucket row to
  the table + the GC sweep to the lifecycle section.
- `docs/dev/tools.md` - the four new record tools + widened reads.
- `docs/dev/attachments.md` Interactions - the shared resolver
  (`record_file_attach` reuses the thread-image lookup).
- `docs/user/wiki.md` - user-facing: how to attach files to a record
  and link records, in the Wiki panel and via chat.
- `docs/qa/use-cases/` - a walkthrough: attach a photo to a record,
  link two records, verify display, verify chat `record_get` sees the
  file + link, verify GC reclaims an orphaned object.

## Tests / gate

- vitest: the new UI primitives.
- Deno: toolbox membership tripwires (extraction + librarian), the new
  write tools' behavior (b-strict validation, hallucinated-id
  rejection, unique-pair rephrasing) via the runner's completion seam.
- `tests/tools.test.ts`: `wikiRecordsToolbox` membership updated.
- `mise run check` green + `mise run knip` clean; no `(!)` build
  warnings. Cloud agent CANNOT browser-verify - the file
  upload/lightbox/link-picker interaction layer is flagged for manual
  sanity check before merge.

## Milestones (suggested landing order)

1. **Schema + storage**: tables, RLS, realtime, bucket, GC sweep +
   RPCs, deploy.yml line, `reset_wiki_data` extension. Idempotent.
2. **Browser data layer**: types, coercers, SupabaseService I/O +
   CRUD, realtime relay.
3. **UI**: files + links in `WikiRecords.svelte` + primitives + tests.
   (Usable end-to-end by hand at this point.)
4. **Edge reads + write tools**: widen `record_get`/`record_list`, the
   four gated tools, membership tests.
5. **Agent awareness**: extraction-agent link verb + prompt, librarian
   link-prune verb + prompt, agent tests.
6. **Docs + QA**: graduate design into `wiki.md` / `file-storage.md`,
   user doc, QA use-case; retire this in-progress doc.

Each milestone is a self-contained commit on the feature branch; the
gate runs green at every step.
