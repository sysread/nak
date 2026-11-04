# Agent Sweep Verification Plan

Extend the wiki-records self-report verification (shipped 2026-11-03 in
44a03528) to the article sweep tick and the librarian runs, which share
the same false-success shape: the agent's final reply is stored verbatim
as the durable `wiki_agent_log` row and nothing checks it against the
writes it claims.

## SYNOPSIS

- The article sweep tick (`runWikiSweepTick`), the manual retry, and the
  librarian's three run paths each store `reasoning` in
  `wiki_agent_log` with zero post-run verification. A run that claims
  it updated or merged articles but wrote nothing is indistinguishable
  from an honest no-op.
- Fix: count the user's `wiki_changelog` rows before and after the run
  (lifetime per-user head count - no time window, no clock comparison);
  when the reply claims a write and the count did not move,
  console.warn and append the `[unverified self-report: ...]`
  annotation to the stored reasoning. Same conventions as the shipped
  wiki-records fix: warn-and-annotate only, matcher errs in the miss
  direction, count failure degrades to skip, no auto-retry, no pointer
  or claim contract changes.
- One production-for-testability change the fix owns explicitly: a
  `complete` test seam threaded through the librarian's sweep tick and
  review runner (the house pattern wiki.ts already uses), so the
  librarian harness can script model rounds without a network.
- Riders: docs (dev + user), QA use-case rows.

## DECISIONS (resolved scope, do not re-litigate)

- **D1 - Selector is a lifetime per-user head count, not a tag or a
  time window.** The changelog table has no thread, run, or source
  column (schema.sql:12638-12666: `user_id`, `article_id`, `kind`,
  `title_at_change`, `message`, `created_at`, plus the later
  `chars_before/after` pair), and stamping one would be a schema +
  tool-contract change, out of scope. A time-window selector
  (`created_at >= tBefore` with the host clock) would compare the edge
  host's clock to the DB's `now()`; a trailing DB clock could hide an
  honest run's rows past `tBefore` and falsely annotate it. The
  lifetime count avoids clocks entirely: count
  `wiki_changelog where user_id = userId` before the run and after it.
  - A concurrent writer for the same user (article tick, librarian
    tick, browser edit) can only ADD rows, inflating the after-count
    and masking a false claim - a miss, which is the allowed error
    direction.
  - Accepted edge (warn-only makes it tolerable): `reset_wiki_data`
    deleting rows mid-run could shrink the after-count below the
    before-count and produce a spurious annotation; a user wiping
    their wiki mid-sweep is rare enough to accept.
- **D2 - No kind filter, but the guarantee is "best effort in, honest
  annotation out".** Every agent write path (article create/update/
  delete and record create/update/delete, including record link/file
  attach which ride `record_update`) lands a changelog row through
  `appendWikiChangelog`
  (`supabase/functions/venice/tools/_wiki_helpers.ts:50-64`), so a
  plain all-kinds count covers every claim the agents can make.
  However, the changelog insert is best-effort by design: article
  save/delete swallow insert errors (`bestEffortChangelog`, tools/
  wiki.ts:293-319) and `appendWikiChangelog` silently no-ops on an
  empty title or message (_wiki_helpers.ts:55-57). So an honest run
  whose changelog insert silently failed can still be annotated.
  Warn-only, and the annotation carries both counts, so the audit row
  stays truthful either way - this is the same softened guarantee the
  shipped fix documents.
- **D3 - The manual retry path is in scope.** `retryWikiThread`
  (wiki.ts:1503-1517) stores the same verbatim reasoning with the same
  zero verification and is the same agent over the same writes. The
  coordinator's citation named the sweep tick; the retry is the
  identical shape one function over, so it gets the same treatment
  rather than a conscious deferral of a known identical defect. The
  annotation intentionally flows to the retry route's returned
  `reasoning` (wiki.ts:1518), so the Skipped panel's chip shows the
  marker too - that panel is the audit surface, and the user seeing
  the marker is the point.
- **D4 - Shared helpers, not a one-size wrapper.** The librarian's
  three sites (scheduled, manual, chat) all funnel through
  `runLibrarianReview` and none has a claim to lose after the run, so
  a `runLibrarianReviewVerified` wrapper (before-count, run,
  after-count, annotate the raw `finalText`) serves all three; the
  sites' existing `normaliseReasoning` keeps the annotation on the
  stored row. The article agent's two sites have different post-run
  claim bookkeeping (the sweep tick gates on `markWikiProcessed`
  succeeding; the retry gates on `manual_advance_wiki_pointer`
  succeeding), so verification there is inline in each done branch
  using the shared count + matcher helpers - mirroring the shipped
  done-branch shape exactly. One matcher per agent file, exported via
  `__test` like the shipped one. The wrapper brackets only the
  librarian run itself, so a chat round that wrote an article earlier
  in the same turn is inside the before-count and cannot perturb the
  delta in either direction.
