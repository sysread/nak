# Journal

User-facing name: **Journal**. Internal name: **journal** -
`src/lib/agents/reflection/` is the memory-extraction agent,
which kept this feature out of the reflection namespace from the
start. The user-facing label was originally "Reflections" but
collided with the memory feature in conversation, so the surface
was renamed.

## Role

A daily-journal surface parallel to memories. Each user has up
to two entries per day: an **automatic** one written by a
background agent after conversations settle, and an optional
**user** one. Entries are semantically searchable and
exportable as Markdown (single day) or a ZIP archive
(everything).

The automatic journaler mirrors the memory-extraction
pipeline's claim/lease pattern but writes Markdown prose
bucketed by date instead of distilled facts keyed by label.
Unlike memories, entries are not linked into a graph.

## Files

- `src/lib/agents/journal/` — background agent.
  - `manager.ts` — main-thread supervisor. Web Lock at
    `'nak:journal-worker'`. Start/stop gated on
    `app.journalAutomaticEnabled`. Timezone update is
    live via a `{type:'timezone'}` postMessage (no restart).
  - `worker.ts` — Web Worker entry. Builds Venice + Supabase
    clients from the start message. Partitions the shared
    `worker_leases` table on `worker_kind='journal'`.
  - `loop.ts` — single-cycle state machine. `CycleResult`
    = `'acquired-lease' | 'polling' | 'empty-queue' |
    'journaled' | 'claim-lost' | 'error'`. Computes
    `entryDate = todayInZone(ctx.timezone)` every cycle so
    an idle worker crossing midnight lands the next turn
    on the right day.
  - `agent.ts` — `JournalAgent implements
    Agent<JournalInput, JournalOutput>`. Model:
    `MODELS.balanced.id`. `reasoning_effort: 'medium'`.
    Reads today's existing automatic entry and injects it
    into the prompt so the LLM extends rather than
    duplicates.
  - `prompt.ts` — `buildJournalPrompt({entryDate,
    existingEntry, threadId})`. Third-person observational
    voice. Tells the model to return one JSON object with
    `worthy` (bool), `reasoning` (one sentence), and
    `entry` (only when worthy=true). The agent parses the
    response and writes through
    `supabase.upsertJournalAutomaticEntry` directly - no
    tool call - to avoid the double-JSON-escape failure
    mode that ate writes when long Markdown bodies came
    through as `tool_calls.arguments`.
  - `types.ts` — `JournalInput`, `JournalOutput`,
    `MAX_JOURNAL_CONTENT_CHARS`.
