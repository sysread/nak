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

-- Per-thread master switch for tool availability. When false, only the
-- always-on `toggle_tools` meta-tool is sent with the request; when true,
-- every registered tool's schema is included. The LLM can flip this via
-- `toggle_tools`, or the user can flip it from the composer toolbox button.
alter table public.threads
  add column if not exists tools_enabled boolean not null default false;

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
  add column if not exists embedding_claim_expires timestamptz;

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
   order by embedding <=> query_embedding
   limit match_limit
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
