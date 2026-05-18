-- Nak — Supabase schema.
--
-- Canonical source of truth for the database shape. Applied to the
-- linked project by `mise run sync` (see scripts/sync.mjs and
-- .mise.toml), which pipes this file through the Supabase Management
-- API's `runSql` endpoint. Pasting into the Supabase SQL Editor is a
-- last-resort fallback — the convention is that every schema change
-- goes through `mise run sync` so there's exactly one application
-- path and one source of truth. Don't tell users to run statements
-- manually; tell them to `mise run sync`.
--
-- ---------------------------------------------------------------------------
-- Rules for edits
-- ---------------------------------------------------------------------------
--
-- `mise run sync` re-applies this file start-to-finish on every run.
-- There are no up/down migrations. Every statement must therefore be
-- safe to run against an already-migrated database. Patterns this
-- file uses, in rough order of preference:
--
--   - `create table if not exists`, `create index if not exists`,
--     `create extension if not exists`.
--   - `alter table ... add column if not exists`.
--   - `drop policy if exists` followed by `create policy ...` —
--     the project-wide pattern for editing RLS policies.
--   - `create or replace function`. For triggers, `drop trigger if
--     exists` then `create trigger`.
--   - Statements with no native `if not exists` (notably
--     `alter publication ... add table`) go inside a guarded
--     `do $$ begin if not exists (...) then ... end if; end $$;`
--     block that checks the relevant catalog first.
--
-- If you add a statement that can't be made idempotent, stop and
-- fix that before merging — the next `mise run sync` on a
-- previously-synced project will error out, and the error won't be
-- at your statement, it'll be on whoever syncs after you.
--
-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------
--   profiles  one row per authenticated user (settings blob, timestamps)
--   threads   conversation containers owned by a user
--   messages  individual turns within a thread (incl. OpenAI-shape tool rows)
--   memories  freeform notes CRUD-able by the user and the memory_* tools
--   recipes   Cooklang recipes CRUD-able by the user and the recipe_* tools
--
-- All tables have Row Level Security enabled so an authenticated user
-- can only access rows they own. The anon key the browser uses is
-- safe to expose provided RLS policies stay in place.

create extension if not exists pgcrypto;

-- profiles ---------------------------------------------------------------

create table if not exists public.profiles (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null unique references auth.users(id) on delete cascade,
  created_at timestamptz not null default now()
);

-- Per-user preferences (default model tier, future UI bits). The app only
-- writes known keys, but we use jsonb so additions don't require a schema
-- change. Defaults to an empty object so row-inserts don't need to set it.
alter table public.profiles
  add column if not exists settings jsonb not null default '{}'::jsonb;

alter table public.profiles enable row level security;

drop policy if exists "profiles are self-visible" on public.profiles;
create policy "profiles are self-visible" on public.profiles
  for select using (auth.uid() = user_id);

drop policy if exists "profiles are self-inserted" on public.profiles;
create policy "profiles are self-inserted" on public.profiles
  for insert with check (auth.uid() = user_id);

drop policy if exists "profiles are self-updated" on public.profiles;
create policy "profiles are self-updated" on public.profiles
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- Auto-create a profile for new auth.users rows.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (user_id) values (new.id)
  on conflict (user_id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- threads ----------------------------------------------------------------

create table if not exists public.threads (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  title text not null default 'New conversation',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Optional per-thread model tier override. Null means "use user default".
-- The app stores the tier name ('smart' | 'balanced' | 'fast') and resolves
-- it to a concrete Venice model id at send-time, so the column stays schema-
-- compatible even as tiers are retuned. No CHECK constraint on purpose —
-- garbage values are scrubbed by the app on read.
alter table public.threads
  add column if not exists model text;

-- Optional per-thread reasoning_effort override ('low' | 'medium' | 'high').
-- Null means "use the user default" (profiles.settings.defaultReasoningEffort
-- → DEFAULT_REASONING_EFFORT). Plain text / no CHECK for the same reason as
-- `model` above: garbage is scrubbed by the app on read, and we want stored
-- rows to survive a future tier / provider change without a schema migration.
alter table public.threads
  add column if not exists reasoning_effort text;

-- Optional per-thread text.verbosity override ('low' | 'medium' | 'high').
-- Null means "use the user default" (profiles.settings.defaultVerbosity →
-- DEFAULT_VERBOSITY). Same plain-text / no-CHECK rationale as `model` /
-- `reasoning_effort`: the app validates on read and we want stored rows to
-- survive a future tier / provider change without a schema migration.
alter table public.threads
  add column if not exists verbosity text;

-- Removed 2026-04: web citations are now sourced from the client-side
-- `web_search` tool (see src/lib/tools/web_search.ts), not from a per-
-- thread or per-user toggle. The main chat loop never sets
-- `venice_parameters.enable_web_search` any more, so a per-thread
-- override for citations has nothing to override. Drop is idempotent
-- so re-applying on a fresh DB or a DB that never had the column is
-- a no-op.
alter table public.threads
  drop column if exists web_citations_enabled;

-- "User has renamed this thread explicitly, don't auto-rename."
-- Flipped true when the user renames via the title input or materializes
-- a draft with an explicit title. Consulted by the chat loop to decide
-- whether to inject the title-note + rename instructions that drive the
-- `update_title` tool - when true, the model never sees the rename prompt
-- at all, so it can't clobber the user's choice. Non-null with a default
-- so existing rows pick up `false` without a backfill.
alter table public.threads
  add column if not exists title_manually_set boolean not null default false;

-- Cached intuition payload for the most recent round it was computed
-- on. Holds {perception, drives:{...}, synthesis, computed_at_round,
-- computed_at_band, computed_at_confident, computed_at_at} - see
-- src/lib/intuition/types.ts for the canonical shape. Refreshed by
-- the chat-loop synchronously when (a) the model calls update_title
-- mid-turn or (b) the user's mood band/confidence changed since the
-- cache was last written, or (c) the staleness fuse trips after N
-- rounds without a refresh. Reused as-is on every other round so the
-- 7-call pipeline (perception + 5 drives + synthesis) doesn't run on
-- every chitchat turn. Null on cold-start threads; the first refresh
-- typically lands during turn 1 via the title trigger.
alter table public.threads
  add column if not exists intuition_payload jsonb;

-- Cached context-recall payload. Sibling of intuition_payload, fired on
-- the same trigger machinery (cold-start, mood shift, stale fuse, mid-
-- turn title change) and keyed by the same computed_at_round / debounce
-- semantics. Holds {note, computed_at_round, computed_at_band,
-- computed_at_column, computed_at_at, trigger} - see
-- src/lib/context-recall/types.ts for the canonical shape. Stitches the
-- memory-recall and conversation-recall agents' first-person notes into
-- one short paragraph that the chat-loop injects as a synthetic
-- <think> assistant turn alongside the intuition block. Null on cold-
-- start threads; the first refresh typically lands during turn 1 via
-- the cold-start trigger.
alter table public.threads
  add column if not exists context_recall_payload jsonb;

create index if not exists threads_user_updated_idx
  on public.threads (user_id, updated_at desc);

alter table public.threads enable row level security;

drop policy if exists "threads are self-selectable" on public.threads;
create policy "threads are self-selectable" on public.threads
  for select using (auth.uid() = user_id);

drop policy if exists "threads are self-insertable" on public.threads;
create policy "threads are self-insertable" on public.threads
  for insert with check (auth.uid() = user_id);

drop policy if exists "threads are self-updatable" on public.threads;
create policy "threads are self-updatable" on public.threads
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists "threads are self-deletable" on public.threads;
create policy "threads are self-deletable" on public.threads
  for delete using (auth.uid() = user_id);

-- messages ---------------------------------------------------------------

create table if not exists public.messages (
  id uuid primary key default gen_random_uuid(),
  thread_id uuid not null references public.threads(id) on delete cascade,
  role text not null check (role in ('system', 'user', 'assistant')),
  content text not null,
  created_at timestamptz not null default now()
);

create index if not exists messages_thread_created_idx
  on public.messages (thread_id, created_at asc);

alter table public.messages enable row level security;

-- Access is gated by the parent thread's ownership.
drop policy if exists "messages are self-selectable via thread" on public.messages;
create policy "messages are self-selectable via thread" on public.messages
  for select using (
    exists (
      select 1 from public.threads t
      where t.id = messages.thread_id and t.user_id = auth.uid()
    )
  );

drop policy if exists "messages are self-insertable via thread" on public.messages;
create policy "messages are self-insertable via thread" on public.messages
  for insert with check (
    exists (
      select 1 from public.threads t
      where t.id = messages.thread_id and t.user_id = auth.uid()
    )
  );

drop policy if exists "messages are self-deletable via thread" on public.messages;
create policy "messages are self-deletable via thread" on public.messages
  for delete using (
    exists (
      select 1 from public.threads t
      where t.id = messages.thread_id and t.user_id = auth.uid()
    )
  );

-- Tool calling -----------------------------------------------------------
--
-- Messages gain an OpenAI-shaped tool-call payload so conversations
-- involving tool calls round-trip faithfully. The shape follows the
-- OpenAI chat completions API (which Venice mirrors):
--
--   role='assistant' with tool_calls[]  — the model asked to invoke tools
--   role='tool'     with tool_call_id   — one row per tool execution result,
--                       name, content=<string-encoded result>
--
-- Keeping this shape on the wire means history → API becomes a direct
-- projection and future providers drop in with no schema churn.

-- Replace the role check to include 'tool'. Drop-and-recreate is safe here
-- because we control the only writer.
alter table public.messages drop constraint if exists messages_role_check;
alter table public.messages
  add constraint messages_role_check
  check (role in ('system', 'user', 'assistant', 'tool'));

-- Assistant rows that produced tool calls carry the raw array; we keep it
-- as jsonb so the OpenAI shape (`[{id, type, function: {name, arguments}}]`)
-- lands untouched. Null on every other row.
alter table public.messages
  add column if not exists tool_calls jsonb;

-- Tool-result rows reference the assistant call they answer. `name` echoes
-- the tool that was invoked (OpenAI includes it on the `tool` message too).
-- Both null on non-tool rows.
alter table public.messages
  add column if not exists tool_call_id text;
alter table public.messages
  add column if not exists name text;

-- Per-message provenance for assistant rows. `model` is the concrete Venice
-- model id that produced this response (e.g. 'kimi-k2-5'), captured at
-- send-time — not the abstract tier — so the row stays truthful even when
-- a tier is later re-pointed to a different backend. Null on non-assistant
-- rows and on assistant rows written before this column existed.
alter table public.messages
  add column if not exists model text;

-- OpenAI-shaped token usage block for the turn that produced this assistant
-- row: `{prompt_tokens, completion_tokens, total_tokens}`. Sourced from the
-- `usage` epilogue frame that Venice emits when we pass
-- `stream_options: { include_usage: true }`. Drives the context-window
-- indicator on the message card. Null when usage wasn't reported (the
-- provider declined, or the stream was cut short).
alter table public.messages
  add column if not exists usage jsonb;

-- Chain-of-thought text emitted by reasoning-capable models on
-- `delta.reasoning_content` during streaming. Stored separately from
-- `content` so the visible answer renders without mixing in the
-- thinking tokens — and so the UI can surface it in its own
-- collapsible "thought" panel. Null on non-assistant rows, on older
-- rows written before this column existed, and on turns where the
-- model didn't emit any reasoning.
alter table public.messages
  add column if not exists reasoning text;

-- Venice web-search citations array in the shape the API returns on
-- `venice_parameters.web_search_citations`:
--   [{index, title?, url, content?, date?}, ...]
-- Inline `^N^` / `^i,j^` superscripts in `content` index into this
-- array (1-based). Null when citations weren't requested, weren't
-- produced, or on rows older than this column. jsonb (not jsonb[])
-- so the whole list travels as a single typed blob matching the
-- wire shape.
alter table public.messages
  add column if not exists citations jsonb;

-- Per-thread set of enabled gated toolboxes. Stored as text[] so the
-- toolbox dimension sits in the thread row without a second table.
-- The always_on toolbox is implicit and is NOT represented here - its
-- tools ride every request regardless. Names are validated client-
-- side against `GATED_TOOLBOX_NAMES` in src/lib/tools/index.ts;
-- unknown names are silently dropped on both the model path
-- (`toggle_toolbox`) and the UI path (composer popover), so a renamed
-- or deleted toolbox does not break mid-flight.
--
-- The LLM can flip this via the `toggle_toolbox` meta-tool; the user
-- can flip it via the composer toolbox popover. Both paths write
-- through the same column.
alter table public.threads
  add column if not exists toolboxes_enabled text[] not null default '{}';

-- Backfill from the legacy boolean `tools_enabled` column, then drop
-- it. Runs in a guarded block so it's safe on projects that have
-- already migrated (the information_schema probe short-circuits) and
-- on projects that never had the boolean column (same). The array we
-- backfill with is the full set of gated toolboxes at migration time
-- (`cooking`, `memories`, `conversations`) - any thread that had
-- tools_enabled=true gets the same capability set it had before. The
-- list is hard-coded rather than derived because "everything that
-- existed when we migrated" is a one-shot decision that must not
-- drift when we add a new toolbox in a later release.
do $$
begin
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'threads'
      and column_name = 'tools_enabled'
  ) then
    update public.threads
      set toolboxes_enabled = array['cooking', 'memories', 'conversations']::text[]
      where tools_enabled = true
        and toolboxes_enabled = '{}'::text[];
    alter table public.threads drop column tools_enabled;
  end if;
end $$;

-- Soft-hide flag for the "Archive" drawer section. Archived threads still
-- load into the sidebar and remain viewable, but the composer is disabled
-- in the UI and they're rendered under a separate collapsed section.
-- Restoring flips this back to false and bumps updated_at so the thread
-- reappears at the top of the Chats list. Existing RLS (auth.uid() =
-- user_id) already covers both states — no policy change needed.
alter table public.threads
  add column if not exists archived boolean not null default false;

-- message_attachments ----------------------------------------------------
--
-- One row per file a user attached to a message. The file bytes live
-- in `data` as base64-encoded `text` — not `bytea`. The original
-- design used bytea, but PostgREST serialises bytea as a hex-escaped
-- string (`\x4869...`) on both read and write, which our client code
-- assumed was base64 and fed straight into `atob()`. Storing base64
-- as text removes the encoding ambiguity entirely: what goes in is
-- what comes out, it's directly usable by `atob`, and the ~33%
-- storage overhead is negligible under the 10 MB per-file cap.
--
-- `extracted_text` is populated at upload time for non-image files by
-- calling Venice's POST /api/v1/augment/text-parser endpoint, so the
-- LLM has a prompt-ready representation of documents without the
-- client having to bundle a PDF parser. It lives alongside `data` on
-- purpose: even after the binary is expired and reclaimed, the
-- extracted text stays, so re-reading an old conversation still shows
-- what the file said.
--
-- Expiration policy: the attachment_expiry worker nulls `data` and
-- stamps `expired_at` 30 days after the parent thread's `updated_at`.
-- `filename`, `mime_type`, `size_bytes`, and `extracted_text` are kept
-- so the message list can still render "<file>: <expired icon> |
-- [extracted text]". `data is null and expired_at is not null` is the
-- expired state; `data is not null and expired_at is null` is live.
--
-- No `updated_at` — attachments are immutable once written (the
-- expiry worker is the only writer post-insert, and it only nulls
-- the blob). RLS is via-parent-of-parent: attachment → message →
-- thread → user, mirroring the messages policies one level deeper.

create table if not exists public.message_attachments (
  id uuid primary key default gen_random_uuid(),
  message_id uuid not null references public.messages(id) on delete cascade,
  position int not null default 0,
  filename text not null,
  mime_type text not null,
  size_bytes int not null,
  data text,
  extracted_text text,
  expired_at timestamptz,
  created_at timestamptz not null default now()
);

-- Migrate the `data` column from bytea to text for projects synced
-- under the original design. Idempotent: the information_schema
-- check short-circuits on freshly-synced databases (where the column
-- is already text) and on subsequent syncs after the migration runs
-- (same reason). We drop + re-add rather than `alter column ... type
-- text using encode(data, 'base64')` because pre-migration rows hold
-- bytes under an ambiguous PostgREST encoding — re-encoding garbage
-- doesn't restore the original files. Post-migration, any rows that
-- existed before render as "expired" (data is null, extracted_text
-- preserved where populated) which matches the expired-attachment
-- rendering the message list already handles gracefully.
do $$
begin
  if exists (
    select 1
      from information_schema.columns
     where table_schema = 'public'
       and table_name = 'message_attachments'
       and column_name = 'data'
       and data_type = 'bytea'
  ) then
    -- Drop the dependent partial index first; `alter column ... type`
    -- would preserve it implicitly but we're dropping the column.
    -- `create index if not exists` further down recreates it.
    drop index if exists public.message_attachments_live_idx;
    alter table public.message_attachments drop column data;
    alter table public.message_attachments add column data text;
  end if;
end $$;

create index if not exists message_attachments_message_idx
  on public.message_attachments (message_id, position);

-- Partial index used by the expiration worker. Only carries live
-- (non-expired) rows so the scan to find expirable attachments stays
-- tiny in steady state — the bulk of history is already expired and
-- excluded from the index.
create index if not exists message_attachments_live_idx
  on public.message_attachments (message_id)
  where data is not null;

alter table public.message_attachments enable row level security;

-- Access is gated by the owning thread's user_id, reached via the
-- message FK. Same via-parent pattern as messages, one level deeper.
drop policy if exists "attachments are self-selectable via thread"
  on public.message_attachments;
create policy "attachments are self-selectable via thread"
  on public.message_attachments
  for select using (
    exists (
      select 1
        from public.messages m
        join public.threads t on t.id = m.thread_id
       where m.id = message_attachments.message_id
         and t.user_id = auth.uid()
    )
  );

drop policy if exists "attachments are self-insertable via thread"
  on public.message_attachments;
create policy "attachments are self-insertable via thread"
  on public.message_attachments
  for insert with check (
    exists (
      select 1
        from public.messages m
        join public.threads t on t.id = m.thread_id
       where m.id = message_attachments.message_id
         and t.user_id = auth.uid()
    )
  );

drop policy if exists "attachments are self-updatable via thread"
  on public.message_attachments;
create policy "attachments are self-updatable via thread"
  on public.message_attachments
  for update using (
    exists (
      select 1
        from public.messages m
        join public.threads t on t.id = m.thread_id
       where m.id = message_attachments.message_id
         and t.user_id = auth.uid()
    )
  ) with check (
    exists (
      select 1
        from public.messages m
        join public.threads t on t.id = m.thread_id
       where m.id = message_attachments.message_id
         and t.user_id = auth.uid()
    )
  );

drop policy if exists "attachments are self-deletable via thread"
  on public.message_attachments;
create policy "attachments are self-deletable via thread"
  on public.message_attachments
  for delete using (
    exists (
      select 1
        from public.messages m
        join public.threads t on t.id = m.thread_id
       where m.id = message_attachments.message_id
         and t.user_id = auth.uid()
    )
  );

-- Expiration RPC. Reclaims the binary for attachments whose owning
-- thread hasn't been touched in `p_days`. Runs as the caller (RLS
-- intact). The `limit` keeps each call's work bounded — the worker
-- drains the backlog by calling repeatedly while the row count is
-- non-zero, then naps for an hour when it returns 0.
--
-- We don't delete the row — we null `data` and stamp `expired_at`.
-- `filename`, `mime_type`, `size_bytes`, and `extracted_text` stay so
-- the message list can still render a "this file expired" entry with
-- the original name and the text the model saw. Conversations read a
-- year later still make sense.
drop function if exists public.expire_old_attachments(int);
create or replace function public.expire_old_attachments(
  p_days int
) returns int
language plpgsql security invoker as $$
declare
  affected int;
begin
  with stale as (
    select a.id
      from public.message_attachments a
      join public.messages m on m.id = a.message_id
      join public.threads t on t.id = m.thread_id
     where t.user_id = auth.uid()
       and a.data is not null
       and t.updated_at < now() - make_interval(days => p_days)
     limit 500
     for update skip locked
  )
  update public.message_attachments a
     set data = null,
         expired_at = now()
    from stale s
   where a.id = s.id;
  get diagnostics affected = row_count;
  return affected;
end $$;

