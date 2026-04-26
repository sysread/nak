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
  --
  -- ON CONFLICT DO NOTHING against the (user, cohort, samskara)
  -- unique constraint - belt-and-braces against any future caller
  -- that double-records the same cohort. Today this RPC is called
  -- exactly once per turn from fireSamskaras with a fresh cohort_id
  -- so the conflict can't trip; if a regression introduces a second
  -- call path, the table stays clean instead of growing duplicates.
  insert into public.samskara_fires (
    user_id, samskara_id, thread_id, cohort_id, score
  )
  select v_uid,
         (elem->>'samskara_id')::uuid,
         p_thread_id,
         p_cohort_id,
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

-- Journal (Reflections feature) -----------------------------------------
--
-- Daily-journal surface for the user's reflective content. A background
-- worker (src/lib/agents/journal/) processes threads that have accrued
-- new terminal assistant messages and extracts reflective content into
-- one automatic entry per user per day. The user can also author their
-- own user-sourced entry for the same day; both render together in the
-- daily-view UI. Semantic search is backed by the same embeddings
-- pipeline as memories/threads.
--
-- "Reflections" is the public feature name; the internal code uses
-- `journal` because the existing `reflection` subtree is the memory-
-- extraction agent and the naming would collide.

create table if not exists public.journal_entries (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  -- Day this entry belongs to, in the user's local timezone. Stored as
  -- a plain DATE so queries can range-scan without timezone math. For
  -- automatic entries this is the day the source conversation started
  -- on (NOT the day the worker happened to process it - those drift
  -- when the worker runs idle past midnight or processes a backlog).
  -- For user entries it's whatever date the user picked when composing.
  entry_date date not null,
  -- Who wrote it. 'automatic' rows are owned by the background worker
  -- and are read-only from the UI; 'user' rows are composed by the
  -- signed-in human.
  source text not null check (source in ('automatic', 'user')),
  content text not null,
  -- Free-text topic chips. Array rather than a separate table because
  -- topics are purely presentational; we don't query across users by
  -- topic and the LLM is free to invent new ones per-entry.
  topics text[] not null default array[]::text[],
  -- Single dominant mood/tone for the entry ("anxious", "hopeful",
  -- "frustrated", "reflective"). Nullable because not every entry
  -- carries a clear dominant tone.
  mood text,
  -- First names / identifiers of people mentioned. Same rationale as
  -- topics - no cross-user joins, chips only.
  people text[] not null default array[]::text[],
  -- Source conversation for an automatic entry. NULL for user-authored
  -- entries (they're not pinned to any specific conversation). The
  -- partial-unique index below pins one automatic entry per (user,
  -- thread) so the worker re-running on a thread extends an existing
  -- entry rather than creating duplicates. The journal-delete path
  -- reads this to populate journal_thread_excludes so a deleted
  -- automatic entry doesn't get regenerated from the same conversation.
  thread_id uuid references public.threads(id) on delete set null,
  embedding vector(2048),
  embedding_model text,
  embedding_claim_holder text,
  embedding_claim_expires timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Idempotent migration off the older shape (where each automatic entry
-- merged multiple threads into one row keyed by date). The thread_id
-- column moved inline in the table definition above for fresh
-- installs; existing tables get the same column added here.
alter table public.journal_entries
  add column if not exists thread_id uuid references public.threads(id) on delete set null;

-- Drop the old "one automatic and one user row per day per user"
-- constraint. We now allow multiple automatic entries per day (one per
-- thread the user had a conversation on) and don't constrain user
-- entries either. Per-thread uniqueness for automatic entries lives in
-- the partial-unique index that follows.
alter table public.journal_entries
  drop constraint if exists journal_entries_user_id_entry_date_source_key;

-- One automatic entry per (user, thread). Enforces the worker's
-- "extend a thread's existing entry rather than create a duplicate"
-- contract. The upsert RPC checks `thread_id IS NOT NULL` upstream
-- via a `raise exception`, so the partial-unique predicate stays at
-- just `source = 'automatic'` - matching the ON CONFLICT clause's
-- predicate exactly. Postgres requires the constraint's predicate
-- and the on-conflict clause's predicate to be identical, otherwise
-- it raises "no unique or exclusion constraint matching the ON
-- CONFLICT specification". Drop-and-recreate (idempotent on fresh
-- installs since the drop is `if exists`) so a database that synced
-- the earlier `... and thread_id is not null` predicate gets the
-- corrected one without manual intervention.
drop index if exists public.journal_entries_user_thread_unique;
create unique index if not exists journal_entries_user_thread_unique
  on public.journal_entries (user_id, thread_id)
  where source = 'automatic';

-- Older databases carry a `source_thread_ids uuid[]` column from the
-- one-entry-per-day era. The column has no consumer after the schema
-- moves to per-thread entries, so drop it. `if exists` keeps fresh
-- installs (which never had the column) green.
alter table public.journal_entries
  drop column if exists source_thread_ids;

create index if not exists journal_entries_user_date_idx
  on public.journal_entries (user_id, entry_date desc);

-- Invalidate the embedding whenever the text that produced it changes.
-- Matches the memories pattern: pending = `embedding is null`, claim
-- columns nulled so an in-flight worker save won't land a stale vector
-- (its guard checks `claim_holder = $me and claim_expires > now()` and
-- both fields would otherwise still match).
create or replace function public.clear_journal_embedding_on_change()
  returns trigger language plpgsql as $$
begin
  if new.content is distinct from old.content
     or new.topics  is distinct from old.topics
     or new.mood    is distinct from old.mood then
    new.embedding := null;
    new.embedding_model := null;
    new.embedding_claim_holder := null;
    new.embedding_claim_expires := null;
  end if;
  return new;
end $$;

drop trigger if exists clear_journal_embedding_on_change on public.journal_entries;
create trigger clear_journal_embedding_on_change
  before update on public.journal_entries
  for each row execute function public.clear_journal_embedding_on_change();

alter table public.journal_entries enable row level security;

drop policy if exists "journal_entries are self-selectable" on public.journal_entries;
create policy "journal_entries are self-selectable" on public.journal_entries
  for select using (auth.uid() = user_id);

drop policy if exists "journal_entries are self-insertable" on public.journal_entries;
create policy "journal_entries are self-insertable" on public.journal_entries
  for insert with check (auth.uid() = user_id);

drop policy if exists "journal_entries are self-updatable" on public.journal_entries;
create policy "journal_entries are self-updatable" on public.journal_entries
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists "journal_entries are self-deletable" on public.journal_entries;
create policy "journal_entries are self-deletable" on public.journal_entries
  for delete using (auth.uid() = user_id);

-- Per-user set of threads the journaling worker should skip. Populated
-- whenever the user (via the chat-side journal_delete tool) removes an
-- automatic entry - we add the entry's source_thread_ids here so the
-- next worker cycle doesn't regenerate what the user just deleted.
-- Hard-deleting the row from this table (e.g. from an admin surface) is
-- the only way to re-enroll a thread; we deliberately don't expose a
-- user-facing "clear excludes" button because the delete action is
-- meant to be durable.
create table if not exists public.journal_thread_excludes (
  user_id uuid not null references auth.users(id) on delete cascade,
  thread_id uuid not null references public.threads(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (user_id, thread_id)
);

alter table public.journal_thread_excludes enable row level security;

drop policy if exists "journal_thread_excludes are self-selectable" on public.journal_thread_excludes;
create policy "journal_thread_excludes are self-selectable" on public.journal_thread_excludes
  for select using (auth.uid() = user_id);

drop policy if exists "journal_thread_excludes are self-insertable" on public.journal_thread_excludes;
create policy "journal_thread_excludes are self-insertable" on public.journal_thread_excludes
  for insert with check (auth.uid() = user_id);

drop policy if exists "journal_thread_excludes are self-deletable" on public.journal_thread_excludes;
create policy "journal_thread_excludes are self-deletable" on public.journal_thread_excludes
  for delete using (auth.uid() = user_id);

-- Threads carry a pointer + per-row claim for the journaling worker,
-- independent of the memory-extraction pipeline's last_reflected_msg_id.
-- Both can run concurrently against the same thread; the two pointers
-- advance independently.
alter table public.threads
  add column if not exists last_journaled_msg_id uuid references public.messages(id) on delete set null,
  add column if not exists journal_claim_holder text,
  add column if not exists journal_claim_expires_at timestamptz;

-- The standalone `upsert_journal_automatic_entry` RPC has been
-- replaced by the atomic `upsert_journal_entry_and_mark_thread`
-- below (entry write + pointer-advance in one transaction). Drop
-- the old signatures so a project that synced an earlier shape of
-- the schema doesn't carry a stale function around.
drop function if exists public.upsert_journal_automatic_entry(date, text, text[], text, text[], uuid[]);
drop function if exists public.upsert_journal_automatic_entry(uuid, date, text, text[], text, text[]);

-- Claim the oldest thread that needs journaling. Parallels
-- `claim_next_thread_for_reflection`; the predicate is "terminal
-- assistant message newer than last_journaled_msg_id, not in the
-- user's excludes, has at least two user messages, no activity
-- today in the user's timezone, not currently claimed". The
-- excludes filter is the per-thread "do not journal" switch the
-- delete path writes to. The same-day gate gives the user a
-- chance to keep talking before the journaler grabs the thread -
-- a conversation still receiving turns today is not a settled
-- conversation, and journaling it mid-flow produces an entry
-- that the next cycle has to extend rather than write fresh.
-- threads.updated_at is bumped on every message insert (see
-- supabase.ts:addMessage), so it tracks "most recent activity"
-- without a separate column or correlated subquery.
drop function if exists public.claim_next_thread_for_journal(text, int);
drop function if exists public.claim_next_thread_for_journal(text, int, text);
create or replace function public.claim_next_thread_for_journal(
  p_holder_id text,
  p_ttl_seconds int,
  -- IANA timezone the user has chosen for journaling (Settings ->
  -- Journal -> Day boundary). The cooldown gate buckets activity
  -- against this zone so a conversation last touched at 11pm in
  -- Los Angeles isn't held over by the worker until UTC's clock
  -- agrees. Defaults to UTC so a worker still on the old client
  -- bundle (between schema sync and asset deploy) resolves the
  -- function and degrades to UTC-day cooldown rather than
  -- erroring on "function does not exist".
  p_timezone text default 'UTC'
) returns table (
  thread_id uuid,
  terminal_msg_id uuid,
  title text,
  -- Conversation-start timestamp. The worker converts this into the
  -- user's local timezone and uses it as the entry_date, so an entry
  -- lands on the day the conversation actually happened on - NOT the
  -- day the worker happens to be processing it. Worker idle past
  -- midnight or processing a backlog would otherwise stamp every
  -- entry with the current run-day and clobber prior entries via the
  -- per-thread upsert.
  thread_created_at timestamptz
)
language sql security invoker as $$
  with candidate as (
    select
      t.id as thread_id,
      term.msg_id as terminal_msg_id,
      t.title as title,
      t.created_at as thread_created_at
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
       and term.msg_id is distinct from t.last_journaled_msg_id
       and (t.journal_claim_expires_at is null
            or t.journal_claim_expires_at < now())
       and not exists (
         select 1 from public.journal_thread_excludes e
          where e.user_id = t.user_id
            and e.thread_id = t.id
       )
       and (
         -- Same depth guard as reflection: skip threads that haven't
         -- seen a follow-up user message yet. A one-shot Q&A isn't
         -- enough material to warrant a daily-journal entry.
         select count(*)
           from public.messages m2
          where m2.thread_id = t.id
            and m2.role = 'user'
       ) >= 2
       -- Same-day cooldown. Skip threads whose most recent activity
       -- (any message insert bumps t.updated_at) lands on today's
       -- date in the user's tz. Effect: a thread is eligible to
       -- journal only after it's been quiet for at least one full
       -- calendar day in the user's timezone, which both gives an
       -- in-progress conversation room to finish AND prevents a
       -- thread that keeps getting new turns from being
       -- continuously re-journaled mid-day. Re-journals on later
       -- days still happen via the existing terminal_msg_id !=
       -- last_journaled_msg_id predicate.
       and (t.updated_at at time zone p_timezone)::date
           < (now() at time zone p_timezone)::date
     order by t.updated_at asc
     limit 1
     for update of t skip locked
  )
  update public.threads t
     set journal_claim_holder = p_holder_id,
         journal_claim_expires_at = now() + make_interval(secs => p_ttl_seconds)
    from candidate c
   where t.id = c.thread_id
  returning t.id as thread_id, c.terminal_msg_id, c.title, c.thread_created_at;
$$;

-- Mark the thread journaled IF our claim is still ours. Returns false
-- on claim-lost; caller drops the cycle (any upsert side-effect already
-- landed and will be reconciled by the agent reading the existing
-- automatic row on the next cycle).
drop function if exists public.mark_thread_journaled_if_claimed(uuid, text, uuid);
create or replace function public.mark_thread_journaled_if_claimed(
  p_thread_id uuid,
  p_holder_id text,
  p_msg_id uuid
) returns boolean
language plpgsql security invoker as $$
declare
  updated int;
begin
  update public.threads
     set last_journaled_msg_id = p_msg_id,
         journal_claim_holder = null,
         journal_claim_expires_at = null
   where id = p_thread_id
     and user_id = auth.uid()
     and journal_claim_holder = p_holder_id
     and journal_claim_expires_at > now();
  get diagnostics updated = row_count;
  return updated > 0;
end $$;

-- Atomic write+mark for a worthy worker run. The journaling worker
-- needs the entry's existence and the thread's pointer-advance to
-- happen in lockstep: a successful entry write that fails to advance
-- the pointer would re-process the same conversation next cycle (and
-- write the same entry idempotently, but waste a Venice call); a
-- pointer advance without a successful entry write would orphan the
-- conversation (no row stored, but the worker thinks it's done). An
-- earlier shape of this pipeline split the upsert and the mark into
-- two RPCs which the worker called in sequence, leaving a window
-- between them where one could succeed and the other fail.
--
-- This function does both in a single plpgsql transaction. Postgres
-- runs every function body as a transaction by default; raising any
-- exception (including the explicit one below for claim-lost) rolls
-- back BOTH the upsert and the mark. The result: if the function
-- returns successfully the entry exists AND the pointer advanced;
-- if it raises the entry doesn't exist (rolled back) AND the
-- pointer didn't advance.
--
-- Claim-lost handling: if the mark UPDATE matched zero rows (TTL
-- expired, another holder grabbed the row, the user cleared the
-- claim) we raise an exception so the upsert rolls back. Without
-- this, the agent's content would land in a row owned by whoever
-- holds the claim now, and the original worker would think it
-- succeeded. The other holder will rewrite the entry on its own
-- cycle from its own model run; we don't want this worker's draft
-- to outlive its lease.
drop function if exists public.upsert_journal_entry_and_mark_thread(uuid, text, uuid, date, text, text[], text, text[]);
create or replace function public.upsert_journal_entry_and_mark_thread(
  p_thread_id uuid,
  p_holder_id text,
  p_msg_id uuid,
  p_entry_date date,
  p_content text,
  p_topics text[],
  p_mood text,
  p_people text[]
) returns table (
  id uuid,
  thread_id uuid,
  entry_date date,
  source text,
  content text,
  topics text[],
  mood text,
  people text[],
  created_at timestamptz,
  updated_at timestamptz
)
language plpgsql security invoker as $$
#variable_conflict use_column
declare
  v_uid uuid := auth.uid();
  v_marked int;
begin
  if v_uid is null then
    raise exception 'not authenticated';
  end if;
  if p_thread_id is null then
    raise exception 'thread_id is required for automatic entries';
  end if;

  -- Step 1: upsert the entry. Same shape as
  -- upsert_journal_automatic_entry; kept inline here so the function
  -- body is one self-contained transaction (a SELECT against another
  -- function would still be in the same transaction, but inlining
  -- removes the round-trip-through-CTE shape).
  return query
  insert into public.journal_entries (
    user_id, thread_id, entry_date, source, content, topics, mood, people
  ) values (
    v_uid, p_thread_id, p_entry_date, 'automatic', p_content,
    coalesce(p_topics, array[]::text[]),
    p_mood,
    coalesce(p_people, array[]::text[])
  )
  on conflict (user_id, thread_id) where source = 'automatic' do update
     set content = excluded.content,
         topics  = excluded.topics,
         mood    = excluded.mood,
         people  = excluded.people,
         updated_at = now()
  returning
    public.journal_entries.id,
    public.journal_entries.thread_id,
    public.journal_entries.entry_date,
    public.journal_entries.source,
    public.journal_entries.content,
    public.journal_entries.topics,
    public.journal_entries.mood,
    public.journal_entries.people,
    public.journal_entries.created_at,
    public.journal_entries.updated_at;

  -- Step 2: advance the thread pointer IF our claim is still ours.
  -- Same predicate as `mark_thread_journaled_if_claimed`.
  update public.threads
     set last_journaled_msg_id = p_msg_id,
         journal_claim_holder = null,
         journal_claim_expires_at = null
   where id = p_thread_id
     and user_id = v_uid
     and journal_claim_holder = p_holder_id
     and journal_claim_expires_at > now();
  get diagnostics v_marked = row_count;
  if v_marked = 0 then
    raise exception
      'claim lost on thread % during atomic upsert; rolling back',
      p_thread_id;
  end if;
end $$;

-- Embeddings pipeline RPCs for journal entries. Same claim/save
-- semantics as memories, same 2048-dim padded vectors, same
-- "security invoker" posture letting RLS enforce user scoping.
drop function if exists public.claim_next_pending_journal_entry(text, int);
create or replace function public.claim_next_pending_journal_entry(
  p_holder_id text,
  p_ttl_seconds int
) returns table (id uuid, entry_date date, content text, topics text[], mood text)
language sql security invoker as $$
  with candidate as (
    select je.id
      from public.journal_entries je
     where je.user_id = auth.uid()
       and je.embedding is null
       and (je.embedding_claim_expires is null
            or je.embedding_claim_expires < now())
     order by je.updated_at desc
     limit 1
     for update skip locked
  )
  update public.journal_entries je
     set embedding_claim_holder = p_holder_id,
         embedding_claim_expires = now() + make_interval(secs => p_ttl_seconds)
    from candidate c
   where je.id = c.id
  returning je.id, je.entry_date, je.content, je.topics, je.mood;
$$;

drop function if exists public.save_journal_entry_embedding_if_claimed(uuid, text, vector, text);
create or replace function public.save_journal_entry_embedding_if_claimed(
  p_id uuid,
  p_holder_id text,
  p_embedding vector(2048),
  p_embedding_model text
) returns boolean
language plpgsql security invoker as $$
declare
  updated int;
begin
  update public.journal_entries
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

-- Similarity search RPC. No confidence boost (journal entries don't
-- carry a confidence scalar; they're direct human/agent assertions
-- rather than probabilistic memories). Plain cosine ranking, scoped
-- by RLS + an explicit user_id guard.
drop function if exists public.search_journal_entries_by_embedding(vector, int);
create or replace function public.search_journal_entries_by_embedding(
  query_embedding vector(2048),
  match_limit int
) returns table (
  id uuid,
  entry_date date,
  source text,
  content text,
  topics text[],
  mood text,
  people text[],
  thread_id uuid,
  created_at timestamptz,
  updated_at timestamptz,
  similarity real
)
language sql stable security invoker as $$
  select id, entry_date, source, content, topics, mood, people, thread_id,
         created_at, updated_at,
         (1 - (embedding <=> query_embedding))::real as similarity
    from public.journal_entries
   where user_id = auth.uid()
     and embedding is not null
   order by embedding <=> query_embedding asc
   limit match_limit
$$;

-- Journal spam filter ----------------------------------------------------
--
-- Naive Bayes classifier over the source conversation text, used as a
-- soft hint to the journal agent's worthiness decision. Two signals
-- feed it:
--
--   - Delete on an automatic entry (existing journal_delete tool path)
--     trains the source thread's tokens as `spam`. The thread is
--     already prevented from re-journaling via journal_thread_excludes,
--     so spam training is naturally one-shot per thread.
--   - The ham button on an automatic entry (Journal.svelte) trains the
--     source thread's tokens as `ham`. Ham idempotency is enforced by
--     `journal_entries.ham_marked_at` - once set, the UI disables the
--     button. We do NOT remove ham training when an entry is later
--     deleted; the user said it was a good entry at the moment of
--     marking, and a later delete doesn't retroactively make that wrong.
--
-- The classifier itself runs in the journal worker and main thread (for
-- training). Tokens are pre-stemmed (Snowball English) before storage
-- so the same word in different inflections shares a row. The model is
-- per-user, RLS-scoped.

create table if not exists public.journal_spam_tokens (
  user_id uuid not null references auth.users(id) on delete cascade,
  -- Lowercased + stemmed token. The stemmer must match between train
  -- and score paths or rows will never join with new conversations.
  token text not null,
  ham_count int not null default 0,
  spam_count int not null default 0,
  primary key (user_id, token)
);

alter table public.journal_spam_tokens enable row level security;

drop policy if exists "journal_spam_tokens are self-selectable" on public.journal_spam_tokens;
create policy "journal_spam_tokens are self-selectable" on public.journal_spam_tokens
  for select using (auth.uid() = user_id);

-- Writes go through the train_journal_spam RPC (which uses
-- auth.uid()), so insert/update policies just enforce the same
-- self-scoping the RPC already imposes.
drop policy if exists "journal_spam_tokens are self-insertable" on public.journal_spam_tokens;
create policy "journal_spam_tokens are self-insertable" on public.journal_spam_tokens
  for insert with check (auth.uid() = user_id);

drop policy if exists "journal_spam_tokens are self-updatable" on public.journal_spam_tokens;
create policy "journal_spam_tokens are self-updatable" on public.journal_spam_tokens
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- Per-user totals. Used as Naive Bayes priors and as the cold-start
-- gate (worker suppresses the hint while either total is below
-- threshold so the LLM doesn't try to interpret meaningless scores).
create table if not exists public.journal_spam_stats (
  user_id uuid primary key references auth.users(id) on delete cascade,
  -- Number of conversations the user has marked as ham (good entry).
  ham_total int not null default 0,
  -- Number of conversations the user has marked as spam (deleted entry).
  spam_total int not null default 0,
  updated_at timestamptz not null default now()
);

alter table public.journal_spam_stats enable row level security;

drop policy if exists "journal_spam_stats are self-selectable" on public.journal_spam_stats;
create policy "journal_spam_stats are self-selectable" on public.journal_spam_stats
  for select using (auth.uid() = user_id);

drop policy if exists "journal_spam_stats are self-insertable" on public.journal_spam_stats;
create policy "journal_spam_stats are self-insertable" on public.journal_spam_stats
  for insert with check (auth.uid() = user_id);

drop policy if exists "journal_spam_stats are self-updatable" on public.journal_spam_stats;
create policy "journal_spam_stats are self-updatable" on public.journal_spam_stats
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- Idempotency marker for the ham button. Set once when the user
-- marks an automatic entry as appropriate; the UI hides the button
-- after the first click. Nullable - most entries never get marked.
alter table public.journal_entries
  add column if not exists ham_marked_at timestamptz null;

-- Train the per-user Bayesian model. Atomic across the token rows
-- and the totals row - both updates land in the same transaction so
-- a partial training failure leaves the model untouched. Tokens are
-- expected pre-stemmed and lowercased; the function does no
-- normalization of its own.
drop function if exists public.train_journal_spam(text[], text);
create or replace function public.train_journal_spam(
  p_tokens text[],
  p_label text
) returns void
language plpgsql security invoker as $$
declare
  v_user_id uuid := auth.uid();
  v_ham int := case when p_label = 'ham' then 1 else 0 end;
  v_spam int := case when p_label = 'spam' then 1 else 0 end;
begin
  if v_user_id is null then
    raise exception 'not authenticated';
  end if;
  if p_label not in ('ham', 'spam') then
    raise exception 'invalid label: %', p_label;
  end if;
  if p_tokens is null or array_length(p_tokens, 1) is null then
    -- Empty token list: still bump the stats row so the prior
    -- shifts correctly even if the conversation tokenized to nothing.
    insert into public.journal_spam_stats (user_id, ham_total, spam_total, updated_at)
    values (v_user_id, v_ham, v_spam, now())
    on conflict (user_id) do update set
      ham_total = public.journal_spam_stats.ham_total + v_ham,
      spam_total = public.journal_spam_stats.spam_total + v_spam,
      updated_at = now();
    return;
  end if;

  insert into public.journal_spam_tokens as t (user_id, token, ham_count, spam_count)
  select v_user_id, tk, v_ham, v_spam
    from unnest(p_tokens) as tk
  on conflict (user_id, token) do update set
    ham_count = t.ham_count + v_ham,
    spam_count = t.spam_count + v_spam;

  insert into public.journal_spam_stats (user_id, ham_total, spam_total, updated_at)
  values (v_user_id, v_ham, v_spam, now())
  on conflict (user_id) do update set
    ham_total = public.journal_spam_stats.ham_total + v_ham,
    spam_total = public.journal_spam_stats.spam_total + v_spam,
    updated_at = now();
end $$;

-- Reverse a previous train_journal_spam call. Decrements the per-
-- token counts AND the per-user totals row, floored at zero so an
-- imbalance (caller untrains a label that wasn't trained, a token
-- count that's already zero) can't push the numbers negative.
--
-- Why this exists: the user can mark an automatic entry as ham
-- (the "Looks good" button) and then later delete it. Without an
-- untrain step, the same conversation's tokens would contribute
-- +1 ham AND +1 spam, polluting both sides of the model. The
-- delete path calls untrain(ham) before train(spam) so the net
-- effect is a clean -ham/+spam shift on the conversation's
-- vocabulary.
drop function if exists public.untrain_journal_spam(text[], text);
create or replace function public.untrain_journal_spam(
  p_tokens text[],
  p_label text
) returns void
language plpgsql security invoker as $$
declare
  v_user_id uuid := auth.uid();
  v_ham int := case when p_label = 'ham' then 1 else 0 end;
  v_spam int := case when p_label = 'spam' then 1 else 0 end;
begin
  if v_user_id is null then
    raise exception 'not authenticated';
  end if;
  if p_label not in ('ham', 'spam') then
    raise exception 'invalid label: %', p_label;
  end if;

  if p_tokens is not null and array_length(p_tokens, 1) is not null then
    update public.journal_spam_tokens
       set ham_count = greatest(0, ham_count - v_ham),
           spam_count = greatest(0, spam_count - v_spam)
     where user_id = v_user_id
       and token = any(p_tokens);

    -- Garbage-collect rows that lost their last evidence in either
    -- class. Otherwise the table accumulates zero-rows for every
    -- token the user once labeled and later untrained. Doesn't
    -- touch rows that still carry evidence in the OTHER class -
    -- those are still load-bearing for scoring.
    delete from public.journal_spam_tokens
     where user_id = v_user_id
       and token = any(p_tokens)
       and ham_count = 0
       and spam_count = 0;
  end if;

  update public.journal_spam_stats
     set ham_total = greatest(0, ham_total - v_ham),
         spam_total = greatest(0, spam_total - v_spam),
         updated_at = now()
   where user_id = v_user_id;
end $$;

-- Score lookup. Returns one row per matched token plus the user's
-- totals (replicated on every row, since callers compute Naive Bayes
-- in JS and need both pieces). Empty result means either no tokens
-- matched the user's vocabulary or the user has no training data
-- yet - the caller distinguishes via the totals.
drop function if exists public.score_journal_spam(text[]);
create or replace function public.score_journal_spam(
  p_tokens text[]
) returns table (
  token text,
  ham_count int,
  spam_count int,
  ham_total int,
  spam_total int
)
language sql stable security invoker as $$
  with stats as (
    select coalesce(s.ham_total, 0) as ham_total,
           coalesce(s.spam_total, 0) as spam_total
      from (select 1) d
      left join public.journal_spam_stats s on s.user_id = auth.uid()
  )
  select t.token, t.ham_count, t.spam_count, stats.ham_total, stats.spam_total
    from public.journal_spam_tokens t, stats
   where t.user_id = auth.uid()
     and t.token = any(p_tokens)
$$;

-- Standalone stats lookup. Used by the worker to apply the
-- cold-start gate before bothering to tokenize and call
-- score_journal_spam (saves a round-trip when the model is empty)
-- and by the UI if it ever wants to surface "trained on N
-- conversations" copy.
drop function if exists public.get_journal_spam_stats();
create or replace function public.get_journal_spam_stats()
returns table (ham_total int, spam_total int)
language sql stable security invoker as $$
  select coalesce(s.ham_total, 0)::int, coalesce(s.spam_total, 0)::int
    from (select 1) d
    left join public.journal_spam_stats s on s.user_id = auth.uid()
$$;

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
