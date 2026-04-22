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

-- Per-thread master switch for tool availability. When false, only the
-- always-on `toggle_tools` meta-tool is sent with the request; when true,
-- every registered tool's schema is included. The LLM can flip this via
-- `toggle_tools`, or the user can flip it from the composer toolbox button.
alter table public.threads
  add column if not exists tools_enabled boolean not null default false;

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
-- No embedding column: a personal cookbook is small (tens to low
-- hundreds of rows). ILIKE on `title` is fast enough and keeps us off
-- the embeddings worker's critical path. If cookbook sizes grow past a
-- few hundred rows, the escape hatch mirrors memories exactly — add
-- vector(2048) + claim columns + the same RPC shape.

create table if not exists public.recipes (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  title text not null,
  source text,
  source_url text,
  cooklang text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists recipes_user_updated_idx
  on public.recipes (user_id, updated_at desc);

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
drop function if exists public.search_memories_by_embedding(vector, int);
create or replace function public.search_memories_by_embedding(
  query_embedding vector(2048),
  match_limit int
) returns table (
  id uuid,
  label text,
  data text,
  created_at timestamptz,
  updated_at timestamptz
)
language sql stable security invoker as $$
  select id, label, data, created_at, updated_at
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
-- message, if last_reflected_msg_id is null). The token-volume guard
-- (~6400 chars ≈ 20% of the fast model's 8192-token embedding context)
-- keeps us from burning Venice calls on "hi"/"hey" exchanges that
-- produced nothing worth remembering.
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
         -- Sum of all message content in the thread (user + assistant
         -- + tool) — generous proxy for conversation volume. ~6400
         -- chars ≈ 20% of 8192-token embedding-model context.
         select coalesce(sum(length(m2.content)), 0)
           from public.messages m2
          where m2.thread_id = t.id
       ) >= 6400
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
  -- preserve. The fire RPC ranks by cosine * sqrt(health *
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
  -- The cosine * sqrt(health * confidence) ranking score at fire
  -- time. Kept for analytics — useful when a debugging session asks
  -- "why did this samskara fire here?".
  score real not null,
  was_confirmed boolean
);

create index if not exists samskara_fires_user_recent_idx
  on public.samskara_fires (user_id, fired_at desc);

create index if not exists samskara_fires_cohort_idx
  on public.samskara_fires (cohort_id);

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

-- Top-K fire query. Ranks by cosine * sqrt(health * confidence) so
-- weak-but-relevant samskaras can break through against strong-but-
-- distant ones. Returns enough columns for the priming formatter to
-- render without a follow-up SELECT.
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
  --   - cosine similarity (1 - distance) — semantic relevance to the
  --     user's current message
  --   - sqrt(health * confidence) — softens both axes so a strong-
  --     but-distant samskara can't crush a weak-but-relevant one
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
           (1 - (s.prediction_embedding <=> p_query_embedding))
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
drop function if exists public.samskara_record_fires(uuid, uuid, jsonb);
create or replace function public.samskara_record_fires(
  p_cohort_id uuid,
  p_thread_id uuid,
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
  insert into public.samskara_fires (
    user_id, samskara_id, thread_id, cohort_id, score
  )
  select v_uid,
         (elem->>'samskara_id')::uuid,
         p_thread_id,
         p_cohort_id,
         (elem->>'score')::real
    from jsonb_array_elements(p_fires) as elem;
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

-- Realtime subscriptions --------------------------------------------------
--
-- The client subscribes to INSERTs on `messages` (filtered by thread_id)
-- and all CUD on `threads` (filtered by user_id) so a conversation open
-- on two devices stays in sync without polling. Supabase ships with the
-- `supabase_realtime` publication pre-created; we just opt in the two
-- tables that carry conversation state.
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
