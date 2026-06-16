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

- **Before changing an existing feature**: if the feature has a
  use-case, execute it against the UNCHANGED code first - that pass
  is the baseline the post-change run is compared against. If it
  has no use-case yet, backfill one and execute it before touching
  the feature (see CLAUDE.md, "QA use-cases").
- **After the change**: re-execute and log both runs. The
  before/after pair is the regression evidence; a lone post-change
  pass only proves the new behavior is self-consistent.
- **Before a release-shaped merge**: run the use-cases touching the
  changed subsystems against the local stack (`mise run dev-start`).
- **After a production deploy**: run the same cases against the
  hosted project. Several behaviors (pg_cron scheduling, hosted
  waitUntil lifetime, private-channel broadcast delivery) only
  exist hosted - local passes do not cover them.

New features ship their use-case in the same PR - a feature without
a walkthrough has no repeatable proof.

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
- [chat-recall-agents](./use-cases/chat-recall-agents.md) - the
  mid-turn recall agents (memory_recall and siblings), their drawer
  sources, and memory_conversation seeding.
- [context-recall-priming](./use-cases/context-recall-priming.md) - the
  boundary-triggered deterministic recall pipeline, its works-cited
  index, the synthetic `<think>` injection, and the umbrella `context`
  tool.
- [intuition-pipeline](./use-cases/intuition-pipeline.md) - the
  subconscious perception / drive / synthesis pipeline, its
  trigger and cache logic on `threads.intuition_payload`, and the
  `<think>`-tagged injection ahead of the next completion.
- [chat-ask-user](./use-cases/chat-ask-user.md) - the ask_user
  tool's suspend/resume lifecycle and the AskUserCard's
  pre-populated question/options.
- [chat-cutoff-retry](./use-cases/chat-cutoff-retry.md) - retrying a
  dead tail (partial-text cutoff or reasoning-only stall) red-outlines
  and replaces it rather than appending a continuation.
- [exchange-per-thread-slots](./use-cases/exchange-per-thread-slots.md) -
  per-thread streaming slot isolation: navigate away mid-stream and
  back, concurrent multi-thread streams, no throbber/text bleed.
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
- [curation-units](./use-cases/curation-units.md) - the venice
  function's five curation units (auto-title, thread topics, memory
  topics, recipe topics, summary) on both drivers: chat-turn tail
  and hourly sweep.
- [bias-pipeline](./use-cases/bias-pipeline.md) - the bias sweep's
  analyze and aggregate phases, their DB writes, and the
  diagnostics modal + prompt-block readers.
- [samskara-decay](./use-cases/samskara-decay.md) - the decay
  pass's three health nudges, exercised deterministically via SQL.
- [samskara-formation](./use-cases/samskara-formation.md) - the
  seven-phase formation rotation (assimilate through
  compound-regen) plus the mint toast surface.
- [samskara-association-mint](./use-cases/samskara-association-mint.md) -
  the sweep-only `mint-tier1-assoc` phase: minting from the
  association graph, the consumption stamp, mixed-kind provenance.
- [samskara-tier2-mint](./use-cases/samskara-tier2-mint.md) - the
  sweep-only `mint-tier2` phase: lift-gated co-fire constellation
  detection, seed iteration past covered groups, compound provenance.
- [attachments-lifecycle-ux](./use-cases/attachments-lifecycle-ux.md) -
  attaching files from the composer, waiting for processing,
  post-send previews, extracted-text drawers, and expired-file
  surfaces.
- [chat-generated-image-card](./use-cases/chat-generated-image-card.md) -
  the dedicated generated-image card resolving by filename and
  rendering without a reload (the per-round attach never echoes over
  realtime).
- [threads-management](./use-cases/threads-management.md) - thread title
  generation, manual rename pinning, topic-filter pills, and the
  per-thread multi-device reply lock.
- [memory-browser-actions](./use-cases/memory-browser-actions.md) - the
  Memories tab's browse/search/filter flows, edit/reaffirm/doubt,
  relate/unrelate, delete, and recall visibility.
- [wiki-editor-agent-update](./use-cases/wiki-editor-agent-update.md) -
  wiki article browse/search/create/edit/delete, per-article agent
  previews, and skipped-item retry/dismiss controls.
- [library-document-workflow](./use-cases/library-document-workflow.md) -
  Library upload, processing/searchability states, document-backed
  answers, and document management actions.
- [search-cross-tab](./use-cases/search-cross-tab.md) - the shared drawer
  search UX across Chats, Recipes, Memories, and Wiki, including
  scanner loading and substring fallback.
- [cookbook-recipe-lifecycle](./use-cases/cookbook-recipe-lifecycle.md) -
  recipe authoring in Cooklang, version log + revert, photos +
  lightbox, Upcoming / Favorites bookmarks, click-to-rate, the copy
  exports, and a model-driven recipe_save landing via the relay.
- [settings-account-and-updates](./use-cases/settings-account-and-updates.md) -
  Settings pane independence, update-check/reload flow, background-job
  toggles, usage refresh, and credential/export actions.
- [setup-config-transfer](./use-cases/setup-config-transfer.md) - first
  launch setup, local config persistence, and config-only export/import
  across browsers.
- [help-modal-docs](./use-cases/help-modal-docs.md) - the in-app Help
  modal: rendering the bundled user manual, internal `.md` link
  navigation with the Scanner transition, external-link new-tab, and
  heading-anchor scrolling.
- [auth-session-lifecycle](./use-cases/auth-session-lifecycle.md) - the
  Supabase auth gate, sign in/up toggle, sign out reset, and session
  restore on reload.
