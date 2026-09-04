# Chat: a hard-killed turn is buried within a minute

## Covers

The liveness heartbeat (`threads.stream_heartbeat_at`) and its three
readers - the `/stream` probe's dead-turn janitor, the browser's
freshness rule, and the `nak_sweep_stale_streams` cron - plus the live
drain's silence watchdog ([dev: chat](../../dev/chat.md), [dev:
exchange](../../dev/exchange.md)).

The shape it proves: the edge runtime hard-kills the streaming
function mid-turn (CPU-time budget exceeded, container loss). No
finally runs, so no terminal row write, no END event, and no socket
drop - the browser's Broadcast channel stays healthy and simply goes
quiet. Before the heartbeat, the streaming row's age was the only
liveness signal and the ceiling was ~12.7 minutes: the throbber spun
that long, Stop published a cancel nobody heard, Regenerate attached
to the dead turn through the duplicate-send guard, and a refresh's
reconnect poll waited the whole fuse out.

Sibling cases: [chat-streaming-turn](./chat-streaming-turn.md) step 5
covers the janitor from a fresh send;
[chat-pregame-refresh-reconnect](./chat-pregame-refresh-reconnect.md)
covers the heartbeat keeping a LIVE turn's reconnect armed.

## Preconditions

- Local stack up (`mise run dev-start`), signed in as the dev user
  (`dev@nak.local` / `devpass123`).
- A thread with at least one completed exchange.
- A way to kill the function mid-turn. Locally the honest way is
  stopping the edge-runtime container while a reply streams
  (`docker stop <supabase_edge_runtime container>`); the forged
  variant below reproduces the same DB state without a kill and is
  enough for the janitor and cron expectations, but not for the
  live-tab watchdog (step 2), which needs a real silent channel.

## Steps

1. Send a message that produces a long reply (ask for a multi-section
   essay). While text is streaming, kill the function (see
   Preconditions). Leave the tab open and do not touch Stop.
2. Watch the live tab for up to 90 seconds.
3. In a second tab, open the same thread ~20 seconds after the kill
   (heartbeat still fresh).
4. In the first tab, after the banner appears, click the retry
   affordance on the cut-off card.
5. Forged variant, for the cron sweep (no kill needed): forge a
   streaming row with a stale heartbeat and wait for the next minute
   boundary without opening the thread:

   ```sql
   insert into messages (thread_id, role, status, content)
   values ('<thread>', 'assistant', 'streaming', 'orphan');
   update threads set stream_heartbeat_at = now() - interval '2 minutes'
    where id = '<thread>';
   ```

## Expected

- **(2)** Within about 90 seconds (one or two 30s silence probes past
  the 60s heartbeat ceiling) the throbber gives way to the partial
  reply rendered as a normal card with the "lost mid-stream" error
  banner beneath it. The Logs drawer's `stream` source shows the
  probe verdict flip from `in-flight(row)` to `quiet`; the `venice`
  source shows the drain handing off on a disconnect. No 12-minute
  wait.
- **(3)** The second tab shows the "Reconnecting" throbber (the
  reconnect poll), then resolves to the same cut-off card once the
  heartbeat ages past 60s - the poll's probe is what runs the
  janitor. `messages.status` on the orphan is `error`,
  `threads.last_error` carries the lost-mid-stream message, and
  `threads.stream_heartbeat_at` is null.
- **(4)** Retry streams a fresh reply in one step; the successful
  commit clears `last_error`.
- **(5) [hosted]** Within a minute of the forge, without any
  `/stream` call, the cron sweep flips the forged row to `error`,
  writes `last_error`, and nulls the heartbeat. Locally the same
  holds when pg_cron is available in the image.
- Throughout: Stop or Regenerate clicked BEFORE the heartbeat ages
  out attaches to the dead turn (the duplicate-send guard still sees
  it as alive) and resolves through the same watchdog within the
  minute; neither leaves a second streaming row behind.

## Cleanup

Delete the forged orphan row if a later send did not already bury it:

```sql
delete from messages where content = 'orphan' and thread_id = '<thread>';
update threads set last_error = null where id = '<thread>';
```

## Results log

Append-only. Every row carries date, environment, and commit. Do not
overwrite prior rows.

| Date | Environment | Commit | Result | Notes |
| --- | --- | --- | --- | --- |
| pending | local | branch claude/stuck-conversation-debug-pm9i6m | not yet executed | Authored with the fix; needs a manual run against a running stack (cloud agent has no browser). Incident baseline (pre-fix, hosted, 2026-09-04): function killed at 22:53:21 with `CPU Time exceeded`, probe reported `in-flight(row)` until ~23:06, cut-off card appeared only after the 760s fuse. |
