# QA use-case walkthroughs

Manual verification procedures, in a fixed format so any session
(human or agent) can execute them and record results. They exist
because the interesting failure modes in nak live in the seams -
edge function to drawer, cron to claim RPC, realtime to panel -
where unit tests cannot reach and "it compiled" proves nothing.

Not user documentation (the Help modal bundles only `docs/user/`)
and not architecture documentation (`docs/dev/` owns that). A
use-case here describes how to PROVE a feature works end to end,
against a named environment.

## When to execute

- **Before a release-shaped merge**: run the use-cases touching the
  changed subsystems against the local stack (`mise run dev-start`).
- **After a production deploy**: run the same cases against the
  hosted project. Several behaviors (pg_cron scheduling, hosted
  waitUntil lifetime, private-channel broadcast delivery) only
  exist hosted - local passes do not cover them.

## Format

One file per use-case under [`use-cases/`](./use-cases/), named
`<area>-<slug>.md`. Sections, in order:

- **Covers** - the features/subsystems this case exercises, with
  links to the relevant `docs/dev/` pages.
- **Preconditions** - environment, data, and state required before
  starting. Include how to MAKE the state when it doesn't occur
  naturally (SQL to reset a pointer, clear a cache, null an
  embedding).
- **Steps** - numbered, imperative, one observable action each.
  Shell commands verbatim; UI actions by their visible labels.
- **Expected** - the observable result per step (or per group of
  steps), phrased so a checker can answer yes/no. Name WHERE to
  look (drawer source tag, DB column, panel).
- **Cleanup** - how to undo any state the case dirtied, when it
  matters.
- **Results log** - a dated table: date, environment
  (local/hosted), commit, pass/fail per expectation, notes. Append,
  never overwrite - the history is the point.

## Conventions

- Cases assume the local stack via `mise run dev-start` with the
  dev login (`dev@nak.local` / `devpass123`) unless they say
  hosted. Hosted-only expectations are marked **[hosted]**.
- Service-role curl examples read the key from
  `supabase status -o json`; never paste keys into the doc.
- Keep cases independent: executing one must not require having
  run another first (preconditions may share setup SQL, stated in
  each).

## Index

- [chat-streaming-turn](./use-cases/chat-streaming-turn.md) - a
  full streaming chat turn: fresh stream, operational drawer lines,
  reconnect, stale-row janitor.
- [reflection-drain](./use-cases/reflection-drain.md) - the
  chat-tail drain, the hourly catch-up sweep, and the attempt cap.
- [wiki-fleet](./use-cases/wiki-fleet.md) - autonomous wiki sweep,
  skipped-thread retry, librarian sweep + manual run with live
  narration.
- [memory-librarians](./use-cases/memory-librarians.md) - rem and
  deep-sleep sweeps, manual runs from the Memories panel, the
  shared in-flight guard.
- [realtime-relays](./use-cases/realtime-relays.md) - server-side
  writes refreshing open panels (wiki articles, memories, recipes),
  including DELETE delivery via the replica-identity indexes.
- [background-maintenance](./use-cases/background-maintenance.md) -
  embed backfill, attachment expiry, recipe-image GC, and their
  per-user drawer summaries.
