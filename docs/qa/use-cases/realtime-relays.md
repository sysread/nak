# Realtime relays: server writes refresh open panels

## Covers

The three postgres_changes relays (wiki_articles, memories,
recipes) that let server-side writers refresh open panels, and
DELETE delivery through the `(id, user_id)` replica-identity
indexes ([dev: cookbook](../../dev/cookbook.md) gotchas,
[dev: wiki](../../dev/wiki.md) gotchas,
[dev: memory](../../dev/memory.md) gotchas).

## Preconditions

- Local stack up, signed in, with the target panel OPEN before the
  write lands (Recipes tab, Memories tab, or Wiki tab).
- psql access to play the server-side writer.

## Steps

1. Recipes INSERT: with the Recipes tab open, insert a recipe row
   for the dev user via psql.
2. Recipes DELETE: delete that row.
3. Memories UPDATE: with the Memories tab open, update any
   memory's label via psql.
4. Wiki: with the Wiki tab open, update an article's content via
   psql.
5. Replica-identity audit (DB-level, no UI):

   ```sql
   select relname, relreplident from pg_class
    where relname in ('recipes','wiki_articles','memories');
   -- expect 'i' (index) for all three
   ```

## Expected

- (1) The new recipe appears in the open list within ~1s, no
  reload.
- (2) The row disappears - DELETE events deliver because the
  replica identity carries user_id; with the default pkey identity
  realtime silently drops them (the original bug).
- (3, 4) The open panel refetches and shows the edit.
- (5) All three tables report `relreplident = 'i'`. The
  `*_replident_idx` indexes exist and are NOT safe to drop -
  dropping one silently degrades the identity to NOTHING and kills
  DELETE replication.
- **[hosted]** Same behaviors against the hosted realtime stack -
  local Realtime and hosted Realtime differ enough (key formats,
  channel auth) that this wants a fresh pass post-deploy.

## Cleanup

Delete QA-inserted rows; revert QA edits (changelog panels show
what changed).

## Results log

| Date | Env | Commit | Result | Notes |
| ---- | --- | ------ | ------ | ----- |
| 2026-06-10 | local | be54771 | pass (1,2,5) | insert appeared live; delete dropped silently until the replident index landed, then delivered; identities 'i' |
| 2026-06-10 | local | 9cd3508 | pass (3,4) | psql label/title edits appeared live in the open Memories and Wiki panels within ~1s; QA renames reverted afterward |
