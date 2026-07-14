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
- [chat-reasoning-collapse](./use-cases/chat-reasoning-collapse.md) -
  the live reasoning panel's open / auto-collapse / manual-latch
  behavior and its elapsed-ms + char-count header pills.
- [chat-recall-agents](./use-cases/chat-recall-agents.md) - the
  mid-turn recall agents (memory_recall and siblings), their drawer
  sources, and memory_conversation seeding.
- [context-recall-priming](./use-cases/context-recall-priming.md) - the
  boundary-triggered recall pipeline: the smoothed, laundered, cited
  `<think>` recollection, its citations UI, the timeless reflection
  writer + librarian reshape that keep the store clean, and the umbrella
  `context` tool.
- [intuition-pipeline](./use-cases/intuition-pipeline.md) - the
  subconscious perception / drive / synthesis pipeline, its
  trigger and cache logic on `threads.intuition_payload`, and the
  `<think>`-tagged injection ahead of the next completion.
- [intent-mint-pipeline](./use-cases/intent-mint-pipeline.md) - the
  daily intent pass: the toggle-gated claim, efficacy evaluation
  (target-vs-control sampling into the posterior), the minter's
  create/retire/dormant/revive portfolio plan, and the run stamp.
- [intent-injection-toggle](./use-cases/intent-injection-toggle.md)
  - the chat-turn side: the `intentsEnabled` toggle, the "Working
  intentions" system-prompt block after the bias appendix under the
  shared cap, and the `intent_active_at_turn` snapshot.
- [intent-inspector](./use-cases/intent-inspector.md) - the read-only
  surfacing: the always-present seedling pill (copy and section
  toggle-gated), the shared modal's active/paused/let-go grouping,
  the honest efficacy labels, and the empty state.
- [intent-employment](./use-cases/intent-employment.md) - the
  settled-thread judge: the toggle/day-gated claim, the per-intention
  opening/acted/reaction writes to `intent_employments`, the
  efficacy-firewall check, and the minter consuming the telemetry.
- [followup-capture](./use-cases/followup-capture.md) - both
  follow-up writers (volitional `followup_create`, reflection
  backfill), the reschedule verb, the reflection close backstop, and
  the dedup between the writers.
- [followup-semantic-recall](./use-cases/followup-semantic-recall.md) -
  the open loop riding the context-recall gather with unresolved
  framing, and the close-on-answer lifecycle. Its baseline arm runs
  against PRE-feature code and reproduces the outcome hallucination -
  execute it before the feature branch merges.
- [followup-date-due](./use-cases/followup-date-due.md) - the
  date-due off-topic ask at thread open, the surfacing cooldown, and
  expiry.
- [followup-inspector](./use-cases/followup-inspector.md) - the
  always-present seedling pill, the follow-ups section of the shared
  inspector modal (groups + status chips), and the intents-off shape.
- [priming-disconnect-survival](./use-cases/priming-disconnect-survival.md)
  - proves turn-entry priming runs server-side under `waitUntil`: a turn
  whose tab closes mid-priming comes back fully primed, and the spinner
  / modals / log sources stay driven by the published priming events.
- [chat-ask-user](./use-cases/chat-ask-user.md) - the ask_user
  tool's suspend/resume lifecycle and the AskUserCard's
  pre-populated question/options.
- [chat-cutoff-retry](./use-cases/chat-cutoff-retry.md) - retrying a
  dead tail (partial-text cutoff or reasoning-only stall) red-outlines
  and replaces it rather than appending a continuation.
- [chat-stop-deliberate-abort](./use-cases/chat-stop-deliberate-abort.md) -
  the Stop button persists a `status='aborted'` row (marker-only even
  when nothing streamed), is never offered for retry, and reads the same
  on a second device.
- [chat-recovery-banner](./use-cases/chat-recovery-banner.md) - one
  recovery banner at the transcript tail, never stacked: precedence
  error > interrupted-draft > cut-off, suppressed while a live claim
  means the detached run is still finishing.
