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
--   grocery_products / grocery_list_entries / grocery_sections
--                                       the grocery list (user-driven UI only)
--
-- All tables have Row Level Security enabled so an authenticated user
-- can only access rows they own. The publishable key the browser uses
-- is safe to expose provided RLS policies stay in place.

create extension if not exists pgcrypto;
-- pgvector backs every embedding column (vector(2048)) further down. It
-- must be created before its first use - hosted Supabase enables it by
-- default so a cloud re-apply never noticed, but a clean apply against a
-- fresh database (e.g. the local dev stack) fails with `type "vector"
-- does not exist` unless the extension exists first.
create extension if not exists vector;

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

-- handle_new_user runs only via the trigger above, executing as the
-- table owner; nothing invokes it as an RPC. Living in the public
-- schema otherwise grants anon/authenticated a default EXECUTE that
-- PostgREST exposes at /rest/v1/rpc/handle_new_user - inert (it
-- references the trigger pseudo-record `new` and errors out of
-- trigger context) but a flagged surface. Revoke it to match the
-- definer-lockdown convention used elsewhere in this file.
revoke all on function public.handle_new_user() from public, anon, authenticated;

-- Atomic merge of a settings patch into profiles.settings. The browser
-- side (SupabaseService.updateSettings) builds a validated patch of the
-- top-level keys it wants to set plus a list of keys to drop, and this
-- function applies both in a single UPDATE against the live row.
--
-- Why this exists: the old write path read the whole jsonb blob, merged
-- one key in JS, and wrote the blob back. Two overlapping writes - e.g.
-- flipping the two adjacent AI-pane toggles in quick succession, or a
-- fire-and-forget theme write racing a toggle - both read the
-- pre-write blob, so the second write clobbered the first's change. The
-- symptom was a setting that silently reverted now and then with no
-- repeatable pattern, because it depended on the timing of two writes
-- landing inside one Supabase round-trip. Doing the merge in one
-- statement removes the read-then-write window for same-tab AND
-- cross-tab concurrency.
--
-- `p_set` is shallow-merged over the current settings via `||`, so a
-- top-level key replaces wholesale - exactly right for the nested
-- values (tierModels, systemPrompts) the app treats as atomic
-- snapshots. `p_remove` lists keys to delete (the caller sends these
-- for "user cleared this field" and the legacy journalTimezone
-- cleanup). Removal runs before the merge so the intent stays
-- unambiguous if a key ever appeared in both. Returns the merged blob
-- so the client can coerce it and adopt the canonical shape.
--
-- security invoker so the profiles RLS update policy (auth.uid() =
-- user_id) scopes the write to the caller's own row; the explicit
-- auth.uid() guard turns an unauthenticated call into a clear error
-- rather than a silent zero-row no-op.
drop function if exists public.merge_profile_settings(jsonb, text[]);
create or replace function public.merge_profile_settings(p_set jsonb, p_remove text[])
returns jsonb
language plpgsql security invoker as $$
declare
  v_user uuid := auth.uid();
  v_settings jsonb;
begin
  if v_user is null then
    raise exception 'merge_profile_settings: not authenticated'
      using errcode = '28000';
  end if;
  update public.profiles
     set settings = (coalesce(settings, '{}'::jsonb) - coalesce(p_remove, '{}'::text[]))
                    || coalesce(p_set, '{}'::jsonb)
   where user_id = v_user
   returning settings into v_settings;
  return v_settings;
end $$;

-- app_config -------------------------------------------------------------
--
-- Project-global configuration shared by every member of this Supabase
-- project - NOT keyed to a user. One Venice API key serves the owner and
-- anyone they invite (for example a family member on a separate account
-- but the same project), so both the embeddings edge function and the
-- browser read the single shared key from here instead of each user
-- supplying their own. See
-- docs/dev/in-progress/venice-edge-functions/ for the broader plan.
--
-- Singleton table: `id boolean primary key default true` plus the
-- `check (id)` constraint permits only the value true, so the table holds
-- at most one row and every upsert targets it via `on conflict (id)`.
-- Seeded by the config editor in `mise run supabase-init`
-- (scripts/setup-supabase.mjs).
create table if not exists public.app_config (
  id boolean primary key default true,
  venice_api_key text,
  updated_at timestamptz not null default now(),
  constraint app_config_singleton check (id)
);

-- Project-wide model price ceilings. The text caps (max_input_usd_per_m /
-- max_output_usd_per_m) are USD per 1,000,000 tokens; the image cap
-- (max_image_usd) is flat USD per generated image. A model whose live
-- Venice price exceeds the matching ceiling is rejected by the venice edge
-- function (and hidden from the Settings picker). 0 means "no limit" - the
-- sentinel is 0, not null, so the column always carries a value. Defaults
-- are a deliberate secure-by-default cap (input $3.00 / output $8.50 per 1M
-- tokens; image $0.10 per image); the owner raises, lowers, or zeroes them
-- via `mise run setup` (service role, same as venice_api_key above - there
-- is no in-app editor and no write policy). Columns on the singleton rather
-- than a new table, per the "columns over migrations" convention.
--
-- The four statements per column are the idempotent path to NOT NULL with
-- a default on a table that may already hold the column as nullable: add
-- (nullable) if missing, backfill any nulls to the default, pin the
-- default, then enforce NOT NULL (which is safe only once no nulls remain).
alter table public.app_config
  add column if not exists max_input_usd_per_m numeric;
alter table public.app_config
  add column if not exists max_output_usd_per_m numeric;
alter table public.app_config
  add column if not exists max_image_usd numeric;
update public.app_config set max_input_usd_per_m = 3.00 where max_input_usd_per_m is null;
update public.app_config set max_output_usd_per_m = 8.50 where max_output_usd_per_m is null;
update public.app_config set max_image_usd = 0.10 where max_image_usd is null;
alter table public.app_config alter column max_input_usd_per_m set default 3.00;
alter table public.app_config alter column max_output_usd_per_m set default 8.50;
alter table public.app_config alter column max_image_usd set default 0.10;
alter table public.app_config alter column max_input_usd_per_m set not null;
alter table public.app_config alter column max_output_usd_per_m set not null;
alter table public.app_config alter column max_image_usd set not null;

alter table public.app_config enable row level security;

-- RLS diverges from the per-user sibling tables on purpose. Every other
-- table isolates rows with `auth.uid() = user_id`; app_config is shared,
-- so any *authenticated* member may read it (anon, where auth.uid() is
-- null, may not). There is intentionally NO insert/update/delete policy:
-- writes happen only through the service role - `mise run supabase-init`
-- via the Management API, and later the edge function - which bypasses RLS.
-- A missing write policy here is deliberate, not an oversight.
drop policy if exists "app_config is readable by authenticated users" on public.app_config;
create policy "app_config is readable by authenticated users" on public.app_config
  for select using (auth.uid() is not null);

-- model_feature_rejections -----------------------------------------------

-- Persistent memory of optional wire features a model's backend rejects
-- with strict validation. Some Venice model backends (GLM 5.x was the
-- first observed) 400 the whole request with "Extra inputs are not
-- permitted, field: 'X'" for optional body fields other backends
-- silently ignore, and the Venice models endpoint exposes no capability
-- flag to gate on. The venice edge function discovers a rejection at
-- runtime (strip-and-retry in getStreamingCompletion), records it here,
-- and strips known-rejected features from future request bodies before
-- they go to Venice - so the failing round-trip is paid once ever per
-- model+feature, not once per turn. The browser reads the table to
-- disable the matching controls in Settings -> Model profiles.
--
-- `feature` holds the wire FIELD name ('text' for the text.verbosity
-- knob), not a product-feature label - the UI owns the field-to-control
-- mapping. Rows are provider facts, not user data, so the table is
-- global (no user_id). Staleness is accepted the same way profile
-- capability snapshots accept it: if a backend later adds support, the
-- row keeps the feature off until deleted by hand; discovered_at is
-- there to make that cleanup legible.
create table if not exists public.model_feature_rejections (
  model_id text not null,
  feature text not null,
  discovered_at timestamptz not null default now(),
  primary key (model_id, feature)
);

alter table public.model_feature_rejections enable row level security;

-- Same RLS shape as app_config: any authenticated member may read (the
-- Settings gating needs it); there is intentionally NO insert/update/
-- delete policy - writes happen only through the service role in the
-- venice edge function, which bypasses RLS.
drop policy if exists "model_feature_rejections readable by authenticated users" on public.model_feature_rejections;
create policy "model_feature_rejections readable by authenticated users" on public.model_feature_rejections
  for select using (auth.uid() is not null);

-- threads ----------------------------------------------------------------

create table if not exists public.threads (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  title text not null default 'New conversation',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Optional per-thread model-profile pin. Null means "track the user's
-- default profile". The app stores a model-profile id (see ModelProfile in
-- src/lib/models; profiles live in profiles.settings.modelProfiles) and
-- resolves it to a concrete Venice model id at send-time. Older rows may
-- still carry a pre-profile tier name ('smart' | 'balanced' | 'fast');
-- resolution maps any unknown id to the default profile, so no data
-- migration was needed. No CHECK constraint on purpose — garbage values
-- are scrubbed by the app on read.
alter table public.threads
  add column if not exists model text;

-- Optional per-thread thinking-level override ('off' | 'low' | 'medium' |
-- 'high'). 'off' maps to venice_parameters.disable_thinking; the rest map to
-- reasoning_effort (see ThinkingLevel in src/lib/models). Null means "use the
-- model profile's default reasoning level". Column keeps the
-- reasoning_effort name for storage-compat. Plain text / no CHECK for the
-- same reason as `model` above: garbage is scrubbed by the app on read, and
-- we want stored rows to survive a future provider change (such as adding
-- 'off') without a schema migration.
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

-- Rechunk bookkeeping for public.thread_chunks (see that table below).
-- last_chunked_msg_id is the newest message the chunk rows were built
-- from; a thread re-qualifies for rechunking when its newest message
-- differs. Same claim-column shape as every other per-row work queue
-- in this file.
alter table public.threads
  add column if not exists last_chunked_msg_id uuid,
  add column if not exists chunk_claim_holder text,
  add column if not exists chunk_claim_expires timestamptz,
  -- Which revision of the chunk RENDERER produced the current rows.
  -- Message-driven invalidation cannot see a change to the rendering
  -- rules, so without this a change to what gets indexed would leave
  -- every already-chunked thread on the old shape forever. Default 0
  -- so pre-existing rows read as stale and re-chunk once.
  -- See CHUNK_RENDER_VERSION in _shared/thread-transcript.ts.
  add column if not exists chunk_render_version int not null default 0;

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

-- thread_chunks -----------------------------------------------------------
--
-- Embedding-sized slices of a thread's transcript, many rows per thread.
-- This is what makes conversation_search able to match on what the user
-- actually wrote. Threads previously carried a single vector over
-- `title + summary` (2000 chars), so a thread auto-titled
-- "Bread Recipe Modification Advice" was unfindable by searching for
-- "lentils" despite that word opening its first message.
--
-- Why many rows instead of one richer thread vector: averaging a
-- 107-message thread into a single embedding yields a centroid close to
-- nothing in particular - any one topic is a few percent of its
-- direction and still will not rank. Chunks are ranked individually and
-- aggregated back to a thread on the SIMILARITY SCORES at query time
-- (search_thread_chunks_by_embedding below), never by combining
-- vectors.
--
-- Rows are derived data, rebuilt by the rechunk unit from the messages
-- themselves - safe to delete wholesale, they regenerate. The chunker
-- (supabase/functions/_shared/thread-transcript.ts) packs greedily from
-- the first message, which makes chunk_index stable as a thread grows:
-- appending rewrites only the last partial chunk.
create table if not exists public.thread_chunks (
  id uuid primary key default gen_random_uuid(),
  thread_id uuid not null references public.threads(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  -- 0-based position within the thread. Unique per thread, and stable
  -- across appends by construction (see the chunker's greedy packing).
  chunk_index int not null,
  content text not null,
  -- Message range this chunk covers, for anchoring a passage fetch back
  -- to the transcript. Deliberately NOT foreign keys: a chunk is a
  -- snapshot, and a deleted message should leave a stale anchor to be
  -- rebuilt on the next rechunk rather than cascade-deleting a row the
  -- rechunk unit is about to rewrite anyway.
  start_msg_id uuid,
  end_msg_id uuid,
  embedding vector(2048),
  embedding_model text,
  embedding_claim_holder text,
  embedding_claim_expires timestamptz,
  created_at timestamptz not null default now(),
  unique (thread_id, chunk_index)
);

-- Covers both the rechunk unit's per-thread replace and the search
-- RPC's join back from a chunk hit to its thread.
create index if not exists thread_chunks_thread_idx
  on public.thread_chunks (thread_id, chunk_index);

-- The embed backfill claims on `embedding is null`; this keeps that
-- scan off a sequential read as the table grows.
create index if not exists thread_chunks_pending_embed_idx
  on public.thread_chunks (user_id)
  where embedding is null;

-- No HNSW/ivfflat index on embedding, for the same reason as
-- public.memories: exact scan is correct at this corpus size and an
-- approximate index silently changes recall.

alter table public.thread_chunks enable row level security;

-- Read-only to the owner. Writes go exclusively through the
-- service-role RPCs below (the rechunk unit and the embed backfill), so
-- there is deliberately no self-insert/update/delete policy - a client
-- has no business hand-editing derived rows.
drop policy if exists "thread chunks are self-selectable" on public.thread_chunks;
create policy "thread chunks are self-selectable" on public.thread_chunks
  for select using (auth.uid() = user_id);

-- messages ---------------------------------------------------------------

create table if not exists public.messages (
  id uuid primary key default gen_random_uuid(),
  thread_id uuid not null references public.threads(id) on delete cascade,
  role text not null check (role in ('system', 'user', 'assistant')),
  content text not null,
  created_at timestamptz not null default now()
);

-- Per-thread transcript reads are served by the unique
-- (thread_id, position) index in the "Explicit per-thread message
-- ordering" section below, which doubles as the thread_id lookup
-- index for this table.

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

-- The only writer that needs UPDATE access on messages is the ask_user
-- suspend/resume path (src/lib/tools/ask_user.ts +
-- src/lib/supabase.ts updateToolMessageContent): the chat-loop writes a
-- pending sentinel into a role='tool' row's content when the model
-- calls ask_user, and the UI rewrites that content to the real answer
-- payload (or an abandonment marker) when the user submits.
--
-- Scoped to role='tool' rows specifically so a buggy or compromised
-- client cannot use this policy to rewrite assistant or user content -
-- those rows remain immutable from the client. Thread ownership gates
-- access the same way the other messages policies do.
drop policy if exists "messages are self-updatable for tool answers" on public.messages;
create policy "messages are self-updatable for tool answers" on public.messages
  for update using (
    role = 'tool'
    and exists (
      select 1 from public.threads t
      where t.id = messages.thread_id and t.user_id = auth.uid()
    )
  ) with check (
    role = 'tool'
    and exists (
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

-- Assistant-row lifecycle status. Meaningful only for role='assistant'
-- rows written by the streaming chat edge function; null on every other
-- row (user, system, tool) and on pre-migration assistant rows where the
-- concept did not exist. The function creates a row with status='streaming'
-- at the first content delta, UPDATEs its content on a debounced cadence
-- as deltas arrive, and transitions to a terminal value when the round
-- chain finishes.
--
--   'streaming'              row is currently being written by the function
--   'complete'               terminal: round chain finished normally
--   'aborted'                terminal: client published a cancel signal
--                            on the thread:<id>:control channel
--   'error'                  terminal: the function gave up on an
--                            unrecoverable error and persisted what it had
--   'suspended_for_ask_user' terminal-for-now: the ask_user tool returned
--                            its pending sentinel. A fresh /stream
--                            invocation creates a new assistant row when
--                            the user submits an answer.
--
-- Render queries default to showing all statuses. Clients reading a
-- status='streaming' row treat its content column as the completed-so-far
-- buffer for resume; the live deltas continue arriving over Broadcast.
alter table public.messages
  add column if not exists status text;

alter table public.messages drop constraint if exists messages_status_check;
alter table public.messages
  add constraint messages_status_check
  check (
    status is null
    or status in (
      'streaming',
      'complete',
      'aborted',
      'error',
      'suspended_for_ask_user',
      'draft'
    )
  );

-- The streaming-probe partial index lives in the "Explicit per-thread
-- message ordering" section below (it indexes the position column,
-- which must exist first).

-- Explicit per-thread message ordering ------------------------------------
--
-- Transcript order within a thread is decided by `position`, not
-- `created_at`. Two different clocks write created_at (the browser for
-- user rows, the edge function for assistant/tool rows), and the two
-- code paths that used to forge timestamps to control ordering (the
-- recovery-row persistence and the streaming row's move-to-tail) now
-- set position instead. created_at stays as honest display metadata
-- and for wall-clock comparisons (day-gates, staleness checks) - every
-- remaining within-thread `order by created_at` in this file carries a
-- wall-clock comment naming why, enforced by a guardrail test.
--
-- Numeric on purpose: the recovery path heals mid-transcript gaps by
-- inserting at fractional midpoints between neighbors. Never assume
-- integer positions.
alter table public.messages
  add column if not exists position numeric;

-- Backfill NULL positions per thread in (created_at, id) order. This
-- statement is a PERMANENT sweeper, not a one-shot migration: the file
-- re-applies start-to-finish on every deploy, and NULL stragglers are
-- real - within a single apply there is a window between this
-- statement and the trigger's creation where a concurrent insert lands
-- with a NULL position (the unique index below admits NULLs), and a
-- backup restore runs its data apply with triggers disabled (replica
-- role), landing every restored row as NULL.
--
-- The offset MUST come from the max over ALL of a thread's rows,
-- computed in its own CTE. Folding the max into the NULL-filtered
-- subquery would aggregate over only the NULL rows, coalesce to 0,
-- assign positions starting at 1, collide with the unique index, and
-- fail every schema apply from then on - a deploy-blocking landmine.
-- Both guards (NULL-only idempotence, per-thread-max offset) are also
-- what keeps restoring a pre-position backup archive safe; weakening
-- either silently breaks older-archive restores.
with thread_max as (
  select thread_id, coalesce(max(position), 0) as mx
    from public.messages group by thread_id
), null_ranked as (
  select m.id,
         tm.mx + row_number() over (
           partition by m.thread_id
           -- legacy order: rows without positions predate the column
           -- (or bypassed the trigger); their transcript order IS
           -- their created_at order, id as the deterministic tiebreak.
           order by m.created_at, m.id
         ) as new_pos
    from public.messages m
    join thread_max tm on tm.thread_id = m.thread_id
   where m.position is null
)
update public.messages m
   set position = nr.new_pos
  from null_ranked nr
 where m.id = nr.id;

-- Assign the tail position at insert when the caller didn't provide
-- one. A caller-provided position passes through untouched - the
-- recovery path depends on this, inserting at fractional midpoints
-- that a tail assignment would clobber.
--
-- The thread-row lock serializes concurrent appenders on the same
-- thread: without it, two inserts read the same max and collide on the
-- unique index. This is NEW contention the trigger introduces, not a
-- lock writers already held (the edge function's round persistence
-- only touches messages, and the browser updates the thread row in a
-- separate call after its insert). Two writers on one thread take
-- turns; different threads never contend; insert transactions are
-- short.
--
-- Runs as the inserting role (not security definer): the browser's
-- `authenticated` role can take the FOR UPDATE lock because thread
-- ownership grants it UPDATE via RLS, and its max() scan sees every
-- row of its own thread through the messages select policy.
--
-- floor() so a fractional tail (a recovery row healed at the end of a
-- transcript) still yields the next whole integer above it.
create or replace function public.assign_message_position()
returns trigger
language plpgsql as $$
begin
  if new.position is not null then
    return new;
  end if;
  perform 1 from public.threads t where t.id = new.thread_id for update;
  select coalesce(floor(max(m.position)), 0) + 1
    into new.position
    from public.messages m
   where m.thread_id = new.thread_id;
  return new;
end $$;

drop trigger if exists messages_assign_position on public.messages;
create trigger messages_assign_position
  before insert on public.messages
  for each row execute function public.assign_message_position();

-- Unique per-thread ordering; also the per-thread transcript index
-- (thread_id prefix + position range scan, forward or backward). NULLs
-- are admitted, which is what lets the straggler window above exist
-- without failing inserts.
create unique index if not exists messages_thread_position_idx
  on public.messages (thread_id, position);

-- Partial index for the streaming function's "is there an in-flight
-- stream anchored to this thread?" lookup, which runs on every /stream
-- POST (fresh send and reconnect both probe it). At most ~one row per
-- active thread sits in 'streaming' at any moment, so the partial
-- keeps the index tiny under steady state.
create index if not exists messages_streaming_pos_idx
  on public.messages (thread_id, position desc)
  where status = 'streaming';

-- The created_at orderings these two served have all moved to
-- position; per-thread scans ride messages_thread_position_idx via its
-- thread_id prefix.
drop index if exists messages_thread_created_idx;
drop index if exists messages_streaming_idx;

-- Move a message to the tail of its thread's transcript. The streaming
-- function calls this at a tool-round boundary: the streaming assistant
-- row is born (and positioned) at the turn's first content delta, which
-- can be BEFORE the round's tool rows persist when the model narrates a
-- preamble before calling tools - an un-moved row would sort the final
-- response card ahead of the tool cards. An UPDATE never fires the
-- insert trigger, and the client library cannot express a subquery in
-- an UPDATE, so this takes the same thread-row lock the trigger takes
-- and assigns the same floor(max)+1 - immune to racing a concurrent
-- insert's tail assignment.
drop function if exists public.move_message_to_tail(uuid, uuid);
create or replace function public.move_message_to_tail(
  p_thread_id uuid,
  p_msg_id uuid
) returns void
language plpgsql security definer
set search_path = public as $$
begin
  perform 1 from public.threads t where t.id = p_thread_id for update;
  update public.messages m
     set position = (
       select coalesce(floor(max(position)), 0) + 1
         from public.messages
        where thread_id = p_thread_id
     )
   where m.id = p_msg_id
     and m.thread_id = p_thread_id;
end $$;

-- service-role only: the streaming edge function is the sole caller,
-- through the admin client.
revoke all on function public.move_message_to_tail(uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.move_message_to_tail(uuid, uuid)
  to service_role;

-- Conversation forking ------------------------------------------------------
--
-- A thread row owns a SEGMENT - the run of messages it minted itself -
-- not necessarily a whole conversation. A conversation is the
-- concatenation of segments along the path from a root thread down to
-- one node: threads form a forest (parent set at creation, never
-- changed), a trie of conversation histories with shared prefixes
-- stored once near the roots. Until the fork entry points ship, every
-- column below is null/false on every row and thread_transcript
-- degenerates to the plain per-thread query.
--
-- forked_from_thread_id: parent thread; null for roots.
-- forked_from_msg_id: the fork point - the last message this thread
--   shares with its parent, always a row of the PARENT's own segment
--   (the reparent rule: a fork's parent is whichever thread owns the
--   fork-point message, which may be an ancestor of the thread the
--   user forked from). Restrict, not cascade, on purpose: only the
--   forking GC destroys shared rows, and it collects child threads
--   before trimming parents - the restrict FK turns a GC ordering bug
--   into a loud error instead of a silently broken fork.
-- hidden: the thread is structure only - it holds rows other threads'
--   transcripts depend on, but no list surface shows it and nobody is
--   talking in it.
alter table public.threads
  add column if not exists forked_from_thread_id uuid
    references public.threads(id) on delete restrict;
alter table public.threads
  add column if not exists forked_from_msg_id uuid
    references public.messages(id) on delete restrict;
alter table public.threads
  add column if not exists hidden boolean not null default false;

-- A fork point without a parent (or a parent without a fork point) is
-- meaningless - the pair travels together.
alter table public.threads drop constraint if exists threads_fork_pair_check;
alter table public.threads
  add constraint threads_fork_pair_check
  check ((forked_from_thread_id is null) = (forked_from_msg_id is null));

-- Serve the restrict-FK enforcement probes (every thread/message
-- delete checks for referencing forks) and the GC's children-of-parent
-- walk. Partial on not-null: forks are sparse relative to root
-- threads, and an equality probe implies the predicate.
create index if not exists threads_forked_from_thread_idx
  on public.threads (forked_from_thread_id)
  where forked_from_thread_id is not null;
create index if not exists threads_forked_from_msg_idx
  on public.threads (forked_from_msg_id)
  where forked_from_msg_id is not null;

-- Resolve a thread's full transcript across fork boundaries: walk the
-- ancestor chain root-ward, take each ancestor's segment up to the
-- fork point its child recorded, then the thread's own whole segment,
-- ordered (segment depth, position). Rows return verbatim (setof
-- messages), so each carries its OWNING thread_id - callers tell
-- inherited prefix from owned tail by comparing it to the id they
-- asked for.
--
-- This is the single choke point for full-transcript readers (browser
-- thread load, summary / topics / bias / recall agents, the
-- conversation_get tool). By-id, windowed, current-turn, and
-- per-segment readers (the chunker) stay on direct queries.
--
-- Position alone is NOT global order across segments: a fork's own
-- segment restarts at 1 while its inherited prefix also starts at 1,
-- so callers must preserve the row order this function returns and
-- never re-sort by bare position. plpgsql rather than sql for exactly
-- that contract: an inlinable sql body could lose its ORDER BY when
-- the planner flattens it into the calling query, while RETURN QUERY
-- hands rows over in the order written.
--
-- SECURITY INVOKER on purpose: the browser's authenticated role
-- resolves through the threads/messages RLS policies - every thread
-- on an ancestor path belongs to the same user (forks never cross
-- users), so ownership covers the whole chain and an unowned or
-- unknown id yields zero rows, same as a direct query. The agents'
-- service role bypasses RLS here exactly as it does on direct reads.
create or replace function public.thread_transcript(p_thread_id uuid)
returns setof public.messages
language plpgsql stable as $$
begin
  return query
  with recursive chain as (
    -- The requested thread: whole own segment, no cutoff.
    select t.id, t.forked_from_thread_id, t.forked_from_msg_id,
           0 as depth, null::uuid as cut_msg_id
      from public.threads t
     where t.id = p_thread_id
    union all
    -- Each ancestor: its segment up to the fork point its child
    -- recorded (the reparent rule guarantees that message lies in
    -- this ancestor's own segment). The depth guard is a backstop
    -- against a corrupted parent cycle turning this into an
    -- unkillable query - the forest is append-only by construction
    -- (a parent is set once, at creation, to an already-existing
    -- thread), so real chains stay far below it.
    select t.id, t.forked_from_thread_id, t.forked_from_msg_id,
           c.depth + 1, c.forked_from_msg_id
      from public.threads t
      join chain c on t.id = c.forked_from_thread_id
     where c.depth < 100
  )
  select m.*
    from chain c
    join public.messages m on m.thread_id = c.id
    left join public.messages cut on cut.id = c.cut_msg_id
   where c.cut_msg_id is null or m.position <= cut.position
   order by c.depth desc, m.position asc;
end $$;

-- Forking GC: reclaim rows no live conversation can reach. Hiding a
-- thread is the ONLY way user action removes a conversation (the
-- browser's delete rewired to it); actual destruction happens here,
-- deferred by at most one sweep cycle. Per pass:
--
--   1. Compute the KEPT set: every visible thread plus every ancestor
--      of one. A hidden thread outside that set is doomed - nothing
--      visible depends on any of its rows.
--   2. Delete doomed thread rows deepest-first. The order is
--      load-bearing, not style: a doomed child's forked_from_msg_id is
--      a restrict FK into its parent's segment, so the parent's rows
--      cannot cascade away until the child thread row is gone. The
--      restrict FKs turn an ordering bug here into a loud error
--      instead of a silently broken fork. Each thread-row delete
--      cascades its messages, and those cascades fan out through the
--      policies the reference graph already declares (attachment link
--      rows, chunks, traces cascade; watermarks and evidence pointers
--      set-null; soft pointers dangle and rebuild).
--   3. Trim surviving hidden threads: only their segment rows past the
--      keep watermark (the max fork position among their children, all
--      of which are kept once step 2 has run) are unreachable. Rows
--      at-or-before a fork point are some fork's shared prefix and
--      must survive; grandchildren never reach into this segment (the
--      reparent rule pins every fork point into its direct parent's
--      own segment).
--
-- With zero forks (every fork column null) this degenerates to
-- "destroy every hidden thread", which is exactly the old destructive
-- delete deferred one sweep. Storage objects for cascaded attachment
-- rows (originals and rendered PDF pages both) orphan here and are
-- reclaimed by the daily attachment-gc, whose double anti-join
-- (message_attachments + message_attachment_pages) exists for exactly
-- this rows-gone-objects-later shape.
--
-- Cycle posture: kept-set recursion uses UNION (dedup terminates a
-- corrupted parent cycle); the depth recursion walks down from roots,
-- which a cycle is unreachable from - so a corrupted cycle is left
-- untouched rather than hanging the sweep.
--
-- Returns the pass's counts so the QA walkthrough and ad hoc runs can
-- assert on what a sweep actually did.
create or replace function public.collect_hidden_threads()
returns table (deleted_threads int, trimmed_messages int)
language plpgsql security definer
set search_path = public as $$
declare
  v_deleted int := 0;
  v_trimmed int := 0;
  v_count int;
  r record;
begin
  for r in
    with recursive kept as (
      select t.id, t.forked_from_thread_id
        from public.threads t
       where not t.hidden
      union
      select t.id, t.forked_from_thread_id
        from public.threads t
        join kept k on t.id = k.forked_from_thread_id
    ), depths as (
      select t.id, 0 as depth
        from public.threads t
       where t.forked_from_thread_id is null
      union all
      select t.id, d.depth + 1
        from public.threads t
        join depths d on t.forked_from_thread_id = d.id
    )
    select d.id
      from depths d
     where d.id not in (select k.id from kept k)
     order by d.depth desc
  loop
    delete from public.threads t where t.id = r.id;
    v_deleted := v_deleted + 1;
  end loop;

  -- Every hidden thread that survives step 2 has at least one kept
  -- child; trim its segment past the highest fork position among them.
  with watermarks as (
    select p.id as thread_id, max(fm.position) as keep_upto
      from public.threads p
      join public.threads c on c.forked_from_thread_id = p.id
      join public.messages fm on fm.id = c.forked_from_msg_id
     where p.hidden
     group by p.id
  )
  delete from public.messages m
   using watermarks w
   where m.thread_id = w.thread_id
     and m.position > w.keep_upto;
  get diagnostics v_count = row_count;
  v_trimmed := v_count;

  return query select v_deleted, v_trimmed;
end $$;

-- service-role only: the cron dispatcher and ad hoc test invocations.
revoke all on function public.collect_hidden_threads()
  from public, anon, authenticated;
grant execute on function public.collect_hidden_threads()
  to service_role;

-- Hourly at :43 - the gap in the sweep ladder (3 bias, 7 wiki, 13
-- samskara reap, 17 wiki-records/rem, 23 samskara, 27 reflection, 33
-- intent employment, 37 wiki librarian, 47 deep sleep, 53 digest, 57
-- curation).
do $cron$
begin
  if exists (select 1 from pg_available_extensions where name = 'pg_cron') then
    create extension if not exists pg_cron;
    if exists (select 1 from cron.job where jobname = 'nak-fork-gc') then
      perform cron.unschedule('nak-fork-gc');
    end if;
    perform cron.schedule(
      'nak-fork-gc',
      '43 * * * *',
      $job$ select * from public.collect_hidden_threads(); $job$
    );
  end if;
exception when others then
  raise notice 'fork gc cron setup skipped: %', sqlerrm;
end
$cron$;

-- Second-thoughts self-review verdict for a completed assistant turn.
-- Written by the second_thoughts reviewer agent
-- (supabase/functions/venice/agents/second_thoughts.ts) from the
-- streaming function's completed-turn waitUntil tail, onto the terminal
-- assistant row. Shape:
--   {v, disposition: 'conviction'|'hedge'|'reframe'|'correct',
--    note: string, model: string, computed_at: number, acted?: boolean}
-- `acted` is set later by the browser (mark_second_thoughts_acted RPC)
-- when the user clicks the refinement button, not by the reviewer.
-- The reviewer is a fast, low-context "doubt reflex" that reads only the
-- turn slice (user message + this turn's assistant/tool rows) and reports
-- a felt confidence. 'conviction' is the common "no second thoughts"
-- verdict. Null on non-assistant rows, on rows written before the column
-- existed, and on turns where the reviewer was disabled or errored (it is
-- best-effort and never blocks the turn). The browser coerces this jsonb
-- on read (src/lib/ui/second-thoughts.ts) - a drifting shape reads as
-- "no verdict" rather than crashing the card.
alter table public.messages
  add column if not exists second_thoughts jsonb;

-- Mark a second-thoughts verdict as acted-on: the user clicked the
-- refinement button ("Let me temper that", etc.), which promotes the
-- doubt from a display-only column to a model-visible <think> connective
-- on replay (toVeniceMessage in src/lib/chat/prompt-assembly.ts). The
-- browser cannot UPDATE an assistant row directly - the messages-UPDATE
-- RLS policy is scoped to role='tool' rows so a client can never rewrite
-- assistant/user content - so this SECURITY DEFINER function is the
-- narrow, safe write path: it touches ONLY the `acted` key, only on an
-- assistant row, and only when auth.uid() owns the parent thread.
-- Idempotent.
create or replace function public.mark_second_thoughts_acted(
  p_message_id uuid
) returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.messages m
     set second_thoughts = jsonb_set(
       coalesce(m.second_thoughts, '{}'::jsonb),
       '{acted}',
       'true'::jsonb,
       true
     )
   where m.id = p_message_id
     and m.role = 'assistant'
     and exists (
       select 1 from public.threads t
       where t.id = m.thread_id and t.user_id = auth.uid()
     );
end;
$$;

-- Browser-called (the authenticated user clicking the refinement
-- button), unlike the service_role-only claim/commit RPCs.
grant execute on function public.mark_second_thoughts_acted(uuid)
  to authenticated;

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
-- One row per file a user attached to a message (or an image the model
-- generated). The original bytes live in the private `attachments`
-- Storage bucket (defined below), pointed at by `storage_path`; the row
-- itself holds only metadata plus the extracted text. This mirrors the
-- `documents` bucket - one file-storage mechanism for the whole app.
-- (The legacy base64 `data` column has been dropped; the drop below
-- clears it from any project that ran an earlier schema.)
--
-- `extracted_text` is populated at upload time for non-image files by
-- calling Venice's POST /api/v1/augment/text-parser endpoint, so the
-- LLM has a prompt-ready representation of documents. It is independent
-- of the binary: even after the object is expired and deleted, the
-- extracted text stays, so re-reading an old conversation still shows
-- what the file said.
--
-- Liveness is keyed on `storage_path`, NOT `data`:
--   * live:    storage_path is not null  (object in the bucket)
--   * expired: storage_path is null      (object deleted, or a legacy
--              base64 row treated as expired). extracted_text survives.
-- The server-side expiry sweep (see the attachments-expiry block near
-- the embeddings cron) deletes the object 30 days after the parent
-- thread's `updated_at`, then nulls `storage_path` and stamps
-- `expired_at`.
--
-- No `updated_at` — attachments are immutable once written aside from
-- the expiry transition. RLS is via-parent-of-parent: attachment ->
-- message -> thread -> user, mirroring the messages policies one level
-- deeper.

create table if not exists public.message_attachments (
  id uuid primary key default gen_random_uuid(),
  message_id uuid not null references public.messages(id) on delete cascade,
  position int not null default 0,
  filename text not null,
  mime_type text not null,
  size_bytes int not null,
  -- Object key in the `attachments` bucket:
  -- `<user_id>/<attachment_id>/<filename>`. Null once expired (object
  -- deleted) or for a legacy pre-bucket row.
  storage_path text,
  extracted_text text,
  expired_at timestamptz,
  created_at timestamptz not null default now()
);

alter table public.message_attachments
  add column if not exists storage_path text;

-- Page count of the source document, for the formats we rasterize (PDF).
-- Null for everything else. Distinct from the number of rows in
-- message_attachment_pages: rendering is capped, so a 200-page PDF stores
-- page_count = 200 alongside far fewer rendered pages. The gap is what
-- lets the model tell the user "I can see the first N of 200 pages"
-- instead of silently answering from a truncated view.
alter table public.message_attachments
  add column if not exists page_count int;

-- Drop the retired legacy base64 column. Stage 1's reclaim already nulled it
-- everywhere, no code reads or writes it, and the bytes live in the
-- `attachments` bucket now. Idempotent: a no-op once the column is gone (and on
-- a fresh database that never had it). The live index keys on storage_path, so
-- nothing depends on this column.
alter table public.message_attachments
  drop column if exists data;

create index if not exists message_attachments_message_idx
  on public.message_attachments (message_id, position);

-- Anti-join support for the orphan-object GC sweep
-- (list_orphan_attachment_objects). The sweep asks "which attachments
-- bucket objects have NO live row pointing at them" - storage.objects
-- LEFT-anti-joined to this column - so a row's storage_path must be
-- index-probable. Partial on non-null because an expired row's path is
-- null (its object is already gone) and never participates in the join.
drop index if exists public.message_attachments_storage_path_idx;
create index if not exists message_attachments_storage_path_idx
  on public.message_attachments (storage_path)
  where storage_path is not null;

-- Partial index over live (non-expired) rows - those with an object still
-- in the bucket. Keeps per-message live-attachment lookups (render
-- partition, thread summaries, generated-image filename resolution) cheap
-- by excluding the bulk of history, which is deleted/expired.
drop index if exists public.message_attachments_live_idx;
create index if not exists message_attachments_live_idx
  on public.message_attachments (message_id)
  where storage_path is not null;

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

-- message_attachment_pages -------------------------------------------------
--
-- Rasterized pages of an attachment whose format the vision models cannot
-- read directly (today: PDF). One row per rendered page, bytes in the same
-- private `attachments` bucket under
-- `<user_id>/<attachment_id>/pages/<page_number>.jpg`.
--
-- Why a separate table rather than more message_attachments rows: page
-- renders are a derived artifact of ONE attachment, not files in their own
-- right. Filed as attachments they would surface in the Artifacts tab, the
-- per-message render, and the <thread_attachments> prompt block, and every
-- one of those listings would need to remember to filter them back out.
-- A separate table keeps the special case off the attachments API entirely.
--
-- Why rasterize at all: Venice's text-parser returns the text layer, which
-- a scanned PDF does not have and which drops charts, diagrams, and layout
-- from the ones that do. The rendered page is what analyze_pdf_page hands
-- to a vision model, so those PDFs stop being a dead end.
--
-- No `expired_at` / nullable `storage_path` analog to message_attachments:
-- a page render carries no information the parent row doesn't, so there is
-- nothing worth preserving past the bytes. Deleting the attachment deletes
-- these rows outright (via the cascade) and their objects with them.

create table if not exists public.message_attachment_pages (
  id uuid primary key default gen_random_uuid(),
  attachment_id uuid not null
    references public.message_attachments(id) on delete cascade,
  -- 1-based, matching how a PDF reader numbers pages and how the user
  -- will refer to them in conversation.
  page_number int not null,
  storage_path text not null,
  created_at timestamptz not null default now(),
  unique (attachment_id, page_number)
);

-- Anti-join support for the orphan-object GC sweep. Same role the
-- storage_path index plays on message_attachments: the sweep probes every
-- attachments-bucket object against both tables, so a page's path has to
-- be index-probable or the sweep degrades to a seq scan per object.
create index if not exists message_attachment_pages_storage_path_idx
  on public.message_attachment_pages (storage_path);

alter table public.message_attachment_pages enable row level security;

-- Via-parent-of-parent-of-parent: page -> attachment -> message -> thread
-- -> user. One level deeper than the message_attachments policies, same
-- shape. No update policy - a page render is immutable; it is written once
-- and deleted with its attachment.
drop policy if exists "attachment pages are self-selectable via thread"
  on public.message_attachment_pages;
create policy "attachment pages are self-selectable via thread"
  on public.message_attachment_pages
  for select using (
    exists (
      select 1
        from public.message_attachments a
        join public.messages m on m.id = a.message_id
        join public.threads t on t.id = m.thread_id
       where a.id = message_attachment_pages.attachment_id
         and t.user_id = auth.uid()
    )
  );

drop policy if exists "attachment pages are self-insertable via thread"
  on public.message_attachment_pages;
create policy "attachment pages are self-insertable via thread"
  on public.message_attachment_pages
  for insert with check (
    exists (
      select 1
        from public.message_attachments a
        join public.messages m on m.id = a.message_id
        join public.threads t on t.id = m.thread_id
       where a.id = message_attachment_pages.attachment_id
         and t.user_id = auth.uid()
    )
  );

drop policy if exists "attachment pages are self-deletable via thread"
  on public.message_attachment_pages;
create policy "attachment pages are self-deletable via thread"
  on public.message_attachment_pages
  for delete using (
    exists (
      select 1
        from public.message_attachments a
        join public.messages m on m.id = a.message_id
        join public.threads t on t.id = m.thread_id
       where a.id = message_attachment_pages.attachment_id
         and t.user_id = auth.uid()
    )
  );

-- Private bucket for attachment originals. Same shape as the `documents`
-- bucket: public = false, reachable only via signed URLs or authenticated
-- requests. Object key is `<user_id>/<attachment_id>/<filename>`; the
-- storage.objects policies scope every operation to the caller's own
-- top-level `<user_id>/` prefix. Idempotent insert.
insert into storage.buckets (id, name, public)
  values ('attachments', 'attachments', false)
  on conflict (id) do nothing;

drop policy if exists "attachments bucket is self-readable" on storage.objects;
create policy "attachments bucket is self-readable" on storage.objects
  for select to authenticated
  using (
    bucket_id = 'attachments'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

drop policy if exists "attachments bucket is self-writable" on storage.objects;
create policy "attachments bucket is self-writable" on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'attachments'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

drop policy if exists "attachments bucket is self-deletable" on storage.objects;
create policy "attachments bucket is self-deletable" on storage.objects
  for delete to authenticated
  using (
    bucket_id = 'attachments'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

-- The legacy per-caller expiry RPC is retired: attachment bytes live in
-- the `attachments` bucket now, and attachments are no longer reclaimed on
-- a timer - they persist until the user deletes them from the Artifacts
-- tab (a client-side mark-expired + object remove). SQL can't delete a
-- Storage object, so this RPC's null-the-base64 approach no longer
-- applies. Dropped so a sync removes it from any project that ran the
-- earlier schema; idempotent, a no-op once gone.
drop function if exists public.expire_old_attachments(int);

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
  add column if not exists reflection_claim_expires_at timestamptz,
  -- Attempt accounting, stamped AT CLAIM TIME by the sweep claim.
  -- Counting attempts (not failures) is deliberate: a run
  -- that dies to the invocation wall clock never reaches an error
  -- handler, so a failure counter would miss exactly the deaths that
  -- need bounding. Three attempts at the same terminal message and
  -- the claims stop offering the thread; a new conversation turn
  -- changes the terminal message and refreshes the budget. A
  -- successful mark resets the count.
  add column if not exists reflection_attempt_msg_id uuid,
  add column if not exists reflection_attempt_count int not null default 0;

-- Samskara evaluation sweep claim/cursor columns. Parallel to the
-- reflection_* set above and load-bearing for the same reason: the
-- evaluation sweep (the next-day retrospective judge of fired
-- samskaras) day-gates and leases the SAME settled threads reflection
-- does, so it needs its own independent claim columns or the two
-- sweeps would contend for one lease. last_evaluated_msg_id is the
-- "judged up to" cursor - the newest terminal assistant message at the
-- time this thread's fired samskaras were last evaluated.
alter table public.threads
  add column if not exists last_evaluated_msg_id uuid references public.messages(id) on delete set null,
  add column if not exists evaluation_holder_id text,
  add column if not exists evaluation_claim_expires_at timestamptz,
  add column if not exists evaluation_attempt_msg_id uuid,
  add column if not exists evaluation_attempt_count int not null default 0;

-- Claim-lookup index. Partial on `reflection_holder_id is not null` so
-- the index only carries live claims — the common case is 0 rows
-- claimed, and a partial index stays tiny under that steady state.
create index if not exists threads_reflection_claim_idx
  on public.threads (reflection_claim_expires_at)
  where reflection_holder_id is not null;

-- Summarisation pipeline -------------------------------------------------
--
-- The summary agent (supabase/functions/venice/agents/summary.ts) takes
-- a thread and writes a 2-3 sentence topical summary into
-- `threads.summary`. `last_summarised_msg_id` points at the terminal
-- assistant message we've summarised up to - same shape as
-- `last_reflected_msg_id`, same reasons (stable ids, no clock skew).
-- Two drivers run it: the chat turn's waitUntil tail (per-user) and the
-- hourly curation sweep (cross-user). The per-thread claim columns are
-- the only mutual exclusion between them - there is no worker lease for
-- this unit.
--
-- The summary is NOT an embedding input any more. Threads used to carry
-- a single vector over `title + summary`, which could only match a
-- conversation on how it was labelled and never on what was said in it -
-- see the `public.thread_chunks` section for what replaced it. The
-- summary survives because it is still what a search hit shows the model
-- so it can judge a thread without opening it.
alter table public.threads
  add column if not exists summary text,
  add column if not exists last_summarised_msg_id uuid references public.messages(id) on delete set null,
  add column if not exists summary_claim_holder text,
  add column if not exists summary_claim_expires timestamptz;

-- Retired: the per-thread title+summary embedding, superseded by
-- public.thread_chunks. Dropping the columns drops the vectors with
-- them, which is intended - they describe an indexing scheme nothing
-- reads any more, and thread_chunks rebuilds from the messages
-- themselves. Idempotent, so re-applying against a project that never
-- had the columns is a no-op.
alter table public.threads
  drop column if exists embedding,
  drop column if exists embedding_model,
  drop column if exists embedding_claim_holder,
  drop column if exists embedding_claim_expires;

-- Partial claim indexes: same shape as the reflection one. Only carry
-- live claims so the index stays tiny in steady state.
create index if not exists threads_summary_claim_idx
  on public.threads (summary_claim_expires)
  where summary_claim_holder is not null;

drop index if exists threads_embedding_claim_idx;

-- Auto-title pipeline ---------------------------------------------------
--
-- The auto-title agent (supabase/functions/venice/agents/auto_title.ts)
-- names threads that are still on the `'New conversation'` placeholder.
-- Per-thread claim columns mirror the summary pair exactly and are the
-- only mutual exclusion between the two drivers (chat-turn waitUntil
-- tail and hourly curation sweep) - no worker lease. Title generation
-- is a single fast-model completion against the opening user message -
-- shape is one non-streaming Venice call per thread, so the 120s claim
-- TTL the drivers pass has plenty of headroom.
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
-- The thread-topics agent
-- (supabase/functions/venice/agents/thread_topics.ts) tags each thread
-- with a short flat set of topic strings ('baking', 'sourdough',
-- 'programming', etc.) so the conversation drawer can offer a topic
-- filter alongside the default date-sorted list. The agent reads the
-- conversation, the existing per-user topic vocabulary, and asks the
-- fast model to pick 1-4 topics - reusing existing names when they fit
-- so the vocabulary doesn't sprawl into near-duplicates over time.
-- Per-thread claim columns mirror summary / auto_title exactly and are
-- the only mutual exclusion between the chat-turn tail and the hourly
-- curation sweep - no worker lease.
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

-- Retired alongside the title+summary thread embedding it invalidated.
-- Chunk invalidation is not a column trigger: `thread_chunks` is rebuilt
-- from the MESSAGES by the rechunk unit, driven off
-- `threads.last_chunked_msg_id` rather than off any column on this row.
drop trigger if exists clear_thread_embedding_on_change on public.threads;
drop function if exists public.clear_thread_embedding_on_change();

-- memories ---------------------------------------------------------------
--
-- Free-form notes the user (or the LLM via the memory_* tools) can CRUD
-- and search. `data` is plain text by design — we want the LLM to be able
-- to read and write it directly without a schema it has to learn.
--
-- The `embedding` column is sized at 2048 dims for forward compatibility.
-- The current embedding model (gte-small, via Supabase.ai.Session) emits
-- 384 dims; the backfill zero-pads to 2048 before storing. Cosine
-- similarity is invariant to the extra zeros (the padded suffix
-- contributes nothing to
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

-- Memory topic-tagging pipeline -----------------------------------------
--
-- Same shape as threads.topics (see "Topic-tagging pipeline" above):
-- the memory-topics agent
-- (supabase/functions/venice/agents/memory_topics.ts) tags each memory
-- with a short flat set of topic strings so the Memories drawer can
-- offer a topic filter. The agent reads the memory's label+data plus
-- the user's existing per-account vocabulary and picks 1-4 topics,
-- reusing existing names where they fit so the dropdown vocabulary
-- stays small and stable.
--
-- `topics` defaults to '{}' so existing rows match "untagged" without a
-- backfill and re-qualify on the first cycle (last_topics_at is null,
-- which is the eligibility predicate). The GIN index backs the `&&`
-- overlap operator the filter uses. The claim columns mirror the
-- embedding pipeline's per-row lease shape exactly.
alter table public.memories
  add column if not exists topics text[] not null default '{}',
  add column if not exists last_topics_at timestamptz,
  add column if not exists topics_claim_holder text,
  add column if not exists topics_claim_expires timestamptz;

create index if not exists memories_topics_gin_idx
  on public.memories using gin (topics);

create index if not exists memories_topics_claim_idx
  on public.memories (topics_claim_expires)
  where topics_claim_holder is not null;

-- Re-queue a memory for tagging whenever the text the tags were derived
-- from changes. Same trigger pattern as `clear_memory_embedding_on_change`
-- above - parallel rather than merged so a future change to one path
-- doesn't risk dragging the other along by accident. Confidence-only
-- updates (bump / decay / reaffirm / doubt) DO NOT change label or data,
-- so they don't fire this trigger and the tags stay stable across
-- volitional nudges - matching how the embedding survives confidence
-- changes today.
--
-- Nulling the claim columns alongside last_topics_at protects against
-- the same race the embedding trigger protects against: an in-flight
-- worker save would otherwise see a live claim + valid TTL and write
-- stale tags. With the claim cleared, save_memory_topics_if_claimed's
-- holder guard fails and the worker drops the result.
create or replace function public.clear_memory_topics_on_change()
  returns trigger language plpgsql as $$
begin
  if new.label is distinct from old.label or new.data is distinct from old.data then
    new.topics := '{}'::text[];
    new.last_topics_at := null;
    new.topics_claim_holder := null;
    new.topics_claim_expires := null;
  end if;
  return new;
end $$;

drop trigger if exists clear_memory_topics_on_change on public.memories;
create trigger clear_memory_topics_on_change
  before update on public.memories
  for each row execute function public.clear_memory_topics_on_change();

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

-- memory_changelog -------------------------------------------------------
--
-- One row per content-affecting memory mutation - create, update,
-- delete, or a librarian consolidation (recorded as an 'update' on the
-- survivor). Written by the volitional create/update/delete tools, the
-- user's direct edits in Memories.svelte, and the librarian's
-- memory_consolidate. Confidence-only operations (reaffirm / doubt /
-- invalidate / the reflection auto-bump) are deliberately NOT logged -
-- they'd drown the "what did I learn / forget / revise" signal in
-- nudge churn. Parallel in shape and intent to wiki_changelog below.
--
-- The `message` column is the commit-message-style one-line summary the
-- writer supplied; for consolidations it is auto-generated from the
-- merged-away memory's label.
--
-- `memory_id` is `on delete set null` so a hard-deleted memory doesn't
-- take its history with it. The `label_at_change` snapshot is captured
-- at write time so a row whose memory has been deleted still reads
-- meaningfully in the changelog UI without a join.
--
-- Rows are append-only - no policy allowing update or delete.
create table if not exists public.memory_changelog (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  memory_id uuid references public.memories(id) on delete set null,
  -- 'create' | 'update' | 'delete'. Constrained at the column level so a
  -- typo'd kind value can't land silently.
  kind text not null check (kind in ('create', 'update', 'delete')),
  -- Snapshot of the memory label as it was at the time of this change.
  -- For create/update this is the new label; for delete it's the label
  -- the memory had immediately before deletion. Allows the changelog UI
  -- to render meaningfully even when memory_id has been nulled by the FK
  -- cascade.
  label_at_change text not null,
  -- The commit-message-style explanation supplied by the writer. Capped
  -- at 200 chars to match MAX_MEMORY_CHANGELOG_MESSAGE_CHARS on the
  -- client; longer prose belongs in the memory body, not here.
  message text not null check (char_length(message) between 1 and 200),
  created_at timestamptz not null default now()
);

-- Body size on either side of the change, so the history panel can show
-- how much a given edit grew or shrank a memory. Memory bodies are
-- replayed verbatim into every recall prompt, so size drift is a real
-- cost signal - these columns are what makes "did that consolidation
-- actually condense anything" answerable after the fact.
--
-- NULL and 0 mean different things and the UI depends on the difference:
--   NULL - unknown. Rows written before these columns existed, which
--          cannot be reconstructed (historical sizes were never stored).
--   0    - known empty. A create has nothing before it; a delete has
--          nothing after it.
-- `chars_before` always means "this memory's body immediately before
-- this change", including for librarian consolidations, where the entry
-- lands on the survivor. It is deliberately NOT survivor+loser combined:
-- mixing semantics per-kind would make a column that sums across rows
-- double-count.
alter table public.memory_changelog
  add column if not exists chars_before int,
  add column if not exists chars_after int;

-- Anchor backfill for pre-existing history. Every `data` mutation writes
-- a changelog row, so for a memory that still exists its MOST RECENT
-- entry describes the body the row carries right now - that one value is
-- exactly recoverable, unlike the older intermediate sizes. Filling it
-- means the first NEW edit after this ships already has a real
-- before/after pair instead of a null.
--
-- Idempotent via the `chars_after is null` guard: on a re-run the latest
-- entry per memory already carries a value (either from this backfill or
-- from the application), so nothing is rewritten. Superseded older
-- entries stay null, which is correct - their sizes are unknown.
with latest as (
  select distinct on (c.memory_id) c.id, m.data
    from public.memory_changelog c
    join public.memories m on m.id = c.memory_id
   order by c.memory_id, c.created_at desc, c.id desc
)
update public.memory_changelog c
   set chars_after = length(latest.data)
  from latest
 where c.id = latest.id
   and c.chars_after is null;

-- Primary access pattern is "page through the user's history newest-
-- first", so the chronological index is the one that pays its way.
create index if not exists memory_changelog_user_created_idx
  on public.memory_changelog (user_id, created_at desc);

alter table public.memory_changelog enable row level security;

drop policy if exists "memory_changelog are self-selectable" on public.memory_changelog;
create policy "memory_changelog are self-selectable" on public.memory_changelog
  for select using (auth.uid() = user_id);

drop policy if exists "memory_changelog are self-insertable" on public.memory_changelog;
create policy "memory_changelog are self-insertable" on public.memory_changelog
  for insert with check (auth.uid() = user_id);

-- No update or delete policies. The changelog is append-only from the
-- client's perspective.

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

-- Memory librarian -------------------------------------------------------
--
-- Two background agents that periodically reorganise the memory store.
-- Their job is the cross-thread consolidation reflection structurally
-- can't do: reflection sees one thread at a time and never sees the
-- store as a whole, so duplicates from different sessions accumulate,
-- the relations graph stays sparse, and old high-confidence memories
-- can stay corroborated even when the user has moved on.
--
-- The two layers - same toolbox, same model, same 12h cadence,
-- different seed-selection strategies:
--
--   deep-sleep (slow-wave consolidation): pick the longest-unvisited
--     memory as a seed, find its similarity neighbors above a medium
--     threshold, hand the batch to the agent with similarity scores.
--     The agent consolidates duplicates (via memory_consolidate),
--     draws relation edges, doubts stale facts, or leaves them alone.
--
--   rem (associative integration): pick the oldest eligible
--     conversation from memory_conversation, fetch the set of memories
--     referenced during recall on that conversation, hand the batch to
--     the agent. The signal here is user behavior - the user's recall
--     queries already treat these memories as belonging together; the
--     librarian looks for missed relations and hidden duplicates that
--     only surface when memories appear together in conversation.
--
-- Both agents share ONE in-flight guard (the holder+TTL pair below) -
-- only one of them can run at a time per user, across every entry
-- path (the two cron sweeps and the two manual-run routes). Cadence
-- drift naturally separates the scheduled runs most of the time; the
-- guard catches the rare overlap.
--
-- Schema additions for this feature, applied here:
--
--   - memories.last_librarian_visit_at: per-row "when did deep-sleep
--     last inspect this neighborhood." Reset when label/data change.
--   - memory_conversation: hint queue for rem; one row per memory
--     referenced during recall on a conversation. last_seen_at /
--     last_processed_at gate the eligibility predicate.
--   - profiles.deep_sleep_last_run_at, profiles.rem_last_run_at:
--     per-user cadence gates, modelled on
--     profiles.wiki_librarian_last_run_at.
--   - claim_next_user_for_deep_sleep / claim_next_user_for_rem:
--     global SECURITY DEFINER sweeps for the cron-driven venice
--     routes (stamp-before-run, most-overdue user first).
--   - claim_memory_librarian_inflight / release: the shared run
--     mutex described above.
--   - consolidate_memories: the agent's content-write primitive. Single
--     RPC so the (survivor confidence, loser invalidate, memory_conversation
--     redirect, memory_relations redirect) sequence is one atomic
--     transaction - the agent loop runs in the venice function; this is
--     just the bookkeeping the agent doesn't need to think about.

alter table public.memories
  add column if not exists last_librarian_visit_at timestamptz;

-- Mark a memory as "deep-sleep just looked at this neighborhood" -
-- runs after a successful agent cycle for the seed and every
-- similarity neighbor it considered. Confidence-only updates (bump /
-- decay / reaffirm / doubt) don't touch last_librarian_visit_at; only
-- label/data changes do (via the trigger below), so re-embedded
-- memories naturally re-enter the queue but a librarian visit
-- followed by a quiet period doesn't.
create index if not exists memories_librarian_visit_idx
  on public.memories (user_id, last_librarian_visit_at nulls first);

-- Re-queue a memory for librarian visit whenever its text changes.
-- Parallel to clear_memory_embedding_on_change and
-- clear_memory_topics_on_change above - separate triggers so a
-- future change to one path doesn't drag the others. Confidence-only
-- updates leave last_librarian_visit_at alone.
create or replace function public.clear_memory_librarian_visit_on_change()
  returns trigger language plpgsql as $$
begin
  if new.label is distinct from old.label or new.data is distinct from old.data then
    new.last_librarian_visit_at := null;
  end if;
  return new;
end $$;

drop trigger if exists clear_memory_librarian_visit_on_change on public.memories;
create trigger clear_memory_librarian_visit_on_change
  before update on public.memories
  for each row execute function public.clear_memory_librarian_visit_on_change();

-- memory_conversation: rem's hint queue. One row per (memory,
-- conversation) pair where the memory was referenced during recall on
-- the conversation. The recall path upserts on every recall; rem
-- queries for conversations with at least one row where
-- `last_processed_at is null or last_processed_at < last_seen_at` and
-- processes them in FIFO order on its 12h cycle.
--
-- The (memory_id, conversation_id) unique constraint lets the recall
-- path use `on conflict do update set last_seen_at = now()` without
-- caring whether the row already exists.
--
-- Cascade semantics: on hard-delete of either side, the row goes too.
-- The memory_consolidate RPC handles the redirect-on-merge case in
-- application code so the unique constraint can't fire mid-sequence.

create table if not exists public.memory_conversation (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  memory_id uuid not null references public.memories(id) on delete cascade,
  conversation_id uuid not null references public.threads(id) on delete cascade,
  last_seen_at timestamptz not null default now(),
  last_processed_at timestamptz,
  unique (memory_id, conversation_id)
);

-- Partial index over rows where rem still has work to do. The full
-- table includes already-processed rows too; this index narrows to
-- the eligibility predicate the worker actually queries with.
create index if not exists memory_conversation_eligible_idx
  on public.memory_conversation (user_id, conversation_id, last_seen_at)
  where last_processed_at is null or last_processed_at < last_seen_at;

-- Plain index for the redirect-on-merge path (UPDATE ... WHERE
-- memory_id = $old). Without this the consolidate RPC sequence-scans
-- the whole table on every merge.
create index if not exists memory_conversation_memory_idx
  on public.memory_conversation (memory_id);

alter table public.memory_conversation enable row level security;

drop policy if exists "memory_conversation is self-selectable" on public.memory_conversation;
create policy "memory_conversation is self-selectable" on public.memory_conversation
  for select using (auth.uid() = user_id);

drop policy if exists "memory_conversation is self-insertable" on public.memory_conversation;
create policy "memory_conversation is self-insertable" on public.memory_conversation
  for insert with check (auth.uid() = user_id);

drop policy if exists "memory_conversation is self-updatable" on public.memory_conversation;
create policy "memory_conversation is self-updatable" on public.memory_conversation
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists "memory_conversation is self-deletable" on public.memory_conversation;
create policy "memory_conversation is self-deletable" on public.memory_conversation
  for delete using (auth.uid() = user_id);

-- Cadence gates + run coordination for the two librarian agents.
-- Same machinery as the wiki librarian's (see that section for the
-- full rationale): a per-pass cadence stamp claimed by a global
-- SECURITY DEFINER sweep (stamp lands BEFORE the run so a crashed
-- run waits out the interval instead of retrying hot), plus ONE
-- shared holder+TTL in-flight guard covering both passes - the
-- server-side successor to the browser workers' shared
-- 'memory-librarian' lease. All four entry paths (the rem and
-- deep-sleep cron sweeps, and both Memories-panel manual-run
-- routes) take the guard; manual runs take ONLY the guard, never
-- the cadence stamp (user-driven runs don't reset the 12h clock).

alter table public.profiles
  add column if not exists deep_sleep_last_run_at timestamptz,
  add column if not exists rem_last_run_at timestamptz,
  add column if not exists memory_librarian_inflight_holder text,
  add column if not exists memory_librarian_inflight_expires_at timestamptz,
  -- Terminal outcome of the most recent manual memory-librarian run
  -- (rem or deep-sleep), persisted so any client can recover "what the
  -- last run did" after a browser reload - the live result rides a
  -- fire-and-forget Broadcast a reloaded tab never re-subscribes to.
  -- Shape: { runId, source, finishedAt, result } (the fleet result
  -- union under `result`); written by detachedManualRunHandler on
  -- completion, read on mount + via the profiles realtime UPDATE.
  add column if not exists memory_librarian_last_run_outcome jsonb;

-- Claim the next user due for a scheduled deep-sleep run, across ALL
-- users. Gated on the memory-librarian Settings toggle (only the
-- literal string 'false' disables - matching the client's `?? true`
-- default, and a cast could wedge the global sweep on one malformed
-- value). Most-overdue user first; returns their user_id or no row
-- when nobody is due. EXECUTE locked to service_role: the only
-- caller is the cron-driven venice route.
drop function if exists public.claim_deep_sleep_run(int);
drop function if exists public.claim_next_user_for_deep_sleep(int);
create or replace function public.claim_next_user_for_deep_sleep(
  p_min_interval_seconds int
) returns uuid
language sql security definer
set search_path = public as $$
  with candidate as (
    select p.user_id
      from public.profiles p
     where (p.settings->>'memoryLibrarianEnabled') is distinct from 'false'
       and (
         p.deep_sleep_last_run_at is null
         or p.deep_sleep_last_run_at
              < now() - make_interval(secs => p_min_interval_seconds)
       )
     order by p.deep_sleep_last_run_at asc nulls first
     limit 1
     for update of p skip locked
  )
  update public.profiles p
     set deep_sleep_last_run_at = now()
    from candidate c
   where p.user_id = c.user_id
  returning p.user_id;
$$;

revoke all on function public.claim_next_user_for_deep_sleep(int)
  from public, anon, authenticated;
grant execute on function public.claim_next_user_for_deep_sleep(int)
  to service_role;

-- Rem's twin of the claim above. Independent cadence column so the
-- two passes drift apart on their own 12h clocks; same toggle, same
-- posture.
drop function if exists public.claim_rem_run(int);
drop function if exists public.claim_next_user_for_rem(int);
create or replace function public.claim_next_user_for_rem(
  p_min_interval_seconds int
) returns uuid
language sql security definer
set search_path = public as $$
  with candidate as (
    select p.user_id
      from public.profiles p
     where (p.settings->>'memoryLibrarianEnabled') is distinct from 'false'
       and (
         p.rem_last_run_at is null
         or p.rem_last_run_at
              < now() - make_interval(secs => p_min_interval_seconds)
       )
     order by p.rem_last_run_at asc nulls first
     limit 1
     for update of p skip locked
  )
  update public.profiles p
     set rem_last_run_at = now()
    from candidate c
   where p.user_id = c.user_id
  returning p.user_id;
$$;

revoke all on function public.claim_next_user_for_rem(int)
  from public, anon, authenticated;
grant execute on function public.claim_next_user_for_rem(int)
  to service_role;

-- Take the shared memory-librarian in-flight guard. Returns true
-- when this holder acquired it (no current holder, or the previous
-- holder's TTL lapsed - a crashed run must not wedge both librarians
-- forever). One guard for BOTH passes on purpose: rem and deep-sleep
-- reason over the same memory rows, and two agents consolidating the
-- same neighborhood concurrently would make conflicting decisions.
-- b-strict: the venice function calls with the service-role client
-- and passes the owner id explicitly; coalesce keeps a hypothetical
-- browser caller correct.
drop function if exists public.claim_memory_librarian_inflight(text, int, uuid);
create or replace function public.claim_memory_librarian_inflight(
  p_holder_id text,
  p_ttl_seconds int,
  p_user_id uuid default null
) returns boolean
language plpgsql security invoker as $$
declare
  updated int;
begin
  update public.profiles
     set memory_librarian_inflight_holder = p_holder_id,
         memory_librarian_inflight_expires_at = now() + make_interval(secs => p_ttl_seconds)
   where user_id = coalesce(p_user_id, auth.uid())
     and (
       memory_librarian_inflight_holder is null
       or memory_librarian_inflight_expires_at is null
       or memory_librarian_inflight_expires_at < now()
     );
  get diagnostics updated = row_count;
  return updated > 0;
end $$;

grant execute on function
  public.claim_memory_librarian_inflight(text, int, uuid) to service_role;

-- Release the in-flight guard IF it is still ours. A lapsed-and-
-- stolen guard is left alone (the thief owns it now). No-op when
-- the holder doesn't match.
drop function if exists public.release_memory_librarian_inflight(text, uuid);
create or replace function public.release_memory_librarian_inflight(
  p_holder_id text,
  p_user_id uuid default null
) returns void
language sql security invoker as $$
  update public.profiles
     set memory_librarian_inflight_holder = null,
         memory_librarian_inflight_expires_at = null
   where user_id = coalesce(p_user_id, auth.uid())
     and memory_librarian_inflight_holder = p_holder_id;
$$;

grant execute on function
  public.release_memory_librarian_inflight(text, uuid) to service_role;

-- pick_rem_eligible_conversations: the conversation queue rem pulls
-- from. Returns up to p_limit conversation ids that still have
-- unprocessed memory_conversation rows, oldest first by each
-- conversation's earliest unprocessed last_seen_at - so a conversation
-- that recalled twice recently doesn't queue-jump one that recalled
-- once a long time ago.
--
-- The eligibility predicate (last_processed_at is null or
-- last_processed_at < last_seen_at) compares two columns, which
-- PostgREST's filter syntax cannot express: a .or('...lt.last_seen_at')
-- filter sends "last_seen_at" as a literal value and Postgres rejects
-- it with `invalid input syntax for type timestamp with time zone:
-- "last_seen_at"`. The comparison only reads as a column-vs-column in
-- SQL, so the query lives here. Predicate matches the partial index
-- memory_conversation_eligible_idx.
--
-- security invoker + the explicit user filter scope the read to the
-- caller and let the (user_id, conversation_id, last_seen_at) index
-- serve the query.
--
-- p_user_id: b-strict escape hatch; see search_memories_by_embedding.
-- The rem agent runs in the venice function under the service role
-- (no auth.uid()) and passes the claimed user explicitly.
drop function if exists public.pick_rem_eligible_conversations(int);
drop function if exists public.pick_rem_eligible_conversations(int, uuid);
create or replace function public.pick_rem_eligible_conversations(
  p_limit int,
  p_user_id uuid default null
) returns table (conversation_id uuid)
language sql security invoker as $$
  select mc.conversation_id
    from public.memory_conversation mc
   where mc.user_id = coalesce(p_user_id, auth.uid())
     and (mc.last_processed_at is null or mc.last_processed_at < mc.last_seen_at)
   group by mc.conversation_id
   order by min(mc.last_seen_at) asc
   limit p_limit;
$$;

grant execute on function
  public.pick_rem_eligible_conversations(int, uuid) to service_role;

-- consolidate_memories: the deep-sleep / rem agents' single content-
-- write primitive. The agent decides "memories A and B are the same
-- fact" and calls this with (survivor_id, loser_id, new_label,
-- new_data). The RPC atomically:
--
--   1. Sets the survivor's label, data, and confidence. The new
--      confidence is greatest(survivor.confidence, loser.confidence) -
--      NOT a bump via bump_memory_confidence. Two threads
--      independently producing the same fact IS corroboration, but
--      we preserve the strongest existing evidence rather than
--      manufacturing new evidence. This avoids systematic inflation
--      as memories survive repeated consolidation passes.
--
--      If future fidelity issues surface - the librarian failing to
--      consolidate because confidence drift is hiding genuine
--      duplicates - revisit by giving the librarian an explicit
--      bump path here.
--
--   2. Halves the loser's confidence (the standard invalidate
--      semantic from decay_memory_confidence). Soft-delete; the row
--      stays on disk below the search floor, recoverable if the
--      librarian later decides the consolidation was wrong.
--
--   3. Redirects memory_conversation rows from loser_id to
--      survivor_id, with on-conflict-do-nothing so the survivor's
--      existing rows in shared conversations win.
--
--   4. Redirects memory_relations edges from loser_id to survivor_id.
--      Self-loops (an edge that would now point survivor->survivor)
--      and duplicates (an edge that already exists with the survivor
--      as the same endpoint) are dropped rather than created. Both
--      memory_relations endpoints (from_memory_id and to_memory_id)
--      are redirected.
--
--   5. Touches survivor.last_librarian_visit_at so the survivor
--      doesn't immediately re-enter the deep-sleep candidate pool.
--
-- security invoker; the explicit per-row ownership checks below are
-- what gate the writes. For a browser caller RLS additionally scopes
-- every read and write; for the venice function's service-role
-- client (which bypasses RLS) the ownership checks against the
-- b-strict p_user_id are the whole guarantee - both memories rows
-- must belong to that user or the function raises.
--
-- Returns the survivor's post-update confidence so the tool can echo
-- it to the LLM.

drop function if exists public.consolidate_memories(uuid, uuid, text, text);
drop function if exists public.consolidate_memories(uuid, uuid, text, text, uuid);
create or replace function public.consolidate_memories(
  p_survivor_id uuid,
  p_loser_id uuid,
  p_new_label text,
  p_new_data text,
  p_user_id uuid default null
) returns real
language plpgsql security invoker as $$
declare
  v_caller uuid := coalesce(p_user_id, auth.uid());
  v_survivor_confidence real;
  v_loser_confidence real;
  v_max_confidence real;
  v_owner uuid;
begin
  if v_caller is null then
    raise exception 'not authenticated';
  end if;
  if p_survivor_id = p_loser_id then
    raise exception 'survivor_id and loser_id must differ';
  end if;

  -- Read both rows and confirm ownership. For browser callers RLS
  -- scopes the select; a row for another user returns null, which we
  -- treat as "not found." For the service-role caller the explicit
  -- v_owner comparison is the gate.
  select confidence, user_id into v_survivor_confidence, v_owner
    from public.memories where id = p_survivor_id;
  if v_owner is null then
    raise exception 'survivor memory % not found or not owned by caller', p_survivor_id;
  end if;
  if v_owner <> v_caller then
    raise exception 'survivor memory % is not owned by the caller', p_survivor_id;
  end if;

  select confidence, user_id into v_loser_confidence, v_owner
    from public.memories where id = p_loser_id;
  if v_owner is null then
    raise exception 'loser memory % not found or not owned by caller', p_loser_id;
  end if;
  if v_owner <> v_caller then
    raise exception 'loser memory % is not owned by the caller', p_loser_id;
  end if;

  v_max_confidence := greatest(v_survivor_confidence, v_loser_confidence);

  -- Step 1+5: rewrite the survivor's content + confidence + librarian
  -- timestamp in one update. The clear_memory_embedding_on_change
  -- trigger fires here when label/data change, which is correct -
  -- the consolidated text deserves a fresh embedding. The
  -- clear_memory_librarian_visit_on_change trigger would null
  -- last_librarian_visit_at; we set it explicitly to now() afterward
  -- in the same statement so the trigger's null doesn't leak.
  update public.memories
     set label = p_new_label,
         data = p_new_data,
         confidence = v_max_confidence,
         updated_at = now(),
         last_librarian_visit_at = now()
   where id = p_survivor_id;

  -- Step 2: halve loser confidence. Same semantic as
  -- decay_memory_confidence; inlined here so the whole consolidation
  -- is one transaction.
  update public.memories
     set confidence = confidence * 0.5
   where id = p_loser_id;

  -- Step 3: redirect memory_conversation rows. The unique
  -- constraint on (memory_id, conversation_id) would fire when the
  -- survivor and loser both already had rows for the same
  -- conversation; we drop the loser's row in that case (survivor's
  -- row wins) before the update.
  delete from public.memory_conversation
   where memory_id = p_loser_id
     and conversation_id in (
       select conversation_id from public.memory_conversation
        where memory_id = p_survivor_id
     );
  update public.memory_conversation
     set memory_id = p_survivor_id
   where memory_id = p_loser_id;

  -- Step 4: redirect memory_relations edges. Both endpoints. Drop
  -- the loser's edge BEFORE redirecting if it would create a self-
  -- loop or duplicate the survivor's edge - the unique constraint
  -- on (user_id, from_memory_id, to_memory_id, kind) would
  -- otherwise fire.
  -- from_memory_id half:
  delete from public.memory_relations
   where from_memory_id = p_loser_id
     and (
       to_memory_id = p_survivor_id  -- would become self-loop
       or exists (
         select 1 from public.memory_relations s
          where s.from_memory_id = p_survivor_id
            and s.to_memory_id = public.memory_relations.to_memory_id
            and s.kind = public.memory_relations.kind
       )
     );
  update public.memory_relations
     set from_memory_id = p_survivor_id
   where from_memory_id = p_loser_id;
  -- to_memory_id half:
  delete from public.memory_relations
   where to_memory_id = p_loser_id
     and (
       from_memory_id = p_survivor_id  -- would become self-loop
       or exists (
         select 1 from public.memory_relations s
          where s.to_memory_id = p_survivor_id
            and s.from_memory_id = public.memory_relations.from_memory_id
            and s.kind = public.memory_relations.kind
       )
     );
  update public.memory_relations
     set to_memory_id = p_survivor_id
   where to_memory_id = p_loser_id;

  return v_max_confidence;
end $$;

grant execute on function
  public.consolidate_memories(uuid, uuid, text, text, uuid)
  to service_role;

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
  -- Object key in the private `recipe-images` bucket, content-addressed
  -- as `<user_id>/<sha256>`. The byte store.
  storage_path text,
  created_at timestamptz not null default now(),
  unique (user_id, sha256)
);

-- Add storage_path for projects synced before the bucket migration, and
-- drop the retired legacy base64 `data` column (the migrate button moved
-- every row's bytes into the bucket; nothing reads or writes `data`
-- anymore). Idempotent: no-ops once the column is gone / the column
-- exists. See docs/dev/in-progress/recipe-images-storage-migration.md.
alter table public.recipe_images
  add column if not exists storage_path text;
alter table public.recipe_images
  drop column if exists data;

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

-- Private bucket for recipe-image bytes, content-addressed as
-- `<user_id>/<sha256>`. Same shape as the documents/attachments buckets:
-- public = false, self-prefix RLS on storage.objects. Idempotent.
insert into storage.buckets (id, name, public)
  values ('recipe-images', 'recipe-images', false)
  on conflict (id) do nothing;

drop policy if exists "recipe-images bucket is self-readable" on storage.objects;
create policy "recipe-images bucket is self-readable" on storage.objects
  for select to authenticated
  using (
    bucket_id = 'recipe-images'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

drop policy if exists "recipe-images bucket is self-writable" on storage.objects;
create policy "recipe-images bucket is self-writable" on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'recipe-images'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

drop policy if exists "recipe-images bucket is self-deletable" on storage.objects;
create policy "recipe-images bucket is self-deletable" on storage.objects
  for delete to authenticated
  using (
    bucket_id = 'recipe-images'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

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
-- immutable once written. Cascades from `recipe_versions` and the
-- orphan-GC sweep below (which drops a recipe_images row once its last
-- link is gone) are the only paths that remove rows.

-- Orphan reclamation: an idempotent server-side sweep (the
-- recipe-image-gc edge function + cron), NOT an AFTER DELETE trigger. The
-- old trigger could only delete the orphaned recipe_images ROW, never its
-- bucket object (SQL can't reach Storage), and never caught insert-side
-- orphans (a row upserted but never linked because the save failed). The
-- sweep reclaims BOTH orphan kinds and deletes the bucket object. Drop
-- the old trigger + function so a sync removes them.
--   See docs/dev/in-progress/recipe-images-storage-migration.md.
drop trigger if exists gc_orphan_recipe_image on public.recipe_version_images;
drop function if exists public.gc_orphan_recipe_image();

-- List a bounded batch of orphaned recipe_images (no link references
-- them), with their bucket key. Insert-side and delete-side orphans look
-- identical here (no link), so one query catches both. security definer +
-- service-role-only: cron has no user session and the sweep spans every
-- member. FOR UPDATE SKIP LOCKED so overlapping ticks don't contend.
drop function if exists public.list_orphan_recipe_images(int);
create or replace function public.list_orphan_recipe_images(p_limit int)
returns table (id uuid, storage_path text)
language sql security definer
set search_path = public as $$
  select ri.id, ri.storage_path
    from public.recipe_images ri
   where not exists (
     select 1 from public.recipe_version_images rvi where rvi.image_id = ri.id
   )
   order by ri.created_at asc
   limit p_limit
   for update of ri skip locked
$$;

-- Delete the given recipe_images rows that are STILL orphaned, returning
-- the bucket keys actually removed so the caller deletes those objects,
-- plus each row's user_id so the caller can attribute the per-user GC
-- summary in the owner's Logs drawer. The re-check (no link) closes the
-- race where a row listed as orphan gets re-linked before we delete it -
-- that row is skipped and its object kept. Content addressing makes it
-- self-healing anyway: a re-attach re-uploads the same <uid>/<sha256>
-- key. Idempotent: already-deleted ids return nothing.
drop function if exists public.delete_orphan_recipe_images(uuid[]);
create or replace function public.delete_orphan_recipe_images(p_ids uuid[])
returns table (id uuid, storage_path text, user_id uuid)
language sql security definer
set search_path = public as $$
  delete from public.recipe_images ri
   where ri.id = any(p_ids)
     and not exists (
       select 1 from public.recipe_version_images rvi where rvi.image_id = ri.id
     )
  returning ri.id, ri.storage_path, ri.user_id
$$;

revoke all on function public.list_orphan_recipe_images(int) from public, anon, authenticated;
revoke all on function public.delete_orphan_recipe_images(uuid[]) from public, anon, authenticated;
grant execute on function public.list_orphan_recipe_images(int) to service_role;
grant execute on function public.delete_orphan_recipe_images(uuid[]) to service_role;

-- Cron dispatcher for the recipe-image GC sweep. Same Vault-secret
-- custody + local-stack guards as the embed-backfill / attachment-expiry
-- crons; no-ops until the secrets are seeded.
create or replace function public.nak_trigger_recipe_image_gc()
returns void
language plpgsql security definer set search_path = public
as $fn$
declare
  v_url text;
  v_key text;
begin
  begin
    execute $q$ select decrypted_secret from vault.decrypted_secrets where name = 'project_url' $q$ into v_url;
    execute $q$ select decrypted_secret from vault.decrypted_secrets where name = 'service_role_key' $q$ into v_key;
  exception when others then
    return;
  end;
  if v_url is null or v_key is null then
    return;
  end if;
  begin
    execute format(
      $q$ select net.http_post(
            url := %L,
            headers := jsonb_build_object('Content-Type', 'application/json', 'Authorization', %L),
            body := '{}'::jsonb
          ) $q$,
      v_url || '/functions/v1/recipe-image-gc',
      'Bearer ' || v_key
    );
  exception when others then
    raise notice 'nak_trigger_recipe_image_gc: dispatch failed: %', sqlerrm;
  end;
end;
$fn$;
revoke all on function public.nak_trigger_recipe_image_gc() from public, anon, authenticated;

do $cron$
begin
  if exists (select 1 from pg_available_extensions where name = 'pg_cron')
     and exists (select 1 from pg_available_extensions where name = 'pg_net') then
    create extension if not exists pg_cron;
    create extension if not exists pg_net;
    if exists (select 1 from cron.job where jobname = 'nak-recipe-image-gc') then
      perform cron.unschedule('nak-recipe-image-gc');
    end if;
    perform cron.schedule(
      'nak-recipe-image-gc',
      '37 */6 * * *',
      $job$ select public.nak_trigger_recipe_image_gc(); $job$
    );
  end if;
exception when others then
  raise notice 'recipe-image gc cron setup skipped: %', sqlerrm;
end
$cron$;

-- Image upsert RPC. Returns the existing row's id if `(user_id,
-- sha256)` already maps to one, otherwise inserts and returns the
-- new id. Used by the client editor (user uploads) and by the
-- `recipe_photos_attach` LLM tool (copies a conversation
-- attachment into the recipe library). Two callers need the same
-- dedup semantics, so it lives in the database rather than in
-- application code.
drop function if exists public.recipe_image_upsert(text, text, int, text);
drop function if exists public.recipe_image_upsert(text, text, int, text, text);
drop function if exists public.recipe_image_upsert(text, text, int, text, uuid);
create or replace function public.recipe_image_upsert(
  p_sha256 text,
  p_mime_type text,
  p_size_bytes int,
  p_storage_path text,
  p_user_id uuid default null
) returns uuid
language plpgsql security invoker as $$
declare
  v_uid uuid := coalesce(p_user_id, auth.uid());
  v_id uuid;
begin
  if v_uid is null then raise exception 'not authenticated'; end if;
  if p_sha256 is null or length(p_sha256) <> 64 then
    raise exception 'sha256 must be a 64-char hex digest';
  end if;
  if p_storage_path is null or length(p_storage_path) = 0 then
    raise exception 'storage_path is required';
  end if;
  -- Two-step upsert that respects the table's no-update RLS posture.
  -- DO NOTHING + a follow-up SELECT for the existing id when the insert
  -- was suppressed by the (user_id, sha256) conflict. The caller has
  -- already uploaded the bytes to the content-addressed key, so on a
  -- conflict the existing row already points at the same object (or, for
  -- a legacy row, still carries `data` and is covered by dual-read until
  -- the migrate button sets its storage_path). New rows never write the
  -- legacy `data` column.
  insert into public.recipe_images
    (user_id, sha256, mime_type, size_bytes, storage_path)
    values (v_uid, p_sha256, p_mime_type, p_size_bytes, p_storage_path)
    on conflict (user_id, sha256) do nothing
    returning id into v_id;
  if v_id is null then
    select id into v_id
      from public.recipe_images
     where user_id = v_uid and sha256 = p_sha256;
  end if;
  return v_id;
end $$;

-- The one-time recipe-image migrate button (and its
-- recipe_image_set_storage_path RPC) has been removed now that every row
-- is in the bucket. Drop the RPC so a sync clears it.
drop function if exists public.recipe_image_set_storage_path(uuid, text);

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
-- p_user_id: b-strict escape hatch; see search_memories_by_embedding
-- for the full rationale.
drop function if exists public.recipe_create_with_version(
  text, text, text, text, smallint, uuid[], text[], text);
drop function if exists public.recipe_create_with_version(
  text, text, text, text, smallint, uuid[], text[], text, uuid);
create or replace function public.recipe_create_with_version(
  p_title text,
  p_cooklang text,
  p_source text,
  p_source_url text,
  p_rating smallint,
  p_image_ids uuid[],
  p_image_labels text[],
  p_change_message text,
  p_user_id uuid default null
) returns table (
  id uuid,
  title text,
  source text,
  source_url text,
  cooklang text,
  rating smallint,
  upcoming boolean,
  favorite boolean,
  topics text[],
  created_at timestamptz,
  updated_at timestamptz
)
language plpgsql security invoker as $$
declare
  v_uid uuid := coalesce(p_user_id, auth.uid());
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
           r.upcoming, r.favorite, r.topics, r.created_at, r.updated_at
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
-- p_user_id: b-strict escape hatch; see search_memories_by_embedding
-- for the full rationale.
drop function if exists public.recipe_update_with_version(
  uuid, boolean, text, boolean, text, boolean, text, boolean, text,
  boolean, smallint, boolean, uuid[], text[], text);
drop function if exists public.recipe_update_with_version(
  uuid, boolean, text, boolean, text, boolean, text, boolean, text,
  boolean, smallint, boolean, uuid[], text[], text, uuid);
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
  p_change_message text,
  p_user_id uuid default null
) returns table (
  id uuid,
  title text,
  source text,
  source_url text,
  cooklang text,
  rating smallint,
  upcoming boolean,
  favorite boolean,
  topics text[],
  created_at timestamptz,
  updated_at timestamptz
)
language plpgsql security invoker as $$
declare
  v_uid uuid := coalesce(p_user_id, auth.uid());
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
           r.upcoming, r.favorite, r.topics, r.created_at, r.updated_at
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
drop function if exists public.recipe_new_photo_version(uuid, text, uuid);
create or replace function public.recipe_new_photo_version(
  p_id uuid,
  p_change_message text,
  p_user_id uuid default null
) returns uuid
language plpgsql security invoker as $$
declare
  v_uid uuid := coalesce(p_user_id, auth.uid());
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
drop function if exists public.recipe_attach_photos(uuid, uuid[], text[], text, uuid);
create or replace function public.recipe_attach_photos(
  p_recipe_id uuid,
  p_image_ids uuid[],
  p_image_labels text[],
  p_change_message text,
  p_user_id uuid default null
) returns table (image_id uuid, "position" int, label text)
language plpgsql security invoker as $$
declare
  v_uid uuid := coalesce(p_user_id, auth.uid());
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

  v_new_version_id := public.recipe_new_photo_version(p_recipe_id, p_change_message, v_uid);

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
drop function if exists public.recipe_remove_photos(uuid, uuid[], text, uuid);
create or replace function public.recipe_remove_photos(
  p_recipe_id uuid,
  p_image_ids uuid[],
  p_change_message text,
  p_user_id uuid default null
) returns table (image_id uuid, "position" int, label text)
language plpgsql security invoker as $$
declare
  v_uid uuid := coalesce(p_user_id, auth.uid());
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

  v_new_version_id := public.recipe_new_photo_version(p_recipe_id, p_change_message, v_uid);

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
drop function if exists public.recipe_reorder_photos(uuid, uuid[], text, uuid);
create or replace function public.recipe_reorder_photos(
  p_recipe_id uuid,
  p_image_ids uuid[],
  p_change_message text,
  p_user_id uuid default null
) returns table (image_id uuid, "position" int, label text)
language plpgsql security invoker as $$
declare
  v_uid uuid := coalesce(p_user_id, auth.uid());
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

  v_new_version_id := public.recipe_new_photo_version(p_recipe_id, p_change_message, v_uid);

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
drop function if exists public.recipe_set_photo_labels(uuid, uuid[], text[], text, uuid);
create or replace function public.recipe_set_photo_labels(
  p_recipe_id uuid,
  p_image_ids uuid[],
  p_image_labels text[],
  p_change_message text,
  p_user_id uuid default null
) returns table (image_id uuid, "position" int, label text)
language plpgsql security invoker as $$
declare
  v_uid uuid := coalesce(p_user_id, auth.uid());
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

  v_new_version_id := public.recipe_new_photo_version(p_recipe_id, p_change_message, v_uid);

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

-- grocery_sections / grocery_products / grocery_list_entries ---------------
--
-- The grocery list. Two intake paths: manual adds from the Groceries
-- drawer tab, and per-ingredient checkboxes on recipes in the
-- Cookbook detail pane.
--
-- Sections are free-form, user-ordered rows. The permanent "Other"
-- section is deliberately NOT a row: products with `section_id is
-- null` render in a fixed "Other" pseudo-section. That makes Other
-- undeletable and unrenamable by construction, and lets section
-- deletion be `on delete set null` - a deleted section's products
-- fall back to Other instead of vanishing. Canned starter sections
-- are seeded lazily by the client (needs an auth context the sync
-- script doesn't have), guarded against double-seeding.
--
-- Products and list entries are split on purpose - the full rationale
-- rides the table definitions below.

create table if not exists public.grocery_sections (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  name text not null,
  -- Display order in the grocery list, lower first. The client's
  -- drag-and-drop reorder rewrites the whole per-user sequence via
  -- grocery_sections_reorder; values stay dense from 0.
  position int not null,
  created_at timestamptz not null default now()
);

create index if not exists grocery_sections_user_position_idx
  on public.grocery_sections (user_id, position);

alter table public.grocery_sections enable row level security;

drop policy if exists "grocery_sections are self-selectable" on public.grocery_sections;
create policy "grocery_sections are self-selectable" on public.grocery_sections
  for select using (auth.uid() = user_id);

drop policy if exists "grocery_sections are self-insertable" on public.grocery_sections;
create policy "grocery_sections are self-insertable" on public.grocery_sections
  for insert with check (auth.uid() = user_id);

drop policy if exists "grocery_sections are self-updatable" on public.grocery_sections;
create policy "grocery_sections are self-updatable" on public.grocery_sections
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists "grocery_sections are self-deletable" on public.grocery_sections;
create policy "grocery_sections are self-deletable" on public.grocery_sections
  for delete using (auth.uid() = user_id);

-- Atomic section reorder: set the user's section order to exactly
-- p_section_ids (position = array index). The array must be a
-- permutation of the caller's current section set - a missing or
-- foreign id is a hard error, so a stale drag can't silently drop a
-- section to the tail. security invoker: RLS scopes every row touch
-- to the caller.
create or replace function public.grocery_sections_reorder(p_section_ids uuid[])
returns void
language plpgsql security invoker as $$
declare
  v_uid uuid := auth.uid();
  v_count int;
begin
  if v_uid is null then raise exception 'not authenticated'; end if;
  select count(*) into v_count
    from public.grocery_sections where user_id = v_uid;
  if v_count <> coalesce(array_length(p_section_ids, 1), 0) then
    raise exception 'reorder must enumerate every section exactly once';
  end if;
  update public.grocery_sections s
     set position = u.ord - 1
    from unnest(p_section_ids) with ordinality as u(id, ord)
   where s.id = u.id and s.user_id = v_uid;
  if not found and v_count > 0 then
    raise exception 'reorder ids do not match any section';
  end if;
end $$;

-- The catalog / list split ------------------------------------------------
--
-- Two tables model what a single `grocery_items` table used to
-- conflate:
--
--   grocery_products      the durable catalog. One row per product
--                         VARIANT ("corn, canned, canned-goods aisle,
--                         photo"); rows live forever and carry
--                         everything that makes a variant itself
--                         (name, note, section, photo, source recipe).
--                         Same-name standalone variants coexist by
--                         design - identity is label PLUS details,
--                         never label alone.
--   grocery_list_entries  list membership as events. An OPEN entry
--                         (acquired_at is null) means "on the list
--                         right now"; buying stamps acquired_at, so
--                         the acquired history is a real purchase log
--                         (one row per buy). Un-planning a recipe
--                         ingredient deletes its open ENTRY - the
--                         product row, and with it the learned
--                         section, survives.
--
-- Quantity (`count` / `unit`) rides the entry, not the product:
-- amounts are per-add and are not part of a variant's identity.

create table if not exists public.grocery_products (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  name text not null,
  note text,
  section_id uuid references public.grocery_sections(id) on delete set null,
  -- Who decided the section. 'user' = chosen in the UI (or inherited
  -- from the pre-split schema); 'auto' = filed by the auto-sectioning
  -- agent; null = unfiled. Disambiguates `section_id is null`, which
  -- alone cannot distinguish "deliberately filed in Other"
  -- (section_source = 'user') from "not yet classified" (null) - and
  -- the classifier may only ever touch rows where it is null.
  section_source text check (section_source in ('user', 'auto')),
  -- Source recipe for checkbox-added products; null for standalone.
  -- `on delete cascade`: deleting a recipe removes its products (and
  -- their entries through the product FK). Recipe EDITS are handled
  -- by the invalidation trigger below.
  recipe_id uuid references public.recipes(id) on delete cascade,
  -- image_id (optional product photo) is added below, after the
  -- grocery_item_images table it references exists - an inline FK here
  -- would break a fresh start-to-finish apply on table order.
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Name lookups: suggestion search, revival matching, and the browse
-- pager's alphabetical ordering all key on the normalized name.
create index if not exists grocery_products_user_name_idx
  on public.grocery_products (user_id, lower(btrim(name)));

-- Reverse lookup for the invalidation trigger's delete and the
-- recipe-detail checkbox-state query.
create index if not exists grocery_products_recipe_idx
  on public.grocery_products (recipe_id) where recipe_id is not null;

alter table public.grocery_products enable row level security;

drop policy if exists "grocery_products are self-selectable" on public.grocery_products;
create policy "grocery_products are self-selectable" on public.grocery_products
  for select using (auth.uid() = user_id);

drop policy if exists "grocery_products are self-insertable" on public.grocery_products;
create policy "grocery_products are self-insertable" on public.grocery_products
  for insert with check (auth.uid() = user_id);

drop policy if exists "grocery_products are self-updatable" on public.grocery_products;
create policy "grocery_products are self-updatable" on public.grocery_products
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists "grocery_products are self-deletable" on public.grocery_products;
create policy "grocery_products are self-deletable" on public.grocery_products
  for delete using (auth.uid() = user_id);

create table if not exists public.grocery_list_entries (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  product_id uuid not null references public.grocery_products(id) on delete cascade,
  -- Free-form quantity text ("2", "1/2", "2-3"). Null = unspecified.
  -- Recipe quantities arrive verbatim from cooklang and a numeric
  -- column would mangle them; `unit` is free-form for the same reason
  -- ("package", "loaf").
  count text,
  unit text,
  added_at timestamptz not null default now(),
  -- Null = on the list now. Set = bought at that moment; the In-cart
  -- card during a shopping trip is exactly the entries acquired since
  -- the trip started, so no updated_at heuristics are involved.
  acquired_at timestamptz
);

-- At most one OPEN entry per product: "on the list" is a boolean per
-- variant, and revival must never stack duplicate open rows.
create unique index if not exists grocery_list_entries_open_uidx
  on public.grocery_list_entries (product_id) where acquired_at is null;

-- The current list is fetched whole (open entries), the purchase
-- history as a recency window.
create index if not exists grocery_list_entries_user_open_idx
  on public.grocery_list_entries (user_id) where acquired_at is null;
create index if not exists grocery_list_entries_user_acquired_idx
  on public.grocery_list_entries (user_id, acquired_at desc)
  where acquired_at is not null;

alter table public.grocery_list_entries enable row level security;

drop policy if exists "grocery_list_entries are self-selectable" on public.grocery_list_entries;
create policy "grocery_list_entries are self-selectable" on public.grocery_list_entries
  for select using (auth.uid() = user_id);

drop policy if exists "grocery_list_entries are self-insertable" on public.grocery_list_entries;
create policy "grocery_list_entries are self-insertable" on public.grocery_list_entries
  for insert with check (auth.uid() = user_id);

drop policy if exists "grocery_list_entries are self-updatable" on public.grocery_list_entries;
create policy "grocery_list_entries are self-updatable" on public.grocery_list_entries
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists "grocery_list_entries are self-deletable" on public.grocery_list_entries;
create policy "grocery_list_entries are self-deletable" on public.grocery_list_entries
  for delete using (auth.uid() = user_id);

-- Recipe-change invalidation. Ingredients are embedded in the recipe's
-- cooklang markup, not discrete rows, so products key on the
-- ingredient NAME: after an edit, a product whose normalized name
-- still parses out of the new source is the same ingredient (its
-- learned section, note, and photo stay valid); one whose name is
-- gone was renamed or removed and is dropped, entries cascading with
-- it. Amount-only edits change no names and delete nothing.
--
-- A trigger (rather than client-side cleanup) covers every write path
-- uniformly: the Cookbook modal, the server-dispatched recipe_update
-- LLM tool, and revert all funnel through an UPDATE on recipes.
-- Fires only when `cooklang` actually changed - bookmark toggles,
-- rating changes, and title/source edits leave the ingredient list
-- intact, so they leave the grocery list intact too. Recipe DELETEs
-- are covered by the FK cascade, not this trigger.
--
-- Name extraction mirrors the client parser's ingredient tokens
-- (src/lib/cooklang.ts): strip [- block -] and `--` line comments,
-- then take every `@name` / `@?name` / `@multi word name{...}` token.
-- Two deliberate divergences, both on the safe side:
--   - This is the union of @-tokens ANYWHERE in the source, while the
--     client's checkbox list narrows to declaration lines when a
--     recipe uses declaration blocks. A kept-but-unlisted product is
--     benign (it simply has no checkbox); a wrongly-deleted one
--     destroys the user's learned section. Supersets only ever keep
--     more.
--   - POSIX classes ([:alnum:]) stand in for the client's \p{L}\p{N};
--     both are Unicode-aware over a UTF-8 database.
-- tests/grocery-list.test.ts runs this exact regex (mirrored in JS)
-- against parseCooklang across sample recipes so drift fails the gate.
create or replace function public.clear_stale_grocery_products_on_recipe_change()
returns trigger language plpgsql as $$
declare
  v_src text;
begin
  if new.cooklang is distinct from old.cooklang then
    v_src := regexp_replace(coalesce(new.cooklang, ''), '\[-.*?-\]', '', 'g');
    v_src := regexp_replace(v_src, '--[^\n]*', '', 'g');
    delete from public.grocery_products p
     where p.recipe_id = new.id
       and lower(btrim(p.name)) not in (
         select lower(btrim(coalesce(m[1], m[2])))
           from regexp_matches(
             v_src,
             '@\??(?:((?:[[:alnum:]_''-]+|\([^)]*\))(?:[ \t](?:[[:alnum:]_''-]+|\([^)]*\)))*)\{[^}]*\}|([[:alnum:]_''-]+))',
             'g'
           ) as m
       );
  end if;
  return new;
end $$;

drop trigger if exists clear_grocery_items_on_recipe_change on public.recipes;
drop function if exists public.clear_grocery_items_on_recipe_change();
drop trigger if exists clear_stale_grocery_products_on_recipe_change on public.recipes;
create trigger clear_stale_grocery_products_on_recipe_change
  after update on public.recipes
  for each row execute function public.clear_stale_grocery_products_on_recipe_change();

-- Retired: grocery_section_prefs -------------------------------------------
--
-- The pre-split schema kept a name-keyed section memory
-- (grocery_section_prefs + fill/remember triggers) because item rows
-- were deleted freely and took their learned section with them. With
-- the catalog split, product rows ARE the memory - they live forever
-- and carry their section - and a name-keyed side-table is actively
-- wrong for the variant model (it can hold only one section per
-- name, so "canned corn" and "fresh corn" would fight over it). The
-- drops are unconditional so deployed databases converge; fresh
-- installs no-op. The triggers targeted the old grocery_items table
-- (dropped by the backfill below), so only the functions and the
-- table need explicit cleanup.
drop function if exists public.fill_grocery_section_from_pref() cascade;
drop function if exists public.remember_grocery_section_pref() cascade;
drop table if exists public.grocery_section_prefs;

-- grocery_item_images ------------------------------------------------------
--
-- Product photos for grocery items (a brand label the shopper wants to
-- match, etc.). Direct clone of `recipe_images`: content-addressed
-- bytes in a private bucket, one metadata row per (user_id, sha256),
-- rows immutable (byte changes mean a different sha, which means a
-- different row). Unlike recipe photos there is no link table - an
-- product has at most one photo via `grocery_products.image_id`, and the
-- same image row may be shared by several items (the dedup upsert
-- returns the existing id).

create table if not exists public.grocery_item_images (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  -- Hex-encoded SHA-256 of the raw bytes, computed client-side via
  -- Web Crypto before upload so the upsert can dedup.
  sha256 text not null,
  mime_type text not null,
  size_bytes int not null,
  -- Object key in the private `grocery-item-images` bucket,
  -- content-addressed as `<user_id>/<sha256>`.
  storage_path text not null,
  created_at timestamptz not null default now(),
  unique (user_id, sha256)
);

alter table public.grocery_item_images enable row level security;

drop policy if exists "grocery_item_images are self-selectable" on public.grocery_item_images;
create policy "grocery_item_images are self-selectable" on public.grocery_item_images
  for select using (auth.uid() = user_id);

drop policy if exists "grocery_item_images are self-insertable" on public.grocery_item_images;
create policy "grocery_item_images are self-insertable" on public.grocery_item_images
  for insert with check (auth.uid() = user_id);

-- No update policy - rows are immutable once written.
drop policy if exists "grocery_item_images are self-deletable" on public.grocery_item_images;
create policy "grocery_item_images are self-deletable" on public.grocery_item_images
  for delete using (auth.uid() = user_id);

-- Private bucket for grocery-item photo bytes, content-addressed as
-- `<user_id>/<sha256>`. Same shape + self-prefix RLS as recipe-images.
insert into storage.buckets (id, name, public)
  values ('grocery-item-images', 'grocery-item-images', false)
  on conflict (id) do nothing;

drop policy if exists "grocery-item-images bucket is self-readable" on storage.objects;
create policy "grocery-item-images bucket is self-readable" on storage.objects
  for select to authenticated
  using (
    bucket_id = 'grocery-item-images'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

drop policy if exists "grocery-item-images bucket is self-writable" on storage.objects;
create policy "grocery-item-images bucket is self-writable" on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'grocery-item-images'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

drop policy if exists "grocery-item-images bucket is self-deletable" on storage.objects;
create policy "grocery-item-images bucket is self-deletable" on storage.objects
  for delete to authenticated
  using (
    bucket_id = 'grocery-item-images'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

-- Optional product photo, at most one per product. Declared here (not
-- inline in the grocery_products create) because this table is created
-- after grocery_products in file order. `set null` (not cascade) so
-- GC-ing an image row never deletes the product it decorated. The
-- images table keeps its historical grocery_item_images name: its
-- rows are content-addressed into the `grocery-item-images` bucket by
-- stored storage_path, and renaming table + bucket buys nothing.
alter table public.grocery_products
  add column if not exists image_id uuid
    references public.grocery_item_images(id) on delete set null;

-- Reverse lookup for the orphan sweep's anti-join and the FK's
-- on-delete-set-null resolution.
create index if not exists grocery_products_image_idx
  on public.grocery_products (image_id) where image_id is not null;

-- One-time backfill from the pre-split grocery_items table. Guarded
-- on that table's existence, so a database that has already migrated
-- (or a fresh install that never had it) no-ops. Sits here, after
-- grocery_products.image_id exists, because the copy carries the
-- photo link. Mapping:
--   - every item row becomes a product with the same id (so image
--     references and any external row references stay valid);
--   - section_source is 'user' for filed rows - pre-split sections
--     were user-chosen or inherited from the user's own prefs, both
--     user-shaped - and null (unfiled) for section-less rows;
--   - each row gets exactly one entry carrying its count/unit:
--     needed rows an OPEN entry, acquired rows an entry stamped with
--     updated_at, the closest thing the old model had to a purchase
--     timestamp (the needed flip was the last write in the common
--     case).
-- The old table is dropped at the end, which is also what removes it
-- from the realtime publication and drops its indexes and policies.
do $$
begin
  if exists (
    select 1 from information_schema.tables
    where table_schema = 'public' and table_name = 'grocery_items'
  ) then
    insert into public.grocery_products
      (id, user_id, name, note, section_id, section_source, recipe_id,
       image_id, created_at, updated_at)
    select id, user_id, name, note, section_id,
           case when section_id is not null then 'user' end,
           recipe_id, image_id, created_at, updated_at
      from public.grocery_items
    on conflict (id) do nothing;
    insert into public.grocery_list_entries
      (user_id, product_id, count, unit, added_at, acquired_at)
    select user_id, id, count, unit, created_at,
           case when needed then null else updated_at end
      from public.grocery_items;
    drop table public.grocery_items;
  end if;
end $$;

-- Read model for every grocery client surface: each product flattened
-- with its CURRENT entry (the open one when the product is on the
-- list, else the most recent purchase), the source recipe's title,
-- and the photo's storage path. One view instead of per-surface
-- PostgREST embeds so the panel list, the acquired-history window,
-- the sidebar browse pager, the add-input suggestions, and the
-- recipe-checkbox sync all page and filter server-side against the
-- same flat columns. security_invoker so the base tables' RLS
-- applies to the querying user; declared after the backfill because
-- it reads grocery_products.image_id, which exists only from that
-- point in file order. Dropped and recreated (not `or replace`) so a
-- column change never trips postgres's "cannot change view columns"
-- error on re-apply.
--
--   on_list      true when an open entry exists.
--   entry_id     the current entry (null only for a product with no
--                entries at all - e.g. a recipe ingredient that was
--                un-planned).
--   count/unit   the current entry's quantity.
--   acquired_at  the current entry's purchase time; null while open.
--                The In-cart split during a shopping trip is
--                `acquired_at >= trip start`, client-side.
drop view if exists public.grocery_products_view;
create view public.grocery_products_view
with (security_invoker = true) as
select p.id, p.user_id, p.name, p.note, p.section_id, p.section_source,
       p.recipe_id, p.image_id, p.created_at, p.updated_at,
       r.title as recipe_title,
       img.storage_path as image_storage_path,
       ce.id as entry_id,
       ce.count, ce.unit, ce.acquired_at,
       (ce.id is not null and ce.acquired_at is null) as on_list
  from public.grocery_products p
  left join public.recipes r on r.id = p.recipe_id
  left join public.grocery_item_images img on img.id = p.image_id
  left join lateral (
    select e.id, e.count, e.unit, e.acquired_at
      from public.grocery_list_entries e
     where e.product_id = p.id
     -- Open entry first (there is at most one, by the partial unique
     -- index), else newest purchase.
     order by (e.acquired_at is null) desc, e.acquired_at desc
     limit 1
  ) ce on true;

grant select on public.grocery_products_view to authenticated;

-- Image upsert RPC, twin of recipe_image_upsert: returns the existing
-- row's id when (user_id, sha256) already maps to one, otherwise
-- inserts and returns the new id. Lives in the database so any future
-- second caller inherits the same dedup semantics.
drop function if exists public.grocery_item_image_upsert(text, text, int, text);
create or replace function public.grocery_item_image_upsert(
  p_sha256 text,
  p_mime_type text,
  p_size_bytes int,
  p_storage_path text
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
  if p_storage_path is null or length(p_storage_path) = 0 then
    raise exception 'storage_path is required';
  end if;
  -- DO NOTHING + follow-up SELECT respects the table's no-update RLS
  -- posture; the caller uploaded the bytes to the content-addressed
  -- key first, so on conflict the existing row points at the same
  -- object already.
  insert into public.grocery_item_images
    (user_id, sha256, mime_type, size_bytes, storage_path)
    values (v_uid, p_sha256, p_mime_type, p_size_bytes, p_storage_path)
    on conflict (user_id, sha256) do nothing
    returning id into v_id;
  if v_id is null then
    select id into v_id
      from public.grocery_item_images
     where user_id = v_uid and sha256 = p_sha256;
  end if;
  return v_id;
end $$;

-- Orphan reclamation for grocery-item images: same sweep shape as
-- recipe-image-gc (edge function + cron; SQL can't delete Storage
-- objects). An image row is orphaned when no
-- grocery_products.image_id references it - covers both delete-side
-- orphans (product deleted or re-photographed) and insert-side
-- orphans (upserted but the product save failed).
drop function if exists public.list_orphan_grocery_item_images(int);
create or replace function public.list_orphan_grocery_item_images(p_limit int)
returns table (id uuid, storage_path text)
language sql security definer
set search_path = public as $$
  select gi.id, gi.storage_path
    from public.grocery_item_images gi
   where not exists (
     select 1 from public.grocery_products it where it.image_id = gi.id
   )
   order by gi.created_at asc
   limit p_limit
   for update of gi skip locked
$$;

-- Delete the given rows that are STILL orphaned, returning the bucket
-- keys actually removed plus each row's user_id for the per-user GC
-- summary. The re-check closes the race where a listed orphan gets
-- re-referenced before the delete; content addressing makes a missed
-- object self-healing (re-attach re-uploads the same key).
drop function if exists public.delete_orphan_grocery_item_images(uuid[]);
create or replace function public.delete_orphan_grocery_item_images(p_ids uuid[])
returns table (id uuid, storage_path text, user_id uuid)
language sql security definer
set search_path = public as $$
  delete from public.grocery_item_images gi
   where gi.id = any(p_ids)
     and not exists (
       select 1 from public.grocery_products it where it.image_id = gi.id
     )
  returning gi.id, gi.storage_path, gi.user_id
$$;

revoke all on function public.list_orphan_grocery_item_images(int) from public, anon, authenticated;
revoke all on function public.delete_orphan_grocery_item_images(uuid[]) from public, anon, authenticated;
grant execute on function public.list_orphan_grocery_item_images(int) to service_role;
grant execute on function public.delete_orphan_grocery_item_images(uuid[]) to service_role;

-- Cron dispatcher for the grocery-image GC sweep. Same Vault-secret
-- custody + local-stack guards as the other GC crons; no-ops until the
-- secrets are seeded.
create or replace function public.nak_trigger_grocery_image_gc()
returns void
language plpgsql security definer set search_path = public
as $fn$
declare
  v_url text;
  v_key text;
begin
  begin
    execute $q$ select decrypted_secret from vault.decrypted_secrets where name = 'project_url' $q$ into v_url;
    execute $q$ select decrypted_secret from vault.decrypted_secrets where name = 'service_role_key' $q$ into v_key;
  exception when others then
    return;
  end;
  if v_url is null or v_key is null then
    return;
  end if;
  begin
    execute format(
      $q$ select net.http_post(
            url := %L,
            headers := jsonb_build_object('Content-Type', 'application/json', 'Authorization', %L),
            body := '{}'::jsonb
          ) $q$,
      v_url || '/functions/v1/grocery-image-gc',
      'Bearer ' || v_key
    );
  exception when others then
    raise notice 'nak_trigger_grocery_image_gc: dispatch failed: %', sqlerrm;
  end;
end;
$fn$;
revoke all on function public.nak_trigger_grocery_image_gc() from public, anon, authenticated;

do $cron$
begin
  if exists (select 1 from pg_available_extensions where name = 'pg_cron')
     and exists (select 1 from pg_available_extensions where name = 'pg_net') then
    create extension if not exists pg_cron;
    create extension if not exists pg_net;
    if exists (select 1 from cron.job where jobname = 'nak-grocery-image-gc') then
      perform cron.unschedule('nak-grocery-image-gc');
    end if;
    perform cron.schedule(
      'nak-grocery-image-gc',
      '49 */6 * * *',
      $job$ select public.nak_trigger_grocery_image_gc(); $job$
    );
  end if;
exception when others then
  raise notice 'grocery-image gc cron setup skipped: %', sqlerrm;
end
$cron$;

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

-- Recipe topic-tagging pipeline -----------------------------------------
--
-- Same shape as memories.topics (see "Memory topic-tagging pipeline"
-- above): the recipe-topics agent
-- (supabase/functions/venice/agents/recipe_topics.ts) tags each recipe
-- with a short flat set of topic strings so the Cookbook drawer can
-- offer a topic filter. The agent reads title + cooklang
-- plus the user's existing recipe-topic vocabulary and picks 1-6
-- topics across four dimensions - primary ingredients, cuisine,
-- course, technique - reusing existing names where they fit so the
-- dropdown vocabulary stays small and stable.
--
-- Cap is higher than threads (4) and memories (4) because recipes
-- legitimately span more dimensions: "chicken tikka masala" wants
-- to surface under chicken, indian, dinner, and curry without
-- forcing the model to drop three of the four. The trade-off is the
-- pill row gets denser; the user can clear individual pills if it
-- becomes noisy.
alter table public.recipes
  add column if not exists topics text[] not null default '{}',
  add column if not exists last_topics_at timestamptz,
  add column if not exists topics_claim_holder text,
  add column if not exists topics_claim_expires timestamptz;

create index if not exists recipes_topics_gin_idx
  on public.recipes using gin (topics);

create index if not exists recipes_topics_claim_idx
  on public.recipes (topics_claim_expires)
  where topics_claim_holder is not null;

-- Re-queue a recipe for tagging whenever ANY of the recipe's own data
-- changes - title, cooklang, source, source_url, rating, the bookmark
-- flags. We detect "anything changed" by comparing the whole OLD and
-- NEW rows rather than naming a column subset, so a future column is
-- covered without revisiting this trigger.
--
-- The exception that makes this safe is the mask below: before the
-- comparison we copy NEW's async-pipeline bookkeeping columns over
-- OLD's, so churn confined to those columns reads as "no change."
-- Two pipelines write them as background machinery, not recipe edits:
--
--   - The topic columns (topics / last_topics_at / topics_claim_*)
--     are written by THIS pipeline's own claim + save RPCs. Without
--     the mask, save_recipe_topics_if_claimed setting topics would
--     look like a change and re-queue the row it just tagged, forever.
--     This is the recursion guard.
--   - The embedding columns (embedding / embedding_model /
--     embedding_claim_*) are written by the embeddings worker. An
--     embedding compute or claim is not a recipe edit, so masking
--     them keeps the embeddings pipeline from churning the tags every
--     time it touches a row.
create or replace function public.clear_recipe_topics_on_change()
  returns trigger language plpgsql as $$
declare
  old_cmp public.recipes;
begin
  old_cmp := old;
  old_cmp.topics := new.topics;
  old_cmp.last_topics_at := new.last_topics_at;
  old_cmp.topics_claim_holder := new.topics_claim_holder;
  old_cmp.topics_claim_expires := new.topics_claim_expires;
  old_cmp.embedding := new.embedding;
  old_cmp.embedding_model := new.embedding_model;
  old_cmp.embedding_claim_holder := new.embedding_claim_holder;
  old_cmp.embedding_claim_expires := new.embedding_claim_expires;

  if new is distinct from old_cmp then
    new.topics := '{}'::text[];
    new.last_topics_at := null;
    new.topics_claim_holder := null;
    new.topics_claim_expires := null;
  end if;
  return new;
end $$;

drop trigger if exists clear_recipe_topics_on_change on public.recipes;
create trigger clear_recipe_topics_on_change
  before update on public.recipes
  for each row execute function public.clear_recipe_topics_on_change();

-- Claim the next recipe whose embedding is null or whose prior claim
-- has expired. Same skip-locked fairness and claim shape as the wiki
-- pipeline. Returns (id, title, source, cooklang) so the worker can
-- build the embedding input without a second round-trip.
drop function if exists public.claim_next_pending_recipe(text, int);
-- Global service-definer sweep, same shape as claim_next_pending_memory:
-- no auth.uid() filter, owner-privileged, EXECUTE locked to service_role below.
create or replace function public.claim_next_pending_recipe(
  p_holder_id text,
  p_ttl_seconds int
) returns table (id uuid, title text, source text, cooklang text, user_id uuid)
language sql security definer
set search_path = public as $$
  with candidate as (
    select r.id
      from public.recipes r
     where r.embedding is null
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
  returning r.id, r.title, r.source, r.cooklang, r.user_id;
$$;

drop function if exists public.save_recipe_embedding_if_claimed(uuid, text, vector, text);
create or replace function public.save_recipe_embedding_if_claimed(
  p_id uuid,
  p_holder_id text,
  p_embedding vector(2048),
  p_embedding_model text
) returns boolean
language plpgsql security definer
set search_path = public as $$
declare
  updated int;
begin
  update public.recipes
     set embedding = p_embedding,
         embedding_model = p_embedding_model,
         embedding_claim_holder = null,
         embedding_claim_expires = null
   where id = p_id
     and embedding_claim_holder = p_holder_id
     and embedding_claim_expires > now();
  get diagnostics updated = row_count;
  return updated > 0;
end $$;

-- Service-role only - see the note on the memory pair.
revoke all on function public.claim_next_pending_recipe(text, int) from public, anon, authenticated;
revoke all on function public.save_recipe_embedding_if_claimed(uuid, text, vector, text) from public, anon, authenticated;
grant execute on function public.claim_next_pending_recipe(text, int) to service_role;
grant execute on function public.save_recipe_embedding_if_claimed(uuid, text, vector, text) to service_role;

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
  topics text[],
  created_at timestamptz,
  updated_at timestamptz,
  similarity real
)
language sql stable security invoker as $$
  -- `topics` rides the return row so the Cookbook drawer's topic
  -- filter can be applied client-side over semantic hits without a
  -- second round trip. Tiny per-row overhead (1-6 short strings),
  -- well under the noise floor at recipe scale.
  select id, title, source, source_url, cooklang, rating,
         upcoming, favorite, topics, created_at, updated_at,
         (1 - (embedding <=> query_embedding))::real as similarity
    from public.recipes
   where user_id = auth.uid()
     and embedding is not null
   order by embedding <=> query_embedding asc
   limit match_limit
$$;

-- worker_leases: removed -----------------------------------------------------
--
-- The per-user per-worker-kind singleton lease coordinated the browser
-- Web Worker fleet (one device at a time per kind). The whole fleet
-- runs server-side in the venice function now, where the per-row claim
-- columns (substrate / threads / compound-summary and friends) are the
-- only mutual exclusion needed - cron ticks and turn tails don't race
-- the way two open tabs did. Idempotent teardown so databases that
-- synced the lease era drop their footprint on the next apply; the
-- pre-generalisation embedding-era names ride along.
drop function if exists public.acquire_worker_lease(text, text, int);
drop function if exists public.heartbeat_worker_lease(text, text, int);
drop function if exists public.release_worker_lease(text, text);
drop function if exists public.acquire_embedding_lease(text, int);
drop function if exists public.heartbeat_embedding_lease(text, int);
drop function if exists public.release_embedding_lease(text);
drop table if exists public.worker_leases cascade;
drop table if exists public.embedding_worker_leases cascade;

-- Claim the next pending memory atomically. The CTE picks one unclaimed
-- or expired-claim row using `for update skip locked`, which is the
-- Postgres queue pattern — concurrent claimers (shouldn't happen under
-- the lease invariant, but defensive) walk past a row another claimer
-- has locked instead of contending. The outer UPDATE stamps the claim
-- and returns the row contents so the worker can embed without a second
-- round trip.
drop function if exists public.claim_next_pending_memory(text, int);
-- Claim the next memory needing an embedding, GLOBALLY across every member.
-- `security definer` (runs as the owner, postgres) with no auth.uid() filter:
-- the cron backfill has no user session, so it sweeps all users' pending rows.
-- The EXECUTE grant below is the security boundary - see the revoke/grant.
create or replace function public.claim_next_pending_memory(
  p_holder_id text,
  p_ttl_seconds int
) returns table (id uuid, label text, data text, user_id uuid)
language sql security definer
set search_path = public as $$
  with candidate as (
    select m.id
      from public.memories m
     where m.embedding is null
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
  returning m.id, m.label, m.data, m.user_id;
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
language plpgsql security definer
set search_path = public as $$
declare
  updated int;
begin
  update public.memories
     set embedding = p_embedding,
         embedding_model = p_embedding_model,
         embedding_claim_holder = null,
         embedding_claim_expires = null
   where id = p_id
     and embedding_claim_holder = p_holder_id
     and embedding_claim_expires > now();
  get diagnostics updated = row_count;
  return updated > 0;
end $$;

-- Lock the embedding claim/save pair to the service role. These run as the
-- definer (postgres) with no per-user filter, so leaving EXECUTE open to
-- `authenticated` would let any signed-in member claim and read another
-- member's memory text. Only the edge function (service role) drives backfill.
revoke all on function public.claim_next_pending_memory(text, int) from public, anon, authenticated;
revoke all on function public.save_memory_embedding_if_claimed(uuid, text, vector, text) from public, anon, authenticated;
grant execute on function public.claim_next_pending_memory(text, int) to service_role;
grant execute on function public.save_memory_embedding_if_claimed(uuid, text, vector, text) to service_role;

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
-- `p_user_id` is the b-strict service-role escape hatch (see
-- docs/dev/edge-function-auth.md). Browser callers pass nothing and
-- rely on `auth.uid()` for user scoping; the streaming function calls
-- this with the validated userId so a service-role admin client can
-- still get user-scoped results without RLS context. coalesce makes
-- the parameter optional and backward-compatible. A malicious browser
-- caller cannot escalate via this parameter because RLS on the
-- underlying tables (SECURITY INVOKER preserves the calling user's
-- RLS) still gates row visibility to the calling user's own data.
drop function if exists public.search_memories_by_embedding(vector, int);
drop function if exists public.search_memories_by_embedding(vector, int, uuid);
create or replace function public.search_memories_by_embedding(
  query_embedding vector(2048),
  match_limit int,
  p_user_id uuid default null
) returns table (
  id uuid,
  label text,
  data text,
  confidence real,
  topics text[],
  created_at timestamptz,
  updated_at timestamptz
)
language sql stable security invoker as $$
  -- `topics` rides the return row so the Memories drawer's topic filter
  -- can be applied client-side over semantic hits without a second
  -- round trip. The array is small (1-4 short strings per row), so the
  -- wire-size cost vs the pre-topics shape is negligible at the per-
  -- query row counts we run.
  select id, label, data, confidence, topics, created_at, updated_at
    from public.memories
   where user_id = coalesce(p_user_id, auth.uid())
     and embedding is not null
     and confidence >= 0.05
   order by (1 - (embedding <=> query_embedding))
          * (1 + 0.15 * ln(1 + confidence)) desc
   limit match_limit
$$;

-- Scored sibling of search_memories_by_embedding. Same ranking formula,
-- but returns the boosted similarity score alongside each row so the
-- caller can threshold in application code. Used by the opening-turn
-- memory-recall priming in chat/loop.ts, which needs a minimum-score
-- gate to avoid injecting noise on turns that don't actually look like
-- anything the user's memories cover. Kept as a separate function so
-- the main memory_search path (and the Memories browser) stays on the
-- unscored RPC and doesn't have to care about a column it never uses.
-- Also used by the deep-sleep librarian's neighbor fetch in the venice
-- function, which is why it carries the p_user_id b-strict escape
-- hatch (see search_memories_by_embedding above).
drop function if exists public.search_memories_by_embedding_scored(vector, int);
drop function if exists public.search_memories_by_embedding_scored(vector, int, uuid);
create or replace function public.search_memories_by_embedding_scored(
  query_embedding vector(2048),
  match_limit int,
  p_user_id uuid default null
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
   where user_id = coalesce(p_user_id, auth.uid())
     and embedding is not null
     and confidence >= 0.05
   order by (1 - (embedding <=> query_embedding))
          * (1 + 0.15 * ln(1 + confidence)) desc
   limit match_limit
$$;

grant execute on function
  public.search_memories_by_embedding_scored(vector, int, uuid)
  to service_role;

-- Neighbours of one memory: the top-k other memories most similar to a
-- given source row, used by the Memories detail panel's "Similar
-- memories" disclosure. The source row's own stored embedding is the
-- query vector, so this is the same boosted-cosine ranking
-- search_memories_by_embedding uses - just keyed off a memory id
-- instead of a client-supplied vector. Keeping it server-side means the
-- 2048-float embedding never has to ship to the client and back just to
-- find a memory's neighbours.
--
-- The source row is excluded by id (`m.id <> p_memory_id`) so a memory
-- never lists itself as its own nearest neighbour. When the source has
-- no embedding yet (the worker hasn't reached a just-written row), the
-- cross join against `src` yields no rows and the caller renders an
-- empty state rather than erroring. `confidence >= 0.05` mirrors the
-- other search RPCs: rows the reflection agent has decayed into
-- oblivion stay hidden.
--
-- `similarity` rides the return row so the disclosure can show each
-- neighbour's match score in a pill. It is the same boosted-cosine value
-- the ORDER BY ranks on (raw cosine similarity times the bounded
-- confidence boost), so the displayed numbers are monotonic with the
-- list order - a higher pill never sorts below a lower one. The boost
-- multiplier tops out around 1.36, so the value can edge above 1.0 for a
-- near-identical, highly-corroborated neighbour.
drop function if exists public.search_memories_similar(uuid, int);
create or replace function public.search_memories_similar(
  p_memory_id uuid,
  match_limit int
) returns table (
  id uuid,
  label text,
  data text,
  confidence real,
  topics text[],
  created_at timestamptz,
  updated_at timestamptz,
  similarity real
)
language sql stable security invoker as $$
  select m.id, m.label, m.data, m.confidence, m.topics,
         m.created_at, m.updated_at,
         ((1 - (m.embedding <=> src.embedding))
           * (1 + 0.15 * ln(1 + m.confidence)))::real as similarity
    from public.memories m
   cross join (
     select embedding
       from public.memories
      where id = p_memory_id
        and user_id = auth.uid()
   ) src
   where m.user_id = auth.uid()
     and m.embedding is not null
     and src.embedding is not null
     and m.id <> p_memory_id
     and m.confidence >= 0.05
   order by (1 - (m.embedding <=> src.embedding))
          * (1 + 0.15 * ln(1 + m.confidence)) desc
   limit match_limit
$$;

-- Thread response claim --------------------------------------------------
--
-- Cross-device coordination for "one device is currently producing the
-- assistant response to this thread." When tab A starts a chat turn it
-- acquires the claim via acquire_thread_response_claim; tab B (or the
-- user's other device) viewing the same thread sees the claim row via
-- the regular threads realtime subscription and renders a
-- "responding on another device" indicator instead of letting the user
-- send a competing message. When A's runExchange finishes (or aborts),
-- release_thread_response_claim clears the claim and B's UI re-enables.
--
-- The claim is per-THREAD: each thread has at most one in-flight
-- response across all of the user's devices; multiple threads can be
-- responding in parallel (their claims live on different rows).
--
-- TTL is 60s and the holder beats every 20s (see ThreadClaimCoordinator
-- in src/lib/exchange/thread-claim-coordinator.ts) - three heartbeat
-- attempts per expiry, since chat turns legitimately run long on slow
-- models. A device that crashes mid-turn frees
-- its claim within 60s.
--
-- Columns piggyback on `threads` rather than living in a separate table
-- so the existing threads realtime subscription (subscribeToThreads in
-- supabase.ts) delivers claim changes to observers for free - no new
-- subscription wiring on the client.
alter table public.threads
  add column if not exists response_holder_id text,
  add column if not exists response_claim_expires_at timestamptz;

-- Server-side "a streaming turn is running against this thread" stamp.
-- Written by the venice /stream orchestrator at turn entry (before the
-- priming stage runs) and cleared in its terminal finally. Exists
-- because the streaming assistant row - the other in-flight signal -
-- is only created at the first content delta, which leaves the whole
-- priming window (and any long reasoning-only stretch) invisible to
-- the reconnect probe: a page refresh during that window found nothing
-- to re-attach to and fell through to the "response was interrupted"
-- retry banners even though the turn was still running server-side.
-- The reconnect probe (resolveStreamContext in
-- supabase/functions/venice/index.ts) treats a fresh stamp as
-- in-flight when no streaming row exists yet; the browser reads it
-- through the regular threads realtime subscription, same as the
-- response-claim columns above.
alter table public.threads
  add column if not exists stream_started_at timestamptz;

-- Claim-lookup index. Partial on `response_holder_id is not null` so
-- the index only carries live claims - the steady state has 0 rows
-- claimed and a partial index stays tiny under that. Same shape as
-- the reflection-claim index above.
create index if not exists threads_response_claim_idx
  on public.threads (response_claim_expires_at)
  where response_holder_id is not null;

-- Try to take the response claim on a specific thread. Returns true iff
-- we hold it after the call. Atomic via the WHERE on the UPDATE: the
-- write only lands if the row was either unclaimed, ours already
-- (harmless refresh), or carrying an expired claim. The threads RLS
-- already scopes by user_id = auth.uid(); the inner guard is belt-and-
-- braces in case a future RLS change widens the policy.
drop function if exists public.acquire_thread_response_claim(uuid, text, int);
create or replace function public.acquire_thread_response_claim(
  p_thread_id uuid,
  p_holder_id text,
  p_ttl_seconds int
) returns boolean
language plpgsql security invoker as $$
declare
  updated int;
begin
  update public.threads
     set response_holder_id = p_holder_id,
         response_claim_expires_at = now() + make_interval(secs => p_ttl_seconds)
   where id = p_thread_id
     and user_id = auth.uid()
     and (
       response_holder_id is null
       or response_holder_id = p_holder_id
       or response_claim_expires_at < now()
     );
  get diagnostics updated = row_count;
  return updated > 0;
end $$;

-- Extend our claim if we still own it. Returns false when our claim has
-- already been taken over by someone else (or the thread has been
-- deleted) - in that case the chat-loop must abort immediately rather
-- than keep streaming on a turn it no longer has the right to produce.
drop function if exists public.heartbeat_thread_response_claim(uuid, text, int);
create or replace function public.heartbeat_thread_response_claim(
  p_thread_id uuid,
  p_holder_id text,
  p_ttl_seconds int
) returns boolean
language plpgsql security invoker as $$
declare
  updated int;
begin
  update public.threads
     set response_claim_expires_at = now() + make_interval(secs => p_ttl_seconds)
   where id = p_thread_id
     and user_id = auth.uid()
     and response_holder_id = p_holder_id
     and response_claim_expires_at > now();
  get diagnostics updated = row_count;
  return updated > 0;
end $$;

-- Explicit release - used on graceful end-of-turn (success, abort,
-- error) so observer devices re-enable their composer instantly rather
-- than waiting for the TTL. Returns void: a release call when we don't
-- hold the claim (already taken over, or never acquired) is a no-op.
drop function if exists public.release_thread_response_claim(uuid, text);
create or replace function public.release_thread_response_claim(
  p_thread_id uuid,
  p_holder_id text
) returns void
language plpgsql security invoker as $$
begin
  update public.threads
     set response_holder_id = null,
         response_claim_expires_at = null
   where id = p_thread_id
     and user_id = auth.uid()
     and response_holder_id = p_holder_id;
end $$;

-- Stream-row janitor (server-side sweep) ---------------------------------
--
-- The function's normal terminal paths (commit_assistant_message on
-- success; the catch/finally block on error/abort/wall-timeout) flip
-- the streaming row's status away from 'streaming'. A row left in
-- status='streaming' past the wall-deadline ceiling means the function
-- was killed externally - Edge Runtime CPU/memory cap, gateway 502
-- mid-round, EdgeRuntime.waitUntil yanked before the finally block
-- could run - and no terminal path executed to write last_error.
--
-- The /stream reconnect probe in supabase/functions/venice/index.ts
-- catches this on the NEXT user-driven /stream call. This cron sweep
-- catches the same shape unconditionally, so a thread the user never
-- reopens still gets its error surfaced.
--
-- IMPORTANT: keys off the messages row's `status='streaming'`, NOT
-- threads.response_holder_id. The thread-level claim
-- (response_holder_id + response_claim_expires_at) is browser-managed:
-- the chat-loop acquires it at turn start and heartbeats it from the
-- producer device. A backgrounded tab, a refresh, or a Chrome pause
-- stops the browser's heartbeat without affecting the function's own
-- streaming work (the function lives in waitUntil and keeps going).
-- An earlier shape of this sweep keyed off the thread claim and would
-- write last_error on healthy long-running streams whose browser
-- happened to be paused - the reconnecting browser would then see the
-- error card instead of the live stream resuming. The messages-row
-- status is the right signal because it's function-owned end to end:
-- ensureAssistantRow inserts with status='streaming',
-- commit_assistant_message and transitionRowTo flip it on terminal.
--
-- Threshold: 2 * WALL_DEADLINE_MS (760 seconds). A healthy stream
-- can't exceed WALL_DEADLINE_MS (the orchestrator's own ceiling); the
-- 2x buffer is the same one the in-function reconnect probe uses.
--
-- SECURITY DEFINER + revoke-from-non-service: this sweep crosses user
-- boundaries (a service role sweeping all threads), which makes the
-- EXECUTE grant the security boundary. Cron is the only legitimate
-- caller; the function exists as an RPC purely so cron can invoke it
-- via SQL.
create or replace function public.nak_sweep_stale_streams()
returns int
language plpgsql security definer set search_path = public as $$
declare
  affected int;
begin
  with stale as (
    select m.id, m.thread_id
    from public.messages m
    where m.role = 'assistant'
      and m.status = 'streaming'
      and m.created_at < now() - interval '760 seconds'
    for update of m skip locked
  ),
  updated_msgs as (
    update public.messages m
    set status = 'error'
    from stale s
    where m.id = s.id
    returning m.thread_id
  )
  update public.threads t
  set last_error = jsonb_build_object(
    'kind', 'internal',
    'message',
      'The previous response was lost mid-stream (the function ended before it could finalise the reply). Try again.',
    'retryable', true,
    'occurred_at', to_jsonb(now())
  )
  from updated_msgs um
  where t.id = um.thread_id
    and t.last_error is null;
  get diagnostics affected = row_count;
  return affected;
end $$;

revoke all on function public.nak_sweep_stale_streams() from public, anon, authenticated;
grant execute on function public.nak_sweep_stale_streams() to service_role;

-- Reflection pipeline RPCs -----------------------------------------------
--
-- The reflection agent runs on the same claim/lease pattern as the
-- embeddings worker, but against `threads` instead of `memories`
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
-- The claim returns `(thread_id, terminal_msg_id)` atomically. The
-- agent fetches messages up to `terminal_msg_id` (so a race where the
-- user adds more turns mid-reflection just queues the thread for the
-- next cycle), runs its tool-call loop, and calls
-- `mark_thread_reflected_if_claimed` with the same msg_id it got here.
-- If the claim was lost (another run took over mid-reflection) the mark
-- returns false and the whole run is discarded — the winner redoes it.

-- The per-user claim variant (claim_next_thread_for_reflection) is
-- retired: reflection is sweep-only, and the cross-user sweep claim
-- below is the single claiming path. The drops cover every signature
-- the variant ever shipped with.
drop function if exists public.claim_next_thread_for_reflection(text, int);
drop function if exists public.claim_next_thread_for_reflection(text, int, text);
drop function if exists public.claim_next_thread_for_reflection(text, int, text, uuid);

-- Record a completed reflection IF the claim is still ours. Returns
-- true on success, false when the claim expired or was stolen (another
-- run took over). The agent treats false the same way
-- save_memory_embedding_if_claimed does: drop the work, loop to the
-- next row. Any memory writes the agent already made during the run
-- stay — they're owned by the user, not the claim, and re-reflection
-- on the same thread will just find them via memory_search and
-- memory_update rather than duplicate.
drop function if exists public.mark_thread_reflected_if_claimed(uuid, text, uuid);
create or replace function public.mark_thread_reflected_if_claimed(
  p_thread_id uuid,
  p_holder_id text,
  p_msg_id uuid,
  -- b-strict escape hatch: the service-role edge-function caller has
  -- no auth.uid(), so it passes the thread owner's id explicitly
  -- (coalesced below).
  p_user_id uuid default null
) returns boolean
language plpgsql security invoker as $$
declare
  updated int;
begin
  update public.threads
     set last_reflected_msg_id = p_msg_id,
         reflection_holder_id = null,
         reflection_claim_expires_at = null,
         reflection_attempt_count = 0
   where id = p_thread_id
     and user_id = coalesce(p_user_id, auth.uid())
     and reflection_holder_id = p_holder_id
     and reflection_claim_expires_at > now();
  get diagnostics updated = row_count;
  return updated > 0;
end $$;

-- service_role grant for the edge-function reflection driver (the
-- venice function's sweep tick marks threads with a service-role
-- client, passing the owner's id through the b-strict escape hatch).
grant execute on function
  public.mark_thread_reflected_if_claimed(uuid, text, uuid, uuid) to service_role;

-- Resolve a stored timezone preference to one Postgres will accept.
-- The global sweep claims (reflection below, wiki, rem) evaluate the
-- day-gate for EVERY user inside one query; a single profile carrying
-- a malformed displayTimezone would make `at time zone` raise and
-- wedge the whole sweep (one bad row pins the queue for all users).
-- The browser-era claims took the timezone as a parameter, so a bad
-- value only ever broke its own user's claim - the global shape needs
-- the per-row guard. Probe the value and fall back to UTC on anything
-- Postgres rejects. Defined above the FIRST consumer on purpose: the
-- sweep claims are `language sql`, whose bodies resolve this
-- reference at create time, and schema.sql applies top to bottom in
-- one pass - a fresh project errors here if the definition sits below
-- any caller.
create or replace function public.nak_safe_timezone(p_tz text)
returns text
language plpgsql stable as $$
begin
  if p_tz is null or p_tz = '' then
    return 'UTC';
  end if;
  perform now() at time zone p_tz;
  return p_tz;
exception when others then
  return 'UTC';
end $$;

-- Global reflection sweep claim: reflection's only claiming path.
-- Picks the most-overdue eligible thread across ALL users - the
-- timezone comes off each owner's profile (nak_safe_timezone, UTC
-- fallback). The sweep tick calls this in a drain loop (claim ->
-- reflect -> claim the next), and overlapping ticks are safe by
-- construction: the per-thread claim columns are the mutual
-- exclusion, so whichever caller claims first wins and the other
-- sees a different candidate or none.
drop function if exists public.claim_next_thread_for_reflection_sweep(text, int);
create or replace function public.claim_next_thread_for_reflection_sweep(
  p_holder_id text,
  p_ttl_seconds int
) returns table (thread_id uuid, terminal_msg_id uuid, user_id uuid)
language sql security definer
set search_path = public as $$
  with candidate as (
    select t.id as thread_id, term.msg_id as terminal_msg_id, t.user_id as user_id
      from public.threads t
      inner join public.profiles p on p.user_id = t.user_id
      cross join lateral (
        -- One safe-timezone resolution per candidate row, shared by
        -- both sides of the day-gate comparison below.
        select public.nak_safe_timezone(p.settings->>'displayTimezone') as tz
      ) usertz
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
         order by m.position desc
         limit 1
      ) term
      cross join lateral (
        -- Wall-clock on purpose, not transcript order: this asks "when
        -- did the thread last see a write" for the day-gate, and a
        -- recovery row healed today counts as today's activity even
        -- though its position is mid-transcript.
        select m2.created_at
          from public.messages m2
         where m2.thread_id = t.id
         order by m2.created_at desc
         limit 1
      ) newest
     -- A hidden thread is deleted-awaiting-GC (or, post-forking, pure
     -- shared structure nobody talks in): no surface ever shows its
     -- summary/topics/etc. and the old destructive delete would have
     -- removed it before this sweep saw it - so never spend agent work
     -- on one. Same one-line filter on every thread claim below; the
     -- chunker claims are the deliberate exception (see their comment).
     where not t.hidden
       and term.msg_id is distinct from t.last_reflected_msg_id
       -- Same attempt cap as the per-user claim; see the column
       -- comment on reflection_attempt_count.
       and (term.msg_id is distinct from t.reflection_attempt_msg_id
            or t.reflection_attempt_count < 3)
       and (t.reflection_claim_expires_at is null
            or t.reflection_claim_expires_at < now())
       and (newest.created_at at time zone usertz.tz)::date
             < (now() at time zone usertz.tz)::date
       and (
         -- Same substance bar as the per-user claim: at least one
         -- follow-up user message.
         select count(*)
           from public.messages m3
          where m3.thread_id = t.id
            and m3.role = 'user'
       ) >= 2
     order by t.updated_at asc
     limit 1
     for update of t skip locked
  )
  update public.threads t
     set reflection_holder_id = p_holder_id,
         reflection_claim_expires_at = now() + make_interval(secs => p_ttl_seconds),
         reflection_attempt_count = case
           when t.reflection_attempt_msg_id is distinct from c.terminal_msg_id then 1
           else t.reflection_attempt_count + 1
         end,
         reflection_attempt_msg_id = c.terminal_msg_id
    from candidate c
   where t.id = c.thread_id
  returning t.id as thread_id, c.terminal_msg_id, t.user_id;
$$;

-- Global sweep, owner-privileged: only the cron-driven service role
-- may claim across users.
revoke all on function public.claim_next_thread_for_reflection_sweep(text, int)
  from public, anon, authenticated;
grant execute on function public.claim_next_thread_for_reflection_sweep(text, int)
  to service_role;

-- Samskara evaluation sweep claim ----------------------------------------
--
-- The next-day retrospective judge's thread claim. A near-exact clone of
-- claim_next_thread_for_reflection_sweep: same cross-user scope, same
-- per-owner timezone day-gate (nak_safe_timezone, defined above this
-- caller on purpose), same ">= 2 user messages" substance bar, same
-- updated_at-ordered skip-locked lease. The only differences are the
-- claim/cursor columns (evaluation_* instead of reflection_*) - the two
-- sweeps target the same settled threads, so each must hold its own
-- lease. last_evaluated_msg_id is the cursor; terminal_msg_id is the
-- newest terminal assistant message ("judge up to here").
drop function if exists public.claim_next_thread_for_evaluation_sweep(text, int);
create or replace function public.claim_next_thread_for_evaluation_sweep(
  p_holder_id text,
  p_ttl_seconds int
) returns table (thread_id uuid, terminal_msg_id uuid, user_id uuid)
language sql security definer
set search_path = public as $$
  with candidate as (
    select t.id as thread_id, term.msg_id as terminal_msg_id, t.user_id as user_id
      from public.threads t
      inner join public.profiles p on p.user_id = t.user_id
      cross join lateral (
        select public.nak_safe_timezone(p.settings->>'displayTimezone') as tz
      ) usertz
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
         order by m.position desc
         limit 1
      ) term
      cross join lateral (
        -- Wall-clock on purpose, not transcript order: this asks "when
        -- did the thread last see a write" for the day-gate, and a
        -- recovery row healed today counts as today's activity even
        -- though its position is mid-transcript.
        select m2.created_at
          from public.messages m2
         where m2.thread_id = t.id
         order by m2.created_at desc
         limit 1
      ) newest
     where not t.hidden -- deleted-awaiting-GC; see the reflection sweep
       and term.msg_id is distinct from t.last_evaluated_msg_id
       and (term.msg_id is distinct from t.evaluation_attempt_msg_id
            or t.evaluation_attempt_count < 3)
       and (t.evaluation_claim_expires_at is null
            or t.evaluation_claim_expires_at < now())
       and (newest.created_at at time zone usertz.tz)::date
             < (now() at time zone usertz.tz)::date
       and (
         select count(*)
           from public.messages m3
          where m3.thread_id = t.id
            and m3.role = 'user'
       ) >= 2
     order by t.updated_at asc
     limit 1
     for update of t skip locked
  )
  update public.threads t
     set evaluation_holder_id = p_holder_id,
         evaluation_claim_expires_at = now() + make_interval(secs => p_ttl_seconds),
         evaluation_attempt_count = case
           when t.evaluation_attempt_msg_id is distinct from c.terminal_msg_id then 1
           else t.evaluation_attempt_count + 1
         end,
         evaluation_attempt_msg_id = c.terminal_msg_id
    from candidate c
   where t.id = c.thread_id
  returning t.id as thread_id, c.terminal_msg_id, t.user_id;
$$;

revoke all on function public.claim_next_thread_for_evaluation_sweep(text, int)
  from public, anon, authenticated;
grant execute on function public.claim_next_thread_for_evaluation_sweep(text, int)
  to service_role;

-- Samskara evaluation sweep mark-done ------------------------------------
--
-- Clone of mark_thread_reflected_if_claimed for the evaluation cursor.
-- Advances last_evaluated_msg_id and releases the lease, but only if the
-- caller still holds an unexpired claim - a lost claim (lease expired or
-- stolen) is a no-op returning false, so a slow judge never clobbers a
-- newer claimant's cursor. Only the service-role sweep calls it.
drop function if exists public.mark_thread_evaluated_if_claimed(uuid, text, uuid, uuid);
create or replace function public.mark_thread_evaluated_if_claimed(
  p_thread_id uuid,
  p_holder_id text,
  p_msg_id uuid,
  p_user_id uuid default null
) returns boolean
language plpgsql security invoker as $$
declare
  updated int;
begin
  update public.threads
     set last_evaluated_msg_id = p_msg_id,
         evaluation_holder_id = null,
         evaluation_claim_expires_at = null,
         evaluation_attempt_count = 0
   where id = p_thread_id
     and user_id = coalesce(p_user_id, auth.uid())
     and evaluation_holder_id = p_holder_id
     and evaluation_claim_expires_at > now();
  get diagnostics updated = row_count;
  return updated > 0;
end $$;

revoke all on function public.mark_thread_evaluated_if_claimed(uuid, text, uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.mark_thread_evaluated_if_claimed(uuid, text, uuid, uuid)
  to service_role;

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
  p_ttl_seconds int,
  -- b-strict escape hatch (see claim_next_thread_for_reflection): the
  -- venice edge function drives summaries from a chat turn's waitUntil
  -- tail with a service-role client that has no uid, so it passes the
  -- thread owner's id explicitly.
  p_user_id uuid default null
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
         order by m.position desc
         limit 1
      ) term
     where t.user_id = coalesce(p_user_id, auth.uid())
       and not t.hidden -- deleted-awaiting-GC; see the reflection sweep
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
  p_msg_id uuid,
  -- b-strict escape hatch, same as the claim RPC above.
  p_user_id uuid default null
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
     and user_id = coalesce(p_user_id, auth.uid())
     and summary_claim_holder = p_holder_id
     and summary_claim_expires > now();
  get diagnostics updated = row_count;
  return updated > 0;
end $$;

-- service_role grants for the edge-function curation drivers (turn
-- tail + curation sweep; see the reflection grants above for the
-- pattern).
grant execute on function
  public.claim_next_thread_for_summary(text, int, uuid) to service_role;
grant execute on function
  public.save_thread_summary_if_claimed(uuid, text, text, uuid, uuid) to service_role;

-- Global summary sweep claim: the curation sweep's cross-user variant
-- of claim_next_thread_for_summary. Same candidate predicate, no user
-- filter; returns the owner so the agent can attribute drawer logs and
-- scope its saves. Tail + sweep double-driving is safe by construction:
-- the per-thread claim columns are the mutual exclusion.
drop function if exists public.claim_next_thread_for_summary_sweep(text, int);
create or replace function public.claim_next_thread_for_summary_sweep(
  p_holder_id text,
  p_ttl_seconds int
) returns table (thread_id uuid, terminal_msg_id uuid, user_id uuid)
language sql security definer
set search_path = public as $$
  with candidate as (
    select t.id as thread_id, term.msg_id as terminal_msg_id, t.user_id as user_id
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
         order by m.position desc
         limit 1
      ) term
     where not t.hidden -- deleted-awaiting-GC; see the reflection sweep
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
  returning t.id as thread_id, c.terminal_msg_id, t.user_id;
$$;

revoke all on function public.claim_next_thread_for_summary_sweep(text, int)
  from public, anon, authenticated;
grant execute on function public.claim_next_thread_for_summary_sweep(text, int)
  to service_role;

-- Auto-title pipeline RPCs ----------------------------------------------
--
-- Claim / save / clear for the auto-title agent
-- (supabase/functions/venice/agents/auto_title.ts), which fills in
-- titles for threads still on the 'New conversation' placeholder.
-- Same per-row claim pattern as the summary RPCs; the chat-turn
-- waitUntil tail and the hourly curation sweep are the two callers,
-- and these claim columns are the only mutual exclusion between them.
--
-- The eligibility predicate: title still default, title_manually_set
-- still false, AND at least one user message exists to title from.
-- Returning the first user message's text in the same round trip
-- avoids a second SELECT before the Venice call.
drop function if exists public.claim_next_thread_for_auto_title(text, int);
create or replace function public.claim_next_thread_for_auto_title(
  p_holder_id text,
  p_ttl_seconds int,
  -- b-strict escape hatch (see claim_next_thread_for_reflection): the
  -- venice edge function drives titling from a chat turn's waitUntil
  -- tail with a service-role client that has no uid, so it passes the
  -- thread owner's id explicitly.
  p_user_id uuid default null
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
         order by m.position asc
         limit 1
      ) first_user
     where t.user_id = coalesce(p_user_id, auth.uid())
       and not t.hidden -- deleted-awaiting-GC; see the reflection sweep
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
  p_title text,
  -- b-strict escape hatch, same as the claim RPC above.
  p_user_id uuid default null
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
     and user_id = coalesce(p_user_id, auth.uid())
     and auto_title_claim_holder = p_holder_id
     and auto_title_claim_expires > now()
     and title = 'New conversation'
     and title_manually_set = false;
  get diagnostics updated = row_count;
  return updated > 0;
end $$;

-- Explicit claim release - used by the agent when title generation
-- produced no usable output (model emitted whitespace, abort fired) so
-- another cycle can re-pick the row immediately rather than waiting for
-- the TTL. Guarded on holder so a stale call from a displaced holder
-- can't clear the live claim. Returns void.
drop function if exists public.clear_auto_title_claim(uuid, text);
create or replace function public.clear_auto_title_claim(
  p_thread_id uuid,
  p_holder_id text,
  -- b-strict escape hatch, same as the claim RPC above.
  p_user_id uuid default null
) returns void
language plpgsql security invoker as $$
begin
  update public.threads
     set auto_title_claim_holder = null,
         auto_title_claim_expires = null
   where id = p_thread_id
     and user_id = coalesce(p_user_id, auth.uid())
     and auto_title_claim_holder = p_holder_id;
end $$;

-- service_role grants for the edge-function curation drivers.
grant execute on function
  public.claim_next_thread_for_auto_title(text, int, uuid) to service_role;
grant execute on function
  public.save_thread_title_if_claimed(uuid, text, text, uuid) to service_role;
grant execute on function
  public.clear_auto_title_claim(uuid, text, uuid) to service_role;

-- Global auto-title sweep claim: cross-user variant of
-- claim_next_thread_for_auto_title for the curation sweep's catch-up
-- drain (a title attempt that failed on the turn tail would otherwise
-- wait for the thread's next turn). Returns the owner for log
-- attribution and save scoping.
drop function if exists public.claim_next_thread_for_auto_title_sweep(text, int);
create or replace function public.claim_next_thread_for_auto_title_sweep(
  p_holder_id text,
  p_ttl_seconds int
) returns table (thread_id uuid, user_text text, user_id uuid)
language sql security definer
set search_path = public as $$
  with candidate as (
    select t.id as thread_id, first_user.text as user_text, t.user_id as user_id
      from public.threads t
      cross join lateral (
        select m.content as text
          from public.messages m
         where m.thread_id = t.id
           and m.role = 'user'
           and m.content is not null
           and length(m.content) > 0
         order by m.position asc
         limit 1
      ) first_user
     where not t.hidden -- deleted-awaiting-GC; see the reflection sweep
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
  returning t.id as thread_id, c.user_text, t.user_id;
$$;

revoke all on function public.claim_next_thread_for_auto_title_sweep(text, int)
  from public, anon, authenticated;
grant execute on function public.claim_next_thread_for_auto_title_sweep(text, int)
  to service_role;

-- Topic-tagging pipeline RPCs -------------------------------------------
--
-- The thread-topics agent
-- (supabase/functions/venice/agents/thread_topics.ts) tags threads
-- with a short flat set of topic strings. Shape mirrors the summary
-- RPCs: claim by terminal-assistant-message id, save guarded by holder
-- + TTL + terminal_msg_id stamp so a thread that grew mid-tagging
-- simply re-qualifies on the next cycle. The extra wrinkle vs summary:
-- the claim also returns the user's existing topic vocabulary in the
-- same round trip, so the agent can prompt the model with "reuse these
-- names if they fit" without a second SELECT. Saves one RPC per cycle
-- and keeps the vocabulary as fresh as the claim that consumed it.
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
  p_ttl_seconds int,
  -- b-strict escape hatch (see claim_next_thread_for_reflection): the
  -- venice edge function drives tagging from a chat turn's waitUntil
  -- tail with a service-role client that has no uid, so it passes the
  -- thread owner's id explicitly. The vocab CTE scopes on the same
  -- coalesce so the model sees the right user's vocabulary.
  p_user_id uuid default null
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
         order by m.position desc
         limit 1
      ) term
     where t.user_id = coalesce(p_user_id, auth.uid())
       and not t.hidden -- deleted-awaiting-GC; see the reflection sweep
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
     where t.user_id = coalesce(p_user_id, auth.uid())
       and not t.hidden -- a deleted thread's tags shouldn't seed reuse
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
  p_msg_id uuid,
  -- b-strict escape hatch, same as the claim RPC above.
  p_user_id uuid default null
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
     and user_id = coalesce(p_user_id, auth.uid())
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
  p_holder_id text,
  -- b-strict escape hatch, same as the claim RPC above.
  p_user_id uuid default null
) returns void
language plpgsql security invoker as $$
begin
  update public.threads
     set topics_claim_holder = null,
         topics_claim_expires = null
   where id = p_thread_id
     and user_id = coalesce(p_user_id, auth.uid())
     and topics_claim_holder = p_holder_id;
end $$;

-- service_role grants for the edge-function curation drivers.
grant execute on function
  public.claim_next_thread_for_topics(text, int, uuid) to service_role;
grant execute on function
  public.save_thread_topics_if_claimed(uuid, text, text[], uuid, uuid) to service_role;
grant execute on function
  public.clear_topics_claim(uuid, text, uuid) to service_role;

-- Global thread-topics sweep claim: cross-user variant of
-- claim_next_thread_for_topics for the curation sweep. The vocab CTE
-- scopes to the candidate row's owner so the model sees that user's
-- vocabulary, not an aggregate across accounts.
drop function if exists public.claim_next_thread_for_topics_sweep(text, int);
create or replace function public.claim_next_thread_for_topics_sweep(
  p_holder_id text,
  p_ttl_seconds int
) returns table (
  thread_id uuid,
  terminal_msg_id uuid,
  existing_topics text[],
  user_id uuid
)
language sql security definer
set search_path = public as $$
  with candidate as (
    select t.id as thread_id, term.msg_id as terminal_msg_id, t.user_id as user_id
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
         order by m.position desc
         limit 1
      ) term
     where not t.hidden -- deleted-awaiting-GC; see the reflection sweep
       and t.title <> 'New conversation'
       and term.msg_id is distinct from t.last_topics_msg_id
       and (t.topics_claim_expires is null
            or t.topics_claim_expires < now())
     order by t.updated_at asc
     limit 1
     for update of t skip locked
  ),
  vocab as (
    select coalesce(array_agg(distinct topic order by topic), '{}'::text[]) as topics
      from public.threads t, unnest(t.topics) as topic
     where t.user_id = (select c.user_id from candidate c)
       and t.topics <> '{}'::text[]
  )
  update public.threads t
     set topics_claim_holder = p_holder_id,
         topics_claim_expires = now() + make_interval(secs => p_ttl_seconds)
    from candidate c, vocab v
   where t.id = c.thread_id
  returning t.id as thread_id, c.terminal_msg_id, v.topics as existing_topics, t.user_id;
$$;

revoke all on function public.claim_next_thread_for_topics_sweep(text, int)
  from public, anon, authenticated;
grant execute on function public.claim_next_thread_for_topics_sweep(text, int)
  to service_role;

-- Topic vocabulary + per-topic corpus counts for the current user.
-- Used by the drawer's topic-filter dropdown on mount and after a
-- tagging event. The aggregate is cheap per user (a few hundred rows
-- at most, each with 1-4 short strings); no need for materialisation.
--
-- Returns a jsonb object rather than the bare text[] the dropdown used
-- before counts: `{ "topics": [{"topic": t, "count": n}, ...],
-- "untagged": m }`. `topics` is alphabetised and each entry's `count`
-- is how many of the user's threads carry that topic - the number the
-- dropdown shows in parens, eg "baking (7)". `untagged` is the count of
-- threads with no topics at all and backs the "(untagged)" row the UI
-- synthesises (that pseudo-topic is never a member of `topics`). Counts
-- span the whole corpus, not a loaded page, because the thread list is
-- paginated client-side - a client-side tally would undercount.
--
-- Both the vocabulary and its counts exclude archived threads
-- (`archived = false`). The drawer the dropdown lives in shows the
-- active list; counting archived threads would inflate the number past
-- what the user sees when they pick the topic. Because the `topics`
-- array is built from this same active-only aggregation, a topic that
-- lives only on archived threads drops out of the dropdown entirely
-- rather than showing a "(0)" - which is correct, since filtering by it
-- would yield an empty active list.
drop function if exists public.list_user_topics();
create or replace function public.list_user_topics()
returns jsonb
language sql security invoker as $$
  select jsonb_build_object(
    'topics', coalesce((
      select jsonb_agg(jsonb_build_object('topic', topic, 'count', n) order by topic)
        from (
          select topic, count(*) as n
            from public.threads t, unnest(t.topics) as topic
           where t.user_id = auth.uid()
             and t.archived = false
             and not t.hidden -- hidden threads are invisible to every list surface
             and t.topics <> '{}'::text[]
           group by topic
        ) counted
    ), '[]'::jsonb),
    'untagged', (
      select count(*)
        from public.threads t
       where t.user_id = auth.uid()
         and t.archived = false
         and not t.hidden -- hidden threads are invisible to every list surface
         and t.topics = '{}'::text[]
    )
  );
$$;

-- Memory topic-tagging pipeline RPCs ------------------------------------
--
-- Sibling of the thread topics RPCs above. Shape is intentionally
-- identical so anyone reading one has the other's vocabulary for free.
-- The two differences vs threads:
--
--   1. Eligibility is `last_topics_at is null` rather than "terminal
--      message past last_topics_msg_id". Memories don't have a message
--      stream - they're a single piece of text - so the trigger on
--      label/data change nulls last_topics_at and that's what re-enters
--      the row into the queue.
--
--   2. The claim returns label + data rather than a thread id + msg id.
--      The agent's input is the memory text itself; no second SELECT
--      against `memories` is needed inside the agent.
--
-- The vocabulary subquery is shared shape: distinct topics across the
-- user's memories, alphabetised, empty array on a brand-new account.
drop function if exists public.claim_next_memory_for_topics(text, int);
create or replace function public.claim_next_memory_for_topics(
  p_holder_id text,
  p_ttl_seconds int,
  -- b-strict escape hatch (see claim_next_thread_for_reflection): the
  -- venice edge function probes this queue from a chat turn's
  -- waitUntil tail with a service-role client that has no uid, so it
  -- passes the owner's id explicitly. The vocab CTE scopes on the
  -- same coalesce.
  p_user_id uuid default null
) returns table (
  memory_id uuid,
  label text,
  data text,
  existing_topics text[]
)
language sql security invoker as $$
  with candidate as (
    select m.id as memory_id, m.label, m.data
      from public.memories m
     where m.user_id = coalesce(p_user_id, auth.uid())
       and m.last_topics_at is null
       and (m.topics_claim_expires is null
            or m.topics_claim_expires < now())
     order by m.updated_at asc
     limit 1
     for update of m skip locked
  ),
  vocab as (
    -- One-shot read of the user's current memory-topic vocabulary so
    -- the worker can pass it to the model as a "reuse these names"
    -- list. Empty array on a brand-new account is fine; the agent gets
    -- free rein on the first few memories and the vocabulary self-
    -- seeds.
    select coalesce(array_agg(distinct topic order by topic), '{}'::text[]) as topics
      from public.memories m, unnest(m.topics) as topic
     where m.user_id = coalesce(p_user_id, auth.uid())
       and m.topics <> '{}'::text[]
  )
  update public.memories m
     set topics_claim_holder = p_holder_id,
         topics_claim_expires = now() + make_interval(secs => p_ttl_seconds)
    from candidate c, vocab v
   where m.id = c.memory_id
  returning m.id as memory_id, c.label, c.data, v.topics as existing_topics;
$$;

-- Save the agent-produced topics IF our claim is still valid. The
-- `last_topics_at = now()` stamp is what marks the row as "tagged"; the
-- trigger on label/data change nulls it back to re-qualify the row on
-- the next cycle. Returns false when the claim expired or was stolen -
-- the worker drops the work. Does NOT touch updated_at so a tagging
-- pass doesn't shuffle the memory list's recency ordering.
drop function if exists public.save_memory_topics_if_claimed(uuid, text, text[]);
create or replace function public.save_memory_topics_if_claimed(
  p_memory_id uuid,
  p_holder_id text,
  p_topics text[],
  -- b-strict escape hatch, same as the claim RPC above.
  p_user_id uuid default null
) returns boolean
language plpgsql security invoker as $$
declare
  updated int;
begin
  update public.memories
     set topics = p_topics,
         last_topics_at = now(),
         topics_claim_holder = null,
         topics_claim_expires = null
   where id = p_memory_id
     and user_id = coalesce(p_user_id, auth.uid())
     and topics_claim_holder = p_holder_id
     and topics_claim_expires > now();
  get diagnostics updated = row_count;
  return updated > 0;
end $$;

-- Explicit claim release for the empty-topics path - mirrors
-- clear_topics_claim above. Used when the agent produced nothing
-- usable so another cycle can re-pick the row immediately rather than
-- waiting for the TTL. Holder guard prevents a stale call from a
-- displaced worker from clearing the live claim.
drop function if exists public.clear_memory_topics_claim(uuid, text);
create or replace function public.clear_memory_topics_claim(
  p_memory_id uuid,
  p_holder_id text,
  -- b-strict escape hatch, same as the claim RPC above.
  p_user_id uuid default null
) returns void
language plpgsql security invoker as $$
begin
  update public.memories
     set topics_claim_holder = null,
         topics_claim_expires = null
   where id = p_memory_id
     and user_id = coalesce(p_user_id, auth.uid())
     and topics_claim_holder = p_holder_id;
end $$;

-- service_role grants for the edge-function curation drivers.
grant execute on function
  public.claim_next_memory_for_topics(text, int, uuid) to service_role;
grant execute on function
  public.save_memory_topics_if_claimed(uuid, text, text[], uuid) to service_role;
grant execute on function
  public.clear_memory_topics_claim(uuid, text, uuid) to service_role;

-- Global memory-topics sweep claim: cross-user variant of
-- claim_next_memory_for_topics for the curation sweep. This queue's
-- writers are all server-side (reflection / rem / deep-sleep on cron
-- and chat-turn tails), so the sweep is the primary drain - without
-- it a 3am rem consolidation leaves rows untagged until their owner
-- next converses. The vocab CTE scopes to the candidate row's owner.
drop function if exists public.claim_next_memory_for_topics_sweep(text, int);
create or replace function public.claim_next_memory_for_topics_sweep(
  p_holder_id text,
  p_ttl_seconds int
) returns table (
  memory_id uuid,
  label text,
  data text,
  existing_topics text[],
  user_id uuid
)
language sql security definer
set search_path = public as $$
  with candidate as (
    select m.id as memory_id, m.label, m.data, m.user_id as user_id
      from public.memories m
     where m.last_topics_at is null
       and (m.topics_claim_expires is null
            or m.topics_claim_expires < now())
     order by m.updated_at asc
     limit 1
     for update of m skip locked
  ),
  vocab as (
    select coalesce(array_agg(distinct topic order by topic), '{}'::text[]) as topics
      from public.memories m, unnest(m.topics) as topic
     where m.user_id = (select c.user_id from candidate c)
       and m.topics <> '{}'::text[]
  )
  update public.memories m
     set topics_claim_holder = p_holder_id,
         topics_claim_expires = now() + make_interval(secs => p_ttl_seconds)
    from candidate c, vocab v
   where m.id = c.memory_id
  returning m.id as memory_id, c.label, c.data, v.topics as existing_topics, m.user_id;
$$;

revoke all on function public.claim_next_memory_for_topics_sweep(text, int)
  from public, anon, authenticated;
grant execute on function public.claim_next_memory_for_topics_sweep(text, int)
  to service_role;

-- Memory-topic vocabulary + per-topic counts for the current user.
-- Used by the Memories drawer's topic-filter dropdown on mount and
-- after a tagging event arrives via realtime. Distinct from
-- list_user_topics() (which targets threads) so a user can have
-- separate vocabularies on each surface without one polluting the
-- other. Same jsonb shape as list_user_topics: `{ "topics":
-- [{"topic": t, "count": n}], "untagged": m }`. Counts span the whole
-- memory corpus, not the (capped) search-result set the panel holds
-- client-side, so the dropdown shows true totals rather than "how many
-- matched the current search".
drop function if exists public.list_user_memory_topics();
create or replace function public.list_user_memory_topics()
returns jsonb
language sql security invoker as $$
  select jsonb_build_object(
    'topics', coalesce((
      select jsonb_agg(jsonb_build_object('topic', topic, 'count', n) order by topic)
        from (
          select topic, count(*) as n
            from public.memories m, unnest(m.topics) as topic
           where m.user_id = auth.uid()
             and m.topics <> '{}'::text[]
           group by topic
        ) counted
    ), '[]'::jsonb),
    'untagged', (
      select count(*)
        from public.memories m
       where m.user_id = auth.uid()
         and m.topics = '{}'::text[]
    )
  );
$$;

-- Recipe topic-tagging pipeline RPCs ------------------------------------
--
-- Sibling of the memory-topics RPCs above. Shape is intentionally
-- identical so anyone reading one has the other's vocabulary for free.
-- Eligibility predicate is `last_topics_at is null`, same as memories -
-- the trigger on title/cooklang change nulls last_topics_at and that's
-- what re-enters the row into the queue. The claim returns title +
-- cooklang as the agent input; no second SELECT against `recipes`.
drop function if exists public.claim_next_recipe_for_topics(text, int);
create or replace function public.claim_next_recipe_for_topics(
  p_holder_id text,
  p_ttl_seconds int,
  -- b-strict escape hatch (see claim_next_thread_for_reflection): the
  -- venice edge function probes this queue from a chat turn's
  -- waitUntil tail with a service-role client that has no uid, so it
  -- passes the owner's id explicitly. The vocab CTE scopes on the
  -- same coalesce.
  p_user_id uuid default null
) returns table (
  recipe_id uuid,
  title text,
  cooklang text,
  existing_topics text[]
)
language sql security invoker as $$
  with candidate as (
    select r.id as recipe_id, r.title, r.cooklang
      from public.recipes r
     where r.user_id = coalesce(p_user_id, auth.uid())
       and r.last_topics_at is null
       and (r.topics_claim_expires is null
            or r.topics_claim_expires < now())
     order by r.updated_at asc
     limit 1
     for update of r skip locked
  ),
  vocab as (
    -- One-shot read of the user's current recipe-topic vocabulary so
    -- the worker can pass it to the model as a "reuse these names"
    -- list. Empty array on a brand-new account is fine; the agent
    -- gets free rein on the first few recipes and the vocabulary
    -- self-seeds.
    select coalesce(array_agg(distinct topic order by topic), '{}'::text[]) as topics
      from public.recipes r, unnest(r.topics) as topic
     where r.user_id = coalesce(p_user_id, auth.uid())
       and r.topics <> '{}'::text[]
  )
  update public.recipes r
     set topics_claim_holder = p_holder_id,
         topics_claim_expires = now() + make_interval(secs => p_ttl_seconds)
    from candidate c, vocab v
   where r.id = c.recipe_id
  returning r.id as recipe_id, c.title, c.cooklang, v.topics as existing_topics;
$$;

-- Save the agent-produced topics IF our claim is still valid. The
-- last_topics_at = now() stamp marks the row as tagged; the trigger
-- on title/cooklang change nulls it back to re-qualify the row on
-- the next cycle. Returns false when the claim expired or was
-- stolen. Does NOT touch updated_at so a tagging pass doesn't
-- shuffle the recipe list's recency ordering (and doesn't trip the
-- embedding trigger by way of an unrelated column write).
drop function if exists public.save_recipe_topics_if_claimed(uuid, text, text[]);
create or replace function public.save_recipe_topics_if_claimed(
  p_recipe_id uuid,
  p_holder_id text,
  p_topics text[],
  -- b-strict escape hatch, same as the claim RPC above.
  p_user_id uuid default null
) returns boolean
language plpgsql security invoker as $$
declare
  updated int;
begin
  update public.recipes
     set topics = p_topics,
         last_topics_at = now(),
         topics_claim_holder = null,
         topics_claim_expires = null
   where id = p_recipe_id
     and user_id = coalesce(p_user_id, auth.uid())
     and topics_claim_holder = p_holder_id
     and topics_claim_expires > now();
  get diagnostics updated = row_count;
  return updated > 0;
end $$;

-- Explicit claim release for the empty-topics path. Mirrors
-- clear_memory_topics_claim - used when the agent produced nothing
-- usable so another cycle can re-pick the row immediately rather
-- than waiting for the TTL.
drop function if exists public.clear_recipe_topics_claim(uuid, text);
create or replace function public.clear_recipe_topics_claim(
  p_recipe_id uuid,
  p_holder_id text,
  -- b-strict escape hatch, same as the claim RPC above.
  p_user_id uuid default null
) returns void
language plpgsql security invoker as $$
begin
  update public.recipes
     set topics_claim_holder = null,
         topics_claim_expires = null
   where id = p_recipe_id
     and user_id = coalesce(p_user_id, auth.uid())
     and topics_claim_holder = p_holder_id;
end $$;

-- service_role grants for the edge-function curation drivers.
grant execute on function
  public.claim_next_recipe_for_topics(text, int, uuid) to service_role;
grant execute on function
  public.save_recipe_topics_if_claimed(uuid, text, text[], uuid) to service_role;
grant execute on function
  public.clear_recipe_topics_claim(uuid, text, uuid) to service_role;

-- Global recipe-topics sweep claim: cross-user variant of
-- claim_next_recipe_for_topics for the curation sweep. Same catch-up
-- rationale as the memory sweep claim: a row a turn tail failed to
-- drain (or one re-queued by an edit outside a chat turn) would
-- otherwise wait for the owner's next conversation. The vocab CTE
-- scopes to the candidate row's owner.
drop function if exists public.claim_next_recipe_for_topics_sweep(text, int);
create or replace function public.claim_next_recipe_for_topics_sweep(
  p_holder_id text,
  p_ttl_seconds int
) returns table (
  recipe_id uuid,
  title text,
  cooklang text,
  existing_topics text[],
  user_id uuid
)
language sql security definer
set search_path = public as $$
  with candidate as (
    select r.id as recipe_id, r.title, r.cooklang, r.user_id as user_id
      from public.recipes r
     where r.last_topics_at is null
       and (r.topics_claim_expires is null
            or r.topics_claim_expires < now())
     order by r.updated_at asc
     limit 1
     for update of r skip locked
  ),
  vocab as (
    select coalesce(array_agg(distinct topic order by topic), '{}'::text[]) as topics
      from public.recipes r, unnest(r.topics) as topic
     where r.user_id = (select c.user_id from candidate c)
       and r.topics <> '{}'::text[]
  )
  update public.recipes r
     set topics_claim_holder = p_holder_id,
         topics_claim_expires = now() + make_interval(secs => p_ttl_seconds)
    from candidate c, vocab v
   where r.id = c.recipe_id
  returning r.id as recipe_id, c.title, c.cooklang, v.topics as existing_topics, r.user_id;
$$;

revoke all on function public.claim_next_recipe_for_topics_sweep(text, int)
  from public, anon, authenticated;
grant execute on function public.claim_next_recipe_for_topics_sweep(text, int)
  to service_role;

-- Recipe-topic vocabulary + per-topic counts for the current user.
-- Backs the Cookbook drawer's topic-filter dropdown. Distinct from
-- list_user_topics (threads) and list_user_memory_topics (memories)
-- so a user can have separate vocabularies on each surface without
-- one polluting another. Same jsonb shape as the sibling RPCs:
-- `{ "topics": [{"topic": t, "count": n}], "untagged": m }`. The
-- Cookbook loads its full row set client-side so a client tally would
-- be exact here, but the count is computed server-side anyway to keep
-- all three dropdowns on one contract.
drop function if exists public.list_user_recipe_topics();
create or replace function public.list_user_recipe_topics()
returns jsonb
language sql security invoker as $$
  select jsonb_build_object(
    'topics', coalesce((
      select jsonb_agg(jsonb_build_object('topic', topic, 'count', n) order by topic)
        from (
          select topic, count(*) as n
            from public.recipes r, unnest(r.topics) as topic
           where r.user_id = auth.uid()
             and r.topics <> '{}'::text[]
           group by topic
        ) counted
    ), '[]'::jsonb),
    'untagged', (
      select count(*)
        from public.recipes r
       where r.user_id = auth.uid()
         and r.topics = '{}'::text[]
    )
  );
$$;

-- Retired: the per-thread title+summary embedding claim/save pair. Its
-- queue is gone from EMBED_SOURCES; public.thread_chunks carries the
-- equivalent pair (claim_next_pending_thread_chunk /
-- save_thread_chunk_embedding_if_claimed) further down.
drop function if exists public.claim_next_pending_thread_for_embedding(text, int);
drop function if exists public.save_thread_embedding_if_claimed(uuid, text, vector, text);

-- thread_chunks pipeline RPCs --------------------------------------------
--
-- Two queues feed public.thread_chunks:
--   1. rechunk  - claim a thread whose newest message is past
--      last_chunked_msg_id, rebuild its chunk rows from the messages.
--   2. embed    - claim a chunk row with a null embedding, vectorize it.
-- Queue 2 is just another EMBED_SOURCES entry and shares the backfill
-- machinery; queue 1 is driven by the rechunk unit in
-- venice/agents/thread_chunks.ts.

-- Claim the next thread needing a rechunk, for one user. Driven from a
-- chat turn's waitUntil tail, so a thread is re-indexed seconds after
-- the turn that changed it rather than waiting for the hourly sweep.
--
-- Newest-first, matching the other embedding claims and unlike the
-- summary queue's oldest-first: recall targets recent conversations, so
-- fresh work is worth more here than deep backlog.
drop function if exists public.claim_next_thread_for_rechunk(text, int);
drop function if exists public.claim_next_thread_for_rechunk(text, int, uuid);
drop function if exists public.claim_next_thread_for_rechunk(text, int, uuid, int);
create or replace function public.claim_next_thread_for_rechunk(
  p_holder_id text,
  p_ttl_seconds int,
  -- b-strict escape hatch, same as the summary claim: the edge function
  -- drives this from a service-role client with no auth.uid().
  p_user_id uuid default null,
  -- Current CHUNK_RENDER_VERSION. A thread whose rows were built by an
  -- older renderer is claimable even when no message has changed.
  p_render_version int default 0
) returns table (thread_id uuid, terminal_msg_id uuid)
language sql security invoker as $$
  with candidate as (
    select t.id as thread_id, term.msg_id as terminal_msg_id
      from public.threads t
      cross join lateral (
        -- Newest message of ANY role: chunks index tool calls and tool
        -- results too, so a turn that ended in a tool row still counts
        -- as new material to index.
        select m.id as msg_id
          from public.messages m
         where m.thread_id = t.id
         order by m.position desc
         limit 1
      ) term
     -- Deliberately NO hidden filter, unlike the other thread claims:
     -- chunks are recall's index of what was said, and once edit-forks
     -- exist a hidden thread's trimmed segment is the shared prefix of
     -- live conversations - rows written just before a hide must still
     -- get chunked or recall goes blind to them. The cost of the
     -- exception today is bounded: a plain-deleted thread gets at most
     -- one wasted chunk pass before the hourly GC destroys it (and its
     -- chunks cascade away with it).
     where t.user_id = coalesce(p_user_id, auth.uid())
       and (term.msg_id is distinct from t.last_chunked_msg_id
            or t.chunk_render_version is distinct from p_render_version)
       and (t.chunk_claim_expires is null
            or t.chunk_claim_expires < now())
     order by t.updated_at desc
     limit 1
     for update of t skip locked
  )
  update public.threads t
     set chunk_claim_holder = p_holder_id,
         chunk_claim_expires = now() + make_interval(secs => p_ttl_seconds)
    from candidate c
   where t.id = c.thread_id
  returning t.id as thread_id, c.terminal_msg_id;
$$;

-- Cross-user sweep variant, same candidate predicate, returning the
-- owner so the unit can scope its save. Tail + sweep double-driving is
-- safe by construction: the per-thread claim columns are the mutual
-- exclusion.
drop function if exists public.claim_next_thread_for_rechunk_sweep(text, int);
drop function if exists public.claim_next_thread_for_rechunk_sweep(text, int, int);
create or replace function public.claim_next_thread_for_rechunk_sweep(
  p_holder_id text,
  p_ttl_seconds int,
  p_render_version int default 0
) returns table (thread_id uuid, terminal_msg_id uuid, user_id uuid)
language sql security definer
set search_path = public as $$
  with candidate as (
    select t.id as thread_id, term.msg_id as terminal_msg_id, t.user_id as user_id
      from public.threads t
      cross join lateral (
        select m.id as msg_id
          from public.messages m
         where m.thread_id = t.id
         order by m.position desc
         limit 1
      ) term
     -- Deliberately NO hidden filter - same rationale as the per-user
     -- rechunk claim above.
     where (term.msg_id is distinct from t.last_chunked_msg_id
            or t.chunk_render_version is distinct from p_render_version)
       and (t.chunk_claim_expires is null
            or t.chunk_claim_expires < now())
     order by t.updated_at desc
     limit 1
     for update of t skip locked
  )
  update public.threads t
     set chunk_claim_holder = p_holder_id,
         chunk_claim_expires = now() + make_interval(secs => p_ttl_seconds)
    from candidate c
   where t.id = c.thread_id
  returning t.id as thread_id, c.terminal_msg_id, t.user_id;
$$;

-- Replace a thread's chunk rows, IF our claim is still valid.
-- p_chunks is [{index, text, start_msg_id, end_msg_id}, ...] in
-- chunk_index order.
--
-- The load-bearing detail is the `where` on the conflict update: a
-- chunk whose content is byte-identical is skipped entirely and KEEPS
-- its embedding. Combined with the chunker's greedy packing (chunk N
-- depends only on the messages before it), appending a message to a
-- 107-message thread re-embeds the last partial chunk and nothing else.
-- Dropping that guard would turn every new message into a full
-- re-embed of the whole thread.
drop function if exists public.save_thread_chunks_if_claimed(uuid, text, uuid, uuid, jsonb);
drop function if exists public.save_thread_chunks_if_claimed(uuid, text, uuid, uuid, jsonb, int);
create or replace function public.save_thread_chunks_if_claimed(
  p_thread_id uuid,
  p_holder_id text,
  p_msg_id uuid,
  p_user_id uuid,
  p_chunks jsonb,
  -- Stamped onto the thread so a later renderer change can tell these
  -- rows apart from ones it produced itself.
  p_render_version int default 0
) returns boolean
language plpgsql security definer
set search_path = public as $$
declare
  updated int;
begin
  -- Cheap bail before doing any write work: if the claim is gone, a
  -- racing run already owns this thread.
  perform 1
     from public.threads
    where id = p_thread_id
      and chunk_claim_holder = p_holder_id
      and chunk_claim_expires > now();
  if not found then
    return false;
  end if;

  insert into public.thread_chunks
      (thread_id, user_id, chunk_index, content, start_msg_id, end_msg_id)
  select p_thread_id,
         p_user_id,
         (c->>'index')::int,
         c->>'text',
         nullif(c->>'start_msg_id', '')::uuid,
         nullif(c->>'end_msg_id', '')::uuid
    from jsonb_array_elements(coalesce(p_chunks, '[]'::jsonb)) c
  on conflict (thread_id, chunk_index) do update
     set content = excluded.content,
         start_msg_id = excluded.start_msg_id,
         end_msg_id = excluded.end_msg_id,
         -- Content changed, so the stored vector describes text that no
         -- longer exists. Null the claim columns alongside it or an
         -- in-flight embed save would land a stale vector (its guard
         -- checks holder + expiry, both of which would still match).
         embedding = null,
         embedding_model = null,
         embedding_claim_holder = null,
         embedding_claim_expires = null
   where public.thread_chunks.content is distinct from excluded.content;

  -- A thread can shrink (messages deleted, or excerpt caps changing the
  -- render). Drop chunk rows past the new tail.
  delete from public.thread_chunks
   where thread_id = p_thread_id
     and chunk_index >= jsonb_array_length(coalesce(p_chunks, '[]'::jsonb));

  update public.threads
     set last_chunked_msg_id = p_msg_id,
         chunk_render_version = p_render_version,
         chunk_claim_holder = null,
         chunk_claim_expires = null
   where id = p_thread_id
     and chunk_claim_holder = p_holder_id
     and chunk_claim_expires > now();
  get diagnostics updated = row_count;
  return updated > 0;
end $$;

-- Claim / save for the chunk embedding queue. Same contract as every
-- other EMBED_SOURCES pair: claim returns the text to embed, save
-- returns false (not an error) when the claim was lost.
drop function if exists public.claim_next_pending_thread_chunk(text, int);
create or replace function public.claim_next_pending_thread_chunk(
  p_holder_id text,
  p_ttl_seconds int
) returns table (id uuid, content text, user_id uuid)
language sql security definer
set search_path = public as $$
  with candidate as (
    select c.id
      from public.thread_chunks c
     where c.embedding is null
       and (c.embedding_claim_expires is null
            or c.embedding_claim_expires < now())
     order by c.created_at desc
     limit 1
     for update skip locked
  )
  update public.thread_chunks c
     set embedding_claim_holder = p_holder_id,
         embedding_claim_expires = now() + make_interval(secs => p_ttl_seconds)
    from candidate cd
   where c.id = cd.id
  returning c.id, c.content, c.user_id;
$$;

drop function if exists public.save_thread_chunk_embedding_if_claimed(uuid, text, vector, text);
create or replace function public.save_thread_chunk_embedding_if_claimed(
  p_id uuid,
  p_holder_id text,
  p_embedding vector(2048),
  p_embedding_model text
) returns boolean
language plpgsql security definer
set search_path = public as $$
declare
  updated int;
begin
  update public.thread_chunks
     set embedding = p_embedding,
         embedding_model = p_embedding_model,
         embedding_claim_holder = null,
         embedding_claim_expires = null
   where id = p_id
     and embedding_claim_holder = p_holder_id
     and embedding_claim_expires > now();
  get diagnostics updated = row_count;
  return updated > 0;
end $$;

revoke all on function public.claim_next_thread_for_rechunk(text, int, uuid, int) from public, anon, authenticated;
revoke all on function public.claim_next_thread_for_rechunk_sweep(text, int, int) from public, anon, authenticated;
revoke all on function public.save_thread_chunks_if_claimed(uuid, text, uuid, uuid, jsonb, int) from public, anon, authenticated;
revoke all on function public.claim_next_pending_thread_chunk(text, int) from public, anon, authenticated;
revoke all on function public.save_thread_chunk_embedding_if_claimed(uuid, text, vector, text) from public, anon, authenticated;
grant execute on function public.claim_next_thread_for_rechunk(text, int, uuid, int) to service_role;
grant execute on function public.claim_next_thread_for_rechunk_sweep(text, int, int) to service_role;
grant execute on function public.save_thread_chunks_if_claimed(uuid, text, uuid, uuid, jsonb, int) to service_role;
grant execute on function public.claim_next_pending_thread_chunk(text, int) to service_role;
grant execute on function public.save_thread_chunk_embedding_if_claimed(uuid, text, vector, text) to service_role;

-- Cosine-similarity search over thread CHUNKS, aggregated back to one
-- row per thread.
--
-- The aggregation is max-similarity on the SCORES: rank every chunk
-- against the query, keep each thread's single best chunk, order
-- threads by that. This is the whole reason chunks exist - a thread
-- matches because one passage in it matches, not because the thread's
-- average direction is vaguely related. Averaging the vectors instead
-- would reproduce exactly the dilution that made title+summary search
-- fail on long threads.
--
-- Returns the matching passage's anchors and an excerpt alongside the
-- thread projection, so a caller can jump straight to the relevant
-- part of the transcript instead of re-reading the thread's tail.
--
-- Recency. Cosine similarity has no time dimension, so "the conversation
-- we had on Tuesday" is not expressible as a query - a caller could only
-- search by topic and then eyeball `updated_at` on whatever came back.
-- Two knobs cover that:
--
--   p_updated_after - a hard floor on the thread's updated_at, applied
--     BEFORE ranking so match_limit spends its budget inside the window
--     rather than on older threads that then get discarded.
--
--   p_recency_boost - an additive, decaying nudge to the ORDERING only.
--     Sized by the caller; see CONVERSATION_SEARCH_RECENCY_BOOST in
--     venice/tools/conversation_search.ts for why it is small. Additive
--     rather than multiplicative because scores here sit in a narrow
--     band (median ~0.54, p99 ~0.71 on a 478-thread corpus), so a
--     multiplier large enough to matter would lift a median-relevance
--     recent thread above the best match in the corpus - recency would
--     stop being a preference and start being the whole ranking.
--
-- `similarity` is always the RAW cosine, never the boosted value. The
-- model reads that number to judge how good a hit is, so inflating it
-- would make the tool lie about relevance in order to express a
-- preference about time.
drop function if exists public.search_thread_chunks_by_embedding(vector, int, uuid);
drop function if exists public.search_thread_chunks_by_embedding(vector, int, uuid, timestamptz, real);
create or replace function public.search_thread_chunks_by_embedding(
  query_embedding vector(2048),
  match_limit int,
  p_user_id uuid default null,
  p_updated_after timestamptz default null,
  p_recency_boost real default 0
) returns table (
  id uuid,
  title text,
  archived boolean,
  updated_at timestamptz,
  similarity real,
  chunk_index int,
  start_msg_id uuid,
  end_msg_id uuid,
  excerpt text
)
language sql stable security invoker as $$
  -- Hidden threads' chunks stay in scope, resolved to a visible
  -- conversation rather than filtered out. A hidden thread's rows can
  -- be the live shared prefix of visible forks (see the "Conversation
  -- forking" section above), so a blanket hidden filter would blind
  -- recall and drawer search to every shared prefix; but surfacing the
  -- hidden thread itself would hand the UI a conversation the user
  -- cannot open. Resolution: a hit on a hidden thread walks down the
  -- fork tree to its nearest visible descendant whose transcript
  -- contains the chunk's rows, presents THAT thread as the hit, and is
  -- dropped when no such descendant exists (a deleted conversation
  -- awaiting GC - its chunks stop surfacing the moment it is deleted,
  -- not a GC cycle later).
  with recursive ranked as (
    select c.thread_id,
           c.chunk_index,
           c.start_msg_id,
           c.end_msg_id,
           c.content,
           t.hidden,
           (1 - (c.embedding <=> query_embedding))::real as similarity,
           row_number() over (
             partition by c.thread_id
             order by c.embedding <=> query_embedding asc
           ) as rn
      from public.thread_chunks c
      join public.threads t on t.id = c.thread_id
     where c.user_id = coalesce(p_user_id, auth.uid())
       and c.embedding is not null
  ),
  best as (
    select r.* from ranked r where r.rn = 1
  ),
  -- Walk down from each hidden-thread hit toward visible descendants.
  -- The first hop out of the chunk's owning thread must prove
  -- containment: the child's fork point (a row of the owner's own
  -- segment) must sit at or past the chunk's last row, otherwise the
  -- child's inherited prefix stops before the chunk. Deeper hops need
  -- no check - a grandchild inherits its parent's ENTIRE inherited
  -- prefix (fork-point truncation only applies within the direct
  -- parent's own segment), so containment is monotone below the first
  -- hop. A chunk whose end anchor went stale (anchors are soft
  -- pointers; a trimmed row leaves them dangling until the next
  -- rechunk) cannot prove containment and drops out here,
  -- conservatively. The walk only continues through hidden nodes
  -- (visible = destination), and the depth guard bounds a corrupted
  -- parent cycle, same posture as thread_transcript.
  walk as (
    select b.thread_id as chunk_thread,
           b.end_msg_id,
           b.thread_id as at_thread,
           true as at_hidden,
           0 as depth
      from best b
     where b.hidden
    union all
    select w.chunk_thread,
           w.end_msg_id,
           ch.id,
           ch.hidden,
           w.depth + 1
      from walk w
      join public.threads ch on ch.forked_from_thread_id = w.at_thread
     where w.at_hidden
       and w.depth < 100
       and (w.depth > 0
            or exists (
              select 1
                from public.messages fm
                join public.messages em on em.id = w.end_msg_id
               where fm.id = ch.forked_from_msg_id
                 and em.thread_id = w.chunk_thread
                 and fm.position >= em.position))
  ),
  -- Nearest visible descendant per hidden hit; ties (several forks at
  -- the same depth contain the chunk) go to the most recently active.
  resolved_hidden as (
    select distinct on (w.chunk_thread)
           w.chunk_thread,
           w.at_thread as display_id
      from walk w
      join public.threads d on d.id = w.at_thread
     where not w.at_hidden
     order by w.chunk_thread, w.depth asc, d.updated_at desc, d.id
  ),
  -- Each surviving hit under the thread the UI will present: visible
  -- owners as themselves, hidden owners as their resolved descendant.
  display as (
    select b.thread_id as display_id, b.similarity, b.chunk_index,
           b.start_msg_id, b.end_msg_id, b.content
      from best b
     where not b.hidden
    union all
    select rh.display_id, b.similarity, b.chunk_index,
           b.start_msg_id, b.end_msg_id, b.content
      from resolved_hidden rh
      join best b on b.thread_id = rh.chunk_thread
  ),
  -- Resolution can land a hidden ancestor's hit on a thread that also
  -- has its own hit: keep the strongest chunk per presented thread.
  -- The recency filter runs against the PRESENTED thread's updated_at
  -- (a live fork keeps its shared prefix searchable even after the
  -- hidden owner's own clock went stale).
  deduped as (
    select d.display_id, t.title, t.archived, t.updated_at,
           d.similarity, d.chunk_index, d.start_msg_id, d.end_msg_id,
           d.content,
           row_number() over (
             partition by d.display_id
             order by d.similarity desc
           ) as drn
      from display d
      join public.threads t on t.id = d.display_id
     where p_updated_after is null or t.updated_at >= p_updated_after
  )
  select dd.display_id, dd.title, dd.archived, dd.updated_at,
         dd.similarity, dd.chunk_index, dd.start_msg_id, dd.end_msg_id,
         left(dd.content, 400) as excerpt
    from deduped dd
   where dd.drn = 1
   -- Exponential decay with a 7-day constant: today gets the full
   -- boost, a week ago ~37% of it, a month ago ~1%. Zero boost (the
   -- default) collapses this to a plain similarity sort.
   order by dd.similarity
              + p_recency_boost
              * exp(-extract(epoch from (now() - dd.updated_at)) / 86400.0 / 7.0)
            desc
   limit match_limit
$$;

-- Retired: cosine search over the per-thread title+summary embedding.
-- Replaced by public.search_thread_chunks_by_embedding, which ranks
-- transcript chunks and aggregates to threads by best-matching chunk.
drop function if exists public.search_threads_by_embedding(vector, int);
drop function if exists public.search_threads_by_embedding(vector, int, uuid);

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

-- p_user_id: b-strict escape hatch; see search_memories_by_embedding
-- for the full rationale.
drop function if exists public.get_memory_relations(uuid[]);
drop function if exists public.get_memory_relations(uuid[], uuid);
create or replace function public.get_memory_relations(
  p_ids uuid[],
  p_user_id uuid default null
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
     and r.user_id = coalesce(p_user_id, auth.uid())
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
--     bge-m3 model emits 1024 dims; writers pad with zeros via
--     `padEmbeddingForStorage` (browser src/lib/models, edge
--     _shared/backfill.ts). Cosine similarity is invariant to that
--     padding.
--
-- The formation pipeline runs server-side in the venice function
-- (supabase/functions/venice/agents/samskara.ts), driven by the
-- chat-turn tail and the hourly nak-samskara-sweep cron. Per-row
-- claim columns on `samskara_substrate` and
-- `samskara_compound_summary` are the mutual exclusion between the
-- two drivers for work that crosses an LLM round-trip.

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

-- Pair-relate seed cursor. When the pair-relate probe seeds on this row
-- (to explore its associations) it stamps `pair_seeded_at = now()`; the
-- probe always seeds the longest-unseeded embedded row (nulls = never
-- seeded), round-robining the seed across the whole corpus instead of
-- pinning it to the newest observation. See samskara_pair_probe_candidates.
-- Index orders the seed pick (oldest-stamp-first, nulls first) over the
-- embedded rows the probe is allowed to seed.
alter table public.samskara_substrate
  add column if not exists pair_seeded_at timestamptz;

create index if not exists samskara_substrate_pair_seed_idx
  on public.samskara_substrate (user_id, pair_seeded_at nulls first)
  where situation_embedding is not null;

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
-- Pair-labels between substrate rows. Written by the pair-relate
-- probe via `samskara_associate` below. `(a_id, b_id,
-- articulated_relation)` is unique so re-encountering the same
-- relation between the same pair updates the existing row (the RPC's
-- conflict clause increments `reinforcement`) rather than
-- duplicating. The `kind` enum drops scratch's `'orthogonal'` value -
-- orthogonal verdicts are recorded in `samskara_pair_declines` so the
-- probe never re-asks, but they are not associations.
create table if not exists public.samskara_associations (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  a_id uuid not null references public.samskara_substrate(id) on delete cascade,
  b_id uuid not null references public.samskara_substrate(id) on delete cascade,
  articulated_relation text not null,
  kind text not null check (
    kind in ('pattern', 'contrast', 'prerequisite', 'consequence')
  ),
  reinforcement integer not null default 1,
  last_reinforced_at timestamptz not null default now(),
  -- Consumption stamp for the association-mint probe. NULL until the
  -- edge has been fed to the tier-1 minter; set to now() once it has -
  -- on a fresh mint, a dedup-hit, OR a decline alike. A stamped edge
  -- leaves the candidate pool permanently: substrate is immutable
  -- after assimilation, so this edge's evidence cannot change. Fresh
  -- corroboration of the same pattern arrives as NEW (unstamped) edges,
  -- which is how a consumed hub re-qualifies - the stamp is per-edge,
  -- never per-hub. See docs/dev/samskara.md and the association-mint
  -- plan.
  minted_at timestamptz,
  created_at timestamptz not null default now(),
  unique (user_id, a_id, b_id, articulated_relation)
);

create index if not exists samskara_associations_user_reinforced_idx
  on public.samskara_associations (user_id, last_reinforced_at desc);

-- Column migration for databases that predate this change: the
-- `create table if not exists` above is a no-op on an existing table,
-- so the add/drop happens here. Both guarded, both idempotent.
-- relation_embedding was reserved for label-level clustering and never
-- populated or read; dropping it is the cleanup half of the
-- association-mint work (re-adding is one guarded ALTER if that feature
-- ever lands).
alter table public.samskara_associations
  add column if not exists minted_at timestamptz;
alter table public.samskara_associations
  drop column if exists relation_embedding;

-- Hub selection scans only unconsumed edges, so a partial index keeps
-- it off the consumed bulk as the graph grows.
create index if not exists samskara_associations_user_unconsumed_idx
  on public.samskara_associations (user_id)
  where minted_at is null;

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

-- Auto-populate user_id on insert from the caller's session. A
-- user-session upsert that omits user_id would otherwise land NULL,
-- fail the RLS `with check (auth.uid() = user_id)` policy, and
-- return a 42501. NOTE the inverse trap for the service role: under
-- the venice function's admin client auth.uid() is NULL, so the
-- server-side pair-relate writer sets user_id explicitly.
-- Idempotent: `set default` overwrites any prior default, so
-- re-running the schema is safe.
alter table public.samskara_associations
  alter column user_id set default auth.uid();

-- Association upsert with a working reinforcement counter. PostgREST
-- upserts can only SET conflict columns to payload values, so the
-- TS-side writer could never express "increment the existing count" -
-- every re-accept overwrote reinforcement with the literal 1. This
-- RPC owns the conflict arithmetic instead. Re-encounters are rare by
-- design (the probe skips already-adjudicated pairs), but the
-- turn-tail and sweep drivers can still race the same fresh pair, and
-- the increment keeps the counter honest when they do. Returns the
-- post-write reinforcement so the caller can log it.
-- Pair-relate runs only under the venice function's service-role
-- client post-port, so EXECUTE is locked to service_role (same
-- posture as the sweep claims).
drop function if exists public.samskara_associate(uuid, uuid, uuid, text, text);
create or replace function public.samskara_associate(
  p_user_id uuid,
  p_a_id uuid,
  p_b_id uuid,
  p_label text,
  p_kind text
) returns integer
language sql security definer
set search_path = public as $$
  insert into public.samskara_associations
         (user_id, a_id, b_id, articulated_relation, kind)
  values (p_user_id, p_a_id, p_b_id, p_label, p_kind)
  on conflict (user_id, a_id, b_id, articulated_relation)
  do update set reinforcement = samskara_associations.reinforcement + 1,
                kind = excluded.kind,
                last_reinforced_at = now()
  returning reinforcement;
$$;

revoke all on function public.samskara_associate(uuid, uuid, uuid, text, text) from public, anon, authenticated;
grant execute on function public.samskara_associate(uuid, uuid, uuid, text, text) to service_role;

-- Association-mint hub selection --
--
-- Picks ONE hub - the substrate row with the most unconsumed
-- association evidence - and returns that hub's unconsumed edges so the
-- association-mint probe can cluster cross-session recurrence the
-- recency window can't see. Hub = the endpoint with the greatest summed
-- reinforcement over its DEDUPED unconsumed edges, requiring at least
-- two distinct partners (hub + 2 partners = 3 member rows, the minter's
-- floor). Edges are undirected, so each one credits both endpoints.
--
-- Edges are collapsed to one representative (highest-reinforcement) per
-- (hub, partner) BEFORE any ranking. pair-relate's unique key includes
-- the label text, so it writes a NEW row each time it phrases the same
-- pair's relation slightly differently - a hot pair accumulates dozens
-- of near-duplicate-labeled edges (observed: 28 edges for one pair).
-- Without the collapse those duplicates flood the minter's sample_labels
-- AND skew hub/partner selection toward whichever pair got re-labeled
-- the most, rather than the most genuinely-connected observation. After
-- the collapse, ranking reflects distinct corroborated relationships.
--
-- Returns the top (cluster-max minus one) partners by summed
-- reinforcement, one edge each. Zero rows when no hub qualifies: that's
-- the probe's quench condition (no LLM call). Snapshots situation text
-- for both endpoints so the caller needs no follow-up reads.
--
-- security definer + service_role-only, same as samskara_associate -
-- the probe runs under the admin client with no auth.uid().
drop function if exists public.samskara_association_cluster(uuid);
create or replace function public.samskara_association_cluster(p_user_id uuid)
returns table (
  association_id uuid,
  label text,
  kind text,
  reinforcement int,
  hub_id uuid,
  hub_situation text,
  partner_id uuid,
  partner_situation text
)
language sql security definer
set search_path = public as $$
  with unconsumed as (
    select id, a_id, b_id, articulated_relation, kind, reinforcement
      from public.samskara_associations
     where user_id = p_user_id and minted_at is null
  ),
  -- Undirected fan-out: one row per (endpoint, other endpoint) so an
  -- edge contributes to both of its substrate rows' hub scores.
  endpoints_all as (
    select a_id as hub, b_id as partner, id, articulated_relation, kind, reinforcement
      from unconsumed
    union all
    select b_id as hub, a_id as partner, id, articulated_relation, kind, reinforcement
      from unconsumed
  ),
  -- Collapse near-duplicate-labeled edges to one per (hub, partner) so
  -- the whole pipeline below ranks on distinct relationships, not on how
  -- many ways a single pair got phrased. Strongest edge wins, id breaks
  -- ties.
  endpoints as (
    select distinct on (hub, partner)
           hub, partner, id, articulated_relation, kind, reinforcement
      from endpoints_all
     order by hub, partner, reinforcement desc, id
  ),
  hub_rank as (
    select hub
      from endpoints
     group by hub
    having count(distinct partner) >= 2
     order by sum(reinforcement) desc, count(distinct partner) desc, hub
     limit 1
  ),
  ranked_partners as (
    select e.partner
      from endpoints e
      join hub_rank hr on e.hub = hr.hub
     group by e.partner
     order by sum(e.reinforcement) desc, e.partner
     limit 4  -- MINT_CLUSTER_MAX - 1 (hub + up to 4 partners = 5 members)
  )
  select e.id as association_id,
         e.articulated_relation as label,
         e.kind,
         e.reinforcement,
         hr.hub as hub_id,
         hsub.situation as hub_situation,
         e.partner as partner_id,
         psub.situation as partner_situation
    from endpoints e
    join hub_rank hr on e.hub = hr.hub
    join ranked_partners rp on rp.partner = e.partner
    join public.samskara_substrate hsub
      on hsub.id = hr.hub and hsub.user_id = p_user_id
    join public.samskara_substrate psub
      on psub.id = e.partner and psub.user_id = p_user_id
   order by e.reinforcement desc, e.id;
$$;

revoke all on function public.samskara_association_cluster(uuid) from public, anon, authenticated;
grant execute on function public.samskara_association_cluster(uuid) to service_role;

-- Pair declines --
--
-- Permanent memory of relator "orthogonal" verdicts. Substrate rows
-- are immutable once assimilated (situation/outcome never change), so
-- a declined pair would get the same verdict on every re-ask - the
-- ledger lets the pair-relate probe skip adjudicated pairs instead of
-- burning a Venice call per probe re-asking the same question on a
-- quiet corpus. No TTL on purpose: a decline can only become stale if
-- substrate content becomes mutable, which would be a design change.
-- (a_id, b_id) are stored in canonical order (a_id < b_id), same
-- convention as samskara_associations.
create table if not exists public.samskara_pair_declines (
  user_id uuid not null references auth.users(id) on delete cascade,
  a_id uuid not null references public.samskara_substrate(id) on delete cascade,
  b_id uuid not null references public.samskara_substrate(id) on delete cascade,
  declined_at timestamptz not null default now(),
  primary key (user_id, a_id, b_id)
);

alter table public.samskara_pair_declines enable row level security;

-- Select-only for the owner (diagnostics surfaces may want to show
-- declines). Writes come exclusively from the venice function's
-- service-role client, which bypasses RLS - no client write path, so
-- no insert/update/delete policies.
drop policy if exists "samskara pair declines self-selectable" on public.samskara_pair_declines;
create policy "samskara pair declines self-selectable" on public.samskara_pair_declines
  for select using (auth.uid() = user_id);

-- Tier-2 candidate declines --
--
-- Memory of tier-2-minter "confirm:false" verdicts on a co-fire
-- constellation, so detection (samskara_tier2_candidate) advances past
-- a declined group instead of re-offering the SAME strongest-lift group
-- every sweep. Without this, a persistently-declined top candidate
-- starves every weaker uncovered constellation behind it - the
-- coverage skip only knew about MINTED tier-2s, not declines.
--
-- Unlike samskara_pair_declines, this ledger is TTL'd, NOT permanent:
-- the candidate walk only honors a decline within a recency window (see
-- the candidate function's v_decline_ttl). A pair decline is permanent
-- because substrate is immutable, so the verdict can never change. A
-- tier-2 decline is over a CO-FIRE constellation, and the co-fire graph
-- keeps growing - a group the minter rejected as too weak today may
-- accumulate enough joint firing to be worth re-offering later. The TTL
-- is the re-arm: a declined group goes quiet for the window, then
-- re-qualifies.
--
-- `group_key` is the sorted child ids joined with ',' - a stable
-- identity for the constellation so a re-decline upserts (refreshing
-- declined_at, re-arming the window) rather than inserting a duplicate.
-- `children` is the sorted child-id array, read back for the Jaccard
-- overlap test. No per-element FK (arrays can't reference) - a deleted
-- child leaves a stale id in the array, which only weakens the Jaccard
-- match slightly and is cleared by the TTL within the window anyway.
create table if not exists public.samskara_tier2_declines (
  user_id uuid not null references auth.users(id) on delete cascade,
  group_key text not null,
  children uuid[] not null,
  declined_at timestamptz not null default now(),
  primary key (user_id, group_key)
);

alter table public.samskara_tier2_declines enable row level security;

-- Select-only for the owner; writes come exclusively from the venice
-- function's service-role client, same as samskara_pair_declines.
drop policy if exists "samskara tier2 declines self-selectable" on public.samskara_tier2_declines;
create policy "samskara tier2 declines self-selectable" on public.samskara_tier2_declines
  for select using (auth.uid() = user_id);

-- Pair-relate seed rotation + partner selection --
--
-- Picks ONE pair-relate seed and returns its best unadjudicated
-- partners, corpus-wide. Replaces an earlier probe that seeded only on
-- the NEWEST embedded substrate row and ranked partners within just the
-- 40 most-recent rows - a recency-pinned walk that left associations
-- among older observations permanently unexplored (the association
-- graph, which feeds mint-tier1-assoc, only ever grew near the recency
-- frontier).
--
-- Seed = the embedded row that has waited longest since it was last
-- seeded (pair_seeded_at asc, nulls = never seeded first), so the seed
-- round-robins across the whole corpus over successive probes. The seed
-- is stamped on selection so the walk advances next probe even if this
-- seed yields no pair (a fully-adjudicated or neighbourless seed quenches
-- this tick without an LLM call, then steps aside). Partners = every
-- other embedded row within p_floor cosine of the seed that the relator
-- has NOT already ruled on (accepted pairs in samskara_associations,
-- declined pairs in samskara_pair_declines, either direction), ordered
-- by cosine desc, capped at p_k. The caller relates the top row.
--
-- No vector index on situation_embedding on purpose: the per-probe
-- nearest-neighbour scan is a sequential cosine over the user's embedded
-- substrate, which is cheap at this corpus scale and runs hourly, not on
-- a hot path - the same reasoning that retired the memories HNSW index.
-- Revisit with an ANN index only if the substrate corpus grows enough to
-- make the seqscan the sweep's bottleneck.
--
-- security definer + service_role-only, same posture as
-- samskara_associate - the probe runs under the admin client with no
-- auth.uid(), and the function writes (the seed stamp).
drop function if exists public.samskara_pair_probe_candidates(uuid, int, real);
create or replace function public.samskara_pair_probe_candidates(
  p_user_id uuid,
  p_k       int  default 8,
  p_floor   real default 0.30
) returns table (
  seed_id           uuid,
  seed_situation    text,
  seed_outcome      text,
  partner_id        uuid,
  partner_situation text,
  partner_outcome   text,
  cosine            real
)
language plpgsql security definer
set search_path = public as $$
declare
  v_seed_id        uuid;
  v_seed_situation text;
  v_seed_outcome   text;
  v_seed_embedding vector(2048);
begin
  -- Longest-unseeded embedded row wins the seed.
  select s.id, s.situation, s.outcome, s.situation_embedding
    into v_seed_id, v_seed_situation, v_seed_outcome, v_seed_embedding
    from public.samskara_substrate s
   where s.user_id = p_user_id
     and s.situation_embedding is not null
   order by s.pair_seeded_at asc nulls first, s.id
   limit 1;
  if v_seed_id is null then
    return;
  end if;

  -- Stamp the seed so the next probe advances regardless of whether this
  -- one yields a pair (prevents a neighbourless seed from wedging the
  -- walk on every tick).
  update public.samskara_substrate
     set pair_seeded_at = now()
   where id = v_seed_id;

  return query
    select v_seed_id, v_seed_situation, v_seed_outcome,
           p.id, p.situation, p.outcome,
           (1 - (p.situation_embedding <=> v_seed_embedding))::real as cos
      from public.samskara_substrate p
     where p.user_id = p_user_id
       and p.situation_embedding is not null
       and p.id <> v_seed_id
       and (1 - (p.situation_embedding <=> v_seed_embedding))::real >= p_floor
       and not exists (
         select 1 from public.samskara_associations a
          where a.user_id = p_user_id
            and a.a_id = least(v_seed_id, p.id)
            and a.b_id = greatest(v_seed_id, p.id)
       )
       and not exists (
         select 1 from public.samskara_pair_declines d
          where d.user_id = p_user_id
            and d.a_id = least(v_seed_id, p.id)
            and d.b_id = greatest(v_seed_id, p.id)
       )
     order by cos desc
     limit p_k;
end $$;

revoke all on function public.samskara_pair_probe_candidates(uuid, int, real) from public, anon, authenticated;
grant execute on function public.samskara_pair_probe_candidates(uuid, int, real) to service_role;

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
  -- Verdict tallies are REAL, not integer. samskara_apply_evaluation
  -- discounts these by the evidence half-life and folds in each verdict
  -- (held -> confirm, contradicted -> disconfirm); health is their
  -- derived posterior, and the discount alone keeps them fractional. An
  -- integer column truncated the sub-unit increments of the earlier
  -- reaction classifier back to 0, which silently froze confidence at
  -- its prior and (under the since-retired wall-clock decay) drove the
  -- whole corpus to health 0 - the bug this column's type prevents.
  confirm_count real not null default 0,
  disconfirm_count real not null default 0,
  last_fired_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists samskaras_user_tier_idx
  on public.samskaras (user_id, tier);

create index if not exists samskaras_user_health_idx
  on public.samskaras (user_id, health desc, confidence desc);

-- Promote the reaction tallies from integer to real on databases that
-- predate the type fix. `create table if not exists` above is a no-op
-- on an existing table, so the column type only changes here. Guarded
-- so the schema re-apply is idempotent: once the columns are real the
-- block does nothing. int -> real is a value-preserving widening
-- (every stored integer is exactly representable), so no data is lost
-- when the one-time rewrite runs.
do $$
begin
  if (select data_type from information_schema.columns
       where table_schema = 'public' and table_name = 'samskaras'
         and column_name = 'confirm_count') = 'integer' then
    alter table public.samskaras alter column confirm_count type real;
    alter table public.samskaras alter column disconfirm_count type real;
  end if;
end $$;

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

-- Auto-populate user_id from auth.uid() on insert; same RLS-failure
-- symptom and same service-role caveat as samskara_associations
-- above (the venice function's mint writers set user_id
-- explicitly). The default + the RLS `with check` policy combine so
-- user-session callers can't attribute a samskara to someone else -
-- the session identity wins.
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

-- Aggressive autovacuum for an insert-heavy, self-joined table.
-- samskara_collapse_by_cofiring self-joins this table on cohort_id
-- every hourly sweep; its candidate-enumeration step is an Index Only
-- Scan over samskara_fires_no_dup_in_cohort. With Postgres defaults
-- (insert_scale_factor 0.2) the visibility map lags the steady insert
-- stream, so the "index only" scan fell back to ~90k heap fetches per
-- pass - the dominant cost of that RPC. Vacuuming after 5% growth
-- keeps the VM fresh so the scan stays heap-free. The plain
-- scale_factor is lowered to match because _samskara_merge_pair also
-- retargets/deletes loser fires (updates + deletes), and those dead
-- tuples want collecting on the same cadence.
alter table public.samskara_fires set (
  autovacuum_vacuum_insert_scale_factor = 0.05,
  autovacuum_vacuum_scale_factor = 0.05
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

-- Retrospective evaluation verdict for this fire, set by the samskara
-- evaluation sweep (the next-day judge that replaces the live reaction
-- classifier). One of 'held' | 'contradicted' | 'not-engaged', or NULL
-- until the owning thread is evaluated. Distinct from was_confirmed (the
-- two-state boolean the legacy live classifier set): verdict is the
-- three-state signal the sweep records per fired samskara and the basis
-- for the health delta it applies. Values are controlled by the edge
-- agent (a trusted internal boundary), so no CHECK constraint here.
alter table public.samskara_fires
  add column if not exists verdict text;

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

-- samskara_fires_unresolved_idx served the retired reaction classifier's
-- "oldest unresolved cohort in the 1-10min window" poll (partial on
-- was_confirmed is null). Nothing reads that access path anymore - the
-- evaluation backlog counts verdict is null, which at this scale is a
-- cheap unindexed count. Dropped from existing databases on re-apply.
drop index if exists public.samskara_fires_unresolved_idx;

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
drop function if exists public.samskara_fire_top_k(vector, int, uuid);
create or replace function public.samskara_fire_top_k(
  p_query_embedding vector(2048),
  p_k_max int,
  p_user_id uuid default null
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
   -- p_user_id: priming runs server-side now, where the service-role
   -- client has no auth.uid(); the orchestrator passes the JWT user id
   -- explicitly. Authenticated callers omit it and fall back to
   -- auth.uid() (the b-strict overload pattern, as on the bias RPCs).
   where s.user_id = coalesce(p_user_id, auth.uid())
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
drop function if exists public.samskara_record_fires(uuid, uuid, integer, jsonb, uuid);
create or replace function public.samskara_record_fires(
  p_cohort_id uuid,
  p_thread_id uuid,
  p_user_round integer,
  p_fires jsonb,
  -- p_user_id: priming runs server-side now, where the service-role
  -- client has no auth.uid(); the orchestrator passes the JWT user id
  -- explicitly. Authenticated callers omit it (b-strict overload).
  p_user_id uuid default null
) returns void
language plpgsql security invoker as $$
declare
  v_uid uuid := coalesce(p_user_id, auth.uid());
begin
  if v_uid is null then
    return;
  end if;
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
  -- save_thread_chunks_if_claimed): silent skip on a non-owned
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

-- samskara_apply_reaction (the live reaction classifier's apply step) is
-- RETIRED. Reaction scoring moved to the next-day evaluation sweep, whose
-- samskara_apply_evaluation (in the self-calibrating block below) is the
-- sole writer of the verdict tallies + health. Dropped from existing
-- databases on re-apply - both the current 5-arg signature and the
-- legacy 4-arg one (drop is signature-specific, so the live 5-arg
-- version needs its own line or it silently survives).
drop function if exists public.samskara_apply_reaction(uuid, uuid[], uuid[], uuid[], uuid);
drop function if exists public.samskara_apply_reaction(uuid, uuid[], uuid[], uuid[]);

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
-- Threshold default 0.85 matches MINT_DEDUP_COSINE in the formation
-- pipeline (supabase/functions/venice/agents/samskara.ts); drop to
-- ~0.75 if cohorts come back splintered.
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
-- p_user_id overload: the venice function's turn tail claims with the
-- service-role client, which has no auth.uid(). Trailing default keeps
-- the function role-agnostic. The old 2-arg signature is dropped so
-- PostgREST resolves the call unambiguously.
drop function if exists public.samskara_claim_next_assimilate(text, int);
create or replace function public.samskara_claim_next_assimilate(
  p_holder_id text,
  p_ttl_seconds int,
  p_user_id uuid default null
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
     where s.user_id = coalesce(p_user_id, auth.uid())
       and s.situation is null
       and (s.assimilate_claim_expires is null
            or s.assimilate_claim_expires < now())
       and (
         -- Junk-data gate, same substance bar as the reflection /
         -- wiki / evaluation claims: substrate from a thread with a
         -- single user message (a one-shot lookup) says nothing about
         -- the user and would pollute minting upstream. The stub is
         -- deferred, not dropped - it becomes claimable the moment a
         -- second user message lands on its thread.
         select count(*)
           from public.messages m
          where m.thread_id = s.thread_id
            and m.role = 'user'
       ) >= 2
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

-- Global sweep variant for the hourly samskara sweep: no user filter,
-- owner-privileged, returns user_id so the sweep can scope the
-- follow-up reads and attribute drawer logs. The per-row claim
-- columns are the mutual exclusion between this and the turn tail.
-- EXECUTE locked to service_role below.
create or replace function public.samskara_claim_next_assimilate_for_sweep(
  p_holder_id text,
  p_ttl_seconds int
) returns table (
  id uuid,
  thread_id uuid,
  user_message_id uuid,
  assistant_message_id uuid,
  user_id uuid
)
language sql security definer
set search_path = public as $$
  with candidate as (
    select s.id
      from public.samskara_substrate s
     where s.situation is null
       and (s.assimilate_claim_expires is null
            or s.assimilate_claim_expires < now())
       and (
         -- Same junk-data gate as the per-user claim above: stubs
         -- from single-user-message threads wait until the thread
         -- earns a second user message.
         select count(*)
           from public.messages m
          where m.thread_id = s.thread_id
            and m.role = 'user'
       ) >= 2
     order by s.created_at asc
     limit 1
     for update skip locked
  )
  update public.samskara_substrate s
     set assimilate_claim_holder = p_holder_id,
         assimilate_claim_expires = now() + make_interval(secs => p_ttl_seconds)
    from candidate c
   where s.id = c.id
  returning s.id, s.thread_id, s.user_message_id, s.assistant_message_id, s.user_id;
$$;

revoke all on function public.samskara_claim_next_assimilate_for_sweep(text, int) from public, anon, authenticated;
grant execute on function public.samskara_claim_next_assimilate_for_sweep(text, int) to service_role;

-- Sweep user discovery: users with recent samskara activity get the
-- per-user maintenance rotation (pair-relate, mints, dedup, regen)
-- each tick. Substrate creation and fires are the two activity
-- signals; union dedups. The probes themselves are self-limiting
-- (regen has its own predicate, dedup self-caps), so a user the
-- window over-includes costs a few cheap reads.
create or replace function public.samskara_sweep_users(
  p_window_hours int default 2
) returns table (user_id uuid)
language sql security definer
set search_path = public as $$
  select s.user_id
    from public.samskara_substrate s
   where s.created_at > now() - make_interval(hours => p_window_hours)
  union
  select f.user_id
    from public.samskara_fires f
   where f.fired_at > now() - make_interval(hours => p_window_hours);
$$;

revoke all on function public.samskara_sweep_users(int) from public, anon, authenticated;
grant execute on function public.samskara_sweep_users(int) to service_role;

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
  p_valence real,
  p_user_id uuid default null
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
     and user_id = coalesce(p_user_id, auth.uid())
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
-- Global service-definer sweep, same shape as claim_next_pending_memory:
-- no auth.uid() filter, owner-privileged, EXECUTE locked to service_role below.
-- The situation-not-null predicate (skip unassimilated rows) is preserved.
create or replace function public.samskara_claim_next_substrate_embed(
  p_holder_id text,
  p_ttl_seconds int
) returns table (id uuid, situation text, outcome text, user_id uuid)
language sql security definer
set search_path = public as $$
  with candidate as (
    select s.id
      from public.samskara_substrate s
     where s.situation_embedding is null
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
  returning s.id, s.situation, s.outcome, s.user_id;
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
language plpgsql security definer
set search_path = public as $$
declare
  updated int;
begin
  update public.samskara_substrate
     set situation_embedding = p_embedding,
         embedding_model = p_embedding_model,
         embedding_claim_holder = null,
         embedding_claim_expires = null
   where id = p_id
     and embedding_claim_holder = p_holder_id
     and embedding_claim_expires > now();
  get diagnostics updated = row_count;
  return updated > 0;
end $$;

-- Service-role only - see the note on the memory pair.
revoke all on function public.samskara_claim_next_substrate_embed(text, int) from public, anon, authenticated;
revoke all on function public.samskara_save_substrate_embedding_if_claimed(uuid, text, vector, text) from public, anon, authenticated;
grant execute on function public.samskara_claim_next_substrate_embed(text, int) to service_role;
grant execute on function public.samskara_save_substrate_embedding_if_claimed(uuid, text, vector, text) to service_role;

-- samskara_decay_sweep (wall-clock decay) is RETIRED - health is now the
-- relevance-gated posterior maintained by samskara_apply_evaluation (see
-- the self-calibrating block below); the nak-samskara-decay cron is
-- unscheduled near the stream janitor. Dropped, along with the earlier
-- samskara_decay() signature, from existing databases on re-apply.
drop function if exists public.samskara_decay();
drop function if exists public.samskara_decay_sweep();

-- ===========================================================================
-- Self-calibrating health (relevance-gated decay; the evaluation sweep).
-- Design of record: docs/dev/plans/samskara-decay-relevance-gated-plan.md.
-- These RPCs ARE the live health mechanism: samskara_apply_evaluation
-- (called by the next-day evaluation sweep) is the sole writer of the
-- verdict tallies and the derived health posterior, and samskara_reap_dead
-- runs on the nak-samskara-reap cron. The wall-clock decay sweep and the
-- live reaction classifier they replaced are retired (dropped above).
-- ===========================================================================

-- Population hit-rate prior p0: the user's aggregate held-rate over the
-- current verdict tallies, with a weak neutral fallback until enough
-- evidence accrues so a cold start doesn't swing on one or two points.
-- This is the "calibrate from aggregate metrics" prior - a fresh or
-- evidence-less samskara's derived health sits here, at the user's own
-- baseline, not at a guessed constant. Service-role only (it reads across
-- a user's whole corpus via the p_user_id param, so it must not be
-- reachable by a caller who could pass someone else's id).
drop function if exists public.samskara_population_p0(uuid);
create or replace function public.samskara_population_p0(p_user_id uuid)
returns real
language sql stable security definer set search_path = public as $$
  select case
    when coalesce(sum(confirm_count + disconfirm_count), 0) < 20.0 then 0.66::real
    else (sum(confirm_count) / nullif(sum(confirm_count + disconfirm_count), 0))::real
  end
  from public.samskaras
  where user_id = p_user_id;
$$;
revoke all on function public.samskara_population_p0(uuid) from public, anon, authenticated;
grant execute on function public.samskara_population_p0(uuid) to service_role;

-- Verdict-apply for the evaluation sweep - the self-calibrating successor
-- to samskara_apply_reaction. For every samskara that received a GENUINE
-- TEST in a judged thread, age its prior evidence by the discount d, fold
-- in this evaluation's verdict, then recompute health as the empirical-
-- Bayes posterior shrunk toward p0. The verdicts map to hit/miss evidence:
--   held         -> a full hit       (confirm += 1)
--   contradicted -> a full miss       (disconfirm += 1) - the user did the opposite
--   not-borne-out -> a SOFT miss      (disconfirm += w_soft) - the prediction's
--                    situation arose but the predicted tendency did not appear;
--                    weaker evidence than an active contradiction, so it counts
--                    fractionally. This is the verdict that gives health its
--                    discriminating power: without it, an on-topic prediction
--                    that fires constantly and never lands stays pinned at the
--                    prior because not-engaged is neutral.
--   not-engaged  -> NOT PASSED to this function at all. The situation never
--                    arose (a loose topical fire) - no fair test, no evidence,
--                    and critically NO DISCOUNT either. An earlier version
--                    accepted the not-engaged ids and applied the discount to
--                    them ("forgetting" per evaluation); live data killed
--                    that: ~80% of judged fires land not-engaged, so evidence
--                    decayed ~4x faster than genuine tests could accrue it,
--                    the biggest tally in a 184-samskara corpus was 5.5
--                    confirms, and every posterior sat pinned at p0 (156/184
--                    rows at 0.95). Decay now ages evidence per GENUINE TEST
--                    only: the half-life L is denominated in tests, and a
--                    samskara that merely fires near a conversation neither
--                    earns nor loses anything.
-- health and confidence are kept EQUAL - both ARE the posterior, the single
-- "earning its keep" score the fire RPC's sqrt(health*confidence) collapses
-- to (so no fire-score change is needed). The posterior is a weighted
-- average of {0,1} outcomes and p0 in [0,1], so it is inherently bounded to
-- [0,1] - it cannot run away the way the old accumulator could. Model knobs:
-- k (prior strength), the evidence half-life L (in genuine tests) behind the
-- discount d = 0.5^(1/L), and w_soft (the soft-miss weight). Caller (the
-- service-role sweep) must pass each genuinely-tested samskara in exactly
-- one of the three arrays.
--
-- The drops clear the two prior signatures on existing databases: the
-- pre-soft-miss 4-arg form (user, held, contradicted, not_engaged) and the
-- 5-arg form that took not-engaged for the per-evaluation discount. The new
-- 4-arg form has the same TYPES as the pre-soft-miss one but different
-- semantics, so the drop-then-create is what keeps re-application
-- unambiguous (see CLAUDE.md on RPC signature changes).
drop function if exists public.samskara_apply_evaluation(uuid, uuid[], uuid[], uuid[]);
drop function if exists public.samskara_apply_evaluation(uuid, uuid[], uuid[], uuid[], uuid[]);
create or replace function public.samskara_apply_evaluation(
  p_user_id uuid,
  p_held uuid[],
  p_contradicted uuid[],
  p_not_borne_out uuid[]
) returns int
language plpgsql security definer set search_path = public as $$
declare
  k constant real := 5.0;                       -- prior strength (pseudo-count)
  l_halflife constant real := 10.0;             -- evidence half-life, in genuine tests
  d constant real := 0.5 ^ (1.0 / l_halflife);  -- per-test discount
  -- Soft-miss weight: a "not-borne-out" (situation arose, tendency did not
  -- appear) is real but weaker evidence against the prediction than a flat
  -- contradiction, so it counts as a fraction of a miss. This is the one
  -- deliberately hand-chosen magnitude in the model (k, L, and p0 are
  -- data-derived). It is set deliberately GENTLE for launch: a counterfactual
  -- of the live corpus showed only the product w_soft * (not-borne-out rate)
  -- is identifiable, and that rate is unknown until the judge runs - at 0.25
  -- the effective decay stays in the healthy band even if every not-engaged
  -- turns out to be an on-topic miss, whereas a larger value risks driving the
  -- whole corpus below the reap floor. Recalibrate from the observed live
  -- not-borne-out rate once it exists (raise to hit a target median health);
  -- under-decay is a one-line bump, over-decay needs ~L cycles to re-earn.
  -- First live reading (2026-07-06, single-user corpus): not-borne-out ran
  -- 6.7% of genuine tests (124 of 1848 judged since the fire-score floor
  -- landed on 2026-06-11) - input for the judge-calibration pass.
  w_soft constant real := 0.25;
  v_p0 real;
  affected int;
begin
  -- Snapshot the prior BEFORE this evaluation's updates so one cycle's
  -- writes don't feed back into its own shrinkage target.
  v_p0 := public.samskara_population_p0(p_user_id);

  with judged as (
    select unnest(p_held)         as id, 1.0::real as h, 0.0::real   as m
    union all
    select unnest(p_contradicted) as id, 0.0::real as h, 1.0::real   as m
    union all
    select unnest(p_not_borne_out) as id, 0.0::real as h, w_soft     as m
  ),
  computed as (
    select s.id,
           s.confirm_count * d + j.h    as new_confirm,
           s.disconfirm_count * d + j.m as new_disconfirm
      from public.samskaras s
      join judged j on j.id = s.id and s.user_id = p_user_id
  )
  update public.samskaras s
     set confirm_count    = c.new_confirm,
         disconfirm_count = c.new_disconfirm,
         -- The merged posterior: written to BOTH health and confidence so
         -- the fire score's sqrt(health*confidence) equals it exactly.
         health     = (c.new_confirm + k * v_p0) / (c.new_confirm + c.new_disconfirm + k),
         confidence = (c.new_confirm + k * v_p0) / (c.new_confirm + c.new_disconfirm + k),
         updated_at = now()
    from computed c
   where s.id = c.id;
  get diagnostics affected = row_count;
  return affected;
end $$;
revoke all on function public.samskara_apply_evaluation(uuid, uuid[], uuid[], uuid[])
  from public, anon, authenticated;
grant execute on function public.samskara_apply_evaluation(uuid, uuid[], uuid[], uuid[])
  to service_role;

-- Reaper: delete repeatedly-contradicted, long-quiet samskaras. Under
-- derived health a never-tested prediction sits at p0 (the baseline), so a
-- LOW health now means real accumulated misses, not mere staleness. Only
-- rows below the floor AND not fired in >= p_quiet_days are removed, so a
-- recurring prediction mid-re-evaluation is never reaped, and never-fired
-- rows (last_fired_at null - newborns, or the bug-era evidence-less rows
-- now sitting at p0) are spared by the not-null guard. Returns the count.
--
-- The floor is a RATIO of the user's own prior p0, not an absolute. The
-- original absolute floor (0.15) was unreachable arithmetic: the posterior
-- is bounded below by k*p0 / (m_max + k), and with k=5, the decay ceiling
-- m_max = 1/(1-d) ~= 14.4, and the observed p0 ~= 0.95, even a samskara
-- contradicted on every genuine test forever converges to ~0.25 - above
-- the floor, so nothing could ever be reaped. At the 0.5 ratio a row is
-- reaped once its net miss evidence outweighs roughly k genuine tests'
-- worth of prior (m - c > k when c ~= 0) - reachable, but only through
-- repeated real failure, never through mere staleness.
drop function if exists public.samskara_reap_dead(real, int);
create or replace function public.samskara_reap_dead(
  p_floor_ratio real default 0.5,
  p_quiet_days int default 14
) returns int
language plpgsql security definer set search_path = public as $$
declare
  affected int;
begin
  -- One p0 per owner, evaluated once per user rather than per row (the
  -- prior aggregates the user's whole corpus).
  with p0 as (
    select u.user_id, public.samskara_population_p0(u.user_id) as v
      from (select distinct user_id from public.samskaras) u
  )
  delete from public.samskaras s
   using p0
   where p0.user_id = s.user_id
     and s.health < p_floor_ratio * p0.v
     and s.last_fired_at is not null
     and s.last_fired_at < now() - make_interval(days => p_quiet_days);
  get diagnostics affected = row_count;
  return affected;
end $$;
revoke all on function public.samskara_reap_dead(real, int) from public, anon, authenticated;
grant execute on function public.samskara_reap_dead(real, int) to service_role;

-- Probation reaper: delete samskaras that have NEVER been genuinely
-- tested (evidence tallies exactly zero - every genuine verdict, even a
-- soft miss, leaves a nonzero tally) after a generous settling window.
-- This is the complement to samskara_reap_dead: that one clears claims
-- disproven by real misses; this one clears claims whose topic never
-- genuinely arose at all - the one-off-lookup mints (a burst of
-- questions about some technology, a single shopping errand) that
-- otherwise sit at the p0 baseline forever, each holding a capped
-- tier-1 slot.
--
-- Why an age window is honest evidence here: measured on the live
-- corpus (2026-07), samskaras that ever get genuinely tested see their
-- first genuine test fast - median under 1 day, p90 ~13 days, worst
-- observed ~65 days - because the evaluation judge tests every fire
-- against the next day's settled conversation. 45 days of that
-- coverage without a single genuine engagement means the predicted
-- situation is not part of the user's life, not that the judge hasn't
-- looked. The window is wall-clock, which is calibrated to a
-- daily-active user; an account idle for weeks under-tests its corpus
-- and would need the window widened.
--
-- Guards:
--   - evidence must be exactly zero: any judged genuine verdict writes
--     confirm_count or disconfirm_count > 0, and discounting decays
--     them toward-but-never-to zero, so = 0 identifies never-tested
--     precisely.
--   - an unresolved fire (verdict pending) spares the row: it may be
--     the first genuine test, and the next-day judge hasn't ruled yet.
--
-- A reaped claim is cheap to lose: if the pattern is real and recurs,
-- minting re-creates it from fresh substrate.
create or replace function public.samskara_reap_untested(
  p_min_age_days int default 45
) returns int
language plpgsql security definer set search_path = public as $$
declare
  affected int;
begin
  delete from public.samskaras s
   where s.confirm_count = 0
     and s.disconfirm_count = 0
     and s.created_at < now() - make_interval(days => p_min_age_days)
     and not exists (
       select 1 from public.samskara_fires f
        where f.samskara_id = s.id and f.verdict is null
     );
  get diagnostics affected = row_count;
  return affected;
end $$;
revoke all on function public.samskara_reap_untested(int) from public, anon, authenticated;
grant execute on function public.samskara_reap_untested(int) to service_role;

-- Junk-thread fire expiry: stamp a terminal 'not-engaged' on fires
-- whose owning thread the judge will never evaluate.
--
-- Fires are recorded on EVERY user message, including the first
-- message of a thread. The evaluation sweep's junk-data gate skips
-- threads with fewer than two user messages forever (a one-round
-- lookup is not evidence about the user), so fires on abandoned
-- one-round threads stay verdict-null permanently. Left alone, that
-- sediment poisons two other readings: the "awaiting judgment" count
-- grows without bound (measured 2026-08-10: 1,840 of 2,084 pending
-- fires were sediment, the oldest from April), and - much worse - the
-- spare-the-pending-test guard in samskara_reap_untested and
-- samskara_evict_for_mint reads each sediment fire as "test in
-- flight" and permanently shields its samskara: 132 of 150 tier-1
-- rows were exempt from every guarded release path.
--
-- 'not-engaged' is the honest terminal verdict: the predicted
-- situation never genuinely arose in that thread. It carries no
-- health evidence (the sweep never passes not-engaged fires to
-- samskara_apply_evaluation), so expiry only unblocks bookkeeping -
-- it cannot move any posterior.
--
-- The abandonment test is ACTIVITY-relative, not wall-clock: a
-- thread's fires expire only once the user has written a message in
-- a DIFFERENT thread at least 24h after this thread's newest
-- message - "came back and moved on". A user idle for a week or a
-- month produces no later activity, so nothing expires while they
-- are away, and the gap can never be caused by absence alone.
--
-- If an expired thread later gains its second user round, the judge
-- evaluates the thread normally; the pre-stamped round-1 fires keep
-- their terminal verdict (a small, accepted evidence loss - the
-- alternative is sediment that never clears).
create or replace function public.samskara_expire_junk_thread_fires()
returns int
language plpgsql security definer set search_path = public as $$
declare
  affected int;
begin
  with junk_threads as (
    select t.id, t.user_id, newest.at as newest_at
      from public.threads t
      cross join lateral (
        select max(m.created_at) as at
          from public.messages m where m.thread_id = t.id
      ) newest
     where exists (
             select 1 from public.samskara_fires f
              where f.thread_id = t.id and f.verdict is null
           )
       and (
             select count(*) from public.messages m
              where m.thread_id = t.id and m.role = 'user'
           ) < 2
  ),
  abandoned as (
    select jt.id
      from junk_threads jt
     where exists (
             select 1
               from public.messages m2
               join public.threads t2 on t2.id = m2.thread_id
              where t2.user_id = jt.user_id
                and m2.thread_id <> jt.id
                and m2.role = 'user'
                and m2.created_at >= jt.newest_at + interval '24 hours'
           )
  )
  update public.samskara_fires f
     set verdict = 'not-engaged'
    from abandoned a
   where f.thread_id = a.id
     and f.verdict is null;
  get diagnostics affected = row_count;
  return affected;
end $$;
revoke all on function public.samskara_expire_junk_thread_fires() from public, anon, authenticated;
grant execute on function public.samskara_expire_junk_thread_fires() to service_role;

-- Cap-pressure eviction: free one tier-1 slot for a pending mint by
-- deleting the corpus's most-disproven untested row. Called by the
-- mint-tier1 probe only when the population cap blocks a mint, so
-- eviction happens exactly as fast as formation pressure demands -
-- decay by replacement, not by clock.
--
-- The victim must be strongly evidenced as junk, not merely quiet:
--   - never genuinely tested (evidence tallies zero, as in
--     samskara_reap_untested), and
--   - judged at least 10 times without one genuine engagement. The
--     next-day judge stamps every settled fire; 10+ not-engaged
--     rulings with zero engagements means the topic's neighborhood
--     keeps coming up and the claim never actually connects. (Live
--     corpus 2026-07: the median untested row has only 2 judged
--     fires - those are merely quiet and are NOT evictable.)
--   - at least 14 days old, so a newborn isn't evicted before the
--     judge has had a real chance (p90 time-to-first-genuine-test is
--     ~13 days).
--   - no unresolved fire (same spare-the-pending-test guard as the
--     probation reaper).
-- Victims are ranked most-judged-first (the most adjacency-disproven
-- row goes first), oldest as the tiebreak.
--
-- When no untested row qualifies, a SECOND tier keeps eviction
-- pressure alive as the corpus matures: weakly-established rows gone
-- stale. Without it, one genuine test ever is a lifetime pass - a row
-- that held once and never genuinely engaged again is untouchable by
-- probation (nonzero tally) and by tier one here, and a mature corpus
-- fills with exactly those. A stale-tier victim must be:
--   - genuinely tested at some point (tally > 0 - never-tested rows
--     belong to tier one / probation, not here), but only weakly:
--     total tally <= 1.0, i.e. at most one full test's worth of
--     evidence (a single held is 1.0; a lone soft miss is 0.25). A
--     row with a real track record is not evictable.
--   - stale: last genuine verdict >= 90 days ago. The clock only
--     matters under cap pressure - an idle account never bleeds.
--   - not awaiting a judgment (same pending-fire guard).
-- Ranked stalest-first, smallest tally as the tiebreak.
--
-- When neither of those qualifies, a THIRD tier evicts on demonstrated
-- failure: the lowest-health row whose posterior sits more than 15%
-- below the user's own population prior p0. Low health is earned, not
-- drifted into - under the k=5 shrinkage of samskara_apply_evaluation
-- a row needs roughly two full contradictions' worth of net miss
-- evidence to fall below 0.85 * p0 - so every victim here is a claim
-- the judge genuinely tested and genuinely rejected, never one that is
-- merely quiet. This tier deliberately drops the pending-fire guard
-- the first two carry: that guard exists to spare a row whose
-- in-flight fire may be its FIRST genuine test, but a row this far
-- under water cannot be exonerated by one more verdict (a single held
-- moves the posterior only a few points), and the guard shrinks the
-- pool sharply on any active day - every row that fired since the
-- last judge pass carries a pending fire (measured 2026-08: the guard
-- left 1 eligible victim out of 11 below the ratio; most of that
-- pending-set was junk-thread sediment, since cleared by
-- samskara_expire_junk_thread_fires, but same-day pendings alone
-- still cover much of an active corpus). Ranked lowest-health
-- first, larger evidence tally as the tiebreak (the better-measured
-- failure goes before the marginal one).
--
-- Returns the deleted id, or null when no tier qualifies - the caller
-- then skips the mint, same as before eviction existed.
create or replace function public.samskara_evict_for_mint(
  p_user_id uuid
) returns uuid
language plpgsql security definer set search_path = public as $$
declare
  victim uuid;
begin
  select s.id into victim
    from public.samskaras s
   where s.user_id = p_user_id
     and s.tier = 1
     and s.confirm_count = 0
     and s.disconfirm_count = 0
     and s.created_at < now() - interval '14 days'
     and not exists (
       select 1 from public.samskara_fires f
        where f.samskara_id = s.id and f.verdict is null
     )
     and (
       select count(*) from public.samskara_fires f
        where f.samskara_id = s.id and f.verdict is not null
     ) >= 10
   order by (
       select count(*) from public.samskara_fires f
        where f.samskara_id = s.id and f.verdict is not null
     ) desc,
     s.created_at asc
   limit 1;
  if victim is null then
    -- Stale tier: weakly-established rows whose last genuine
    -- engagement is 90+ days old.
    select s.id into victim
      from public.samskaras s
     where s.user_id = p_user_id
       and s.tier = 1
       and s.confirm_count + s.disconfirm_count > 0
       and s.confirm_count + s.disconfirm_count <= 1.0
       and not exists (
         select 1 from public.samskara_fires f
          where f.samskara_id = s.id and f.verdict is null
       )
       and (
         select max(f.fired_at) from public.samskara_fires f
          where f.samskara_id = s.id
            and f.verdict in ('held', 'contradicted', 'not-borne-out')
       ) < now() - interval '90 days'
     order by (
         select max(f.fired_at) from public.samskara_fires f
          where f.samskara_id = s.id
            and f.verdict in ('held', 'contradicted', 'not-borne-out')
       ) asc,
       s.confirm_count + s.disconfirm_count asc
     limit 1;
  end if;
  if victim is null then
    -- Underperformer tier: demonstrated failure well below the user's
    -- own baseline. No pending-fire guard - see header comment.
    select s.id into victim
      from public.samskaras s
     where s.user_id = p_user_id
       and s.tier = 1
       and s.health < 0.85 * public.samskara_population_p0(p_user_id)
     order by s.health asc,
       s.confirm_count + s.disconfirm_count desc,
       s.id
     limit 1;
  end if;
  if victim is null then
    return null;
  end if;
  delete from public.samskaras where id = victim;
  return victim;
end $$;
revoke all on function public.samskara_evict_for_mint(uuid) from public, anon, authenticated;
grant execute on function public.samskara_evict_for_mint(uuid) to service_role;

-- One-shot health reconcile. Recompute health = confidence = the derived
-- posterior of each samskara's CURRENT tallies (k=5 mirrors
-- samskara_apply_evaluation - keep the two in sync). On the first apply
-- after the flip this IS the repair: the int-truncation casualties carry
-- zero evidence, so they evaluate to p0 (the population baseline) and
-- lift out of their stale bug-era health, fire-able again. Idempotent
-- afterward - health is a pure function of (tallies, p0), so re-running
-- only re-asserts it. Guarded so an empty samskaras table is a clean
-- no-op; per-user because p0 is per-user.
do $reconcile$
declare
  v_user uuid;
  v_p0 real;
begin
  for v_user in select distinct user_id from public.samskaras loop
    v_p0 := public.samskara_population_p0(v_user);
    update public.samskaras s
       set health     = (s.confirm_count + 5.0 * v_p0) / (s.confirm_count + s.disconfirm_count + 5.0),
           confidence = (s.confirm_count + 5.0 * v_p0) / (s.confirm_count + s.disconfirm_count + 5.0)
     where s.user_id = v_user;
  end loop;
exception when others then
  raise notice 'samskara health reconcile skipped: %', sqlerrm;
end
$reconcile$;

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
-- p_user_id overload for the sweep's service-role probe; the old
-- 0-arg signature is dropped so PostgREST resolves the call cleanly.
drop function if exists public.samskara_should_regen_compound();
create or replace function public.samskara_should_regen_compound(
  p_user_id uuid default null
)
returns table (
  should_regen boolean,
  samskara_count int,
  last_regen_at timestamptz
)
language plpgsql stable security invoker as $$
declare
  v_uid uuid := coalesce(p_user_id, auth.uid());
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
  p_ttl_seconds int,
  p_user_id uuid default null
) returns boolean
language plpgsql security invoker as $$
declare
  v_uid uuid := coalesce(p_user_id, auth.uid());
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
  p_samskara_count int,
  p_user_id uuid default null
) returns boolean
language plpgsql security invoker as $$
declare
  v_uid uuid := coalesce(p_user_id, auth.uid());
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
-- back the mint-phase dedup guards in
-- supabase/functions/venice/agents/samskara.ts.
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
-- The tier filter was added after the original 2-arg shape shipped;
-- drop the old signature so the 3-arg version doesn't create an
-- overload that PostgREST can't disambiguate.
drop function if exists public.samskara_nearest_by_prediction(vector, int);
drop function if exists public.samskara_nearest_by_prediction(vector, int, int);
create or replace function public.samskara_nearest_by_prediction(
  p_query_embedding vector(2048),
  p_k_max int,
  p_tier int default null,
  p_user_id uuid default null
) returns table (
  id uuid,
  cosine real,
  tier int
)
language sql stable security invoker as $$
  -- Returns the k nearest samskaras by cosine similarity against the
  -- supplied prediction embedding. Ordered by pgvector's cosine
  -- distance ascending so the most-similar row comes first; the
  -- caller reads `cosine` (1 - distance) for a threshold check.
  --
  -- p_tier null (the default) searches every tier - the original
  -- behaviour, used by the tier-1 mint dedup guard where a tier-2
  -- compound duplicating a tier-1 prediction is still worth catching.
  -- p_tier = N restricts to that tier, which the tier-2 mint dedup
  -- guard needs: "is there an existing COMPOUND this close?" can't be
  -- answered by post-filtering a global-k list, because nearer tier-1
  -- rows would crowd a genuine tier-2 twin out of the top k.
  select s.id,
         (1 - (s.prediction_embedding <=> p_query_embedding))::real as cosine,
         s.tier
    from public.samskaras s
   where s.user_id = coalesce(p_user_id, auth.uid())
     and s.prediction_embedding is not null
     and (p_tier is null or s.tier = p_tier)
   order by s.prediction_embedding <=> p_query_embedding asc
   limit p_k_max
$$;

-- Reinforce an existing samskara on re-observation. Called by the
-- mint-tier1 / mint-tier2 dedup paths when the proposed prediction is
-- semantically too close to an existing row. Nudges health up by a
-- small amount - capped at 1.0 - because a re-observation is a weak
-- positive signal (the user didn't actively confirm, they just said
-- something similar enough that the minter wanted to restate the
-- claim). Heavy reinforcement still goes through reaction-classify's
-- confirm/disconfirm path, which touches confidence.
--
-- Deliberately does NOT touch provenance. Provenance records the
-- substrate that FORMED a samskara (its origin cluster), not every
-- later re-observation. Appending the recency batch on each dedup hit
-- grew provenance without bound (rows accreted to 200+ links, most of
-- them temporally-adjacent bystanders unrelated to the claim) and
-- buried the formation evidence the detail view exists to show. The
-- health bump and fire_count already encode "re-observed"; the audit
-- trail stays the mint-time cluster.
--
-- The earlier signature carried a `p_substrate_ids uuid[]` arg for the
-- append; drop it so PostgREST resolves the new 2-arg shape cleanly.
drop function if exists public.samskara_reinforce_existing(uuid, uuid[], real);
drop function if exists public.samskara_reinforce_existing(uuid, real);
create or replace function public.samskara_reinforce_existing(
  p_samskara_id uuid,
  p_health_bump real,
  p_user_id uuid default null
) returns boolean
language plpgsql security invoker as $$
declare
  v_uid uuid := coalesce(p_user_id, auth.uid());
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
-- `p_target_count` MUST stay in sync with TIER1_POPULATION_CAP in
-- venice/agents/samskara.ts: the mint probes skip while the pool is
-- at that cap, so this overflow pass is the backstop for races, not
-- the routine make-room mechanism (it merges distinct claims, and
-- running it once per mint was the treadmill the mint gate removed).
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
drop function if exists public.samskara_collapse_by_cofiring(int, real, real, int, real, int);
create or replace function public.samskara_collapse_by_cofiring(
  p_min_cofires int default 3,
  p_min_cofire_ratio real default 0.5,
  p_cosine_floor real default 0.70,
  p_target_count int default 150,
  p_cap_cosine_floor real default 0.60,
  p_max_collapses int default 20,
  p_user_id uuid default null
) returns int
language plpgsql security invoker as $$
declare
  v_uid uuid := coalesce(p_user_id, auth.uid());
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

-- Tier-2 (compound) candidate detection -----------------------------------
--
-- Finds ONE recurring co-fire constellation of tier-1 samskaras worth
-- compounding into a tier-2 parent, or returns nothing. The worker's
-- mint-tier2 phase calls this, hands the child predictions to the
-- minter agent, and (if the agent confirms) inserts a tier-2 row whose
-- provenance points back at these children.
--
-- This is the INVERSE of samskara_collapse_by_cofiring, and the two
-- read the same co-fire self-join, so the distinction is load-bearing:
--   - dedup merges pairs that are the SAME claim - high co-fire AND
--     high embedding cosine (>= p_cosine_floor, default 0.70). One is
--     deleted.
--   - tier-2 groups claims that CO-ACTIVATE BUT STAY DISTINCT - high
--     co-fire but cosine strictly BELOW that floor. Nothing is deleted;
--     a parent is added.
-- The cosine band [p_cosine_lo, p_cosine_hi) is the seam. p_cosine_hi
-- MUST stay below dedup's p_cosine_floor or the two phases fight over
-- the same pairs - dedup deleting what tier-2 just grouped.
--
-- Group shape: eligible edges are ranked strongest-LIFT first; the
-- strongest edge whose grown group is large enough AND not already
-- covered by an existing tier-2 seeds the candidate. Around a seed,
-- every node sharing an eligible edge with BOTH seed members joins (up
-- to p_max_group_size, strongest first). Requiring both - not either -
-- keeps the constellation coherent: a node co-firing with only one seed
-- member is adjacent, not part of the pattern.
--
-- Lift gate (the load-bearing selectivity): eligibility is NOT raw
-- co-fire count, and NOT the rarer-member ratio dedup uses. Raw count
-- ranks the busiest predictions to the top - two samskaras that each
-- fire on a large fraction of turns co-fire hundreds of times by base
-- rate alone, with no real association (a forced candidate built that
-- way came back a cross-topic grab-bag of the highest-firing claims:
-- emojis + pork chops + Thai food). dedup's ratio (cofires /
-- min(fires)) does not catch this either: two busy-but-independent
-- predictions still reach ratio ~0.5, because the rarer member is also
-- busy. The measure that DOES isolate association is lift:
--     lift = cofires * v_cohorts / (fire_count_a * fire_count_b)
-- i.e. observed co-fires over co-fires expected under independence.
-- Base-rate binding sits at lift ~1 (at or below chance); genuine
-- co-activation runs several times chance. Eligibility requires
-- lift >= p_min_lift (default 2.0, comfortably above the ~1.5 ceiling
-- the grab-bag pairs reach in production). Lift is a rate ratio, so the
-- threshold stays meaningful as the corpus grows. The companion
-- p_min_cofires floor (raised to 10) is an absolute-mass guard against
-- lift's small-sample variance - a pair firing 4 times that always
-- co-fires scores a huge lift on 4 data points.
--
-- Cosine band [p_cosine_lo, p_cosine_hi): the UPPER bound is
-- load-bearing - it MUST stay below dedup's p_cosine_floor (above) or
-- the two phases fight over the same pairs. The LOWER bound is currently
-- non-binding: every prediction shares the "In situations like X, this
-- user tends to Y" template, which floors pairwise prediction-cosine
-- around 0.38, so no co-firing pair sits below p_cosine_lo = 0.30.
-- Coherence is carried by the lift gate, not this floor; the band's only
-- live job is keeping tier-2 out of dedup's territory. (Do not "fix" the
-- floor by raising p_cosine_lo - prediction-cosine is template
-- similarity, not topical similarity, so a higher floor filters noise,
-- not for coherence.)
--
-- Seed iteration (coverage): a candidate group whose child-set overlaps
-- a COVERED region by Jaccard >= p_overlap_skip is SKIPPED, and
-- detection advances to the next-strongest uncovered seed rather than
-- giving up. A covered region is either an existing tier-2's child-set
-- (already compounded) OR a recent tier-2-minter decline (the minter
-- just rejected that group and would reject it again - see
-- samskara_tier2_declines, TTL'd so a strengthening group re-qualifies
-- after the window). Without the existing-tier-2 skip, once one tier-2
-- exists the single strongest edge sits in the densest (already-
-- compounded) region forever, the skip fires every cycle, and detection
-- returns empty permanently while many uncovered constellations
-- elsewhere go unseen. Without the decline skip, a group the minter
-- keeps refusing re-wins the seed every sweep and starves every weaker
-- uncovered constellation behind it. The probe budget scales with the
-- covered-region count (existing tier-2s + recent declines) so the
-- first uncovered, non-declined seed is always reachable. The mint
-- phase's embedding dedup is the second net (it catches a different
-- child set that synthesized to the same claim).
--
-- Volatile (not stable): builds temp edge + existing-child-set tables so
-- the seed loop, neighbour scans, and per-member weight read hit the
-- eligible self-join once rather than per iteration. `on commit drop`
-- scopes them to the PostgREST call's transaction.
drop function if exists public.samskara_tier2_candidate(int, real, real, int, int, real);
drop function if exists public.samskara_tier2_candidate(int, real, real, int, int, real, uuid);
drop function if exists public.samskara_tier2_candidate(int, real, real, real, int, int, real, uuid);
create or replace function public.samskara_tier2_candidate(
  p_min_cofires      int  default 10,
  p_min_lift         real default 2.0,
  p_cosine_lo        real default 0.30,
  p_cosine_hi        real default 0.68,
  p_min_group_size   int  default 3,
  p_max_group_size   int  default 6,
  p_overlap_skip     real default 0.60,
  p_user_id          uuid default null
) returns table (
  samskara_id uuid,
  prediction text,
  valence real,
  cofire_weight real
)
language plpgsql security invoker as $$
declare
  v_uid uuid := coalesce(p_user_id, auth.uid());
  v_active int;
  v_cohorts int;
  v_existing_count int;
  v_decline_count int;
  v_seed record;
  v_extra uuid[];
  v_group uuid[];
  v_max_overlap real;
  -- How long a tier-2-minter decline suppresses re-offering its group.
  -- TTL'd (not permanent like pair-declines) because the co-fire graph
  -- keeps growing: a group too weak to compound today may accumulate
  -- enough joint firing to be worth re-offering after the window. See
  -- samskara_tier2_declines.
  v_decline_ttl constant interval := interval '7 days';
begin
  -- Cheap precondition before the costly self-join: tier-2 is
  -- meaningless until a substantial tier-1 corpus has actually fired.
  -- Floor at min-group-size + 1 so a group can even form.
  select count(*) into v_active
    from public.samskaras
   where user_id = v_uid and tier = 1 and fire_count > 0;
  if v_active < greatest(p_min_group_size + 1, 8) then
    return;
  end if;

  -- Total fire cohorts - the denominator for the lift gate. Lift =
  -- observed co-fires / co-fires expected under independence
  -- (fires_a * fires_b / v_cohorts): how many times more often a pair
  -- fires together than chance. Computed once; used in the edge filter.
  select count(distinct cohort_id) into v_cohorts
    from public.samskara_fires
   where user_id = v_uid;
  if coalesce(v_cohorts, 0) = 0 then
    return;
  end if;

  -- Eligible edges materialized once. Each is a tier-1<->tier-1 pair
  -- that co-fires in >= p_min_cofires cohorts (an absolute-mass floor
  -- that controls the small-sample variance of lift - a pair firing 4
  -- times that always co-fires scores a huge lift on 4 data points),
  -- clears the lift gate (>= p_min_lift times more co-firing than
  -- independence predicts - genuine association, not two busy
  -- predictions colliding by base rate), AND whose prediction-embedding
  -- cosine sits in the [lo, hi) band - strictly below hi (dedup's
  -- floor) so we only ever group claims dedup deliberately leaves
  -- distinct. The lo bound is non-binding in practice (the prediction
  -- template floors cosine ~0.38); the lift gate, not lo, is what keeps
  -- base-rate noise out. See the preamble.
  create temporary table if not exists _tier2_edges (
    a_id uuid,
    b_id uuid,
    cofires int,
    lift real
  ) on commit drop;
  -- TRUNCATE, not an unqualified DELETE: PostgREST connections can
  -- preload pg-safeupdate (the local stack does), which rejects
  -- DELETE without a WHERE clause even inside function bodies -
  -- SQLSTATE 21000 on every call, which is how this function spent
  -- weeks never running locally. TRUNCATE is a different command
  -- class safeupdate doesn't hook, and is faster besides.
  truncate _tier2_edges;
  insert into _tier2_edges (a_id, b_id, cofires, lift)
  with pair_cofires as (
    select least(f1.samskara_id, f2.samskara_id) as a_id,
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
  select pc.a_id, pc.b_id, pc.cofires,
         (pc.cofires::real * v_cohorts::real
            / greatest(sa.fire_count::real * sb.fire_count::real, 1)::real)::real as lift
    from pair_cofires pc
    join public.samskaras sa on sa.id = pc.a_id
    join public.samskaras sb on sb.id = pc.b_id
   where sa.user_id = v_uid
     and sb.user_id = v_uid
     and sa.tier = 1
     and sb.tier = 1
     and sa.prediction_embedding is not null
     and sb.prediction_embedding is not null
     and (pc.cofires::real * v_cohorts::real
            / greatest(sa.fire_count::real * sb.fire_count::real, 1)::real) >= p_min_lift
     and (1 - (sa.prediction_embedding <=> sb.prediction_embedding))::real >= p_cosine_lo
     and (1 - (sa.prediction_embedding <=> sb.prediction_embedding))::real <  p_cosine_hi;

  -- Existing tier-2 child-sets, materialized once. The seed loop tests
  -- each candidate group's Jaccard overlap against these to skip
  -- already-compounded regions.
  create temporary table if not exists _tier2_existing (
    t2_id uuid,
    children uuid[]
  ) on commit drop;
  truncate _tier2_existing;
  insert into _tier2_existing (t2_id, children)
    select sp.samskara_id, array_agg(sp.ref_id)
      from public.samskara_provenance sp
      join public.samskaras s2 on s2.id = sp.samskara_id
     where sp.user_id = v_uid
       and sp.kind = 'samskara'
       and s2.tier = 2
     group by sp.samskara_id;
  select count(*) into v_existing_count from _tier2_existing;

  -- Recent tier-2-minter declines, materialized once. A group whose
  -- child-set overlaps one of these by Jaccard >= p_overlap_skip is
  -- skipped exactly like a minted-tier2-covered group - that is what
  -- stops detection re-offering a declined constellation every sweep.
  -- Only declines inside v_decline_ttl count; older ones have re-armed
  -- (the co-fire structure may have shifted), so the group re-qualifies.
  create temporary table if not exists _tier2_declined (
    children uuid[]
  ) on commit drop;
  truncate _tier2_declined;
  insert into _tier2_declined (children)
    select d.children
      from public.samskara_tier2_declines d
     where d.user_id = v_uid
       and d.declined_at >= now() - v_decline_ttl;
  select count(*) into v_decline_count from _tier2_declined;

  -- Seed iteration. Walk eligible edges strongest-LIFT first - NOT raw
  -- co-fire: raw co-fire ranks the busiest base-rate-bound pairs to the
  -- top, which is what produced the original cross-topic grab-bag. The
  -- first seed whose grown group is both large enough and uncovered
  -- wins. Deterministic tie-break on the ids so repeated calls pick the
  -- same order when lift ties. Probe budget = 64 + 16 per covered
  -- region, where a covered region is an existing tier-2 OR a recent
  -- decline: each covers up to C(size,2) of the strongest edges (<= 15
  -- at size 6), so 16 apiece keeps the first uncovered, non-declined
  -- seed reachable as covered regions accumulate; the 64 base covers
  -- the common no/one-tier-2 case. Declines count for the same reason
  -- minted tier-2s do - a declined group sits among the strongest seeds
  -- and gets skipped, consuming budget on the way to a fresh one.
  for v_seed in
    select e.a_id, e.b_id
      from _tier2_edges e
     order by e.lift desc, e.a_id, e.b_id
     limit (64 + 16 * (v_existing_count + v_decline_count))
  loop
    -- Grow: nodes sharing an eligible edge with BOTH seed members,
    -- strongest combined LIFT first, capped at the group budget. Lift,
    -- not raw co-fire, for the same reason as the seed ordering - the
    -- group should accrete the most genuinely-associated neighbours,
    -- not the busiest.
    select coalesce(array_agg(node order by w desc), array[]::uuid[])
      into v_extra
      from (
        select i.node, sum(i.lift)::real as w
          from (
            select a_id as node, b_id as other, lift from _tier2_edges
            union all
            select b_id as node, a_id as other, lift from _tier2_edges
          ) i
         where i.other in (v_seed.a_id, v_seed.b_id)
           and i.node not in (v_seed.a_id, v_seed.b_id)
         group by i.node
        having count(distinct i.other) = 2
         order by w desc
         limit greatest(p_max_group_size - 2, 0)
      ) picked;

    v_group := array[v_seed.a_id, v_seed.b_id] || v_extra;
    if coalesce(array_length(v_group, 1), 0) < p_min_group_size then
      continue;
    end if;

    -- Coverage: max Jaccard of this group against every covered region -
    -- existing tier-2 child-sets AND recent minter declines. Skip to the
    -- next-strongest seed if any covers it. Declines sit in the same test
    -- as minted tier-2s because both mean "do not offer this group": a
    -- minted one is already compounded, a recently-declined one the
    -- minter just rejected and would reject again within the window.
    select coalesce(max(
      cardinality(array(
        select unnest(v_group) intersect select unnest(x.children)
      ))::real
      / nullif(cardinality(array(
          select unnest(v_group) union select unnest(x.children)
        )), 0)::real
    ), 0) into v_max_overlap
      from (
        select children from _tier2_existing
        union all
        select children from _tier2_declined
      ) x;
    if v_max_overlap >= p_overlap_skip then
      continue;
    end if;

    -- Uncovered winner. Emit the members with a per-member weight =
    -- summed co-fire count of that member's eligible edges to the rest
    -- of the group. Becomes the provenance weight on the minted tier-2's
    -- child links; the compound's own valence is the minter agent's
    -- call, not a weighted mean here. One candidate per call: return.
    return query
      with mem as (
        select unnest(v_group) as mid
      ),
      weighted as (
        select m.mid,
               coalesce(sum(e.cofires), 0)::real as cw
          from mem m
          left join _tier2_edges e
            on (e.a_id = m.mid and e.b_id = any(v_group))
            or (e.b_id = m.mid and e.a_id = any(v_group))
         group by m.mid
      )
      select s.id, s.prediction, s.valence, w.cw
        from weighted w
        join public.samskaras s
          on s.id = w.mid
         and s.user_id = v_uid;
    return;
  end loop;

  -- No uncovered constellation among the probed seeds.
  return;
end $$;

-- Observability reads -----------------------------------------------------
--
-- Read-only surface for the Samskara diagnostics tab (Corpus + Health
-- panels). None of these write or shape anything; they exist so the
-- operator can see what the pipeline has formed and whether it's still
-- working. The in-chat surface stays opaque - these are deliberately
-- opened, like reading logs.

-- Corpus browse-time semantic search. Plain cosine on
-- prediction_embedding, NOT the fire-ranking formula (cosine^1.3 *
-- sqrt(health*confidence) * sample-size that samskara_fire_top_k uses).
-- Browse wants "closest to what I typed"; folding health/confidence in
-- would bury the weak-but-relevant samskaras the operator most wants to
-- find. Optional tier filter. Returns the display fields the list and
-- detail views render, plus cosine for an optional relevance readout.
-- Drop before recreate: the confirm/disconfirm columns widened from
-- int to real (see the samskaras table comment), and Postgres refuses
-- to change a function's OUT column types via CREATE OR REPLACE. An
-- int return type here would re-truncate the real column values on the
-- way out, re-introducing the exact frozen-tally bug downstream.
drop function if exists public.samskara_search_by_prediction(vector, int, int);
create or replace function public.samskara_search_by_prediction(
  p_query_embedding vector(2048),
  p_k_max int,
  p_tier int default null
) returns table (
  id uuid,
  tier int,
  prediction text,
  inner_voice text,
  valence real,
  confidence real,
  health real,
  fire_count int,
  confirm_count real,
  disconfirm_count real,
  last_fired_at timestamptz,
  created_at timestamptz,
  cosine real
)
language sql stable security invoker as $$
  select s.id, s.tier, s.prediction, s.inner_voice, s.valence,
         s.confidence, s.health, s.fire_count, s.confirm_count,
         s.disconfirm_count, s.last_fired_at, s.created_at,
         (1 - (s.prediction_embedding <=> p_query_embedding))::real as cosine
    from public.samskaras s
   where s.user_id = auth.uid()
     and s.prediction_embedding is not null
     and (p_tier is null or s.tier = p_tier)
   order by s.prediction_embedding <=> p_query_embedding asc
   limit p_k_max
$$;

-- Greedy cosine clustering of the whole samskara corpus by
-- prediction_embedding. The corpus analog of
-- samskara_cluster_thread_fires (same greedy algorithm) minus the
-- per-cohort scoping. Powers the Corpus panel's "hide similar" slider:
-- the UI shows one representative per cluster (the seed, which is the
-- strongest member because we walk health-then-confidence first) and
-- folds the rest under a "+N similar" affordance. Seeds are never
-- re-evaluated, so cluster_seq is deterministic across calls at a given
-- threshold and the renderer can cache by it. Optional tier filter.
--
-- Cost is O(n * seeds) from the per-(row, seed) embedding reload, same
-- as the thread version. The corpus is small by design (dedup targets
-- ~150 tier-1), and this only runs when the slider is engaged, so the
-- naive reload is fine - not on any hot path.
create or replace function public.samskara_cluster_corpus(
  p_threshold real,
  p_tier int default null
) returns table (
  samskara_id uuid,
  cluster_seq int,
  cluster_size int
)
language plpgsql stable security invoker as $$
declare
  v_uid uuid := auth.uid();
  v_next_seq int := 0;
  v_seed_ids uuid[] := array[]::uuid[];
  v_seed_seqs int[] := array[]::int[];
  v_assignments jsonb := '{}'::jsonb;
  v_best_cos real;
  v_best_seq int;
  v_cos real;
  v_seed_emb vector(2048);
  v_emb vector(2048);
  i int;
  rec record;
begin
  for rec in
    select s.id, s.prediction_embedding as embedding
      from public.samskaras s
     where s.user_id = v_uid
       and s.prediction_embedding is not null
       and (p_tier is null or s.tier = p_tier)
     order by s.health desc, s.confidence desc, s.id
  loop
    v_emb := rec.embedding;
    v_best_cos := -1.0;
    v_best_seq := 0;
    for i in 1..coalesce(array_length(v_seed_ids, 1), 0) loop
      select s.prediction_embedding into v_seed_emb
        from public.samskaras s where s.id = v_seed_ids[i];
      if v_seed_emb is null then
        continue;
      end if;
      v_cos := (1 - (v_seed_emb <=> v_emb))::real;
      if v_cos > v_best_cos then
        v_best_cos := v_cos;
        v_best_seq := v_seed_seqs[i];
      end if;
    end loop;
    if v_best_cos >= p_threshold then
      v_assignments := v_assignments
        || jsonb_build_object(rec.id::text, v_best_seq);
    else
      v_next_seq := v_next_seq + 1;
      v_seed_ids := array_append(v_seed_ids, rec.id);
      v_seed_seqs := array_append(v_seed_seqs, v_next_seq);
      v_assignments := v_assignments
        || jsonb_build_object(rec.id::text, v_next_seq);
    end if;
  end loop;

  return query
    with assigned as (
      select s.id as a_id,
             ((v_assignments ->> (s.id::text))::int) as a_seq
        from public.samskaras s
       where s.user_id = v_uid
         and s.prediction_embedding is not null
         and (p_tier is null or s.tier = p_tier)
    ),
    sizes as (
      select a_seq, count(*)::int as a_size
        from assigned
       where a_seq is not null
       group by a_seq
    )
    select a.a_id, a.a_seq, sz.a_size
      from assigned a
      join sizes sz on sz.a_seq = a.a_seq;
end $$;

-- Resolve a samskara's provenance rows to human-readable labels for the
-- Corpus detail view. Tier-2 compounds carry kind='samskara' rows
-- pointing at their tier-1 children (label = child prediction, plus the
-- child's tier); tier-1 carry 'substrate' (label = situation) and
-- 'association' (label = articulated_relation). ref_id has no FK, so a
-- target deleted since minting yields a null label - the UI renders
-- that as "(removed)". `asc2` alias because `asc` is reserved.
create or replace function public.samskara_provenance_detail(
  p_samskara_id uuid
) returns table (
  kind text,
  ref_id uuid,
  weight real,
  label text,
  ref_tier int
)
language sql stable security invoker as $$
  select p.kind,
         p.ref_id,
         p.weight,
         case p.kind
           when 'samskara' then cs.prediction
           when 'substrate' then sub.situation
           when 'association' then asc2.articulated_relation
         end as label,
         cs.tier as ref_tier
    from public.samskara_provenance p
    left join public.samskaras cs
      on p.kind = 'samskara' and cs.id = p.ref_id and cs.user_id = auth.uid()
    left join public.samskara_substrate sub
      on p.kind = 'substrate' and sub.id = p.ref_id and sub.user_id = auth.uid()
    left join public.samskara_associations asc2
      on p.kind = 'association' and asc2.id = p.ref_id and asc2.user_id = auth.uid()
   where p.samskara_id = p_samskara_id
     and p.user_id = auth.uid()
   order by p.weight desc;
$$;

-- Per-samskara verdict tally over its fires, for the diagnostics detail
-- pane (Samskaras screen). The row's confirm_count/disconfirm_count are
-- the EWMA-discounted posterior inputs (fractional, recency-weighted);
-- this is the raw LIFETIME count by verdict so the soft-miss
-- (not-borne-out) bucket is legible next to held / contradicted /
-- not-engaged rather than being folded invisibly into disconfirm_count.
-- pending = fired but not yet judged (null verdict). last_genuine_at is
-- when the judge last ruled a genuine verdict (held / contradicted /
-- not-borne-out) - the timestamp the stale-eviction tier keys on, so
-- the detail pane can show how long an established claim has gone
-- without re-engaging. security invoker so the samskara_fires RLS
-- select policy scopes the read; the explicit user_id filter is
-- belt-and-braces (mirrors samskara_provenance_detail).
drop function if exists public.samskara_verdict_counts(uuid);
create or replace function public.samskara_verdict_counts(p_samskara_id uuid)
returns table (
  held int,
  contradicted int,
  not_borne_out int,
  not_engaged int,
  pending int,
  last_genuine_at timestamptz
)
language sql stable security invoker set search_path = public as $$
  select
    count(*) filter (where verdict = 'held')::int,
    count(*) filter (where verdict = 'contradicted')::int,
    count(*) filter (where verdict = 'not-borne-out')::int,
    count(*) filter (where verdict = 'not-engaged')::int,
    count(*) filter (where verdict is null)::int,
    max(fired_at) filter (where verdict in ('held', 'contradicted', 'not-borne-out'))
  from public.samskara_fires
  where samskara_id = p_samskara_id
    and user_id = auth.uid();
$$;

-- One-row corpus-wide health snapshot for the Health panel. Each column
-- maps to a pipeline pathology the operator otherwise can't see:
--   - pending_assimilate / pending_embed: backlog the formation/embed
--     workers haven't drained (growing = a worker is down or starving).
--   - fires_unresolved_window: fires awaiting reaction-classify inside
--     the 1-10min window (in-flight, normal in small numbers).
--   - fires_aged_out: unresolved fires past the 10min window - signal
--     the assistant was shaped by but the model never learned from.
--   - orphan_fires: fires pointing at a deleted samskara (merge/delete
--     bug smell).
--   - stuck_*_claims: rows a worker claimed then died on (holder set,
--     expiry past). TTL releases them on the next claim, so a high
--     count means workers are crashing mid-claim, not just idle.
--   - near_dead / never_fired: corpus-quality signals (decay working,
--     mints that never match anything).
--   - probation_eligible / evictable / evictable_stale /
--     evictable_unhealthy: rows the decay machinery will release.
--     probation_eligible mirrors samskara_reap_untested's predicate
--     (never genuinely tested, past the 45-day window, no pending
--     fire) - drains at the next hourly reap tick, so a persistent
--     nonzero means the reaper cron is stalled. evictable mirrors
--     samskara_evict_for_mint's first tier (judged 10+ times, zero
--     genuine engagements, 14+ days old); evictable_stale mirrors its
--     second (weakly established, last genuine verdict 90+ days ago);
--     evictable_unhealthy mirrors its third (health more than 15%
--     below the user's own p0) - together the pool a capped mint may
--     draw a victim from; informational, since eviction only runs
--     under cap pressure.
--   - associations / associations_unconsumed: the relation graph total
--     and the slice still awaiting an association-mint pass. A standing
--     unconsumed pile is normal between hourly sweeps; it should drain,
--     not grow without bound.
-- One round trip beats a dozen head-counts from the client.
drop function if exists public.samskara_health_snapshot();
create or replace function public.samskara_health_snapshot()
returns table (
  total_samskaras int,
  tier1 int,
  tier2 int,
  near_dead int,
  never_fired int,
  probation_eligible int,
  evictable int,
  evictable_stale int,
  evictable_unhealthy int,
  associations int,
  associations_unconsumed int,
  substrate_total int,
  pending_assimilate int,
  pending_embed int,
  fires_total int,
  fires_awaiting_judgment int,
  orphan_fires int,
  stuck_assimilate_claims int,
  stuck_embed_claims int
)
language sql stable security invoker as $$
  select
    (select count(*) from public.samskaras s
      where s.user_id = auth.uid())::int,
    (select count(*) from public.samskaras s
      where s.user_id = auth.uid() and s.tier = 1)::int,
    (select count(*) from public.samskaras s
      where s.user_id = auth.uid() and s.tier = 2)::int,
    (select count(*) from public.samskaras s
      where s.user_id = auth.uid() and s.health < 0.2)::int,
    (select count(*) from public.samskaras s
      where s.user_id = auth.uid() and s.fire_count = 0)::int,
    -- Keep both predicates in lockstep with samskara_reap_untested and
    -- samskara_evict_for_mint - a drifted copy here reports a pool the
    -- workers don't actually drain.
    (select count(*) from public.samskaras s
      where s.user_id = auth.uid()
        and s.confirm_count = 0 and s.disconfirm_count = 0
        and s.created_at < now() - interval '45 days'
        and not exists (
          select 1 from public.samskara_fires f
           where f.samskara_id = s.id and f.verdict is null
        ))::int,
    (select count(*) from public.samskaras s
      where s.user_id = auth.uid()
        and s.tier = 1
        and s.confirm_count = 0 and s.disconfirm_count = 0
        and s.created_at < now() - interval '14 days'
        and not exists (
          select 1 from public.samskara_fires f
           where f.samskara_id = s.id and f.verdict is null
        )
        and (select count(*) from public.samskara_fires f
              where f.samskara_id = s.id and f.verdict is not null) >= 10)::int,
    (select count(*) from public.samskaras s
      where s.user_id = auth.uid()
        and s.tier = 1
        and s.confirm_count + s.disconfirm_count > 0
        and s.confirm_count + s.disconfirm_count <= 1.0
        and not exists (
          select 1 from public.samskara_fires f
           where f.samskara_id = s.id and f.verdict is null
        )
        and (select max(f.fired_at) from public.samskara_fires f
              where f.samskara_id = s.id
                and f.verdict in ('held', 'contradicted', 'not-borne-out'))
            < now() - interval '90 days')::int,
    (select count(*) from public.samskaras s
      where s.user_id = auth.uid()
        and s.tier = 1
        -- samskara_population_p0 inlined and scoped to auth.uid(): the
        -- standalone function is service-role only (its p_user_id param
        -- would let any signed-in caller probe another user's prior),
        -- and this snapshot runs security invoker.
        and s.health < 0.85 * (
          select case
            when coalesce(sum(p.confirm_count + p.disconfirm_count), 0) < 20.0 then 0.66
            else sum(p.confirm_count) / nullif(sum(p.confirm_count + p.disconfirm_count), 0)
          end
          from public.samskaras p
          where p.user_id = auth.uid()
        ))::int,
    (select count(*) from public.samskara_associations a
      where a.user_id = auth.uid())::int,
    (select count(*) from public.samskara_associations a
      where a.user_id = auth.uid() and a.minted_at is null)::int,
    (select count(*) from public.samskara_substrate sub
      where sub.user_id = auth.uid())::int,
    -- Only stubs the claim RPCs can actually pick up. Stubs on
    -- single-user-message threads are deferred by the junk-data gate
    -- in samskara_claim_next_assimilate* and wait indefinitely by
    -- design; counting them here would read as a stuck worker.
    (select count(*) from public.samskara_substrate sub
      where sub.user_id = auth.uid() and sub.situation is null
        and (select count(*) from public.messages m
              where m.thread_id = sub.thread_id
                and m.role = 'user') >= 2)::int,
    (select count(*) from public.samskara_substrate sub
      where sub.user_id = auth.uid()
        and sub.situation_embedding is null
        and sub.situation is not null)::int,
    (select count(*) from public.samskara_fires f
      where f.user_id = auth.uid())::int,
    -- Fires the next-day judge still owes a verdict (verdict is null):
    -- the evaluation-sweep backlog. Drains toward ~0 as the sweep
    -- catches up; a persistent climb means the sweep is stalled. (This
    -- replaced two metrics built on the retired 1-10min reaction window.)
    (select count(*) from public.samskara_fires f
      where f.user_id = auth.uid()
        and f.verdict is null)::int,
    (select count(*) from public.samskara_fires f
      where f.user_id = auth.uid()
        and not exists (
          select 1 from public.samskaras s where s.id = f.samskara_id
        ))::int,
    (select count(*) from public.samskara_substrate sub
      where sub.user_id = auth.uid()
        and sub.assimilate_claim_holder is not null
        and sub.assimilate_claim_expires < now())::int,
    (select count(*) from public.samskara_substrate sub
      where sub.user_id = auth.uid()
        and sub.embedding_claim_holder is not null
        and sub.embedding_claim_expires < now())::int
$$;

-- Windowed activity rates for the Health panel. Computed from existing
-- timestamps over the last p_days - no metrics table, no cron. Answers
-- "is the pipeline alive and converging" (mints flowing, fires
-- happening, reactions actually resolving) without storing history.
-- Drop-then-recreate (not just create-or-replace): the verdict-mix
-- columns changed the RETURNS TABLE shape, and Postgres rejects a
-- create-or-replace that changes a function's return type.
drop function if exists public.samskara_rates(int);
create or replace function public.samskara_rates(p_days int default 7)
returns table (
  window_days int,
  mints int,
  fires int,
  resolved int,
  unresolved int,
  resolution_pct real,
  held int,
  contradicted int,
  not_borne_out int,
  not_engaged int
)
language sql stable security invoker as $$
  -- "Resolved" = the next-day evaluation sweep has judged the fire
  -- (verdict is set). held/contradicted/not-borne-out/not-engaged break
  -- that down; an unjudged fire (same-day thread, or under the 2-round
  -- gate) has a null verdict and counts as unresolved.
  with w as (
    select f.verdict
      from public.samskara_fires f
     where f.user_id = auth.uid()
       and f.fired_at >= now() - make_interval(days => p_days)
  )
  select
    p_days,
    (select count(*) from public.samskaras s
      where s.user_id = auth.uid()
        and s.created_at >= now() - make_interval(days => p_days))::int,
    (select count(*) from w)::int,
    (select count(*) from w where verdict is not null)::int,
    (select count(*) from w where verdict is null)::int,
    (case when (select count(*) from w) = 0 then 0::real
          else ((select count(*) from w where verdict is not null)::real
                / (select count(*) from w)::real * 100.0) end)::real,
    (select count(*) from w where verdict = 'held')::int,
    (select count(*) from w where verdict = 'contradicted')::int,
    (select count(*) from w where verdict = 'not-borne-out')::int,
    (select count(*) from w where verdict = 'not-engaged')::int
$$;

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

-- Long-lived bookmark. Marking an article favorite is what flags it for
-- offline caching (the browser mirrors the favorite set into IndexedDB
-- so it reads with no network). Mirrors recipes.favorite: a personal
-- bookmark, not article content, so toggling it must NOT bump
-- updated_at - the offline cache's freshness comparator keys on
-- updated_at, and a bookmark flip is not a content change. The
-- clear_wiki_embedding_on_change trigger above only guards title /
-- content, so a favorite toggle also leaves the embedding intact.
alter table public.wiki_articles
  add column if not exists favorite boolean not null default false;

-- Partial index over the flagged subset only, so the "list favorites"
-- query (and the offline-sync reconcile that drives it) stays cheap
-- while most rows aren't favorited. Twin of recipes_user_favorite_idx.
create index if not exists wiki_articles_user_favorite_idx
  on public.wiki_articles (user_id) where favorite;

-- Per-thread pointer + claim columns for the autonomous wiki agent.
-- Independent of last_reflected_msg_id so both workers can run
-- concurrently against the same thread without crowding each
-- other's pointers.
--
-- wiki_failure_count tracks consecutive agent errors against a given
-- terminal message. The error path in loop.ts increments it and
-- releases the claim so the next cycle retries; once the count crosses
-- the per-thread cap (passed by the worker) the pointer is advanced
-- and the count reset so a permanently-filtered conversation (Venice
-- 400 inappropriate-content rulings, repeatable parse failures, etc.)
-- doesn't pin the queue forever. Successful processing resets the
-- counter so a transient blip doesn't shorten future retry budget.
alter table public.threads
  add column if not exists last_wiki_processed_msg_id uuid references public.messages(id) on delete set null,
  add column if not exists wiki_claim_holder text,
  add column if not exists wiki_claim_expires_at timestamptz,
  add column if not exists wiki_failure_count int not null default 0,
  -- Skip marker stamped by record_wiki_failure_or_skip when the
  -- counter hits the cap. Surfaced in the Wiki tab's "Skipped" panel
  -- so the user can see which conversations the autonomous agent gave
  -- up on (Venice content classifier rejections are the dominant
  -- reason). Both columns are cleared on the next successful run, so
  -- the panel naturally drains as the user edits the offending
  -- conversations.
  add column if not exists wiki_last_skip_at timestamptz,
  add column if not exists wiki_last_skip_reason text,
  -- True when the per-thread skip was stamped after the agent already
  -- attempted the uncensored fallback model (currently
  -- arcee-trinity-large-thinking, see agent.ts). The eligibility
  -- predicate uses this to decide whether a content-classifier skip
  -- is worth re-eligibilising: rows whose skip happened BEFORE the
  -- fallback existed (or before the fallback got a turn) carry the
  -- default `false` and re-enter the queue automatically, so legacy
  -- skips recover without a manual reset. Cleared on the next
  -- successful run alongside the rest of the per-thread state.
  add column if not exists wiki_skip_fallback_attempted boolean not null default false;

-- Claim the next thread eligible for wiki processing, across ALL
-- users. SECURITY DEFINER global sweep (same posture as
-- claim_next_pending_wiki_article in the embeddings section): the
-- caller is the venice function's /wiki-sweep route, driven by
-- pg_cron with a service-role bearer, so there is no auth.uid() to
-- scope by. EXECUTE is locked to service_role below. The per-user
-- inputs the browser worker used to pass as parameters are read off
-- the joined profile instead:
--   - the day-gate timezone comes from settings->>'displayTimezone'
--     (via nak_safe_timezone, UTC fallback);
--   - the Settings "automatic wiki updates" toggle gates eligibility
--     here (only the literal string 'false' disables - anything else,
--     including a missing key, means enabled, matching the client's
--     `?? true` default; a cast would let one malformed value wedge
--     the global sweep).
-- Returns user_id alongside the thread columns so the agent can scope
-- its run to the owner.
--
-- Two notable shape choices, unchanged from the browser-era claim:
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
  p_ttl_seconds int
) returns table (
  thread_id uuid,
  user_id uuid,
  terminal_msg_id uuid,
  title text,
  newest_msg_at timestamptz
)
language sql security definer
set search_path = public as $$
  with candidate as (
    select
      t.id as thread_id,
      t.user_id as user_id,
      term.msg_id as terminal_msg_id,
      t.title as title,
      newest.created_at as newest_msg_at
      from public.threads t
      inner join public.profiles p on p.user_id = t.user_id
      cross join lateral (
        -- One safe-timezone resolution per candidate row, shared by
        -- both sides of the day-gate comparison below.
        select public.nak_safe_timezone(p.settings->>'displayTimezone') as tz
      ) usertz
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
         order by m.position desc
         limit 1
      ) term
      cross join lateral (
        -- Newest message of any role - the timestamp the day-gate
        -- buckets. Reading it off messages.created_at instead of
        -- threads.updated_at keeps the gate stable against future
        -- bumps to threads.updated_at from unrelated writes.
        -- Wall-clock on purpose, not transcript order: a recovery row
        -- healed today counts as today's activity even though its
        -- position is mid-transcript.
        select m2.created_at
          from public.messages m2
         where m2.thread_id = t.id
         order by m2.created_at desc
         limit 1
      ) newest
     where (p.settings->>'wikiAutomaticEnabled') is distinct from 'false'
       and not t.hidden -- deleted-awaiting-GC; see the reflection sweep
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
       and (
         -- Two eligibility branches:
         --
         --   (a) Normal: there's new work past the pointer AND the
         --       newest message lands on a calendar day strictly
         --       before today in the user's tz. The day-gate is what
         --       lets in-flight conversations settle before the
         --       autonomous agent reads them.
         --
         --   (b) Recovery: the thread carries a content-classifier
         --       skip marker that the uncensored fallback hasn't tried
         --       yet. This branch INTENTIONALLY bypasses the day-gate:
         --       a skipped thread is by definition not in-flight any
         --       more (the agent already attempted it and gave up),
         --       and gating on next-day would mean adding a new turn
         --       to nudge the worker actually pushes the eligibility
         --       boundary OUT to tomorrow rather than making the
         --       thread retryable sooner. The success path clears
         --       both the skip reason and the fallback-attempted flag
         --       together, so a thread can't loop through this branch
         --       indefinitely: at most one re-entry per terminal
         --       message, after which either the agent processed it
         --       (skip marker cleared) or the fallback failed too
         --       (flag stamped true).
         (
           term.msg_id is distinct from t.last_wiki_processed_msg_id
           and (newest.created_at at time zone usertz.tz)::date
               < (now() at time zone usertz.tz)::date
         )
         or (
           t.wiki_last_skip_reason is not null
           and t.wiki_last_skip_reason ilike '%inappropriate content%'
           and not t.wiki_skip_fallback_attempted
         )
       )
     order by newest.created_at asc
     limit 1
     for update of t skip locked
  )
  update public.threads t
     set wiki_claim_holder = p_holder_id,
         wiki_claim_expires_at = now() + make_interval(secs => p_ttl_seconds)
    from candidate c
   where t.id = c.thread_id
  returning t.id as thread_id, t.user_id as user_id, c.terminal_msg_id,
            c.title, c.newest_msg_at;
$$;

-- Global sweep, owner-privileged: only the cron-driven service role
-- may claim across users.
revoke all on function public.claim_next_thread_for_wiki(text, int)
  from public, anon, authenticated;
grant execute on function public.claim_next_thread_for_wiki(text, int)
  to service_role;

-- Advance the per-thread wiki pointer IF our claim is still ours.
-- Called after every successful agent run - even a no-op run (agent
-- decided no topic in the conversation warranted an article) advances
-- the pointer so the same conversation is not re-processed every poll.
-- Also resets wiki_failure_count so transient blips during prior
-- attempts don't shorten future retry budget. Returns false on
-- claim-lost; caller drops the cycle.
drop function if exists public.mark_thread_wiki_processed_if_claimed(uuid, text, uuid);
create or replace function public.mark_thread_wiki_processed_if_claimed(
  p_thread_id uuid,
  p_holder_id text,
  p_msg_id uuid,
  -- b-strict escape hatch (see claim_next_thread_for_reflection): the
  -- venice function's wiki sweep runs with a service-role client that
  -- has no auth.uid(), so it passes the owner id the claim returned.
  -- security invoker stays correct because service_role bypasses RLS
  -- and the coalesce scopes the update to one user either way.
  p_user_id uuid default null
) returns boolean
language plpgsql security invoker as $$
declare
  updated int;
begin
  update public.threads
     set last_wiki_processed_msg_id = p_msg_id,
         wiki_claim_holder = null,
         wiki_claim_expires_at = null,
         wiki_failure_count = 0,
         -- A successful run supersedes any previous skip marker
         -- (whoever-took-over-after-the-skip ran cleanly, or the
         -- user edited the conversation so the agent could process
         -- it). Clear the marker so the Skipped panel drains.
         wiki_last_skip_at = null,
         wiki_last_skip_reason = null,
         -- Reset the fallback flag too: a successful run means the
         -- next skip (if any) starts a fresh recovery budget. Without
         -- this, a thread that succeeded once and then later failed
         -- with content-filter would never get the fallback retry.
         wiki_skip_fallback_attempted = false
   where id = p_thread_id
     and user_id = coalesce(p_user_id, auth.uid())
     and wiki_claim_holder = p_holder_id
     and wiki_claim_expires_at > now();
  get diagnostics updated = row_count;
  return updated > 0;
end $$;

grant execute on function
  public.mark_thread_wiki_processed_if_claimed(uuid, text, uuid, uuid)
  to service_role;

-- Record an agent failure against the claimed wiki thread. The error
-- path in loop.ts calls this instead of mark_thread_wiki_processed
-- so the pointer doesn't advance prematurely on a transient blip.
--
-- Behaviour:
--   - Under our claim: increment wiki_failure_count.
--     - If the new count is below p_max_failures, clear the claim so
--       the next worker cycle can re-claim the thread quickly (the
--       10-minute TTL otherwise gates retries to one attempt per 10
--       min - too slow for a transient network blip).
--     - If the new count reaches p_max_failures, treat the thread as
--       permanently failing for this terminal message: advance the
--       pointer to p_msg_id, reset the counter, clear the claim. The
--       conversation rejoins the queue only when a new turn lands
--       (which changes the terminal message) - giving Venice's content
--       filter a fresh body to evaluate.
--   - Not under our claim (TTL lapsed, another device took over): no-op.
--
-- Returns 'released', 'skipped', or 'claim-lost' so the cycle driver
-- can log + decide whether to keep draining.
drop function if exists public.record_wiki_failure_or_skip(uuid, text, uuid, int);
drop function if exists public.record_wiki_failure_or_skip(uuid, text, uuid, int, text);
create or replace function public.record_wiki_failure_or_skip(
  p_thread_id uuid,
  p_holder_id text,
  p_msg_id uuid,
  p_max_failures int,
  -- Short human-readable summary of the failure (the agent's error
  -- message, typically the Venice HTTP body). Stamped into
  -- wiki_last_skip_reason on the skip path so the Skipped panel can
  -- render it. Ignored on the release path - in-flight failures
  -- don't warrant surfacing yet; only the final give-up does.
  p_reason text default null,
  -- b-strict escape hatch, same as the mark RPC above: null from a
  -- browser caller (auth.uid() in scope), the thread owner's id from
  -- the service-role wiki sweep.
  p_user_id uuid default null
) returns text
language plpgsql security invoker as $$
declare
  v_new_count int;
begin
  update public.threads
     set wiki_failure_count = wiki_failure_count + 1
   where id = p_thread_id
     and user_id = coalesce(p_user_id, auth.uid())
     and wiki_claim_holder = p_holder_id
     and wiki_claim_expires_at > now()
  returning wiki_failure_count into v_new_count;
  if not found then
    return 'claim-lost';
  end if;
  if v_new_count >= p_max_failures then
    update public.threads
       set last_wiki_processed_msg_id = p_msg_id,
           wiki_claim_holder = null,
           wiki_claim_expires_at = null,
           wiki_failure_count = 0,
           wiki_last_skip_at = now(),
           -- Truncate at 1000 chars to keep the row reasonable when
           -- the error body is a large HTTP response. Sized above the
           -- edge client's 600-char completions error-body cap plus
           -- its message prefix, so the Skipped panel shows the whole
           -- captured error rather than clipping it a second time.
           wiki_last_skip_reason = nullif(left(coalesce(p_reason, ''), 1000), ''),
           -- If the agent gave up with a content-classifier reason,
           -- we know the in-agent primary -> fallback retry already
           -- ran (the wiki agent always tries the fallback for that
           -- sentinel). Stamp the flag so the eligibility predicate
           -- stops re-eligibilising this thread. Non-content-filter
           -- skips leave the flag at its existing value; the predicate
           -- only consults it alongside the content-filter reason
           -- match, so the value doesn't affect them.
           wiki_skip_fallback_attempted = case
             when p_reason ilike '%inappropriate content%'
               then true
             else wiki_skip_fallback_attempted
           end
     where id = p_thread_id;
    return 'skipped';
  end if;
  update public.threads
     set wiki_claim_holder = null,
         wiki_claim_expires_at = null
   where id = p_thread_id;
  return 'released';
end $$;

grant execute on function
  public.record_wiki_failure_or_skip(uuid, text, uuid, int, text, uuid)
  to service_role;

-- Read the user's skipped-thread list. Joined with the title for
-- display and the newest message timestamp so the panel can sort by
-- recency. RLS scopes to auth.uid() - the security_invoker posture
-- on this function inherits the caller's identity, same as the rest
-- of the wiki RPCs.
drop function if exists public.list_wiki_skipped_threads();
create or replace function public.list_wiki_skipped_threads()
returns table (
  thread_id uuid,
  title text,
  last_skip_at timestamptz,
  last_skip_reason text,
  -- True while a held per-thread wiki claim is in flight - the manual
  -- Retry runs under this claim (claim_wiki_thread_for_retry), and the
  -- hourly sweep's recovery branch can hold it too. The Skipped panel
  -- renders this as "Retrying..." and recovers the in-flight state across
  -- a browser reload (the claim is a durable server fact, unlike the
  -- panel's in-memory per-row spinner).
  retrying boolean
)
language sql security invoker as $$
  select t.id as thread_id,
         t.title as title,
         t.wiki_last_skip_at as last_skip_at,
         t.wiki_last_skip_reason as last_skip_reason,
         (t.wiki_claim_expires_at is not null
          and t.wiki_claim_expires_at > now()) as retrying
    from public.threads t
   where t.user_id = auth.uid()
     and t.wiki_last_skip_at is not null
   order by t.wiki_last_skip_at desc;
$$;

-- Compute the same "terminal assistant message" id the worker would
-- pin against a given thread. Used by the Skipped-panel Retry flow
-- (the venice function's /wiki-retry route), which runs the wiki
-- agent against the thread and needs the same msg id the sweep would
-- have picked. Returns null when the thread has no assistant message
-- with non-empty content and no tool calls (the agent would have
-- nothing to anchor against).
drop function if exists public.compute_wiki_terminal_msg_id(uuid);
create or replace function public.compute_wiki_terminal_msg_id(
  p_thread_id uuid,
  -- b-strict escape hatch: the /wiki-retry route runs with the
  -- service-role client and passes the gateway-validated user id;
  -- a browser caller leaves this null and auth.uid() applies.
  p_user_id uuid default null
) returns uuid
language sql security invoker as $$
  select m.id
    from public.messages m
   inner join public.threads t on t.id = m.thread_id
   where m.thread_id = p_thread_id
     and t.user_id = coalesce(p_user_id, auth.uid())
     and m.role = 'assistant'
     and (m.tool_calls is null
          or jsonb_typeof(m.tool_calls) <> 'array'
          or jsonb_array_length(m.tool_calls) = 0)
     and m.content is not null
     and length(m.content) > 0
   order by m.position desc
   limit 1;
$$;

grant execute on function
  public.compute_wiki_terminal_msg_id(uuid, uuid) to service_role;

-- Advance the wiki pointer + clear the skip marker from outside the
-- sweep's claim protocol. Used by the /wiki-retry route after a
-- successful agent run: the sweep's mark RPC requires an active
-- claim, but the manual retry doesn't go through the claim protocol
-- at all. This RPC does the equivalent state transition without the
-- claim guard - scoped to the owning user (auth.uid() or the
-- gateway-validated id the service-role caller passes), so a user
-- can only advance their own pointers. No-op when the thread isn't
-- found (e.g. a thread the user just deleted while the retry was in
-- flight).
drop function if exists public.manual_advance_wiki_pointer(uuid, uuid);
create or replace function public.manual_advance_wiki_pointer(
  p_thread_id uuid,
  p_msg_id uuid,
  -- b-strict escape hatch, same as compute_wiki_terminal_msg_id.
  p_user_id uuid default null
) returns void
language sql security invoker as $$
  update public.threads
     set last_wiki_processed_msg_id = p_msg_id,
         wiki_claim_holder = null,
         wiki_claim_expires_at = null,
         wiki_failure_count = 0,
         wiki_last_skip_at = null,
         wiki_last_skip_reason = null,
         wiki_skip_fallback_attempted = false
   where id = p_thread_id
     and user_id = coalesce(p_user_id, auth.uid());
$$;

grant execute on function
  public.manual_advance_wiki_pointer(uuid, uuid, uuid) to service_role;

-- Targeted per-thread claim for the manual Skipped-panel retry. Unlike
-- claim_next_thread_for_wiki (the global sweep that PICKS the next
-- eligible thread), this claims ONE named thread, making the retry's run
-- a durable server fact: a held wiki_claim_expires_at is what
-- list_wiki_skipped_threads reports as `retrying`, so the panel shows the
-- in-flight state and recovers it across a browser reload. Claims IFF the
-- thread is the caller's and currently unclaimed (or its claim lapsed); a
-- thread the sweep or another retry already holds returns false and the
-- route surfaces that as a `busy` result. b-strict: the /wiki-retry route
-- runs service-role and passes the gateway-validated id.
drop function if exists public.claim_wiki_thread_for_retry(uuid, text, int, uuid);
create or replace function public.claim_wiki_thread_for_retry(
  p_thread_id uuid,
  p_holder_id text,
  p_ttl_seconds int,
  p_user_id uuid default null
) returns boolean
language plpgsql security invoker as $$
declare
  updated int;
begin
  update public.threads
     set wiki_claim_holder = p_holder_id,
         wiki_claim_expires_at = now() + make_interval(secs => p_ttl_seconds)
   where id = p_thread_id
     and user_id = coalesce(p_user_id, auth.uid())
     and (wiki_claim_holder is null
          or wiki_claim_expires_at is null
          or wiki_claim_expires_at < now());
  get diagnostics updated = row_count;
  return updated > 0;
end $$;

grant execute on function
  public.claim_wiki_thread_for_retry(uuid, text, int, uuid) to service_role;

-- Release a manual-retry thread claim IF it is still ours. Holder-checked
-- (a lapsed-and-stolen claim is left to its new owner), and a no-op when
-- the success path (manual_advance_wiki_pointer) already cleared it.
drop function if exists public.release_wiki_thread_retry_claim(uuid, text, uuid);
create or replace function public.release_wiki_thread_retry_claim(
  p_thread_id uuid,
  p_holder_id text,
  p_user_id uuid default null
) returns void
language sql security invoker as $$
  update public.threads
     set wiki_claim_holder = null,
         wiki_claim_expires_at = null
   where id = p_thread_id
     and user_id = coalesce(p_user_id, auth.uid())
     and wiki_claim_holder = p_holder_id;
$$;

grant execute on function
  public.release_wiki_thread_retry_claim(uuid, text, uuid) to service_role;

-- Embeddings pipeline RPCs for wiki articles. Same claim/save shape
-- as memories, same 2048-dim padded vectors,
-- same security invoker posture letting RLS enforce user scoping.
drop function if exists public.claim_next_pending_wiki_article(text, int);
-- Global service-definer sweep, same shape as claim_next_pending_memory:
-- no auth.uid() filter, owner-privileged, EXECUTE locked to service_role below.
create or replace function public.claim_next_pending_wiki_article(
  p_holder_id text,
  p_ttl_seconds int
) returns table (id uuid, title text, content text, user_id uuid)
language sql security definer
set search_path = public as $$
  with candidate as (
    select w.id
      from public.wiki_articles w
     where w.embedding is null
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
  returning w.id, w.title, w.content, w.user_id;
$$;

drop function if exists public.save_wiki_article_embedding_if_claimed(uuid, text, vector, text);
create or replace function public.save_wiki_article_embedding_if_claimed(
  p_id uuid,
  p_holder_id text,
  p_embedding vector(2048),
  p_embedding_model text
) returns boolean
language plpgsql security definer
set search_path = public as $$
declare
  updated int;
begin
  update public.wiki_articles
     set embedding = p_embedding,
         embedding_model = p_embedding_model,
         embedding_claim_holder = null,
         embedding_claim_expires = null
   where id = p_id
     and embedding_claim_holder = p_holder_id
     and embedding_claim_expires > now();
  get diagnostics updated = row_count;
  return updated > 0;
end $$;

-- Service-role only - see the note on the memory pair.
revoke all on function public.claim_next_pending_wiki_article(text, int) from public, anon, authenticated;
revoke all on function public.save_wiki_article_embedding_if_claimed(uuid, text, vector, text) from public, anon, authenticated;
grant execute on function public.claim_next_pending_wiki_article(text, int) to service_role;
grant execute on function public.save_wiki_article_embedding_if_claimed(uuid, text, vector, text) to service_role;

-- Similarity search RPC. Plain cosine ranking, no confidence boost
-- (articles are direct user/agent assertions, not probabilistic
-- memories). Scoped by RLS plus an explicit user_id guard.
-- p_user_id: b-strict escape hatch; see search_memories_by_embedding
-- for the full rationale.
drop function if exists public.search_wiki_articles_by_embedding(vector, int);
drop function if exists public.search_wiki_articles_by_embedding(vector, int, uuid);
create or replace function public.search_wiki_articles_by_embedding(
  query_embedding vector(2048),
  match_limit int,
  p_user_id uuid default null
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
   where user_id = coalesce(p_user_id, auth.uid())
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
  -- 'create' | 'update' | 'delete' for ARTICLE writes, plus
  -- 'record_create' | 'record_update' | 'record_delete' for writes to
  -- the article's dated records (records reuse this same changelog,
  -- scoped to the parent article_id). Constrained so a typo'd kind
  -- can't land silently. Named explicitly so the widening migration
  -- below can replace it idempotently on databases created before the
  -- record kinds existed.
  kind text not null constraint wiki_changelog_kind_check check (
    kind in (
      'create', 'update', 'delete',
      'record_create', 'record_update', 'record_delete'
    )
  ),
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

-- Body size on either side of the change, so the history panel can show
-- how much a given edit grew or shrank an article (or a record). Parallel
-- to the columns on memory_changelog; same NULL-vs-0 semantics:
--   NULL - unknown. Rows written before these columns existed.
--   0    - known empty. A create has nothing before it; a delete has
--          nothing after it.
-- For article kinds (create/update/delete) the size measures
-- wiki_articles.content; for record kinds (record_*) it measures
-- wiki_records.content. The kind chip already distinguishes the two, so
-- a "+412" on an article row means "article body grew 412 chars" and on
-- a record row means "record content was 412 chars". File/link record
-- writes (which reuse the record_update kind without changing content)
-- pass null for both - the noise floor would suppress a zero delta
-- anyway, but null is the honest answer ("no content size to report").
alter table public.wiki_changelog
  add column if not exists chars_before int,
  add column if not exists chars_after int;

-- Anchor backfill for pre-existing article-kind history. Every
-- article-content mutation writes a changelog row, so for an article
-- that still exists its MOST RECENT article-kind entry describes the
-- body the row carries right now - that one value is exactly
-- recoverable, unlike older intermediate sizes. Filling it means the
-- first NEW edit after this ships already has a real before/after pair
-- instead of a null.
--
-- Record-kind rows cannot be backfilled: the changelog has no
-- record_id FK (record writes are scoped to the parent article_id
-- only), so there is no way to link a record_kind row to the specific
-- record it affected. Pre-existing record rows stay null, which is
-- correct - their sizes are unknown.
--
-- Idempotent via the `chars_after is null` guard: on a re-run the
-- latest entry per article already carries a value (from this backfill
-- or the application), so nothing is rewritten. Superseded older
-- entries stay null, which is correct - their sizes are unknown.
with latest as (
  select distinct on (c.article_id) c.id, a.content
    from public.wiki_changelog c
    join public.wiki_articles a on a.id = c.article_id
   where c.kind in ('create', 'update', 'delete')
   order by c.article_id, c.created_at desc, c.id desc
)
update public.wiki_changelog c
   set chars_after = length(latest.content)
  from latest
  where c.id = latest.id
    and c.chars_after is null;

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

-- Widen the kind CHECK on databases that predate the record kinds.
-- `create table if not exists` above is a no-op once the table exists,
-- so the inline constraint change never reaches an existing DB; replace
-- it here. Drop ANY check constraint currently guarding `kind` (older
-- DBs carry the auto-generated `wiki_changelog_kind_check` from the
-- inline `check (...)`; the name is stable but we match by definition to
-- be safe), then add the widened named constraint.
do $$
declare
  c text;
begin
  for c in
    select conname
      from pg_constraint
     where conrelid = 'public.wiki_changelog'::regclass
       and contype = 'c'
       and pg_get_constraintdef(oid) ilike '%kind%'
  loop
    execute format('alter table public.wiki_changelog drop constraint %I', c);
  end loop;
  alter table public.wiki_changelog
    add constraint wiki_changelog_kind_check check (
      kind in (
        'create', 'update', 'delete',
        'record_create', 'record_update', 'record_delete'
      )
    );
end $$;

-- Wiki agent audit log. One row per COMPLETED agent cycle - the
-- per-conversation wiki agent (sweep tick or manual retry), the
-- record-extraction agent, and the librarian (all three trigger
-- paths). The changelog above records what changed; this table
-- records that a cycle RAN, including the majority of cycles that
-- decide to change nothing. Without it, "when was this thread
-- processed" and "why did the agent write nothing about X" are only
-- answerable from the ephemeral log relay (in-app drawer, 24h edge
-- logs) - the reasoning column here is the durable copy of the
-- operator summary those surfaces already show.
--
-- Written best-effort by the edge agents through the service-role
-- client (appendWikiAgentLog in venice/agents/_wiki_agent_log.ts);
-- append-only from the client's perspective (select only, no
-- insert/update/delete policies for authenticated).
create table if not exists public.wiki_agent_log (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  agent text not null constraint wiki_agent_log_agent_check check (
    agent in ('wiki', 'wiki-records', 'wiki-librarian')
  ),
  -- What kicked the cycle off: the hourly cron sweep, the Skipped
  -- panel's Retry button, the Wiki panel's manual librarian run, or
  -- the chat-dispatched wiki_librarian tool. Named trigger_source
  -- because `trigger` is a Postgres keyword.
  trigger_source text not null constraint wiki_agent_log_trigger_check check (
    trigger_source in ('scheduled', 'retry', 'manual', 'chat')
  ),
  -- The processed conversation, for the thread-scoped agents; null
  -- for the librarian (wiki-wide, no thread). `set null` so deleting
  -- a conversation keeps its processing history readable.
  thread_id uuid references public.threads(id) on delete set null,
  terminal_msg_id uuid references public.messages(id) on delete set null,
  tool_calls int not null default 0,
  -- The model's one-or-two-sentence operator summary ("No edits -
  -- generic Q&A with no user-centric subject"). Same text the log
  -- drawer's finished-cycle line inlines as reasoning="...".
  reasoning text,
  created_at timestamptz not null default now()
);

-- Same access pattern as the changelog: page the user's history
-- newest-first (health audits, "what ran last night").
create index if not exists wiki_agent_log_user_created_idx
  on public.wiki_agent_log (user_id, created_at desc);

alter table public.wiki_agent_log enable row level security;

drop policy if exists "wiki_agent_log is self-selectable" on public.wiki_agent_log;
create policy "wiki_agent_log is self-selectable" on public.wiki_agent_log
  for select using (auth.uid() = user_id);

-- No insert/update/delete policies: rows land only through the
-- service-role edge agents, and history is append-only.

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
    -- Per source conversation, its BEST-matching chunk; then the
    -- minimum across sources. Threads no longer carry a single vector
    -- (see the thread_chunks section), so "how close is this
    -- conversation to the article" is now a max over that thread's
    -- chunks - the same reduction the conversation search RPC uses.
    -- Taking the min of those maxima preserves the original meaning:
    -- the bar is set by the LEAST related source the article cites.
    select coalesce(min(best.sim), 0.0)::real as min_sim
      from public.wiki_article_sources ws
      cross join lateral (
        select max(1 - (c.embedding <=> (select embedding from target))) as sim
          from public.thread_chunks c
         where c.thread_id = ws.thread_id
           and c.embedding is not null
      ) best
     where ws.article_id = p_article_id
       and best.sim is not null
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

-- Wiki records. A linked table of discrete, dated entries scoped to a
-- single wiki article. The split is deliberate: the article body is the
-- consolidated "current state" of a topic (what is true now), while
-- records preserve the dated journey (specific events, experiments,
-- observations, milestones - "baked a loaf", "doctor visit"). The
-- article worker + librarian read records and promote durable learnings
-- into the body without deleting the records, so the narrative stays
-- current while the history survives.
--
-- Records attach to an article (article_id NOT NULL, cascade on article
-- delete). Unlike wiki_articles there's no (user_id, title) uniqueness:
-- many records per article is the whole point, and two records on the
-- same date are legal (two events, one day).
--
-- Embedding mirrors wiki_articles exactly: 2048-padded vector written by
-- the shared server-side backfill loop, same claim/save protocol, same
-- invalidation-on-edit trigger. tags is a JSONB array of freeform
-- keyword strings for filtering; it is not part of the embedded text.
create table if not exists public.wiki_records (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  article_id uuid not null references public.wiki_articles(id) on delete cascade,
  -- Calendar date the event occurred (user-specified or extracted),
  -- distinct from created_at (when the row was written). The records
  -- list sorts by this column descending.
  date date not null,
  content text not null,
  tags jsonb not null default '[]'::jsonb,
  -- Provenance for extraction-agent writes; null for manually-added
  -- records. set null (not cascade) so deleting the source thread
  -- leaves the record intact - the event still happened.
  source_conversation_id uuid references public.threads(id) on delete set null,
  embedding vector(2048),
  embedding_model text,
  -- No _at suffix to match the convention from memories / wiki_articles.
  embedding_claim_holder text,
  embedding_claim_expires timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Reverse-chronological list by article (the article-view Records
-- section). date desc matches the rendered order.
create index if not exists wiki_records_article_date_idx
  on public.wiki_records (article_id, date desc);
-- Cross-article chronological queries for one user.
create index if not exists wiki_records_user_date_idx
  on public.wiki_records (user_id, date desc);
-- Tag filtering. GIN over the JSONB array supports `tags ? 'x'` /
-- `tags @> '["x"]'` containment without scanning every row.
create index if not exists wiki_records_tags_idx
  on public.wiki_records using gin (tags);

-- Stamp updated_at on every UPDATE. wiki_articles relies on its write
-- tools to set updated_at by hand; records are written from three
-- surfaces (UI, chat tools, background agents), so a trigger is the
-- single source of truth rather than three callers that must remember.
create or replace function public.touch_wiki_record_updated_at()
  returns trigger language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end $$;

drop trigger if exists touch_wiki_record_updated_at on public.wiki_records;
create trigger touch_wiki_record_updated_at
  before update on public.wiki_records
  for each row execute function public.touch_wiki_record_updated_at();

-- Same invariant as wiki_articles: when the text that produced the
-- embedding changes, null the embedding so the backfill worker re-embeds
-- on its next poll. The embed input is date + content (see
-- buildWikiRecordEmbedInput), so both fields gate invalidation. Null the
-- claim columns too so an in-flight worker save (which guards on holder
-- + expires > now()) cannot land a stale vector against the new text.
create or replace function public.clear_wiki_record_embedding_on_change()
  returns trigger language plpgsql as $$
begin
  if new.content is distinct from old.content
     or new.date is distinct from old.date then
    new.embedding := null;
    new.embedding_model := null;
    new.embedding_claim_holder := null;
    new.embedding_claim_expires := null;
  end if;
  return new;
end $$;

drop trigger if exists clear_wiki_record_embedding_on_change on public.wiki_records;
create trigger clear_wiki_record_embedding_on_change
  before update on public.wiki_records
  for each row execute function public.clear_wiki_record_embedding_on_change();

alter table public.wiki_records enable row level security;

drop policy if exists "wiki_records are self-selectable" on public.wiki_records;
create policy "wiki_records are self-selectable" on public.wiki_records
  for select using (auth.uid() = user_id);

drop policy if exists "wiki_records are self-insertable" on public.wiki_records;
create policy "wiki_records are self-insertable" on public.wiki_records
  for insert with check (auth.uid() = user_id);

drop policy if exists "wiki_records are self-updatable" on public.wiki_records;
create policy "wiki_records are self-updatable" on public.wiki_records
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists "wiki_records are self-deletable" on public.wiki_records;
create policy "wiki_records are self-deletable" on public.wiki_records
  for delete using (auth.uid() = user_id);

-- Embeddings pipeline RPCs for wiki records. Same claim/save/search
-- shape as wiki_articles (see that trio above), same security posture:
-- definer global sweep for claim/save (cron-driven service role, no
-- auth.uid()), invoker for search (RLS + explicit user_id guard).
drop function if exists public.claim_next_pending_wiki_record(text, int);
create or replace function public.claim_next_pending_wiki_record(
  p_holder_id text,
  p_ttl_seconds int
) returns table (id uuid, date date, content text, tags jsonb, user_id uuid)
language sql security definer
set search_path = public as $$
  with candidate as (
    select r.id
      from public.wiki_records r
     where r.embedding is null
       and (r.embedding_claim_expires is null
            or r.embedding_claim_expires < now())
     order by r.updated_at desc
     limit 1
     for update skip locked
  )
  update public.wiki_records r
     set embedding_claim_holder = p_holder_id,
         embedding_claim_expires = now() + make_interval(secs => p_ttl_seconds)
    from candidate c
   where r.id = c.id
  returning r.id, r.date, r.content, r.tags, r.user_id;
$$;

drop function if exists public.save_wiki_record_embedding_if_claimed(uuid, text, vector, text);
create or replace function public.save_wiki_record_embedding_if_claimed(
  p_id uuid,
  p_holder_id text,
  p_embedding vector(2048),
  p_embedding_model text
) returns boolean
language plpgsql security definer
set search_path = public as $$
declare
  updated int;
begin
  update public.wiki_records
     set embedding = p_embedding,
         embedding_model = p_embedding_model,
         embedding_claim_holder = null,
         embedding_claim_expires = null
   where id = p_id
     and embedding_claim_holder = p_holder_id
     and embedding_claim_expires > now();
  get diagnostics updated = row_count;
  return updated > 0;
end $$;

revoke all on function public.claim_next_pending_wiki_record(text, int) from public, anon, authenticated;
revoke all on function public.save_wiki_record_embedding_if_claimed(uuid, text, vector, text) from public, anon, authenticated;
grant execute on function public.claim_next_pending_wiki_record(text, int) to service_role;
grant execute on function public.save_wiki_record_embedding_if_claimed(uuid, text, vector, text) to service_role;

-- Similarity search RPC. Plain cosine ranking, same shape as
-- search_wiki_articles_by_embedding. Returns article_id so a caller can
-- group hits by their owning article. Scoped by RLS plus an explicit
-- user_id guard (b-strict escape hatch; see search_memories_by_embedding).
drop function if exists public.search_wiki_records_by_embedding(vector, int, uuid);
create or replace function public.search_wiki_records_by_embedding(
  query_embedding vector(2048),
  match_limit int,
  p_user_id uuid default null
) returns table (
  id uuid,
  article_id uuid,
  date date,
  content text,
  tags jsonb,
  created_at timestamptz,
  updated_at timestamptz,
  similarity real
)
language sql stable security invoker as $$
  select id, article_id, date, content, tags, created_at, updated_at,
         (1 - (embedding <=> query_embedding))::real as similarity
    from public.wiki_records
   where user_id = coalesce(p_user_id, auth.uid())
     and embedding is not null
   order by embedding <=> query_embedding asc
   limit match_limit
$$;

-- Per-thread pointer + claim columns for the background wiki-record
-- extraction agent. Independent of the wiki article pointer
-- (last_wiki_processed_msg_id) so extraction and article maintenance
-- run concurrently against the same thread without crowding each other's
-- pointers. Simpler than the article agent's per-thread state: no
-- content-filter fallback tracking (the extraction model has no
-- uncensored-fallback path), just a failure counter that advances the
-- pointer past a permanently-failing terminal message at the cap.
alter table public.threads
  add column if not exists last_wiki_record_processed_msg_id uuid references public.messages(id) on delete set null,
  add column if not exists wiki_record_claim_holder text,
  add column if not exists wiki_record_claim_expires_at timestamptz,
  add column if not exists wiki_record_failure_count int not null default 0,
  add column if not exists wiki_record_last_skip_at timestamptz,
  add column if not exists wiki_record_last_skip_reason text;

-- Claim the next thread eligible for record extraction, across ALL
-- users. SECURITY DEFINER global sweep, same posture as
-- claim_next_thread_for_wiki: cron-driven service role, EXECUTE locked
-- to service_role below. Eligibility differs from the article sweep in
-- two ways:
--   - gated on settings->>'wikiRecordExtractionEnabled' (only the literal
--     string 'false' disables, matching the client's `?? true` default);
--   - the user must already have at least one wiki article, since records
--     attach to an article - there is nothing for the extraction agent to
--     hang a record on otherwise.
-- Same day-gate (settle before processing) and >=2-user-message floor as
-- the article sweep.
drop function if exists public.claim_next_thread_for_wiki_records(text, int);
create or replace function public.claim_next_thread_for_wiki_records(
  p_holder_id text,
  p_ttl_seconds int
) returns table (
  thread_id uuid,
  user_id uuid,
  terminal_msg_id uuid,
  title text,
  newest_msg_at timestamptz
)
language sql security definer
set search_path = public as $$
  with candidate as (
    select
      t.id as thread_id,
      t.user_id as user_id,
      term.msg_id as terminal_msg_id,
      t.title as title,
      newest.created_at as newest_msg_at
      from public.threads t
      inner join public.profiles p on p.user_id = t.user_id
      cross join lateral (
        select public.nak_safe_timezone(p.settings->>'displayTimezone') as tz
      ) usertz
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
         order by m.position desc
         limit 1
      ) term
      cross join lateral (
        -- Wall-clock on purpose, not transcript order: this asks "when
        -- did the thread last see a write" for the day-gate, and a
        -- recovery row healed today counts as today's activity even
        -- though its position is mid-transcript.
        select m2.created_at
          from public.messages m2
         where m2.thread_id = t.id
         order by m2.created_at desc
         limit 1
      ) newest
     where (p.settings->>'wikiRecordExtractionEnabled') is distinct from 'false'
       and not t.hidden -- deleted-awaiting-GC; see the reflection sweep
       and (t.wiki_record_claim_expires_at is null
            or t.wiki_record_claim_expires_at < now())
       -- Records hang off an article; skip users with an empty wiki.
       and exists (
         select 1 from public.wiki_articles wa where wa.user_id = t.user_id
       )
       and (
         select count(*)
           from public.messages m3
          where m3.thread_id = t.id
            and m3.role = 'user'
       ) >= 2
       and term.msg_id is distinct from t.last_wiki_record_processed_msg_id
       and (newest.created_at at time zone usertz.tz)::date
           < (now() at time zone usertz.tz)::date
     order by newest.created_at asc
     limit 1
     for update of t skip locked
  )
  update public.threads t
     set wiki_record_claim_holder = p_holder_id,
         wiki_record_claim_expires_at = now() + make_interval(secs => p_ttl_seconds)
    from candidate c
   where t.id = c.thread_id
  returning t.id as thread_id, t.user_id as user_id, c.terminal_msg_id,
            c.title, c.newest_msg_at;
$$;

revoke all on function public.claim_next_thread_for_wiki_records(text, int)
  from public, anon, authenticated;
grant execute on function public.claim_next_thread_for_wiki_records(text, int)
  to service_role;

-- Advance the per-thread record pointer IF our claim is still ours.
-- Called after every successful extraction run (even a no-op run that
-- found no event advances the pointer so the thread is not re-scanned
-- every tick). Resets the failure counter + clears any skip marker.
drop function if exists public.mark_thread_wiki_record_processed_if_claimed(uuid, text, uuid, uuid);
create or replace function public.mark_thread_wiki_record_processed_if_claimed(
  p_thread_id uuid,
  p_holder_id text,
  p_msg_id uuid,
  p_user_id uuid default null
) returns boolean
language plpgsql security invoker as $$
declare
  updated int;
begin
  update public.threads
     set last_wiki_record_processed_msg_id = p_msg_id,
         wiki_record_claim_holder = null,
         wiki_record_claim_expires_at = null,
         wiki_record_failure_count = 0,
         wiki_record_last_skip_at = null,
         wiki_record_last_skip_reason = null
   where id = p_thread_id
     and user_id = coalesce(p_user_id, auth.uid())
     and wiki_record_claim_holder = p_holder_id
     and wiki_record_claim_expires_at > now();
  get diagnostics updated = row_count;
  return updated > 0;
end $$;

grant execute on function
  public.mark_thread_wiki_record_processed_if_claimed(uuid, text, uuid, uuid)
  to service_role;

-- Record an extraction failure against the claimed thread. Below the
-- cap: increment + release the claim for a fast retry. At the cap:
-- advance the pointer past this terminal message + stamp a skip marker
-- so a permanently-failing conversation does not pin the queue. Returns
-- 'released' | 'skipped' | 'claim-lost'. Simpler than the article RPC:
-- no content-filter fallback flag (the extraction model has no fallback).
drop function if exists public.record_wiki_record_failure_or_skip(uuid, text, uuid, int, text, uuid);
create or replace function public.record_wiki_record_failure_or_skip(
  p_thread_id uuid,
  p_holder_id text,
  p_msg_id uuid,
  p_max_failures int,
  p_reason text default null,
  p_user_id uuid default null
) returns text
language plpgsql security invoker as $$
declare
  v_new_count int;
begin
  update public.threads
     set wiki_record_failure_count = wiki_record_failure_count + 1
   where id = p_thread_id
     and user_id = coalesce(p_user_id, auth.uid())
     and wiki_record_claim_holder = p_holder_id
     and wiki_record_claim_expires_at > now()
  returning wiki_record_failure_count into v_new_count;
  if not found then
    return 'claim-lost';
  end if;
  if v_new_count >= p_max_failures then
    update public.threads
       set last_wiki_record_processed_msg_id = p_msg_id,
           wiki_record_claim_holder = null,
           wiki_record_claim_expires_at = null,
           wiki_record_failure_count = 0,
           wiki_record_last_skip_at = now(),
           -- 1000 mirrors the wiki agent's skip-reason cap: above the
           -- edge client's 600-char completions error-body slice plus
           -- prefix, so the stored reason is never clipped twice.
           wiki_record_last_skip_reason = nullif(left(coalesce(p_reason, ''), 1000), '')
     where id = p_thread_id;
    return 'skipped';
  end if;
  update public.threads
     set wiki_record_claim_holder = null,
         wiki_record_claim_expires_at = null
   where id = p_thread_id;
  return 'released';
end $$;

grant execute on function
  public.record_wiki_record_failure_or_skip(uuid, text, uuid, int, text, uuid)
  to service_role;

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
-- ---------------------------------------------------------------------------
-- Wiki record files + cross-links
-- ---------------------------------------------------------------------------
--
-- Two relations hung off wiki_records (the dated "journey" layer under each
-- article):
--   - wiki_record_files: per-record file attachments (crumb photos, scanned
--     recipe cards, PDFs). Bytes in the persistent `wiki-record-files` bucket;
--     the row holds metadata + a storage_path pointer, same model as documents
--     / attachments (see docs/dev/file-storage.md). Unlike attachments these
--     never expire - a record is permanent, so its evidence is too.
--   - wiki_record_links: a directed, labelled graph between records ("attempt
--     #3 is based on attempt #2"). Simple directed graph: at most one edge per
--     ordered pair, the label is the edge's editable attribute; both directions
--     are distinct rows.

create table if not exists public.wiki_record_files (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  record_id uuid not null references public.wiki_records(id) on delete cascade,
  -- Stable render order within the record's file strip.
  position int not null default 0,
  filename text not null,
  mime_type text,
  size_bytes int,
  -- Object key in the `wiki-record-files` bucket:
  -- `<user_id>/<file_id>/<filename>`. NOT NULL: records are permanent, so the
  -- object is never reclaimed while the row lives (the GC sweep only removes
  -- objects whose row is already gone). A record/article delete cascades the
  -- row away and the wiki-record-file-gc sweep reclaims the orphaned object.
  storage_path text not null,
  -- Venice text-parser output for non-image documents, so the chat model can
  -- read an attached PDF via record_get without re-fetching bytes. NULL for
  -- images (they reach the model as a signed URL / analyze_image instead).
  extracted_text text,
  -- Lowercase hex SHA-256 of the file bytes. Drives the per-record dedup in
  -- record_file_attach: a re-run of the extraction/wiki agent that names the
  -- same source file must not stack a second identical row on the record.
  -- Content-keyed (not filename) so a filename collision between two
  -- genuinely different files still attaches both. NULL for legacy rows
  -- written before the column existed; the dedup probe simply misses them.
  content_hash text,
  created_at timestamptz not null default now()
);

-- Per-record fetch in render order.
create index if not exists wiki_record_files_record_idx
  on public.wiki_record_files (record_id, position);
-- Anti-join support for the orphan-object GC sweep
-- (list_orphan_wiki_record_file_objects): the sweep LEFT-anti-joins
-- storage.objects to this column, so a row's storage_path must be
-- index-probable.
create index if not exists wiki_record_files_storage_path_idx
  on public.wiki_record_files (storage_path);

-- content_hash added after the initial ship: guard for existing installs
-- (create table if not exists won't add it to a populated table).
alter table public.wiki_record_files
  add column if not exists content_hash text;
-- Probe for the per-record dedup in record_file_attach: "does this record
-- already hold a file with these exact bytes?"
create index if not exists wiki_record_files_record_hash_idx
  on public.wiki_record_files (record_id, content_hash);

alter table public.wiki_record_files enable row level security;

-- Direct user_id scoping, same as wiki_records (which also carries user_id) -
-- no via-parent chain needed.
drop policy if exists "wiki_record_files are self-selectable" on public.wiki_record_files;
create policy "wiki_record_files are self-selectable" on public.wiki_record_files
  for select using (auth.uid() = user_id);
drop policy if exists "wiki_record_files are self-insertable" on public.wiki_record_files;
create policy "wiki_record_files are self-insertable" on public.wiki_record_files
  for insert with check (auth.uid() = user_id);
drop policy if exists "wiki_record_files are self-updatable" on public.wiki_record_files;
create policy "wiki_record_files are self-updatable" on public.wiki_record_files
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
drop policy if exists "wiki_record_files are self-deletable" on public.wiki_record_files;
create policy "wiki_record_files are self-deletable" on public.wiki_record_files
  for delete using (auth.uid() = user_id);

-- Private bucket for record file bytes. Same shape as documents / attachments:
-- public = false, self-prefix RLS on storage.objects, key
-- `<user_id>/<file_id>/<filename>`. Persistent (no expiry sweep); orphaned
-- objects (post-cascade) reclaimed by wiki-record-file-gc.
insert into storage.buckets (id, name, public)
  values ('wiki-record-files', 'wiki-record-files', false)
  on conflict (id) do nothing;

drop policy if exists "wiki-record-files bucket is self-readable" on storage.objects;
create policy "wiki-record-files bucket is self-readable" on storage.objects
  for select to authenticated
  using (
    bucket_id = 'wiki-record-files'
    and (storage.foldername(name))[1] = auth.uid()::text
  );
drop policy if exists "wiki-record-files bucket is self-writable" on storage.objects;
create policy "wiki-record-files bucket is self-writable" on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'wiki-record-files'
    and (storage.foldername(name))[1] = auth.uid()::text
  );
drop policy if exists "wiki-record-files bucket is self-deletable" on storage.objects;
create policy "wiki-record-files bucket is self-deletable" on storage.objects
  for delete to authenticated
  using (
    bucket_id = 'wiki-record-files'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

create table if not exists public.wiki_record_links (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  from_record_id uuid not null references public.wiki_records(id) on delete cascade,
  to_record_id uuid not null references public.wiki_records(id) on delete cascade,
  -- Freeform relationship label ("based on", "supersedes"); capped to match
  -- MAX_RECORD_LINK_LABEL_CHARS (120) on the client + tools.
  label text,
  created_at timestamptz not null default now(),
  -- No self-links.
  constraint wiki_record_links_no_self check (from_record_id <> to_record_id),
  -- Simple directed graph: one edge per ordered pair. A->B and B->A are
  -- distinct rows; re-linking the same pair updates the label rather than
  -- adding a parallel edge.
  constraint wiki_record_links_unique_pair unique (from_record_id, to_record_id)
);

-- Forward (a record's outgoing links) and reverse (incoming) lookups; a
-- record's view shows both.
create index if not exists wiki_record_links_from_idx
  on public.wiki_record_links (from_record_id);
create index if not exists wiki_record_links_to_idx
  on public.wiki_record_links (to_record_id);

alter table public.wiki_record_links enable row level security;

drop policy if exists "wiki_record_links are self-selectable" on public.wiki_record_links;
create policy "wiki_record_links are self-selectable" on public.wiki_record_links
  for select using (auth.uid() = user_id);
drop policy if exists "wiki_record_links are self-insertable" on public.wiki_record_links;
create policy "wiki_record_links are self-insertable" on public.wiki_record_links
  for insert with check (auth.uid() = user_id);
drop policy if exists "wiki_record_links are self-updatable" on public.wiki_record_links;
create policy "wiki_record_links are self-updatable" on public.wiki_record_links
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
drop policy if exists "wiki_record_links are self-deletable" on public.wiki_record_links;
create policy "wiki_record_links are self-deletable" on public.wiki_record_links
  for delete using (auth.uid() = user_id);

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
  -- Record files + links cascade on wiki_records delete (record_id is NOT
  -- NULL, on delete cascade), but delete them explicitly first so the wipe
  -- reads clearly and doesn't depend on cascade ordering. The bucket OBJECTS
  -- behind wiki_record_files are NOT removed here (SQL can't touch Storage);
  -- the wiki-record-file-gc sweep reclaims them once the rows are gone.
  delete from public.wiki_record_files where user_id = v_user;
  delete from public.wiki_record_links where user_id = v_user;
  -- Records cascade on wiki_articles delete (article_id is NOT NULL,
  -- on delete cascade), but delete them explicitly first so the wipe
  -- reads clearly and doesn't depend on cascade ordering.
  delete from public.wiki_records where user_id = v_user;
  delete from public.wiki_articles where user_id = v_user;
  -- A wipe is a fresh start. Surviving changelog rows would point at
  -- nothing (article_id nulled by the FK cascade) and read confusingly
  -- alongside an empty wiki, so we drop them here as part of the same
  -- reset rather than leaving orphans.
  delete from public.wiki_changelog where user_id = v_user;
  -- The audit log is processing history for data that no longer
  -- exists after a wipe; clear it with the rest so the fresh start
  -- is actually fresh.
  delete from public.wiki_agent_log where user_id = v_user;
  update public.threads
     set last_wiki_processed_msg_id = null,
         wiki_claim_holder = null,
         wiki_claim_expires_at = null,
         wiki_failure_count = 0,
         wiki_last_skip_at = null,
         wiki_last_skip_reason = null,
         wiki_skip_fallback_attempted = false,
         -- Clear the record-extraction pointer too so the extraction
         -- agent re-scans each thread from scratch after a reset, the
         -- same way the article agent does.
         last_wiki_record_processed_msg_id = null,
         wiki_record_claim_holder = null,
         wiki_record_claim_expires_at = null,
         wiki_record_failure_count = 0,
         wiki_record_last_skip_at = null,
         wiki_record_last_skip_reason = null
   where user_id = v_user;
end $$;

-- Wiki librarian cadence + run-coordination state. The wiki
-- librarian is a separate background agent that periodically
-- reorganises the user's wiki: consolidating duplicates, fact-
-- checking against conversation history, merging articles that
-- belong together. It runs on a long minimum interval (12 hours
-- by default) - far less often than the per-conversation wiki
-- agent - and there's no per-thread queue. The scheduled drive is
-- the venice function's /wiki-librarian-sweep route (pg_cron ->
-- pg_net, see the cron section at the bottom of this file).
--
-- Cadence gate: store the last run timestamp on profiles and gate
-- via an UPDATE-with-WHERE that only matches when `now() - last_run
-- >= min_interval`. The UPDATE is atomic per row, so concurrent
-- sweep ticks can't double-claim a user. The stamp lands BEFORE the
-- run on purpose: a run that dies mid-flight waits out the interval
-- rather than retrying hot against whatever killed it.
--
-- In-flight guard: a separate holder+TTL pair, because the cadence
-- stamp can't express "running right now". Three server paths can
-- start a librarian run (the scheduled sweep, the Wiki panel's
-- manual-run button, the chat-dispatched wiki_librarian tool); the
-- guard makes them mutually exclusive so two runs never edit the
-- wiki concurrently. Manual and chat runs take ONLY the guard (not
-- the cadence stamp - user-driven runs don't reset the 12h clock).
alter table public.profiles
  add column if not exists wiki_librarian_last_run_at timestamptz,
  add column if not exists wiki_librarian_inflight_holder text,
  add column if not exists wiki_librarian_inflight_expires_at timestamptz,
  -- Terminal outcome of the most recent manual wiki-librarian run,
  -- persisted for reload recovery. Twin of
  -- memory_librarian_last_run_outcome (see the memory-librarian block);
  -- the `_outcome` suffix keeps it distinct from the
  -- wiki_librarian_last_run_at cadence stamp above. Shape:
  -- { runId, source, finishedAt, result: WikiLibrarianRunResult }.
  add column if not exists wiki_librarian_last_run_outcome jsonb;

-- Claim the next user due for a scheduled librarian run, across ALL
-- users. SECURITY DEFINER global sweep (same posture as
-- claim_next_thread_for_wiki): the caller is the cron-driven
-- service role, so there is no auth.uid() to scope by; EXECUTE is
-- locked to service_role below. Gated on the Settings toggle (only
-- the literal string 'false' disables - matching the client's
-- `?? true` default, and a cast could wedge the global sweep on one
-- malformed value). Most-overdue user first; returns their user_id
-- or no row when nobody is due.
drop function if exists public.claim_wiki_librarian_run(int);
drop function if exists public.claim_next_user_for_wiki_librarian(int);
create or replace function public.claim_next_user_for_wiki_librarian(
  p_min_interval_seconds int
) returns uuid
language sql security definer
set search_path = public as $$
  with candidate as (
    select p.user_id
      from public.profiles p
     where (p.settings->>'wikiLibrarianEnabled') is distinct from 'false'
       and (
         p.wiki_librarian_last_run_at is null
         or p.wiki_librarian_last_run_at
              < now() - make_interval(secs => p_min_interval_seconds)
       )
     order by p.wiki_librarian_last_run_at asc nulls first
     limit 1
     for update of p skip locked
  )
  update public.profiles p
     set wiki_librarian_last_run_at = now()
    from candidate c
   where p.user_id = c.user_id
  returning p.user_id;
$$;

revoke all on function public.claim_next_user_for_wiki_librarian(int)
  from public, anon, authenticated;
grant execute on function public.claim_next_user_for_wiki_librarian(int)
  to service_role;

-- Take the per-user in-flight guard. Returns true when this holder
-- acquired it (no current holder, or the previous holder's TTL
-- lapsed - a crashed run must not wedge the librarian forever).
-- b-strict: the venice function calls with the service-role client
-- and passes the owner id explicitly; coalesce keeps a hypothetical
-- browser caller correct.
drop function if exists public.claim_wiki_librarian_inflight(text, int, uuid);
create or replace function public.claim_wiki_librarian_inflight(
  p_holder_id text,
  p_ttl_seconds int,
  p_user_id uuid default null
) returns boolean
language plpgsql security invoker as $$
declare
  updated int;
begin
  update public.profiles
     set wiki_librarian_inflight_holder = p_holder_id,
         wiki_librarian_inflight_expires_at = now() + make_interval(secs => p_ttl_seconds)
   where user_id = coalesce(p_user_id, auth.uid())
     and (
       wiki_librarian_inflight_holder is null
       or wiki_librarian_inflight_expires_at is null
       or wiki_librarian_inflight_expires_at < now()
     );
  get diagnostics updated = row_count;
  return updated > 0;
end $$;

grant execute on function
  public.claim_wiki_librarian_inflight(text, int, uuid) to service_role;

-- Release the in-flight guard IF it is still ours. A lapsed-and-
-- stolen guard is left alone (the thief owns it now). No-op when
-- the holder doesn't match.
drop function if exists public.release_wiki_librarian_inflight(text, uuid);
create or replace function public.release_wiki_librarian_inflight(
  p_holder_id text,
  p_user_id uuid default null
) returns void
language sql security invoker as $$
  update public.profiles
     set wiki_librarian_inflight_holder = null,
         wiki_librarian_inflight_expires_at = null
   where user_id = coalesce(p_user_id, auth.uid())
     and wiki_librarian_inflight_holder = p_holder_id;
$$;

grant execute on function
  public.release_wiki_librarian_inflight(text, uuid) to service_role;

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

-- Atomic terminal commit for streaming-root assistant rows --------------
--
-- The streaming chat edge function creates an assistant row with
-- status='streaming' at the first content delta and UPDATEs its content
-- as deltas arrive. When the round chain finishes, the function calls
-- this RPC to atomically run the same "newer user message" conflict
-- check that add_assistant_message uses on the legacy path and either
-- flip status to 'complete' (writing the final content + provenance) or
-- report the conflict so the function can transition the row to a
-- terminal-error state instead. add_assistant_message stays in place for
-- callers that still INSERT the assistant row in one shot at the end of
-- the round (the browser-side chat-loop, pre-migration); this one is the
-- UPDATE-the-existing-streaming-row variant.
--
-- p_superseded_ids carries the regenerate-from-here replace range: the
-- rows the new completion replaces (the old assistant turn plus every
-- later row, including later user turns). They are excluded from the
-- newer-user-message conflict check - they are still in the DB while
-- the replacement streams, and without the exclusion every mid-thread
-- regenerate would false-positive as a cross-device race - and deleted
-- here, in the same transaction as the commit. Deleting at commit
-- rather than browser-side after the END event means a turn that never
-- commits (error, abort, conflict, wall timeout) leaves the original
-- rows untouched, and a browser that dies right after the commit
-- cannot strand superseded rows in the thread. Null/empty on plain
-- sends.
--
-- security definer because the function calls this through the service-
-- role admin client (b-strict; see docs/dev/edge-function-auth.md). The
-- caller's session JWT may have expired by the time the round chain
-- finishes - the whole point of the migration is the function outliving
-- the browser connection - so auth.uid() is not available. p_user_id is
-- passed explicitly and verified against the thread's owner inside the
-- function to keep the ownership gate intact.
drop function if exists public.commit_assistant_message(uuid, uuid, uuid, text, text, jsonb, text, jsonb);
create or replace function public.commit_assistant_message(
  p_assistant_message_id uuid,
  p_user_message_id      uuid,
  p_user_id              uuid,
  p_content              text,
  p_model                text,
  p_usage                jsonb,
  p_reasoning            text,
  p_citations            jsonb,
  p_superseded_ids       uuid[] default null
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_thread_id uuid;
  v_anchor_ts timestamptz;
  v_owner_id  uuid;
  v_msg       record;
begin
  -- Lock the streaming row. The status='streaming' filter doubles as
  -- an idempotency guard: a retried commit on an already-terminal row
  -- fails the lookup and returns conflict rather than overwriting a
  -- completed state.
  select m.thread_id
    into v_thread_id
    from public.messages m
    where m.id = p_assistant_message_id
      and m.role = 'assistant'
      and m.status = 'streaming'
    for update;

  if not found then
    return jsonb_build_object('conflict', true, 'reason', 'row_not_streaming');
  end if;

  -- Confirm the caller owns the thread. The function trusts its own
  -- p_user_id (extracted from the gateway-verified JWT at request entry);
  -- this is the integrity gate that catches a row-id from one thread
  -- being committed under another user's context.
  select user_id into v_owner_id
    from public.threads
    where id = v_thread_id
    for update;

  if v_owner_id is null or v_owner_id <> p_user_id then
    return jsonb_build_object('conflict', true, 'reason', 'ownership_mismatch');
  end if;

  -- Anchor user message must still exist in the thread's resolved
  -- transcript. Same-thread is the common case and the fast path; the
  -- transcript fallback admits an INHERITED anchor - a completion on a
  -- fork whose fork point is the anchoring user message itself (any
  -- fork minted at a user row, and every shared-region regenerate,
  -- which forks at the anchor and streams into the fork) commits with
  -- an anchor that lives in an ancestor's segment. Transcript
  -- membership still proves the anchor belongs to THIS conversation
  -- and still catches an anchor deleted mid-stream.
  select created_at into v_anchor_ts
    from public.messages
    where id = p_user_message_id
      and role = 'user'
      and (thread_id = v_thread_id
           or exists (
             select 1
               from public.thread_transcript(v_thread_id) tt
              where tt.id = p_user_message_id));

  if not found then
    return jsonb_build_object('conflict', true, 'reason', 'anchor_missing');
  end if;

  -- Any user message newer than our anchor means a competing send
  -- landed while the function was streaming. The response was computed
  -- without that context, so we discard it. Rows in p_superseded_ids
  -- are exempt: a regenerate anchored mid-thread is REPLACING the later
  -- turns, so their user rows are stale context slated for the delete
  -- below, not competing sends. The cross-device-race-ui v1+ plan
  -- covers the loser-UI affordance and the soft-delete 'superseded'
  -- transition; for v1 we just return conflict and the function
  -- persists status='error' on the row. The check must run BEFORE the
  -- superseded delete: returning a conflict object does not roll the
  -- transaction back, so a delete-first ordering would destroy the
  -- rows of a turn we then refuse to commit.
  if exists (
    select 1 from public.messages
      where thread_id = v_thread_id
        and role = 'user'
        and id <> p_user_message_id
        and created_at > v_anchor_ts
        and (p_superseded_ids is null or id <> all(p_superseded_ids))
  ) then
    return jsonb_build_object('conflict', true, 'reason', 'newer_user_message');
  end if;

  -- Regenerate-from-here: drop the replaced rows atomically with the
  -- commit (see the function preamble for why server-side). The
  -- empty-content guard mirrors the browser's own rule: a completion
  -- with no replaceable text (a reasoning-only turn) keeps the old
  -- rows rather than replacing them with nothing. The anchor user
  -- message and the streaming row itself are excluded defensively -
  -- callers never include them, but deleting either would corrupt the
  -- turn being committed. message_attachments rows cascade via their
  -- FK's ON DELETE CASCADE; samskara_substrate does NOT cascade by
  -- design - an orphan substrate row still carries training signal
  -- for the formation pipeline, so it stays.
  if p_superseded_ids is not null
     and array_length(p_superseded_ids, 1) > 0
     and trim(p_content) <> '' then
    delete from public.messages
      where thread_id = v_thread_id
        and id = any(p_superseded_ids)
        and id <> p_user_message_id
        and id <> p_assistant_message_id;
  end if;

  update public.messages
     set content   = trim(p_content),
         model     = p_model,
         usage     = p_usage,
         reasoning = p_reasoning,
         citations = p_citations,
         status    = 'complete'
   where id = p_assistant_message_id
  returning * into v_msg;

  -- Bump updated_at so the thread jumps to the top of the sidebar,
  -- matching add_assistant_message's behavior. Also clear last_error -
  -- a successful commit is the explicit signal that any prior
  -- transient failure has been resolved (next user message + completed
  -- turn = the thread is healthy again). The browser's error card is
  -- driven off this column going non-null, so clearing here is what
  -- removes the card on the realtime echo.
  update public.threads
    set updated_at = now(),
        last_error = null
    where id = v_thread_id;

  return jsonb_build_object(
    'conflict', false,
    'message',  row_to_json(v_msg)
  );
end;
$$;

-- service-role only - mirrors the discipline elsewhere in this file for
-- security-definer functions that the browser must never reach. The
-- streaming function calls this through the admin client; no
-- authenticated or anon user should be able to commit terminal state
-- on an assistant row.
revoke all on function public.commit_assistant_message(uuid, uuid, uuid, text, text, jsonb, text, jsonb, uuid[])
  from public, anon, authenticated;
grant execute on function public.commit_assistant_message(uuid, uuid, uuid, text, text, jsonb, text, jsonb, uuid[])
  to service_role;

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
-- prompt on the most recent turn against this thread.
-- Overwritten per turn (the priming stage's `applyBiasPriming`
-- writes whatever it just rendered). The worker reads this in its
-- analyze phase so the merged observer/reactor agent knows which
-- biases the user's messages could have been reacting to.
-- Empty array (the default) means "no biases were active" - the
-- reactor pass for this conversation produces no rows.
alter table public.threads
  add column if not exists bias_active_at_turn text[] not null default '{}';

-- Most recent unrecoverable error against this thread. Set by the
-- streaming function on any terminalKind='error' path (Venice 4xx/5xx,
-- network, truncated, round-limit, wall-timeout, tool dispatch, commit
-- conflict); cleared by commit_assistant_message on the happy path.
-- Shape is `{kind, message, occurred_at}` - the message is the user-
-- facing translated string (see error-translate.ts), kind is the
-- machine-readable source for UI branching (retry-able vs not), and
-- occurred_at is the function-side wall clock for ordering / staleness
-- checks. jsonb lets us evolve the shape (add retry_after_ms, request_id,
-- etc.) without another migration. NULL means "no outstanding error" -
-- the browser keys the error card off non-null, so a happy completion
-- naturally removes the card. Realtime delivers the column update via
-- the existing threads channel, so the browser doesn't need a separate
-- subscription.
alter table public.threads
  add column if not exists last_error jsonb;

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

-- Claim the next eligible thread for bias analysis - the cron
-- sweep's claim, scanning across ALL users (the per-user variant
-- died with the browser worker). Eligibility, from
-- docs/dev/bias-profile.md:
--   - has at least p_min_user_messages user messages (default 2)
--   - either never processed, or processed before the thread's most
--     recent update (a new user message bumps threads.updated_at,
--     and chat-loop also clears bias_processed_at directly)
--   - threads.updated_at falls on a calendar day BEFORE today in the
--     owner's timezone (profile displayTimezone via
--     nak_safe_timezone, UTC fallback) - "today" excludes
--     conversations the user might still be actively chatting in.
--     There is no open-tab exclusion list: this day-gate subsumes it,
--     and the save RPC's message-count guard covers the mid-analysis
--     race.
--   - no live claim (claim_holder NULL, or expired, or already ours)
--
-- Atomic claim via update-returning so overlapping ticks never both
-- win. Returns one row (with user_id for logger attribution) or
-- empty.
drop function if exists public.bias_claim_next_thread_for_sweep(text, int, int);
create or replace function public.bias_claim_next_thread_for_sweep(
  p_holder_id text,
  p_ttl_seconds int,
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
  active_biases text[],
  user_id uuid
)
language sql security definer
set search_path = public as $$
  with candidate as (
    select t.id as thread_id,
           (select count(*)::int from public.messages m
             where m.thread_id = t.id and m.role = 'user') as user_message_count,
           coalesce(t.bias_active_at_turn, '{}'::text[]) as active_biases,
           t.user_id as user_id
      from public.threads t
      inner join public.profiles p on p.user_id = t.user_id
      cross join lateral (
        -- One safe-timezone resolution per candidate row, shared by
        -- both sides of the day-gate comparison below.
        select public.nak_safe_timezone(p.settings->>'displayTimezone') as tz
      ) usertz
     where (t.updated_at at time zone usertz.tz)::date
             < (now() at time zone usertz.tz)::date
       and (
         t.bias_processed_at is null
         or t.bias_processed_at < t.updated_at
       )
       and (
         t.bias_claim_holder is null
         or t.bias_claim_expires < now()
         or t.bias_claim_holder = p_holder_id
       )
       -- The count check MUST live in the WHERE, not as a post-SELECT
       -- early return: this query takes one candidate (LIMIT 1, oldest
       -- updated_at first), so a rejected candidate has to be excluded
       -- BEFORE the limit or it stays the queue head and starves every
       -- thread behind it. A one-shot Q&A thread at the head of the
       -- queue once wedged the analyze pipeline this way for weeks -
       -- the worker logged "no eligible threads" while eligible
       -- multi-message threads sat unprocessed behind it. Same inline
       -- shape as claim_next_thread_for_reflection's substance bar.
       and (
         select count(*) from public.messages m
           where m.thread_id = t.id and m.role = 'user'
       ) >= p_min_user_messages
     order by t.updated_at asc
     limit 1
     for update of t skip locked
  )
  update public.threads t
     set bias_claim_holder = p_holder_id,
         bias_claim_expires = now() + make_interval(secs => p_ttl_seconds)
    from candidate c
   where t.id = c.thread_id
  returning t.id, c.user_message_count, c.active_biases, t.user_id;
$$;

-- Global sweep, owner-privileged: only the cron-driven service role
-- may claim across users.
revoke all on function public.bias_claim_next_thread_for_sweep(text, int, int)
  from public, anon, authenticated;
grant execute on function public.bias_claim_next_thread_for_sweep(text, int, int)
  to service_role;

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
--
-- p_user_id: the sweep's service-role client has no auth.uid(), so
-- it passes the claimed row's owner explicitly (the b-strict
-- overload pattern). An authenticated caller omits it.
drop function if exists public.bias_save_observations(uuid, text, int, jsonb, jsonb, uuid);
create or replace function public.bias_save_observations(
  p_thread_id uuid,
  p_holder_id text,
  p_expected_msg_count int,
  p_observations jsonb,
  p_reactions jsonb,
  p_user_id uuid default null
)
returns boolean
security invoker
language plpgsql
as $$
declare
  v_uid uuid := coalesce(p_user_id, auth.uid());
  v_actual_count int;
  v_obs jsonb;
  v_was_confirmed boolean;
begin
  if v_uid is null then
    return false;
  end if;

  -- Claim + ownership + message-count guard, all in one statement.
  -- If any condition fails the SELECT returns no row and we exit.
  perform 1 from public.threads
    where id = p_thread_id
      and user_id = v_uid
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
      -- user_id explicit: the column default is auth.uid(), which is
      -- NULL for the sweep's service-role call and would violate the
      -- not-null constraint.
      insert into public.bias_observations
        (user_id, thread_id, bias, confidence, reasoning, evidence_message_id)
      values (
        v_uid,
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
        (user_id, thread_id, bias, was_confirmed, reasoning)
      values (
        v_uid,
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

-- Clear a thread's bias-processed state. Called at turn entry when a
-- new user message lands on a thread that was previously processed:
-- the conversation has new content the worker hasn't seen, so the
-- prior observations are stale. We delete the observations outright
-- (cheaper than tracking "stale" flags) and clear the processed-at so
-- the worker's next scan picks the thread up.
-- p_user_id: priming runs server-side in the venice edge function now,
-- where the service-role client has no auth.uid(); the orchestrator
-- passes the JWT-derived user id explicitly. Authenticated callers omit
-- it and fall back to auth.uid() (same overload pattern as
-- bias_processed_threads_for_bias).
drop function if exists public.bias_clear_thread(uuid, uuid);
create or replace function public.bias_clear_thread(
  p_thread_id uuid,
  p_user_id uuid default null
)
returns void
security invoker
language plpgsql
as $$
declare
  v_uid uuid := coalesce(p_user_id, auth.uid());
begin
  if v_uid is null then
    return;
  end if;
  -- Guard ownership before deleting. RLS would scope an authenticated
  -- caller too, but the service-role orchestrator bypasses RLS, so the
  -- explicit v_uid filter is what keeps the writes user-scoped.
  delete from public.bias_observations
    where thread_id = p_thread_id and user_id = v_uid;
  -- v2: also clear reactions. The snapshot column gets reset to
  -- empty - a re-analyze on the next worker pass will see whatever
  -- the chat-loop renders on the next turn.
  delete from public.bias_reactions
    where thread_id = p_thread_id and user_id = v_uid;
  update public.threads
    set bias_processed_at = null,
        bias_processed_msg_count = null,
        bias_claim_holder = null,
        bias_claim_expires = null,
        bias_active_at_turn = '{}'::text[]
    where id = p_thread_id and user_id = v_uid;
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
-- p_user_id: b-strict overload - the sweep's aggregate pass scopes
-- per claimed user with the service-role client; authenticated
-- callers omit it.
drop function if exists public.bias_processed_threads_for_bias(text, uuid);
create or replace function public.bias_processed_threads_for_bias(
  p_bias text,
  p_user_id uuid default null
)
returns table (
  thread_id uuid,
  processed_at timestamptz,
  p_conv real
)
security invoker
language plpgsql
as $$
declare
  v_uid uuid := coalesce(p_user_id, auth.uid());
begin
  if v_uid is null then
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
        where o.user_id = v_uid and o.bias = p_bias
        group by o.thread_id
    )
    select t.id, t.bias_processed_at, coalesce(h.p_conv, 0.0)::real
      from public.threads t
      left join hits h on h.thread_id = t.id
      where t.user_id = v_uid
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
-- p_user_id: b-strict overload, same as
-- bias_processed_threads_for_bias above.
drop function if exists public.bias_reactions_for_bias(text, uuid);
create or replace function public.bias_reactions_for_bias(
  p_bias text,
  p_user_id uuid default null
)
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
declare
  v_uid uuid := coalesce(p_user_id, auth.uid());
begin
  if v_uid is null then
    return;
  end if;
  return query
    select r.thread_id,
           r.was_confirmed,
           (extract(epoch from (now() - r.created_at)) / 86400.0)::real as age_days,
           r.created_at,
           r.reasoning
      from public.bias_reactions r
      where r.user_id = v_uid and r.bias = p_bias
      order by r.created_at desc;
end;
$$;

-- service_role grants for the sweep driver (the venice function's
-- bias-sweep tick) - its only caller now that the browser worker is
-- gone. The b-strict overload keeps the functions role-agnostic
-- (an authenticated caller still gets auth.uid() scoping) rather
-- than forking definer copies.
grant execute on function
  public.bias_save_observations(uuid, text, int, jsonb, jsonb, uuid) to service_role;
grant execute on function
  public.bias_processed_threads_for_bias(text, uuid) to service_role;
grant execute on function
  public.bias_reactions_for_bias(text, uuid) to service_role;


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
  -- wiki_articles feeds the browser's emitWikiChange refresh: the
  -- autonomous wiki agent writes articles server-side (cron-driven, no
  -- browser event bus to fire), so an open Wiki panel learns about
  -- changes through a user-scoped postgres_changes subscription
  -- instead of the old worker progress message.
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'wiki_articles'
  ) then
    alter publication supabase_realtime add table public.wiki_articles;
  end if;
  -- memories feeds the browser's emitMemoryChange refresh the same
  -- way wiki_articles feeds emitWikiChange: the memory librarians
  -- (rem, deep-sleep) and reflection all write memories server-side
  -- now, so an open Memories panel learns about changes through a
  -- user-scoped postgres_changes subscription.
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'memories'
  ) then
    alter publication supabase_realtime add table public.memories;
  end if;
  -- recipes feeds the browser's emitCookbookChange refresh, third of
  -- the wiki_articles / memories family: the chat-reachable recipe
  -- writers (the recipe_* tools) run server-side, so the Cookbook
  -- modal and the drawer's Recipes tab learn about model-driven
  -- writes through a user-scoped postgres_changes subscription.
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'recipes'
  ) then
    alter publication supabase_realtime add table public.recipes;
  end if;
  -- wiki_records feeds the browser's emitWikiChange refresh alongside
  -- wiki_articles: the extraction agent, the librarian, and the chat
  -- record tools all write records server-side, so an open article view
  -- learns about record changes through a user-scoped postgres_changes
  -- subscription (see subscribeToWikiRecordChanges).
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'wiki_records'
  ) then
    alter publication supabase_realtime add table public.wiki_records;
  end if;
  -- wiki_record_files / wiki_record_links: an open article view learns about
  -- file attach/remove and link create/delete (from the chat tools and the
  -- extraction/librarian agents, all server-side) through the same user-scoped
  -- postgres_changes relay as wiki_records (see subscribeToWikiRecordChanges).
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'wiki_record_files'
  ) then
    alter publication supabase_realtime add table public.wiki_record_files;
  end if;
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'wiki_record_links'
  ) then
    alter publication supabase_realtime add table public.wiki_record_links;
  end if;
  -- The grocery tables feed the Groceries drawer tab's refresh relay
  -- (subscribeToGroceryChanges -> emitGroceryChange): a checkbox
  -- click in the Cookbook detail pane, the invalidation trigger's
  -- delete on a recipe edit, and a second device at the store all
  -- reach an open Groceries tab through this stream. Products and
  -- entries are both members because either can change alone (a
  -- section filing touches only the product; a buy touches only the
  -- entry).
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'grocery_products'
  ) then
    alter publication supabase_realtime add table public.grocery_products;
  end if;
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'grocery_list_entries'
  ) then
    alter publication supabase_realtime add table public.grocery_list_entries;
  end if;
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'grocery_sections'
  ) then
    alter publication supabase_realtime add table public.grocery_sections;
  end if;
  -- samskaras is deliberately NOT a member. Mint toasts ride a private
  -- samskara-mint Broadcast event (insertMint -> _shared/samskara-mint.ts
  -- + the owner-subscribe policy below), never a postgres_changes echo.
  -- The only thing any client ever consumed was the INSERT, but the fire
  -- path UPDATEs fire_count / last_fired_at / health on this table on
  -- every fire - those updates outran inserts ~10,000:1. As a publication
  -- member each one got decoded off the WAL by realtime.list_changes and
  -- discarded for want of a subscriber, which made that decode the single
  -- largest consumer of database time. Drop it on re-apply for databases
  -- that still carry the old membership (alter publication has no `drop
  -- table if exists`, so guard explicitly).
  if exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'samskaras'
  ) then
    alter publication supabase_realtime drop table public.samskaras;
  end if;
  -- profiles feeds the manual-agent-run strips' "a run is in flight"
  -- spinner + button-disable. The wiki/memory librarian in-flight
  -- leases live on this row (*_inflight_expires_at); a manual or
  -- scheduled run claims the lease (UPDATE) and releases it (UPDATE),
  -- so a user-scoped postgres_changes subscription on UPDATE lets every
  -- open client (the originating tab, a refresh, another device) detect
  -- a run - including background scheduled runs - and render at least a
  -- spinner. UPDATE-only delivery: the filter is on user_id, which the
  -- new tuple always carries, so no replica-identity index is needed
  -- (that requirement is specific to DELETE delivery, see below; lease
  -- rows are never deleted, only nulled).
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'profiles'
  ) then
    alter publication supabase_realtime add table public.profiles;
  end if;
end $$;

-- DELETE delivery for the user-filtered postgres_changes relays above.
-- A DELETE's WAL record carries only the table's replica identity (the
-- primary key by default), so realtime cannot match a user_id filter
-- against it and silently drops the event - an open panel keeps
-- showing a row a server-side tool already deleted. REPLICA IDENTITY
-- FULL would fix delivery but writes the entire old row into WAL on
-- every update/delete, and memories + recipes carry vector(2048)
-- embeddings - a bulk confidence sweep would amplify WAL by ~10KB per
-- row. A unique (id, user_id) index as the replica identity puts
-- exactly the filter column into the old tuple at near-zero WAL cost.
-- NOTE: dropping one of these indexes silently degrades the table's
-- replica identity to NOTHING, which breaks DELETE replication
-- entirely - they look redundant next to the pkey but are
-- load-bearing for realtime.
create unique index if not exists recipes_replident_idx
  on public.recipes (id, user_id);
alter table public.recipes replica identity using index recipes_replident_idx;
create unique index if not exists wiki_articles_replident_idx
  on public.wiki_articles (id, user_id);
alter table public.wiki_articles replica identity using index wiki_articles_replident_idx;
create unique index if not exists memories_replident_idx
  on public.memories (id, user_id);
alter table public.memories replica identity using index memories_replident_idx;
create unique index if not exists wiki_records_replident_idx
  on public.wiki_records (id, user_id);
alter table public.wiki_records replica identity using index wiki_records_replident_idx;
create unique index if not exists wiki_record_files_replident_idx
  on public.wiki_record_files (id, user_id);
alter table public.wiki_record_files replica identity using index wiki_record_files_replident_idx;
create unique index if not exists wiki_record_links_replident_idx
  on public.wiki_record_links (id, user_id);
alter table public.wiki_record_links replica identity using index wiki_record_links_replident_idx;
create unique index if not exists grocery_products_replident_idx
  on public.grocery_products (id, user_id);
alter table public.grocery_products replica identity using index grocery_products_replident_idx;
create unique index if not exists grocery_list_entries_replident_idx
  on public.grocery_list_entries (id, user_id);
alter table public.grocery_list_entries replica identity using index grocery_list_entries_replident_idx;
create unique index if not exists grocery_sections_replident_idx
  on public.grocery_sections (id, user_id);
alter table public.grocery_sections replica identity using index grocery_sections_replident_idx;

-- ---------------------------------------------------------------------------
-- Realtime Broadcast authorization (streaming-root channels)
-- ---------------------------------------------------------------------------
--
-- The streaming chat edge function publishes live events to a
-- 'thread:<uuid>:stream' Broadcast channel for each in-flight assistant
-- turn, and subscribes to 'thread:<uuid>:control' to receive client-
-- initiated cancel signals. The function uses the service-role admin
-- client, so its publishes and subscribes bypass these RLS policies.
-- These policies gate the *browser* side of the contract:
--
--   - Browsers subscribe to 'thread:<uuid>:stream' to receive deltas.
--     A SELECT on realtime.messages keyed on the topic name is what the
--     Realtime server checks against these policies.
--   - Browsers publish '{"type":"cancel"}' to 'thread:<uuid>:control'
--     when the user clicks Stop. Publishing a broadcast over the socket
--     requires the client to FIRST join (subscribe to) the channel, and
--     joining a private channel is itself a SELECT check - so the
--     control channel needs BOTH a SELECT (subscribe/join) policy and an
--     INSERT (publish) policy. The browser is the only publisher; the
--     function subscribes under service_role and never publishes here, so
--     the SELECT policy only ever authorizes the browser joining its own
--     thread's control channel (it receives nothing, since nothing else
--     publishes there). Without the SELECT policy the join is denied
--     ("permission to read from this Channel topic"), cancelStream's
--     awaited subscribe rejects, and the cancel publish on the next line
--     never runs - the function streams to completion despite the Stop.
--
-- For these policies to take effect on the wire, the browser must
-- subscribe with `private: true` in its channel options. Subscribing
-- with the default `private: false` produces a public broadcast room
-- whose name we treat as unguessable but which is not formally
-- authorized; the documented client path uses private channels.

-- Helper that extracts the thread uuid from a topic of shape
-- 'thread:<uuid>:<suffix>'. Returns null when the topic does not match,
-- so policies that compare against threads.id silently exclude rows for
-- non-streaming topics rather than throwing. Pure text manipulation, no
-- DB read - immutable for planner caching.
create or replace function public.realtime_topic_thread_id(p_topic text)
returns uuid
language sql immutable
as $$
  select case
    when p_topic ~ '^thread:[0-9a-f-]{36}:(stream|control)$'
      then substring(p_topic from 8 for 36)::uuid
    else null
  end;
$$;

-- Subscribers to the stream channel must own the thread the topic
-- references. Anonymous users have no thread ownership and so are
-- excluded; service_role bypasses RLS unconditionally and is what the
-- function publishes under.
drop policy if exists "streaming channel: owner subscribe" on realtime.messages;
create policy "streaming channel: owner subscribe" on realtime.messages
  for select to authenticated
  using (
    realtime.topic() like 'thread:%:stream'
    and exists (
      select 1 from public.threads t
        where t.id = public.realtime_topic_thread_id(realtime.topic())
          and t.user_id = (select auth.uid())
    )
  );

-- Publishers to the control channel must own the thread. The browser
-- emits exactly one event shape today ('{"type":"cancel"}'); future
-- additions ride the same authorization gate. service_role is what the
-- function subscribes under and bypasses this check.
drop policy if exists "control channel: owner publish" on realtime.messages;
create policy "control channel: owner publish" on realtime.messages
  for insert to authenticated
  with check (
    realtime.topic() like 'thread:%:control'
    and exists (
      select 1 from public.threads t
        where t.id = public.realtime_topic_thread_id(realtime.topic())
          and t.user_id = (select auth.uid())
    )
  );

-- Subscribers to the control channel must own the thread. The browser
-- never wants to RECEIVE here (the function is the only reader, under
-- service_role), but Supabase requires a channel to be joined before a
-- broadcast can be published over the socket, and the join is gated by a
-- SELECT check. Without this policy the browser's cancelStream() join is
-- denied ("permission to read from this Channel topic"), and the cancel
-- publish on the next line never fires - the Stop button looks like it
-- worked locally while the edge function keeps generating to completion.
-- Mirror of the stream channel's owner-subscribe gate, scoped to control.
drop policy if exists "control channel: owner subscribe" on realtime.messages;
create policy "control channel: owner subscribe" on realtime.messages
  for select to authenticated
  using (
    realtime.topic() like 'thread:%:control'
    and exists (
      select 1 from public.threads t
        where t.id = public.realtime_topic_thread_id(realtime.topic())
          and t.user_id = (select auth.uid())
    )
  );

-- Per-user log channel. Background work that runs in the venice edge
-- function (reflection, and the other agent fleets as they migrate) has
-- no Web Worker postMessage path back to the browser Logs drawer, so it
-- publishes structured log entries to a 'logs:<user-uuid>' Broadcast
-- topic instead. The topic name carries the owner's id directly, so the
-- subscribe gate is a literal equality - no threads join needed. The
-- function publishes under service_role (bypasses this policy); the
-- browser only ever subscribes (never publishes), so there is no
-- matching INSERT policy. Browser must subscribe with private:true for
-- this to engage.
drop policy if exists "log channel: owner subscribe" on realtime.messages;
create policy "log channel: owner subscribe" on realtime.messages
  for select to authenticated
  using (
    realtime.topic() = 'logs:' || (select auth.uid())::text
  );

-- Same owner-subscribe shape for the agent-run progress channel: the
-- venice function publishes live step events (model rounds, tool
-- calls) for user-triggered agent runs - the Wiki librarian's
-- manual-run strip is the first consumer. Per-USER topic rather than
-- per-run so this one literal-equality policy covers every run; the
-- payload carries the runId and consumers demux client-side.
drop policy if exists "agent-run channel: owner subscribe" on realtime.messages;
create policy "agent-run channel: owner subscribe" on realtime.messages
  for select to authenticated
  using (
    realtime.topic() = 'agent-runs:' || (select auth.uid())::text
  );

-- Same owner-subscribe shape for the samskara mint-toast channel. The
-- venice function publishes a 'samskara-mint' event to 'samskaras:<uuid>'
-- when insertMint lands a fresh tier-1/tier-2 row; the browser pops the
-- mood-pill toast. This replaced a postgres_changes INSERT subscription
-- on the samskaras table: the table's fire-bookkeeping UPDATE churn made
-- it the heaviest table for realtime.list_changes to decode, so it was
-- pulled from the supabase_realtime publication (above) and the toast
-- moved to Broadcast. The function publishes under service_role (bypasses
-- this policy); the browser only subscribes, so there is no INSERT
-- policy. Browser must subscribe with private:true for this to engage.
drop policy if exists "samskara mint channel: owner subscribe" on realtime.messages;
create policy "samskara mint channel: owner subscribe" on realtime.messages
  for select to authenticated
  using (
    realtime.topic() = 'samskaras:' || (select auth.uid())::text
  );

-- ---------------------------------------------------------------------------
-- User Documents (Library)
--
-- Persistent, user-uploaded reference documents (HOA agreements, insurance
-- policies, contracts, tax docs - anything we can extract text from). UNLIKE
-- message_attachments, these never expire: the Library is long-term reference
-- material the user curates, not per-message context that ages out on a 30-day
-- sweep.
--
-- Storage shape differs from message_attachments on purpose. Attachments keep
-- the binary as base64 in a text column because they are bounded by the expiry
-- sweep; a persistent multi-MB PDF base64'd into a Postgres row would bloat
-- backups forever, so the original file lives in a private Storage bucket
-- (`documents`, defined below) and the row holds only a `storage_path` pointer
-- plus metadata and the extracted text.
--   FOLLOW-UP: message_attachments should migrate onto the same bucket so we
--   have one file-storage mechanism, not two. Tracked separately.
--
-- Search model: there is no per-document embedding. A 40-page contract is
-- useless as a single embedding, and a per-chunk embedding layer (the original
-- design) both underperformed - semantic ranking surfaced the table of
-- contents and definitions over the operative clauses - and cost a heavy
-- backfill (thousands of chunks for a multi-MB upload). The actual corpus is a
-- few dozen documents, so the model routes by document metadata (doc_list /
-- document_stat) and pinpoints with exact regex (grep_documents) plus range
-- reads (read_document_lines), the same grep-then-read loop used on a large
-- source file. See grep_documents / read_document_lines below.

create table if not exists public.documents (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  -- User-facing display name. Defaults to the original filename but the
  -- user (or the doc_update tool) can rename it.
  title text not null,
  -- The "what this is for" field. Free-form note the user/LLM writes to
  -- explain the document's purpose ("my 2024 Aetna policy", "the HOA CC&Rs").
  -- Searchable context that helps the model decide whether a doc is relevant.
  description text not null default '',
  -- Original upload metadata, preserved verbatim.
  filename text not null,
  mime_type text not null,
  size_bytes bigint not null,
  -- Object key inside the `documents` Storage bucket. Convention:
  -- `<user_id>/<document_id>/<filename>`. NULL only transiently between the
  -- row insert and the binary upload completing.
  storage_path text,
  -- Venice text-parser output. Survives independent of the binary; this is
  -- what grep_documents / read_document_lines operate on. NULL until
  -- extraction finishes.
  extracted_text text,
  -- pending: uploaded, extraction not yet done. done: text extracted.
  -- failed: extraction errored (parser rejected the file, etc.) - the
  -- original is still downloadable, it just isn't searchable.
  extraction_status text not null default 'pending'
    check (extraction_status in ('pending', 'done', 'failed')),
  -- Trimmed parser/extraction error, surfaced in the Library UI when status
  -- is 'failed' so the user knows why a doc isn't searchable.
  extraction_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists documents_user_created_idx
  on public.documents (user_id, created_at desc);

alter table public.documents enable row level security;

drop policy if exists "documents are self-selectable" on public.documents;
create policy "documents are self-selectable" on public.documents
  for select using (auth.uid() = user_id);

drop policy if exists "documents are self-insertable" on public.documents;
create policy "documents are self-insertable" on public.documents
  for insert with check (auth.uid() = user_id);

drop policy if exists "documents are self-updatable" on public.documents;
create policy "documents are self-updatable" on public.documents
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists "documents are self-deletable" on public.documents;
create policy "documents are self-deletable" on public.documents
  for delete using (auth.uid() = user_id);

-- Legacy per-chunk embedding infrastructure, dropped. The Library originally
-- backed search with a document_chunks table + a semantic search RPC; that
-- underperformed (semantic ranking surfaced the table of contents and
-- definitions over the operative clauses) and cost a heavy per-chunk embedding
-- backfill (thousands of chunks per multi-MB upload). Search now routes on
-- document metadata and uses exact regex + range reads (grep_documents /
-- read_document_lines below). These drops clean the old objects off any project
-- that applied the earlier schema; idempotent and a no-op once gone.
drop function if exists public.search_document_chunks_by_embedding(vector, int);
drop function if exists public.claim_next_pending_document_chunk(text, int);
drop function if exists public.save_document_chunk_embedding_if_claimed(uuid, text, vector, text);
drop table if exists public.document_chunks;

-- Exact regex search over a document's extracted text, with line numbers and a
-- few lines of context around each hit - the SQL equivalent of `rg -n -C` over
-- the stored text. This is the primary document-search path: the chat model
-- uses it to find the precise clause ("late fee", "quorum", a section heading)
-- once it knows which document to look in, the same grep-then-read loop a human
-- (or a coding agent) uses on a large file.
--
-- The text is split into numbered lines on the fly (regexp_split_to_table WITH
-- ORDINALITY) so we never store a line index; ordinality restarts per document
-- via the lateral, so line numbers are per-document and line up with
-- read_document_lines below. The lines CTE is MATERIALIZED so a 5 MB document's
-- split runs once rather than once per context lookup. Matching and context all
-- happen server-side; only the matching snippets cross the wire, never the
-- whole blob.
--
-- p_document_id null means "every document the caller owns" (each hit carries
-- its own document_id + line). security invoker + the explicit user_id guard
-- keep it scoped to the caller. An invalid regex raises; the calling tool
-- rephrases that into actionable text.
-- p_user_id: b-strict escape hatch; see search_memories_by_embedding
-- for the full rationale.
drop function if exists public.grep_documents(text, uuid, boolean, int, int);
drop function if exists public.grep_documents(text, uuid, boolean, int, int, uuid);
create or replace function public.grep_documents(
  p_pattern text,
  p_document_id uuid,
  p_case_sensitive boolean,
  p_context int,
  p_max_matches int,
  p_user_id uuid default null
) returns table (
  document_id uuid,
  title text,
  line_number int,
  line_text text,
  context_before text[],
  context_after text[]
)
language sql stable security invoker as $$
  with docs as (
    select d.id as document_id, d.title, d.extracted_text
      from public.documents d
     where d.user_id = coalesce(p_user_id, auth.uid())
       and (p_document_id is null or d.id = p_document_id)
       and d.extracted_text is not null
  ),
  lines as materialized (
    select docs.document_id, docs.title,
           t.ln::int as line_number, t.line_content
      from docs
      cross join lateral
        regexp_split_to_table(docs.extracted_text, E'\n')
        with ordinality as t(line_content, ln)
  ),
  matched as (
    select document_id, title, line_number, line_content
      from lines
     where case when p_case_sensitive then line_content ~ p_pattern
                else line_content ~* p_pattern end
     order by document_id, line_number
     limit p_max_matches
  )
  select m.document_id, m.title, m.line_number, m.line_content as line_text,
         coalesce((select array_agg(l.line_content order by l.line_number)
                     from lines l
                    where l.document_id = m.document_id
                      and l.line_number between m.line_number - p_context
                                           and m.line_number - 1), array[]::text[])
           as context_before,
         coalesce((select array_agg(l.line_content order by l.line_number)
                     from lines l
                    where l.document_id = m.document_id
                      and l.line_number between m.line_number + 1
                                           and m.line_number + p_context), array[]::text[])
           as context_after
    from matched m
   order by m.document_id, m.line_number
$$;

-- Read a contiguous line range of one document's extracted text, numbered, plus
-- the document's total line count so the caller knows the address space. The
-- read half of the grep-then-read loop: the model feeds the line numbers
-- grep_documents returned straight in. Same per-line split as grep so the line
-- numbers agree. The calling tool clamps the span so a single read can't ship
-- the whole document. Empty result = out-of-range range or a doc the caller
-- doesn't own (RLS).
-- p_user_id: b-strict escape hatch; see search_memories_by_embedding
-- for the full rationale.
drop function if exists public.read_document_lines(uuid, int, int);
drop function if exists public.read_document_lines(uuid, int, int, uuid);
create or replace function public.read_document_lines(
  p_document_id uuid,
  p_start int,
  p_end int,
  p_user_id uuid default null
) returns table (
  line_number int,
  content text,
  total_lines int
)
language sql stable security invoker as $$
  with d as (
    select d.extracted_text
      from public.documents d
     where d.id = p_document_id
       and d.user_id = coalesce(p_user_id, auth.uid())
       and d.extracted_text is not null
  ),
  lines as materialized (
    select t.ln::int as line_number, t.line_content as content
      from d
      cross join lateral
        regexp_split_to_table(d.extracted_text, E'\n')
        with ordinality as t(line_content, ln)
  )
  select l.line_number, l.content, (select count(*)::int from lines)
    from lines l
   where l.line_number between p_start and p_end
   order by l.line_number
$$;

-- Lightweight "stat" for one document: metadata plus the total line count,
-- WITHOUT shipping the extracted text. Line count is the newline-count + 1
-- (length diff, not a row-exploding split) and agrees with the per-line split
-- the grep/read RPCs use. Powers the doc_get tool, which used to ship a
-- truncated head of the text - now doc_read owns text retrieval and doc_get is
-- the cheap overview that tells the model how many lines it can address.
drop function if exists public.document_stat(uuid);
create or replace function public.document_stat(p_document_id uuid)
returns table (
  id uuid,
  title text,
  description text,
  filename text,
  mime_type text,
  size_bytes bigint,
  extraction_status text,
  extraction_error text,
  has_text boolean,
  total_lines int,
  created_at timestamptz,
  updated_at timestamptz
)
language sql stable security invoker as $$
  select d.id, d.title, d.description, d.filename, d.mime_type, d.size_bytes,
         d.extraction_status, d.extraction_error,
         (d.extracted_text is not null and length(d.extracted_text) > 0) as has_text,
         case when d.extracted_text is null or length(d.extracted_text) = 0 then 0
              else length(d.extracted_text)
                   - length(replace(d.extracted_text, E'\n', '')) + 1 end as total_lines,
         d.created_at, d.updated_at
    from public.documents d
   where d.id = p_document_id
     and d.user_id = auth.uid()
$$;

-- Private bucket for the original uploaded files. `public = false` so objects
-- are only reachable via signed URLs or authenticated download. Insert is
-- idempotent so re-applying the schema is a no-op once the bucket exists.
insert into storage.buckets (id, name, public)
  values ('documents', 'documents', false)
  on conflict (id) do nothing;

-- Storage RLS: a user may only touch objects under their own `<user_id>/...`
-- prefix in the documents bucket. storage.foldername(name) splits the object
-- key on '/', so element [1] is the top-level folder - we require it to equal
-- the caller's uid. Mirrors the per-row user_id scoping on the tables above.
drop policy if exists "documents bucket is self-readable" on storage.objects;
create policy "documents bucket is self-readable" on storage.objects
  for select to authenticated
  using (
    bucket_id = 'documents'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

drop policy if exists "documents bucket is self-writable" on storage.objects;
create policy "documents bucket is self-writable" on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'documents'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

drop policy if exists "documents bucket is self-deletable" on storage.objects;
create policy "documents bucket is self-deletable" on storage.objects
  for delete to authenticated
  using (
    bucket_id = 'documents'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

-- ---------------------------------------------------------------------------
-- Scheduled embedding backfill (pg_cron -> pg_net -> venice/backfill)
--
-- Replaces the browser embeddings worker: a cron tick POSTs to the venice edge
-- function's /backfill route, which drains pending embeddings server-side
-- across every member. See docs/dev/in-progress/venice-edge-functions/embeddings.md.
--
-- Auth + endpoint custody live in two Vault secrets the owner seeds once via
-- `mise run supabase-init`:
--   project_url       - e.g. https://<ref>.supabase.co
--   service_role_key  - the LEGACY JWT service-role key. The modern opaque
--                       sb_secret_ key is NOT a JWT, and the function gateway
--                       rejects a non-JWT bearer (the same reason the local
--                       realtime stack rejects sb_publishable_). The /backfill
--                       handler also requires the bearer to equal its injected
--                       SUPABASE_SERVICE_ROLE_KEY, so an ordinary signed-in user
--                       can't trigger a cross-member sweep.
-- Until both secrets exist the trigger no-ops - backfill simply does not run on
-- an unseeded project, it never errors.
-- ---------------------------------------------------------------------------

-- Dynamic SQL throughout so this function compiles on a database that lacks
-- pg_net / supabase_vault (the local dev stack). It no-ops cleanly there; only
-- hosted Supabase, where the extensions and seeded secrets exist, dispatches.
create or replace function public.nak_trigger_embed_backfill()
returns void
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_url text;
  v_key text;
begin
  begin
    execute $q$ select decrypted_secret from vault.decrypted_secrets where name = 'project_url' $q$ into v_url;
    execute $q$ select decrypted_secret from vault.decrypted_secrets where name = 'service_role_key' $q$ into v_key;
  exception when others then
    return;  -- vault not installed or unreadable; nothing to dispatch
  end;
  if v_url is null or v_key is null then
    return;  -- secrets not seeded yet
  end if;
  begin
    execute format(
      $q$ select net.http_post(
            url := %L,
            headers := jsonb_build_object('Content-Type', 'application/json', 'Authorization', %L),
            body := '{}'::jsonb
          ) $q$,
      v_url || '/functions/v1/venice/backfill',
      'Bearer ' || v_key
    );
  exception when others then
    raise notice 'nak_trigger_embed_backfill: dispatch failed: %', sqlerrm;
  end;
end;
$fn$;

revoke all on function public.nak_trigger_embed_backfill() from public, anon, authenticated;

-- One-time migration: null all embeddings stamped with a model other
-- than gte-small so the backfill sweep re-embeds them. Using a broad
-- condition (`embedding_model is not null and <> 'gte-small'`) rather
-- than naming the old model id means a deploy that re-applies schema
-- while the old edge function is still live also catches any rows the
-- old function re-embedded with bge-m3 during the deploy window.
-- Idempotent: once all rows carry 'gte-small', the WHERE clause
-- matches nothing on re-apply.
do $migration$
begin
  -- memories
  update public.memories
     set embedding = null,
         embedding_model = null,
         embedding_claim_holder = null,
         embedding_claim_expires = null
   where embedding_model is not null and embedding_model <> 'gte-small';

  -- recipes
  update public.recipes
     set embedding = null,
         embedding_model = null,
         embedding_claim_holder = null,
         embedding_claim_expires = null
   where embedding_model is not null and embedding_model <> 'gte-small';

  -- wiki_articles
  update public.wiki_articles
     set embedding = null,
         embedding_model = null,
         embedding_claim_holder = null,
         embedding_claim_expires = null
   where embedding_model is not null and embedding_model <> 'gte-small';

  -- wiki_records
  update public.wiki_records
     set embedding = null,
         embedding_model = null,
         embedding_claim_holder = null,
         embedding_claim_expires = null
   where embedding_model is not null and embedding_model <> 'gte-small';

  -- samskara_substrate (column is situation_embedding, not embedding)
  update public.samskara_substrate
     set situation_embedding = null,
         embedding_model = null,
         embedding_claim_holder = null,
         embedding_claim_expires = null
   where embedding_model is not null and embedding_model <> 'gte-small';

  -- followups
  update public.followups
     set embedding = null,
         embedding_model = null,
         embedding_claim_holder = null,
         embedding_claim_expires = null
   where embedding_model is not null and embedding_model <> 'gte-small';

  -- thread_chunks (created by the conversation-search feature, which
  -- deployed to prod using bge-m3 before this migration lands)
  update public.thread_chunks
     set embedding = null,
         embedding_model = null,
         embedding_claim_holder = null,
         embedding_claim_expires = null
   where embedding_model is not null and embedding_model <> 'gte-small';

exception when others then
  raise notice 'embedding migration: %', sqlerrm;
end
$migration$;

-- Enable pg_cron + pg_net and (re)schedule the backfill. Runs every minute
-- (not every 5) so the one-time re-embedding drain after the gte-small
-- model switch completes in hours rather than days. Once the queue is
-- drained, the cadence can be relaxed back to */5. Guarded on extension
-- availability so the local dev stack (which ships neither) still applies
-- schema.sql cleanly. Idempotent: re-applying schema.sql reschedules the
-- single named job rather than stacking duplicates.
do $cron$
begin
  if exists (select 1 from pg_available_extensions where name = 'pg_cron')
     and exists (select 1 from pg_available_extensions where name = 'pg_net') then
    create extension if not exists pg_cron;
    create extension if not exists pg_net;
    if exists (select 1 from cron.job where jobname = 'nak-embed-backfill') then
      perform cron.unschedule('nak-embed-backfill');
    end if;
    perform cron.schedule(
      'nak-embed-backfill',
      '* * * * *',
      $job$ select public.nak_trigger_embed_backfill(); $job$
    );
  end if;
exception when others then
  raise notice 'embedding backfill cron setup skipped: %', sqlerrm;
end
$cron$;

-- ---------------------------------------------------------------------------
-- Scheduled wiki sweep (pg_cron -> pg_net -> venice/wiki-sweep)
--
-- Drives the server-side autonomous wiki agent. Replaces the browser
-- wiki Web Worker: a cron tick POSTs to the venice function's
-- /wiki-sweep route, which claims day-gate-eligible threads across
-- every member (claim_next_thread_for_wiki above) and runs the wiki
-- agent's tool loop on each, bounded per invocation. Same Vault-secret
-- custody and no-op-until-seeded behavior as the embed backfill
-- trigger above.
--
-- Hourly, not every-5-minutes: wiki eligibility only changes when a
-- user's local calendar day rolls over (plus the rare content-filter
-- recovery re-entry), and each processed thread is an LLM tool-loop,
-- so a tighter cadence would mostly buy empty claims. The per-tick
-- bound lives in the function handler; the schedule resumes a long
-- drain across ticks.
-- ---------------------------------------------------------------------------

create or replace function public.nak_trigger_wiki_sweep()
returns void
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_url text;
  v_key text;
begin
  begin
    execute $q$ select decrypted_secret from vault.decrypted_secrets where name = 'project_url' $q$ into v_url;
    execute $q$ select decrypted_secret from vault.decrypted_secrets where name = 'service_role_key' $q$ into v_key;
  exception when others then
    return;  -- vault not installed or unreadable; nothing to dispatch
  end;
  if v_url is null or v_key is null then
    return;  -- secrets not seeded yet
  end if;
  begin
    execute format(
      $q$ select net.http_post(
            url := %L,
            headers := jsonb_build_object('Content-Type', 'application/json', 'Authorization', %L),
            body := '{}'::jsonb
          ) $q$,
      v_url || '/functions/v1/venice/wiki-sweep',
      'Bearer ' || v_key
    );
  exception when others then
    raise notice 'nak_trigger_wiki_sweep: dispatch failed: %', sqlerrm;
  end;
end;
$fn$;

revoke all on function public.nak_trigger_wiki_sweep() from public, anon, authenticated;

do $cron$
begin
  if exists (select 1 from pg_available_extensions where name = 'pg_cron')
     and exists (select 1 from pg_available_extensions where name = 'pg_net') then
    create extension if not exists pg_cron;
    create extension if not exists pg_net;
    if exists (select 1 from cron.job where jobname = 'nak-wiki-sweep') then
      perform cron.unschedule('nak-wiki-sweep');
    end if;
    -- Minute 7, offset from the embed backfill's */5 grid so the two
    -- pg_net dispatches don't stack on the same tick.
    perform cron.schedule(
      'nak-wiki-sweep',
      '7 * * * *',
      $job$ select public.nak_trigger_wiki_sweep(); $job$
    );
  end if;
exception when others then
  raise notice 'wiki sweep cron setup skipped: %', sqlerrm;
end
$cron$;

-- ---------------------------------------------------------------------------
-- Scheduled wiki-record extraction sweep
-- (pg_cron -> pg_net -> venice/wiki-records-sweep)
--
-- Drives the background record extraction agent: claims settled threads
-- whose owner has record extraction enabled and at least one article,
-- and logs discrete events as dated records. Same Vault-secret custody
-- and no-op-until-seeded behavior as the wiki sweep above. Minute 17,
-- offset from the wiki sweep (minute 7) and the librarian (minute 37) so
-- the three pg_net dispatches don't stack on one tick.
-- ---------------------------------------------------------------------------

create or replace function public.nak_trigger_wiki_records_sweep()
returns void
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_url text;
  v_key text;
begin
  begin
    execute $q$ select decrypted_secret from vault.decrypted_secrets where name = 'project_url' $q$ into v_url;
    execute $q$ select decrypted_secret from vault.decrypted_secrets where name = 'service_role_key' $q$ into v_key;
  exception when others then
    return;  -- vault not installed or unreadable; nothing to dispatch
  end;
  if v_url is null or v_key is null then
    return;  -- secrets not seeded yet
  end if;
  begin
    execute format(
      $q$ select net.http_post(
            url := %L,
            headers := jsonb_build_object('Content-Type', 'application/json', 'Authorization', %L),
            body := '{}'::jsonb
          ) $q$,
      v_url || '/functions/v1/venice/wiki-records-sweep',
      'Bearer ' || v_key
    );
  exception when others then
    raise notice 'nak_trigger_wiki_records_sweep: dispatch failed: %', sqlerrm;
  end;
end;
$fn$;

revoke all on function public.nak_trigger_wiki_records_sweep() from public, anon, authenticated;

do $cron$
begin
  if exists (select 1 from pg_available_extensions where name = 'pg_cron')
     and exists (select 1 from pg_available_extensions where name = 'pg_net') then
    create extension if not exists pg_cron;
    create extension if not exists pg_net;
    if exists (select 1 from cron.job where jobname = 'nak-wiki-records-sweep') then
      perform cron.unschedule('nak-wiki-records-sweep');
    end if;
    perform cron.schedule(
      'nak-wiki-records-sweep',
      '17 * * * *',
      $job$ select public.nak_trigger_wiki_records_sweep(); $job$
    );
  end if;
exception when others then
  raise notice 'wiki records sweep cron setup skipped: %', sqlerrm;
end
$cron$;

-- ---------------------------------------------------------------------------
-- Scheduled wiki-librarian sweep (pg_cron -> pg_net -> venice/wiki-librarian-sweep)
--
-- Drives the scheduled half of the server-side wiki librarian. The
-- route claims the most-overdue eligible user
-- (claim_next_user_for_wiki_librarian; the 12h minimum interval is
-- enforced by that claim, not by this schedule) and runs the
-- librarian's review for them. Hourly tick, one user per tick: the
-- claim's interval gate makes a tighter schedule pointless, and a
-- librarian run is the heaviest agent cycle in the system. Same
-- Vault-secret custody and no-op-until-seeded behavior as the embed
-- backfill trigger above.
-- ---------------------------------------------------------------------------

create or replace function public.nak_trigger_wiki_librarian_sweep()
returns void
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_url text;
  v_key text;
begin
  begin
    execute $q$ select decrypted_secret from vault.decrypted_secrets where name = 'project_url' $q$ into v_url;
    execute $q$ select decrypted_secret from vault.decrypted_secrets where name = 'service_role_key' $q$ into v_key;
  exception when others then
    return;  -- vault not installed or unreadable; nothing to dispatch
  end;
  if v_url is null or v_key is null then
    return;  -- secrets not seeded yet
  end if;
  begin
    execute format(
      $q$ select net.http_post(
            url := %L,
            headers := jsonb_build_object('Content-Type', 'application/json', 'Authorization', %L),
            body := '{}'::jsonb
          ) $q$,
      v_url || '/functions/v1/venice/wiki-librarian-sweep',
      'Bearer ' || v_key
    );
  exception when others then
    raise notice 'nak_trigger_wiki_librarian_sweep: dispatch failed: %', sqlerrm;
  end;
end;
$fn$;

revoke all on function public.nak_trigger_wiki_librarian_sweep() from public, anon, authenticated;

do $cron$
begin
  if exists (select 1 from pg_available_extensions where name = 'pg_cron')
     and exists (select 1 from pg_available_extensions where name = 'pg_net') then
    create extension if not exists pg_cron;
    create extension if not exists pg_net;
    if exists (select 1 from cron.job where jobname = 'nak-wiki-librarian-sweep') then
      perform cron.unschedule('nak-wiki-librarian-sweep');
    end if;
    -- Minute 37: offset from the wiki sweep's minute 7 and the embed
    -- backfill's */5 grid so the heavy agent dispatches never share a
    -- tick.
    perform cron.schedule(
      'nak-wiki-librarian-sweep',
      '37 * * * *',
      $job$ select public.nak_trigger_wiki_librarian_sweep(); $job$
    );
  end if;
exception when others then
  raise notice 'wiki librarian sweep cron setup skipped: %', sqlerrm;
end
$cron$;

-- ---------------------------------------------------------------------------
-- Scheduled memory-librarian sweeps (pg_cron -> pg_net -> venice function)
--
-- Drives the scheduled halves of the two server-side memory
-- librarians. Each route claims the most-overdue eligible user
-- (claim_next_user_for_rem / claim_next_user_for_deep_sleep; the 12h
-- minimum interval is enforced by those claims, not by these
-- schedules) and runs that pass for them. Hourly tick, one user per
-- tick, two separate jobs so the passes keep independent cadences.
-- Same Vault-secret custody and no-op-until-seeded behavior as the
-- embed backfill trigger above.
-- ---------------------------------------------------------------------------

create or replace function public.nak_trigger_rem_sweep()
returns void
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_url text;
  v_key text;
begin
  begin
    execute $q$ select decrypted_secret from vault.decrypted_secrets where name = 'project_url' $q$ into v_url;
    execute $q$ select decrypted_secret from vault.decrypted_secrets where name = 'service_role_key' $q$ into v_key;
  exception when others then
    return;  -- vault not installed or unreadable; nothing to dispatch
  end;
  if v_url is null or v_key is null then
    return;  -- secrets not seeded yet
  end if;
  begin
    execute format(
      $q$ select net.http_post(
            url := %L,
            headers := jsonb_build_object('Content-Type', 'application/json', 'Authorization', %L),
            body := '{}'::jsonb
          ) $q$,
      v_url || '/functions/v1/venice/rem-sweep',
      'Bearer ' || v_key
    );
  exception when others then
    raise notice 'nak_trigger_rem_sweep: dispatch failed: %', sqlerrm;
  end;
end;
$fn$;

revoke all on function public.nak_trigger_rem_sweep() from public, anon, authenticated;

do $cron$
begin
  if exists (select 1 from pg_available_extensions where name = 'pg_cron')
     and exists (select 1 from pg_available_extensions where name = 'pg_net') then
    create extension if not exists pg_cron;
    create extension if not exists pg_net;
    if exists (select 1 from cron.job where jobname = 'nak-rem-sweep') then
      perform cron.unschedule('nak-rem-sweep');
    end if;
    -- Minute 17: offset from the embed backfill's */5 grid, the wiki
    -- sweep's minute 7, the wiki librarian's minute 37, and the
    -- deep-sleep sweep's minute 47, so the heavy agent dispatches
    -- never share a tick.
    perform cron.schedule(
      'nak-rem-sweep',
      '17 * * * *',
      $job$ select public.nak_trigger_rem_sweep(); $job$
    );
  end if;
exception when others then
  raise notice 'rem sweep cron setup skipped: %', sqlerrm;
end
$cron$;

create or replace function public.nak_trigger_deep_sleep_sweep()
returns void
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_url text;
  v_key text;
begin
  begin
    execute $q$ select decrypted_secret from vault.decrypted_secrets where name = 'project_url' $q$ into v_url;
    execute $q$ select decrypted_secret from vault.decrypted_secrets where name = 'service_role_key' $q$ into v_key;
  exception when others then
    return;  -- vault not installed or unreadable; nothing to dispatch
  end;
  if v_url is null or v_key is null then
    return;  -- secrets not seeded yet
  end if;
  begin
    execute format(
      $q$ select net.http_post(
            url := %L,
            headers := jsonb_build_object('Content-Type', 'application/json', 'Authorization', %L),
            body := '{}'::jsonb
          ) $q$,
      v_url || '/functions/v1/venice/deep-sleep-sweep',
      'Bearer ' || v_key
    );
  exception when others then
    raise notice 'nak_trigger_deep_sleep_sweep: dispatch failed: %', sqlerrm;
  end;
end;
$fn$;

revoke all on function public.nak_trigger_deep_sleep_sweep() from public, anon, authenticated;

do $cron$
begin
  if exists (select 1 from pg_available_extensions where name = 'pg_cron')
     and exists (select 1 from pg_available_extensions where name = 'pg_net') then
    create extension if not exists pg_cron;
    create extension if not exists pg_net;
    if exists (select 1 from cron.job where jobname = 'nak-deep-sleep-sweep') then
      perform cron.unschedule('nak-deep-sleep-sweep');
    end if;
    -- Minute 47: see the rem sweep's minute-17 comment for the
    -- spacing scheme.
    perform cron.schedule(
      'nak-deep-sleep-sweep',
      '47 * * * *',
      $job$ select public.nak_trigger_deep_sleep_sweep(); $job$
    );
  end if;
exception when others then
  raise notice 'deep-sleep sweep cron setup skipped: %', sqlerrm;
end
$cron$;

-- ---------------------------------------------------------------------------
-- Scheduled reflection sweep (pg_cron -> pg_net -> venice function)
--
-- Reflection's ONLY driver. Each hourly tick drains the day-gated
-- queue one thread at a time (claimed across all users by
-- claim_next_thread_for_reflection_sweep) until it runs empty or the
-- tick's cap/time budget stops it; the next tick resumes. Memory
-- formation deliberately does not ride the chat turn's tail - the
-- fixed cadence gives the user a predictable window to edit or retry
-- a settled conversation before reflection reads it. Same
-- Vault-secret custody and no-op-until-seeded behavior as the other
-- sweep triggers above.
-- ---------------------------------------------------------------------------

create or replace function public.nak_trigger_reflection_sweep()
returns void
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_url text;
  v_key text;
begin
  begin
    execute $q$ select decrypted_secret from vault.decrypted_secrets where name = 'project_url' $q$ into v_url;
    execute $q$ select decrypted_secret from vault.decrypted_secrets where name = 'service_role_key' $q$ into v_key;
  exception when others then
    return;  -- vault not installed or unreadable; nothing to dispatch
  end;
  if v_url is null or v_key is null then
    return;  -- secrets not seeded yet
  end if;
  begin
    execute format(
      $q$ select net.http_post(
            url := %L,
            headers := jsonb_build_object('Content-Type', 'application/json', 'Authorization', %L),
            body := '{}'::jsonb
          ) $q$,
      v_url || '/functions/v1/venice/reflection-sweep',
      'Bearer ' || v_key
    );
  exception when others then
    raise notice 'nak_trigger_reflection_sweep: dispatch failed: %', sqlerrm;
  end;
end;
$fn$;

revoke all on function public.nak_trigger_reflection_sweep() from public, anon, authenticated;

do $cron$
begin
  if exists (select 1 from pg_available_extensions where name = 'pg_cron')
     and exists (select 1 from pg_available_extensions where name = 'pg_net') then
    create extension if not exists pg_cron;
    create extension if not exists pg_net;
    if exists (select 1 from cron.job where jobname = 'nak-reflection-sweep') then
      perform cron.unschedule('nak-reflection-sweep');
    end if;
    -- Minute 27: see the rem sweep's minute-17 comment for the
    -- spacing scheme (embed */5, wiki 7, rem 17, librarian 37,
    -- deep-sleep 47).
    perform cron.schedule(
      'nak-reflection-sweep',
      '27 * * * *',
      $job$ select public.nak_trigger_reflection_sweep(); $job$
    );
  end if;
exception when others then
  raise notice 'reflection sweep cron setup skipped: %', sqlerrm;
end
$cron$;

-- Read-only "is there work?" gate for the evaluation sweep. Mirrors the
-- candidate predicate of claim_next_thread_for_evaluation_sweep exactly,
-- minus the `for update skip locked` lease and the claim mutation, so the
-- frequent (*/10) trigger fn can skip the edge POST entirely on idle
-- ticks. KEEP THIS PREDICATE IN SYNC with that claim's candidate CTE: a
-- mismatch that is too strict here silently strands a thread for a tick
-- (or forever, if permanently false-negative); too loose just costs an
-- occasional POST-then-no-thread, which is harmless.
drop function if exists public.samskara_evaluable_exists();
create or replace function public.samskara_evaluable_exists()
returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1
      from public.threads t
      inner join public.profiles p on p.user_id = t.user_id
      cross join lateral (
        select public.nak_safe_timezone(p.settings->>'displayTimezone') as tz
      ) usertz
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
         order by m.position desc
         limit 1
      ) term
      cross join lateral (
        -- Wall-clock on purpose, not transcript order: this asks "when
        -- did the thread last see a write" for the day-gate, and a
        -- recovery row healed today counts as today's activity even
        -- though its position is mid-transcript.
        select m2.created_at
          from public.messages m2
         where m2.thread_id = t.id
         order by m2.created_at desc
         limit 1
      ) newest
     where not t.hidden -- deleted-awaiting-GC; see the reflection sweep
       and term.msg_id is distinct from t.last_evaluated_msg_id
       and (term.msg_id is distinct from t.evaluation_attempt_msg_id
            or t.evaluation_attempt_count < 3)
       and (t.evaluation_claim_expires_at is null
            or t.evaluation_claim_expires_at < now())
       and (newest.created_at at time zone usertz.tz)::date
             < (now() at time zone usertz.tz)::date
       and (
         select count(*)
           from public.messages m3
          where m3.thread_id = t.id
            and m3.role = 'user'
       ) >= 2
  );
$$;
revoke all on function public.samskara_evaluable_exists() from public, anon, authenticated;
grant execute on function public.samskara_evaluable_exists() to service_role;

-- Samskara evaluation sweep dispatcher. Reads the Vault project_url +
-- service_role_key and POSTs the cron-only edge route, which runs the
-- next-day retrospective judge (relevance-gated samskara health). Gated:
-- it fast-exits via samskara_evaluable_exists() so the */10 cron only
-- spins up the edge function when a thread is actually claimable. Silent
-- no-op when Vault is unseeded, same as every other trigger fn.
create or replace function public.nak_trigger_samskara_evaluation_sweep()
returns void
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_url text;
  v_key text;
begin
  -- Fast-exit: only spin up the edge function when there is actually a
  -- thread to judge. The */10 cadence is cheap because an idle tick stops
  -- right here at one SQL EXISTS - no edge POST, no log line, no Venice.
  if not public.samskara_evaluable_exists() then
    return;
  end if;
  begin
    execute $q$ select decrypted_secret from vault.decrypted_secrets where name = 'project_url' $q$ into v_url;
    execute $q$ select decrypted_secret from vault.decrypted_secrets where name = 'service_role_key' $q$ into v_key;
  exception when others then
    return;  -- vault not installed or unreadable; nothing to dispatch
  end;
  if v_url is null or v_key is null then
    return;  -- secrets not seeded yet
  end if;
  begin
    execute format(
      $q$ select net.http_post(
            url := %L,
            headers := jsonb_build_object('Content-Type', 'application/json', 'Authorization', %L),
            body := '{}'::jsonb
          ) $q$,
      v_url || '/functions/v1/venice/samskara-evaluation-sweep',
      'Bearer ' || v_key
    );
  exception when others then
    raise notice 'nak_trigger_samskara_evaluation_sweep: dispatch failed: %', sqlerrm;
  end;
end;
$fn$;

revoke all on function public.nak_trigger_samskara_evaluation_sweep() from public, anon, authenticated;

do $cron$
begin
  if exists (select 1 from pg_available_extensions where name = 'pg_cron')
     and exists (select 1 from pg_available_extensions where name = 'pg_net') then
    create extension if not exists pg_cron;
    create extension if not exists pg_net;
    if exists (select 1 from cron.job where jobname = 'nak-samskara-evaluation-sweep') then
      perform cron.unschedule('nak-samskara-evaluation-sweep');
    end if;
    -- Every 10 minutes, NOT a fixed-minute slot: the trigger fn gates on
    -- samskara_evaluable_exists() and only POSTs the edge route when a
    -- thread is actually claimable, so idle ticks are just a cheap SQL
    -- EXISTS in pg_cron (no edge POST, no log noise, no Venice). Frequent
    -- polling keeps the one-thread-per-run judge draining the initial
    -- backlog in ~days instead of ~weeks; steady-state new threads get
    -- judged within ~10 min of becoming eligible.
    perform cron.schedule(
      'nak-samskara-evaluation-sweep',
      '*/10 * * * *',
      $job$ select public.nak_trigger_samskara_evaluation_sweep(); $job$
    );
  end if;
exception when others then
  raise notice 'samskara evaluation sweep cron setup skipped: %', sqlerrm;
end
$cron$;

-- ---------------------------------------------------------------------------
-- Scheduled curation sweep (pg_cron -> pg_net -> venice/curation-sweep)
--
-- Hourly catch-up drain for the five curation queues the venice
-- function's chat-turn tail also services: auto-title, thread topics,
-- thread summaries, memory topics, recipe topics. The tail only fires
-- when its owner converses, so the sweep is what drains work created
-- server-side (rem / deep-sleep consolidations re-queue memory tags;
-- recipe tools re-queue recipe tags) or left behind by a failed tail
-- attempt. Same Vault secrets and dispatch shape as the reflection
-- sweep above.
-- ---------------------------------------------------------------------------

create or replace function public.nak_trigger_curation_sweep()
returns void
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_url text;
  v_key text;
begin
  begin
    execute $q$ select decrypted_secret from vault.decrypted_secrets where name = 'project_url' $q$ into v_url;
    execute $q$ select decrypted_secret from vault.decrypted_secrets where name = 'service_role_key' $q$ into v_key;
  exception when others then
    return;  -- vault not installed or unreadable; nothing to dispatch
  end;
  if v_url is null or v_key is null then
    return;  -- secrets not seeded yet
  end if;
  begin
    execute format(
      $q$ select net.http_post(
            url := %L,
            headers := jsonb_build_object('Content-Type', 'application/json', 'Authorization', %L),
            body := '{}'::jsonb
          ) $q$,
      v_url || '/functions/v1/venice/curation-sweep',
      'Bearer ' || v_key
    );
  exception when others then
    raise notice 'nak_trigger_curation_sweep: dispatch failed: %', sqlerrm;
  end;
end;
$fn$;

revoke all on function public.nak_trigger_curation_sweep() from public, anon, authenticated;

do $cron$
begin
  if exists (select 1 from pg_available_extensions where name = 'pg_cron')
     and exists (select 1 from pg_available_extensions where name = 'pg_net') then
    create extension if not exists pg_cron;
    create extension if not exists pg_net;
    if exists (select 1 from cron.job where jobname = 'nak-curation-sweep') then
      perform cron.unschedule('nak-curation-sweep');
    end if;
    -- Minute 57: the last free slot in the hourly spacing scheme
    -- (embed */5, wiki 7, rem 17, reflection 27, librarian 37,
    -- deep-sleep 47). Deliberately after rem (:17) and deep-sleep
    -- (:47) so the tag queues their consolidations re-arm drain
    -- within the same hour.
    perform cron.schedule(
      'nak-curation-sweep',
      '57 * * * *',
      $job$ select public.nak_trigger_curation_sweep(); $job$
    );
  end if;
exception when others then
  raise notice 'curation sweep cron setup skipped: %', sqlerrm;
end
$cron$;

-- ---------------------------------------------------------------------------
-- Scheduled bias sweep (pg_cron -> pg_net -> venice/bias-sweep)
--
-- Hourly drain for the bias pipeline: analyze (claim settled threads
-- via bias_claim_next_thread_for_sweep, run the observer/reactor
-- agent, save observations + reactions) then aggregate (recompute
-- bias_summary for the users touched this tick plus any user whose
-- cache has aged past the daily freshness floor). Cron is the ONLY
-- driver - there is no chat-turn tail, because analyze eligibility
-- requires the thread's last update to fall on a prior calendar day
-- in its owner's timezone, so the thread a turn just touched is
-- never eligible at turn time. Same Vault secrets and dispatch shape
-- as the reflection sweep above.
-- ---------------------------------------------------------------------------

create or replace function public.nak_trigger_bias_sweep()
returns void
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_url text;
  v_key text;
begin
  begin
    execute $q$ select decrypted_secret from vault.decrypted_secrets where name = 'project_url' $q$ into v_url;
    execute $q$ select decrypted_secret from vault.decrypted_secrets where name = 'service_role_key' $q$ into v_key;
  exception when others then
    return;  -- vault not installed or unreadable; nothing to dispatch
  end;
  if v_url is null or v_key is null then
    return;  -- secrets not seeded yet
  end if;
  begin
    execute format(
      $q$ select net.http_post(
            url := %L,
            headers := jsonb_build_object('Content-Type', 'application/json', 'Authorization', %L),
            body := '{}'::jsonb
          ) $q$,
      v_url || '/functions/v1/venice/bias-sweep',
      'Bearer ' || v_key
    );
  exception when others then
    raise notice 'nak_trigger_bias_sweep: dispatch failed: %', sqlerrm;
  end;
end;
$fn$;

revoke all on function public.nak_trigger_bias_sweep() from public, anon, authenticated;

do $cron$
begin
  if exists (select 1 from pg_available_extensions where name = 'pg_cron')
     and exists (select 1 from pg_available_extensions where name = 'pg_net') then
    create extension if not exists pg_cron;
    create extension if not exists pg_net;
    if exists (select 1 from cron.job where jobname = 'nak-bias-sweep') then
      perform cron.unschedule('nak-bias-sweep');
    end if;
    -- Minute 3: the x7 ladder (:07 wiki, :17 rem, :27 reflection,
    -- :37 librarian, :47 deep-sleep, :57 curation) is full, so the
    -- bias sweep starts a new column clear of the */5 embed ticks
    -- and the :13 samskara reaper.
    perform cron.schedule(
      'nak-bias-sweep',
      '3 * * * *',
      $job$ select public.nak_trigger_bias_sweep(); $job$
    );
  end if;
exception when others then
  raise notice 'bias sweep cron setup skipped: %', sqlerrm;
end
$cron$;

-- Hourly samskara formation sweep: the catch-up driver behind the
-- chat-turn tail (and the ONLY driver for mint-tier2, dedup, and
-- compound-regen). Same vault -> pg_net dispatch shape as the other
-- sweep triggers.
create or replace function public.nak_trigger_samskara_sweep()
returns void
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_url text;
  v_key text;
begin
  begin
    execute $q$ select decrypted_secret from vault.decrypted_secrets where name = 'project_url' $q$ into v_url;
    execute $q$ select decrypted_secret from vault.decrypted_secrets where name = 'service_role_key' $q$ into v_key;
  exception when others then
    return;  -- vault not installed or unreadable; nothing to dispatch
  end;
  if v_url is null or v_key is null then
    return;  -- secrets not seeded yet
  end if;
  begin
    execute format(
      $q$ select net.http_post(
            url := %L,
            headers := jsonb_build_object('Content-Type', 'application/json', 'Authorization', %L),
            body := '{}'::jsonb
          ) $q$,
      v_url || '/functions/v1/venice/samskara-sweep',
      'Bearer ' || v_key
    );
  exception when others then
    raise notice 'nak_trigger_samskara_sweep: dispatch failed: %', sqlerrm;
  end;
end;
$fn$;

revoke all on function public.nak_trigger_samskara_sweep() from public, anon, authenticated;

do $cron$
begin
  if exists (select 1 from pg_available_extensions where name = 'pg_cron')
     and exists (select 1 from pg_available_extensions where name = 'pg_net') then
    create extension if not exists pg_cron;
    create extension if not exists pg_net;
    if exists (select 1 from cron.job where jobname = 'nak-samskara-sweep') then
      perform cron.unschedule('nak-samskara-sweep');
    end if;
    -- Minute 23: the x3 column after bias's :03 and the :13/:43
    -- decay pair, clear of the x7 ladder and the */5 embed ticks.
    perform cron.schedule(
      'nak-samskara-sweep',
      '23 * * * *',
      $job$ select public.nak_trigger_samskara_sweep(); $job$
    );
  end if;
exception when others then
  raise notice 'samskara sweep cron setup skipped: %', sqlerrm;
end
$cron$;

-- ---------------------------------------------------------------------------
-- Scheduled stream-claim janitor (pg_cron -> SQL)
--
-- Every minute, call nak_sweep_stale_streams() to terminate threads whose
-- streaming claim has been expired more than 60s without being released
-- by the function's own terminal path. Catches function deaths the
-- /stream reconnect probe misses - the probe only runs on user-driven
-- /stream calls and only inspects the message row's status, so a
-- function death on a tool-call round (which leaves a thread orphan-
-- claimed with no streaming-status message row) sits stuck until this
-- sweep catches it.
--
-- Pure SQL (no pg_net): the sweep only touches the threads table, so
-- there's no network call to make. Gated on pg_cron availability the
-- same way as embed-backfill above; the outer handler swallows the
-- "shared_preload_libraries" failure so a local image without pg_cron
-- still applies schema.sql cleanly.
do $cron$
begin
  if exists (select 1 from pg_available_extensions where name = 'pg_cron') then
    create extension if not exists pg_cron;
    if exists (select 1 from cron.job where jobname = 'nak-stream-janitor') then
      perform cron.unschedule('nak-stream-janitor');
    end if;
    perform cron.schedule(
      'nak-stream-janitor',
      '* * * * *',
      $job$ select public.nak_sweep_stale_streams(); $job$
    );
  end if;
exception when others then
  raise notice 'stream-janitor cron setup skipped: %', sqlerrm;
end
$cron$;

-- ---------------------------------------------------------------------------
-- Scheduled samskara decay (pg_cron -> SQL)
--
-- Wall-clock samskara decay is RETIRED. Health is now a derived,
-- relevance-gated posterior maintained by the evaluation sweep
-- (samskara_apply_evaluation, driven by nak-samskara-evaluation-sweep);
-- a wall-clock pass would fight it over the same column. The old
-- nak-samskara-decay job is unscheduled idempotently on every apply,
-- and the samskara_decay_sweep function itself is dropped above.
--
-- The freed minute-13 slot now drives the REAPERS: pure-SQL passes (no
-- pg_net, same shape the old decay used). samskara_expire_junk_thread_fires
-- runs FIRST so the guards in the two reapers see its terminal verdicts
-- in the same tick: it clears the permanently-unjudgeable fires on
-- abandoned one-round threads that would otherwise read as "test in
-- flight" and shield their samskaras from every release path.
-- samskara_reap_dead deletes repeatedly-contradicted, long-quiet
-- samskaras; samskara_reap_untested deletes never-genuinely-tested rows
-- past the 45-day probation window (the one-off-lookup mints that would
-- otherwise hold tier-1 slots at the p0 baseline forever).
-- Tested-and-baseline rows are spared by both. Was :13/:43; one pass a
-- day's worth of cadence suffices, so a single :13 tick runs all three
-- in one statement.
do $cron$
begin
  if exists (select 1 from pg_available_extensions where name = 'pg_cron') then
    create extension if not exists pg_cron;
    if exists (select 1 from cron.job where jobname = 'nak-samskara-decay') then
      perform cron.unschedule('nak-samskara-decay');
    end if;
    if exists (select 1 from cron.job where jobname = 'nak-samskara-reap') then
      perform cron.unschedule('nak-samskara-reap');
    end if;
    perform cron.schedule(
      'nak-samskara-reap',
      '13 * * * *',
      $job$ select public.samskara_expire_junk_thread_fires(), public.samskara_reap_dead(), public.samskara_reap_untested(); $job$
    );
  end if;
exception when others then
  raise notice 'samskara reaper cron setup skipped: %', sqlerrm;
end
$cron$;

-- ---------------------------------------------------------------------------
-- Retired: scheduled attachment expiry
--
-- Attachments are no longer reclaimed on a timer. Images are compressed in
-- the browser on upload (so they land small at the source) and every
-- attachment persists until the user deletes it from the Artifacts tab.
-- The old hourly sweep (the `expire-attachments` edge function, its cron
-- dispatcher, and the batch RPCs) is gone; these statements drop it from
-- any project that ran the earlier schema. Idempotent, no-ops once gone.
--
-- The "expired" row state (null storage_path + stamped expired_at) and its
-- placeholder rendering survive - manual delete now produces it, and
-- attachment-gc below still reclaims the objects of deleted-thread rows.
do $cron$
begin
  if exists (select 1 from pg_available_extensions where name = 'pg_cron') then
    create extension if not exists pg_cron;
    if exists (select 1 from cron.job where jobname = 'nak-attachment-expiry') then
      perform cron.unschedule('nak-attachment-expiry');
    end if;
  end if;
exception when others then
  raise notice 'attachment-expiry cron teardown skipped: %', sqlerrm;
end
$cron$;
drop function if exists public.nak_trigger_attachment_expiry();
drop function if exists public.list_expirable_attachments(int, int);
drop function if exists public.mark_attachments_expired(uuid[]);

-- Orphan-object GC for the attachments bucket (pg_cron -> pg_net -> attachment-gc)
--
-- Deleting a thread cascades message_attachments rows away (thread -> messages
-- -> message_attachments, all `on delete cascade`), but SQL can't reach Storage
-- to drop the bucket OBJECTS those rows pointed at - so every deleted thread
-- leaves its attachment + generated-image objects stranded in the bucket. The
-- client's deleteThread best-effort removes them inline, but a failed remove
-- (offline, partial error) or any object predating that path stays orphaned
-- forever: nothing else reclaims them (there is no per-row dormancy sweep,
-- and an orphan has no row to drive one anyway).
--
-- This daily sweep is the backstop. It lists bucket objects with no live row
-- pointing at them and deletes the objects in the attachment-gc edge function
-- (service-role Storage client). Same Vault-secret custody + local-stack guards
-- as the recipe-image-gc cron; no-ops until the secrets are seeded.
--
-- Only reclaims objects whose row is already GONE (a deleted thread or
-- message). A manually-deleted-but-still-present attachment row has a null
-- storage_path, so its object was already removed and can't resurface here
-- as a false orphan.

-- List a bounded batch of attachments-bucket objects with no live
-- message_attachments row. p_min_age_seconds is a grace window: an in-flight
-- send uploads the object a moment before its row insert commits, so a freshly
-- created object with no row yet is not an orphan - skipping objects younger
-- than the window keeps the sweep from racing a concurrent upload. No FOR
-- UPDATE / claim: the list step mutates nothing, and object deletion is
-- idempotent (removing a gone object is a no-op), so overlapping ticks at worst
-- redo harmless work. security definer + service-role-only: cron has no user
-- session and the sweep spans every member's objects.
--
-- TWO tables claim objects in this bucket: message_attachments (the
-- originals + generated images) and message_attachment_pages (rasterized
-- PDF pages). An object is an orphan only when NEITHER points at it -
-- checking attachments alone would reclaim every page render on the next
-- tick, which is the shape of the bug this second anti-join exists to
-- prevent. Any future table that parks bytes in this bucket has to be added
-- here too.
drop function if exists public.list_orphan_attachment_objects(int, int);
create or replace function public.list_orphan_attachment_objects(
  p_min_age_seconds int,
  p_limit int
) returns table (name text)
language sql security definer
set search_path = public as $$
  select o.name
    from storage.objects o
   where o.bucket_id = 'attachments'
     and o.created_at < now() - make_interval(secs => p_min_age_seconds)
     and not exists (
       select 1 from public.message_attachments a
        where a.storage_path = o.name
     )
     and not exists (
       select 1 from public.message_attachment_pages p
        where p.storage_path = o.name
     )
   order by o.created_at asc
   limit p_limit
$$;

revoke all on function public.list_orphan_attachment_objects(int, int) from public, anon, authenticated;
grant execute on function public.list_orphan_attachment_objects(int, int) to service_role;

-- Cron dispatcher, same shape + Vault-secret custody as
-- nak_trigger_embed_backfill above. Dynamic SQL so it compiles where pg_net /
-- vault are absent (local stack); no-ops until the secrets are seeded.
create or replace function public.nak_trigger_attachment_gc()
returns void
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_url text;
  v_key text;
begin
  begin
    execute $q$ select decrypted_secret from vault.decrypted_secrets where name = 'project_url' $q$ into v_url;
    execute $q$ select decrypted_secret from vault.decrypted_secrets where name = 'service_role_key' $q$ into v_key;
  exception when others then
    return;  -- vault not installed or unreadable; nothing to dispatch
  end;
  if v_url is null or v_key is null then
    return;  -- secrets not seeded yet
  end if;
  begin
    execute format(
      $q$ select net.http_post(
            url := %L,
            headers := jsonb_build_object('Content-Type', 'application/json', 'Authorization', %L),
            body := '{}'::jsonb
          ) $q$,
      v_url || '/functions/v1/attachment-gc',
      'Bearer ' || v_key
    );
  exception when others then
    raise notice 'nak_trigger_attachment_gc: dispatch failed: %', sqlerrm;
  end;
end;
$fn$;

revoke all on function public.nak_trigger_attachment_gc() from public, anon, authenticated;

-- Schedule the sweep daily. Orphans only appear on thread deletion (rare
-- relative to dormancy expiry) and the client's inline delete handles the
-- common case, so this backstop runs once a day rather than hourly. Guarded on
-- extension availability + idempotent reschedule, same as the expiry cron.
do $cron$
begin
  if exists (select 1 from pg_available_extensions where name = 'pg_cron')
     and exists (select 1 from pg_available_extensions where name = 'pg_net') then
    create extension if not exists pg_cron;
    create extension if not exists pg_net;
    if exists (select 1 from cron.job where jobname = 'nak-attachment-gc') then
      perform cron.unschedule('nak-attachment-gc');
    end if;
    perform cron.schedule(
      'nak-attachment-gc',
      '23 4 * * *',
      $job$ select public.nak_trigger_attachment_gc(); $job$
    );
  end if;
exception when others then
  raise notice 'attachment gc cron setup skipped: %', sqlerrm;
end
$cron$;

-- Orphan-object GC for the wiki-record-files bucket. A record/article delete
-- cascades the wiki_record_files rows away (record_id on delete cascade), but
-- SQL cannot delete the Storage objects, so they linger. The client's
-- record-delete path best-effort removes them inline; this daily sweep is the
-- backstop (and the only reclaim path for objects orphaned before that path
-- existed). Same shape as list_orphan_attachment_objects: list a bounded batch
-- of bucket objects with no row, anti-joined on storage_path, with a grace
-- window so a freshly-uploaded object whose row insert hasn't committed yet is
-- not mistaken for an orphan. No FOR UPDATE / claim: object deletion is
-- idempotent. security definer + service-role-only.
drop function if exists public.list_orphan_wiki_record_file_objects(int, int);
create or replace function public.list_orphan_wiki_record_file_objects(
  p_min_age_seconds int,
  p_limit int
) returns table (name text)
language sql security definer
set search_path = public as $$
  select o.name
    from storage.objects o
   where o.bucket_id = 'wiki-record-files'
     and o.created_at < now() - make_interval(secs => p_min_age_seconds)
     and not exists (
       select 1 from public.wiki_record_files f
        where f.storage_path = o.name
     )
   order by o.created_at asc
   limit p_limit
$$;

revoke all on function public.list_orphan_wiki_record_file_objects(int, int) from public, anon, authenticated;
grant execute on function public.list_orphan_wiki_record_file_objects(int, int) to service_role;

-- Cron dispatcher, same shape + Vault-secret custody as nak_trigger_attachment_gc.
create or replace function public.nak_trigger_wiki_record_file_gc()
returns void
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_url text;
  v_key text;
begin
  begin
    execute $q$ select decrypted_secret from vault.decrypted_secrets where name = 'project_url' $q$ into v_url;
    execute $q$ select decrypted_secret from vault.decrypted_secrets where name = 'service_role_key' $q$ into v_key;
  exception when others then
    return;  -- vault not installed or unreadable; nothing to dispatch
  end;
  if v_url is null or v_key is null then
    return;  -- secrets not seeded yet
  end if;
  begin
    execute format(
      $q$ select net.http_post(
            url := %L,
            headers := jsonb_build_object('Content-Type', 'application/json', 'Authorization', %L),
            body := '{}'::jsonb
          ) $q$,
      v_url || '/functions/v1/wiki-record-file-gc',
      'Bearer ' || v_key
    );
  exception when others then
    raise notice 'nak_trigger_wiki_record_file_gc: dispatch failed: %', sqlerrm;
  end;
end;
$fn$;

revoke all on function public.nak_trigger_wiki_record_file_gc() from public, anon, authenticated;

-- Daily sweep, offset from the attachment-gc tick. Orphans appear only on
-- record/article deletion and the client removes objects inline, so once a day
-- is enough. Guarded + idempotent reschedule, same as the other GC crons.
do $cron$
begin
  if exists (select 1 from pg_available_extensions where name = 'pg_cron')
     and exists (select 1 from pg_available_extensions where name = 'pg_net') then
    create extension if not exists pg_cron;
    create extension if not exists pg_net;
    if exists (select 1 from cron.job where jobname = 'nak-wiki-record-file-gc') then
      perform cron.unschedule('nak-wiki-record-file-gc');
    end if;
    perform cron.schedule(
      'nak-wiki-record-file-gc',
      '43 4 * * *',
      $job$ select public.nak_trigger_wiki_record_file_gc(); $job$
    );
  end if;
exception when others then
  raise notice 'wiki record file gc cron setup skipped: %', sqlerrm;
end
$cron$;

-- intents ------------------------------------------------------------------
--
-- The first NORMATIVE layer in nak. Every other user-model the app
-- builds (samskara, bias_summary, memories, wiki) describes who the
-- user is; an intent is a self-authored standing GOAL the chat model
-- forms about how it wants to help the user grow ("help them notice
-- when they're seeking confirmation rather than testing a belief").
-- See docs/dev/in-progress/intents.md for the full design.
--
-- The load-bearing integrity property: an intent's "is this working?"
-- signal (its efficacy posterior) is read from descriptive-layer
-- MOVEMENT relative to a matched control, never from the model's own
-- read of how a conversation went. The two tables that could leak that
-- firewall - intent_employments (what the model did) and
-- intent_target_samples (what the descriptive layer did) - are kept
-- physically separate so the wrong wiring is obvious in review. The
-- math kernel is supabase/functions/_shared/intent-math.ts.
--
-- This is storage only. The minting sweep, the priming injection, the
-- evaluation sweep, and the settings toggle that gates them all are
-- separate milestones; until they land nothing reads or writes these
-- tables and the feature has zero observable behavior.

-- Snapshot of the intent ids that rendered into the system prompt on
-- the most recent chat turn for this thread, written by
-- applyIntentPriming. The employment-classification half of evaluation
-- (not yet built) reads it to know which intentions the user's messages
-- this turn could have been responding to - the intent analog of
-- threads.bias_active_at_turn. Default empty: no intents active.
alter table public.threads
  add column if not exists intent_active_at_turn text[] not null default '{}'::text[];

-- The unit. A small active set renders into the system prompt as
-- standing behavioral guidance; the rest stay as dormant/retired
-- history for the inspector.
create table if not exists public.intents (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  -- First-person goal the minter wrote, and why it formed it.
  statement text not null,
  rationale text,
  -- active = renders + scored; dormant = kept but not rendered (its
  -- seeding pattern went quiet); retired = tombstoned for the
  -- inspector's history, never rendered.
  status text not null default 'active'
    check (status in ('active', 'dormant', 'retired')),
  -- Descriptive-layer target binding (the C efficacy model). 'bias' ->
  -- target_ref is a bias catalog key; 'samskara' -> target_ref is a
  -- samskaras.id (as text); 'none' -> free-form, no measurable target,
  -- never gains an efficacy posterior. No FK on target_ref: a 'bias'
  -- ref is a catalog key, not a row, and a samskara ref should survive
  -- the samskara being reaped (debugging beats normalization, same as
  -- samskara_provenance). Coupling between kind/ref/direction is the
  -- minter's contract, not a DB check, to keep the table permissive.
  target_kind text not null default 'none'
    check (target_kind in ('bias', 'samskara', 'none')),
  target_ref text,
  target_direction text
    check (target_direction is null or target_direction in ('reduce', 'reinforce')),
  -- Efficacy posterior + its running evidence tallies. NULL efficacy =
  -- a free-form intent that is never scored (a non-null efficacy on a
  -- target_kind='none' row is a bug - the firewall leaked). The tallies
  -- MUST be real, not int: the recency discount in updateEfficacy
  -- multiplies them by a fraction every cycle, and an int column
  -- truncating the sub-unit result to 0 is the exact bug that once
  -- froze the samskara corpus at health 0.
  efficacy real,
  confirm_count real not null default 0,
  disconfirm_count real not null default 0,
  last_minted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- The active-set read (priming) and the per-target efficacy-sampling
-- lookup (evaluation sweep).
create index if not exists intents_user_status_idx
  on public.intents (user_id, status);
create index if not exists intents_user_target_idx
  on public.intents (user_id, target_kind, target_ref);

alter table public.intents enable row level security;

drop policy if exists "intents self-selectable" on public.intents;
create policy "intents self-selectable" on public.intents
  for select using (auth.uid() = user_id);

drop policy if exists "intents self-insertable" on public.intents;
create policy "intents self-insertable" on public.intents
  for insert with check (auth.uid() = user_id);

drop policy if exists "intents self-updatable" on public.intents;
create policy "intents self-updatable" on public.intents
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists "intents self-deletable" on public.intents;
create policy "intents self-deletable" on public.intents
  for delete using (auth.uid() = user_id);

alter table public.intents
  alter column user_id set default auth.uid();

-- Audit of what each intent was minted FROM. Direct analog of
-- samskara_provenance: no FK on ref_id (kept even if the seeding row is
-- later deleted - debugging beats normalization), and ref_id is text
-- because a 'bias' provenance points at a catalog key while the others
-- point at uuids.
create table if not exists public.intent_provenance (
  intent_id uuid not null references public.intents(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  kind text not null
    check (kind in ('samskara', 'bias', 'memory', 'wiki', 'thread')),
  ref_id text not null,
  weight real not null default 1.0,
  created_at timestamptz not null default now(),
  primary key (intent_id, kind, ref_id)
);

alter table public.intent_provenance enable row level security;

drop policy if exists "intent provenance self-selectable" on public.intent_provenance;
create policy "intent provenance self-selectable" on public.intent_provenance
  for select using (auth.uid() = user_id);

drop policy if exists "intent provenance self-insertable" on public.intent_provenance;
create policy "intent provenance self-insertable" on public.intent_provenance
  for insert with check (auth.uid() = user_id);

drop policy if exists "intent provenance self-deletable" on public.intent_provenance;
create policy "intent provenance self-deletable" on public.intent_provenance
  for delete using (auth.uid() = user_id);

alter table public.intent_provenance
  alter column user_id set default auth.uid();

-- Retrospective PROCESS telemetry: one row per (intent, settled thread)
-- where the evaluation agent judged the model acted on the intent.
-- Deliberately NEVER feeds efficacy - user_reaction is recorded as an
-- observation, not a success signal. A receptive user can be reacting
-- to a nudge that changed nothing, and a resistant one to a nudge that
-- landed; only descriptive-layer movement (intent_target_samples)
-- decides efficacy. Keeping this in its own table is what makes a
-- wrong wiring obvious in review. One row per (intent, thread),
-- replaced on re-analyze via the unique key (same contract as
-- bias_reactions).
create table if not exists public.intent_employments (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  intent_id uuid not null references public.intents(id) on delete cascade,
  thread_id uuid not null references public.threads(id) on delete cascade,
  -- did the model get an opening at all, and did it take it. The split
  -- distinguishes "no chance arose" from "chance arose, missed".
  opening boolean not null,
  acted boolean not null,
  -- three-state + null, like bias_reactions.was_confirmed. NOT an
  -- efficacy input - see the table comment.
  user_reaction text
    check (user_reaction is null
           or user_reaction in ('receptive', 'neutral', 'resistant')),
  reasoning text not null,
  created_at timestamptz not null default now(),
  unique (intent_id, thread_id)
);

create index if not exists intent_employments_intent_idx
  on public.intent_employments (intent_id);

alter table public.intent_employments enable row level security;

drop policy if exists "intent employments self-selectable" on public.intent_employments;
create policy "intent employments self-selectable" on public.intent_employments
  for select using (auth.uid() = user_id);

drop policy if exists "intent employments self-insertable" on public.intent_employments;
create policy "intent employments self-insertable" on public.intent_employments
  for insert with check (auth.uid() = user_id);

drop policy if exists "intent employments self-updatable" on public.intent_employments;
create policy "intent employments self-updatable" on public.intent_employments
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists "intent employments self-deletable" on public.intent_employments;
create policy "intent employments self-deletable" on public.intent_employments
  for delete using (auth.uid() = user_id);

alter table public.intent_employments
  alter column user_id set default auth.uid();

-- The efficacy TIME SERIES. One row per (intent, evaluation cycle)
-- capturing the targeted descriptive-layer metric and a matched-control
-- value at that time. This table is what makes the feature PROVABLE:
-- without a series we cannot tell a real decline from regression to the
-- mean, and cannot compute "faster than control" (matchedControlLift in
-- the math kernel). control_value is nullable - when no comparable
-- cohort exists yet the row still records target_value so the series
-- stays unbroken, and the caller tracks control coverage as a health
-- metric (a corpus where most samples lack a control cannot defend
-- against regression to the mean, and that must be visible).
create table if not exists public.intent_target_samples (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  intent_id uuid not null references public.intents(id) on delete cascade,
  sampled_at timestamptz not null default now(),
  target_value real not null,
  control_value real
);

create index if not exists intent_target_samples_series_idx
  on public.intent_target_samples (intent_id, sampled_at);

alter table public.intent_target_samples enable row level security;

drop policy if exists "intent target samples self-selectable"
  on public.intent_target_samples;
create policy "intent target samples self-selectable"
  on public.intent_target_samples
  for select using (auth.uid() = user_id);

drop policy if exists "intent target samples self-insertable"
  on public.intent_target_samples;
create policy "intent target samples self-insertable"
  on public.intent_target_samples
  for insert with check (auth.uid() = user_id);

drop policy if exists "intent target samples self-deletable"
  on public.intent_target_samples;
create policy "intent target samples self-deletable"
  on public.intent_target_samples
  for delete using (auth.uid() = user_id);

alter table public.intent_target_samples
  alter column user_id set default auth.uid();

-- Cached rendered prose, one row per user - the always-on block the
-- priming stage injects. Direct analog of samskara_compound_summary,
-- including the per-row regen claim so multiple devices coordinate the
-- render instead of duplicating it.
create table if not exists public.intent_compound_summary (
  user_id uuid primary key references auth.users(id) on delete cascade,
  summary text,
  intent_count_at_regen int not null default 0,
  last_regen_at timestamptz not null default now(),
  regen_claim_holder text,
  regen_claim_expires timestamptz
);

alter table public.intent_compound_summary enable row level security;

drop policy if exists "intent compound summary self-selectable"
  on public.intent_compound_summary;
create policy "intent compound summary self-selectable"
  on public.intent_compound_summary
  for select using (auth.uid() = user_id);

drop policy if exists "intent compound summary self-insertable"
  on public.intent_compound_summary;
create policy "intent compound summary self-insertable"
  on public.intent_compound_summary
  for insert with check (auth.uid() = user_id);

drop policy if exists "intent compound summary self-updatable"
  on public.intent_compound_summary;
create policy "intent compound summary self-updatable"
  on public.intent_compound_summary
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists "intent compound summary self-deletable"
  on public.intent_compound_summary;
create policy "intent compound summary self-deletable"
  on public.intent_compound_summary
  for delete using (auth.uid() = user_id);

-- Per-user minting coordination. One row per user the mint sweep has
-- ever touched: when it last minted, and the cross-tick claim. The
-- daily mint sweep is per-USER (unlike bias/samskara which claim
-- per-thread/per-substrate), so the claim lives on a per-user row
-- rather than on a work item.
create table if not exists public.intent_mint_runs (
  user_id uuid primary key references auth.users(id) on delete cascade,
  last_mint_at timestamptz,
  mint_claim_holder text,
  mint_claim_expires timestamptz
);

alter table public.intent_mint_runs enable row level security;

-- Select-only for the owner (the inspector can show "last reviewed");
-- all writes go through the security-definer RPCs below under the
-- service role, so no owner insert/update/delete policy is needed.
drop policy if exists "intent mint runs self-selectable" on public.intent_mint_runs;
create policy "intent mint runs self-selectable" on public.intent_mint_runs
  for select using (auth.uid() = user_id);

-- Claim the next user due for a daily mint. Candidate set = users who
-- have any descriptive layer to mint from (a samskara or a bias_summary
-- row); eligible = never minted, or last minted older than
-- p_min_age_hours with no live claim. Picks the most-overdue
-- (last_mint_at asc nulls first) and claims atomically via the
-- ON CONFLICT upsert. Returns the user_id or NULL when the queue is
-- dry.
--
-- Concurrency note: unlike the per-thread claim RPCs this does NOT use
-- `for update skip locked` across the candidate union (a never-minted
-- user has no row to lock). The claim still serializes within one
-- tick's drain (a just-claimed user has a live claim and drops out of
-- the next candidate scan), and the daily cadence makes overlapping
-- ticks racing the same never-minted user a sub-second, low-stakes
-- window - a double-mint self-heals because processMintProposals dedups
-- new creates against the intents already written by the first run.
create or replace function public.intent_mint_claim_next_user(
  p_holder_id text,
  p_ttl_seconds int,
  p_min_age_hours int
) returns uuid
language sql security definer set search_path = public as $$
  with candidate as (
    select u.user_id
      from (
        select user_id from public.samskaras
        union
        select user_id from public.bias_summary
      ) u
      -- Gate on the per-user opt-in: minting AND the efficacy
      -- evaluation that rides inside the per-user pass run ONLY for
      -- users who turned intents on. Off means the whole pipeline is
      -- inert (the injection side is gated separately in
      -- applyIntentPriming). A missing/false flag excludes the user.
      join public.profiles p
        on p.user_id = u.user_id
       and p.settings->>'intentsEnabled' = 'true'
      left join public.intent_mint_runs r on r.user_id = u.user_id
     where r.user_id is null
        or (
          (r.last_mint_at is null
            or r.last_mint_at < now() - make_interval(hours => p_min_age_hours))
          and (r.mint_claim_holder is null or r.mint_claim_expires < now())
        )
     order by r.last_mint_at asc nulls first
     limit 1
  )
  insert into public.intent_mint_runs (user_id, mint_claim_holder, mint_claim_expires)
  select user_id, p_holder_id, now() + make_interval(secs => p_ttl_seconds)
    from candidate
  on conflict (user_id) do update
     set mint_claim_holder = excluded.mint_claim_holder,
         mint_claim_expires = excluded.mint_claim_expires
  returning user_id;
$$;

revoke all on function public.intent_mint_claim_next_user(text, int, int)
  from public, anon, authenticated;
grant execute on function public.intent_mint_claim_next_user(text, int, int)
  to service_role;

-- Stamp a completed mint and release the claim. Holder-guarded so a
-- claim that expired and was taken over by another tick is not clobbered
-- by the original holder finishing late.
create or replace function public.intent_mint_finish(
  p_user_id uuid,
  p_holder_id text
) returns void
language sql security definer set search_path = public as $$
  update public.intent_mint_runs
     set last_mint_at = now(),
         mint_claim_holder = null,
         mint_claim_expires = null
   where user_id = p_user_id and mint_claim_holder = p_holder_id;
$$;

revoke all on function public.intent_mint_finish(uuid, text)
  from public, anon, authenticated;
grant execute on function public.intent_mint_finish(uuid, text) to service_role;

-- Daily mint-sweep cron. Dispatches to the venice function's
-- intent-mint-sweep route; the same Vault-secret + pg_net pattern every
-- other trigger uses, a silent no-op when the secrets are not seeded
-- (forks without automation). Daily at 05:37 - a free minute clear of
-- the GC crons (04:xx), the bias sweep (:03), and the */10 samskara
-- evaluation tick.
create or replace function public.nak_trigger_intent_mint_sweep()
returns void
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_url text;
  v_key text;
begin
  begin
    execute $q$ select decrypted_secret from vault.decrypted_secrets where name = 'project_url' $q$ into v_url;
    execute $q$ select decrypted_secret from vault.decrypted_secrets where name = 'service_role_key' $q$ into v_key;
  exception when others then
    return;  -- vault not installed or unreadable; nothing to dispatch
  end;
  if v_url is null or v_key is null then
    return;  -- secrets not seeded yet
  end if;
  begin
    execute format(
      $q$ select net.http_post(
            url := %L,
            headers := jsonb_build_object('Content-Type', 'application/json', 'Authorization', %L),
            body := '{}'::jsonb
          ) $q$,
      v_url || '/functions/v1/venice/intent-mint-sweep',
      'Bearer ' || v_key
    );
  exception when others then
    raise notice 'nak_trigger_intent_mint_sweep: dispatch failed: %', sqlerrm;
  end;
end;
$fn$;

revoke all on function public.nak_trigger_intent_mint_sweep() from public, anon, authenticated;

do $cron$
begin
  if exists (select 1 from pg_available_extensions where name = 'pg_cron')
     and exists (select 1 from pg_available_extensions where name = 'pg_net') then
    create extension if not exists pg_cron;
    create extension if not exists pg_net;
    if exists (select 1 from cron.job where jobname = 'nak-intent-mint-sweep') then
      perform cron.unschedule('nak-intent-mint-sweep');
    end if;
    perform cron.schedule(
      'nak-intent-mint-sweep',
      '37 5 * * *',
      $job$ select public.nak_trigger_intent_mint_sweep(); $job$
    );
  end if;
exception when others then
  raise notice 'intent mint sweep cron setup skipped: %', sqlerrm;
end
$cron$;

-- intent employment ---------------------------------------------------------
--
-- The settled-thread judge that fills intent_employments: per intention
-- that was active during a conversation (the threads.intent_active_at_turn
-- snapshot), what happened with it - opening, acted, reaction. Process
-- telemetry for the minter's pruning; NEVER an efficacy input. Shape
-- mirrors the bias analyze phase (per-thread claim + message-count
-- guard + processed stamp), with INDEPENDENT claim columns so the
-- employment sweep and the bias sweep never fight over the same thread.

alter table public.threads
  add column if not exists intent_employment_processed_at timestamptz,
  add column if not exists intent_employment_processed_msg_count int,
  add column if not exists intent_employment_claim_holder text,
  add column if not exists intent_employment_claim_expires timestamptz;

-- Claim the most-overdue settled thread whose intents-active snapshot is
-- non-empty, for an opted-in user. Mirrors bias_claim_next_thread_for_sweep:
-- the day-gate (updated_at on a prior calendar day in the owner's
-- timezone) excludes today's still-live conversations, and the
-- user-message-count predicate lives inline in the WHERE (before the
-- LIMIT) so a one-shot thread at the queue head cannot wedge the
-- pipeline (the starvation fix). The intentsEnabled join is the opt-in
-- gate - an opted-out user is never claimed, so employment is inert when
-- the feature is off, matching minting.
create or replace function public.intent_employment_claim_next_thread(
  p_holder_id text,
  p_ttl_seconds int,
  p_min_user_messages int
) returns table (
  thread_id uuid,
  user_message_count int,
  active_intent_ids text[],
  user_id uuid
)
language sql security definer
set search_path = public as $$
  with candidate as (
    select t.id as thread_id,
           (select count(*)::int from public.messages m
             where m.thread_id = t.id and m.role = 'user') as user_message_count,
           coalesce(t.intent_active_at_turn, '{}'::text[]) as active_intent_ids,
           t.user_id as user_id
      from public.threads t
      inner join public.profiles p on p.user_id = t.user_id
        and p.settings->>'intentsEnabled' = 'true'
      cross join lateral (
        select public.nak_safe_timezone(p.settings->>'displayTimezone') as tz
      ) usertz
     where (t.updated_at at time zone usertz.tz)::date
             < (now() at time zone usertz.tz)::date
       and coalesce(array_length(t.intent_active_at_turn, 1), 0) >= 1
       and (
         t.intent_employment_processed_at is null
         or t.intent_employment_processed_at < t.updated_at
       )
       and (
         t.intent_employment_claim_holder is null
         or t.intent_employment_claim_expires < now()
       )
       and (
         select count(*) from public.messages m
           where m.thread_id = t.id and m.role = 'user'
       ) >= p_min_user_messages
     order by t.updated_at asc
     limit 1
     for update of t skip locked
  )
  update public.threads t
     set intent_employment_claim_holder = p_holder_id,
         intent_employment_claim_expires = now() + make_interval(secs => p_ttl_seconds)
    from candidate c
   where t.id = c.thread_id
  returning t.id, c.user_message_count, c.active_intent_ids, t.user_id;
$$;

revoke all on function public.intent_employment_claim_next_thread(text, int, int)
  from public, anon, authenticated;
grant execute on function public.intent_employment_claim_next_thread(text, int, int)
  to service_role;

-- Save the judge's employment rows under the claim + message-count
-- guard, fully replacing any prior rows for the thread, and stamp
-- processed. Mirrors bias_save_observations. `security invoker`: the
-- sweep's service-role caller bypasses RLS, and user_id is passed
-- explicitly (the column default auth.uid() is null under service role).
create or replace function public.intent_employment_save(
  p_thread_id uuid,
  p_holder_id text,
  p_expected_msg_count int,
  p_employments jsonb,
  p_user_id uuid default null
)
returns boolean
security invoker
language plpgsql
as $$
declare
  v_uid uuid := coalesce(p_user_id, auth.uid());
  v_actual_count int;
  v_e jsonb;
begin
  if v_uid is null then
    return false;
  end if;

  perform 1 from public.threads
    where id = p_thread_id
      and user_id = v_uid
      and intent_employment_claim_holder = p_holder_id
      and (intent_employment_claim_expires is null or intent_employment_claim_expires > now());
  if not found then
    return false;
  end if;

  select count(*)::int into v_actual_count
    from public.messages
    where thread_id = p_thread_id and role = 'user';
  if v_actual_count <> p_expected_msg_count then
    -- A new user message landed during the judge call; the verdicts are
    -- now stale. Release the claim and let the thread re-eligible.
    update public.threads
      set intent_employment_claim_holder = null, intent_employment_claim_expires = null
      where id = p_thread_id;
    return false;
  end if;

  -- Fully replace prior employment rows for the thread (a re-evaluation
  -- after a new message supersedes the old read).
  delete from public.intent_employments
    where thread_id = p_thread_id and user_id = v_uid;

  if jsonb_array_length(p_employments) > 0 then
    for v_e in select * from jsonb_array_elements(p_employments) loop
      insert into public.intent_employments
        (user_id, intent_id, thread_id, opening, acted, user_reaction, reasoning)
      values (
        v_uid,
        (v_e->>'intent_id')::uuid,
        p_thread_id,
        (v_e->>'opening')::boolean,
        (v_e->>'acted')::boolean,
        nullif(v_e->>'user_reaction', ''),
        v_e->>'reasoning'
      );
    end loop;
  end if;

  update public.threads
    set intent_employment_processed_at = now(),
        intent_employment_processed_msg_count = p_expected_msg_count,
        intent_employment_claim_holder = null,
        intent_employment_claim_expires = null
    where id = p_thread_id;
  return true;
end;
$$;

revoke all on function public.intent_employment_save(uuid, text, int, jsonb, uuid)
  from public, anon;

-- Hourly employment sweep cron. Settled threads accumulate daily; an
-- hourly drain keeps intent_employments fresh for the daily mint pass
-- without a heavy per-tick cost (one judge per claimed thread, capped).
-- Minute :33 is clear of the other ticks (:03 bias, :13/:23 samskara,
-- :43 GC).
create or replace function public.nak_trigger_intent_employment_sweep()
returns void
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_url text;
  v_key text;
begin
  begin
    execute $q$ select decrypted_secret from vault.decrypted_secrets where name = 'project_url' $q$ into v_url;
    execute $q$ select decrypted_secret from vault.decrypted_secrets where name = 'service_role_key' $q$ into v_key;
  exception when others then
    return;
  end;
  if v_url is null or v_key is null then
    return;
  end if;
  begin
    execute format(
      $q$ select net.http_post(
            url := %L,
            headers := jsonb_build_object('Content-Type', 'application/json', 'Authorization', %L),
            body := '{}'::jsonb
          ) $q$,
      v_url || '/functions/v1/venice/intent-employment-sweep',
      'Bearer ' || v_key
    );
  exception when others then
    raise notice 'nak_trigger_intent_employment_sweep: dispatch failed: %', sqlerrm;
  end;
end;
$fn$;

revoke all on function public.nak_trigger_intent_employment_sweep() from public, anon, authenticated;

do $cron$
begin
  if exists (select 1 from pg_available_extensions where name = 'pg_cron')
     and exists (select 1 from pg_available_extensions where name = 'pg_net') then
    create extension if not exists pg_cron;
    create extension if not exists pg_net;
    if exists (select 1 from cron.job where jobname = 'nak-intent-employment-sweep') then
      perform cron.unschedule('nak-intent-employment-sweep');
    end if;
    perform cron.schedule(
      'nak-intent-employment-sweep',
      '33 * * * *',
      $job$ select public.nak_trigger_intent_employment_sweep(); $job$
    );
  end if;
exception when others then
  raise notice 'intent employment sweep cron setup skipped: %', sqlerrm;
end
$cron$;

-- followups -----------------------------------------------------------------
--
-- Pending questions the assistant saves for itself: "Ask how the lasagna
-- turned out." A follow-up is scaffolding, not knowledge - when the user
-- reports the outcome the row is closed (status + resolution stamp) and
-- the durable fact reaches `memories` through the normal channels
-- (reflection reading the settled transcript). See docs/dev/followups.md.
--
-- Two surfacing axes read this table, both inside the context-recall
-- gather (supabase/functions/venice/priming/context-recall.ts):
--   - semantic: open rows ride the embedding backfill and are searched
--     via search_followups_by_embedding alongside memories;
--   - date-due: open rows whose relevant_after has passed are pulled
--     deterministically, cooldown-gated via the surfacing ledger
--     (last_surfaced_at / surface_count, stamped by the gather).
-- relevant_after NULL means "never proactively asked" - the row
-- surfaces only when the topic comes up semantically.

create table if not exists public.followups (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  -- First-person prompt to self ("Ask how the lasagna turned out").
  question text not null,
  -- One or two lines of seeding context, enough to raise the question
  -- naturally without a thread fetch.
  context text not null default '',
  -- The conversation that seeded the loop. SET NULL, not cascade - the
  -- question is about the user's life, so it outlives the thread.
  source_thread_id uuid references public.threads(id) on delete set null,
  -- open = surfaces; answered/dismissed/expired = kept for audit and
  -- create-side dedup (an answered twin blocks stale re-creation),
  -- never surfaced again.
  status text not null default 'open'
    check (status in ('open', 'answered', 'dismissed', 'expired')),
  -- Start of proactive relevance. NULL = semantic-only surfacing.
  relevant_after timestamptz,
  -- What we learned, stamped on close. Audit only - the durable outcome
  -- lives in memories, written from the transcript.
  resolution text,
  -- Anti-nag ledger, written by the gather's date-due pull only
  -- (semantic surfacing is not an ask-prompt, so it doesn't count).
  last_surfaced_at timestamptz,
  surface_count int not null default 0,
  embedding vector(2048),
  embedding_model text,
  embedding_claim_holder text,
  embedding_claim_expires timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- The gather's two hot reads: due pull (user, status, relevant_after)
-- and the list tool's newest-first browse.
create index if not exists followups_user_open_due_idx
  on public.followups (user_id, relevant_after)
  where status = 'open';

create index if not exists followups_user_created_idx
  on public.followups (user_id, created_at desc);

alter table public.followups enable row level security;

drop policy if exists "followups_select_own" on public.followups;
create policy "followups_select_own" on public.followups
  for select using (auth.uid() = user_id);

drop policy if exists "followups_insert_own" on public.followups;
create policy "followups_insert_own" on public.followups
  for insert with check (auth.uid() = user_id);

drop policy if exists "followups_update_own" on public.followups;
create policy "followups_update_own" on public.followups
  for update using (auth.uid() = user_id);

drop policy if exists "followups_delete_own" on public.followups;
create policy "followups_delete_own" on public.followups
  for delete using (auth.uid() = user_id);

-- Invalidate the embedding whenever the text that produced it changes.
-- Same shape and rationale as clear_memory_embedding_on_change: pending
-- = `embedding is null`; the claim columns are nulled too so an
-- in-flight backfill save can't land a now-stale vector.
create or replace function public.clear_followup_embedding_on_change()
  returns trigger language plpgsql as $$
begin
  if new.question is distinct from old.question
     or new.context is distinct from old.context then
    new.embedding := null;
    new.embedding_model := null;
    new.embedding_claim_holder := null;
    new.embedding_claim_expires := null;
  end if;
  return new;
end $$;

drop trigger if exists clear_followup_embedding_on_change on public.followups;
create trigger clear_followup_embedding_on_change
  before update on public.followups
  for each row execute function public.clear_followup_embedding_on_change();

-- Embedding backfill claim/save pair. Same contract as
-- claim_next_pending_memory / save_memory_embedding_if_claimed; the
-- backfill loop walks this via its EMBED_SOURCES registry entry
-- (supabase/functions/_shared/embed-input.ts).
create or replace function public.claim_next_pending_followup(
  p_holder_id text,
  p_ttl_seconds int
) returns table (id uuid, question text, context text, user_id uuid)
language sql security definer
set search_path = public as $$
  with candidate as (
    select f.id
      from public.followups f
     where f.embedding is null
       and (f.embedding_claim_expires is null
            or f.embedding_claim_expires < now())
     order by f.updated_at desc
     limit 1
     for update skip locked
  )
  update public.followups f
     set embedding_claim_holder = p_holder_id,
         embedding_claim_expires = now() + make_interval(secs => p_ttl_seconds)
    from candidate c
   where f.id = c.id
  returning f.id, f.question, f.context, f.user_id;
$$;

create or replace function public.save_followup_embedding_if_claimed(
  p_id uuid,
  p_holder_id text,
  p_embedding vector(2048),
  p_embedding_model text
) returns boolean
language plpgsql security definer
set search_path = public as $$
declare
  updated int;
begin
  update public.followups
     set embedding = p_embedding,
         embedding_model = p_embedding_model,
         embedding_claim_holder = null,
         embedding_claim_expires = null
   where id = p_id
     and embedding_claim_holder = p_holder_id
     and embedding_claim_expires > now();
  get diagnostics updated = row_count;
  return updated > 0;
end $$;

-- Same lockdown rationale as the memory pair: definer functions with no
-- per-user filter must not be callable by authenticated users.
revoke all on function public.claim_next_pending_followup(text, int) from public, anon, authenticated;
revoke all on function public.save_followup_embedding_if_claimed(uuid, text, vector, text) from public, anon, authenticated;
grant execute on function public.claim_next_pending_followup(text, int) to service_role;
grant execute on function public.save_followup_embedding_if_claimed(uuid, text, vector, text) to service_role;

-- Semantic search over OPEN follow-ups only - this RPC exists for the
-- context-recall gather's semantic arm, and closed loops must never
-- surface as loops (the resolved outcome reaches recall as an ordinary
-- memory instead). No confidence boost: loops have no corroboration
-- axis, so plain cosine order is the whole ranking. p_user_id is the
-- b-strict service-role escape hatch (see search_memories_by_embedding
-- above for the full rationale).
create or replace function public.search_followups_by_embedding(
  query_embedding vector(2048),
  match_limit int,
  p_user_id uuid default null
) returns table (
  id uuid,
  question text,
  context text,
  relevant_after timestamptz,
  created_at timestamptz
)
language sql stable security invoker as $$
  select id, question, context, relevant_after, created_at
    from public.followups
   where user_id = coalesce(p_user_id, auth.uid())
     and status = 'open'
     and embedding is not null
   order by embedding <=> query_embedding
   limit match_limit
$$;

-- ---------------------------------------------------------------------------
-- Conversation digests
--
-- One row per (user, local calendar day): an agent-written recap of
-- everything the user discussed that day, rendered by the Daily digest
-- panel on the Chats tab. Rows are written exclusively by the digest
-- sweep agent (service role, bypasses RLS); the browser only reads.
--
-- digest_date is a plain DATE in the USER'S timezone (the sweep RPC
-- resolves profiles.settings.displayTimezone via nak_safe_timezone),
-- not a UTC bucket - "yesterday" means the user's yesterday.
--
-- threads is a JSONB array of {thread_id, title, summary} snapshots.
-- Titles are snapshotted (not joined) so a digest stays readable after
-- the underlying conversation is deleted - same rationale as
-- wiki_changelog.title_at_change.
-- ---------------------------------------------------------------------------

create table if not exists public.conversation_digests (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  digest_date date not null,
  summary text not null,
  threads jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now(),
  -- One digest per local day; the save RPC inserts with
  -- on-conflict-do-nothing so a raced double-claim can't duplicate.
  constraint conversation_digests_user_date_key unique (user_id, digest_date)
);

-- Newest-first cursor pagination for the panel ("Load more" pages on
-- digest_date) rides this as a range scan.
create index if not exists conversation_digests_user_date_idx
  on public.conversation_digests (user_id, digest_date desc);

alter table public.conversation_digests enable row level security;

-- Read-only for the owner. No insert/update/delete policies on
-- purpose: every write comes from the sweep agent under the service
-- role, which bypasses RLS. The browser cannot forge or edit history.
drop policy if exists "conversation_digests_select_own" on public.conversation_digests;
create policy "conversation_digests_select_own" on public.conversation_digests
  for select using (auth.uid() = user_id);

-- Per-user claim pair for the digest sweep. Lives on profiles (the
-- digest is a per-user unit of work, unlike the wiki's per-thread
-- claims on threads). Same TTL discipline as the other claim pairs:
-- a crashed run leaves the claim to expire and the next hourly tick
-- retries.
alter table public.profiles
  add column if not exists digest_claim_holder text,
  add column if not exists digest_claim_expires_at timestamptz,
  -- Consecutive-failure tracking for ONE day at a time: the claim
  -- always serves the oldest undigested day, so at most one day per
  -- user can be failing. When the failing day changes, the counter
  -- resets; when it hits the cap, record_digest_failure writes a
  -- placeholder digest to advance the queue.
  add column if not exists digest_failing_date date,
  add column if not exists digest_failure_count integer not null default 0;

-- Claim the next (user, day) pair needing a digest, across ALL users.
-- SECURITY DEFINER global sweep, same posture as
-- claim_next_thread_for_wiki: the caller is the venice function's
-- /digest-sweep route driven by pg_cron with a service-role bearer,
-- so there is no auth.uid() to scope by; EXECUTE is locked to
-- service_role below.
--
-- Eligibility per user:
--   - settings->>'conversationDigestEnabled' is distinct from 'false'
--     (string compare, not a boolean cast, so one malformed value
--     cannot wedge the global sweep - same guard as the wiki toggle);
--   - no live claim (null or expired);
--   - there exists a local calendar day, STRICTLY BEFORE today in the
--     user's timezone, that has at least one non-empty user/assistant
--     message and no digest row yet. There is NO backfill floor: the
--     sweep grinds through the user's entire history oldest-first,
--     a few days per hourly tick, until every past day is digested.
--     A permanently-failing day cannot pin the queue (the claim
--     always picks the oldest undigested day) because
--     record_digest_failure below skips it with a placeholder row
--     after DIGEST_FAILURE_CAP consecutive failures.
--
-- Returns the UTC instants of the local day's boundaries
-- (day_start/day_end) alongside the date so the edge agent can range-
-- scan messages without re-deriving timezone math in JS.
drop function if exists public.claim_next_digest_day(text, int);
create or replace function public.claim_next_digest_day(
  p_holder_id text,
  p_ttl_seconds int
) returns table (
  user_id uuid,
  digest_date date,
  tz text,
  day_start timestamptz,
  day_end timestamptz
)
language sql security definer
set search_path = public as $$
  with candidate as (
    select
      p.user_id as user_id,
      pick.d as digest_date,
      usertz.tz as tz
      from public.profiles p
      cross join lateral (
        select public.nak_safe_timezone(p.settings->>'displayTimezone') as tz
      ) usertz
      cross join lateral (
        -- Oldest undigested local day with substantive traffic,
        -- across the user's whole history. Bucketing happens per
        -- message row, so this lateral scans every message the user
        -- owns on every claim call - acceptable at nak's single-user
        -- scale, and once the backlog drains the min() short-circuits
        -- to recent days only in effect (older days all have rows).
        select min((m.created_at at time zone usertz.tz)::date) as d
          from public.messages m
          inner join public.threads t on t.id = m.thread_id
         where t.user_id = p.user_id
           and m.role in ('user', 'assistant')
           and m.content is not null
           and length(m.content) > 0
           and (m.created_at at time zone usertz.tz)::date
               < (now() at time zone usertz.tz)::date
           and not exists (
             select 1
               from public.conversation_digests cd
              where cd.user_id = p.user_id
                and cd.digest_date = (m.created_at at time zone usertz.tz)::date
           )
      ) pick
     where (p.settings->>'conversationDigestEnabled') is distinct from 'false'
       and (p.digest_claim_expires_at is null
            or p.digest_claim_expires_at < now())
       and pick.d is not null
     order by pick.d asc
     limit 1
     for update of p skip locked
  )
  update public.profiles p
     set digest_claim_holder = p_holder_id,
         digest_claim_expires_at = now() + make_interval(secs => p_ttl_seconds)
    from candidate c
   where p.user_id = c.user_id
  returning p.user_id,
            c.digest_date,
            c.tz,
            (c.digest_date::timestamp at time zone c.tz) as day_start,
            ((c.digest_date + 1)::timestamp at time zone c.tz) as day_end;
$$;

revoke all on function public.claim_next_digest_day(text, int)
  from public, anon, authenticated;
grant execute on function public.claim_next_digest_day(text, int)
  to service_role;

-- Persist a digest IF our claim is still ours, releasing the claim in
-- the same statement. Returns false when another holder took over
-- (the caller drops its result on the floor - the winner writes).
-- on-conflict-do-nothing makes a raced duplicate insert a no-op
-- rather than an error.
create or replace function public.save_conversation_digest(
  p_user_id uuid,
  p_holder_id text,
  p_digest_date date,
  p_summary text,
  p_threads jsonb
) returns boolean
language plpgsql security definer
set search_path = public as $$
begin
  update public.profiles
     set digest_claim_holder = null,
         digest_claim_expires_at = null,
         -- A success wipes the consecutive-failure tracking so a
         -- transient blip on an earlier attempt doesn't shorten the
         -- retry budget of some future day.
         digest_failing_date = null,
         digest_failure_count = 0
   where user_id = p_user_id
     and digest_claim_holder = p_holder_id
     and digest_claim_expires_at > now();
  if not found then
    return false;
  end if;
  insert into public.conversation_digests (user_id, digest_date, summary, threads)
  values (p_user_id, p_digest_date, p_summary, p_threads)
  on conflict (user_id, digest_date) do nothing;
  return true;
end $$;

revoke all on function public.save_conversation_digest(uuid, text, date, text, jsonb)
  from public, anon, authenticated;
grant execute on function public.save_conversation_digest(uuid, text, date, text, jsonb)
  to service_role;

-- Record a failed digest attempt and decide retry-vs-skip. Because
-- the claim always serves a user's OLDEST undigested day, a day that
-- keeps failing would pin that user's whole queue - so after
-- p_failure_cap consecutive failures on the same day this writes a
-- placeholder digest row (empty threads, an honest "couldn't
-- generate" summary) to advance the queue, mirroring the wiki
-- sweep's skip-after-cap discipline. Returns:
--   'released'   - claim cleared, counter bumped; retried next tick
--   'skipped'    - cap reached, placeholder written, queue advanced
--   'claim-lost' - another holder owns the row; nothing recorded
create or replace function public.record_digest_failure(
  p_user_id uuid,
  p_holder_id text,
  p_digest_date date,
  p_failure_cap int
) returns text
language plpgsql security definer
set search_path = public as $$
declare
  v_count int;
begin
  update public.profiles
     set digest_claim_holder = null,
         digest_claim_expires_at = null,
         digest_failure_count = case
           when digest_failing_date = p_digest_date
             then digest_failure_count + 1
           else 1
         end,
         digest_failing_date = p_digest_date
   where user_id = p_user_id
     and digest_claim_holder = p_holder_id
     and digest_claim_expires_at > now()
  returning digest_failure_count into v_count;
  if not found then
    return 'claim-lost';
  end if;
  if v_count < p_failure_cap then
    return 'released';
  end if;
  insert into public.conversation_digests (user_id, digest_date, summary, threads)
  values (
    p_user_id,
    p_digest_date,
    'Digest generation failed repeatedly for this day, so it was skipped.',
    '[]'::jsonb
  )
  on conflict (user_id, digest_date) do nothing;
  update public.profiles
     set digest_failing_date = null,
         digest_failure_count = 0
   where user_id = p_user_id;
  return 'skipped';
end $$;

revoke all on function public.record_digest_failure(uuid, text, date, int)
  from public, anon, authenticated;
grant execute on function public.record_digest_failure(uuid, text, date, int)
  to service_role;

-- ---------------------------------------------------------------------------
-- Scheduled conversation-digest sweep
-- (pg_cron -> pg_net -> venice/digest-sweep)
--
-- Hourly, not daily: eligibility only flips when a user's LOCAL
-- calendar day rolls over, and users sit in different timezones, so
-- an hourly tick with the per-user day-gate in claim_next_digest_day
-- is what delivers "after midnight in each user's timezone". Same
-- Vault-secret custody and no-op-until-seeded behavior as the wiki
-- sweep. Minute 53 - free slot on the shared minute ladder (see
-- docs/dev/architecture.md, background-job model).
-- ---------------------------------------------------------------------------

create or replace function public.nak_trigger_digest_sweep()
returns void
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_url text;
  v_key text;
begin
  begin
    execute $q$ select decrypted_secret from vault.decrypted_secrets where name = 'project_url' $q$ into v_url;
    execute $q$ select decrypted_secret from vault.decrypted_secrets where name = 'service_role_key' $q$ into v_key;
  exception when others then
    return;  -- vault not installed or unreadable; nothing to dispatch
  end;
  if v_url is null or v_key is null then
    return;  -- secrets not seeded yet
  end if;
  begin
    execute format(
      $q$ select net.http_post(
            url := %L,
            headers := jsonb_build_object('Content-Type', 'application/json', 'Authorization', %L),
            body := '{}'::jsonb
          ) $q$,
      v_url || '/functions/v1/venice/digest-sweep',
      'Bearer ' || v_key
    );
  exception when others then
    raise notice 'nak_trigger_digest_sweep: dispatch failed: %', sqlerrm;
  end;
end;
$fn$;

revoke all on function public.nak_trigger_digest_sweep() from public, anon, authenticated;

do $cron$
begin
  if exists (select 1 from pg_available_extensions where name = 'pg_cron')
     and exists (select 1 from pg_available_extensions where name = 'pg_net') then
    create extension if not exists pg_cron;
    create extension if not exists pg_net;
    if exists (select 1 from cron.job where jobname = 'nak-conversation-digest-sweep') then
      perform cron.unschedule('nak-conversation-digest-sweep');
    end if;
    perform cron.schedule(
      'nak-conversation-digest-sweep',
      '53 * * * *',
      $job$ select public.nak_trigger_digest_sweep(); $job$
    );
  end if;
exception when others then
  raise notice 'conversation digest sweep cron setup skipped: %', sqlerrm;
end
$cron$;

-- mcp_integrations -------------------------------------------------------
--
-- One row per remote MCP server a user has connected. The browser
-- Settings "Integrations" pane inserts a row on paste-URL; the edge
-- function's mcp-discover route fills in the OAuth metadata and the
-- mcp-register route fills in client_id via RFC 7591 DCR; the
-- mcp-token-exchange route stores the first access + refresh token
-- in mcp_oauth_tokens; subsequent mcp-token-refresh calls rotate the
-- token row. The chat model toggles a per-server "mcp:<label>"
-- toolbox; the edge function's performToolCall dispatches against
-- the server URL with the stored bearer token.
--
-- Token storage lives in a separate table (mcp_oauth_tokens) so the
-- integration row itself - which the browser reads for the settings
-- list - never carries secrets. The access_token is still a bearer
-- credential and must never be returned to the browser; all reads of
-- mcp_oauth_tokens happen service-role from the edge function.

create table if not exists public.mcp_integrations (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  -- User-supplied label for the integration, shown in the settings
  -- list and used as the toolbox display name prefix.
  label text not null,
  -- The remote MCP server URL the user pasted. Unique per user so a
  -- second paste of the same URL updates the existing row instead of
  -- creating a duplicate.
  server_url text not null,
  -- Whether this server's auth advertised RFC 7591 Dynamic Client
  -- Registration. If true, nak self-registered on the fly. If false,
  -- the client_id was user-pasted (tier 2) or shipped as a curated
  -- constant (tier 1 - not yet implemented).
  supports_dcr boolean not null default false,
  -- OAuth client registration. Minted by DCR (supports_dcr=true) or
  -- pasted by the user (tier 2). client_secret is null for public
  -- clients (PKCE-only, the common case for MCP servers).
  client_id text,
  client_secret text,
  -- The redirect URI nak used for this integration's OAuth flow.
  -- Stored so a re-authorization uses the same registered URI.
  registered_redirect_uri text,
  -- The auth status: 'pending' = user pasted URL but OAuth not yet
  -- completed; 'authorized' = tokens stored and ready; 'revoked' =
  -- token refresh failed permanently or the user removed access.
  auth_status text not null default 'pending',
  -- Cached RFC 8414 + RFC 9728 metadata from the discovery chain, so
  -- the edge function doesn't refetch on every tool-dispatch refresh.
  discovered_metadata jsonb,
  -- The scopes the user actually granted. Array of scope strings.
  granted_scopes text[] not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, server_url)
);

alter table public.mcp_integrations enable row level security;

drop policy if exists "mcp_integrations are self-selectable" on public.mcp_integrations;
create policy "mcp_integrations are self-selectable" on public.mcp_integrations
  for select using (auth.uid() = user_id);

drop policy if exists "mcp_integrations are self-insertable" on public.mcp_integrations;
create policy "mcp_integrations are self-insertable" on public.mcp_integrations
  for insert with check (auth.uid() = user_id);

drop policy if exists "mcp_integrations are self-updatable" on public.mcp_integrations;
create policy "mcp_integrations are self-updatable" on public.mcp_integrations
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists "mcp_integrations are self-deletable" on public.mcp_integrations;
create policy "mcp_integrations are self-deletable" on public.mcp_integrations
  for delete using (auth.uid() = user_id);

create index if not exists mcp_integrations_user_idx
  on public.mcp_integrations (user_id, updated_at desc);

-- Unique labels per user so toolbox names (mcp:<label>) don't collide
-- and so the user always knows which integration they're enabling.
do $$ begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'mcp_integrations_user_label_key'
      and conrelid = 'public.mcp_integrations'::regclass
  ) then
    alter table public.mcp_integrations
      add constraint mcp_integrations_user_label_key unique (user_id, label);
  end if;
end $$;

-- mcp_oauth_tokens -------------------------------------------------------
--
-- Per-integration OAuth token storage. One row per mcp_integrations
-- row (1:1). Written and read exclusively by the edge function using
-- the service-role client - the browser never touches this table. The
-- access_token and refresh_token are bearer credentials; RLS still
-- gates the table (auth.uid() = user_id) as defense in depth, but the
-- security boundary is that no browser code path reads from it.
--
-- Refresh-token rotation: some MCP servers (Fastmail, and OAuth 2.1
-- public clients per spec) return a NEW refresh_token on every
-- refresh and invalidate the old one on reuse. The edge function's
-- refresh handler must write-then-replace: update both token columns
-- atomically, never let two devices race a refresh on the same row
-- (one gets rotated-out and the whole grant dies). For v1 single-
-- device use this is a straightforward UPDATE; cross-device
-- coordination is deferred (see plan open question 2).

create table if not exists public.mcp_oauth_tokens (
  id uuid primary key default gen_random_uuid(),
  integration_id uuid not null references public.mcp_integrations(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  access_token text not null,
  -- When the access token expires (epoch ms), from the token response
  -- expires_in. Null means the server didn't return an expiry (treat
  -- as already-expired so the first use triggers a refresh).
  access_token_expires_at bigint,
  refresh_token text,
  refresh_token_rotated_at timestamptz,
  last_refreshed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (integration_id)
);

alter table public.mcp_oauth_tokens enable row level security;

drop policy if exists "mcp_oauth_tokens are self-selectable" on public.mcp_oauth_tokens;
create policy "mcp_oauth_tokens are self-selectable" on public.mcp_oauth_tokens
  for select using (auth.uid() = user_id);

drop policy if exists "mcp_oauth_tokens are self-insertable" on public.mcp_oauth_tokens;
create policy "mcp_oauth_tokens are self-insertable" on public.mcp_oauth_tokens
  for insert with check (auth.uid() = user_id);

drop policy if exists "mcp_oauth_tokens are self-updatable" on public.mcp_oauth_tokens;
create policy "mcp_oauth_tokens are self-updatable" on public.mcp_oauth_tokens
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists "mcp_oauth_tokens are self-deletable" on public.mcp_oauth_tokens;
create policy "mcp_oauth_tokens are self-deletable" on public.mcp_oauth_tokens
  for delete using (auth.uid() = user_id);

create index if not exists mcp_oauth_tokens_integration_idx
  on public.mcp_oauth_tokens (integration_id);

-- mcp_integration_tools --------------------------------------------------
--
-- Cached MCP tool catalog per integration. Populated after OAuth by
-- calling tools/list on the MCP server; consulted at chat-dispatch
-- time to build the wire `tools` array entry for the integration's
-- gated "mcp:<label>" toolbox. Refreshed on integration-add and
-- periodically thereafter (the edge function decides the cadence).
--
-- The wire_schema column holds the JSON Schema for the tool's input
-- parameters (the inputSchema field from the MCP tools/list
-- response). The description column holds the full tool description
-- (for the wire `tools` array). The short_description column holds
-- the <50-char brief for the system-prompt catalog line.

create table if not exists public.mcp_integration_tools (
  id uuid primary key default gen_random_uuid(),
  integration_id uuid not null references public.mcp_integrations(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  -- The tool name as the MCP server defines it (e.g. "search_email").
  -- The wire tool name is namespaced as "mcp:<integrationId>:<serverToolName>"
  -- to avoid collisions; the edge function resolves the mapping.
  server_tool_name text not null,
  -- Full description from the MCP server (for the wire tools array).
  description text not null default '',
  -- <50-char brief for the system-prompt catalog line.
  short_description text not null default '',
  -- JSON Schema for the tool's input parameters (inputSchema from
  -- the MCP tools/list response).
  wire_schema jsonb not null default '{}'::jsonb,
  last_refreshed_at timestamptz not null default now(),
  -- One row per (integration, server_tool_name).
  unique (integration_id, server_tool_name)
);

alter table public.mcp_integration_tools enable row level security;

drop policy if exists "mcp_integration_tools are self-selectable" on public.mcp_integration_tools;
create policy "mcp_integration_tools are self-selectable" on public.mcp_integration_tools
  for select using (auth.uid() = user_id);

drop policy if exists "mcp_integration_tools are self-insertable" on public.mcp_integration_tools;
create policy "mcp_integration_tools are self-insertable" on public.mcp_integration_tools
  for insert with check (auth.uid() = user_id);

drop policy if exists "mcp_integration_tools are self-updatable" on public.mcp_integration_tools;
create policy "mcp_integration_tools are self-updatable" on public.mcp_integration_tools
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists "mcp_integration_tools are self-deletable" on public.mcp_integration_tools;
create policy "mcp_integration_tools are self-deletable" on public.mcp_integration_tools
  for delete using (auth.uid() = user_id);

create index if not exists mcp_integration_tools_integration_idx
  on public.mcp_integration_tools (integration_id);

-- ---------------------------------------------------------------------------
-- Scheduled MCP catalog refresh (pg_cron -> pg_net -> venice/mcp-catalog-refresh)
--
-- Daily re-fetch of every authorized integration's tool catalog. Uses the
-- stored access token (auto-refreshed), so no user interaction is needed.
-- A revoked grant marks the integration `expired` so the Settings UI can
-- show a re-authorize badge. Same vault -> pg_net dispatch shape as the
-- other sweep triggers.
-- ---------------------------------------------------------------------------
create or replace function public.nak_trigger_mcp_catalog_refresh()
returns void
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_url text;
  v_key text;
begin
  begin
    execute $q$ select decrypted_secret from vault.decrypted_secrets where name = 'project_url' $q$ into v_url;
    execute $q$ select decrypted_secret from vault.decrypted_secrets where name = 'service_role_key' $q$ into v_key;
  exception when others then
    return;
  end;
  if v_url is null or v_key is null then
    return;
  end if;
  begin
    execute format(
      $q$ select net.http_post(
            url := %L,
            headers := jsonb_build_object('Content-Type', 'application/json', 'Authorization', %L),
            body := '{}'::jsonb
          ) $q$,
      v_url || '/functions/v1/venice/mcp-catalog-refresh',
      'Bearer ' || v_key
    );
  exception when others then
    raise notice 'nak_trigger_mcp_catalog_refresh: dispatch failed: %', sqlerrm;
  end;
end;
$fn$;

revoke all on function public.nak_trigger_mcp_catalog_refresh() from public, anon, authenticated;

do $cron$
begin
  if exists (select 1 from pg_available_extensions where name = 'pg_cron')
     and exists (select 1 from pg_available_extensions where name = 'pg_net') then
    create extension if not exists pg_cron;
    create extension if not exists pg_net;
    if exists (select 1 from cron.job where jobname = 'nak-mcp-catalog-refresh') then
      perform cron.unschedule('nak-mcp-catalog-refresh');
    end if;
    -- 4:00 UTC: once-daily is enough for catalog drift (MCP servers
    -- don't change their tool surface often), and it sits clear of the
    -- minute-ladder sweeps.
    perform cron.schedule(
      'nak-mcp-catalog-refresh',
      '0 4 * * *',
      $job$ select public.nak_trigger_mcp_catalog_refresh(); $job$
    );
  end if;
exception when others then
  raise notice 'mcp catalog refresh cron setup skipped: %', sqlerrm;
end
$cron$;

