# Image Turn Resilience Plan

Status: SHIPPED 2026-11-02 (merged to main; deploy runs on the merge
CI - edge functions only, no schema, no frontend). QA results in
`docs/qa/use-cases/chat-image-turn-resilience.md` (prod baseline FAIL
row + live dev-stack pass, both turns green). Refinement record:
three review rounds (round 1 deep-mode: seven lenses; rounds 2-3
quick-mode fresh-context reviewers), round-3 verdict no blockers with
both audits PASS. Implementation deltas from the as-proposed text
below: the "repeat 400 naming an already-stripped field" strip test
ALSO flips (calls 2 -> 3: the strip retry and the http retry have
separate budgets, so a deterministic 400 that survives both costs
three calls); the hard-stop byte cap gates on the attachment row's
`size_bytes` BEFORE downloading (no wasted download of a part the cap
will reject). The plan text below is the as-proposed record.

## SYNOPSIS

Three changes to how streamed chat turns survive failures, all
server-side in the venice edge function, with zero browser diff:

1. **Auto-retry pre-event HTTP and network failures.** A
   `kind: 'http'` VeniceError (any non-2xx Venice status other than
   401/403/429) or a pre-event `network` failure currently aborts the
   turn immediately. These always fail before the first streamed
   event, so re-issuing the identical body is safe. Retry once after
   a short fixed backoff, alongside the existing rate-limit and
   truncation retry classes in `withRateLimitRetry`.
2. **Inline owned image attachments as data URIs at the edge.** The
   `/stream` route currently relays the browser's body verbatim, and
   image attachments ride as signed Storage URLs that Venice fetches
   server-side. A fetch failure (slow Storage, transient error) fails
   the whole turn with a user-facing 400. Instead, `handleStreamFresh`
   downloads each owned image attachment service-role and swaps the
   part to a `data:` URI before the round chain starts. Ownership is
   verified against the already-validated thread; anything that fails
   verification or download degrades to today's signed-URL behavior.
3. **Preserve the HTTP status through the error-signal boundary.**
   The streaming error path drops `err.status` when building
   `threads.last_error` input, so kind `http` errors translate through
   the no-status branch of `translateError` (`retryable: true`
   regardless of status). Our incident wrote a status-400 failure to
   `threads.last_error` with `retryable: true` while nothing anywhere
   retried it.

Terminology used throughout: **pre-event** means a failure thrown
before the first stream event of an attempt yields (the `!emitted`
state in the retry wrapper). The `retryable` flag on error surfaces is
**user-facing guidance** ("try again" advice), not a description of
what the system does automatically.

## PURPOSE

Prod incident, 2026-11-02, thread `5a500304-53cd-4daa-94cf-29f713fcdd7f`
("Easy no-prep dinner ideas"). The user pasted two screenshot WebPs
(94 KB / 72 KB) into a message at 20:59 UTC. The paste turn succeeded.
The next turn (21:36:05) succeeded. The turn after (send 21:36:19)
failed 18 seconds in:

> Venice HTTP 400: {"error":"A remote image URL in the request could
> not be used. Remote images must be public http(s) URLs on the default
> port that answer quickly with a PNG, JPEG, GIF, WebP, BMP, TIFF, ICO,
> AVIF or HEIC image within the size limit. Send the image as a data:
> URI (base64) instead."}

(The incident record above was established this session against the
prod database - thread row, message rows, attachment rows, storage
objects - not from this repo; the repo-checkable consequences
(`classifyHttpError`'s message template, the retryable-flag mechanics)
are verified below.)

Nothing expired. Both storage objects were live, `expired_at` null, and
the send path mints fresh 1-hour signed URLs on every send
(`src/screens/Chat.svelte:4397-4410` -> `createAttachmentSignedUrls`,
default 3600 s, `src/lib/supabase/messages.ts:218-246`). The identical
construction had worked twice in the preceding 40 minutes. The failure
was a transient Venice-side fetch of a fresh, valid, public URL, and it
killed the turn outright. `threads.last_error` recorded it as
`kind: 'http'`, `retryable: true` - guidance the system did not act on.

Two structural weaknesses produce that outcome:

- Every send in a vision thread re-inlines every image in history as a
  signed URL, and Venice re-fetches all of them server-side on every
  turn, for the life of the thread. Any single slow or erroring fetch
  400s the whole turn, however old the image or fresh the URL.
- The retry machinery has no class for this failure. `withRateLimitRetry`
  (`supabase/functions/venice/getStreamingCompletion.ts:304-410`) retries
  exactly three things: pre-event rate limits (3 attempts,
  Retry-After-aware), mid-stream truncations (2 attempts), and a
  strict-validation 400 naming a droppable wire field (strip and
  retry immediately). A generic `http` kind falls through all three
  branches and rethrows (`getStreamingCompletion.ts:381-385`).

The Venice error text itself prescribes the durable fix ("Send the
image as a data: URI (base64) instead"). The codebase already runs an
edge-side download-and-inline pattern on the `analyze_image` path
(`attachmentObjectAsDataUrl`, `supabase/functions/venice/tools/_vision.ts:68-86`),
recorded there for environment-reachability reasons (local-dev
127.0.0.1 URLs, container-internal hostnames, unreliable
host-detection - `_vision.ts:49-67` and `docs/dev/image-editing.md:136`).
This plan applies the same pattern to the chat path for a different,
complementary reason: removing the per-turn Venice fetch dependency
entirely.

## CURRENT MECHANICS (verified 2026-11-02)

**Wire construction, browser side.** On send,
`src/screens/Chat.svelte:4397-4410` collects every live image
attachment in the thread (`mime_type` starts `image/`,
`storage_path` non-null) and mints fresh signed URLs via
`SupabaseService.createAttachmentSignedUrls` (1-hour TTL,
`src/lib/supabase/messages.ts:221`). `buildHistoryOnWire`
(`Chat.svelte:4412-4434`) projects every message row through
`toVeniceMessage` (`src/lib/chat/prompt-assembly.ts:681-720`), which
calls `buildUserVeniceContent` (`src/lib/attachments.ts:556-625`); each
image with a resolved URL becomes a `{type: 'image_url'}` content part
(`attachments.ts:618-623`). History replay re-inlines all of them on
every send. Attachment rows without `storage_path` never reach the
wire (`attachments.ts:597-604`).

**The body ships verbatim.** The browser builds the full Venice wire
body via `buildChatBody` and posts it to `/stream`
(`StreamRequestBody.body`, `supabase/functions/venice/index.ts:1012-1021`:
"the browser builds this ... ships it verbatim; this route does not
reshape it"). `handleStream` hands it to `getStreamingResponse`, whose
round loop re-sends the same `messages` each round with round results
appended (`getStreamingResponse.ts:538-539`) - so anything inlined at
body receipt rides every round, including on tool-heavy turns.

**Error classification.** Non-2xx Venice responses throw
`VeniceError(kind)` from `classifyHttpError`
(`getStreamingCompletion.ts:617-644`): 401/403 -> `auth`, 429 ->
`rate_limit`, everything else -> `http` with the status attached. A
non-2xx status is known at fetch-open, before any event yields
(`streamFromVenice` throws at `getStreamingCompletion.ts:445`), so an
`http` error is always a pre-event failure. Pre-event connect failures
throw `network` (`getStreamingCompletion.ts:438-443`) - the only
`network` throw in the file. Mid-stream read failures throw `parse`
(`getStreamingCompletion.ts:555-558`); early stream cuts throw
`truncated` - a distinct kind that already retries mid-stream.

**Retry signal contract.** The `stream_retry` signal exists
(`_shared/venice-stream.ts:171`) but its `reason` field is the literal
`'truncated'`, mirrored in the browser's own event union
(`src/lib/venice.ts:466`), and the browser transport drops any
`stream_retry` whose reason is not `'truncated'`
(`src/lib/chat/stream-transport.ts:486-494`, "Drop the event if the
wire shape skews"). The orchestrator consumes the signal
reason-agnostically (accumulator + streaming-row reset,
`getStreamingResponse.ts:755-781`) and logs it with a hardcoded
"truncated stream" label (`getStreamingResponse.ts:756-757`).

**Terminal surfacing, and where the status drops.** The error event is
built by `errorEventFor` (`getStreamingCompletion.ts:729-761`):
`rate_limit`/`network` -> `retryable: true`, everything else `false`.
The error StreamSignal type has **no `status` field**
(`_shared/venice-stream.ts:143-149`), so when the round-loop consumer
builds `lastErrorInput` from an error signal
(`getStreamingResponse.ts:729-732`) only `{ kind, rawMessage }` exist.
The orchestrator's separate thrown-VeniceError catch already preserves
status (`getStreamingResponse.ts:1249-1255`), which confirms the signal
boundary is the only leak. At terminal write,
`getStreamingResponse.ts:1540-1563` runs `translateError`
(`supabase/functions/_shared/error-translate.ts:98-136`), whose `http`
case uses the status when present and falls to `retryable: true` when
absent (131-135). The browser's error-signal consumers read only
`kind`/`message`/`retryable` (`stream-transport.ts:495-506`,
`stream-events.ts:319-336`), so adding an optional field is inert
browser-side.

**Retry wrapper callers.** `withRateLimitRetry` is internal to the
streaming path only (`withGuards` wraps it per guard attempt,
`getStreamingCompletion.ts:183, 204`); `getStreamingCompletion` has
exactly one production caller, the round loop
(`getStreamingResponse.ts:648`). The agent fleets and `/complete` use
`veniceComplete` (`tools/_venice_complete.ts:133`), which keeps its own
policy and is untouched by this plan. The only browser caller of
`/complete` is the grocery section classifier
(`src/lib/grocery-section-agent.ts:200`), which is text-only.
(The browser does retry 429 on `/complete` itself - 5 attempts,
Retry-After-aware, `venice-proxy.ts` - a different route and out of
scope; see D1.)

**Existing retry tests.** `supabase/functions/tests/streaming-completion-strip.test.ts`
and `streaming-completion-empty.test.ts` exercise the wrapper through
injected `fetchImpl` fakes (collect helper, 400-then-200 sequences).
The rate-limit and truncation branches have **no tests today** (grep
for `rate_limit_wait` / `stream_retry` / `rate_limit_resolved` in
`tests/` returns none) - see Test-first pre-work.

## PROPOSED APPROACH

### Test-first pre-work (before any behavior change)

1. Pin the two untested retry branches in the existing
   `streaming-completion-*` fake-`fetchImpl` harness: a 429-then-ok
   sequence honoring `retryAfterMs` (rate-limit branch), and a
   cut-stream-then-ok sequence (`truncated` branch). These guard the
   insertion on both sides.
2. Add the `status?: number` field to the error StreamSignal variant
   (Change 3 edit 1 - type-only, no consumer yet), THEN add an
   orchestrator-harness test (`tests/orchestrator.test.ts`) driving a
   status-bearing `http` error through a round and asserting the
   `threads.last_error` payload (kind, status, retryable), before
   touching the consumer. Ordering matters: the test does not compile
   against the shared type until the field exists.

### Change 1: retry pre-event `http` and `network` failures once

In `withRateLimitRetry` (`getStreamingCompletion.ts:304-410`), add a
branch mirroring the truncation branch:

- `HTTP_MAX_ATTEMPTS = 2` (one automatic retry), fixed
  `HTTP_RETRY_BACKOFF_MS = 1500`.
- Trigger: `err instanceof VeniceError && (kind === 'http' || kind ===
  'network')` AND `!emitted` (no event yielded this attempt) AND not
  aborted. Both kinds throw pre-event in practice, so `!emitted` is
  belt-and-suspenders rather than load-bearing, but it keeps the
  "mid-stream is terminal" invariant for anything unexpected and stays
  defensive against future kinds landing in the trigger.
- **No `stream_retry` signal is emitted by this branch.** The branch
  is reachable only when nothing has been yielded, so there is nothing
  to reset, and the signal's `reason` field is literal-typed
  `'truncated'` on both runtimes with the browser dropping any other
  reason - widening two mirrored unions to send a signal the browser
  would discard violates D5 for zero observability gain. Observability
  comes from the function-side log line instead (below).
- Abort-aware sleep via the existing `sleepCancellable`.
- Do NOT touch `auth`, `parse`, or the strict-validation branch, which
  keeps priority ahead of this branch (its `continue` fires first).
- Deterministic 400s (malformed body, "maximum context length
  exceeded") will now cost one retry: bounded waste (1.5 s + one body
  re-upload) accepted because the incident's transient failure was
  itself a 400 and cannot be told apart from a deterministic one by
  status alone. This deliberately diverges from `ff53788e`'s
  `/complete` policy ("excludes 4xx: they will not improve on a
  re-send") for the streaming path; the 2-attempt cap is what bounds
  the cost. Recorded here so the tension is a decision, not a
  discovery.
- The guards wrapper re-enters `withRateLimitRetry` per guard attempt,
  so attempt counters reset per guard attempt (worst case ~10 Venice
  calls per round); the 380 s wall deadline
  (`getStreamingResponse.ts:150`, `WALL_DEADLINE_MS = 380_000`) and
  abort-aware sleeps bound the composition. Accepted.
- Log a line on each automatic retry (`[withRateLimitRetry] pre-event
  <kind> failure; retrying (attempt N)`) so the Logs drawer carries
  the observability AC2 asks for. For tests, make the backoff
  injectable like `veniceComplete`'s `retrySchedule` injection
  (ff53788e precedent) so the fake-`fetchImpl` tests do not sleep the
  real 1.5 s.

Two existing tests flip deliberately: `streaming-completion-strip.test.ts`
"a 400 naming a non-droppable field is terminal" (line 191) and "a
mandatory-reasoning 400 with no disable_thinking in the body is
terminal" (line 264) currently assert `calls === 1`; after Change 1
they assert `calls === 2` and their names are updated to say "terminal
after one retry" so the test names do not lie.

### Change 2: inline owned image attachments as data URIs in `handleStreamFresh`

"Owned image attachments" includes both user pastes and generated
images - both are `message_attachments` rows with bucket-shaped
`storage_path`, both carry the same Venice-fetch risk, and the walker
deliberately does not distinguish them.

New module `supabase/functions/venice/inline-images.ts` (top-level
placement matches the established flat-helper convention of
`broadcast.ts`, `empty-rows.ts`, `feature-rejections.ts`,
`stream-guards.ts`, `stream-probe.ts`). Two separately-exported pieces
so the walker unit-tests against a fake downloader:

```ts
walkImageParts(body): Array<{ container, index, url }>   // pure
inlineAttachmentImages(adminClient, body, threadId): Promise<{ inlined: number; bytesInlined: number }>
```

- `walkImageParts` traverses `body.messages` content arrays for
  elements shaped `{type: 'image_url', image_url: {url}}` whose URL
  matches the signed-URL shape
  `/storage/v1/object/sign/attachments/<user-uuid>/<attachment-uuid>/<rest>`.
  No existing helper traverses message content parts (the
  `_shared/venice.ts` walkers operate on top-level body fields only),
  so this walker is genuinely new surface. The literal signed-URL
  prefix appears nowhere in-repo (it is Supabase Storage's standard
  shape); a test pins the regex against a real minted URL during
  implementation.
- Ownership: the plan reuses the thread-scoped idiom already
  established by `findImageAttachmentByFilename`
  (`tools/_image_ops.ts:97-120`): select the `message_attachments` row
  by attachment id with `messages!inner(thread_id)`, scoped to the
  request's `threadId`. `resolveStreamContext`
  (`stream-probe.ts:118-134`) has already proven
  `thread.user_id === userId` at stream entry, so thread scoping
  closes the cross-user hole (service role bypasses RLS) without a
  second join leg. The row's `storage_path` must also equal the path
  from the URL.
- Download + encode: reuse `attachmentObjectAsDataUrl`
  (`tools/_vision.ts:68-86`) rather than reimplementing - import
  precedent across module boundaries exists (`agents/*.ts`,
  `priming/*.ts` import from `tools/` regularly). Its
  throw-on-failure contract is what the caller wants: catch and
  degrade. Byte counts come from the downloaded bytes
  (`bytes.length`), with `base64ByteLength` (`_image_ops.ts:304-307`)
  available if a post-encode count is ever needed.
- **Whole-phase budget, sequential downloads.** A per-download
  timeout alone is not enough: N hanging URLs would stack N x 10 s
  inside the synchronous envelope POST. Downloads run SEQUENTIALLY,
  newest-first, under a single 15 s whole-phase deadline; the
  hard-stop byte cap (above) ends the walk early on size, and the
  deadline ends it early on time - whichever fires first. When either
  trips, every remaining part degrades to its URL and the phase
  returns. Sequential order is what makes the cap's memory claim true:
  with concurrent downloads the in-flight peak is the sum of ALL
  candidate images before the cap could bind (twenty 4 MB generated
  PNGs would peak ~80 MB), defeating the memory bound this exists for.
  The whole inline phase still runs before `EdgeRuntime.waitUntil`
  work begins, so its cost is bounded and visible.
- **Per-download timeout** (10 s proposed) wrapping each download +
  encode, so one hanging Storage fetch degrades that part to its URL
  and the walk continues, instead of one hung image sacrificing the
  rest of the phase budget to the deadline. Degrade on timeout
  exactly like on error.
- **Body mutation in place.** `inlineAttachmentImages` mutates
  `body.messages` in place, the same deliberate convention as the
  strict-validation strip path
  (`getStreamingCompletion.ts:318-323`).
- **Ownership lookup batched.** The candidate attachment ids from one
  body resolve in one `in`-query (thread-scoped, per the idiom above)
  rather than per-part lookups.
- **Degrade = current behavior.** No match, ownership failure,
  download failure, or timeout leaves the part untouched; Venice
  fetches the signed URL exactly as today. Every failure mode
  collapses to the incident's status quo.
- **Newest-first walk order** so the byte cap evicts the OLDEST
  history images, not the anchor turn's. Walking in history order
  would inline oldest first and drop the newest images back to URLs -
  exactly the ones the current turn is about. The anchor message is
  the last user turn; walk from the tail.
- **Byte cap, hard stop.** Walk newest-first, accumulating raw bytes;
  the first part that would push the total past the cap is SKIPPED,
  and so is every older part after it (no partial-budget weirdness -
  the cap is a hard stop, simple to test). All skipped parts keep
  their signed URLs.
- **Byte cap calibration.** The 8 MB raw cap exists to bound
  edge-isolate memory; inlined data URIs ride
  EVERY round (`bodyTemplate.messages` re-sent per round,
  `getStreamingResponse.ts:538-539`), so 8 MB raw is
  ~10.7 MB base64 re-uploaded per round on tool-heavy turns. The cap
  bounds edge-isolate memory (the isolate has a hard kill behavior;
  incident record at `getStreamingResponse.ts:117-127` and
  `docs/dev/plans/tool-batch-resilience-plan.md`). The 8 MB value is a
  guess - reviewers flagged no precedent; adjust if the envelope shows
  stress.
- Log a summary line (`[inline-images] inlined=N bytes=B`) for the
  Logs drawer.

Call site: `handleStreamFresh` (`index.ts:1087-1184`), after the
`ctx.inFlight` early-return (line 1112) and after the price-cap check
(lines 1136-1147), before the orchestrator kick (line 1162) - so
double-sends and 403s never pay for downloads, and all rounds plus all
retry attempts inherit the inlined body. `handleStreamReconnect`
(lines 1196-1215) reads only `threadId` and never carries a body, so
the fresh path is the only call site. Priming sub-calls fan out
text-only (`extractUserText`, defined `supabase/functions/venice/priming.ts:815`,
call sites 541 and 629, flattens multimodal content to text parts), so
inlined data URIs never ride the priming Venice calls.

### Change 3: preserve `err.status` through the error-signal boundary

Three named edits (the leak site is known, not to be "located"):

1. `_shared/venice-stream.ts:143-149`: add `status?: number` to the
   error StreamSignal variant.
2. `errorEventFor` (`getStreamingCompletion.ts:729-737`): populate it
   from `VeniceError.status`.
3. The round-loop consumer (`getStreamingResponse.ts:729-732`): carry
   `status` into `lastErrorInput`.

The thrown-error catch (`getStreamingResponse.ts:1249-1255`) already
passes `err.status`; this completes the pattern one layer up. Browser
blast radius is nil: the browser's error consumers read only
`kind`/`message`/`retryable` (`stream-transport.ts:495-506`), so the
optional field is inert - D5 holds. After the fix, a status-400 `http`
error translates through the status branch of `translateError`
(honest prose, `retryable: false`) instead of the no-status branch
(`retryable: true` for everything).

UX delta to own explicitly: `retryable: false` removes the error
card's Retry button (`src/lib/ui/completion-status.ts:566, 620-631`
via `parseLastError`), so for a transient 400 that survived the
automatic retry, manual re-send (send a new message) is the only
lever. Accepted - "retry it" advice on an error the system already
retried once is honest.

## DECISIONS

- **D1 - Retry lives edge-side, in the streaming path only.**
  `withRateLimitRetry` is the established home for streamed-turn
  retries (rate-limit and truncation retry already live there,
  server-side only, and the browser never retries a streamed turn).
  The browser's 429 retry on `/complete` is a separate route-level
  policy and stays untouched.
- **D2 - Inline at body receipt, once, edge-side.** Not per-round, not
  in the round loop, not browser-side. History: the chat path once
  shipped browser-side data URIs (pre-2026-05-29, base64-in-Postgres)
  and left them via `8107c536`'s storage-bucket migration for
  thread-load reasons - edge-side inlining does not reverse that
  tradeoff (the browser->edge request stays lean; only the
  colocated edge->Storage hop does the download).
- **D3 - Ownership by thread-scoped join, not URL trust.** The signed
  URL token is not validated; the attachment id from the path is
  looked up scoped to the already-validated thread
  (`_image_ops.ts` idiom). A failed check degrades to the URL as-is.
- **D4 - One retry, fixed short backoff.** These are pre-event
  failures where the request never reached inference; longer schedules
  only add wall-clock. Two attempts total. The deliberate divergence
  from `/complete`'s 4xx-exclusion policy is recorded at Change 1.
- **D5 - Browser-visible behavior unchanged.** No frontend change
  ships in this plan. The one wire-level delta (Change 3 adds an
  optional `status` field to the error stream signal over the
  Broadcast channel) is additive and ignored by old browsers, whose
  error handler reads exactly `kind`/`message`/`retryable`
  (`stream-transport.ts:495-506`). The mixed-version window (old
  browser / new function, and reverse) is therefore trivially safe:
  inlining is additive, image parts keep their Venice shape, and both
  sides of the window already tolerate signed URLs.
- **D6 - Scope excludes** mid-stream `network` retry (moot as of this
  writing: mid-stream read failures throw `parse`, which stays
  terminal - there is no mid-stream `network` kind; the
  accumulator-reset mechanic exists via the truncation branch if that
  ever changes), the signed-URL render TTL on the display side
  (cosmetic, separate), and the `/complete` route (its only browser
  caller, the grocery section classifier, is text-only - verified at
  `src/lib/grocery-section-agent.ts:200`). Note:
  `docs/dev/architecture.md` currently claims `/complete` is used only
  by the intuition pipeline; that is stale (intuition's models run
  server-side) and gets corrected in the implementation PR per the
  repo's doc convention, alongside the stale header comment at
  `error-translate.ts:6-8` (it claims the browser imports
  `translateError`; it no longer does). The doc sweep should also
  glance at `docs/dev/chat.md` for error-kind narration needing the
  same pass (unverified whether it needs it).

## ACCEPTANCE CRITERIA

1. A `kind: 'http'` or pre-event `network` failure retries once
   automatically; a second consecutive failure terminates the turn with
   the error surfaces (terminal row status + `threads.last_error`,
   carrying the status-bearing translation from Change 3).
2. The retry is observable in the function-side Logs drawer (the
   `[withRateLimitRetry]` retry line); no new stream-signal contract
   is introduced.
3. `threads.last_error` for a status-400 `http` error reports
   `retryable: false` with the status-bearing prose (status no longer
   lost at the signal boundary).
4. A `/stream` body whose image parts point at the caller's owned
   image attachments (pastes and generated images alike) arrives at
   Venice as data URIs, not signed URLs, for all parts within the
   byte cap.
5. A body referencing another user's attachment path, a nonexistent
   attachment, or an expired row (null `storage_path`) inlines nothing
   and fails nothing - parts pass through untouched.
6. Inlining respects the per-request byte cap with the hard-stop rule;
   the first over-cap part and every older part keep their signed
   URLs, so eviction always takes the oldest history images first.
7. All existing gate checks stay green (`mise run check`); new Deno
   tests cover: the retry class (fake `fetchImpl` sequence 400-then-ok
   and 400-then-400), the newly-pinned rate-limit and truncation
   branches, the ownership-verified inline walk (owned, cross-user,
   missing, expired, over-cap, download-failure degrade), the
   signed-URL regex against a real minted URL shape, the
   status-preserving error translation (orchestrator harness), and the
   two deliberately-flipped strip tests.
8. The local dev stack can exercise image-paste chat turns end-to-end
   (the internal-host signed-URL limitation documented at
   `_vision.ts:55-58` and `docs/dev/image-editing.md:136` dies for the
   chat path) - verified in QA.

## VALIDATION

- `mise run check` in the worktree (gate includes the Deno island:
  `functions-check` + `functions-test`).
- Targeted: `pnpm exec deno test --check supabase/functions/tests/` for
  the new retry + inline tests.
- QA use-case: extend `docs/qa/use-cases/` (attachments or
  chat-streaming) with an image-thread scenario: paste two images,
  send, assert the turn completes; then force a first-attempt 400 via a
  stub and assert the automatic retry recovers. Log both runs. The QA
  pass should also exercise a multi-image body large enough to probe
  Venice's aggregate request-size tolerance for data URIs (unverified
  upper bound - the error text confirms a per-image limit exists, none
  documented for the whole request).
- Prod verification plan: after deploy, resend the failed turn in
  thread `5a500304...` and confirm completion; edge logs show the
  inline summary line.

## RELEASE PLAN

- Edge function only: `mise run functions-deploy` (or the CI deploy
  chain). No schema change, no frontend change, no feature flag.
- Rollback: redeploy the previous function revision. Inlining and
  retrying are stateless per request.
- Mixed-version window: nothing to do (D5).

## NOTES (for refinement reviewers)

- **Mid-stream `network` retry** is moot today (mid-stream read
  failures throw `parse`, which stays terminal); if a future kind
  makes it real, the accumulator-reset mechanic exists via the
  truncation branch (D6).
- **Byte cap value** (8 MB raw): no precedent in history; calibrated
  against the per-round re-upload reality (inlined data URIs ride
  every round). A reviewer with a better bound on the edge isolate's
  safe envelope should adjust.
- **`errorEventFor`'s retryable flag** (`getStreamingCompletion.ts:735`)
  stays untouched: it feeds live-stream UI state, not the terminal
  card, and the terminal card's honesty comes from Change 3 instead.
  The flag's semantics are user-facing guidance (see SYNOPSIS), which
  keeps AC3 and Change 1 consistent.
- **Per-round re-upload**: accepted for capped sizes; the alternative
  (per-round re-inlining or turn-count heuristics) was rejected at the
  alternatives lens as strictly worse than the byte cap.
- **Unverified upper bounds**: Venice's aggregate request-size limit
  for data-URI bodies, and the edge isolate's memory envelope for a
  full 8 MB inline - both empirical, both covered by the QA pass.
