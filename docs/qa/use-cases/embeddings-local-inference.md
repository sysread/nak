# Local embeddings: gte-small model and backfill drain

## Covers

The local embedding inference pipeline
([dev: embeddings](../../dev/embeddings.md)): the
`Supabase.ai.Session('gte-small')` model in the edge function, the
`/embed` query route, the `/backfill` cron-driven drain, and the
one-time migration that nulls rows stamped with the previous model.

## Preconditions

- Local stack up (`mise run dev-start`), signed in as the dev user.
- `app_config` seeded with a Venice key (needed for non-embed routes
  to function; the embed route itself uses no key).
- At least one memory row with `embedding is not null` and
  `embedding_model = 'gte-small'`. Seed one if needed:

```sql
insert into public.memories (user_id, label, data, confidence)
values (
  (select id from auth.users where email = 'dev@nak.local'),
  'Embedding QA test',
  'A test memory about cooking pasta with tomato sauce and basil',
  5
);
```

- Read the service-role key for curl commands:

```sh
SB_KEY=$(supabase status -o json | python3 -c "import sys,json; print(json.load(sys.stdin)['SERVICE_ROLE_KEY'])")
```

## Steps

1. Verify the `/embed` route produces a 384-dim vector:

```sh
curl -s -X POST http://127.0.0.1:54321/functions/v1/venice/embed \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $SB_KEY" \
  -d '{"input":"cooking pasta with tomato sauce"}' | python3 -c \
  "import sys,json; d=json.load(sys.stdin); print('dims:', len(d['data'][0]['embedding']))"
```

1. Verify the stored embedding is 2048-dim (zero-padded from 384):

```sh
PGPASSWORD=postgres psql -h 127.0.0.1 -p 54322 -U postgres -d postgres -c \
  "select label, embedding_model, vector_dims(embedding) as dims from memories where embedding is not null;"
```

1. In the browser, open the Memories drawer and search for "cooking
   pasta".

1. Wait for results to render, then clear the search box.

1. Trigger a manual backfill tick:

```sh
curl -s -X POST http://127.0.0.1:54321/functions/v1/venice/backfill \
  -H "Authorization: Bearer $SB_KEY" \
  -H "Content-Type: application/json"
```

1. Null a memory's embedding to simulate a pending row, then run
   the backfill again:

```sh
PGPASSWORD=postgres psql -h 127.0.0.1 -p 54322 -U postgres -d postgres -c \
  "update memories set embedding = null, embedding_model = null,
   embedding_claim_holder = null, embedding_claim_expires = null
   where label = 'Embedding QA test';"

curl -s -X POST http://127.0.0.1:54321/functions/v1/venice/backfill \
  -H "Authorization: Bearer $SB_KEY" \
  -H "Content-Type: application/json"
```

1. Verify the row was re-embedded with the correct model:

```sh
PGPASSWORD=postgres psql -h 127.0.0.1 -p 54322 -U postgres -d postgres -c \
  "select label, embedding_model, vector_dims(embedding) as dims
   from memories where label = 'Embedding QA test';"
```

## Expected

- (1) The `/embed` route returns 200 with `dims: 384`. No Venice API
  key required (the model is pre-bundled in the edge-runtime image).
- (2) All embedded rows show `embedding_model = 'gte-small'` and
  `dims = 2048` (the 384-dim native vector zero-extended to the
  storage column width).
- (3) Searching "cooking pasta" returns the "Embedding QA test"
  memory near the top of the results. The network panel shows
  `POST /functions/v1/venice/embed` returning 200 for each
  debounced query, followed by
  `POST /rest/v1/rpc/search_memories_by_embedding` returning 200.
- (4) Clearing the search restores the normal memory browse list.
- (5) The manual backfill returns a JSON summary with
  `embedded: 0` (or a small count if rows were pending). No
  errors, no rate-limited flag.
- (6) After nulling and re-running backfill, the summary shows
  `embedded: 1` (the nulled row was picked up and re-embedded).
- (7) The row shows `embedding_model = 'gte-small'` and
  `dims = 2048` again.

## Cleanup

```sh
PGPASSWORD=postgres psql -h 127.0.0.1 -p 54322 -U postgres -d postgres -c \
  "delete from memories where label = 'Embedding QA test';"
```

## Results log

| Date | Env | Commit | Result | Notes |
| --- | --- | --- | --- | --- |
| 2026-08-11 | local | 2c97416 | pass | Full stack test: /embed returns 384 dims, search finds test memory by meaning, backfill re-embeds nulled row, all rows show embedding_model=gte-small at 2048 dims |