- **D5 - Matchers are per-agent.** The article agent's prompt contract
  is "name the article(s) you touched" (wiki.ts:892-907, examples use
  "Updated the Nak article ..."); the librarian's is "name the
  articles you merged or deleted" (wiki_librarian.ts:644-664, examples
  use "Deleted 'Kermit protocol' as out-of-scope; merged the two
  'Maya' articles"). One matcher each, tuned to its prompt's verb
  inventory, both following the shipped discipline (below).
- **D6 - No schema changes, no new tables, no auto-retry, no changes
  to pointer/lease/day-gate contracts.** The article sweep's
  unconditional pointer advance on a done run (wiki.ts:1292-1297) and
  the librarian's cadence stamp at claim time
  (wiki_librarian.ts:1448-1455) are untouched.
- **D7 - The librarian `complete` test seam is part of this fix.**
  `runWikiLibrarianSweepTick(adminClient)` takes no options and
  `runLibrarianReview`'s args have no completion seam
  (wiki_librarian.ts:1456-1458, :1345-1353, runner call :1401-1423),
  so its harness cannot script model rounds. The fix threads an
  optional `complete` through the sweep tick opts and the review args
  into `runHeadlessAgent` - the exact seam wiki.ts already exposes
  (wiki.ts:1207-1208). Undefined in production, so production behavior
  is unchanged.

## VERIFIED MECHANISM (citations re-verified at branch tip 5e89fab2, contains daf92e10)

### The shipped pattern being replicated (wiki_records.ts)

- Done branch: `runWikiRecordsSweepTick` captures
  `recordsBefore = await countRecordsForThread(...)` at
  wiki_records.ts:614 before `runExtractionOnThread`, and in the done
  branch (wiki_records.ts:628-646, after `markRecordProcessed`
  succeeds) re-counts; when `claimsRecordCreation(reasoning)` and the
  count did not move, it console.warns and appends
  `[unverified self-report: claimed record creation, but wiki_records
  rows for this thread went from N to M]` to the reasoning stored by
  `appendWikiAgentLog` (wiki_records.ts:652-659).
- Matcher (wiki_records.ts:115-121): affirmative
  `(logged|created|recorded|added)` before `(records?|events?)` in a
  `{0,3}`-word same-sentence window; negation guard
  `/\b(no|none|zero|not|never)\b|n't\b/i` with the documented
  no-word-boundary-inside-contractions lesson; documented miss
  direction ("some honest no-op phrasings may still be annotated -
  warn-only").
- Count helper returns `null` on any failure and the caller skips
  verification (wiki_records.ts:123-140) - the tripwireArmed
  precedent; a count failure can never fail the run.

### Site 1 - the article sweep tick (supabase/functions/venice/agents/wiki.ts)

- `runWikiSweepTick`'s done branch is at wiki.ts:1292-1318 (was
  :1283-1303 at the 5eee96fa reading): `markWikiProcessed` advances the
  pointer unconditionally on a done outcome, then `outcome.reasoning`
  is stored verbatim via `appendWikiAgentLog` (wiki.ts:1304-1311) with
  zero verification.
- The agent's write surface: toolbox is the wiki combo (op=save /
  op=delete), the records combo, record_link_create,
  record_file_attach, analyze_image, and memory_search
  (wiki.ts:924-936). Every write in that set lands a `wiki_changelog`
  row (article kinds and record kinds alike - see D2).
- Final-reply contract (wiki.ts:892-907): "name the article(s) you
  touched, or name the reason you skipped"; example claims: "Updated
  the Nak article with March 2026 logo-brainstorm details"; example
  no-ops: "No edits - the conversation was generic technical Q&A
  about regex with no user-centric subject."

### Site 2 - the librarian runs (supabase/functions/venice/agents/wiki_librarian.ts)

- Three sites store `normaliseReasoning(result.finalText)` verbatim:
  scheduled tick wiki_librarian.ts:1506-1511, manual run :1572-1577,
  chat dispatch :1636-1641 (were :1495-1501, :1561-1567, :1625 at the
  5eee96fa reading). All three call `runLibrarianReview`
  (wiki_librarian.ts:1367-1429).
- The librarian's write surface: librarian wiki tool (op=save with
  existing-id requirement, op=delete), records combo, record link
  create/delete, conversation search/get, memory_search
  (wiki_librarian.ts:441-454). Writes land changelog rows same as
  site 1.
