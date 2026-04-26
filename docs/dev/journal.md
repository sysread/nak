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
    `nvidia-nemotron-cascade-2-30b-a3b` (literal id, not a
    tier - low-traffic slot for the background queue,
    256k context, supports function calling + reasoning).
    `reasoning_effort: 'medium'`. Reads today's existing
    automatic entry and injects it into the prompt so the
    LLM extends rather than
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
  - `spam_filter.ts` — per-user Naive Bayes classifier over
    the source conversation text. Tokenize (user/assistant
    only, lowercased, length-windowed, Snowball English
    stemmed, deduped per conversation) -> train via the
    `train_journal_spam` RPC -> score via the
    `score_journal_spam` and `get_journal_spam_stats` RPCs.
    `renderSpamHint(score)` returns the natural-language
    string the agent injects into the prompt; returns null
    below the cold-start threshold so the prompt section is
    suppressed entirely until there's enough data. Two
    tokenizer entry points: `tokenizeConversation(messages)`
    for thread-sourced training/scoring, and
    `tokenizeUserEntry(content)` for user-authored entries
    where the entry text itself is the training input. Both
    share `addTokensFromText` so the train and score paths
    see byte-identical tokens regardless of source.
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
- `src/screens/Journal.svelte` — the modal. Daily-view-only
  with an inline compose form. The drawer's Journal tab in
  `Chat.svelte` aggregates entries to one row per
  `entry_date` (rendered in the `recipe-drawer-list` block)
  and is the equivalent of a list view; the modal itself
  starts on whatever day the drawer click passed in (or
  today when no date came in via the route).

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

- `journal_entries` — multiple rows per `(user_id, entry_date)`
  allowed. Automatic entries pin to a single source thread via
  the `thread_id uuid` FK (on delete set null); a partial-unique
  index on `(user_id, thread_id) WHERE source='automatic'`
  enforces "one automatic entry per thread, ever" so a worker
  re-running on the same thread extends the existing row rather
  than creating a duplicate. User entries leave `thread_id` null.
  Columns include `content`, `topics text[]`, `mood`, `people
  text[]`, `embedding vector(2048)`, claim stamps.
- `journal_thread_excludes` — `(user_id, thread_id)`.
  Populated when an automatic entry is deleted; the
  journaler's claim RPC filters these out.
- `journal_spam_tokens` — `(user_id, token)` PK + `ham_count`
  and `spam_count`. The Naive Bayes vocabulary. Tokens are
  stored already-stemmed (Snowball English); train and score
  paths must agree on the pipeline or rows never join.
- `journal_spam_stats` — `user_id` PK + `ham_total` and
  `spam_total` (counts of conversations labeled, not tokens).
  The Bayes prior + the cold-start gate.
- `journal_entries.ham_marked_at timestamptz null` — set
  the first time the user clicks the thumbs-up (Looks good)
  button on an automatic entry. Idempotency marker for ham
  training; the UI keeps the button visible but flags it
  with a green border (`.is-voted`), and the click handler
  short-circuits when this column is non-null so a re-click
  on an already-voted button doesn't fire a redundant RPC.
  The supabase update path also re-checks
  `ham_marked_at IS NULL` in its WHERE clause so a stale
  tab can't double-train.
- `threads.last_journaled_msg_id`, `journal_claim_holder`,
  `journal_claim_expires_at` — per-thread journaling
  cursor + claim stamps.
- Trigger `clear_journal_embedding_on_change` nulls the
  embedding columns when `content | topics | mood`
  change, so the embeddings worker re-vectorises.