- [chat-pregame-refresh-reconnect](./use-cases/chat-pregame-refresh-reconnect.md) -
  refreshing during the pre-response pregame (priming) reconnects to
  the still-running server turn via the `stream_started_at` stamp
  instead of surfacing interrupted/cut-off retry banners.
- [exchange-per-thread-slots](./use-cases/exchange-per-thread-slots.md) -
  per-thread streaming slot isolation: navigate away mid-stream and
  back, concurrent multi-thread streams, no throbber/text bleed.
- [reflection-drain](./use-cases/reflection-drain.md) - the
  chat-tail drain, the hourly catch-up sweep, and the attempt cap.
- [wiki-fleet](./use-cases/wiki-fleet.md) - autonomous wiki sweep,
  skipped-thread retry, librarian sweep + manual run with live
  narration.
- [wiki-chat-crud](./use-cases/wiki-chat-crud.md) - the chat model's
  direct article + record writes (wiki_create / wiki_update /
  wiki_delete and record_create), gated behind the single wiki
  toolbox, with the gating-off control and changelog audit.
- [wiki-records](./use-cases/wiki-records.md) - dated records:
  manual add/edit/filter/search/export, the extraction sweep, the
  librarian promoting learnings while preserving records.
- [wiki-record-files-and-links](./use-cases/wiki-record-files-and-links.md) -
  attaching files to a record (panel + the record_file_attach tool's
  copy-from-chat), the directed labelled cross-link graph, and the
  wiki-record-file-gc orphan sweep.
- [memory-librarians](./use-cases/memory-librarians.md) - rem and
  deep-sleep sweeps, manual runs from the Memories panel, the
  shared in-flight guard.
- [realtime-relays](./use-cases/realtime-relays.md) - server-side
  writes refreshing open panels (wiki articles, memories, recipes),
  including DELETE delivery via the replica-identity indexes.
- [offline-cache](./use-cases/offline-cache.md) - favoriting to save a
  wiki article / recipe offline, reading it with no network, the
  read-only gating + photo placeholder, and cross-device eviction that
  never fires on a network blip.
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
- [settings-image-model-picker](./use-cases/settings-image-model-picker.md) -
  the Settings image-model dropdown, the imageModel settings round-trip,
  and generate_image resolving the configured model (with default
  fallback).
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
- [grocery-list-lifecycle](./use-cases/grocery-list-lifecycle.md) -
  the Groceries tab: ingredient checkboxes on bookmarked recipes,
  the recipe-edit invalidation wipe, the needed / acquired shopping
  flow, add-input history suggestions, section management, and item
  photos.
- [settings-account-and-updates](./use-cases/settings-account-and-updates.md) -
  Settings pane independence, update-check/reload flow, background-job
  toggles, usage refresh, and credential/export actions.
- [settings-custom-prompts](./use-cases/settings-custom-prompts.md) - the
  Custom prompts pane: add/edit/delete autosave, drag-and-drop reorder,
  and the order flowing through to the chat composer's prompt toggles.
- [settings-model-profiles](./use-cases/settings-model-profiles.md) - the
  Model profiles pane: the seeded starter profile, add/edit/delete with
  the exactly-one-default and last-profile invariants, unique-name
  validation gating the autosave, catalog re-snapshot on a model pick,
  and drag reorder.
- [chat-model-profile-selection](./use-cases/chat-model-profile-selection.md) -
  the composer's profile picker pinning `threads.model`, send-path
  resolution of model/reasoning/verbosity through the profile, the
  pickers badging profile defaults (including Off), and the
  deleted-profile / legacy-tier fallback to the default profile.
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
- [appearance-terminal-style](./use-cases/appearance-terminal-style.md) -
  the terminal UI style: the Style picker's live apply, `data-style`
  on `<html>`, square/flat/borderless rendering with side-border chat
  bubbles in both color modes, boot-cache reload (including legacy
  two-field blobs), and Supabase sync of `uiStyle`.