-- Reflection pipeline ----------------------------------------------------
--
-- The memory-reflection agent (src/lib/agents/reflection/*) sweeps
-- completed conversations and updates long-term memory based on what it
-- learned. These columns on `threads` are the ground truth for two
-- questions:
--
--   1. "Has this thread been reflected on since its last terminal
--      assistant response?" — answered by comparing
--      `last_reflected_msg_id` to the newest terminal assistant message
--      in the thread.
--   2. "Is this thread currently being reflected on by some device?" —
--      answered by `reflection_holder_id`/`reflection_claim_expires_at`
--      (same per-row-claim pattern memories uses for embeddings).
--
-- A message id is the pointer rather than a timestamp because message
-- ids are stable and comparable without clock-skew worries across
-- devices. "Terminal assistant message" means a row with role='assistant',
-- no tool_calls (the tool round resolved), and non-null content — a
-- failed / empty response doesn't count as a round worth reflecting on.
alter table public.threads
  add column if not exists last_reflected_msg_id uuid references public.messages(id) on delete set null,
  add column if not exists reflection_holder_id text,
  add column if not exists reflection_claim_expires_at timestamptz;

-- Claim-lookup index. Partial on `reflection_holder_id is not null` so
-- the index only carries live claims — the common case is 0 rows
-- claimed, and a partial index stays tiny under that steady state.
create index if not exists threads_reflection_claim_idx
  on public.threads (reflection_claim_expires_at)
  where reflection_holder_id is not null;

-- Summarisation + search pipeline ----------------------------------------
--
-- Two workers cooperate to make conversations searchable:
--
--   1. The summary agent (src/lib/agents/summary/*) takes a thread and
--      writes a 2–3 sentence topical summary into `threads.summary`.
--      `last_summarised_msg_id` points at the terminal assistant
--      message we've summarised up to — same shape as
--      `last_reflected_msg_id`, same reasons (stable ids, no clock
--      skew). The per-thread claim columns mirror the reflection
--      agent exactly; the top-rail lease is a separate worker_kind
--      ('summary') so a device can hold summary + reflection +
--      embedding leases simultaneously.
--
--   2. The embeddings worker (src/lib/embeddings/*) then embeds
--      `title + summary` into `embedding` so the search RPC below can
--      cosine-rank threads against a query vector. The trigger in
--      `clear_thread_embedding_on_change` wipes the embedding when
--      either input changes, so the worker picks the row up again on
--      its next poll.
--
-- `embedding` is vector(2048) to match memories — same padding helper,
-- same forward-compat headroom for a future native-2048 model. No HNSW
-- index for the same reason memories skip it: per-user thread counts
-- stay tiny (hundreds at most), so seq scan is fast enough; halfvec +
-- HNSW is the escape hatch if that ever stops being true.
alter table public.threads
  add column if not exists summary text,
  add column if not exists last_summarised_msg_id uuid references public.messages(id) on delete set null,
  add column if not exists summary_claim_holder text,
  add column if not exists summary_claim_expires timestamptz,
  add column if not exists embedding vector(2048),
  add column if not exists embedding_model text,
  add column if not exists embedding_claim_holder text,
  add column if not exists embedding_claim_expires timestamptz;

-- Partial claim indexes: same shape as the reflection one. Only carry
-- live claims so the index stays tiny in steady state.
create index if not exists threads_summary_claim_idx
  on public.threads (summary_claim_expires)
  where summary_claim_holder is not null;

create index if not exists threads_embedding_claim_idx
  on public.threads (embedding_claim_expires)
  where embedding_claim_holder is not null;

-- Auto-title pipeline ---------------------------------------------------
--
-- The auto-title worker (src/lib/agents/auto_title/*) names threads that
-- are still on the `'New conversation'` placeholder. Per-thread claim
-- columns mirror the reflection / summary pair exactly; the singleton
-- lease is a separate `worker_kind` ('auto_title') so a device can hold
-- it concurrently with the others. Title generation is a single fast-
-- model completion against the opening user message - shape is one
-- non-streaming Venice call per thread, so 60s of claim TTL is plenty.
--
-- The eligibility predicate is "title still default AND user did not
-- pin a title manually AND there is at least one user message to title
-- from". The save RPC re-checks all of those before writing so a manual
-- rename or a model-driven `update_title` mid-poll wins the race.
alter table public.threads
  add column if not exists auto_title_claim_holder text,
  add column if not exists auto_title_claim_expires timestamptz;

create index if not exists threads_auto_title_claim_idx
  on public.threads (auto_title_claim_expires)
  where auto_title_claim_holder is not null;

-- Topic-tagging pipeline ------------------------------------------------
--
-- The topics worker (src/lib/agents/topics/*) tags each thread with a
-- short flat set of topic strings ('baking', 'sourdough', 'programming',
-- etc.) so the conversation drawer can offer a topic filter alongside
-- the default date-sorted list. The agent reads the conversation, the
-- existing per-user topic vocabulary, and asks the fast model to pick
-- 1-4 topics - reusing existing names when they fit so the vocabulary
-- doesn't sprawl into near-duplicates over time. Per-thread claim
-- columns mirror summary / auto_title exactly; the singleton lease is a
-- separate `worker_kind` ('topics') so a device can hold it concurrently
-- with the others.
--
-- `topics` defaults to '{}' (empty array) so existing rows match
-- "untagged" without a backfill. `last_topics_msg_id` is the terminal
-- assistant message we tagged up to; a new round on the thread re-
-- qualifies it for the next cycle the same way `last_summarised_msg_id`
-- does for the summary worker.
--
-- The GIN index on `topics` supports the `&&` (array overlap) predicate
-- the drawer uses when the user filters by one or more topics. It's
-- per-user-implicit because RLS scopes every read to auth.uid().
alter table public.threads
  add column if not exists topics text[] not null default '{}',
  add column if not exists last_topics_msg_id uuid references public.messages(id) on delete set null,
  add column if not exists topics_claim_holder text,
  add column if not exists topics_claim_expires timestamptz;

create index if not exists threads_topics_gin_idx
  on public.threads using gin (topics);

create index if not exists threads_topics_claim_idx
  on public.threads (topics_claim_expires)
  where topics_claim_holder is not null;

-- Invalidate the embedding whenever its inputs change. Pending =
-- `embedding is null`, so the embeddings worker will re-embed on its
-- next poll. We null the claim columns too — an in-flight worker save
-- would otherwise land a stale embedding, since its guard checks
-- `claim_holder = $me and claim_expires > now()` and both of those
-- would still match without this clear. Same invariant as the memories
-- trigger.
create or replace function public.clear_thread_embedding_on_change()
  returns trigger language plpgsql as $$
begin
  if new.title is distinct from old.title
     or new.summary is distinct from old.summary then
    new.embedding := null;
    new.embedding_model := null;
    new.embedding_claim_holder := null;
    new.embedding_claim_expires := null;
  end if;
  return new;
end $$;

drop trigger if exists clear_thread_embedding_on_change on public.threads;
create trigger clear_thread_embedding_on_change
  before update on public.threads
  for each row execute function public.clear_thread_embedding_on_change();

-- memories ---------------------------------------------------------------
--
-- Free-form notes the user (or the LLM via the memory_* tools) can CRUD
-- and search. `data` is plain text by design — we want the LLM to be able
-- to read and write it directly without a schema it has to learn.
--
-- The `embedding` column is sized at 2048 dims for forward compatibility.
-- Venice's current embeddings model (text-embedding-bge-m3) emits 1024
-- dims; the worker zero-pads to 2048 before storing. Cosine similarity is
-- invariant to the extra zeros (the padded suffix contributes nothing to
-- the dot product and scales both vectors' norms identically), so we can
-- eventually switch to a native-2048 model without a column-type
-- migration. See src/lib/models.ts for the padding helper.
--
-- No HNSW index: pgvector caps HNSW at 2000 dims for the `vector` type
-- (halfvec goes to 4000 but trades precision). Sequential scan is plenty
-- at memories-scale — a few ms at 10k rows per user. If we ever outgrow
-- seq scan, the escape hatch is to switch `embedding` to halfvec(2048)
-- and add the HNSW index then.
--
-- A background Web Worker (src/lib/embeddings/*) populates the column on
-- a poll of `where embedding is null`; rows stay pending until the worker
-- catches up, and `memory_search` falls back to ILIKE for those
-- unembedded rows so a just-written memory is never invisible.
--
-- `embedding_model` records which Venice model produced the vector. A
-- future model rotation reselects stale rows with
-- `where embedding_model <> $current` without a schema change.
--
-- `embedding_claim_holder` / `embedding_claim_expires` implement the
-- per-row lease for cross-device coordination. See the lease table below
-- for the full picture — the short version: when a worker on device A is
-- embedding a row, the claim columns are stamped so device B (if it ever
-- holds the lease) skips the row until the claim expires, preventing
-- duplicate Venice billing across devices.

create extension if not exists vector;

create table if not exists public.memories (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  label text not null,
  data text not null,
  embedding vector(2048),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Columns added after the initial table ship. `add column if not exists`
-- keeps every alter statement idempotent across re-runs of the script.
alter table public.memories
  add column if not exists embedding_model text,
  add column if not exists embedding_claim_holder text,
  add column if not exists embedding_claim_expires timestamptz,
  -- Confidence that this memory is still valid. Starts at 1.0 on
  -- create; the reflection agent's `memory_invalidate` halves it when
  -- the agent thinks a memory has been contradicted by new evidence.
  -- The memory-search RPC floors at 0.05 (effectively hides the row
  -- from search without hard-deleting — recoverable if the agent
  -- re-learns the fact) and applies a logarithmic boost to the
  -- similarity score so corroborated memories (`memory_update` calls
  -- `bump_memory_confidence`, adding 1.0 up to a cap of 10.0) rank
  -- higher than single-occurrence ones.
  add column if not exists confidence real not null default 1.0;

-- Upgrade path for projects that shipped with vector(1024) before the
-- pad-to-2048 decision. Guarded so fresh projects (already created at
-- vector(2048) above) skip the block entirely. We null the embedding
-- column first because ALTER TYPE on a vector column with mismatched-dim
-- rows would error. The null is safe — any previously-populated vector
-- gets re-embedded by the worker on the next poll, and
-- `embedding_model` is nulled alongside so memory_search knows it's
-- pending. No HNSW index to drop on old projects since we never shipped
-- one against 1024-dim either.
do $$
declare
  current_type text;
begin
  select format_type(atttypid, atttypmod) into current_type
    from pg_attribute
   where attrelid = 'public.memories'::regclass
     and attname = 'embedding'
     and not attisdropped;
  if current_type = 'vector(1024)' then
    drop index if exists memories_embedding_hnsw;
    update public.memories set embedding = null, embedding_model = null;
    alter table public.memories alter column embedding type vector(2048);
  end if;
end $$;

-- A prior revision of this file shipped an HNSW index. Drop it
-- unconditionally — see the "No HNSW index" comment at the top of this
-- section for rationale.
drop index if exists memories_embedding_hnsw;

create index if not exists memories_user_updated_idx
  on public.memories (user_id, updated_at desc);

-- Invalidate the embedding whenever the text that produced it changes.
-- Pending = `embedding is null`, so once the trigger fires the worker
-- will re-embed on its next poll. We null the claim columns too — an
-- in-flight worker save would otherwise land a now-stale embedding,
-- since its guard checks `claim_holder = $me and claim_expires > now()`
-- and both of those would still match without this clear.
create or replace function public.clear_memory_embedding_on_change()
  returns trigger language plpgsql as $$
begin
  if new.label is distinct from old.label or new.data is distinct from old.data then
    new.embedding := null;
    new.embedding_model := null;
    new.embedding_claim_holder := null;
    new.embedding_claim_expires := null;
  end if;
  return new;
end $$;

drop trigger if exists clear_memory_embedding_on_change on public.memories;
create trigger clear_memory_embedding_on_change
  before update on public.memories
  for each row execute function public.clear_memory_embedding_on_change();

alter table public.memories enable row level security;

drop policy if exists "memories are self-selectable" on public.memories;
create policy "memories are self-selectable" on public.memories
  for select using (auth.uid() = user_id);

drop policy if exists "memories are self-insertable" on public.memories;
create policy "memories are self-insertable" on public.memories
  for insert with check (auth.uid() = user_id);

drop policy if exists "memories are self-updatable" on public.memories;
create policy "memories are self-updatable" on public.memories
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists "memories are self-deletable" on public.memories;
create policy "memories are self-deletable" on public.memories
  for delete using (auth.uid() = user_id);

-- memory_relations -------------------------------------------------------
--
-- The volitional-memory layer's graph. Each row is a directed edge the
-- LLM (or the user) drew between two memories. Four kinds:
--   supports      - target reinforces the source's claim.
--   contradicts   - target disagrees with the source (stored
--                   asymmetrically; the LLM chooses direction).
--   generalises   - target is a broader version of the source.
--   specialises   - target is a narrower/concrete case of the source.
--
-- Cycles are legal. Retrieval bounds traversal depth (1 hop in v1) and
-- caps the fan-out per source so a runaway web of edges can't blow the
-- priming budget. `get_memory_relations` below is the retrieval primitive
-- the opening-recall and memory_search paths use.
--
-- `on delete cascade` on both foreign keys means deleting a memory
-- sweeps its edges automatically — no orphan rows, no code-side cleanup.
--
-- The `(user_id, from_memory_id, to_memory_id, kind)` unique constraint
-- prevents the LLM from double-inserting the same edge on a repeated
-- tool call. The chat-side tool still rejects self-loops (from_id =
-- to_id) at the wire boundary so the constraint-violation path stays for
-- the "same edge twice" case the LLM might actually trip.
--
-- Companion to `memories.confidence`: relations annotate the graph,
-- confidence annotates the node. Both surface in injected memory text
-- and the Memories.svelte UI so Jeff can QA what the LLM has built.

create table if not exists public.memory_relations (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  from_memory_id uuid not null references public.memories(id) on delete cascade,
  to_memory_id uuid not null references public.memories(id) on delete cascade,
  kind text not null check (
    kind in ('supports', 'contradicts', 'generalises', 'specialises')
  ),
  note text,
  created_at timestamptz not null default now(),
  unique (user_id, from_memory_id, to_memory_id, kind)
);

create index if not exists memory_relations_from_idx
  on public.memory_relations (user_id, from_memory_id);

create index if not exists memory_relations_to_idx
  on public.memory_relations (user_id, to_memory_id);

alter table public.memory_relations enable row level security;

drop policy if exists "memory_relations are self-selectable"
  on public.memory_relations;
create policy "memory_relations are self-selectable"
  on public.memory_relations
  for select using (auth.uid() = user_id);

drop policy if exists "memory_relations are self-insertable"
  on public.memory_relations;
create policy "memory_relations are self-insertable"
  on public.memory_relations
  for insert with check (auth.uid() = user_id);

drop policy if exists "memory_relations are self-updatable"
  on public.memory_relations;
create policy "memory_relations are self-updatable"
  on public.memory_relations
  for update using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

drop policy if exists "memory_relations are self-deletable"
  on public.memory_relations;
create policy "memory_relations are self-deletable"
  on public.memory_relations
  for delete using (auth.uid() = user_id);

-- recipes ----------------------------------------------------------------
--
-- Cooklang recipes the user authors in Nak (often by asking the model to
-- fetch one from a URL and save it). The store is deliberately simple —
-- the canonical representation is a single `cooklang` text column holding
-- the recipe's full source. All structure (ingredients, cookware, timers,
-- metadata) is re-derived at read-time by `src/lib/cooklang.ts`, so a
-- future spec change doesn't require a data migration.
--
-- `source` is an optional free-form provenance string (e.g. "NYT
-- Cooking — Alison Roman" or "my grandmother"); `source_url` is the
-- machine-readable URL when the model imported it from the web. Both
-- nullable because hand-typed recipes often have neither.
--
-- Embedding column added later (see "Recipe embeddings" section below).
-- Original design omitted it on the rationale that ILIKE-on-title is
-- enough for a single-user cookbook; that holds for the LLM tool path
-- but the drawer's recipe search is a human surface where a fuzzy
-- "fluffy potato side" should find "Mashed Potatoes." Vector storage
-- mirrors memories / wiki: 2048-padded, written by the shared
-- embeddings worker. The default ILIKE-on-title still works for
-- callers that pass no embedding (e.g. the `recipe_list` tool).

create table if not exists public.recipes (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  title text not null,
  source text,
  source_url text,
  cooklang text not null,
  -- User rating, 1-5 stars. Null means "unrated"; clearing the stars in
  -- the UI writes null rather than 0 so the unrated case is
  -- distinguishable from "actively rated zero" (which we don't allow).
  rating smallint,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Idempotent column add for projects synced before the rating rollout.
-- `add column if not exists` is enough on its own - the type is
-- compatible with existing null-only data, and the constraint below
-- guards new writes.
alter table public.recipes
  add column if not exists rating smallint;

-- 1-5 stars, or null. Wrapped in a do-block because `add constraint`
-- has no `if not exists` form; checking pg_constraint keeps the
-- statement re-runnable.
do $$ begin
  if not exists (
    select 1 from pg_constraint
     where conname = 'recipes_rating_check'
       and conrelid = 'public.recipes'::regclass
  ) then
    alter table public.recipes
      add constraint recipes_rating_check
      check (rating is null or (rating between 1 and 5));
  end if;
end $$;

create index if not exists recipes_user_updated_idx
  on public.recipes (user_id, updated_at desc);

-- "Upcoming" flag - workflow state, not recipe content. The user marks
-- recipes they plan to cook during the current grocery-shopping cycle
-- and they surface in a section at the top of the drawer listing. Not
-- part of recipe_versions on purpose - this is a transient bookmark,
-- not something to roll back through history. Toggling does NOT bump
-- updated_at (see setRecipeUpcoming in the client) so the recency
-- sort stays stable across toggles.
alter table public.recipes
  add column if not exists upcoming boolean not null default false;

-- Partial index: at any moment only a handful of recipes are upcoming,
-- so the index footprint stays tiny while still accelerating the
-- listing query that filters on `upcoming = true`.
create index if not exists recipes_user_upcoming_idx
  on public.recipes (user_id) where upcoming;

-- "Favorite" flag - long-lived bookmark for recipes the user has
-- decided they love and want one click away. Same versioning and
-- updated_at semantics as `upcoming` (workflow state, not content),
-- and the same partial-index strategy. The two flags are independent:
-- a recipe can be favorited without being upcoming, marked upcoming
-- without being a favorite, both, or neither. They surface as two
-- separate sections at the top of the drawer listing (Upcoming above
-- Favorites above the main list) and a recipe flagged for both
-- appears in both sections AND in its natural slot below - the
-- duplication is intentional and matches what the user asked for.
alter table public.recipes
  add column if not exists favorite boolean not null default false;

create index if not exists recipes_user_favorite_idx
  on public.recipes (user_id) where favorite;

alter table public.recipes enable row level security;

drop policy if exists "recipes are self-selectable" on public.recipes;
create policy "recipes are self-selectable" on public.recipes
  for select using (auth.uid() = user_id);

drop policy if exists "recipes are self-insertable" on public.recipes;
create policy "recipes are self-insertable" on public.recipes
  for insert with check (auth.uid() = user_id);

drop policy if exists "recipes are self-updatable" on public.recipes;
create policy "recipes are self-updatable" on public.recipes
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists "recipes are self-deletable" on public.recipes;
create policy "recipes are self-deletable" on public.recipes
  for delete using (auth.uid() = user_id);

-- recipe_versions --------------------------------------------------------
--
-- Immutable change log for `recipes`. Every create and every update
-- writes one snapshot row here capturing the full editable state
-- (title, cooklang, source, source_url) plus a required free-form
-- `change_message` describing the edit. The most-recent version row
-- always matches the corresponding `recipes` row by content; the
-- `recipes` row stays the denormalized cache so hot reads (list,
-- detail pane, drawer tab) remain one-table and one-index.
--
-- Why both: every read path today projects directly off `recipes` and
-- `cookbook.recipes[]` is denormalized too. A `current_version_id`
-- pointer would force a join on every read for no user-visible win,
-- since history is a cold path opened only when the user clicks into
-- it. Mirroring the current row into `recipe_versions` on every
-- mutation costs O(recipe size) bytes per edit, which is trivial at
-- single-user cookbook scale.
--
-- Retention is unbounded by design - the user opted in to keeping
-- every revision so the History panel reads as a complete diary.
--
-- Versions are immutable: select / insert policies only. A cascade
-- delete from `recipes` is the only way a row leaves this table.

create table if not exists public.recipe_versions (
  id uuid primary key default gen_random_uuid(),
  recipe_id uuid not null references public.recipes(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  title text not null,
  source text,
  source_url text,
  cooklang text not null,
  -- Snapshot of `recipes.rating` at the time of the save. Same
  -- semantics as the parent column (null = unrated, otherwise 1-5),
  -- so a revert restores the rating along with the rest of the
  -- editable state.
  rating smallint,
  change_message text not null,
  created_at timestamptz not null default now()
);

-- Idempotent column add for projects synced before the rating rollout.
alter table public.recipe_versions
  add column if not exists rating smallint;

create index if not exists recipe_versions_recipe_created_idx
  on public.recipe_versions (recipe_id, created_at desc);

-- Defensive user-scoped index. Most queries filter by recipe_id (which
-- is itself user-scoped via the FK), but RLS policy evaluation reads
-- user_id directly and a dedicated index keeps that fast as the table
-- grows.
create index if not exists recipe_versions_user_idx
  on public.recipe_versions (user_id);

alter table public.recipe_versions enable row level security;

drop policy if exists "recipe_versions are self-selectable"
  on public.recipe_versions;
create policy "recipe_versions are self-selectable"
  on public.recipe_versions
  for select using (auth.uid() = user_id);

drop policy if exists "recipe_versions are self-insertable"
  on public.recipe_versions;
create policy "recipe_versions are self-insertable"
  on public.recipe_versions
  for insert with check (auth.uid() = user_id);

-- No update / delete policies - versions are immutable once written.
-- Deletes flow only through the `on delete cascade` from `recipes`.

-- Backfill: every recipe that predates the versioning rollout gets one
-- "Initial version" row so the History panel is non-empty on day one.
-- Idempotent via `not exists` - re-running `mise run sync` does not
-- duplicate. Runs as the sync role, which bypasses RLS by design.
insert into public.recipe_versions
  (recipe_id, user_id, title, source, source_url, cooklang, rating,
   change_message, created_at)
select r.id, r.user_id, r.title, r.source, r.source_url, r.cooklang,
       r.rating, 'Initial version (backfilled).', r.created_at
  from public.recipes r
 where not exists (
   select 1 from public.recipe_versions v where v.recipe_id = r.id
 );

-- recipe_images / recipe_version_images ----------------------------------
--
-- Photo support for the cookbook. Two tables: `recipe_images` holds the
-- raw image bytes once per user-deduped image; `recipe_version_images`
-- links images to recipe versions (many-to-many, ordered by `position`).
--
-- Why split: a single image can be referenced by many version snapshots
-- (the user adds a photo, makes ten edits unrelated to photos, the same
-- bytes are still on the recipe at every version). Snapshotting bytes
-- per version would explode storage; snapshotting links is cheap. The
-- bytes-table-plus-link-table shape lets revert restore the exact set
-- a past version held without paying for byte duplication.
--
-- "Current photos for recipe X" is derived: photos linked to the most
-- recent `recipe_versions` row for X. The hot read path is "open detail
-- pane", which already needs to know the latest version (cheap probe via
-- the existing `recipe_versions_recipe_created_idx`). No
-- `current_version_id` denormalisation on `recipes` is needed.
--
-- Dedup: `unique (user_id, sha256)` on `recipe_images` collapses the
-- "user uploads the same photo twice" and "LLM re-attaches the same
-- conversation image" cases to one row. Scope is per-user so two
-- different users uploading the same image each get their own row -
-- RLS-clean, no cross-user data path through the lookup index.
--
-- Bytes shape: `data text` is base64, mirroring `message_attachments`
-- for the same PostgREST round-trip reasons (see the long comment on
-- that table for the bytea-vs-text history). `mime_type` and
-- `size_bytes` are stored alongside so the client can render thumbnails
-- without inspecting the base64 payload.
--
-- Lifecycle: a `recipe_images` row is orphaned only when no
-- `recipe_version_images` row references it. The AFTER DELETE trigger
-- on the link table reclaims the orphan row in the same transaction
-- that removed the last reference. Recipe delete cascades through
-- versions to link rows, which fires the trigger per-row and drops the
-- now-unreferenced image bytes. Insert-side orphans (an image was
-- created but the save that would have linked it failed) are not
-- reclaimed automatically; they're rare and cheap, and a separate GC
-- job can be added if it ever matters.

create table if not exists public.recipe_images (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  -- Hex-encoded SHA-256 of the raw image bytes (pre-base64). The
  -- client computes this via Web Crypto API before upload so the
  -- upsert RPC can dedup against existing rows. Hex (not base64) so
  -- the column is human-readable in the dashboard.
  sha256 text not null,
  mime_type text not null,
  size_bytes int not null,
  -- Base64 of the image bytes. Same encoding choice as
  -- `message_attachments.data` - PostgREST round-trips this as a
  -- plain string with no encoding ambiguity, the client feeds it
  -- straight into `data:` URIs without intermediate decoding.
  data text not null,
  created_at timestamptz not null default now(),
  unique (user_id, sha256)
);

alter table public.recipe_images enable row level security;

drop policy if exists "recipe_images are self-selectable" on public.recipe_images;
create policy "recipe_images are self-selectable" on public.recipe_images
  for select using (auth.uid() = user_id);

drop policy if exists "recipe_images are self-insertable" on public.recipe_images;
create policy "recipe_images are self-insertable" on public.recipe_images
  for insert with check (auth.uid() = user_id);

-- No update policy - rows are immutable once written. Bytes change ->
-- new sha256 -> new row.
drop policy if exists "recipe_images are self-deletable" on public.recipe_images;
create policy "recipe_images are self-deletable" on public.recipe_images
  for delete using (auth.uid() = user_id);

create table if not exists public.recipe_version_images (
  recipe_version_id uuid not null
    references public.recipe_versions(id) on delete cascade,
  image_id uuid not null references public.recipe_images(id),
  -- Denormalised user_id matches the convention on `recipes` and
  -- `recipe_versions`: every cookbook table is user-scoped via a
  -- direct column rather than a via-parent join, so RLS predicates
  -- are single-column index probes. The application sets this from
  -- `auth.uid()` on every insert; both parents (the version row and
  -- the image row) carry the same user_id by construction, so the
  -- denormalisation can't drift.
  user_id uuid not null references auth.users(id) on delete cascade,
  -- Display order within the version. Lower numbers render first.
  -- The link-write code assigns sequentially from 0; reorder
  -- operations renumber.
  position int not null,
  -- Optional caption for the photo, scoped to this version's link.
  -- Renders below the thumbnail and above the lightbox image when
  -- present; also feeds the img alt/title for accessibility. Labels
  -- are not unique - two photos on the same recipe can share the
  -- same caption. NULL means "no label". Per-version (link-level)
  -- so a label change creates a new version like every other photo
  -- edit, and reverting restores the labels that were on the recipe
  -- when the snapshot was saved.
  label text,
  created_at timestamptz not null default now(),
  primary key (recipe_version_id, image_id)
);

-- Idempotent on a database synced before labels existed. The column
-- is added nullable; existing link rows get NULL labels and render
-- without a caption, matching the pre-label behaviour.
alter table public.recipe_version_images
  add column if not exists label text;

create index if not exists recipe_version_images_image_idx
  on public.recipe_version_images (image_id);

create index if not exists recipe_version_images_user_idx
  on public.recipe_version_images (user_id);

alter table public.recipe_version_images enable row level security;

drop policy if exists "recipe_version_images are self-selectable"
  on public.recipe_version_images;
create policy "recipe_version_images are self-selectable"
  on public.recipe_version_images
  for select using (auth.uid() = user_id);

drop policy if exists "recipe_version_images are self-insertable"
  on public.recipe_version_images;
create policy "recipe_version_images are self-insertable"
  on public.recipe_version_images
  for insert with check (auth.uid() = user_id);

-- No update / delete policies for application code: links are
-- immutable once written. Cascades from `recipe_versions` (and from
-- `recipe_images` when an image row goes away) are the only paths
-- that remove rows. The orphan-GC trigger below runs as
-- `security definer` so it can reach across to delete the image row
-- when the last link to it is removed by a cascade.

-- Orphan reclamation. After the last link to an image is deleted
-- (typically as part of a recipe-delete cascade through versions),
-- delete the image row itself. `security definer` because the
-- triggering DELETE may be a cascade that the original caller's
-- role can't follow into recipe_images directly; the function still
-- only ever deletes images the same user owns, since the joined
-- recipe_images row carries the same user_id.
create or replace function public.gc_orphan_recipe_image()
  returns trigger
  language plpgsql
  security definer
  set search_path = public
as $$
begin
  if not exists (
    select 1 from public.recipe_version_images
     where image_id = old.image_id
  ) then
    delete from public.recipe_images where id = old.image_id;
  end if;
  return null;
end $$;

drop trigger if exists gc_orphan_recipe_image on public.recipe_version_images;
create trigger gc_orphan_recipe_image
  after delete on public.recipe_version_images
  for each row execute function public.gc_orphan_recipe_image();

-- Image upsert RPC. Returns the existing row's id if `(user_id,
-- sha256)` already maps to one, otherwise inserts and returns the
-- new id. Used by the client editor (user uploads) and by the
-- `recipe_photos_attach` LLM tool (copies a conversation
-- attachment into the recipe library). Two callers need the same
-- dedup semantics, so it lives in the database rather than in
-- application code.
drop function if exists public.recipe_image_upsert(text, text, int, text);
create or replace function public.recipe_image_upsert(
  p_sha256 text,
  p_mime_type text,
  p_size_bytes int,
  p_data text
) returns uuid
language plpgsql security invoker as $$
declare
  v_uid uuid := auth.uid();
  v_id uuid;
begin
  if v_uid is null then raise exception 'not authenticated'; end if;
  if p_sha256 is null or length(p_sha256) <> 64 then
    raise exception 'sha256 must be a 64-char hex digest';
  end if;
  if p_data is null or length(p_data) = 0 then
    raise exception 'data is required';
  end if;
  -- Two-step upsert that respects the table's no-update RLS posture.
  -- DO UPDATE would trip the RLS update policy that intentionally
  -- doesn't exist (recipe_images rows are immutable - byte changes
  -- mean a different sha256, which means a different row), so we use
  -- DO NOTHING and follow up with a SELECT for the existing id when
  -- the insert was suppressed by the conflict. The SELECT goes
  -- through the SELECT policy (auth.uid() = user_id) which is
  -- satisfied by construction.
  insert into public.recipe_images
    (user_id, sha256, mime_type, size_bytes, data)
    values (v_uid, p_sha256, p_mime_type, p_size_bytes, p_data)
    on conflict (user_id, sha256) do nothing
    returning id into v_id;
  if v_id is null then
    select id into v_id
      from public.recipe_images
     where user_id = v_uid and sha256 = p_sha256;
  end if;
  return v_id;
end $$;

-- Recipe versioning RPCs -------------------------------------------------
--
-- `security invoker` so RLS still applies; the function bodies also
-- assert `auth.uid()` defensively (same belt + suspenders pattern as
-- the worker-lease RPCs above). Both RPCs run inside one transaction
-- by virtue of being plpgsql functions, so the snapshot insert and
-- the parent insert/update either both land or neither does.
--
-- The update RPC uses paired `p_set_<field> boolean` flags to
-- distinguish "leave field alone" from "clear to null", since
-- Postgres can't tell an absent argument from a NULL one in a scalar
-- parameter list.

-- Older signatures must be dropped explicitly because Postgres treats
-- a parameter-list change as a different overload, not a replacement.
-- Drop every prior signature - the pre-rating one, the rating-only one,
-- and any leftover post-image variant - before recreate so a re-sync
-- from any prior schema lands on a single canonical function with no
-- overload ambiguity.
drop function if exists public.recipe_create_with_version(
  text, text, text, text, text);
drop function if exists public.recipe_create_with_version(
  text, text, text, text, smallint, text);
drop function if exists public.recipe_create_with_version(
  text, text, text, text, smallint, uuid[], text);
drop function if exists public.recipe_create_with_version(
  text, text, text, text, smallint, uuid[], text[], text);
create or replace function public.recipe_create_with_version(
  p_title text,
  p_cooklang text,
  p_source text,
  p_source_url text,
  p_rating smallint,
  p_image_ids uuid[],
  p_image_labels text[],
  p_change_message text
) returns table (
  id uuid,
  title text,
  source text,
  source_url text,
  cooklang text,
  rating smallint,
  upcoming boolean,
  favorite boolean,
  created_at timestamptz,
  updated_at timestamptz
)
language plpgsql security invoker as $$
declare
  v_uid uuid := auth.uid();
  v_recipe_id uuid;
  v_version_id uuid;
  v_now timestamptz := now();
  v_image_id uuid;
  v_pos int := 0;
  v_label text;
begin
  if v_uid is null then raise exception 'not authenticated'; end if;
  if p_title is null or length(trim(p_title)) = 0 then
    raise exception 'title is required';
  end if;
  if p_cooklang is null or length(p_cooklang) = 0 then
    raise exception 'cooklang is required';
  end if;
  if p_change_message is null or length(trim(p_change_message)) = 0 then
    raise exception 'change_message is required';
  end if;
  -- Mirror the table check so the RPC fails fast with a readable error
  -- before the insert. The table constraint is the load-bearing guard;
  -- this just produces a nicer message at the API surface.
  if p_rating is not null and (p_rating < 1 or p_rating > 5) then
    raise exception 'rating must be between 1 and 5';
  end if;
  -- Labels are optional and parallel-indexed with image_ids. A null
  -- array means "no labels for any photo"; a non-null array must have
  -- the same length as p_image_ids so position i in one corresponds
  -- to position i in the other. Anything else is a programming error
  -- on the caller side and we fail loud.
  if p_image_labels is not null
     and coalesce(array_length(p_image_labels, 1), 0)
       <> coalesce(array_length(p_image_ids, 1), 0) then
    raise exception 'image_labels length must match image_ids length';
  end if;

  insert into public.recipes (user_id, title, source, source_url, cooklang,
                              rating, created_at, updated_at)
    values (v_uid, p_title, p_source, p_source_url, p_cooklang,
            p_rating, v_now, v_now)
    returning recipes.id into v_recipe_id;

  insert into public.recipe_versions
    (recipe_id, user_id, title, source, source_url, cooklang, rating,
     change_message, created_at)
    values (v_recipe_id, v_uid, p_title, p_source, p_source_url, p_cooklang,
            p_rating, p_change_message, v_now)
    returning recipe_versions.id into v_version_id;

  -- Link any provided images to the new version in array order. We
  -- verify each image_id belongs to the calling user via the SELECT
  -- check - RLS would also block a foreign image, but failing fast
  -- here gives a readable error instead of an opaque RLS denial.
  -- The `ri` alias on recipe_images qualifies `id` away from the
  -- same-named OUT parameter declared in this function's RETURNS
  -- TABLE clause - bare `id = v_image_id` is ambiguous to the
  -- planner once the function is recreated against a session that
  -- treats the OUT name as a candidate column reference.
  if p_image_ids is not null and array_length(p_image_ids, 1) is not null then
    foreach v_image_id in array p_image_ids loop
      if not exists (
        select 1 from public.recipe_images ri
         where ri.id = v_image_id and ri.user_id = v_uid
      ) then
        raise exception 'image % not found', v_image_id;
      end if;
      v_label := null;
      if p_image_labels is not null then
        v_label := p_image_labels[v_pos + 1];
      end if;
      insert into public.recipe_version_images
        (recipe_version_id, image_id, user_id, position, label)
        values (v_version_id, v_image_id, v_uid, v_pos, v_label);
      v_pos := v_pos + 1;
    end loop;
  end if;

  return query
    select r.id, r.title, r.source, r.source_url, r.cooklang, r.rating,
           r.upcoming, r.favorite, r.created_at, r.updated_at
      from public.recipes r where r.id = v_recipe_id;
end $$;

-- Same overload-cleanup pattern as the create RPC: drop every prior
-- signature - the pre-rating shape, the rating-only shape, and any
-- earlier image-bearing variant - so a re-sync from any prior schema
-- converges on a single function.
drop function if exists public.recipe_update_with_version(
  uuid, boolean, text, boolean, text, boolean, text, boolean, text, text);
drop function if exists public.recipe_update_with_version(
  uuid, boolean, text, boolean, text, boolean, text, boolean, text,
  boolean, smallint, text);
drop function if exists public.recipe_update_with_version(
  uuid, boolean, text, boolean, text, boolean, text, boolean, text,
  boolean, smallint, boolean, uuid[], text);
drop function if exists public.recipe_update_with_version(
  uuid, boolean, text, boolean, text, boolean, text, boolean, text,
  boolean, smallint, boolean, uuid[], text[], text);
create or replace function public.recipe_update_with_version(
  p_id uuid,
  p_set_title boolean,
  p_title text,
  p_set_cooklang boolean,
  p_cooklang text,
  p_set_source boolean,
  p_source text,
  p_set_source_url boolean,
  p_source_url text,
  p_set_rating boolean,
  p_rating smallint,
  p_set_image_ids boolean,
  p_image_ids uuid[],
  p_image_labels text[],
  p_change_message text
) returns table (
  id uuid,
  title text,
  source text,
  source_url text,
  cooklang text,
  rating smallint,
  upcoming boolean,
  favorite boolean,
  created_at timestamptz,
  updated_at timestamptz
)
language plpgsql security invoker as $$
declare
  v_uid uuid := auth.uid();
  v_now timestamptz := now();
  v_title text;
  v_cooklang text;
  v_source text;
  v_source_url text;
  v_rating smallint;
  v_prev_version_id uuid;
  v_new_version_id uuid;
  v_image_id uuid;
  v_pos int := 0;
  v_label text;
begin
  if v_uid is null then raise exception 'not authenticated'; end if;
  if p_change_message is null or length(trim(p_change_message)) = 0 then
    raise exception 'change_message is required';
  end if;
  if p_set_rating and p_rating is not null
     and (p_rating < 1 or p_rating > 5) then
    raise exception 'rating must be between 1 and 5';
  end if;
  -- Label parallelism check, same shape as recipe_create_with_version.
  -- Only meaningful when the caller is also setting image_ids; if
  -- image_ids is being inherited from the previous version, labels
  -- ride along with the inheritance and p_image_labels is ignored.
  if p_set_image_ids and p_image_labels is not null
     and coalesce(array_length(p_image_labels, 1), 0)
       <> coalesce(array_length(p_image_ids, 1), 0) then
    raise exception 'image_labels length must match image_ids length';
  end if;

  -- Lock the row and read current state. `for update` prevents the
  -- snapshot from going stale if two writers race (the user editing in
  -- the modal while the model also calls recipe_update on the same
  -- recipe). The first writer commits its snapshot; the second sees the
  -- post-first-commit state and snapshots that, so history stays a
  -- linear chain with no gaps.
  select r.title, r.cooklang, r.source, r.source_url, r.rating
    into v_title, v_cooklang, v_source, v_source_url, v_rating
    from public.recipes r
   where r.id = p_id and r.user_id = v_uid
   for update;
  if not found then raise exception 'recipe % not found', p_id; end if;

  if p_set_title then
    if p_title is null or length(trim(p_title)) = 0 then
      raise exception 'title cannot be cleared';
    end if;
    v_title := p_title;
  end if;
  if p_set_cooklang then
    if p_cooklang is null or length(p_cooklang) = 0 then
      raise exception 'cooklang cannot be cleared';
    end if;
    v_cooklang := p_cooklang;
  end if;
  if p_set_source then v_source := p_source; end if;
  if p_set_source_url then v_source_url := p_source_url; end if;
  -- Rating uses the same set-flag pattern as the other nullable fields:
  -- absent leaves it alone; explicit null clears (back to "unrated").
  if p_set_rating then v_rating := p_rating; end if;

  update public.recipes
     set title = v_title, cooklang = v_cooklang,
         source = v_source, source_url = v_source_url,
         rating = v_rating,
         updated_at = v_now
   where recipes.id = p_id;

  insert into public.recipe_versions
    (recipe_id, user_id, title, source, source_url, cooklang, rating,
     change_message, created_at)
    values (p_id, v_uid, v_title, v_source, v_source_url, v_cooklang,
            v_rating, p_change_message, v_now)
    returning recipe_versions.id into v_new_version_id;

  -- Photo links on the new version. Two modes, distinguished by
  -- p_set_image_ids:
  --   true  -> the new version's link set is exactly p_image_ids in
  --            the given order. Empty array means "this version has
  --            no photos."
  --   false -> inherit from the previous-latest version (the row we
  --            just superseded). This mirrors the "absent leaves
  --            field alone" semantics of the scalar fields above:
  --            an edit that touches only title/cooklang carries the
  --            existing photo set forward without the caller having
  --            to enumerate it.
  if p_set_image_ids then
    if p_image_ids is not null
       and array_length(p_image_ids, 1) is not null then
      foreach v_image_id in array p_image_ids loop
        -- `ri` qualifies `id` away from the same-named OUT parameter
        -- declared in this function's RETURNS TABLE clause. The
        -- planner otherwise reads bare `id` as ambiguous and fails
        -- the call with "column reference 'id' is ambiguous".
        if not exists (
          select 1 from public.recipe_images ri
           where ri.id = v_image_id and ri.user_id = v_uid
        ) then
          raise exception 'image % not found', v_image_id;
        end if;
        v_label := null;
        if p_image_labels is not null then
          v_label := p_image_labels[v_pos + 1];
        end if;
        insert into public.recipe_version_images
          (recipe_version_id, image_id, user_id, position, label)
          values (v_new_version_id, v_image_id, v_uid, v_pos, v_label);
        v_pos := v_pos + 1;
      end loop;
    end if;
  else
    -- Find the previous-latest version (the row immediately before
    -- the one we just inserted). Same recipe, earlier created_at,
    -- newest first. Null when this is the very first version of a
    -- recipe (shouldn't happen on the update path, but defensive).
    select v.id
      into v_prev_version_id
      from public.recipe_versions v
     where v.recipe_id = p_id
       and v.id <> v_new_version_id
     order by v.created_at desc
     limit 1;
    if v_prev_version_id is not null then
      -- Carry forward labels alongside positions; an inherit path
      -- that dropped them would silently clear captions on every
      -- non-photo edit.
      insert into public.recipe_version_images
        (recipe_version_id, image_id, user_id, position, label)
      select v_new_version_id, l.image_id, v_uid, l.position, l.label
        from public.recipe_version_images l
       where l.recipe_version_id = v_prev_version_id
       order by l.position;
    end if;
  end if;

  return query
    select r.id, r.title, r.source, r.source_url, r.cooklang, r.rating,
           r.upcoming, r.favorite, r.created_at, r.updated_at
      from public.recipes r where r.id = p_id;
end $$;

-- Recipe-photo RPCs ------------------------------------------------------
--
-- Three operations: append photos, remove photos, reorder photos. Each
-- creates a new `recipe_versions` row with the post-mutation link set,
-- so a photo edit shows in the History panel like any other edit. The
-- `change_message` is required for the same reason scalar updates
-- require it.
--
-- Atomic by virtue of being plpgsql functions: the version insert and
-- the link inserts either all land or none do. The "find latest
-- version" probe is cheap (covered by `recipe_versions_recipe_created_idx`).
--
-- Why three RPCs instead of one with a mode flag: the verb is the
-- contract. attach is append-only and cannot reorder; remove names IDs
-- to drop and cannot rename; reorder takes the full new ordering and
-- cannot add or remove. Each one's failure mode is closed: an attach
-- can't accidentally clear the existing set, a reorder can't silently
-- add a stray ID. The LLM tool surface mirrors this 1:1.

-- Helper: insert a fresh `recipe_versions` row mirroring the parent
-- recipe's current state, then return the new version's id. The link
-- inserts that follow vary per RPC, but the "snapshot the recipe
-- columns under a new version id" boilerplate is shared.
drop function if exists public.recipe_new_photo_version(uuid, text);
create or replace function public.recipe_new_photo_version(
  p_id uuid,
  p_change_message text
) returns uuid
language plpgsql security invoker as $$
declare
  v_uid uuid := auth.uid();
  v_now timestamptz := now();
  v_title text;
  v_cooklang text;
  v_source text;
  v_source_url text;
  v_rating smallint;
  v_version_id uuid;
begin
  if v_uid is null then raise exception 'not authenticated'; end if;
  if p_change_message is null or length(trim(p_change_message)) = 0 then
    raise exception 'change_message is required';
  end if;
  -- Lock the parent so a concurrent recipe_update can't slip a snapshot
  -- in between our read and our insert. Same pattern as
  -- recipe_update_with_version.
  select r.title, r.cooklang, r.source, r.source_url, r.rating
    into v_title, v_cooklang, v_source, v_source_url, v_rating
    from public.recipes r
   where r.id = p_id and r.user_id = v_uid
   for update;
  if not found then raise exception 'recipe % not found', p_id; end if;

  -- Bump updated_at so the recipe sorts to the top of the list after a
  -- photo edit, the same as any other content edit.
  update public.recipes set updated_at = v_now where recipes.id = p_id;

  insert into public.recipe_versions
    (recipe_id, user_id, title, source, source_url, cooklang, rating,
     change_message, created_at)
    values (p_id, v_uid, v_title, v_source, v_source_url, v_cooklang,
            v_rating, p_change_message, v_now)
    returning recipe_versions.id into v_version_id;

  return v_version_id;
end $$;

-- recipe_attach_photos. Append the given image_ids onto the recipe's
-- current photo set, in array order, and write a new version. Returns
-- the post-mutation link list as `(image_id, position)` rows.
drop function if exists public.recipe_attach_photos(uuid, uuid[], text);
drop function if exists public.recipe_attach_photos(uuid, uuid[], text[], text);
create or replace function public.recipe_attach_photos(
  p_recipe_id uuid,
  p_image_ids uuid[],
  p_image_labels text[],
  p_change_message text
) returns table (image_id uuid, "position" int, label text)
language plpgsql security invoker as $$
declare
  v_uid uuid := auth.uid();
  v_new_version_id uuid;
  v_prev_version_id uuid;
  v_image_id uuid;
  v_pos int := 0;
  v_idx int := 0;
  v_attach_label text;
begin
  if v_uid is null then raise exception 'not authenticated'; end if;
  if p_image_ids is null or array_length(p_image_ids, 1) is null then
    raise exception 'photos is required and must be non-empty';
  end if;
  if p_image_labels is not null
     and coalesce(array_length(p_image_labels, 1), 0)
       <> coalesce(array_length(p_image_ids, 1), 0) then
    raise exception 'image_labels length must match image_ids length';
  end if;

  v_new_version_id := public.recipe_new_photo_version(p_recipe_id, p_change_message);

  -- Carry forward the previous version's links (and their labels)
  -- so this version reads as "previous + appended". Dropping labels
  -- on append would silently strip every existing caption on the
  -- recipe, which would be a surprising side-effect of "add a photo".
  select v.id
    into v_prev_version_id
    from public.recipe_versions v
   where v.recipe_id = p_recipe_id
     and v.id <> v_new_version_id
   order by v.created_at desc
   limit 1;
  if v_prev_version_id is not null then
    insert into public.recipe_version_images
      (recipe_version_id, image_id, user_id, position, label)
    select v_new_version_id, l.image_id, v_uid, l.position, l.label
      from public.recipe_version_images l
     where l.recipe_version_id = v_prev_version_id
     order by l.position;
    select coalesce(max(l.position) + 1, 0)
      into v_pos
      from public.recipe_version_images l
     where l.recipe_version_id = v_new_version_id;
  end if;

  foreach v_image_id in array p_image_ids loop
    v_idx := v_idx + 1;
    if not exists (
      select 1 from public.recipe_images
       where id = v_image_id and user_id = v_uid
    ) then
      raise exception 'image % not found', v_image_id;
    end if;
    v_attach_label := null;
    if p_image_labels is not null then
      v_attach_label := p_image_labels[v_idx];
    end if;
    -- Skip duplicates - if the same image is already on this recipe,
    -- attaching it again is a no-op rather than a primary-key violation
    -- on (recipe_version_id, image_id). Keeps the LLM-side path simple
    -- when the model isn't sure whether a photo it wants to add is
    -- already there. The table alias `vi` qualifies `image_id` away
    -- from the same-named OUT parameter declared in this function's
    -- RETURNS TABLE clause - bare `image_id = v_image_id` is
    -- ambiguous to the planner.
    --
    -- When a duplicate's incoming label is non-null, update the
    -- inherited label so the caller can use attach as a "set or
    -- update label" affordance for an existing photo. A null label
    -- on a duplicate is treated as "no preference" and leaves the
    -- existing label alone. Empty / whitespace-only strings reach
    -- this branch as null (normalised in the TS service helper) so
    -- attach is additive-only for captions; recipe_photo_label_set
    -- is the verb for clearing or overwriting existing captions.
    if not exists (
      select 1 from public.recipe_version_images vi
       where vi.recipe_version_id = v_new_version_id and vi.image_id = v_image_id
    ) then
      insert into public.recipe_version_images
        (recipe_version_id, image_id, user_id, position, label)
        values (v_new_version_id, v_image_id, v_uid, v_pos, v_attach_label);
      v_pos := v_pos + 1;
    elsif v_attach_label is not null then
      update public.recipe_version_images vi
         set label = v_attach_label
       where vi.recipe_version_id = v_new_version_id
         and vi.image_id = v_image_id;
    end if;
  end loop;

  return query
    select l.image_id, l.position, l.label
      from public.recipe_version_images l
     where l.recipe_version_id = v_new_version_id
     order by l.position;
end $$;

-- recipe_remove_photos. Remove the given image_ids from the recipe's
-- current photo set and write a new version with the survivors. Throws
-- when an id isn't currently linked, so the LLM can see "I asked for
-- something stale" rather than a silent no-op.
drop function if exists public.recipe_remove_photos(uuid, uuid[], text);
create or replace function public.recipe_remove_photos(
  p_recipe_id uuid,
  p_image_ids uuid[],
  p_change_message text
) returns table (image_id uuid, "position" int, label text)
language plpgsql security invoker as $$
declare
  v_uid uuid := auth.uid();
  v_new_version_id uuid;
  v_prev_version_id uuid;
  v_pos int := 0;
  v_missing uuid[];
begin
  if v_uid is null then raise exception 'not authenticated'; end if;
  if p_image_ids is null or array_length(p_image_ids, 1) is null then
    raise exception 'photos is required and must be non-empty';
  end if;

  -- Find the current latest version BEFORE creating the new one, so
  -- "currently linked" reflects the state the caller saw.
  select v.id
    into v_prev_version_id
    from public.recipe_versions v
    join public.recipes r on r.id = v.recipe_id
   where v.recipe_id = p_recipe_id and r.user_id = v_uid
   order by v.created_at desc
   limit 1;
  if v_prev_version_id is null then
    raise exception 'recipe % not found', p_recipe_id;
  end if;

  -- Verify every requested id is actually currently linked. Names
  -- the offending IDs in the error so the LLM can re-issue the call
  -- with the right set rather than guessing.
  select array_agg(x)
    into v_missing
    from unnest(p_image_ids) x
   where not exists (
     select 1 from public.recipe_version_images l
      where l.recipe_version_id = v_prev_version_id and l.image_id = x
   );
  if v_missing is not null then
    raise exception 'photos not on recipe: %', v_missing;
  end if;

  v_new_version_id := public.recipe_new_photo_version(p_recipe_id, p_change_message);

  -- Insert survivors in their original relative order, renumbered
  -- from 0 so positions stay dense. Labels travel with the link so
  -- "remove photo X" doesn't strip captions off the surviving photos.
  insert into public.recipe_version_images
    (recipe_version_id, image_id, user_id, position, label)
  select v_new_version_id, l.image_id, v_uid,
         row_number() over (order by l.position) - 1,
         l.label
    from public.recipe_version_images l
   where l.recipe_version_id = v_prev_version_id
     and l.image_id <> all (p_image_ids)
   order by l.position;

  return query
    select l.image_id, l.position, l.label
      from public.recipe_version_images l
     where l.recipe_version_id = v_new_version_id
     order by l.position;
end $$;

-- recipe_reorder_photos. Set the photo order to exactly p_image_ids.
-- The array MUST be a permutation of the recipe's current photo set -
-- any ID missing or any extra ID is a hard error. This forecloses the
-- "I forgot to enumerate" footgun the LLM would otherwise fall into.
drop function if exists public.recipe_reorder_photos(uuid, uuid[], text);
create or replace function public.recipe_reorder_photos(
  p_recipe_id uuid,
  p_image_ids uuid[],
  p_change_message text
) returns table (image_id uuid, "position" int, label text)
language plpgsql security invoker as $$
declare
  v_uid uuid := auth.uid();
  v_new_version_id uuid;
  v_prev_version_id uuid;
  v_current uuid[];
  v_image_id uuid;
  v_pos int := 0;
begin
  if v_uid is null then raise exception 'not authenticated'; end if;
  if p_image_ids is null or array_length(p_image_ids, 1) is null then
    raise exception 'photos is required and must be non-empty';
  end if;

  select v.id
    into v_prev_version_id
    from public.recipe_versions v
    join public.recipes r on r.id = v.recipe_id
   where v.recipe_id = p_recipe_id and r.user_id = v_uid
   order by v.created_at desc
   limit 1;
  if v_prev_version_id is null then
    raise exception 'recipe % not found', p_recipe_id;
  end if;

  select array_agg(l.image_id)
    into v_current
    from public.recipe_version_images l
   where l.recipe_version_id = v_prev_version_id;
  if v_current is null then v_current := array[]::uuid[]; end if;

  -- Permutation check: array_length must match, and every id in
  -- p_image_ids must appear in the current set (and vice versa,
  -- captured by the length match plus uniqueness from the primary
  -- key on the link table).
  if coalesce(array_length(p_image_ids, 1), 0)
     <> coalesce(array_length(v_current, 1), 0) then
    raise exception 'photos must list the recipe''s exact current set (got % ids, recipe has %)',
      coalesce(array_length(p_image_ids, 1), 0),
      coalesce(array_length(v_current, 1), 0);
  end if;
  if exists (
    select 1 from unnest(p_image_ids) x
     where x <> all (v_current)
  ) then
    raise exception 'photos contains an id not currently on the recipe';
  end if;
  -- Catch duplicate ids in p_image_ids - the earlier length check
  -- only proves count parity, not uniqueness.
  if (select count(*) from unnest(p_image_ids))
     <> (select count(distinct x) from unnest(p_image_ids) x) then
    raise exception 'photos contains duplicate ids';
  end if;

  v_new_version_id := public.recipe_new_photo_version(p_recipe_id, p_change_message);

  -- Pull each photo's label from the previous version's link so the
  -- reorder preserves captions. Reorder is "change order, nothing
  -- else" by contract; if it stripped labels, the LLM would have to
  -- re-set every caption after every reorder - a footgun the API
  -- shouldn't hand out.
  foreach v_image_id in array p_image_ids loop
    insert into public.recipe_version_images
      (recipe_version_id, image_id, user_id, position, label)
    select v_new_version_id, v_image_id, v_uid, v_pos, l.label
      from public.recipe_version_images l
     where l.recipe_version_id = v_prev_version_id
       and l.image_id = v_image_id;
    v_pos := v_pos + 1;
  end loop;

  return query
    select l.image_id, l.position, l.label
      from public.recipe_version_images l
     where l.recipe_version_id = v_new_version_id
     order by l.position;
end $$;

-- recipe_set_photo_labels. Update labels on photos that are already
-- linked to a recipe. The two arrays are parallel-indexed: image_ids[i]
-- gets label image_labels[i]. NULL in image_labels clears that photo's
-- label; an empty string is also treated as a clear (the UI sends "" as
-- the "no caption" sentinel from a blank input). Photos not named in
-- p_image_ids inherit their existing labels unchanged.
--
-- Like the other photo RPCs, this creates a new recipe_versions row so
-- a label change shows in the History panel like any other edit.
drop function if exists public.recipe_set_photo_labels(uuid, uuid[], text[], text);
create or replace function public.recipe_set_photo_labels(
  p_recipe_id uuid,
  p_image_ids uuid[],
  p_image_labels text[],
  p_change_message text
) returns table (image_id uuid, "position" int, label text)
language plpgsql security invoker as $$
declare
  v_uid uuid := auth.uid();
  v_new_version_id uuid;
  v_prev_version_id uuid;
  v_image_id uuid;
  v_idx int := 0;
  v_label text;
  v_missing uuid[];
begin
  if v_uid is null then raise exception 'not authenticated'; end if;
  if p_image_ids is null or array_length(p_image_ids, 1) is null then
    raise exception 'photos is required and must be non-empty';
  end if;
  if p_image_labels is null
     or coalesce(array_length(p_image_labels, 1), 0)
       <> coalesce(array_length(p_image_ids, 1), 0) then
    raise exception 'image_labels length must match image_ids length';
  end if;

  -- Resolve "currently linked" against the previous version, before
  -- creating the new one - same pattern as recipe_remove_photos.
  select v.id
    into v_prev_version_id
    from public.recipe_versions v
    join public.recipes r on r.id = v.recipe_id
   where v.recipe_id = p_recipe_id and r.user_id = v_uid
   order by v.created_at desc
   limit 1;
  if v_prev_version_id is null then
    raise exception 'recipe % not found', p_recipe_id;
  end if;

  -- Verify every requested id is currently on the recipe. Names the
  -- offenders in the error so the LLM can re-issue against fresh
  -- state rather than guessing.
  select array_agg(x)
    into v_missing
    from unnest(p_image_ids) x
   where not exists (
     select 1 from public.recipe_version_images l
      where l.recipe_version_id = v_prev_version_id and l.image_id = x
   );
  if v_missing is not null then
    raise exception 'photos not on recipe: %', v_missing;
  end if;

  v_new_version_id := public.recipe_new_photo_version(p_recipe_id, p_change_message);

  -- Carry forward all of the previous version's links (positions and
  -- labels) verbatim. Photos whose labels we're not changing inherit
  -- as-is; photos we are changing get UPDATEd below.
  insert into public.recipe_version_images
    (recipe_version_id, image_id, user_id, position, label)
  select v_new_version_id, l.image_id, v_uid, l.position, l.label
    from public.recipe_version_images l
   where l.recipe_version_id = v_prev_version_id
   order by l.position;

  -- Apply the new labels. An empty string normalises to NULL - the
  -- UI's "blank input means clear" convention - so the DB doesn't
  -- accumulate "" rows that read as captions of zero width.
  foreach v_image_id in array p_image_ids loop
    v_idx := v_idx + 1;
    v_label := p_image_labels[v_idx];
    if v_label is not null and length(trim(v_label)) = 0 then
      v_label := null;
    end if;
    update public.recipe_version_images vi
       set label = v_label
     where vi.recipe_version_id = v_new_version_id
       and vi.image_id = v_image_id;
  end loop;

  return query
    select l.image_id, l.position, l.label
      from public.recipe_version_images l
     where l.recipe_version_id = v_new_version_id
     order by l.position;
end $$;

-- Recipe embeddings ------------------------------------------------------
--
-- Late add to the recipes table: the file-level comment further up
-- claims "no embedding column" on the rationale that ILIKE-on-title is
-- enough for a single-user cookbook. That holds for the LLM tool path
-- (the model already knows what title it just wrote), but the drawer's
-- recipe search is a human-facing surface where "fluffy potato side"
-- should find "Mashed Potatoes with Olive Oil." The sidebar wires
-- through the same embed-then-merge pipeline the wiki uses, so a
-- column + the standard claim/save/search RPC trio joins recipes
-- without disturbing the existing recipe_*_with_version RPCs.
--
-- Same 2048-padded vector storage as memories / wiki so the single
-- embeddings worker can share a pool and no per-source dim plumbing
-- is needed.
alter table public.recipes
  add column if not exists embedding vector(2048);
alter table public.recipes
  add column if not exists embedding_model text;
alter table public.recipes
  add column if not exists embedding_claim_holder text;
alter table public.recipes
  add column if not exists embedding_claim_expires timestamptz;

-- Invalidate the embedding whenever the text that produced it changes.
-- The embedding source builds its input from title + source + cooklang
-- (see src/lib/embeddings/sources/recipes.ts), so any of those three
-- diverging means the stored vector is stale. Null the claim columns
-- too so an in-flight worker save (which guards on holder + expires >
-- now()) cannot land a stale vector against the new text.
create or replace function public.clear_recipe_embedding_on_change()
  returns trigger language plpgsql as $$
begin
  if new.title is distinct from old.title
     or new.cooklang is distinct from old.cooklang
     or new.source is distinct from old.source then
    new.embedding := null;
    new.embedding_model := null;
    new.embedding_claim_holder := null;
    new.embedding_claim_expires := null;
  end if;
  return new;
end $$;

drop trigger if exists clear_recipe_embedding_on_change on public.recipes;
create trigger clear_recipe_embedding_on_change
  before update on public.recipes
  for each row execute function public.clear_recipe_embedding_on_change();

-- Claim the next recipe whose embedding is null or whose prior claim
-- has expired. Same skip-locked fairness and claim shape as the wiki
-- pipeline. Returns (id, title, source, cooklang) so the worker can
-- build the embedding input without a second round-trip.
drop function if exists public.claim_next_pending_recipe(text, int);
create or replace function public.claim_next_pending_recipe(
  p_holder_id text,
  p_ttl_seconds int
) returns table (id uuid, title text, source text, cooklang text)
language sql security invoker as $$
  with candidate as (
    select r.id
      from public.recipes r
     where r.user_id = auth.uid()
       and r.embedding is null
       and (r.embedding_claim_expires is null
            or r.embedding_claim_expires < now())
     order by r.updated_at desc
     limit 1
     for update skip locked
  )
  update public.recipes r
     set embedding_claim_holder = p_holder_id,
         embedding_claim_expires = now() + make_interval(secs => p_ttl_seconds)
    from candidate c
   where r.id = c.id
  returning r.id, r.title, r.source, r.cooklang;
$$;

drop function if exists public.save_recipe_embedding_if_claimed(uuid, text, vector, text);
create or replace function public.save_recipe_embedding_if_claimed(
  p_id uuid,
  p_holder_id text,
  p_embedding vector(2048),
  p_embedding_model text
) returns boolean
language plpgsql security invoker as $$
declare
  updated int;
begin
  update public.recipes
     set embedding = p_embedding,
         embedding_model = p_embedding_model,
         embedding_claim_holder = null,
         embedding_claim_expires = null
   where id = p_id
     and user_id = auth.uid()
     and embedding_claim_holder = p_holder_id
     and embedding_claim_expires > now();
  get diagnostics updated = row_count;
  return updated > 0;
end $$;

-- Cosine similarity search. Same shape as the wiki RPC; the sidebar
-- merges these hits with an ILIKE pass on the client side so freshly
-- written recipes that the worker has not embedded yet still appear.
drop function if exists public.search_recipes_by_embedding(vector, int);
create or replace function public.search_recipes_by_embedding(
  query_embedding vector(2048),
  match_limit int
) returns table (
  id uuid,
  title text,
  source text,
  source_url text,
  cooklang text,
  rating smallint,
  upcoming boolean,
  favorite boolean,
  created_at timestamptz,
  updated_at timestamptz,
  similarity real
)
language sql stable security invoker as $$
  select id, title, source, source_url, cooklang, rating,
         upcoming, favorite, created_at, updated_at,
         (1 - (embedding <=> query_embedding))::real as similarity
    from public.recipes
   where user_id = auth.uid()
     and embedding is not null
   order by embedding <=> query_embedding asc
   limit match_limit
$$;

-- worker_leases ----------------------------------------------------------
--
-- Singleton per user per worker kind: at most one worker of a given kind
-- runs at a time across all the user's open tabs and devices. Originally
-- an embeddings-only table (`embedding_worker_leases`); generalised when
-- the memory-reflection agent landed — agents are a category now, not a
-- one-off, and each agent kind wants the same lease-plus-heartbeat
-- shape. The `worker_kind` column partitions the lease: `'embedding'`
-- and `'reflection'` hold independently so both can run concurrently as
-- long as there's one per kind.
--
-- Lease is the top rail for "one device at a time per worker kind"; the
-- bottom rails (per-row claims on `memories`, per-thread claims on
-- `threads`) handle the lease-handover race where in-flight work on the
-- outgoing device shouldn't collide with the new lease holder.
--
-- Workers hold their lease by writing `(holder_id, expires_at)` and
-- heartbeating it forward every ~20s. When `expires_at < now()` the
-- lease is claimable by anyone. A polling device runs acquire every
-- ~20s; it's one cheap SELECT plus an optional UPDATE.
--
-- Why `(user_id, worker_kind)` composite primary key: we want "at most
-- one per user per kind" structurally enforced, and `on conflict
-- (user_id, worker_kind)` is the primitive the acquire RPC relies on.

-- Clean up the pre-generalisation table on databases synced before the
-- rename. `cascade` also sweeps its old RLS policies. Idempotent — a
-- never-synced database or a freshly-synced one has no table by that
-- name and skips.
drop table if exists public.embedding_worker_leases cascade;

create table if not exists public.worker_leases (
  user_id uuid not null references auth.users(id) on delete cascade,
  worker_kind text not null,
  holder_id text not null,
  expires_at timestamptz not null,
  primary key (user_id, worker_kind)
);

alter table public.worker_leases enable row level security;

drop policy if exists "worker leases are self-selectable"
  on public.worker_leases;
create policy "worker leases are self-selectable"
  on public.worker_leases
  for select using (auth.uid() = user_id);

drop policy if exists "worker leases are self-insertable"
  on public.worker_leases;
create policy "worker leases are self-insertable"
  on public.worker_leases
  for insert with check (auth.uid() = user_id);

drop policy if exists "worker leases are self-updatable"
  on public.worker_leases;
create policy "worker leases are self-updatable"
  on public.worker_leases
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists "worker leases are self-deletable"
  on public.worker_leases;
create policy "worker leases are self-deletable"
  on public.worker_leases
  for delete using (auth.uid() = user_id);

-- Worker-lease RPCs ------------------------------------------------------
--
-- `security invoker` throughout — RLS still applies, but the explicit
-- `user_id = auth.uid()` guards inside each function's body keep intent
-- obvious at the call site and protect us if the policies ever change
-- shape. Every function is drop-then-create because some signatures
-- change the return type, which `create or replace` can't do in place.
--
-- Drop the pre-generalisation function signatures too, so a
-- freshly-synced database with no leftover table still has no leftover
-- functions pointing at it.
drop function if exists public.acquire_embedding_lease(text, int);
drop function if exists public.heartbeat_embedding_lease(text, int);
drop function if exists public.release_embedding_lease(text);

-- Try to take the singleton lease for a given worker kind. Returns true
-- iff we hold it after the call. Atomic via `on conflict do update
-- where ...`: the update only fires when the existing lease is either
-- ours (same holder_id, harmless refresh) or expired.
drop function if exists public.acquire_worker_lease(text, text, int);
create or replace function public.acquire_worker_lease(
  p_worker_kind text,
  p_holder_id text,
  p_ttl_seconds int
) returns boolean
language plpgsql security invoker as $$
begin
  insert into public.worker_leases (user_id, worker_kind, holder_id, expires_at)
    values (auth.uid(), p_worker_kind, p_holder_id, now() + make_interval(secs => p_ttl_seconds))
    on conflict (user_id, worker_kind) do update
      set holder_id = excluded.holder_id,
          expires_at = excluded.expires_at
      where public.worker_leases.expires_at < now()
         or public.worker_leases.holder_id = excluded.holder_id;
  return exists (
    select 1 from public.worker_leases
     where user_id = auth.uid()
       and worker_kind = p_worker_kind
       and holder_id = p_holder_id
       and expires_at > now()
  );
end $$;

-- Extend our lease if we still own it. Returns true iff the update
-- landed — false means our lease lapsed and someone else took over, in
-- which case the worker should stop immediately rather than keep
-- processing rows it no longer has the right to.
drop function if exists public.heartbeat_worker_lease(text, text, int);
create or replace function public.heartbeat_worker_lease(
  p_worker_kind text,
  p_holder_id text,
  p_ttl_seconds int
) returns boolean
language plpgsql security invoker as $$
declare
  updated int;
begin
  update public.worker_leases
     set expires_at = now() + make_interval(secs => p_ttl_seconds)
   where user_id = auth.uid()
     and worker_kind = p_worker_kind
     and holder_id = p_holder_id
     and expires_at > now();
  get diagnostics updated = row_count;
  return updated > 0;
end $$;

-- Explicit release — used by the worker on graceful shutdown so another
-- device can pick up instantly rather than waiting for the TTL. Always
-- returns void: nothing to do if our lease is already gone.
drop function if exists public.release_worker_lease(text, text);
create or replace function public.release_worker_lease(
  p_worker_kind text,
  p_holder_id text
) returns void
language plpgsql security invoker as $$
begin
  delete from public.worker_leases
   where user_id = auth.uid()
     and worker_kind = p_worker_kind
     and holder_id = p_holder_id;
end $$;

-- Claim the next pending memory atomically. The CTE picks one unclaimed
-- or expired-claim row using `for update skip locked`, which is the
-- Postgres queue pattern — concurrent claimers (shouldn't happen under
-- the lease invariant, but defensive) walk past a row another claimer
-- has locked instead of contending. The outer UPDATE stamps the claim
-- and returns the row contents so the worker can embed without a second
-- round trip.
drop function if exists public.claim_next_pending_memory(text, int);
create or replace function public.claim_next_pending_memory(
  p_holder_id text,
  p_ttl_seconds int
) returns table (id uuid, label text, data text)
language sql security invoker as $$
  with candidate as (
    select m.id
      from public.memories m
     where m.user_id = auth.uid()
       and m.embedding is null
       and (m.embedding_claim_expires is null
            or m.embedding_claim_expires < now())
     order by m.updated_at desc
     limit 1
     for update skip locked
  )
  update public.memories m
     set embedding_claim_holder = p_holder_id,
         embedding_claim_expires = now() + make_interval(secs => p_ttl_seconds)
    from candidate c
   where m.id = c.id
  returning m.id, m.label, m.data;
$$;

-- Save the embedding IF our claim is still valid. Returns true on
-- success, false when we lost the row — either the user edited it
-- (trigger nulled our claim), the TTL expired and another worker
-- re-claimed, or the row was deleted. The worker treats false as "skip
-- and move on"; it's not an error.
drop function if exists public.save_memory_embedding_if_claimed(uuid, text, vector, text);
create or replace function public.save_memory_embedding_if_claimed(
  p_id uuid,
  p_holder_id text,
  p_embedding vector(2048),
  p_embedding_model text
) returns boolean
language plpgsql security invoker as $$
declare
  updated int;
begin
  update public.memories
     set embedding = p_embedding,
         embedding_model = p_embedding_model,
         embedding_claim_holder = null,
         embedding_claim_expires = null
   where id = p_id
     and user_id = auth.uid()
     and embedding_claim_holder = p_holder_id
     and embedding_claim_expires > now();
  get diagnostics updated = row_count;
  return updated > 0;
end $$;

-- Similarity search RPC. `security invoker` means the function runs as
-- the caller — RLS still applies — but the explicit `user_id = auth.uid()`
-- guard keeps behavior obvious here and protects us if the select policy
-- ever changes shape. Returns the full row (minus embedding) so the
-- client doesn't re-fetch 2048 floats per hit just to drop them.
--
-- Ranking: the raw cosine distance is `embedding <=> query_embedding`,
-- so similarity is `1 - distance`. We boost that by a logarithmic
-- function of confidence: `score = (1 - distance) * (1 + 0.15 *
-- ln(1 + confidence))`. The `+1` inside the log keeps the formula
-- defined at confidence=0 and monotonic; γ=0.15 keeps the boost
-- multiplier bounded roughly in [1.00, 1.36] across the [0, 10]
-- confidence range, so a corroborated memory can't steamroller a
-- merely-more-similar one — it just wins on ties and near-ties.
--
-- `confidence >= 0.05` filters memories the reflection agent has
-- decayed into oblivion — they're still stored (recoverable if the
-- agent re-learns the fact), just hidden from search. The ORDER BY
-- uses DESC on the boosted score because higher score = more
-- relevant.
-- `confidence` rides the return row so callers formatting the result
-- (opening-recall's <think> block, memory_search's tool-result JSON)
-- can prefix a qualitative tag ([corroborated]/[hedged]/[shaky]) without
-- a second round trip. Thresholds live in src/lib/memories.ts so SQL and
-- TS aren't both claiming authority over the classification.
drop function if exists public.search_memories_by_embedding(vector, int);
create or replace function public.search_memories_by_embedding(
  query_embedding vector(2048),
  match_limit int
) returns table (
  id uuid,
  label text,
  data text,
  confidence real,
  created_at timestamptz,
  updated_at timestamptz
)
language sql stable security invoker as $$
  select id, label, data, confidence, created_at, updated_at
    from public.memories
   where user_id = auth.uid()
     and embedding is not null
     and confidence >= 0.05
   order by (1 - (embedding <=> query_embedding))
          * (1 + 0.15 * ln(1 + confidence)) desc
   limit match_limit
$$;

-- Scored sibling of search_memories_by_embedding. Same ranking formula,
-- but returns the boosted similarity score alongside each row so the
-- caller can threshold in application code. Used by the opening-turn
-- memory-recall priming in chat-loop.ts, which needs a minimum-score
-- gate to avoid injecting noise on turns that don't actually look like
-- anything the user's memories cover. Kept as a separate function so
-- the main memory_search path (and the Memories browser) stays on the
-- unscored RPC and doesn't have to care about a column it never uses.
drop function if exists public.search_memories_by_embedding_scored(vector, int);
create or replace function public.search_memories_by_embedding_scored(
  query_embedding vector(2048),
  match_limit int
) returns table (
  id uuid,
  label text,
  data text,
  confidence real,
  similarity real
)
language sql stable security invoker as $$
  select id, label, data, confidence,
         ((1 - (embedding <=> query_embedding))
           * (1 + 0.15 * ln(1 + confidence)))::real as similarity
    from public.memories
   where user_id = auth.uid()
     and embedding is not null
     and confidence >= 0.05
   order by (1 - (embedding <=> query_embedding))
          * (1 + 0.15 * ln(1 + confidence)) desc
   limit match_limit
$$;

-- Reflection pipeline RPCs -----------------------------------------------
--
-- The reflection agent's worker runs on the same claim/lease pattern as
-- the embeddings worker, but against `threads` instead of `memories`
-- and with a different "what does 'needs work' mean?" predicate.
--
-- "Needs reflection" = there exists a terminal assistant message in the
-- thread (role='assistant' AND (tool_calls IS NULL OR empty) AND
-- content is non-null and non-empty) whose id is strictly greater than
-- whatever `threads.last_reflected_msg_id` currently is (or any such
-- message, if last_reflected_msg_id is null). The depth guard requires
-- at least two user messages on the thread, so a one-shot ask (single
-- user prompt + assistant reply, no follow-up) doesn't burn Venice
-- calls reflecting on a conversation that hadn't actually started yet.
--
-- The function returns `(thread_id, terminal_msg_id)` atomically. The
-- worker fetches messages up to `terminal_msg_id` (so a race where the
-- user adds more turns mid-reflection just queues the thread for the
-- next cycle), runs its tool-call loop, and calls
-- `mark_thread_reflected_if_claimed` with the same msg_id it got here.
-- If the claim was lost (device B took over mid-reflection) the mark
-- returns false and the whole run is discarded — device B will redo it.

-- Claim the oldest thread in need of reflection and return its id plus
-- the terminal assistant message we should reflect up to. `for update
-- skip locked` is belt-and-suspenders under the lease invariant (only
-- one device should be claiming at a time); it costs nothing and
-- removes an entire class of wrong answer from the corner where two
-- devices briefly both think they hold the lease.
drop function if exists public.claim_next_thread_for_reflection(text, int);
create or replace function public.claim_next_thread_for_reflection(
  p_holder_id text,
  p_ttl_seconds int
) returns table (thread_id uuid, terminal_msg_id uuid)
language sql security invoker as $$
  with candidate as (
    -- Oldest thread (by updated_at ascending) that has a terminal
    -- assistant message newer than what we've reflected on, passes the
    -- token-volume guard, and isn't currently claimed. The terminal-
    -- message lookup is a lateral join so we get both the thread row
    -- AND the specific msg id to mark up to, in one round trip.
    select t.id as thread_id, term.msg_id as terminal_msg_id
      from public.threads t
      cross join lateral (
        select m.id as msg_id
          from public.messages m
         where m.thread_id = t.id
           and m.role = 'assistant'
           and (m.tool_calls is null
                or jsonb_typeof(m.tool_calls) <> 'array'
                or jsonb_array_length(m.tool_calls) = 0)
           and m.content is not null
           and length(m.content) > 0
         order by m.created_at desc
         limit 1
      ) term
     where t.user_id = auth.uid()
       and term.msg_id is distinct from t.last_reflected_msg_id
       and (t.reflection_claim_expires_at is null
            or t.reflection_claim_expires_at < now())
       and (
         -- At least two user messages on the thread. A single user
         -- prompt + assistant reply is a one-shot Q&A; we only want
         -- to reflect once the user came back with a follow-up, which
         -- is the cheapest signal that the conversation has substance
         -- worth turning into memories.
         select count(*)
           from public.messages m2
          where m2.thread_id = t.id
            and m2.role = 'user'
       ) >= 2
     order by t.updated_at asc
     limit 1
     for update of t skip locked
  )
  update public.threads t
     set reflection_holder_id = p_holder_id,
         reflection_claim_expires_at = now() + make_interval(secs => p_ttl_seconds)
    from candidate c
   where t.id = c.thread_id
  returning t.id as thread_id, c.terminal_msg_id;
$$;

-- Record a completed reflection IF the claim is still ours. Returns
-- true on success, false when the claim expired or was stolen (another
-- device took over). The worker treats false the same way
-- save_memory_embedding_if_claimed does: drop the work, loop to the
-- next row. Any memory writes the agent already made during the run
-- stay — they're owned by the user, not the claim, and re-reflection
-- on the same thread will just find them via memory_search and
-- memory_update rather than duplicate.
drop function if exists public.mark_thread_reflected_if_claimed(uuid, text, uuid);
create or replace function public.mark_thread_reflected_if_claimed(
  p_thread_id uuid,
  p_holder_id text,
  p_msg_id uuid
) returns boolean
language plpgsql security invoker as $$
declare
  updated int;
begin
  update public.threads
     set last_reflected_msg_id = p_msg_id,
         reflection_holder_id = null,
         reflection_claim_expires_at = null
   where id = p_thread_id
     and user_id = auth.uid()
     and reflection_holder_id = p_holder_id
     and reflection_claim_expires_at > now();
  get diagnostics updated = row_count;
  return updated > 0;
end $$;

-- Summarisation pipeline RPCs -------------------------------------------
--
-- Mirror of the reflection pair, but the predicate is "needs a new
-- summary" — `last_summarised_msg_id` distinct from the most recent
-- terminal assistant message. No token-volume guard here: even a
-- short "fix the typo on this button" thread is worth a title-scale
-- summary so search can semantically match against phrasing the user
-- typed that never made it into the title. Venice cost of a fast-
-- model call on a tiny thread is a rounding error.
drop function if exists public.claim_next_thread_for_summary(text, int);
create or replace function public.claim_next_thread_for_summary(
  p_holder_id text,
  p_ttl_seconds int
) returns table (thread_id uuid, terminal_msg_id uuid)
language sql security invoker as $$
  with candidate as (
    select t.id as thread_id, term.msg_id as terminal_msg_id
      from public.threads t
      cross join lateral (
        select m.id as msg_id
          from public.messages m
         where m.thread_id = t.id
           and m.role = 'assistant'
           and (m.tool_calls is null
                or jsonb_typeof(m.tool_calls) <> 'array'
                or jsonb_array_length(m.tool_calls) = 0)
           and m.content is not null
           and length(m.content) > 0
         order by m.created_at desc
         limit 1
      ) term
     where t.user_id = auth.uid()
       and term.msg_id is distinct from t.last_summarised_msg_id
       and (t.summary_claim_expires is null
            or t.summary_claim_expires < now())
     order by t.updated_at asc
     limit 1
     for update of t skip locked
  )
  update public.threads t
     set summary_claim_holder = p_holder_id,
         summary_claim_expires = now() + make_interval(secs => p_ttl_seconds)
    from candidate c
   where t.id = c.thread_id
  returning t.id as thread_id, c.terminal_msg_id;
$$;

-- Save a completed summary IF the claim is still ours. The stamped
-- msg_id is what we summarised up to; a new terminal message after
-- that re-qualifies the thread on the next poll. Returns false when
-- the claim expired or was stolen — the worker drops the work.
drop function if exists public.save_thread_summary_if_claimed(uuid, text, text, uuid);
create or replace function public.save_thread_summary_if_claimed(
  p_thread_id uuid,
  p_holder_id text,
  p_summary text,
  p_msg_id uuid
) returns boolean
language plpgsql security invoker as $$
declare
  updated int;
begin
  update public.threads
     set summary = p_summary,
         last_summarised_msg_id = p_msg_id,
         summary_claim_holder = null,
         summary_claim_expires = null
   where id = p_thread_id
     and user_id = auth.uid()
     and summary_claim_holder = p_holder_id
     and summary_claim_expires > now();
  get diagnostics updated = row_count;
  return updated > 0;
end $$;

-- Auto-title pipeline RPCs ----------------------------------------------
--
-- Background worker that fills in titles for threads still on the
-- 'New conversation' placeholder. Replaces the in-Chat fire-and-forget
-- title-gen pipeline that lost work whenever the user closed the tab
-- (or refreshed) before the single Venice call resolved. The worker
-- lives in src/lib/agents/auto_title/* and uses the same lease + claim
-- pattern as reflection / summary.
--
-- The eligibility predicate matches the gate the in-Chat trigger used
-- to apply: title still default, title_manually_set still false, AND
-- at least one user message exists to title from. Returning the first
-- user message's text in the same round trip avoids a second SELECT
-- before the Venice call - the worker reuses the same tight system
-- prompt that title-gen.ts has always used.
drop function if exists public.claim_next_thread_for_auto_title(text, int);
create or replace function public.claim_next_thread_for_auto_title(
  p_holder_id text,
  p_ttl_seconds int
) returns table (thread_id uuid, user_text text)
language sql security invoker as $$
  with candidate as (
    -- Oldest still-default-title thread (by updated_at ascending) that
    -- has at least one user message and isn't currently claimed. The
    -- first-user-message lookup is a lateral join so we get both the
    -- thread row AND the text to title from in one round trip - the
    -- worker can call Venice without a follow-up SELECT.
    select t.id as thread_id, first_user.text as user_text
      from public.threads t
      cross join lateral (
        select m.content as text
          from public.messages m
         where m.thread_id = t.id
           and m.role = 'user'
           and m.content is not null
           and length(m.content) > 0
         order by m.created_at asc
         limit 1
      ) first_user
     where t.user_id = auth.uid()
       and t.title = 'New conversation'
       and t.title_manually_set = false
       and (t.auto_title_claim_expires is null
            or t.auto_title_claim_expires < now())
     order by t.updated_at asc
     limit 1
     for update of t skip locked
  )
  update public.threads t
     set auto_title_claim_holder = p_holder_id,
         auto_title_claim_expires = now() + make_interval(secs => p_ttl_seconds)
    from candidate c
   where t.id = c.thread_id
  returning t.id as thread_id, c.user_text;
$$;

-- Save the generated title IF our claim is still valid AND the row is
-- still eligible. Three races guard against:
--   1. Claim was stolen (different holder OR our TTL expired).
--   2. The user manually renamed the thread mid-flight (title_manually_set
--      flipped true).
--   3. The model called update_title via the round-2+ nag mid-flight
--      (title is no longer the placeholder).
-- Returns true on a successful write, false on any race - caller drops
-- the work; the next cycle will skip this row because the predicates no
-- longer match. We also clear the claim on a winning write so the
-- partial index immediately drops the row from its live-claims set.
-- Doesn't bump updated_at - the title write is a side-effect of the
-- conversation; bumping would re-promote the thread in the sidebar.
drop function if exists public.save_thread_title_if_claimed(uuid, text, text);
create or replace function public.save_thread_title_if_claimed(
  p_thread_id uuid,
  p_holder_id text,
  p_title text
) returns boolean
language plpgsql security invoker as $$
declare
  updated int;
begin
  update public.threads
     set title = p_title,
         auto_title_claim_holder = null,
         auto_title_claim_expires = null
   where id = p_thread_id
     and user_id = auth.uid()
     and auto_title_claim_holder = p_holder_id
     and auto_title_claim_expires > now()
     and title = 'New conversation'
     and title_manually_set = false;
  get diagnostics updated = row_count;
  return updated > 0;
end $$;

-- Explicit claim release - used by the worker when the title-gen call
-- produced no usable output (model emitted whitespace, abort fired) so
-- another cycle can re-pick the row immediately rather than waiting for
-- the TTL. Guarded on holder so a stale call from a displaced worker
-- can't clear the live claim. Returns void.
drop function if exists public.clear_auto_title_claim(uuid, text);
create or replace function public.clear_auto_title_claim(
  p_thread_id uuid,
  p_holder_id text
) returns void
language plpgsql security invoker as $$
begin
  update public.threads
     set auto_title_claim_holder = null,
         auto_title_claim_expires = null
   where id = p_thread_id
     and user_id = auth.uid()
     and auto_title_claim_holder = p_holder_id;
end $$;

-- Topic-tagging pipeline RPCs -------------------------------------------
--
-- The topics worker (src/lib/agents/topics/*) tags threads with a short
-- flat set of topic strings. Shape mirrors the summary RPCs: claim by
-- terminal-assistant-message id, save guarded by holder + TTL +
-- terminal_msg_id stamp so a thread that grew mid-tagging simply re-
-- qualifies on the next cycle. The extra wrinkle vs summary: the claim
-- also returns the user's existing topic vocabulary in the same round
-- trip, so the worker can prompt the model with "reuse these names if
-- they fit" without a second SELECT. Saves one RPC per cycle and keeps
-- the vocabulary as fresh as the claim that consumed it.
--
-- Eligibility predicate: thread has at least one assistant message with
-- non-empty content (same shape as summary), AND that terminal message
-- is distinct from `last_topics_msg_id` (so re-tagging only runs when
-- the conversation has materially grown). Drafts and brand-new threads
-- without any assistant turn are skipped - tagging "hi" with topics is
-- noise. Threads with the placeholder title are also excluded so
-- auto-title gets first crack at the row; once auto-title lands a real
-- title the topics worker picks the row up on its next poll.
drop function if exists public.claim_next_thread_for_topics(text, int);
create or replace function public.claim_next_thread_for_topics(
  p_holder_id text,
  p_ttl_seconds int
) returns table (thread_id uuid, terminal_msg_id uuid, existing_topics text[])
language sql security invoker as $$
  with candidate as (
    select t.id as thread_id, term.msg_id as terminal_msg_id
      from public.threads t
      cross join lateral (
        select m.id as msg_id
          from public.messages m
         where m.thread_id = t.id
           and m.role = 'assistant'
           and (m.tool_calls is null
                or jsonb_typeof(m.tool_calls) <> 'array'
                or jsonb_array_length(m.tool_calls) = 0)
           and m.content is not null
           and length(m.content) > 0
         order by m.created_at desc
         limit 1
      ) term
     where t.user_id = auth.uid()
       and t.title <> 'New conversation'
       and term.msg_id is distinct from t.last_topics_msg_id
       and (t.topics_claim_expires is null
            or t.topics_claim_expires < now())
     order by t.updated_at asc
     limit 1
     for update of t skip locked
  ),
  vocab as (
    -- One-shot read of the user's current topic vocabulary. The worker
    -- passes this to the model as a "reuse these names if they fit"
    -- list so the dropdown doesn't sprawl with near-duplicates. Empty
    -- array on a brand-new account is fine - the model gets free rein
    -- on the first few threads, then the vocabulary self-seeds.
    select coalesce(array_agg(distinct topic order by topic), '{}'::text[]) as topics
      from public.threads t, unnest(t.topics) as topic
     where t.user_id = auth.uid()
       and t.topics <> '{}'::text[]
  )
  update public.threads t
     set topics_claim_holder = p_holder_id,
         topics_claim_expires = now() + make_interval(secs => p_ttl_seconds)
    from candidate c, vocab v
   where t.id = c.thread_id
  returning t.id as thread_id, c.terminal_msg_id, v.topics as existing_topics;
$$;

-- Save the agent-produced topics IF our claim is still valid. The stamped
-- msg_id is what we tagged against; a new terminal message after that
-- re-qualifies the thread on the next poll. Returns false when the claim
-- expired or was stolen - the worker drops the work. Doesn't bump
-- updated_at: tagging is a side-effect of the conversation, and a bump
-- would re-promote the thread to the top of the drawer.
drop function if exists public.save_thread_topics_if_claimed(uuid, text, text[], uuid);
create or replace function public.save_thread_topics_if_claimed(
  p_thread_id uuid,
  p_holder_id text,
  p_topics text[],
  p_msg_id uuid
) returns boolean
language plpgsql security invoker as $$
declare
  updated int;
begin
  update public.threads
     set topics = p_topics,
         last_topics_msg_id = p_msg_id,
         topics_claim_holder = null,
         topics_claim_expires = null
   where id = p_thread_id
     and user_id = auth.uid()
     and topics_claim_holder = p_holder_id
     and topics_claim_expires > now();
  get diagnostics updated = row_count;
  return updated > 0;
end $$;

-- Explicit claim release - used by the worker when the agent returned
-- no usable topics (model emitted garbage, abort fired) so another cycle
-- can re-pick the row immediately rather than waiting for the TTL.
-- Guarded on holder so a stale call from a displaced worker can't clear
-- the live claim. Returns void.
drop function if exists public.clear_topics_claim(uuid, text);
create or replace function public.clear_topics_claim(
  p_thread_id uuid,
  p_holder_id text
) returns void
language plpgsql security invoker as $$
begin
  update public.threads
     set topics_claim_holder = null,
         topics_claim_expires = null
   where id = p_thread_id
     and user_id = auth.uid()
     and topics_claim_holder = p_holder_id;
end $$;

-- Distinct topic vocabulary for the current user. Used by the drawer's
-- topic-filter dropdown on mount and after a tagging event. The
-- aggregate is cheap per user (a few hundred rows at most, each with
-- 1-4 short strings); no need for materialisation. Returns an empty
-- list on a brand-new account. The "(untagged)" pseudo-topic the UI
-- offers separately is NOT in this list - the UI synthesises it from
-- a "rows where topics = '{}' exist" predicate (which the existing
-- listRecentThreads call already establishes, no extra query needed).
drop function if exists public.list_user_topics();
create or replace function public.list_user_topics()
returns text[]
language sql security invoker as $$
  select coalesce(array_agg(distinct topic order by topic), '{}'::text[])
    from public.threads t, unnest(t.topics) as topic
   where t.user_id = auth.uid()
     and t.topics <> '{}'::text[];
$$;

-- Thread embedding pipeline RPCs ----------------------------------------
--
-- The embeddings worker is multi-source: memories and now threads.
-- This claim RPC returns the inputs the worker will concatenate —
-- `title` plus `summary` — so the worker doesn't need a second round
-- trip to read them. A freshly-created thread with its placeholder
-- title and no summary yet is skipped (empty string wouldn't produce
-- a meaningful embedding); the worker will pick it up on a later
-- poll once either the autoTitle or the summary agent has landed.
drop function if exists public.claim_next_pending_thread_for_embedding(text, int);
create or replace function public.claim_next_pending_thread_for_embedding(
  p_holder_id text,
  p_ttl_seconds int
) returns table (id uuid, title text, summary text)
language sql security invoker as $$
  with candidate as (
    select t.id
      from public.threads t
     where t.user_id = auth.uid()
       and t.embedding is null
       and (t.embedding_claim_expires is null
            or t.embedding_claim_expires < now())
       and (t.title is distinct from 'New conversation' or t.summary is not null)
     order by t.updated_at desc
     limit 1
     for update skip locked
  )
  update public.threads t
     set embedding_claim_holder = p_holder_id,
         embedding_claim_expires = now() + make_interval(secs => p_ttl_seconds)
    from candidate c
   where t.id = c.id
  returning t.id, t.title, t.summary;
$$;

-- Save the thread embedding IF our claim is still valid. Same shape
-- as save_memory_embedding_if_claimed — false = skip, not an error.
drop function if exists public.save_thread_embedding_if_claimed(uuid, text, vector, text);
create or replace function public.save_thread_embedding_if_claimed(
  p_id uuid,
  p_holder_id text,
  p_embedding vector(2048),
  p_embedding_model text
) returns boolean
language plpgsql security invoker as $$
declare
  updated int;
begin
  update public.threads
     set embedding = p_embedding,
         embedding_model = p_embedding_model,
         embedding_claim_holder = null,
         embedding_claim_expires = null
   where id = p_id
     and user_id = auth.uid()
     and embedding_claim_holder = p_holder_id
     and embedding_claim_expires > now();
  get diagnostics updated = row_count;
  return updated > 0;
end $$;

-- Cosine-similarity search over threads. Returns a small projection
-- (id + the columns the drawer renders) plus the raw similarity score
-- so the client can merge this into its exact-match list without a
-- second fetch. Archived threads are included — the drawer greys them
-- and the client-side rank stays "exact before semantic" regardless
-- of which bucket each hit lives in.
drop function if exists public.search_threads_by_embedding(vector, int);
create or replace function public.search_threads_by_embedding(
  query_embedding vector(2048),
  match_limit int
) returns table (
  id uuid,
  title text,
  archived boolean,
  updated_at timestamptz,
  similarity real
)
language sql stable security invoker as $$
  select id, title, archived, updated_at,
         (1 - (embedding <=> query_embedding))::real as similarity
    from public.threads
   where user_id = auth.uid()
     and embedding is not null
   order by embedding <=> query_embedding asc
   limit match_limit
$$;

-- Confidence adjustment RPCs ---------------------------------------------
--
-- Both bump and decay return the new confidence so the calling agent
-- can include it in the tool result — gives the model visible feedback
-- on its own action (if a tool result said "confidence now 0.25" the
-- agent sees how close the memory is to the 0.05 search-hide floor).
--
-- Rounding / flooring:
--   - decay halves confidence (× 0.5) without a floor. A memory hit
--     many times keeps halving below 0.05, where the search RPC will
--     stop returning it — exactly the "soft delete" semantic we want.
--   - bump adds 1.0 and caps at 10.0. The cap prevents a runaway loop
--     (agent writes the same memory every round for weeks) from
--     pushing confidence so high the log boost saturates.

drop function if exists public.decay_memory_confidence(uuid);
create or replace function public.decay_memory_confidence(
  p_id uuid
) returns real
language sql security invoker as $$
  update public.memories
     set confidence = confidence * 0.5
   where id = p_id
     and user_id = auth.uid()
  returning confidence;
$$;

drop function if exists public.bump_memory_confidence(uuid);
create or replace function public.bump_memory_confidence(
  p_id uuid
) returns real
language sql security invoker as $$
  update public.memories
     set confidence = least(confidence + 1.0, 10.0)
   where id = p_id
     and user_id = auth.uid()
  returning confidence;
$$;

-- Volitional confidence adjustment RPCs ----------------------------------
--
-- Chat-side siblings of bump/decay. The reflection agent uses the
-- stronger bump (+1.0) and decay (×0.5) tools because it's operating on
-- settled evidence across a whole conversation; the chat-side tools
-- (memory_reaffirm / memory_doubt) fire mid-turn on a single exchange,
-- so their deltas are gentler on purpose. The intent is that the LLM
-- can nudge confidence several times over a conversation without
-- saturating the log-boost or crashing a memory below the 0.05 search
-- floor in one move.
--
--   - reaffirm: +0.5, capped at 10.0. Takes ~8 reaffirms from the
--     default 1.0 to cross 5.0 (the [corroborated] tag threshold).
--   - doubt:    ×0.7, no floor. Five doubts from 1.0 lands around
--     0.168, past the [shaky] threshold of 0.5 but still well above
--     the 0.05 hide floor. Six gets you to 0.117; you'd need ~10 to
--     drop below 0.05 from a fresh memory.

drop function if exists public.reaffirm_memory_confidence(uuid);
create or replace function public.reaffirm_memory_confidence(
  p_id uuid
) returns real
language sql security invoker as $$
  update public.memories
     set confidence = least(confidence + 0.5, 10.0)
   where id = p_id
     and user_id = auth.uid()
  returning confidence;
$$;

drop function if exists public.doubt_memory_confidence(uuid);
create or replace function public.doubt_memory_confidence(
  p_id uuid
) returns real
language sql security invoker as $$
  update public.memories
     set confidence = confidence * 0.7
   where id = p_id
     and user_id = auth.uid()
  returning confidence;
$$;

-- Relation retrieval -----------------------------------------------------
--
-- Outbound edges for a batch of memory ids, joined to the target row's
-- display fields so the caller can format the inline relation block
-- without a second query per edge. Used by:
--
--   - opening-recall.ts (bounded traversal when building the priming
--     <think> block).
--   - the memory_search tool's response shaping (so the agent sees the
--     graph alongside hits).
--   - Memories.svelte (per-row edge list).
--
-- The RPC is RLS-scoped implicitly: the underlying table RLS filters by
-- auth.uid(), and the memories join inherits the same filter. No need
-- for an explicit user_id check in the where clause.
--
-- `to_confidence` rides the row for the same reason the search RPCs
-- carry `confidence`: the formatter wants to tag the linked memory's
-- confidence too ([hedged] support vs [corroborated] support is a
-- meaningful distinction for the LLM reading the block).

drop function if exists public.get_memory_relations(uuid[]);
create or replace function public.get_memory_relations(
  p_ids uuid[]
) returns table (
  id uuid,
  from_memory_id uuid,
  to_memory_id uuid,
  kind text,
  note text,
  created_at timestamptz,
  to_label text,
  to_data text,
  to_confidence real
)
language sql stable security invoker as $$
  select r.id,
         r.from_memory_id,
         r.to_memory_id,
         r.kind,
         r.note,
         r.created_at,
         m.label as to_label,
         m.data as to_data,
         m.confidence as to_confidence
    from public.memory_relations r
    join public.memories m on m.id = r.to_memory_id
   where r.from_memory_id = any(p_ids)
     and r.user_id = auth.uid()
   order by r.created_at asc;
$$;

-- Samskara ---------------------------------------------------------------
--
-- The chat model's progressively-built predictive model of the user.
-- Per-round observations (substrate) compound through background
-- clustering into emergent predictive claims (samskaras); cohorts of
-- samskaras that fire together compound once more into higher-tier
-- samskaras. The accumulated set is summarised into prose that lives
-- always-on in the system prompt; per-turn cosine fire surfaces
-- situationally-relevant samskaras on top.
--
-- See docs/dev/samskara.md for the full design including why the
-- pieces are split this way, what each phase of the formation worker
-- does, and the load-bearing gotchas (no health threshold at fire
-- time, log10 dampening of compound regen, recursion cap at tier 2).
--
-- Conventions inherited from the rest of this file:
--   - All tables RLS-scoped to `auth.uid() = user_id`.
--   - All idempotent: `create table if not exists`, `add column if not
--     exists`, drop-then-create policies and RPCs.
--   - Vectors are `vector(2048)` to match memories/threads. Venice's
--     bge-m3 model emits 1024 dims; the worker pads with zeros via
--     `padEmbeddingForStorage` (see src/lib/models.ts). Cosine
--     similarity is invariant to that padding.
--
-- Cross-device coordination uses two layers, same as memories:
--   - The singleton `worker_kind='samskara'` lease in `worker_leases`
--     keeps formation work on one device at a time.
--   - Per-row claim columns on `samskara_substrate` and
--     `samskara_compound_summary` cover the lease-handover race for
--     work that crosses an LLM round-trip.

create table if not exists public.samskara_substrate (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  thread_id uuid not null references public.threads(id) on delete cascade,
  -- The user message that opened this round, plus the assistant
  -- message that closed it. The assistant id is nullable because a
  -- turn can be aborted or error out before the assistant row writes.
  -- Both are soft pointers — substrate survives the messages it
  -- references being deleted, since orphan substrate still carries
  -- training signal.
  user_message_id uuid not null,
  assistant_message_id uuid,
  -- Filled by the assimilator agent in the formation worker. NULL at
  -- chat-loop write-time. `situation` is a third-person observation
  -- of what happened ("user asked X about Y, expressing Z");
  -- `outcome` is what the assistant did and how it landed; `valence`
  -- is a continuous scalar roughly in [-1, 1] capturing how positive
  -- or negative the round felt. Continuous on purpose — the user's
  -- explicit guidance was that fixed affect categories defeat the
  -- compounding design.
  situation text,
  outcome text,
  valence real,
  -- Embedded by the embeddings worker via the samskara_substrate
  -- source. NULL until embedded; the worker polls for that condition.
  -- Padded to 2048 from bge-m3's 1024 native dims; see memories'
  -- preamble for the rationale.
  situation_embedding vector(2048),
  embedding_model text,
  embedding_claim_holder text,
  embedding_claim_expires timestamptz,
  -- Separate claim pair for the assimilator phase of the formation
  -- worker. Two phases write to this row at different times
  -- (assimilator fills situation/outcome/valence; embedder fills
  -- situation_embedding) so they need independent claims to avoid
  -- contention.
  assimilate_claim_holder text,
  assimilate_claim_expires timestamptz,
  created_at timestamptz not null default now()
);

-- Pending-substrate indexes the workers poll against. The assimilator
-- needs `situation is null`; the embedder needs
-- `situation_embedding is null AND situation is not null` (can't
-- embed empty text). Partial indexes keep both queries cheap as the
-- substrate table grows.
create index if not exists samskara_substrate_pending_assimilate_idx
  on public.samskara_substrate (user_id, created_at)
  where situation is null;

create index if not exists samskara_substrate_pending_embed_idx
  on public.samskara_substrate (user_id, created_at)
  where situation_embedding is null and situation is not null;

create index if not exists samskara_substrate_user_created_idx
  on public.samskara_substrate (user_id, created_at desc);

alter table public.samskara_substrate enable row level security;

drop policy if exists "samskara substrate self-selectable" on public.samskara_substrate;
create policy "samskara substrate self-selectable" on public.samskara_substrate
  for select using (auth.uid() = user_id);

drop policy if exists "samskara substrate self-insertable" on public.samskara_substrate;
create policy "samskara substrate self-insertable" on public.samskara_substrate
  for insert with check (auth.uid() = user_id);

drop policy if exists "samskara substrate self-updatable" on public.samskara_substrate;
create policy "samskara substrate self-updatable" on public.samskara_substrate
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists "samskara substrate self-deletable" on public.samskara_substrate;
create policy "samskara substrate self-deletable" on public.samskara_substrate
  for delete using (auth.uid() = user_id);

-- Associations --
--
-- Pair-labels between substrate rows. Written by the relator phase of
-- the formation worker. `(a_id, b_id, articulated_relation)` is unique
-- so re-encountering the same relation between the same pair upserts
-- onto the existing row and bumps `reinforcement` rather than
-- duplicating. The `kind` enum drops scratch's `'orthogonal'` value —
-- orthogonal pairs aren't written at all (the relator agent returns a
-- skip verdict and the worker discards the result).
create table if not exists public.samskara_associations (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  a_id uuid not null references public.samskara_substrate(id) on delete cascade,
  b_id uuid not null references public.samskara_substrate(id) on delete cascade,
  articulated_relation text not null,
  -- Optional: lets us cluster associations by label embedding when
  -- minting tier-1 samskaras. Filled by the embedder phase via the
  -- same pattern as substrate. Keeping it nullable means the relator
  -- phase can write the row immediately and the embedder catches up
  -- later — same separation as substrate's `situation` vs
  -- `situation_embedding` split.
  relation_embedding vector(2048),
  kind text not null check (
    kind in ('pattern', 'contrast', 'prerequisite', 'consequence')
  ),
  reinforcement integer not null default 1,
  last_reinforced_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  unique (user_id, a_id, b_id, articulated_relation)
);

create index if not exists samskara_associations_user_reinforced_idx
  on public.samskara_associations (user_id, last_reinforced_at desc);

alter table public.samskara_associations enable row level security;

drop policy if exists "samskara associations self-selectable" on public.samskara_associations;
create policy "samskara associations self-selectable" on public.samskara_associations
  for select using (auth.uid() = user_id);

drop policy if exists "samskara associations self-insertable" on public.samskara_associations;
create policy "samskara associations self-insertable" on public.samskara_associations
  for insert with check (auth.uid() = user_id);

drop policy if exists "samskara associations self-updatable" on public.samskara_associations;
create policy "samskara associations self-updatable" on public.samskara_associations
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists "samskara associations self-deletable" on public.samskara_associations;
create policy "samskara associations self-deletable" on public.samskara_associations
  for delete using (auth.uid() = user_id);

-- Auto-populate user_id on insert from the caller's session. The
-- pair-relate phase in src/lib/agents/samskara/loop.ts upserts
-- rows via a raw .from('samskara_associations').upsert(...) call
-- that only sets (a_id, b_id, articulated_relation, kind,
-- reinforcement, last_reinforced_at) - it does NOT set user_id.
-- Without this default, user_id lands as NULL, the RLS `with
-- check (auth.uid() = user_id)` policy fails, and the upsert
-- returns a 42501. Idempotent: `set default` overwrites any
-- prior default, so re-running the schema is safe.
alter table public.samskara_associations
  alter column user_id set default auth.uid();

-- Samskaras --
--
-- The unit. Tier 1 are minted from substrate-cluster mints; tier 2
-- are minted from cohort co-fire patterns of tier-1 samskaras (a
-- compound is a samskara-of-samskaras). The `tier in (1, 2)` check is
-- load-bearing — tier 3+ would be a compounds-of-compounds noise
-- amplifier; lifting the cap should be a deliberate design change,
-- not an oversight.
create table if not exists public.samskaras (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  tier int not null check (tier in (1, 2)),
  -- The minter agent's one-or-two-line predictive claim. This is what
  -- the cosine fire query runs against (via `prediction_embedding`)
  -- and what the priming block actually renders.
  prediction text not null,
  prediction_embedding vector(2048) not null,
  -- Optional silent self-talk fragment in the LLM's voice. Rendered
  -- in the priming block when present; truncated aggressively if the
  -- token budget is tight.
  inner_voice text,
  -- Aggregated from substrate or child-samskara provenance. Same
  -- continuous scalar as substrate — no enum.
  valence real,
  -- Bayesian-ish via reaction reinforcement. See
  -- bump_samskara_confidence and decay_samskara_confidence for the
  -- formula. Initial 0.5 leaves room for either direction.
  confidence real not null default 0.5,
  -- Decays over time and on disconfirm; clamped to [0, 1]. NO health
  -- threshold filter at fire time — three near-dead samskaras
  -- co-firing is exactly the cohort-reinforcement signal we want to
  -- preserve. The fire RPC ranks by cosine^1.3 * sqrt(health *
  -- confidence) so weak-but-relevant samskaras can break through, and
  -- the formatPriming token budget bounds the long tail in the
  -- application layer.
  health real not null default 1.0,
  fire_count int not null default 0,
  confirm_count int not null default 0,
  disconfirm_count int not null default 0,
  last_fired_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists samskaras_user_tier_idx
  on public.samskaras (user_id, tier);

create index if not exists samskaras_user_health_idx
  on public.samskaras (user_id, health desc, confidence desc);

alter table public.samskaras enable row level security;

drop policy if exists "samskaras self-selectable" on public.samskaras;
create policy "samskaras self-selectable" on public.samskaras
  for select using (auth.uid() = user_id);

drop policy if exists "samskaras self-insertable" on public.samskaras;
create policy "samskaras self-insertable" on public.samskaras
  for insert with check (auth.uid() = user_id);

drop policy if exists "samskaras self-updatable" on public.samskaras;
create policy "samskaras self-updatable" on public.samskaras
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists "samskaras self-deletable" on public.samskaras;
create policy "samskaras self-deletable" on public.samskaras
  for delete using (auth.uid() = user_id);

-- Auto-populate user_id from auth.uid() on insert. mint-tier1 in
-- src/lib/agents/samskara/loop.ts inserts rows directly via
-- .from('samskaras').insert({...}) and doesn't set user_id.
-- Same RLS-failure symptom as samskara_associations above. The
-- default + the RLS `with check (auth.uid() = user_id)` policy
-- combine so callers can't accidentally or maliciously attribute
-- a samskara to someone else - the session identity wins.
alter table public.samskaras
  alter column user_id set default auth.uid();

-- Provenance --
--
-- Audit trail for what each samskara was minted from. Kept even if
-- the underlying substrate or association is deleted (no FK on
-- `ref_id`) — debugging beats normalisation here. Three kinds:
-- 'substrate' and 'association' for tier-1 mints, 'samskara' for
-- tier-2 (compound) mints whose provenance points at their tier-1
-- children.
create table if not exists public.samskara_provenance (
  samskara_id uuid not null references public.samskaras(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  kind text not null check (kind in ('substrate', 'association', 'samskara')),
  ref_id uuid not null,
  weight real not null default 1.0,
  primary key (samskara_id, kind, ref_id)
);

alter table public.samskara_provenance enable row level security;

drop policy if exists "samskara provenance self-selectable" on public.samskara_provenance;
create policy "samskara provenance self-selectable" on public.samskara_provenance
  for select using (auth.uid() = user_id);

drop policy if exists "samskara provenance self-insertable" on public.samskara_provenance;
create policy "samskara provenance self-insertable" on public.samskara_provenance
  for insert with check (auth.uid() = user_id);

drop policy if exists "samskara provenance self-deletable" on public.samskara_provenance;
create policy "samskara provenance self-deletable" on public.samskara_provenance
  for delete using (auth.uid() = user_id);

-- Auto-populate user_id from auth.uid() on insert. Same reason as
-- the samskaras and samskara_associations defaults: the mint
-- phase upserts into this table with only (samskara_id, kind,
-- ref_id, weight) set.
alter table public.samskara_provenance
  alter column user_id set default auth.uid();

-- Fires --
--
-- One row per samskara fired per turn. `cohort_id` is shared across
-- the whole set fired together on a single turn — lets the reaction
-- classifier and the tier-2 mint phase both operate on the cohort as
-- a unit. `was_confirmed` starts NULL, set to true/false by the
-- reaction classifier on the next user turn. Older unresolved fires
-- (>10 minutes) are left at NULL and age out via decay rather than
-- being force-classified by stale signal.
create table if not exists public.samskara_fires (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  samskara_id uuid not null references public.samskaras(id) on delete cascade,
  thread_id uuid not null references public.threads(id) on delete cascade,
  cohort_id uuid not null,
  fired_at timestamptz not null default now(),
  -- The cosine^1.3 * sqrt(health * confidence) * sample-size bonus
  -- ranking score at fire time. Kept for analytics — useful when a
  -- debugging session asks "why did this samskara fire here?".
  score real not null,
  was_confirmed boolean
);

-- Per-thread index of the user message this cohort fired in response
-- to. 1-based, matches the in-memory countUserRounds(history) value
-- the chat loop sees at fire time (the current user message is
-- already in history when fireSamskaras runs). The UI joins user
-- messages to their cohort by walking the transcript and using the
-- Nth user message's index as the user_round; new fires from the
-- chat loop always carry an accurate value. Nullable for legacy
-- rows written before the column existed; those get an approximate
-- backfill below. Anchoring on a per-thread integer rather than a
-- message_id FK lets the value survive message edits/regenerations
-- without rewriting fire rows, at the cost of an off-by-N if the
-- user deletes earlier user messages (rare; not worth a trigger).
alter table public.samskara_fires
  add column if not exists user_round integer;

-- Best-effort backfill of user_round for fire rows written before
-- this column existed. Ranks cohorts within (user_id, thread_id) by
-- min(fired_at) and assigns sequential integers, so every fire in a
-- cohort shares the same user_round. Approximate: any user message
-- that produced no fire row (empty top-k from samskaraFireTopK,
-- empty user text, embed failure) shifts the ranking by one for
-- everything that followed. Acceptable for historical rows because
-- the inline UI just won't anchor cleanly there; new fires written
-- by the chat loop carry the precise value. Idempotent via the
-- NULL-only WHERE guard.
update public.samskara_fires sf
   set user_round = ranked.r
  from (
    select user_id, thread_id, cohort_id,
           dense_rank() over (
             partition by user_id, thread_id
             order by min_fired_at
           )::int as r
      from (
        select user_id, thread_id, cohort_id,
               min(fired_at) as min_fired_at
          from public.samskara_fires
         group by user_id, thread_id, cohort_id
      ) as cohort_starts
  ) as ranked
 where sf.user_id = ranked.user_id
   and sf.thread_id = ranked.thread_id
   and sf.cohort_id = ranked.cohort_id
   and sf.user_round is null;

create index if not exists samskara_fires_user_recent_idx
  on public.samskara_fires (user_id, fired_at desc);

create index if not exists samskara_fires_cohort_idx
  on public.samskara_fires (cohort_id);

-- Look up "which cohort fired at user-round N in this thread?" - the
-- per-message inline UI uses this on thread load to map each user
-- message in the transcript (numbered 1..N by the renderer) to its
-- cohort group. Partial-on-not-null is a tiny optimization for the
-- common path; the backfill above populates historical rows so the
-- legacy gap is short-lived.
create index if not exists samskara_fires_user_round_idx
  on public.samskara_fires (user_id, thread_id, user_round)
  where user_round is not null;

create index if not exists samskara_fires_unresolved_idx
  on public.samskara_fires (user_id, thread_id, fired_at desc)
  where was_confirmed is null;

alter table public.samskara_fires enable row level security;

drop policy if exists "samskara fires self-selectable" on public.samskara_fires;
create policy "samskara fires self-selectable" on public.samskara_fires
  for select using (auth.uid() = user_id);

drop policy if exists "samskara fires self-insertable" on public.samskara_fires;
create policy "samskara fires self-insertable" on public.samskara_fires
  for insert with check (auth.uid() = user_id);

drop policy if exists "samskara fires self-updatable" on public.samskara_fires;
create policy "samskara fires self-updatable" on public.samskara_fires
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists "samskara fires self-deletable" on public.samskara_fires;
create policy "samskara fires self-deletable" on public.samskara_fires
  for delete using (auth.uid() = user_id);

-- One-shot cleanup of (user_id, cohort_id, samskara_id) duplicates
-- left over from a pre-fix _samskara_merge_pair that retargeted
-- loser-fires onto a winner without first dropping fires the winner
-- already had in the same cohort. Two distinct samskaras both firing
-- in cohort C, then merged into one, used to leave two fire rows in
-- cohort C with the same samskara_id but different scores - which
-- showed up as identical-looking entries in the diagnostics modal
-- and skewed the cofire-based dedup math (a samskara cofiring with
-- itself).
--
-- Keeps the highest-scoring fire per (user, cohort, samskara) tuple
-- and deletes the rest. Idempotent: once the data is clean and the
-- constraint below is in place, the predicate matches no rows and
-- the DELETE is a no-op.
delete from public.samskara_fires f
 where exists (
   select 1 from public.samskara_fires keeper
    where keeper.cohort_id = f.cohort_id
      and keeper.samskara_id = f.samskara_id
      and keeper.user_id = f.user_id
      and (keeper.score, keeper.id) > (f.score, f.id)
 );

-- Belt-and-braces against the merge bug returning. With the helper
-- below now dropping colliding loser-fires before retargeting, this
-- constraint can never trip in normal flow - but if a future change
-- introduces another path that double-inserts into samskara_fires,
-- the database catches it instead of the user noticing duplicates
-- in the modal weeks later. Drop-then-add via DO block to stay
-- idempotent across re-applies.
do $$ begin
  if not exists (
    select 1 from pg_constraint
     where conname = 'samskara_fires_no_dup_in_cohort'
       and conrelid = 'public.samskara_fires'::regclass
  ) then
    alter table public.samskara_fires
      add constraint samskara_fires_no_dup_in_cohort
      unique (user_id, cohort_id, samskara_id);
  end if;
end $$;

-- Compound summary cache --
--
-- Single row per user. The always-on prose block that lives at the
-- top of every system prompt (see src/lib/samskara/index.ts's
-- getCompoundSummary). Rewritten by the compound-regen phase of the
-- formation worker on a hybrid trigger — see
-- samskara_should_regen_compound for the exact predicate. Per-row
-- claim columns let multiple devices coordinate the regen so two
-- workers don't both call the fast model and then race to write.
create table if not exists public.samskara_compound_summary (
  user_id uuid primary key references auth.users(id) on delete cascade,
  summary text,
  samskara_count_at_regen int not null default 0,
  last_regen_at timestamptz not null default now(),
  regen_claim_holder text,
  regen_claim_expires timestamptz
);

alter table public.samskara_compound_summary enable row level security;

drop policy if exists "samskara compound summary self-selectable"
  on public.samskara_compound_summary;
create policy "samskara compound summary self-selectable"
  on public.samskara_compound_summary
  for select using (auth.uid() = user_id);

drop policy if exists "samskara compound summary self-insertable"
  on public.samskara_compound_summary;
create policy "samskara compound summary self-insertable"
  on public.samskara_compound_summary
  for insert with check (auth.uid() = user_id);

drop policy if exists "samskara compound summary self-updatable"
  on public.samskara_compound_summary;
create policy "samskara compound summary self-updatable"
  on public.samskara_compound_summary
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists "samskara compound summary self-deletable"
  on public.samskara_compound_summary;
create policy "samskara compound summary self-deletable"
  on public.samskara_compound_summary
  for delete using (auth.uid() = user_id);

-- Samskara RPCs ----------------------------------------------------------
--
-- All `security invoker` with explicit `auth.uid()` guards inside, same
-- pattern as the rest of this file. Drop-then-create because a few of
-- these change return shape over time; `create or replace` can't
-- handle that.

-- Top-K fire query. Ranks by cosine^1.3 * sqrt(health * confidence)
-- * sample-size bonus so weak-but-relevant samskaras can break
-- through against strong-but-distant ones, while topical samskaras
-- whose cosine is genuinely low get pushed further down (a
-- well-tested off-topic samskara was outranking a mid-quality
-- on-topic one when the cosine factor was linear). Returns enough
-- columns for the priming formatter to render without a follow-up
-- SELECT.
--
-- `k_max` is computed by the caller as
-- `ceil(K_BASE * log10(live_samskara_count + 10))` — the log10 cap
-- the user asked for as a way of softly bounding how much priming
-- volume the chat-loop emits. Caller is trusted to pass a reasonable
-- value; this RPC just honours it.
drop function if exists public.samskara_fire_top_k(vector, int);
create or replace function public.samskara_fire_top_k(
  p_query_embedding vector(2048),
  p_k_max int
) returns table (
  id uuid,
  prediction text,
  inner_voice text,
  valence real,
  confidence real,
  health real,
  score real
)
language sql stable security invoker as $$
  -- Ranking has three multiplicands:
  --   - power(cosine_similarity, 1.3) — semantic relevance to the
  --     user's current message, with the cosine factor raised to a
  --     mild power so weak-cosine matches get discounted faster
  --     than strong ones. Linear cosine (the original) let a
  --     well-tested off-topic samskara (cos=0.20, sqrt term ~1.0)
  --     outrank a mid-quality on-topic one (cos=0.55, sqrt term
  --     ~0.5) because the multiplicative health/confidence/N terms
  --     could close the gap. Powering the cosine factor cuts a 0.20
  --     match by ~45% and a 0.70 match by only ~9%, so the long
  --     tail stays present (no SQL threshold) but topical samskaras
  --     stop crashing into unrelated turns. The greatest(..., 0)
  --     clamp guards against the (rare) negative cosine case where
  --     power() would otherwise raise on a fractional exponent.
  --     The 1.3 exponent is the conservative end of the dial; if
  --     it under-corrects in practice, 1.5 is the next step up.
  --   - sqrt(health * confidence) — softens both axes so a strong-
  --     but-distant samskara can't crush a weak-but-relevant one.
  --   - (1 + 0.1 * ln(1 + N)) where N = confirm + disconfirm —
  --     sample-size bonus. A samskara with 4/5 confirms and one with
  --     80/100 confirms have identical confidence; this term lets
  --     the more-tested one rank higher when cosine and health are
  --     close. Same shape as the memory-search confidence boost.
  --     Caps growth: N=0 -> 1.00x, N=10 -> 1.24x, N=100 -> 1.46x.
  --     A brand-new samskara still ranks normally so it can fire and
  --     accumulate signal.
  select s.id,
         s.prediction,
         s.inner_voice,
         s.valence,
         s.confidence,
         s.health,
         (
           power(greatest(1 - (s.prediction_embedding <=> p_query_embedding), 0.0)::double precision, 1.3)
           * sqrt(greatest(s.health * s.confidence, 0.0))
           * (1 + 0.1 * ln(1 + s.confirm_count + s.disconfirm_count))
         )::real as score
    from public.samskaras s
   where s.user_id = auth.uid()
     and s.prediction_embedding is not null
   order by score desc
   limit p_k_max
$$;

-- Record a cohort fire after the chat loop has selected its top-k.
-- The caller passes the cohort id (a fresh uuid generated client-side
-- so the chat loop already knows it) plus the score per samskara.
-- Bumps `fire_count` and `last_fired_at` on each samskara as a side
-- effect — the SQL `update ... in (select ...)` is one round trip and
-- keeps the bookkeeping atomic with the fire-log insert.
-- Old (cohort, thread, fires) signature retired in favor of the
-- (cohort, thread, user_round, fires) one below. Dropping the old
-- shape forces every client through the new path so a stale wrapper
-- can't silently insert NULL user_round rows.
drop function if exists public.samskara_record_fires(uuid, uuid, jsonb);
drop function if exists public.samskara_record_fires(uuid, uuid, integer, jsonb);
create or replace function public.samskara_record_fires(
  p_cohort_id uuid,
  p_thread_id uuid,
  p_user_round integer,
  p_fires jsonb
) returns void
language plpgsql security invoker as $$
declare
  v_uid uuid := auth.uid();
begin
  if jsonb_typeof(p_fires) <> 'array' or jsonb_array_length(p_fires) = 0 then
    return;
  end if;
  -- Thread-ownership guard. RLS hides READS of fires linked to a
  -- thread the caller doesn't own, but doesn't constrain our own
  -- INSERT here once we've already trusted `auth.uid()` for the
  -- `user_id` column. p_thread_id is supplied by the client; without
  -- a guard a caller could link their own samskara_fires rows to a
  -- thread they don't own, corrupting cohort/reaction integrity.
  --
  -- Pattern matches the other thread-touching RPCs in this file
  -- (mark_thread_reflected_if_claimed, save_thread_summary_if_claimed,
  -- save_thread_embedding_if_claimed): silent skip on a non-owned
  -- target rather than raising. Those RPCs embed
  -- `user_id = auth.uid()` directly in their UPDATE's WHERE so an
  -- unowned row has no effect; we do the moral equivalent here by
  -- short-circuiting the INSERT when ownership doesn't match. A
  -- buggy chat-loop caller would otherwise have to learn to handle
  -- a propagated PostgrestException; a no-op write is the same
  -- "nothing happened" semantics those siblings produce.
  if not exists (
    select 1 from public.threads t
    where t.id = p_thread_id and t.user_id = v_uid
  ) then
    return;
  end if;
  -- Insert one fire row per cohort member. The jsonb array is shape
  -- `[{"samskara_id": "...", "score": 0.42}, ...]` — minimal payload
  -- since the rest is derivable from the samskara row.
  --
  -- ON CONFLICT DO NOTHING against the (user, cohort, samskara)
  -- unique constraint - belt-and-braces against any future caller
  -- that double-records the same cohort. Today this RPC is called
  -- exactly once per turn from fireSamskaras with a fresh cohort_id
  -- so the conflict can't trip; if a regression introduces a second
  -- call path, the table stays clean instead of growing duplicates.
  insert into public.samskara_fires (
    user_id, samskara_id, thread_id, cohort_id, user_round, score
  )
  select v_uid,
         (elem->>'samskara_id')::uuid,
         p_thread_id,
         p_cohort_id,
         p_user_round,
         (elem->>'score')::real
    from jsonb_array_elements(p_fires) as elem
   on conflict (user_id, cohort_id, samskara_id) do nothing;
  -- Keep samskaras' fire bookkeeping in sync.
  update public.samskaras
     set fire_count = fire_count + 1,
         last_fired_at = now(),
         updated_at = now()
   where user_id = v_uid
     and id = any (
       select (elem->>'samskara_id')::uuid
         from jsonb_array_elements(p_fires) as elem
     );
end $$;

-- Apply a reaction across a cohort. The reaction-classify phase calls
-- this with the partition the fast-model agent produced — three id
-- arrays (confirms / disconfirms / neutrals). Bumps confirm/disconfirm
-- counts with cohort-aware reinforcement weights, recomputes
-- confidence using the additive-Laplace shape (with the +2 bonus on
-- confirms), and sets `was_confirmed` on the matching fire rows so
-- they don't get re-classified on the next pass.
--
-- Cohort weight: a cohort of N receives `+1 / sqrt(N)` per member
-- rather than full +1. This keeps a large cohort from dominating
-- single-fire signal but still lets the cohort reinforce its members
-- meaningfully. The choice of sqrt vs log vs linear was empirical in
-- scratch's predecessor; revisit if cohort dynamics misbehave.
drop function if exists public.samskara_apply_reaction(uuid, uuid[], uuid[], uuid[]);
create or replace function public.samskara_apply_reaction(
  p_cohort_id uuid,
  p_confirm_ids uuid[],
  p_disconfirm_ids uuid[],
  p_neutral_ids uuid[]
) returns void
language plpgsql security invoker as $$
declare
  v_uid uuid := auth.uid();
  v_cohort_n int;
  v_weight real;
begin
  -- Cohort size is the count of fires for this cohort that we own,
  -- not the size of any single id-array — neutral fires count toward
  -- the cohort even though they don't shift confidence.
  select count(*) into v_cohort_n
    from public.samskara_fires
   where user_id = v_uid and cohort_id = p_cohort_id;
  if v_cohort_n = 0 then return; end if;
  v_weight := 1.0 / sqrt(v_cohort_n::real);

  if array_length(p_confirm_ids, 1) > 0 then
    update public.samskaras
       set confirm_count = confirm_count + greatest(round(v_weight * 100) / 100.0, 0.01),
           confidence = (confirm_count + 2) / nullif(confirm_count + disconfirm_count + 3, 0)::real,
           updated_at = now()
     where user_id = v_uid
       and id = any (p_confirm_ids);
  end if;

  if array_length(p_disconfirm_ids, 1) > 0 then
    update public.samskaras
       set disconfirm_count = disconfirm_count + greatest(round(v_weight * 100) / 100.0, 0.01),
           confidence = (confirm_count + 1) / nullif(confirm_count + disconfirm_count + 3, 0)::real,
           updated_at = now()
     where user_id = v_uid
       and id = any (p_disconfirm_ids);
  end if;

  -- Resolve all cohort fires we own. Neutrals get marked resolved too
  -- so they don't re-trigger classification — they just don't shift
  -- counts.
  update public.samskara_fires
     set was_confirmed = case
       when samskara_id = any (p_confirm_ids) then true
       when samskara_id = any (p_disconfirm_ids) then false
       else null
     end
   where user_id = v_uid
     and cohort_id = p_cohort_id;

  -- Mark neutrals resolved by stamping a sentinel. NULL would let the
  -- next pass re-pick them; we want them out of the unresolved pool.
  -- Two-step because the case-expression above leaves neutrals at
  -- NULL by design (we don't have a 'neutral' boolean state). Use a
  -- separate UPDATE keyed on neutral_ids that sets was_confirmed to
  -- false but tagged at the application layer via the cohort context.
  -- Simpler: leave neutrals NULL but bump fired_at so the
  -- unresolved-window predicate (>10 min) ages them out faster.
  update public.samskara_fires
     set fired_at = now() - interval '15 minutes'
   where user_id = v_uid
     and cohort_id = p_cohort_id
     and samskara_id = any (p_neutral_ids);
end $$;

-- Cluster a thread's fires by cosine similarity on their samskaras'
-- prediction embeddings, scoped per-cohort. Used by the diagnostics
-- modal to collapse the per-cohort fire list (which can run to ~22
-- predictions) down to a handful of themes the human reader can scan.
--
-- The clustering itself is greedy in score order: within each cohort,
-- walk the fires from highest-scoring to lowest. The first fire opens
-- cluster 1. Each subsequent fire is compared against every existing
-- seed by cosine; if its best match is >= p_threshold, it joins that
-- cluster, otherwise it opens a new cluster of its own. Seeds are
-- never re-evaluated, which means cluster_seq is deterministic across
-- repeated calls so the renderer can cache the result by cohort.
--
-- Threshold default 0.85 matches the MINT dedup convention from
-- src/lib/agents/samskara/loop.ts; drop to ~0.75 if cohorts come back
-- splintered.
--
-- Output is one row per fire in the thread (cohort-keyed), naming the
-- cluster_seq it landed in (1-based, restarts per cohort) plus the
-- cluster_size so the renderer doesn't have to re-aggregate.
-- Display-only - no schema is mutated, the fires table doesn't carry
-- a cluster column. Lets the threshold be tuned without backfills.
--
-- Seed-embedding lookup happens once per (new fire, existing seed)
-- pair via PK fetch on samskaras. Cohorts are typically small
-- (~20 fires, ~5-10 seeds), so the inner-loop reload is fine for a
-- modal-time call. Not on the chat-loop hot path.
drop function if exists public.samskara_cluster_thread_fires(uuid, real);
create or replace function public.samskara_cluster_thread_fires(
  p_thread_id uuid,
  p_threshold real
) returns table (
  fire_id uuid,
  cluster_seq int,
  cluster_size int
)
language plpgsql stable security invoker as $$
declare
  v_uid uuid := auth.uid();
  v_current_cohort uuid := null;
  v_next_seq int := 0;
  v_seed_ids uuid[] := array[]::uuid[];
  v_seed_seqs int[] := array[]::int[];
  v_assignments jsonb := '{}'::jsonb;
  v_best_cos real;
  v_best_seq int;
  v_cos real;
  v_seed_emb vector(2048);
  v_fire_emb vector(2048);
  i int;
  rec record;
begin
  -- Thread-ownership guard. Mirrors samskara_record_fires above:
  -- silent return on a non-owned thread keeps RLS-style "nothing
  -- happened" semantics rather than raising.
  if not exists (
    select 1 from public.threads t
    where t.id = p_thread_id and t.user_id = v_uid
  ) then
    return;
  end if;

  -- Walk every fire of every cohort in this thread, ordered by
  -- (cohort_id, score desc) so each cohort starts fresh and rows
  -- arrive highest-score-first inside the cohort. left join because
  -- a samskara may have been deleted after firing - we still want to
  -- emit the orphan fire, just as its own singleton cluster.
  for rec in
    select f.id as fire_id,
           f.cohort_id,
           f.samskara_id,
           s.prediction_embedding as embedding
      from public.samskara_fires f
      left join public.samskaras s on s.id = f.samskara_id
     where f.thread_id = p_thread_id
       and f.user_id = v_uid
     order by f.cohort_id, f.score desc, f.id
  loop
    if rec.cohort_id is distinct from v_current_cohort then
      v_current_cohort := rec.cohort_id;
      v_next_seq := 0;
      v_seed_ids := array[]::uuid[];
      v_seed_seqs := array[]::int[];
    end if;

    -- Orphan fire (samskara deleted since): give it its own cluster.
    -- Without this guard the row would be dropped by the inner-loop
    -- guard below, leaving the renderer without an assignment for it.
    if rec.embedding is null then
      v_next_seq := v_next_seq + 1;
      v_assignments := v_assignments
        || jsonb_build_object(rec.fire_id::text, v_next_seq);
      continue;
    end if;

    v_fire_emb := rec.embedding;
    v_best_cos := -1.0;
    v_best_seq := 0;

    for i in 1..coalesce(array_length(v_seed_ids, 1), 0) loop
      select s.prediction_embedding into v_seed_emb
        from public.samskaras s
       where s.id = v_seed_ids[i];
      if v_seed_emb is null then
        continue;
      end if;
      v_cos := (1 - (v_seed_emb <=> v_fire_emb))::real;
      if v_cos > v_best_cos then
        v_best_cos := v_cos;
        v_best_seq := v_seed_seqs[i];
      end if;
    end loop;

    if v_best_cos >= p_threshold then
      v_assignments := v_assignments
        || jsonb_build_object(rec.fire_id::text, v_best_seq);
    else
      v_next_seq := v_next_seq + 1;
      v_seed_ids := array_append(v_seed_ids, rec.samskara_id);
      v_seed_seqs := array_append(v_seed_seqs, v_next_seq);
      v_assignments := v_assignments
        || jsonb_build_object(rec.fire_id::text, v_next_seq);
    end if;
  end loop;

  -- Emit (fire_id, cluster_seq, cluster_size). Sizes are recomputed
  -- from the assignment map via a CTE so the caller doesn't have to.
  return query
    with assigned as (
      select f.id as a_fire_id,
             f.cohort_id as a_cohort_id,
             ((v_assignments ->> (f.id::text))::int) as a_seq
        from public.samskara_fires f
       where f.thread_id = p_thread_id
         and f.user_id = v_uid
    ),
    sizes as (
      select a_cohort_id, a_seq, count(*)::int as a_size
        from assigned
       where a_seq is not null
       group by a_cohort_id, a_seq
    )
    select a.a_fire_id, a.a_seq, sz.a_size
      from assigned a
      join sizes sz
        on sz.a_cohort_id = a.a_cohort_id
       and sz.a_seq = a.a_seq;
end $$;

-- Insert one substrate stub at end-of-round. The chat loop calls this
-- with just the thread + message ids; the assimilator phase fills in
-- situation/outcome/valence later. Returns the new row id so the
-- caller can include it in logs.
drop function if exists public.samskara_record_substrate(uuid, uuid, uuid);
create or replace function public.samskara_record_substrate(
  p_thread_id uuid,
  p_user_message_id uuid,
  p_assistant_message_id uuid
) returns uuid
language plpgsql security invoker as $$
declare
  v_id uuid;
begin
  insert into public.samskara_substrate (
    user_id, thread_id, user_message_id, assistant_message_id
  ) values (
    auth.uid(), p_thread_id, p_user_message_id, p_assistant_message_id
  ) returning id into v_id;
  return v_id;
end $$;

-- Claim the next substrate row needing assimilation. Same shape as
-- `claim_next_pending_memory`: `for update skip locked` plus a
-- holder/expiry stamp lets concurrent workers walk past locked rows.
drop function if exists public.samskara_claim_next_assimilate(text, int);
create or replace function public.samskara_claim_next_assimilate(
  p_holder_id text,
  p_ttl_seconds int
) returns table (
  id uuid,
  thread_id uuid,
  user_message_id uuid,
  assistant_message_id uuid
)
language sql security invoker as $$
  with candidate as (
    select s.id
      from public.samskara_substrate s
     where s.user_id = auth.uid()
       and s.situation is null
       and (s.assimilate_claim_expires is null
            or s.assimilate_claim_expires < now())
     order by s.created_at asc
     limit 1
     for update skip locked
  )
  update public.samskara_substrate s
     set assimilate_claim_holder = p_holder_id,
         assimilate_claim_expires = now() + make_interval(secs => p_ttl_seconds)
    from candidate c
   where s.id = c.id
  returning s.id, s.thread_id, s.user_message_id, s.assistant_message_id;
$$;

-- Save assimilator output IF our claim is still valid. Returns false
-- when the row was deleted, the claim expired, or another holder
-- took over — the worker treats false as "skip and move on".
drop function if exists public.samskara_save_assimilation_if_claimed(
  uuid, text, text, text, real
);
create or replace function public.samskara_save_assimilation_if_claimed(
  p_id uuid,
  p_holder_id text,
  p_situation text,
  p_outcome text,
  p_valence real
) returns boolean
language plpgsql security invoker as $$
declare
  updated int;
begin
  update public.samskara_substrate
     set situation = p_situation,
         outcome = p_outcome,
         valence = p_valence,
         assimilate_claim_holder = null,
         assimilate_claim_expires = null
   where id = p_id
     and user_id = auth.uid()
     and assimilate_claim_holder = p_holder_id
     and assimilate_claim_expires > now();
  get diagnostics updated = row_count;
  return updated > 0;
end $$;

-- Substrate embedder claim/save — same shape as memories but on the
-- substrate table's situation_embedding column. Picks rows where
-- `situation_embedding is null AND situation is not null` — empty
-- text would waste a Venice call.
drop function if exists public.samskara_claim_next_substrate_embed(text, int);
create or replace function public.samskara_claim_next_substrate_embed(
  p_holder_id text,
  p_ttl_seconds int
) returns table (id uuid, situation text, outcome text)
language sql security invoker as $$
  with candidate as (
    select s.id
      from public.samskara_substrate s
     where s.user_id = auth.uid()
       and s.situation_embedding is null
       and s.situation is not null
       and (s.embedding_claim_expires is null
            or s.embedding_claim_expires < now())
     order by s.created_at asc
     limit 1
     for update skip locked
  )
  update public.samskara_substrate s
     set embedding_claim_holder = p_holder_id,
         embedding_claim_expires = now() + make_interval(secs => p_ttl_seconds)
    from candidate c
   where s.id = c.id
  returning s.id, s.situation, s.outcome;
$$;

drop function if exists public.samskara_save_substrate_embedding_if_claimed(
  uuid, text, vector, text
);
create or replace function public.samskara_save_substrate_embedding_if_claimed(
  p_id uuid,
  p_holder_id text,
  p_embedding vector(2048),
  p_embedding_model text
) returns boolean
language plpgsql security invoker as $$
declare
  updated int;
begin
  update public.samskara_substrate
     set situation_embedding = p_embedding,
         embedding_model = p_embedding_model,
         embedding_claim_holder = null,
         embedding_claim_expires = null
   where id = p_id
     and user_id = auth.uid()
     and embedding_claim_holder = p_holder_id
     and embedding_claim_expires > now();
  get diagnostics updated = row_count;
  return updated > 0;
end $$;

-- Decay pass. Two updates, mirroring scratch's two paths: stale-fire
-- decay (gentle, hiatus-tolerant) and disconfirm decay (sharper,
-- gated on accumulated feedback). Health clamped to [0, 1]. Returns
-- the count of rows changed so the worker can log meaningful churn.
drop function if exists public.samskara_decay();
create or replace function public.samskara_decay()
returns int
language plpgsql security invoker as $$
declare
  v_uid uuid := auth.uid();
  v_stale int;
  v_disconfirm int;
  v_unreinforced int;
begin
  update public.samskaras
     set health = greatest(0.0, health - 0.02),
         updated_at = now()
   where user_id = v_uid
     and (last_fired_at is null
          or last_fired_at < now() - interval '60 days');
  get diagnostics v_stale = row_count;

  update public.samskaras
     set health = greatest(0.0, health - 0.10),
         updated_at = now()
   where user_id = v_uid
     and disconfirm_count > confirm_count
     and (disconfirm_count + confirm_count) >= 3;
  get diagnostics v_disconfirm = row_count;

  -- Locked-in-without-feedback decay. A samskara that has fired many
  -- times but accumulated very little reaction signal is one of two
  -- things: bland context the user never reacts to, or stuck firing
  -- without challenge ("stereotype hardening" - the recursion-trap
  -- pathology where the model converges on a local minimum that's
  -- not wrong enough to update but not right enough to delight).
  -- Either way, a gentle 0.03 nudge per pass crowds it out without
  -- artificially perturbing user-facing behaviour the way an
  -- exploration epsilon would.
  --
  -- Threshold: fire_count > 10 AND total feedback < 20% of fires.
  -- A row with no feedback at all has the ratio = 0, definitely
  -- decays. A row that gets reacted-to ~1-in-3 fires is fine.
  update public.samskaras
     set health = greatest(0.0, health - 0.03),
         updated_at = now()
   where user_id = v_uid
     and fire_count > 10
     and (confirm_count + disconfirm_count)::real
         < 0.2 * fire_count::real;
  get diagnostics v_unreinforced = row_count;

  return v_stale + v_disconfirm + v_unreinforced;
end $$;

-- Compound-summary regeneration coordination.
--
-- Three RPCs. `samskara_should_regen_compound` returns a small
-- decision payload the worker uses to decide whether to do work; the
-- predicate combines a 6-hour staleness window with an event-count
-- threshold dampened by `log10(samskara_count + 10)` so a chatty
-- session doesn't thrash regeneration as the corpus grows. The two
-- claim/save RPCs follow the standard claim-then-save shape so
-- multiple devices coordinate.
drop function if exists public.samskara_should_regen_compound();
create or replace function public.samskara_should_regen_compound()
returns table (
  should_regen boolean,
  samskara_count int,
  last_regen_at timestamptz
)
language plpgsql stable security invoker as $$
declare
  v_uid uuid := auth.uid();
  v_count int;
  v_last_regen timestamptz;
  v_count_at_regen int;
  v_should boolean;
  v_threshold int;
begin
  select count(*) into v_count
    from public.samskaras s
   where s.user_id = v_uid;

  -- Table alias required: `last_regen_at` is also the name of one
  -- of this function's RETURNS TABLE output columns, and PL/pgSQL
  -- treats those as implicit variables inside the function body.
  -- Without `c.`-qualification on the select list, Postgres raises
  -- 42702 "column reference 'last_regen_at' is ambiguous" the
  -- moment the query is planned. Same reason this function
  -- qualifies the user_id predicate even though only one table is
  -- in scope: explicit is safer than magical.
  select c.last_regen_at, c.samskara_count_at_regen
    into v_last_regen, v_count_at_regen
    from public.samskara_compound_summary c
   where c.user_id = v_uid;

  -- Threshold formula: K_REGEN=5, log10 dampening, floor at 3 so a
  -- new corpus regenerates after as few as 3 mints rather than
  -- waiting on an unreachable threshold.
  --
  -- IMPORTANT for future readers (and LLM reviewers): in PostgreSQL
  -- the unary `log(x)` is the BASE-10 logarithm, not the natural
  -- log. The natural log is `ln(x)`. Most other languages have it
  -- the other way (Math.log in JS = natural; Math.log10 = base 10),
  -- so a naive grep-and-translate read of this line will mis-flag
  -- it as inconsistent with the worker code that uses
  -- `Math.log10(...)`. They agree. See PostgreSQL's "Mathematical
  -- Functions and Operators" docs.
  v_threshold := greatest(3, ceil(5.0 * log(v_count + 10))::int);

  if v_last_regen is null then
    v_should := v_count > 0;
  else
    v_should :=
      (v_last_regen < now() - interval '6 hours')
      or (v_count - coalesce(v_count_at_regen, 0) >= v_threshold);
  end if;

  return query select v_should, v_count, v_last_regen;
end $$;

drop function if exists public.samskara_claim_compound_regen(text, int);
create or replace function public.samskara_claim_compound_regen(
  p_holder_id text,
  p_ttl_seconds int
) returns boolean
language plpgsql security invoker as $$
declare
  v_uid uuid := auth.uid();
  v_changed int;
begin
  -- Insert-or-update with claim guard. The compound row is
  -- per-user (1:1) so a missing row is the cold-start case — we
  -- create it claimed in the same statement.
  insert into public.samskara_compound_summary (
    user_id, regen_claim_holder, regen_claim_expires
  ) values (
    v_uid, p_holder_id, now() + make_interval(secs => p_ttl_seconds)
  )
  on conflict (user_id) do update
     set regen_claim_holder = excluded.regen_claim_holder,
         regen_claim_expires = excluded.regen_claim_expires
   where samskara_compound_summary.regen_claim_expires is null
      or samskara_compound_summary.regen_claim_expires < now()
      or samskara_compound_summary.regen_claim_holder = excluded.regen_claim_holder;
  get diagnostics v_changed = row_count;
  return v_changed > 0;
end $$;

drop function if exists public.samskara_save_compound_summary_if_claimed(
  text, text, int
);
create or replace function public.samskara_save_compound_summary_if_claimed(
  p_holder_id text,
  p_summary text,
  p_samskara_count int
) returns boolean
language plpgsql security invoker as $$
declare
  v_uid uuid := auth.uid();
  v_changed int;
begin
  update public.samskara_compound_summary
     set summary = p_summary,
         samskara_count_at_regen = p_samskara_count,
         last_regen_at = now(),
         regen_claim_holder = null,
         regen_claim_expires = null
   where user_id = v_uid
     and regen_claim_holder = p_holder_id
     and regen_claim_expires > now();
  get diagnostics v_changed = row_count;
  return v_changed > 0;
end $$;

-- Mint-time dedup support -------------------------------------------------
--
-- `samskara_nearest_by_prediction` and `samskara_reinforce_existing`
-- back the mint-tier1 dedup guard in src/lib/agents/samskara/loop.ts.
-- Backstory: the mint-tier1 phase used to insert unconditionally
-- whenever the minter agent returned a non-null candidate; because
-- the agent's input is limited to a five-row substrate sample and
-- never the existing samskara corpus, near-duplicate paraphrases of
-- the same claim would accumulate - a single cohort fire could easily
-- contain 20+ worded-differently restatements of "user shares
-- detailed heritage-grain bread recipes." The guard queries the
-- nearest existing samskara by cosine on `prediction_embedding`, and
-- when the similarity exceeds the threshold it reinforces the
-- existing row (health bump + appended substrate provenance) instead
-- of minting a twin. The long-tail fire behaviour (no health-
-- threshold filter) is unchanged; this only affects MINT, not FIRE.
create or replace function public.samskara_nearest_by_prediction(
  p_query_embedding vector(2048),
  p_k_max int
) returns table (
  id uuid,
  cosine real,
  tier int
)
language sql stable security invoker as $$
  -- Returns the k nearest samskaras by cosine similarity against the
  -- supplied prediction embedding. Ordered by pgvector's cosine
  -- distance ascending so the most-similar row comes first; the
  -- caller reads `cosine` (1 - distance) for a threshold check. Does
  -- NOT filter by tier because a tier-2 compound duplicating a tier-1
  -- prediction is still a duplicate worth collapsing; callers that
  -- want tier-aware behaviour can post-filter on the return.
  select s.id,
         (1 - (s.prediction_embedding <=> p_query_embedding))::real as cosine,
         s.tier
    from public.samskaras s
   where s.user_id = auth.uid()
     and s.prediction_embedding is not null
   order by s.prediction_embedding <=> p_query_embedding asc
   limit p_k_max
$$;

-- Reinforce an existing samskara on re-observation. Called by the
-- mint-tier1 dedup path when the proposed prediction is semantically
-- too close to an existing row. Appends substrate provenance so the
-- audit trail still names the new observations, and nudges health up
-- by a small amount - capped at 1.0 - because a re-observation is a
-- weak positive signal (the user didn't actively confirm, they just
-- said something similar enough that the minter wanted to restate
-- the claim). Heavy reinforcement still goes through reaction-
-- classify's confirm/disconfirm path, which touches confidence.
create or replace function public.samskara_reinforce_existing(
  p_samskara_id uuid,
  p_substrate_ids uuid[],
  p_health_bump real
) returns boolean
language plpgsql security invoker as $$
declare
  v_uid uuid := auth.uid();
  v_exists boolean;
begin
  -- Ownership check yields an explicit boolean to the caller so
  -- "reinforced" vs "no such samskara" are distinguishable. RLS would
  -- silently filter an unowned row out of the update, which is fine
  -- for safety but useless for observability.
  select exists(
    select 1 from public.samskaras s
    where s.id = p_samskara_id and s.user_id = v_uid
  ) into v_exists;
  if not v_exists then
    return false;
  end if;

  update public.samskaras
     set health = least(1.0, health + p_health_bump),
         updated_at = now()
   where id = p_samskara_id and user_id = v_uid;

  -- Extend the provenance chain with the substrate rows that
  -- triggered this re-observation. Weight 0.5 (half of a fresh mint's
  -- 1.0) encodes "this is a re-observation, not the canonical
  -- evidence." `on conflict do nothing` keeps the function idempotent
  -- under duplicate callers or retries.
  if p_substrate_ids is not null and array_length(p_substrate_ids, 1) > 0 then
    insert into public.samskara_provenance (samskara_id, user_id, kind, ref_id, weight)
    select p_samskara_id, v_uid, 'substrate', sid, 0.5
      from unnest(p_substrate_ids) as sid
      on conflict (samskara_id, kind, ref_id) do nothing;
  end if;

  return true;
end $$;

-- Retire the earlier threshold-only collapse RPC. Superseded by
-- `samskara_collapse_by_cofiring` below, which uses behavioural
-- redundancy (co-firing in the same cohort) as its primary signal
-- instead of embedding similarity alone. The single-argument shape
-- is named explicitly so the drop is unambiguous even if a future
-- overload gets introduced; `if exists` keeps the schema re-apply
-- clean on databases that never had the old function.
drop function if exists public.samskara_collapse_duplicates(real);

-- Internal helper: merge `p_loser_id` into `p_winner_id` for the
-- given user. Retargets fires, copies provenance (primary-key
-- dedup via `on conflict do nothing`), folds counters into the
-- winner, then deletes the loser. Exists as a helper because the
-- collapse RPC below runs two passes (co-firing pass + safety
-- cap), both of which need the same merge semantics. RLS applies;
-- callers that don't pass the right user_id simply no-op because
-- the updates and delete filter on it.
--
-- Not intended for direct client use - the underscore prefix is
-- the callsite signal. Declared `security invoker` so the caller's
-- auth.uid() governs RLS the same way it would in an inlined
-- merge; the winner/loser lookups below require the caller to own
-- both rows, which the enclosing RPC guarantees.
create or replace function public._samskara_merge_pair(
  p_winner_id uuid,
  p_loser_id uuid,
  p_user_id uuid
) returns void
language plpgsql security invoker as $$
begin
  -- Drop loser-fires in cohorts where the winner already has a
  -- fire. Without this, the retarget UPDATE below would create two
  -- rows with the same (cohort_id, samskara_id) - originally a
  -- visible bug in the diagnostics modal (identical predictions
  -- with different scores under one cohort) and a subtler problem
  -- for the cofire-based dedup math, which would see the winner
  -- "cofiring with itself" and inflate Hebbian binding scores. The
  -- unique constraint added alongside this fix would also reject
  -- the UPDATE, but doing the cleanup explicitly here keeps the
  -- merge transaction succeeding instead of erroring on conflict.
  delete from public.samskara_fires
   where samskara_id = p_loser_id
     and user_id = p_user_id
     and cohort_id in (
       select cohort_id
         from public.samskara_fires
        where samskara_id = p_winner_id
          and user_id = p_user_id
     );

  -- Retarget the surviving fires. Every fire row that pointed at
  -- the loser now counts toward the winner so cohort history is
  -- preserved.
  update public.samskara_fires
     set samskara_id = p_winner_id
   where samskara_id = p_loser_id and user_id = p_user_id;

  -- Copy loser's provenance to the winner (dedup via the composite
  -- primary key). Loser's remaining provenance rows cascade-delete
  -- when the loser row itself is deleted below.
  insert into public.samskara_provenance (samskara_id, user_id, kind, ref_id, weight)
  select p_winner_id, user_id, kind, ref_id, weight
    from public.samskara_provenance
   where samskara_id = p_loser_id
    on conflict (samskara_id, kind, ref_id) do nothing;

  -- Fold counters. `greatest` with nullable timestamps yields the
  -- later timestamp or NULL if both are NULL (Postgres greatest()
  -- ignores NULLs rather than propagating them, unlike arithmetic).
  update public.samskaras w
     set fire_count = w.fire_count + l.fire_count,
         confirm_count = w.confirm_count + l.confirm_count,
         disconfirm_count = w.disconfirm_count + l.disconfirm_count,
         last_fired_at = greatest(w.last_fired_at, l.last_fired_at),
         updated_at = now()
    from public.samskaras l
   where w.id = p_winner_id
     and l.id = p_loser_id
     and w.user_id = p_user_id;

  delete from public.samskaras
   where id = p_loser_id and user_id = p_user_id;
end $$;

-- Maintenance: collapse redundant tier-1 samskaras using co-firing
-- as the primary signal, with an embedding-similarity safety cap.
--
-- Primary pass ("behavioural redundancy"). Two samskaras that
-- reliably co-fire in the same cohort are Hebbianly bound — they
-- activate together, so one of them is functionally the other.
-- A pair is merged when:
--   - they've co-fired in at least `p_min_cofires` cohorts, AND
--   - cofires / min(fires_a, fires_b) >= `p_min_cofire_ratio`
--     (the normalization prevents a pair that always fires together
--     BUT also fires independently from being flagged; pure-cofire
--     counts are confounded by samskaras that fire in nearly every
--     cohort for situational reasons), AND
--   - prediction-embedding cosine >= `p_cosine_floor` as a sanity
--     floor against spurious co-fires (e.g. "tech tester" and
--     "barley science" both firing on a debug-panel-about-baking
--     turn without being the same habit).
-- The winner is always the older row so the audit trail and
-- compound-regen's recency weighting stay aligned with the existing
-- mint-tier1 dedup-reinforce behaviour.
--
-- Safety cap ("population overflow"). If the primary pass leaves
-- the tier-1 pool above `p_target_count`, fall through to a pure
-- embedding-cosine greedy merge down to the target, refusing to
-- merge pairs with cosine < `p_cap_cosine_floor`. This guards
-- against a diverse-but-overflowing pool where no pair meets the
-- co-firing bar but the count is still growing without bound.
--
-- Per-call cap. `p_max_collapses` bounds work per invocation so a
-- single RPC never chains through a pathological pool. The
-- background worker calls this each rotation; repeated calls drain
-- the backlog without any individual call blocking the worker
-- loop.
--
-- Idempotent under repeated calls. Safe to run while the worker is
-- live: a concurrent mint-tier1 could at worst re-create a twin
-- this call just removed, which the next invocation catches.
create or replace function public.samskara_collapse_by_cofiring(
  p_min_cofires int default 3,
  p_min_cofire_ratio real default 0.5,
  p_cosine_floor real default 0.70,
  p_target_count int default 150,
  p_cap_cosine_floor real default 0.60,
  p_max_collapses int default 20
) returns int
language plpgsql security invoker as $$
declare
  v_uid uuid := auth.uid();
  v_collapsed int := 0;
  v_pair record;
  v_winner uuid;
  v_loser uuid;
  v_current_count int;
begin
  -- PRIMARY PASS: behavioural redundancy via co-firing.
  --
  -- Candidate pair enumeration self-joins samskara_fires on
  -- cohort_id with `f1.samskara_id < f2.samskara_id` to emit each
  -- unordered pair exactly once. Filtered by min-cofires at the
  -- GROUP BY step to keep the candidate set small, then enriched
  -- with embedding cosine and fire counts before the ratio and
  -- cosine-floor checks. Ordered by ratio desc, cosine desc so the
  -- strongest redundancies merge first and the max-collapses cap
  -- bites on the most defensible merges when it bites.
  for v_pair in
    with pair_cofires as (
      select
        least(f1.samskara_id, f2.samskara_id) as a_id,
        greatest(f1.samskara_id, f2.samskara_id) as b_id,
        count(*)::int as cofires
      from public.samskara_fires f1
      join public.samskara_fires f2
        on f1.cohort_id = f2.cohort_id
       and f1.samskara_id < f2.samskara_id
      where f1.user_id = v_uid
        and f2.user_id = v_uid
      group by 1, 2
      having count(*) >= p_min_cofires
    )
    select
      pc.a_id,
      pc.b_id,
      sa.created_at as a_created_at,
      sb.created_at as b_created_at,
      pc.cofires,
      (pc.cofires::real / greatest(least(sa.fire_count, sb.fire_count), 1)::real)::real as ratio,
      (1 - (sa.prediction_embedding <=> sb.prediction_embedding))::real as cosine
    from pair_cofires pc
    join public.samskaras sa on sa.id = pc.a_id
    join public.samskaras sb on sb.id = pc.b_id
    where sa.user_id = v_uid
      and sb.user_id = v_uid
      and sa.tier = 1
      and sb.tier = 1
      and sa.prediction_embedding is not null
      and sb.prediction_embedding is not null
      and (pc.cofires::real / greatest(least(sa.fire_count, sb.fire_count), 1)::real) >= p_min_cofire_ratio
      and (1 - (sa.prediction_embedding <=> sb.prediction_embedding))::real >= p_cosine_floor
    order by ratio desc, cosine desc
  loop
    exit when v_collapsed >= p_max_collapses;

    if v_pair.a_created_at <= v_pair.b_created_at then
      v_winner := v_pair.a_id;
      v_loser  := v_pair.b_id;
    else
      v_winner := v_pair.b_id;
      v_loser  := v_pair.a_id;
    end if;

    -- Skip if either side already disappeared (consumed by an
    -- earlier merge this pass). The candidate set was computed up
    -- front; the pool shrinks as we iterate.
    if not exists (select 1 from public.samskaras where id = v_winner and user_id = v_uid)
       or not exists (select 1 from public.samskaras where id = v_loser and user_id = v_uid)
    then
      continue;
    end if;

    perform public._samskara_merge_pair(v_winner, v_loser, v_uid);
    v_collapsed := v_collapsed + 1;
  end loop;

  -- SAFETY CAP: fall through to pure-embedding greedy merge when
  -- the pool is still over target.
  select count(*) into v_current_count
    from public.samskaras
   where user_id = v_uid and tier = 1;

  if v_current_count > p_target_count then
    for v_pair in
      select
        sa.id as a_id,
        sb.id as b_id,
        sa.created_at as a_created_at,
        sb.created_at as b_created_at,
        (1 - (sa.prediction_embedding <=> sb.prediction_embedding))::real as cosine
      from public.samskaras sa
      join public.samskaras sb
        on sa.user_id = sb.user_id
       and sa.id < sb.id
      where sa.user_id = v_uid
        and sa.tier = 1
        and sb.tier = 1
        and sa.prediction_embedding is not null
        and sb.prediction_embedding is not null
        and (1 - (sa.prediction_embedding <=> sb.prediction_embedding))::real >= p_cap_cosine_floor
      order by sa.prediction_embedding <=> sb.prediction_embedding asc
    loop
      exit when v_collapsed >= p_max_collapses;
      exit when v_current_count <= p_target_count;

      if v_pair.a_created_at <= v_pair.b_created_at then
        v_winner := v_pair.a_id;
        v_loser  := v_pair.b_id;
      else
        v_winner := v_pair.b_id;
        v_loser  := v_pair.a_id;
      end if;

      if not exists (select 1 from public.samskaras where id = v_winner and user_id = v_uid)
         or not exists (select 1 from public.samskaras where id = v_loser and user_id = v_uid)
      then
        continue;
      end if;

      perform public._samskara_merge_pair(v_winner, v_loser, v_uid);
      v_collapsed := v_collapsed + 1;
      v_current_count := v_current_count - 1;
    end loop;
  end if;

  return v_collapsed;
end $$;

-- Journal feature removed -------------------------------------------------
--
-- The daily-journal subsystem (entries, spam-filter classifier, thread
-- claim cursor, worker-leases partition) used to live here. The feature
-- was removed because the wiki absorbed the long-term reflective-content
-- role and the spam-filter ham/spam labelling never converged. Idempotent
-- teardown so databases that synced the old schema drop their journal
-- footprint on the next apply.
drop function if exists public.reset_journal_data();
drop function if exists public.score_journal_spam(text[]);
drop function if exists public.untrain_journal_spam(text[], text);
drop function if exists public.train_journal_spam(text[], text);
drop function if exists public.get_journal_spam_stats();
drop function if exists public.save_journal_entry_embedding_if_claimed(uuid, text, vector, text);
drop function if exists public.claim_next_pending_journal_entry(text, int);
drop function if exists public.search_journal_entries_by_embedding(vector, int);
drop function if exists public.mark_thread_journaled_for_user(uuid);
drop function if exists public.mark_thread_journaled_if_claimed(uuid, text, uuid);
drop function if exists public.upsert_journal_entry_and_mark_thread(uuid, text, uuid, date, text, text[], text, text[]);
drop function if exists public.claim_next_thread_for_journal(text, int, text);
drop function if exists public.clear_journal_embedding_on_change() cascade;
drop table if exists public.journal_spam_tokens cascade;
drop table if exists public.journal_spam_stats cascade;
drop table if exists public.journal_thread_excludes cascade;
drop table if exists public.journal_entries cascade;
alter table public.threads
  drop column if exists last_journaled_msg_id,
  drop column if exists journal_claim_holder,
  drop column if exists journal_claim_expires_at;
-- Drop any lingering worker_leases rows so a tab that hasn't reloaded
-- yet doesn't keep heartbeating a partition that no longer exists.
delete from public.worker_leases where worker_kind = 'journal';

-- User Wiki ---------------------------------------------------------------
--
-- Flat (no nesting) encyclopedia-style articles peer to chats and
-- memories. A background worker (src/lib/agents/wiki/) reads
-- conversations the day after they settle and either updates an
-- existing article or creates a new one. The user can also search,
-- view, edit, add, delete, and ask an agent to rewrite a single
-- article with explicit instructions.
--
-- Article voice is wiki-style third-person prose. Articles are NEVER
-- auto-injected into the chat; the main LLM reaches them only through
-- the always-on `wiki_search` tool. This is the deliberate split from
-- memory (atomic facts surfaced inline by the recall layer).
--
-- title is the alphabetical sort key the drawer renders; (user_id,
-- title) is unique so the autonomous agent's `wiki_create` can hit
-- ON CONFLICT and fall through to `wiki_update` rather than racing
-- duplicates. The unique key is per-user; deduplication across users
-- is meaningless because every user has their own private encyclopedia.

create table if not exists public.wiki_articles (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  -- Topic / encyclopedia-entry name. Drawer sorts by this column
  -- (case-insensitive) so the listing reads alphabetically. Also the
  -- uniqueness key per user.
  title text not null,
  content text not null,
  embedding vector(2048),
  embedding_model text,
  embedding_claim_holder text,
  -- No _at suffix to match the convention from memories.
  embedding_claim_expires timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, title)
);

create index if not exists wiki_articles_user_title_idx
  on public.wiki_articles (user_id, lower(title) asc);

-- Same invariant as memories: when the text that
-- produced the embedding changes, null the embedding so the worker re-
-- embeds on its next poll. Null the claim columns too so an in-flight
-- worker save (which guards on holder + expires > now()) cannot land a
-- stale vector against the new text.
create or replace function public.clear_wiki_embedding_on_change()
  returns trigger language plpgsql as $$
begin
  if new.title is distinct from old.title
     or new.content is distinct from old.content then
    new.embedding := null;
    new.embedding_model := null;
    new.embedding_claim_holder := null;
    new.embedding_claim_expires := null;
  end if;
  return new;
end $$;

drop trigger if exists clear_wiki_embedding_on_change on public.wiki_articles;
create trigger clear_wiki_embedding_on_change
  before update on public.wiki_articles
  for each row execute function public.clear_wiki_embedding_on_change();

alter table public.wiki_articles enable row level security;

drop policy if exists "wiki_articles are self-selectable" on public.wiki_articles;
create policy "wiki_articles are self-selectable" on public.wiki_articles
  for select using (auth.uid() = user_id);

drop policy if exists "wiki_articles are self-insertable" on public.wiki_articles;
create policy "wiki_articles are self-insertable" on public.wiki_articles
  for insert with check (auth.uid() = user_id);

drop policy if exists "wiki_articles are self-updatable" on public.wiki_articles;
create policy "wiki_articles are self-updatable" on public.wiki_articles
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists "wiki_articles are self-deletable" on public.wiki_articles;
create policy "wiki_articles are self-deletable" on public.wiki_articles
  for delete using (auth.uid() = user_id);

-- Per-thread pointer + claim columns for the autonomous wiki agent.
-- Independent of last_reflected_msg_id so both workers can run
-- concurrently against the same thread without crowding each
-- other's pointers.
alter table public.threads
  add column if not exists last_wiki_processed_msg_id uuid references public.messages(id) on delete set null,
  add column if not exists wiki_claim_holder text,
  add column if not exists wiki_claim_expires_at timestamptz;

-- Claim the next thread eligible for wiki processing. Two notable
-- shape choices:
--   (1) Eligibility uses the NEWEST message's created_at (read off a
--       second lateral) rather than threads.updated_at. Both columns
--       move on every insert, but reading the timestamp from messages
--       directly is more honest about "when did the conversation
--       actually last move" - threads.updated_at can be bumped by
--       other unrelated writes (a future schema change might add
--       title-renames or settings-bumps to threads.updated_at and the
--       gate would shift).
--   (2) The eligibility gate is "newest message lands on a calendar
--       day STRICTLY BEFORE today in the user's tz". Effect: chat
--       Monday -> eligible Tuesday; user resumes Wednesday -> the new
--       newest msg lands on Wednesday and the inequality fails again
--       until Thursday. This is the user's "settles for at least one
--       full day boundary" rule.
-- Depth guard (>= 2 user messages) and skip-locked fairness.
drop function if exists public.claim_next_thread_for_wiki(text, int);
drop function if exists public.claim_next_thread_for_wiki(text, int, text);
create or replace function public.claim_next_thread_for_wiki(
  p_holder_id text,
  p_ttl_seconds int,
  -- User's display timezone from Settings -> AI -> About you;
  -- determines the calendar day the eligibility gate buckets on.
  p_timezone text default 'UTC'
) returns table (
  thread_id uuid,
  terminal_msg_id uuid,
  title text,
  newest_msg_at timestamptz
)
language sql security invoker as $$
  with candidate as (
    select
      t.id as thread_id,
      term.msg_id as terminal_msg_id,
      t.title as title,
      newest.created_at as newest_msg_at
      from public.threads t
      cross join lateral (
        -- Terminal-msg lateral: latest assistant row whose
        -- tool_calls is empty/null and whose
        -- content is non-empty. The id is what we stamp into
        -- last_wiki_processed_msg_id when the agent finishes.
        select m.id as msg_id
          from public.messages m
         where m.thread_id = t.id
           and m.role = 'assistant'
           and (m.tool_calls is null
                or jsonb_typeof(m.tool_calls) <> 'array'
                or jsonb_array_length(m.tool_calls) = 0)
           and m.content is not null
           and length(m.content) > 0
         order by m.created_at desc
         limit 1
      ) term
      cross join lateral (
        -- Newest message of any role - the timestamp the day-gate
        -- buckets. Reading it off messages.created_at instead of
        -- threads.updated_at keeps the gate stable against future
        -- bumps to threads.updated_at from unrelated writes.
        select m2.created_at
          from public.messages m2
         where m2.thread_id = t.id
         order by m2.created_at desc
         limit 1
      ) newest
     where t.user_id = auth.uid()
       and term.msg_id is distinct from t.last_wiki_processed_msg_id
       and (t.wiki_claim_expires_at is null
            or t.wiki_claim_expires_at < now())
       and (
         -- Skip threads that haven't seen a follow-up user message.
         -- A one-shot Q&A is not enough material to warrant a wiki
         -- update.
         select count(*)
           from public.messages m3
          where m3.thread_id = t.id
            and m3.role = 'user'
       ) >= 2
       -- Next-day eligibility. Newest message must land on a
       -- calendar day strictly before today in the user's tz.
       and (newest.created_at at time zone p_timezone)::date
           < (now() at time zone p_timezone)::date
     order by newest.created_at asc
     limit 1
     for update of t skip locked
  )
  update public.threads t
     set wiki_claim_holder = p_holder_id,
         wiki_claim_expires_at = now() + make_interval(secs => p_ttl_seconds)
    from candidate c
   where t.id = c.thread_id
  returning t.id as thread_id, c.terminal_msg_id, c.title, c.newest_msg_at;
$$;

-- Advance the per-thread wiki pointer IF our claim is still ours.
-- Called after every agent run regardless of outcome - even a no-op
-- run (agent decided no topic in the conversation warranted an
-- article) should advance the pointer so the same conversation is not
-- re-processed every poll. Returns false on claim-lost; caller drops
-- the cycle.
drop function if exists public.mark_thread_wiki_processed_if_claimed(uuid, text, uuid);
create or replace function public.mark_thread_wiki_processed_if_claimed(
  p_thread_id uuid,
  p_holder_id text,
  p_msg_id uuid
) returns boolean
language plpgsql security invoker as $$
declare
  updated int;
begin
  update public.threads
     set last_wiki_processed_msg_id = p_msg_id,
         wiki_claim_holder = null,
         wiki_claim_expires_at = null
   where id = p_thread_id
     and user_id = auth.uid()
     and wiki_claim_holder = p_holder_id
     and wiki_claim_expires_at > now();
  get diagnostics updated = row_count;
  return updated > 0;
end $$;

-- Embeddings pipeline RPCs for wiki articles. Same claim/save shape
-- as memories, same 2048-dim padded vectors,
-- same security invoker posture letting RLS enforce user scoping.
drop function if exists public.claim_next_pending_wiki_article(text, int);
create or replace function public.claim_next_pending_wiki_article(
  p_holder_id text,
  p_ttl_seconds int
) returns table (id uuid, title text, content text)
language sql security invoker as $$
  with candidate as (
    select w.id
      from public.wiki_articles w
     where w.user_id = auth.uid()
       and w.embedding is null
       and (w.embedding_claim_expires is null
            or w.embedding_claim_expires < now())
     order by w.updated_at desc
     limit 1
     for update skip locked
  )
  update public.wiki_articles w
     set embedding_claim_holder = p_holder_id,
         embedding_claim_expires = now() + make_interval(secs => p_ttl_seconds)
    from candidate c
   where w.id = c.id
  returning w.id, w.title, w.content;
$$;

drop function if exists public.save_wiki_article_embedding_if_claimed(uuid, text, vector, text);
create or replace function public.save_wiki_article_embedding_if_claimed(
  p_id uuid,
  p_holder_id text,
  p_embedding vector(2048),
  p_embedding_model text
) returns boolean
language plpgsql security invoker as $$
declare
  updated int;
begin
  update public.wiki_articles
     set embedding = p_embedding,
         embedding_model = p_embedding_model,
         embedding_claim_holder = null,
         embedding_claim_expires = null
   where id = p_id
     and user_id = auth.uid()
     and embedding_claim_holder = p_holder_id
     and embedding_claim_expires > now();
  get diagnostics updated = row_count;
  return updated > 0;
end $$;

-- Similarity search RPC. Plain cosine ranking, no confidence boost
-- (articles are direct user/agent assertions, not probabilistic
-- memories). Scoped by RLS plus an explicit user_id guard.
drop function if exists public.search_wiki_articles_by_embedding(vector, int);
create or replace function public.search_wiki_articles_by_embedding(
  query_embedding vector(2048),
  match_limit int
) returns table (
  id uuid,
  title text,
  content text,
  created_at timestamptz,
  updated_at timestamptz,
  similarity real
)
language sql stable security invoker as $$
  select id, title, content, created_at, updated_at,
         (1 - (embedding <=> query_embedding))::real as similarity
    from public.wiki_articles
   where user_id = auth.uid()
     and embedding is not null
   order by embedding <=> query_embedding asc
   limit match_limit
$$;

-- Source-conversation attribution. Replaces the older inline-citation
-- convention (Markdown links of the form `[label](?cid=<uuid>)` inside
-- article bodies) with structured many-to-many rows. Two motivations:
--
--   1. The autonomous and librarian agents kept emitting malformed
--      citation markdown (`([?cid=<uuid>)` was the consistent shape),
--      because building a structured Markdown link with a UUID in the
--      URL is a low-frequency pattern in training data. Taking
--      citation-formatting work away from the model entirely sidesteps
--      the failure mode.
--   2. The bibliography view that surfaces these rows orders them by
--      `last_processed_at` ascending, so the reader sees the article's
--      narrative of growth (first contributing conversation, then the
--      conversations that added to it) rather than scattered inline
--      anchors. Per-fact provenance is lost; article-level provenance
--      is gained and is more honest about what we actually know.
--
-- Tools (wiki_create / wiki_update) populate these rows on every
-- successful write. The autonomous agent's wrapper auto-attaches the
-- current thread id (it processes exactly one thread per cycle). The
-- librarian (which synthesises from `conversation_search` results)
-- passes `source_thread_ids` explicitly; the tool validates each id
-- belongs to a thread the user owns before inserting.
--
-- Composite PK + `on conflict do nothing` upserts means re-processing
-- a thread bumps `last_processed_at` (via an explicit update path in
-- the tool) instead of creating duplicate rows. Cascade-on-delete from
-- both sides keeps the table consistent under article deletion and
-- thread deletion (reset_wiki_data + the rare manual thread purge).
create table if not exists public.wiki_article_sources (
  article_id uuid not null references public.wiki_articles(id) on delete cascade,
  thread_id  uuid not null references public.threads(id)       on delete cascade,
  first_processed_at timestamptz not null default now(),
  last_processed_at  timestamptz not null default now(),
  primary key (article_id, thread_id)
);

create index if not exists wiki_article_sources_article_chrono_idx
  on public.wiki_article_sources (article_id, last_processed_at);
create index if not exists wiki_article_sources_thread_idx
  on public.wiki_article_sources (thread_id);

alter table public.wiki_article_sources enable row level security;

-- RLS via the owning article's user_id. We don't need a user_id
-- column on this sidecar because the article's row already carries
-- one; an `exists` subquery enforces ownership transitively and keeps
-- the schema narrower.
drop policy if exists "wiki_article_sources are self-selectable" on public.wiki_article_sources;
create policy "wiki_article_sources are self-selectable" on public.wiki_article_sources
  for select using (
    exists (
      select 1 from public.wiki_articles wa
       where wa.id = wiki_article_sources.article_id
         and wa.user_id = auth.uid()
    )
  );

drop policy if exists "wiki_article_sources are self-insertable" on public.wiki_article_sources;
create policy "wiki_article_sources are self-insertable" on public.wiki_article_sources
  for insert with check (
    exists (
      select 1 from public.wiki_articles wa
       where wa.id = wiki_article_sources.article_id
         and wa.user_id = auth.uid()
    )
  );

drop policy if exists "wiki_article_sources are self-updatable" on public.wiki_article_sources;
create policy "wiki_article_sources are self-updatable" on public.wiki_article_sources
  for update using (
    exists (
      select 1 from public.wiki_articles wa
       where wa.id = wiki_article_sources.article_id
         and wa.user_id = auth.uid()
    )
  );

drop policy if exists "wiki_article_sources are self-deletable" on public.wiki_article_sources;
create policy "wiki_article_sources are self-deletable" on public.wiki_article_sources
  for delete using (
    exists (
      select 1 from public.wiki_articles wa
       where wa.id = wiki_article_sources.article_id
         and wa.user_id = auth.uid()
    )
  );

-- Wiki changelog. One row per individual mutation - create, update, or
-- delete - written by every wiki write path: the per-conversation wiki
-- agent's tool calls, the librarian's tool calls, and the user's direct
-- edits in Wiki.svelte. The `message` column is the commit-message-style
-- one-line summary the writer supplied at the time of the change; the
-- librarian's broader run summary is implicit from the cluster of rows
-- sharing a created_at neighbourhood.
--
-- `article_id` is `on delete set null` so a deleted article doesn't take
-- its history with it. The `title_at_change` snapshot is captured at
-- write time so a row whose article has been deleted still reads
-- meaningfully in the changelog UI without a join.
--
-- Rows are append-only - no policy allowing update or delete (rebuilds
-- via reset_wiki_data go through a separate path; see the same-named
-- function in this file).
create table if not exists public.wiki_changelog (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  article_id uuid references public.wiki_articles(id) on delete set null,
  -- 'create' | 'update' | 'delete'. Constrained at the column level so a
  -- typo'd kind value can't land silently.
  kind text not null check (kind in ('create', 'update', 'delete')),
  -- Snapshot of the article title as it was at the time of this change.
  -- For create/update this is the new title; for delete it's the title
  -- the article had immediately before deletion. Allows the changelog
  -- UI to render meaningfully even when article_id has been nulled by
  -- the FK cascade.
  title_at_change text not null,
  -- The commit-message-style explanation supplied by the writer. Capped
  -- at 200 chars to match the column-level CHECK that mirrors the tool
  -- schemas; longer prose belongs in the article body, not here.
  message text not null check (char_length(message) between 1 and 200),
  created_at timestamptz not null default now()
);

-- Primary access pattern is "page through the user's history newest-
-- first", so the chronological index is the index that pays its way.
-- A separate per-article index would let the article panel show its own
-- timeline cheaply, but no surface needs that today - add it when one
-- does.
create index if not exists wiki_changelog_user_created_idx
  on public.wiki_changelog (user_id, created_at desc);

alter table public.wiki_changelog enable row level security;

drop policy if exists "wiki_changelog are self-selectable" on public.wiki_changelog;
create policy "wiki_changelog are self-selectable" on public.wiki_changelog
  for select using (auth.uid() = user_id);

drop policy if exists "wiki_changelog are self-insertable" on public.wiki_changelog;
create policy "wiki_changelog are self-insertable" on public.wiki_changelog
  for insert with check (auth.uid() = user_id);

-- No update or delete policies. The changelog is append-only from the
-- client's perspective; bulk wipes go through reset_wiki_data which
-- runs as the security-definer owner and isn't subject to RLS.

-- See Also RPC. Returns wiki articles topically related to the
-- target article, using a dynamically-calibrated similarity floor:
-- the minimum cosine similarity between the target's embedding and
-- the embeddings of the conversations attributed to it. Articles
-- built from tight-topic sources end up with a high bar (only very
-- close siblings clear it); articles built from a wider net of
-- sources get a more permissive bar. An article with no related
-- siblings honestly returns an empty list rather than padding with
-- low-quality matches.
--
-- Single-sample floors (an article with one source) are noisy but
-- acceptable; the floor is whatever it is for that one source. If
-- the article has zero sources, or no source's embedding has been
-- computed yet, the floor falls through to 0.0 - we still return
-- the top-k most-similar articles rather than nothing, on the
-- assumption that "no signal" should not punish discovery.
drop function if exists public.find_related_wiki_articles(uuid);
drop function if exists public.find_related_wiki_articles(uuid, int);
create or replace function public.find_related_wiki_articles(
  p_article_id uuid,
  p_limit int default 5
) returns table (
  id uuid,
  title text,
  similarity real
)
language sql stable security invoker as $$
  with target as (
    select embedding
      from public.wiki_articles
     where id = p_article_id
       and user_id = auth.uid()
       and embedding is not null
  ),
  floor as (
    select coalesce(
             min(1 - (t.embedding <=> (select embedding from target))),
             0.0
           )::real as min_sim
      from public.wiki_article_sources ws
      join public.threads t on t.id = ws.thread_id
     where ws.article_id = p_article_id
       and t.embedding is not null
  )
  select a.id,
         a.title,
         (1 - (a.embedding <=> (select embedding from target)))::real as similarity
    from public.wiki_articles a, floor f
   where a.user_id = auth.uid()
     and a.id <> p_article_id
     and a.embedding is not null
     and exists (select 1 from target)
     and (1 - (a.embedding <=> (select embedding from target)))::real >= f.min_sim
   order by a.embedding <=> (select embedding from target) asc
   limit p_limit;
$$;

-- One-time data migration: extract source-conversation citations the
-- wiki agents previously emitted as `?cid=<uuid>` substrings inside
-- article bodies, hoist them into wiki_article_sources, and strip the
-- broken citation text from the content. Idempotent: after the first
-- successful run there are no `?cid=` substrings left, the regex
-- matches nothing, no inserts/updates fire. Cheap to re-run on every
-- deploy (~one no-op pass over the article set).
--
-- The strip handles two shapes seen in the wild:
--   ([?cid=<uuid>)            - the consistent malformed citation
--                               the model emitted as its "citation"
--   [<label>](?cid=<uuid>)    - the correctly-formed link the
--                               prompt's example produced when the
--                               model followed instructions
-- The correctly-formed variant leaves the human-readable label in
-- place; the malformed shape is removed entirely. Any remaining
-- `?cid=<uuid>` fragments (other malformed variants we didn't see)
-- get stripped wholesale in a final pass.
do $$
declare
  v_article record;
  v_cid record;
  v_cleaned text;
begin
  for v_article in
    select id, user_id, content from public.wiki_articles
  loop
    -- Hoist every UUID-shaped ?cid= candidate into the sidecar,
    -- conditional on the thread actually existing and belonging to
    -- the same user as the article (defense against any historical
    -- fabrications that happened to round-trip the JS validator).
    for v_cid in
      select distinct (m[1])::uuid as thread_id
        from regexp_matches(
               v_article.content,
               '\?cid=([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})',
               'g'
             ) m
    loop
      if exists (
        select 1 from public.threads
         where id = v_cid.thread_id
           and user_id = v_article.user_id
      ) then
        insert into public.wiki_article_sources (article_id, thread_id)
          values (v_article.id, v_cid.thread_id)
          on conflict do nothing;
      end if;
    end loop;

    v_cleaned := v_article.content;
    -- Malformed shape first - greedier match, would otherwise be
    -- partially consumed by the correctly-formed pattern.
    v_cleaned := regexp_replace(
      v_cleaned,
      '\(\[\?cid=[0-9a-fA-F-]+\)',
      '',
      'g'
    );
    -- Correctly-formed markdown link - keep the label, drop the URL.
    v_cleaned := regexp_replace(
      v_cleaned,
      '\[([^\]]+)\]\(\?cid=[0-9a-fA-F-]+\)',
      '\1',
      'g'
    );
    -- Catch-all for any remaining ?cid=... fragment.
    v_cleaned := regexp_replace(v_cleaned, '\?cid=[0-9a-fA-F-]+', '', 'g');
    -- Tidy whitespace artefacts the strips can leave behind.
    v_cleaned := regexp_replace(v_cleaned, '  +', ' ', 'g');
    v_cleaned := regexp_replace(v_cleaned, ' +([.,;:!?])', '\1', 'g');

    if v_cleaned <> v_article.content then
      update public.wiki_articles
         set content = v_cleaned
       where id = v_article.id;
    end if;
  end loop;
end $$;

-- Wipe-and-rewind for the wiki subsystem. Called from Settings ->
-- Wiki -> Reset. Two side effects under RLS scoping:
--
--   1. Delete every wiki article the user owns. The wiki has no
--      per-thread exclude table - articles are aggregated across
--      many threads, so there's no "permanently exclude this
--      thread" semantic to undo.
--   2. Null out the per-thread wiki pointer + claim columns on every
--      thread the user owns. Clearing last_wiki_processed_msg_id is
--      what re-eligibilizes the threads for the next worker sweep;
--      the wiki agent will read each conversation fresh and rebuild
--      articles from scratch. Claim columns are nulled defensively
--      against an in-flight worker cycle.
--
-- Note: the librarian's last-run timestamp on profiles is left alone.
-- A reset is about the article store and the per-thread pipeline; the
-- librarian's cadence is orthogonal (and re-running the librarian
-- immediately after a reset is harmless because it has nothing to
-- consolidate).
--
-- Single plpgsql transaction so the user can't end up half-reset.
drop function if exists public.reset_wiki_data();
create or replace function public.reset_wiki_data()
returns void
language plpgsql security invoker as $$
declare
  v_user uuid := auth.uid();
begin
  if v_user is null then
    raise exception 'reset_wiki_data: not authenticated'
      using errcode = '28000';
  end if;
  delete from public.wiki_articles where user_id = v_user;
  -- A wipe is a fresh start. Surviving changelog rows would point at
  -- nothing (article_id nulled by the FK cascade) and read confusingly
  -- alongside an empty wiki, so we drop them here as part of the same
  -- reset rather than leaving orphans.
  delete from public.wiki_changelog where user_id = v_user;
  update public.threads
     set last_wiki_processed_msg_id = null,
         wiki_claim_holder = null,
         wiki_claim_expires_at = null
   where user_id = v_user;
end $$;

-- Wiki librarian last-run timestamp + atomic-claim RPC. The wiki
-- librarian is a separate background agent that periodically
-- reorganises the user's wiki: consolidating duplicates, fact-
-- checking against conversation history, merging articles that
-- belong together. It runs on a long minimum interval (12 hours
-- by default) - far less often than the per-conversation wiki
-- agent - and there's no per-thread queue. Cross-device
-- coordination needs an atomic "is it time to run yet?" check
-- so two devices that both wake up don't both run the agent.
--
-- Approach: store the last successful run timestamp on profiles
-- and gate the run via an UPDATE-with-WHERE that only matches
-- when `now() - last_run >= min_interval`. The UPDATE is atomic
-- per row, so only one device's call ever sees the row update;
-- the others see zero rows updated and skip.
alter table public.profiles
  add column if not exists wiki_librarian_last_run_at timestamptz;

-- Atomic claim. Returns true if this caller acquired the run
-- (i.e. the timestamp had aged past p_min_interval_seconds, OR
-- no prior run timestamp was stored), false otherwise. The
-- worker calls this BEFORE running the agent; if it returns
-- false the worker skips this cycle and naps until the next
-- check.
--
-- security invoker so RLS scopes the row to the calling user.
-- profiles already has a self-update policy.
drop function if exists public.claim_wiki_librarian_run(int);
create or replace function public.claim_wiki_librarian_run(
  p_min_interval_seconds int
) returns boolean
language plpgsql security invoker as $$
declare
  updated int;
begin
  if auth.uid() is null then
    return false;
  end if;
  update public.profiles
     set wiki_librarian_last_run_at = now()
   where user_id = auth.uid()
     and (
       wiki_librarian_last_run_at is null
       or wiki_librarian_last_run_at
            < now() - make_interval(secs => p_min_interval_seconds)
     );
  get diagnostics updated = row_count;
  return updated > 0;
end $$;

-- Atomic assistant-message commit with conflict detection -----------------
--
-- Terminal assistant rows from the chat-loop are written through this
-- function instead of a plain INSERT. Two safety checks run inside the
-- same serialized transaction:
--
--   1. The thread row is locked (SELECT ... FOR UPDATE) so two devices
--      that both finish streaming at the same moment cannot both pass
--      the conflict check and both insert an assistant response.
--
--   2. A "newer user message" check: if any user message in the thread
--      was created AFTER p_user_message_id, this device was streaming
--      against a stale context. The response is discarded and the client
--      surfaces a "conversation changed on another device" prompt.
--
-- Returns a jsonb discriminated union:
--   { "conflict": true }
--   { "conflict": false, "message": <messages row as json> }
--
-- security invoker so the caller's RLS session applies - the thread
-- lock and the message insert are both subject to the owner-only
-- policies on threads and messages.
drop function if exists public.add_assistant_message(uuid, uuid, text, text, jsonb, text, jsonb);
create or replace function public.add_assistant_message(
  p_thread_id       uuid,
  p_user_message_id uuid,
  p_content         text,
  p_model           text,
  p_usage           jsonb,
  p_reasoning       text,
  p_citations       jsonb
) returns jsonb
language plpgsql
security invoker
as $$
declare
  v_anchor_ts timestamptz;
  v_msg       record;
begin
  -- Lock the thread to serialize concurrent commit attempts. Two devices
  -- finishing at the same moment would otherwise both see "no conflict"
  -- and both insert, producing a duplicate assistant turn.
  perform id
    from public.threads
    where id = p_thread_id
    for update;

  if not found then
    raise exception 'thread not found or not accessible';
  end if;

  -- Fetch the timestamp of the user message we are responding to.
  -- If it has been deleted we treat that as a conflict rather than
  -- inserting an orphaned assistant row.
  select created_at into v_anchor_ts
    from public.messages
    where id = p_user_message_id;

  if not found then
    return jsonb_build_object('conflict', true);
  end if;

  -- Any user message created AFTER our anchor means a different device
  -- sent a new prompt while we were streaming. Our response was
  -- computed without that context, so we must not commit it.
  if exists (
    select 1 from public.messages
      where thread_id  = p_thread_id
        and role       = 'user'
        and id        != p_user_message_id
        and created_at > v_anchor_ts
  ) then
    return jsonb_build_object('conflict', true);
  end if;

  insert into public.messages
    (thread_id, role, content, model, usage, reasoning, citations)
  values
    (p_thread_id, 'assistant', trim(p_content), p_model, p_usage, p_reasoning, p_citations)
  returning * into v_msg;

  -- Bump updated_at so the thread jumps to the top of the sidebar.
  update public.threads
    set updated_at = now()
    where id = p_thread_id;

  return jsonb_build_object(
    'conflict', false,
    'message',  row_to_json(v_msg)
  );
end;
$$;

-- Bias profile ----------------------------------------------------------
--
-- Per-conversation observations of cognitive biases / System-1
-- heuristics in the user's behavior, written by a background worker
-- agent. Aggregated by the same worker into a per-user, per-bias
-- credible-interval summary (`bias_summary`); the chat-loop reads
-- only the summary cache to inject a "user profile - observed
-- patterns" block into the system prompt when bias evidence clears
-- a tier.
--
-- See docs/dev/bias-profile.md for the math (Beta-Binomial posterior
-- with exponential recency decay, exact 90% one-sided credible
-- interval lower bound) and the surfacing rule. The catalog of bias
-- names is closed and lives in src/lib/bias/catalog.ts; the schema
-- carries `bias text` without an enum check so adding a catalog
-- entry doesn't require a schema change. RLS on every row;
-- everything self-scoped by user_id.

-- Two columns on `threads` carry the worker's processed-state.
-- `bias_processed_at` is when the worker last analyzed this thread;
-- `bias_processed_msg_count` is the user-message count it saw, used
-- as an optimistic-concurrency token (the chat-loop clears these on
-- any new user-message insert, so a stale save from a still-running
-- analysis cycle gets rejected).
alter table public.threads
  add column if not exists bias_processed_at timestamptz;

alter table public.threads
  add column if not exists bias_processed_msg_count int;

-- Per-row claim columns so the worker can lock a thread for the
-- duration of its analysis without preventing other workers (e.g.
-- samskara) from operating on the same thread for their own
-- purposes.
alter table public.threads
  add column if not exists bias_claim_holder text;

alter table public.threads
  add column if not exists bias_claim_expires timestamptz;

-- Snapshot of the bias keys that were rendered into the system
-- prompt on the most recent chat-loop turn against this thread.
-- Overwritten per turn (the chat-loop's `getBiasProfileBlock`
-- writes whatever it just rendered). The worker reads this in its
-- analyze phase so the merged observer/reactor agent knows which
-- biases the user's messages could have been reacting to.
-- Empty array (the default) means "no biases were active" - the
-- reactor pass for this conversation produces no rows.
alter table public.threads
  add column if not exists bias_active_at_turn text[] not null default '{}';

create table if not exists public.bias_observations (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  thread_id uuid not null references public.threads(id) on delete cascade,
  -- Catalog key from src/lib/bias/catalog.ts (e.g. 'confirmation_bias').
  -- No DB-side enum check: the catalog is the source of truth and
  -- adding an entry there is a code change, not a schema change.
  -- The TypeScript ingest validates against the catalog before
  -- insert; an unknown string here would be a code bug, not a data
  -- integrity threat.
  bias text not null,
  -- Post-floor, post-cap. The TypeScript clamp drops sub-floor
  -- observations entirely (the agent's "I am not sure" channel) and
  -- pulls supra-cap observations down to the cap before insert, so
  -- every row that lands satisfies the [0.40, 0.85] range.
  confidence real not null check (confidence between 0.40 and 0.85),
  reasoning text not null,
  -- Soft pointer back to the user message the agent cited. Nullable
  -- because messages can be deleted while observations survive; if
  -- the user removes the cited message we keep the observation
  -- text but lose the deep link.
  evidence_message_id uuid references public.messages(id) on delete set null,
  created_at timestamptz not null default now()
);

create index if not exists bias_observations_thread_idx
  on public.bias_observations (thread_id);

create index if not exists bias_observations_user_bias_idx
  on public.bias_observations (user_id, bias);

alter table public.bias_observations enable row level security;

drop policy if exists "bias observations self-selectable" on public.bias_observations;
create policy "bias observations self-selectable" on public.bias_observations
  for select using (auth.uid() = user_id);

drop policy if exists "bias observations self-insertable" on public.bias_observations;
create policy "bias observations self-insertable" on public.bias_observations
  for insert with check (auth.uid() = user_id);

drop policy if exists "bias observations self-deletable" on public.bias_observations;
create policy "bias observations self-deletable" on public.bias_observations
  for delete using (auth.uid() = user_id);

-- Auto-populate user_id from the session so chat-loop and worker
-- inserts don't need to thread it through. Same pattern as
-- samskara_associations / samskaras.
alter table public.bias_observations
  alter column user_id set default auth.uid();

-- Per-user, per-bias aggregate cache. The worker's aggregate phase
-- recomputes this from the underlying observations + thread
-- metadata; the chat-loop side reads it directly. Eventual
-- consistency: the chat-loop may briefly see a stale row after a
-- new observation lands or a thread's observations get cleared on
-- a new user message - the worker catches up on its next rotation.
create table if not exists public.bias_summary (
  user_id uuid not null references auth.users(id) on delete cascade,
  bias text not null,
  effective_n real not null,
  posterior_alpha real not null,
  posterior_beta real not null,
  posterior_mean real not null,
  ci_lower real not null,
  tier text not null check (tier in ('elided', 'soft', 'strong')),
  computed_at timestamptz not null default now(),
  primary key (user_id, bias)
);

-- Compensation-feedback EMA in [-1, +1] (v2 calibration layer).
-- Recomputed by the worker on every aggregate pass from the
-- bias_reactions rows for this (user, bias). Default 0 on cold
-- start so v1 callers see unshifted thresholds before any
-- reactions land. See src/lib/bias/types.ts for FEEDBACK_* tunables.
alter table public.bias_summary
  add column if not exists feedback_score real not null default 0;

alter table public.bias_summary enable row level security;

drop policy if exists "bias summary self-selectable" on public.bias_summary;
create policy "bias summary self-selectable" on public.bias_summary
  for select using (auth.uid() = user_id);

drop policy if exists "bias summary self-insertable" on public.bias_summary;
create policy "bias summary self-insertable" on public.bias_summary
  for insert with check (auth.uid() = user_id);

drop policy if exists "bias summary self-updatable" on public.bias_summary;
create policy "bias summary self-updatable" on public.bias_summary
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists "bias summary self-deletable" on public.bias_summary;
create policy "bias summary self-deletable" on public.bias_summary
  for delete using (auth.uid() = user_id);

alter table public.bias_summary
  alter column user_id set default auth.uid();

-- Per-conversation per-bias compensation-feedback signal (v2). The
-- merged observer/reactor agent classifies, for each bias that was
-- active in the system prompt during a conversation, whether the
-- user engaged positively with the assistant's compensated phrasing
-- (was_confirmed=true), pushed back on it (was_confirmed=false), or
-- showed no clear signal (was_confirmed=null, neutral). The
-- worker's aggregate phase reads these to compute the per-(user,
-- bias) feedback EMA cached on bias_summary.feedback_score.
--
-- One row per (user, thread, bias) - re-analyzing a thread (which
-- happens whenever a new user message lands; see bias_clear_thread)
-- replaces the prior row via the unique-key upsert in
-- bias_save_reactions.
create table if not exists public.bias_reactions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  thread_id uuid not null references public.threads(id) on delete cascade,
  bias text not null,
  -- true = user affirmed the compensation
  -- false = user pushed back
  -- null = neutral / no clear signal (still recorded so we can tell
  --        "agent looked and saw nothing" from "agent never ran")
  was_confirmed boolean,
  reasoning text not null,
  created_at timestamptz not null default now(),
  unique (user_id, thread_id, bias)
);

create index if not exists bias_reactions_user_bias_idx
  on public.bias_reactions (user_id, bias);

alter table public.bias_reactions enable row level security;

drop policy if exists "bias reactions self-selectable" on public.bias_reactions;
create policy "bias reactions self-selectable" on public.bias_reactions
  for select using (auth.uid() = user_id);

drop policy if exists "bias reactions self-insertable" on public.bias_reactions;
create policy "bias reactions self-insertable" on public.bias_reactions
  for insert with check (auth.uid() = user_id);

drop policy if exists "bias reactions self-deletable" on public.bias_reactions;
create policy "bias reactions self-deletable" on public.bias_reactions
  for delete using (auth.uid() = user_id);

alter table public.bias_reactions
  alter column user_id set default auth.uid();

-- Bias-profile RPCs ------------------------------------------------------
--
-- security invoker throughout - RLS still applies, and the explicit
-- `user_id = auth.uid()` guards inside each function's body keep the
-- intent obvious at the call site.

-- Drop pre-existing signatures before recreating: return-type changes
-- break a plain `create or replace function`. The v1 signatures are
-- listed here too so a sync against a pre-v2 database cleans up the
-- prior shapes before the v2 functions land. New v2 signatures
-- (with the extra parameters / extra return columns) are dropped on
-- their own line so a re-sync against a v2 database is idempotent.
drop function if exists public.bias_claim_next_thread(text, int, uuid[], timestamptz, int);
drop function if exists public.bias_save_observations(uuid, text, int, jsonb);
drop function if exists public.bias_save_observations(uuid, text, int, jsonb, jsonb);
drop function if exists public.bias_clear_thread(uuid);
drop function if exists public.bias_processed_threads_for_bias(text);
drop function if exists public.bias_reactions_for_bias(text);

-- Claim the next eligible thread for bias analysis. Eligibility is
-- the full filter list from docs/dev/bias-profile.md:
--   - belongs to the calling user
--   - has at least p_min_user_messages user messages (default 2)
--   - either never processed, or processed before the thread's most
--     recent update (a new user message bumps threads.updated_at,
--     and chat-loop also clears bias_processed_at directly)
--   - threads.updated_at is BEFORE p_today_start - the caller passes
--     midnight-local-time-today as a UTC instant, so "today" excludes
--     conversations the user might still be actively chatting in
--   - id is not in p_exclude_ids (the worker's "currently open in
--     this app instance" list, gathered by the manager from main-
--     thread messages)
--   - no live claim (claim_holder NULL, or expired, or already ours)
--
-- Atomic claim via update-returning so two workers polling the same
-- candidate set never both win. Returns one row or empty.
create or replace function public.bias_claim_next_thread(
  p_holder_id text,
  p_ttl_seconds int,
  p_exclude_ids uuid[],
  p_today_start timestamptz,
  p_min_user_messages int
)
returns table (
  thread_id uuid,
  user_message_count int,
  -- v2: snapshot of biases that were rendered into the system
  -- prompt on the most recent chat-loop turn for this thread. The
  -- merged observer/reactor agent uses this to know which biases'
  -- compensation behavior the user's messages could have reacted
  -- to. Empty array means "no biases were active" and the reactor
  -- pass produces no rows.
  active_biases text[]
)
security invoker
language plpgsql
as $$
declare
  v_id uuid;
  v_msg_count int;
  v_active_biases text[];
begin
  if auth.uid() is null then
    return;
  end if;

  -- Pick a candidate. We could combine the SELECT and UPDATE via
  -- `update ... where id = (select ...)` but the two-step makes the
  -- "what we picked" debuggable in a SQL editor session.
  select t.id, (
    select count(*)::int from public.messages m
      where m.thread_id = t.id and m.role = 'user'
  ), coalesce(t.bias_active_at_turn, '{}'::text[])
    into v_id, v_msg_count, v_active_biases
    from public.threads t
    where t.user_id = auth.uid()
      and t.updated_at < p_today_start
      and (
        t.bias_processed_at is null
        or t.bias_processed_at < t.updated_at
      )
      and (
        t.bias_claim_holder is null
        or t.bias_claim_expires < now()
        or t.bias_claim_holder = p_holder_id
      )
      and (
        p_exclude_ids is null
        or not (t.id = any(p_exclude_ids))
      )
    -- Defer the user-message count check to a HAVING-style filter
    -- below; computing it inline keeps the index-friendly filters
    -- doing the heavy work.
    order by t.updated_at asc
    limit 1
    for update skip locked;

  if v_id is null then
    return;
  end if;
  if v_msg_count < p_min_user_messages then
    return;
  end if;

  update public.threads
    set bias_claim_holder = p_holder_id,
        bias_claim_expires = now() + make_interval(secs => p_ttl_seconds)
    where id = v_id;

  thread_id := v_id;
  user_message_count := v_msg_count;
  active_biases := v_active_biases;
  return next;
end;
$$;

-- Save the agent's observations AND compensation-feedback reactions
-- for a thread in one transaction. Three guards:
--   - claim is still ours (someone else didn't steal it after TTL)
--   - the user-message count we expected matches what's there now
--     (no new user message landed during analysis - if it did, the
--     observations are based on stale state and we drop them)
--   - the thread still belongs to the calling user (RLS would catch
--     this anyway, but the explicit check keeps the failure path
--     deterministic instead of relying on a 0-row update)
--
-- `p_reactions` is a jsonb array of {bias, was_confirmed, reasoning}
-- objects, where was_confirmed is true/false/null. Empty array is
-- valid and means "the active-bias set was empty so there was
-- nothing to react to" OR "the reactor agent saw no signal". The
-- merged observer/reactor agent emits both arrays from one LLM
-- call so persisting them together keeps observations and
-- reactions in sync.
--
-- Returns true on success, false if any guard fails. Caller treats
-- false as 'work was wasted, drain to next cycle'.
create or replace function public.bias_save_observations(
  p_thread_id uuid,
  p_holder_id text,
  p_expected_msg_count int,
  p_observations jsonb,
  p_reactions jsonb
)
returns boolean
security invoker
language plpgsql
as $$
declare
  v_actual_count int;
  v_obs jsonb;
  v_was_confirmed boolean;
begin
  if auth.uid() is null then
    return false;
  end if;

  -- Claim + ownership + message-count guard, all in one statement.
  -- If any condition fails the SELECT returns no row and we exit.
  perform 1 from public.threads
    where id = p_thread_id
      and user_id = auth.uid()
      and bias_claim_holder = p_holder_id
      and (bias_claim_expires is null or bias_claim_expires > now());
  if not found then
    return false;
  end if;

  select count(*)::int into v_actual_count
    from public.messages
    where thread_id = p_thread_id and role = 'user';
  if v_actual_count <> p_expected_msg_count then
    -- A new user message landed during analysis. The observations
    -- we have are based on a now-stale view of the conversation;
    -- drop them and release the claim so the worker picks the
    -- thread up again on its next scan with the fresh state.
    update public.threads
      set bias_claim_holder = null, bias_claim_expires = null
      where id = p_thread_id;
    return false;
  end if;

  -- Delete any pre-existing observations and reactions for this
  -- thread. A previous analysis cycle's writes get fully replaced;
  -- we don't merge in case the catalog has changed or the agent
  -- changed its mind about the same conversation.
  delete from public.bias_observations
    where thread_id = p_thread_id;
  delete from public.bias_reactions
    where thread_id = p_thread_id;

  -- Insert the new observations, if any. Empty array is a valid
  -- save - it means "the agent processed this thread and found
  -- nothing", which is the correct answer most of the time.
  if jsonb_array_length(p_observations) > 0 then
    for v_obs in select * from jsonb_array_elements(p_observations) loop
      insert into public.bias_observations
        (thread_id, bias, confidence, reasoning, evidence_message_id)
      values (
        p_thread_id,
        v_obs->>'bias',
        (v_obs->>'confidence')::real,
        v_obs->>'reasoning',
        nullif(v_obs->>'evidence_message_id', '')::uuid
      );
    end loop;
  end if;

  -- Insert the new reactions, if any. Each reaction row carries a
  -- was_confirmed that may be null - the reactor agent records
  -- "neutral / no clear signal" as a distinct value from "did not
  -- run" (the absence of a row).
  if jsonb_array_length(p_reactions) > 0 then
    for v_obs in select * from jsonb_array_elements(p_reactions) loop
      -- jsonb -> boolean: explicit cast via text so true/false/null
      -- all round-trip. A missing/non-boolean was_confirmed lands
      -- as null which the EMA correctly treats as "no signal."
      v_was_confirmed := case
        when v_obs->>'was_confirmed' = 'true'  then true
        when v_obs->>'was_confirmed' = 'false' then false
        else null
      end;
      insert into public.bias_reactions
        (thread_id, bias, was_confirmed, reasoning)
      values (
        p_thread_id,
        v_obs->>'bias',
        v_was_confirmed,
        v_obs->>'reasoning'
      )
      on conflict (user_id, thread_id, bias) do update
        set was_confirmed = excluded.was_confirmed,
            reasoning = excluded.reasoning,
            created_at = now();
    end loop;
  end if;

  update public.threads
    set bias_processed_at = now(),
        bias_processed_msg_count = p_expected_msg_count,
        bias_claim_holder = null,
        bias_claim_expires = null
    where id = p_thread_id;

  return true;
end;
$$;

-- Clear a thread's bias-processed state. Called from the chat loop
-- when a new user message lands on a thread that was previously
-- processed: the conversation has new content the worker hasn't
-- seen, so the prior observations are stale. We delete the
-- observations outright (cheaper than tracking "stale" flags) and
-- clear the processed-at so the worker's next scan picks the
-- thread up.
create or replace function public.bias_clear_thread(p_thread_id uuid)
returns void
security invoker
language plpgsql
as $$
begin
  if auth.uid() is null then
    return;
  end if;
  -- Guard ownership before deleting; RLS would too, but the explicit
  -- check keeps the failure path clear.
  delete from public.bias_observations
    where thread_id = p_thread_id and user_id = auth.uid();
  -- v2: also clear reactions. The snapshot column gets reset to
  -- empty - a re-analyze on the next worker pass will see whatever
  -- the chat-loop renders on the next turn.
  delete from public.bias_reactions
    where thread_id = p_thread_id and user_id = auth.uid();
  update public.threads
    set bias_processed_at = null,
        bias_processed_msg_count = null,
        bias_claim_holder = null,
        bias_claim_expires = null,
        bias_active_at_turn = '{}'::text[]
    where id = p_thread_id and user_id = auth.uid();
end;
$$;

-- List processed threads for the aggregation pass. Per-bias caller
-- gets (thread_id, processed_at, p_conv) where p_conv is the
-- within-conversation noisy-OR-collapsed confidence for the
-- specified bias on that thread. The denominator (all processed
-- threads) is the full row set; threads with no observation for
-- this bias get p_conv = 0 so the beta side of the posterior
-- accumulates correctly. The TypeScript side runs the math on this
-- row set - keeps the math in one place (math.ts), with the SQL
-- doing only the grouping and the timestamp join.
create or replace function public.bias_processed_threads_for_bias(p_bias text)
returns table (
  thread_id uuid,
  processed_at timestamptz,
  p_conv real
)
security invoker
language plpgsql
as $$
begin
  if auth.uid() is null then
    return;
  end if;
  return query
    with hits as (
      -- Noisy-OR collapse of multiple same-bias observations on
      -- the same thread: 1 - prod(1 - c_i). The cap to the per-
      -- conversation ceiling happens on the TS side so the cap
      -- value lives in one place; the SQL just emits the raw
      -- noisy-OR.
      select o.thread_id,
             (1.0 - exp(sum(ln(greatest(1.0 - o.confidence, 1e-9))))) ::real as p_conv
        from public.bias_observations o
        where o.user_id = auth.uid() and o.bias = p_bias
        group by o.thread_id
    )
    select t.id, t.bias_processed_at, coalesce(h.p_conv, 0.0)::real
      from public.threads t
      left join hits h on h.thread_id = t.id
      where t.user_id = auth.uid()
        and t.bias_processed_at is not null;
end;
$$;

-- v2 aggregate-phase input. Lists every reaction row for one bias
-- with its age in days. The TypeScript side feeds these into
-- feedbackEMA() to produce the per-(user, bias) score cached on
-- bias_summary.feedback_score. Neutral reactions (was_confirmed is
-- null) are returned alongside the signed ones so the aggregate
-- pass can count them for its own debugging - the math kernel
-- discards them, but the worker logs them.
create or replace function public.bias_reactions_for_bias(p_bias text)
returns table (
  thread_id uuid,
  was_confirmed boolean,
  age_days real,
  created_at timestamptz,
  reasoning text
)
security invoker
language plpgsql
as $$
begin
  if auth.uid() is null then
    return;
  end if;
  return query
    select r.thread_id,
           r.was_confirmed,
           (extract(epoch from (now() - r.created_at)) / 86400.0)::real as age_days,
           r.created_at,
           r.reasoning
      from public.bias_reactions r
      where r.user_id = auth.uid() and r.bias = p_bias
      order by r.created_at desc;
end;
$$;


--
-- Guarded so re-running the script doesn't error on tables that are
-- already members — `alter publication ... add table` has no built-in
-- `if not exists`.
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'threads'
  ) then
    alter publication supabase_realtime add table public.threads;
  end if;
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'messages'
  ) then
    alter publication supabase_realtime add table public.messages;
  end if;
end $$;