- RLS: `auth.uid() = user_id` on both tables.
- Index on `(user_id, entry_date desc)`.
- RPCs:
  - `upsert_journal_automatic_entry(p_thread_id, ...)` -
    on-conflict path keyed on `(user_id, thread_id)` WHERE
    `source='automatic'`. `entry_date` is set on insert and
    intentionally not updated on conflict (the entry's date is
    the conversation-start day, fixed). Carries the
    `#variable_conflict use_column` plpgsql directive so
    `RETURNS TABLE` OUT-variable names don't collide with the
    target table's column names.
  - `claim_next_thread_for_journal` - filters threads in
    `journal_thread_excludes`, gates on at least two user
    messages on the thread (skip one-shot Q&A) past
    `last_journaled_msg_id`. Returns `thread_created_at` so
    the worker can compute `entry_date` in the user's IANA
    timezone (via `dateInZone` in `journal-day.ts`); pinning
    on the conversation start day keeps an entry from drifting
    onto whatever calendar day the worker happens to be
    processing it on.
  - `mark_thread_journaled_if_claimed` - advances the
    pointer if the holder still owns the claim.
  - `claim_next_pending_journal_entry` +
    `save_journal_entry_embedding_if_claimed` - the
    embeddings-side claim/save pair.
  - `search_journal_entries_by_embedding` - cosine
    similarity. No confidence bias; journals don't use
    the confidence metric memories carry.
  - `train_journal_spam(p_tokens text[], p_label text)` -
    bumps the per-token counts and the per-user totals row
    in one transaction. `security invoker`; the RPC reads
    `auth.uid()` and rejects the call if there's no
    session.
  - `untrain_journal_spam(p_tokens text[], p_label text)` -
    reverse of train. Decrements with `greatest(0, x - 1)`
    so an over-untrain (calling on tokens that weren't
    trained, or trained fewer times) is a no-op rather
    than an underflow. Garbage-collects token rows whose
    counts both hit zero so the table doesn't accumulate
    no-evidence entries.
  - `score_journal_spam(p_tokens text[])` - returns one row
    per matched token plus the user's totals replicated on
    every row. `security invoker`. The Bayes math runs in
    JS; this RPC just feeds the inputs.
  - `get_journal_spam_stats()` - standalone totals lookup
    used by the worker as a cheap cold-start gate before
    paying for the (potentially large) token query.

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
- **Spam-filter training paths.** Three signals feed the
  per-user Naive Bayes model.
  - Deleting an automatic entry (chat-side `journal_delete`
    tool path AND modal delete button, both routing through
    `journal-store.svelte.ts:deleteEntry`) trains as `spam`
    on the source conversation's tokens via
    `trainSpamFilterForThread`. Naturally one-shot per
    thread because `journal_thread_excludes` prevents the
    same thread from re-journaling.
  - The thumbs-up button on an automatic entry trains as
    `ham` on the source conversation's tokens. One-shot
    enforced by `ham_marked_at`.
  - Saving a user-authored entry (`saveUserEntry`) trains
    as `ham` on the entry's CONTENT via
    `trainSpamFilterForUserEntry` - no thread is involved,
    the entry IS the training input. Edits do NOT retrain;
    only the original save counts (rationale: re-training
    on every save would over-weight verbose users; the
    drift from heavy edits is acceptable for v1).
  All training is best-effort (silently swallows errors) -
  it must not break the user-facing delete / ham / save
  action.
- **Ham-rescind on delete.** Two flavours, mirroring the
  two ham sources.
  - Automatic entry delete: when `ham_marked_at` is
    non-null on the row being deleted, the delete path
    calls `untrainSpamFilterForThread(threadId, 'ham')`
    BEFORE `trainSpamFilterForThread(threadId, 'spam')`.
    Without the rescind, the same conversation's tokens
    would contribute +1 ham AND +1 spam, polluting both
    classes. With it, the net effect is a clean -ham +spam
    shift.
  - User entry delete: `untrainSpamFilterForUserEntry` on
    the entry's content. Rescinds the auto-ham vote that
    creation set. Safe for legacy user entries that
    pre-date the auto-ham wiring - the untrain RPC floors
    at zero so a decrement against a never-trained vocabulary
    is a no-op rather than an underflow.
  Both checks live in `journal-store.svelte.ts:deleteEntry`
  (and the equivalent automatic-only check in the
  `journal_delete` tool); the helper's contract stays
  best-effort fire-and-forget.
- **Spam-filter scoring path.** The journal agent
  tokenizes the conversation slice, scores it via
  `scoreSpamFilter`, and renders the score as a
  natural-language hint via `renderSpamHint`. The hint
  goes into `buildJournalPrompt` as `spamHint`; the prompt
  section is suppressed entirely when null (cold-start or
  scoring failure). The score is positioned in the prompt
  as a SOFT signal explicitly subordinate to the
  conversation's actual content - a topic pivot that
  reframes a technical thread as emotional should still
  produce a journal entry even if early tokens score as
  spam.
- **Cold-start gate.** Hardcoded at 20 examples per class
  (`SPAM_FILTER_COLD_START_MIN` in `spam_filter.ts`). Below
  that threshold the worker doesn't pass the score to the
  prompt at all - the LLM falls back to its built-in
  worthy/not-worthy heuristics. Tuning this requires data
  we don't have yet; revisit if cold-start drags on
  longer than expected.

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
- **Stemmer language is fixed at English.** The
  `snowball-stemmers` package supports many languages but
  `spam_filter.ts` hardcodes `'english'`. Non-English
  tokens get stemmed by English rules, which mostly leaves
  them alone but occasionally over-stems a Spanish/Italian
  suffix. Acceptable for v1; if non-English usage matters,
  detect language and pick a per-conversation stemmer
  (and decide whether to keep the per-language vocabulary
  separate so cross-language false-matches don't pollute
  the model).
- **Train and score must use the same tokenizer.**
  `tokenizeConversation` is the single source of truth.
  Drift between the two paths would land train rows in
  one vocabulary and score lookups in another; no token
  rows would join and the classifier would silently
  return prior-only scores forever. If you change the
  tokenizer, decide what to do with already-stored token
  rows (truncate? leave as legacy noise?) - there's no
  migration path baked in.
