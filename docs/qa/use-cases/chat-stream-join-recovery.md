# Chat: stream-channel join fails, the exchange rescues or degrades cleanly

## Covers

The pre-subscribe join rescue in `streamChatViaFunction`
([dev: chat](../../dev/chat.md)) - the bounded join attempt, the
teardown + fresh-socket nudge retry, and the kind-'network' error card
whose Retry re-enters the same exchange context. This is the path that
used to hard-fail with a raw "Channel TIMED_OUT" card (and could hang
"Thinking" forever when the join queued on a disconnected socket).

## Preconditions

- Local stack up (`mise run dev-start`), signed in as the dev user.
- Access to docker (to stop/start `supabase_realtime_nak`).
- A thread to drive (any).

## Steps

1. Baseline: send a short message; the reply streams normally.
2. Outage path: `docker stop supabase_realtime_nak`, then send a
   short message.
3. Recovery path: `docker start supabase_realtime_nak`, wait a few
   seconds, then click the Retry button on the Network error card.
4. DB check (before step 3 if separating them): the failed send left
   an orphaned user row (role=user, no assistant row following) in
   the transcript's thread.

## Expected

- Step 2: the exchange spins through two bounded join attempts
  (~30s total), then shows a "Network error" card with
  "Check your network, then retry", Retry and Dismiss. No raw
  "Channel TIMED_OUT" text, no stuck spinner.
- Step 3: the same exchange context re-fires; the orphaned user row
  from step 2 is answered in place - no duplicate user message.
- Step 1 and 3 both leave `threads.last_error` null (the turn
  committed normally); the join failure never touches
  `threads.last_error` because the turn never started.
- Healthy-path sends behave exactly as before (no retry cost).

## Results log

| Date | Env | Commit | Result | Notes |
| ---- | --- | ------ | ------ | ----- |
| 2026-09-09 | local | 144ecc13 (pre-fix) | fail (2) | Baseline send streamed fine; with realtime stopped the send hard-failed with "chat exchange failed Error: Channel TIMED_OUT" after ~10s and left an orphaned user row (prod's exact signature). An immediate retry also failed. A later send after realtime recovered worked. Second observed pre-fix shape: a join queued while the socket reconnect loop ran hung the exchange silently ("Thinking" 20+ min, no error, no POST) because the phoenix push timeout never starts on an unsent push. |
| 2026-09-09 | local | 78cdb59a (post-fix) | pass (1-4) | Healthy path unchanged (ACK turn). Outage path: two bounded attempts (~30s), then the Network error card (advice + Retry + Dismiss) instead of raw TIMED_OUT. With realtime restored, Retry re-fired the same exchange context and answered the orphaned user row (ACK4 at 16:18, no duplicate row). Unit tests cover the retry loop (tests/stream-transport-join.test.ts). |
