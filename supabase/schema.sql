-- Nak — minimum viable schema.
-- Run this once in the Supabase SQL Editor for your project.
--
-- Tables:
--   profiles  one row per authenticated user
--   threads   conversation containers owned by a user
--   messages  individual turns within a thread
--
-- All tables have Row Level Security enabled so that an authenticated user
-- can only access rows they own. The anon key that the browser uses is
-- safe to expose provided RLS policies are in place.

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
-- The `embedding` column is here early so we don't need a schema migration
-- later: 1024 dims matches the embedding model we plan to use. Stays null
-- until the embed-on-write path lands. Until then, search runs on pg's
-- ILIKE over label||data — fine for the small-N memory count we expect.

create extension if not exists vector;

create table if not exists public.memories (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  label text not null,
  data text not null,
  embedding vector(1024),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists memories_user_updated_idx
  on public.memories (user_id, updated_at desc);

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