- Final-reply contract (wiki_librarian.ts:644-664): "name the articles
  you merged or deleted"; example claims: "Deleted 'Kermit protocol'
  as out-of-scope; merged the two 'Maya' articles into one"; example
  no-ops: "Left 'Maya' and 'household' separate - ..."; "No edits -
  wiki is small and coherent."

### Site 3 - the manual retry (supabase/functions/venice/agents/wiki.ts, D3)

- `retryWikiThread` runs `runWikiAgentOnThread` and stores the
  reasoning verbatim at wiki.ts:1510-1517 (triggerSource 'retry') with
  zero verification. Same agent, same writes, same selector (lifetime
  per-user count - D1; the thread is known here but the changelog
  cannot key on it).

## FIX SHAPE

1. **wiki.ts**: add `countChangelogForUser(adminClient, userId)`
   (verbatim port of the shipped count helper's null-on-failure
   contract, wiki_records.ts:126-140, aimed at `wiki_changelog` by
   `user_id` only) plus the `claimsArticleEdit` matcher (D5). Inline
   verification in the two done branches:
   - Sweep tick: capture the before-count next to the claim logging
     (before `runWikiAgentOnThread`), then after `markWikiProcessed`
     succeeds, re-count and annotate `outcome.reasoning` per the
     shipped conditional (claim && both counts non-null && equal).
   - `retryWikiThread`: same sequence around `runWikiAgentOnThread`,
     gated on `manual_advance_wiki_pointer` succeeding (the annotation
     flows to the returned `reasoning` too - D3).
   Annotation wording (review R2 folded: "an edit", not "an article
   edit" - record claims route through the same matcher):
   `[unverified self-report: claimed an edit, but wiki_changelog rows for this user went from N to M]`.
2. **wiki_librarian.ts**: `runLibrarianReviewVerified` wrapping
   `runLibrarianReview` (D4): before-count, run, after-count, and on
   the shipped conditional append the annotation to `result.finalText`
   (the sites' `normaliseReasoning` preserves it on the stored row).
   The three sites consume it unchanged otherwise. Annotation wording
   mirrors the shipped convention with the librarian's claim
   vocabulary.
3. **Matchers** (D5), both conservative, verb-before-noun
   `{0,3}`-word window, negation guard = the shipped one plus
   `nothing` (`/\b(no|none|zero|not|never|nothing)\b|n't\b/i` - the
   extra token closes "Merged nothing this run; 'Maya' stays as is",
   which the quoted-title alternative would otherwise match; strictly
   widens the guard, so it only ever suppresses annotations):
   - Article: `(updated|created|saved|wrote|added|deleted|edited)` x
     `(articles?|entry|entries|pages?|records?)`.
   - Librarian: `(merged|deleted|updated|saved|consolidated|folded|combined|rewrote|renamed|edited)`
     x `(articles?|entry|entries|pages?|duplicates?|records?)` OR a
     quoted title `['"][^'"]+['"]` in the window (the prompt's own
     example claim "Deleted 'Kermit protocol' as out-of-scope" names a
     quoted title, not the word "article").
   - The `nothing` token's job is the semicolon-free sibling of the
     prompt's no-op examples ("Merged nothing and 'Maya' stays as
     is"); a semicolon already blocks the filler window.
   - Both files carry the shipped miss-direction comment: the matcher
     can miss a false claim and some honest no-op phrasings may still
     be annotated - warn-only, annotation carries both counts.
   - The `n't` alternative keeps NO leading word boundary - none
     exists inside a contraction (the shipped lesson).
4. **Ordering contract** (same as shipped): before-count strictly
   before the run, after-count strictly after it and before the
   reasoning annotation and the `appendWikiAgentLog` insert.
5. **Failure degradation**: either count returning null skips
   verification entirely; a thrown count is caught inside the helper.
   Verification never changes the run's outcome, the summary counters'
   semantics, or the pointer/cadence contracts.
6. **Librarian `complete` seam** (D7): optional `complete` on the
   sweep tick's options and the `runLibrarianReview` args, forwarded
   to `runHeadlessAgent`; undefined everywhere in production.

## TESTS

Per the house pattern (wiki_records_sweep.test.ts is the template;
per-file stub harness - scripted RPCs, FIFO table queues, injected
`complete`):

- **wiki_sweep_verification.test.ts** (new, Deno): characterization +
  flip around the sweep tick's done branch -
  1. honest success: claim + moved count -> stored unannotated;
  2. honest no-op: "No edits - ..." + unmoved count -> unannotated;
  3. false claim: claim + unmoved count -> console.warn + annotation
     stored (characterization: today the reasoning stores clean);
  4. count failure (error entry): run completes, no annotation;
  5. ordering ledger: before-count, run, after-count, log-insert;
  6. matcher matrix: affirmative claims, honest no-ops, contracted
     negations ("hasn't", "didn't" - no `\b` before n't), passive
     reference-style past tense (accepted miss), mixed-sentence
     negation suppression, `nothing` suppression, and a record-write
     claim by the article agent ("Added a record about the promotion")
     - the article matcher's `records?` noun covers the article
     agent's record tools too.
- **wiki_librarian_verification.test.ts** (new, Deno): same harness
  shape driving `runWikiLibrarianSweepTick` through the new `complete`
  seam (FIX SHAPE 6): claim user, inflight claim, min-articles
  passthrough, scripted review round; plus the librarian matcher
  matrix including the quoted-title claim shape ("Deleted 'Kermit
  protocol' as out-of-scope") and the honest no-op shapes from the
  prompt ("Left 'Maya' and 'household' separate", "No edits - wiki is
  small and coherent.", "Merged nothing and 'Maya' stays as is").
  Built fresh on the wiki_records_sweep.test.ts stub pattern -
  wiki_librarian.test.ts is pure `__test` unit tests with no stub
  admin to reuse.
- **Manual retry + librarian manual/chat sites**: the retry's
  verification is the same inline shape as the sweep tick's and is
  covered by the helper-level assertions plus one honest-success path
  through `retryWikiThread` (it already accepts a `complete` option,
  wiki.ts:1432; the stub harness scripts its four RPCs -
  claim_wiki_thread_for_retry, compute_wiki_terminal_msg_id,
  manual_advance_wiki_pointer, release_wiki_thread_retry_claim - plus
  the transcript/threads/app_config/profiles/message_attachments
  queues). The librarian manual and chat sites are thin consumers of
  the wrapper - one honest-success path each (manual via
  `runWikiLibrarianManual`, chat via the `wiki_librarian` ToolDef).

## DOCS

- **docs/dev/wiki.md**: extend the self-report verification note
  (currently only on the record-extraction entry point,
  docs/dev/wiki.md:668-677) to the article sweep, the manual retry,
  and the librarian (all three paths): same count-before/after shape,
  lifetime per-user changelog count instead of the thread-keyed
  `wiki_records` count (and why - D1), warn-and-annotate-only
  contract unchanged.
- **docs/qa/use-cases/wiki-fleet.md** (the sweep/librarian use case)
  and **docs/qa/use-cases/wiki-records.md**: add result-log rows for
  the new annotation behavior per the append-only results discipline;
  add the annotation check to the expected sections where the log
  drawer is read.
- **docs/user/wiki.md**: extend the `[unverified self-report]`
  story (docs/user/wiki.md:436-439). The marker now also covers the
  article agent's and librarian's log rows, the manual librarian
  run's result text in the Wiki panel, and the retry chip. The user
  doc must say "could not be verified" (an edit whose changelog entry
  silently failed counts too - D2), not "did not land"; reword the
  shipped records sentence in the same pass so the extended story
  inherits the honest frame rather than the overclaim.
- **User-visible surface inventory** (the annotation can appear on):
  sweep/librarian/retry `wiki_agent_log` rows (the log drawer), the
  manual librarian run's returned `finalText` (Wiki panel result,
  wiki_librarian.ts:1581), the chat-dispatch tool's `summary` field
  (which the chat model may relay into the transcript,
  wiki_librarian.ts:1643), and the retry route's returned `reasoning`
  (the Skipped panel chip, wiki.ts:1518). All warn-only, all carrying
  both counts.

## MILESTONES

- **M0**: this plan committed to the branch; refined via
  fresh-context reviewer rounds until consensus; coordinator approval.
- **M1**: wiki.ts verification (helpers, matcher, two sites) +
  wiki_sweep_verification.test.ts green.
- **M2**: wiki_librarian.ts verification (seam, wrapper, matcher,
  three sites) + wiki_librarian_verification.test.ts green.
- **M3**: docs + QA use-case rows; `mise run check` green before every
  commit; diff summary + test results + QA rows to the coordinator.

## OPEN QUESTIONS for the coordinator

- None blocking. D3 (retry path in scope, annotation shown on the
  retry chip) is the one judgment call made without an explicit
  instruction - flagged here and in the message to the coordinator for
  veto.

## ACCEPTED RISKS (from refinement round 1, kept open by design)

- `reset_wiki_data` mid-run can produce a spurious annotation
  (D1) - rare, warn-only.
- Best-effort changelog inserts (swallowed errors, empty title or
  message) can annotate an honest run (D2) - warn-only, both counts
  recorded.
- The matchers miss passive reference-style phrasings and mixed
  sentences carrying any negation token - the allowed miss direction;
  the shipped fix accepted the same shapes.
