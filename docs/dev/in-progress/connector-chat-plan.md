# Connector Chat Plan (nak half)

Status: PROPOSED - explicitly unscheduled, nothing here is
implemented. Co-written 2026-10-30 with the thatch coordinator
session (lucien-the-dream-librarian-00018, at Jeff's direction)
over thatch chat. This file is the NAK half; the shared contract
and the THATCH half live in the thatch repo
(`docs/plans/connector-chat.md`, commit c85e241, checkout at
~/dev/thatch), cross-referenced both ways. When this ever
graduates to real work, re-verify every citation against the code
of both repos as of that date.

Read [`../architecture.md`](../architecture.md) first (the
production-path ownership vocabulary and the app_config row in
"Where state lives"), plus [`../memory.md`](../memory.md) for the
headless server-side agent pattern this plan leans on.

## SYNOPSIS

Nak joins a thatch chat as a remote participant through thatch's
generic external-connector contract: a small Mac-resident driver
bridges thatch's `connector sync` primitive to a nak ingest
route; arriving mail lands as a real conversation thread for the
owner account; nak's existing headless-agent machinery fires a
chat turn over that history and writes the reply back for the
driver's next sync beat to carry out. Nak-the-assistant genuinely
replies - not a script wearing its name.

The bigger picture this is a piece of: the blue-sky self-fix loop
where nak is the front door and context layer (where Jeff talks,
what memories and skills ride along), opencode sessions are the
hands (shell, repo, toolchain), and thatch chat is the
coordination bus. This connector is nak's presence on that bus.
It is useful independently of the worker idea: any harness or
session on the machine could reach nak, and nak could reach them.

## The shared contract (normative source: the thatch doc)

A connector is a configured driver process that represents an
external message system as a thatch chat participant. Thatch's
contract is register (from explicit config, never self-minted) +
sync (one round trip per beat: drain undelivered mail as JSON,
accept inbound bodies, stamp delivered) + liveness by beat
(`host_kind: connector`, stale after ~3 missed beats, durable
mailbox) + no wake (poll-only by design). The wire format is
pinned in the thatch doc, including multi-part reassembly. The
thatch side is fully generic - nak is never named in it and is
merely the first candidate driver. Do not duplicate the contract
here; the thatth doc is normative.

## The driver

A small process resident on the machine where thatch lives
(Jeff's Mac). Two duties, one host: the same resident bridge the
parked worker idea wants (nak posts a job, an opencode session
runs it) - if both ever ship, they are one process, not two.
Host choice is open (launchd daemon vs an opencode plugin riding
the always-running shared opencode daemon); see Open questions.
The driver is nak-owned integration code but carries no nak
secrets beyond the per-connector ingest secret below.

## The ingest route

`POST /connector/ingest` on the venice edge function. Auth: a
per-connector secret held in `app_config` - the same
project-global, service-level config seam that holds the Venice
API key and the model price caps, written only by setup tooling
with no in-app editor and no write policy (the app_config row in
architecture.md's "Where state lives"). The driver holds the
publishable key plus this secret; it never holds the service key.
RLS stays the boundary: the route is b-strict (it stamps and
filters `user_id` against the configured owner, exactly the
service-role posture every edge tool already follows), and writes
only through the paths below.

## The proxy thread and its messages

Connector mail lands as ordinary conversation rows, not a
parallel store: a `threads` row flagged `connector` (the same
add-a-flag-to-threads idiom as `hidden`), messages appended by
the ingest route under the owner's id, replies appended by the
turn below. Riding the real `threads` / `messages` machinery is
the point - the chat loop, the transcript resolver, and the
persistence paths all work unmodified on a connector thread, and
the exclusions below are one-line eligibility filters keyed on
the flag, the same shape as the existing `not hidden` filters in
the background-job predicates.

## The headless connector turn

Nak already runs server-side agents with no browser attached -
the reflection sweep, the wiki fleet, the librarians
(`docs/dev/memory.md`) - and already runs route-triggered long
work detached under `EdgeRuntime.waitUntil` with progress
relayed over Broadcast (the manual librarian runs). The connector
turn is the same machinery pointed at the chat model: on ingest
(or a sweep backstop), fire a headless chat turn for the owner
account over the connector thread's history, using the standard
prompt assembly (the skills index, the metadata block, all of it
rides), append the reply to the thread, and mark it ready for
outbound sync. One turn per mail batch, reply-only in v1 - nak
never initiates a conversation unprompted (see Decisions).

## Owner isolation

The connector is scoped to the single configured owner account:
`owner_user_id` in `app_config`, stamped b-strict by the ingest
route on every write. Nak is effectively single-owner (the second
account on the deployment is Jeff's daughter, who has not used
it); the owner flag makes that de-facto state an enforced
boundary instead. No other account can appear in a connector
thread by construction.

## Subsystem exclusions

Connector threads are machine-coordination content, not human
conversation, and must not feed the user-modeling subsystems -
the same contamination class the tabled personas analysis
mapped (2026-10-12): reflection memories, samskara substrate,
the wiki agents, the bias observer, and the memory librarian
would all model the wrong thing from agent-to-agent traffic. The
`connector` thread flag enters the eligibility predicates the
same way `hidden` already does. The reverse direction needs no
new rule: a connector turn runs under the owner's normal
recall surfaces, which is exactly what makes nak's replies
useful to the other participants.

## Cost, loops, and liveness

A headless turn spends Venice credits per reply; the existing
app_config price caps and the per-turn budget machinery apply
unchanged. Anti-loop: one turn per mail batch, reply-only, and
thatch's existing anti-loop wake wording plus the echo filter
govern the other side. Roster liveness on the thatch side
reflects the driver's beat, not the model's turn; end-to-end
reply latency is beat interval + one headless turn, and the
driver's beat budget is the knob.

## Open questions

- Driver host: launchd daemon vs opencode plugin (the
  always-running shared daemon is already a resident host; the
  plugin answer reuses it, the launchd answer stands alone).
- Turn trigger: fire on ingest arrival (fastest, arrival-order
  quirks under bursts) vs a short sweep backstop (the curation
  tail + sweep shape). Leaning arrival-triggered with a sweep
  backstop, matching house precedent.
- Do connector threads appear in the threads drawer (visible
  history of nak's machine conversations) or stay out of the UI?
  Leaning visible but visually distinct.
- Mirrored from the thatch doc: push via the sideband socket; a
  blocking `connector wait` long-poll; whether connector
  participants are broadcast recipients.

## Deliberately out of scope

- The job-dispatch / worker bridge (nak posts a job, an opencode
  session executes it) - separate parked idea, same driver host.
- Nak initiating conversations (v1 is reply-only).
- Any non-thatch external system as a driver.

## Settled in the co-brainstorm (all subject to Jeff's veto when
this graduates)

- Poll-only; no push in v1 (thatch keeps its zero network
  surface).
- app_config holds the per-connector secret and owner_user_id;
  the driver never holds the service key; RLS untouched.
- Connector mail rides the real threads/messages machinery with
  a thread flag, not a parallel store.
- Reply-only v1; one headless turn per mail batch.
- Exclusions keyed on the thread flag in the eligibility
  predicates.
