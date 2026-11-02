# Chat: image-paste turn resilience (edge inline + pre-event retry)

## Covers

The `/stream` inline phase (`venice/inline-images.ts`: owned image
attachments swapped to data URIs at body receipt,
[dev: attachments](../../dev/attachments.md)) and the streaming
wrapper's pre-event http/network retry branch
(`withRateLimitRetry` in `getStreamingCompletion.ts`,
[dev: chat](../../dev/chat.md)).

## Preconditions

- Local stack up (`mise run dev-start`), signed in as the dev user.
- A vision-capable chat model selected (the inline phase only matters
  when the wire carries image parts; the retry branch applies to every
  turn).
- Motivating prod baseline (2026-11-02, thread `5a500304-53cd-4daa-
  94cf-29f713fcdd7f`): two pasted WebP screenshots rode every send as
  fresh signed URLs; two turns succeeded, then the third failed 18 s
  in with `Venice HTTP 400: A remote image URL in the request could
  not be used...` when Venice's server-side fetch failed transiently.
  `threads.last_error` recorded `kind:'http'`, `retryable:true` - and
  nothing retried it. That failure shape is the "before".

## Steps

1. Paste two images into the composer (clipboard paste, not file
   attach), type a short question, send.
2. When the turn settles, open the Logs drawer and filter Source to
   `stream`. Look for the inline summary line
   (`[inline-images] inlined=N bytes=B`).
3. Verify the wire the model saw: the turn completes without any
   image-related 400. For the deep check, set `NAK_DUMP_STREAM=truthy`
   on the functions serve and confirm the dumped request frames carry
   `data:image/...` URLs for the pasted images, not
   `/storage/v1/object/sign/...` URLs.
4. Continue the thread with a text-only follow-up (history replay
   re-ships the images) and confirm it also completes - the inline
   phase runs per send, so the data URIs are re-minted every turn and
   Venice's fetch dependency stays gone.
5. Pre-event retry (unit-covered, not forceable live without a
   stub): `mise exec -- deno test --allow-env --config
   supabase/functions/deno.json supabase/functions/tests/streaming-completion-retry.test.ts`
   - the 400-then-ok and reject-then-ok cases pin the one-shot retry,
   the 400-then-400 case pins the terminal, and the mid-stream break
   case pins "no post-emission retry".

## Expected

- Step 2: `inlined=2 bytes=~221000` (the two pastes, raw bytes summed;
  browser-compressed WebPs land ~100 KB each).
- Steps 3-4: no image-related 400 anywhere; the model answers about
  the images. The thread does NOT become poisoned for later sends
  (the pre-fix local behavior was: one image upload 400s every
  subsequent send because Venice cannot reach `127.0.0.1` signed
  URLs).
- Step 5: all tests pass (`400` then ok -> completed with no
  stream_retry signal; second consecutive 400 -> terminal kind http;
  mid-stream break -> terminal, exactly 1 fetch call).

## Cleanup

None - pasted images persist as normal attachments; delete the thread
from the sidebar if it was created just for this run.

## Results log

| Date | Env | Commit | Result | Notes |
| ---- | --- | ------ | ------ | ----- |
| 2026-11-02 | prod (linked project) | pre-fix main | FAIL (baseline) | The motivating incident: paste turn + one later turn ok, third send died on a transient Venice fetch of a fresh signed URL; last_error said retryable:true, nothing retried. |
| 2026-11-02 | unit gate (worktree) | this branch | pass (5) / - (1-4, live) | 4 retry-branch pins + 3 flips green pre-change (rate-limit/truncation pinned first); 11 inline-images tests green (walker, ownership degrade, byte-cap hard stop, timeouts, deadline); orchestrator last_error status test green. Live pass on the dev stack pending - no stack/browser in the worktree session; run 1-4 with the post-change pass and log both rows. |
| 2026-11-02 | local (dev-start from the worktree, change code live) | this branch | pass (1-4) | Live pass complete, closing the pending row. Two ~180KB noise PNGs pasted via synthetic ClipboardEvent on the composer (drove the real onComposerPaste handler); both composer chips attached. Send 1: turn completed, model answered about the images (via analyze_image per image - the tool path, unaffected); log line `[inline-images] inlined=2 bytes=360438`. Send 2 (text-only, history replay): answered from the inlined history WITHOUT re-calling analyze_image ("Noise - random multicolored pixel static") - the replayed wire carried the data URIs; second `[inline-images] inlined=2` line. threads.last_error null after both; 2 live attachment rows; pre-fix local behavior (image upload poisons every later send) is gone. Stack bounced for garrick's M2 after (teardown clean). |