- `src/lib/tools/journal_{list,read,search,delete}.ts` —
  user-facing tools; registered in `journalToolbox`, gated
  (user-toggleable in the chat composer's tool picker).
  The agent itself does NOT use any tool; it goes through
  `response_format=json_object` and writes the entry
  directly.
- `src/lib/embeddings/sources/journal.ts` —
  `createJournalSource(supabase)`. Text =
  `${entry_date}\n${topics}\nmood: ${mood}\n\n${content}`.
  Registered in `src/lib/embeddings/worker.ts`'s `sources`
  list alongside memories / threads / samskara-substrate.
- `src/lib/journal-day.ts` — `todayInZone(tz)`,
  `detectTimezone()`, `normalizeTimezone(tz)`. Worker-safe
  (no main-thread imports).
- `src/lib/journal-store.svelte.ts` — Svelte-5 `$state`
  store + CRUD helpers.
- `src/lib/journal-events.ts` — `JOURNAL_CHANGE_EVENT`
  window event; emitted by every store write so tool-path
  writes and modal writes fan out to every surface.
- `src/lib/journal-export.ts` — single-entry `.md` and
  full-archive `.zip` (dynamic-import jszip).
- `src/screens/Journal.svelte` — the modal. List
  view, daily view, and inline compose form.

## Entry points

- `state.svelte.ts:activate()` calls
  `journalManager.start(...)` when
  `app.journalAutomaticEnabled` is true.
- `state.svelte.ts:setJournalAutomaticEnabled(enabled)` -
  live toggle; Settings pane + refreshSettings path call
  it.
- `state.svelte.ts:setJournalTimezone(tz)` - pushes the
  new zone into the running worker via postMessage (no
  restart).
- `chat-loop.ts` reads today's automatic entry on the
  opening turn of each conversation via
  `supabase.getJournalEntriesForDate(todayInZone(tz))` and
  appends a `## Today's journal` block to the appendix.

## Data model

In `supabase/schema.sql`:

- `journal_entries` — unique `(user_id, entry_date,
  source)`. Columns include `content`, `topics text[]`,
  `mood`, `people text[]`, `source_thread_ids uuid[]`,
  `embedding vector(2048)`, claim stamps.
- `journal_thread_excludes` — `(user_id, thread_id)`.
  Populated when an automatic entry is deleted; the
  journaler's claim RPC filters these out.
- `threads.last_journaled_msg_id`, `journal_claim_holder`,
  `journal_claim_expires_at` — per-thread journaling
  cursor + claim stamps.
- Trigger `clear_journal_embedding_on_change` nulls the
  embedding columns when `content | topics | mood`
  change, so the embeddings worker re-vectorises.
- RLS: `auth.uid() = user_id` on both tables.
- Index on `(user_id, entry_date desc)`.
- RPCs:
  - `upsert_journal_automatic_entry` - on-conflict merge
    with `source_thread_ids` union-deduped.
  - `claim_next_thread_for_journal` - filters threads in
    `journal_thread_excludes`, gates on at least two user
    messages on the thread (skip one-shot Q&A) past
    `last_journaled_msg_id`.
  - `mark_thread_journaled_if_claimed` - advances the
    pointer if the holder still owns the claim.
  - `claim_next_pending_journal_entry` +
    `save_journal_entry_embedding_if_claimed` - the
    embeddings-side claim/save pair.
  - `search_journal_entries_by_embedding` - cosine
    similarity. No confidence bias; journals don't use
    the confidence metric memories carry.

`UserSettings` adds `journalAutomaticEnabled?: boolean`
and `journalTimezone?: string` (IANA zone).

## Contracts

- **Worker start gating.** The manager is a no-op when
  `journalAutomaticEnabled` is false. Toggling it live
  starts/stops the worker without a reload.
- **Timezone live-update.** Settings calls
  `setJournalTimezone(tz)`, which posts `{type:'timezone',
  tz}` to the worker. No restart; the loop picks up the
  new zone on its next iteration.
- **Delete == exclude.** Deleting an automatic entry
  MUST insert its `source_thread_ids` into
  `journal_thread_excludes` in the same round. The modal
  and the `journal_delete` tool both honour this by
  reading the entry before delete.
- **Upsert merge.** The agent calls
  `upsert_journal_automatic_entry` which merges
  `source_thread_ids` via `unnest + array_agg(distinct)`.
  Concurrent worker runs (shouldn't happen because of the
  lease, but in case) converge instead of overwriting.
- **Today's-journal appendix.** The main chat loop
  injects today's automatic entry (if any) into the
  system-prompt appendix on the opening turn. Weave
  continuity in naturally; no announcement.

## Interactions

- **Memory.** Parallel pipeline, separate tables. The
  two agents coexist (different `worker_kind` values,
  distinct leases, distinct model tiers - reflection
  hardcodes fast, journal uses balanced + medium
  reasoning effort). See [memory.md](./memory.md).
- **Embeddings.** Journal rows embed through the same
  worker that handles memories / threads / samskara
  substrate, via the source adapter at
  `src/lib/embeddings/sources/journal.ts`. See
  [embeddings.md](./embeddings.md).
- **Tools.** `journalToolbox` (user-facing CRUD + search)
  is gated and toggleable in the composer's tool picker.
  The background agent does NOT use a tool to write; the
  upsert goes through `response_format=json_object` and
  a direct `supabase.upsertJournalAutomaticEntry` call.
  See [tools.md](./tools.md).
- **Settings.** The Journal pane owns the toggle +
  timezone + export buttons. See [settings.md](./settings.md).
- **Chat.** The drawer gains a Journal tab between
  Recipes and (before) the other footer icons; the modal
  reads `route.modal === 'journal'` and
  `route.journal_date`. See [chat.md](./chat.md).

## Gotchas

- **Internal vs public name.** The agent lives under
  `src/lib/agents/journal/`, NOT `.../reflection/` - the
  reflection folder is the memory-extraction agent. When
  grepping, use `journal` for this feature.
- **Structured output, not tools.** The agent talks to
  Venice with `response_format: {type: 'json_object'}`
  and parses the model's `{worthy, reasoning, entry?}`
  payload. An earlier tool-call shape (`journal_upsert`)
  ate too many writes to long-Markdown threads because
  the entry body had to survive two layers of JSON
  escaping (the streamed `tool_calls.arguments` string
  on the wire, then the inner `content` field). Keeping
  the journal body in a single layer of provider-issued
  JSON dropped silent failures to near zero. If you ever
  need a tool path back (e.g. for a future agent-driven
  delete flow), expose a NEW tool rather than restoring
  `journal_upsert` so the always-on JSON-output path
  stays the only writer.
- **Timezone recomputation per cycle.** `loop.ts`
  recomputes `entryDate` every iteration so an idle
  worker that straddles midnight still writes to the
  right day.
- **Automatic card is read-only.** The modal does not
  expose an edit affordance on the automatic card. The
  journaler re-reads that card every update; user edits
  would be clobbered on the next conversation-settles
  cycle. Users who want to adjust an automatic entry
  delete it (which also excludes the source threads)
  and write their own.
- **IANA zone validation.** `normalizeTimezone` is the
  only guard on the settings path. A typo that slips
  through would still be caught by `todayInZone`'s
  fallback (browser's local zone), so the failure mode
  is "days land on local time" rather than "app breaks".
- **Embedding vector width.** Venice ships 1024 dims;
  schema is `vector(2048)` per the project convention
  (`padEmbeddingForStorage`). Mirrors the memories
  source exactly.
