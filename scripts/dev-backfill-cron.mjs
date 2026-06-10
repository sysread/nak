// ===========================================================================
// DEV SHIM - not used in production, not part of any deploy.
// ===========================================================================
//
// Stands in for the hosted pg_cron jobs that drive the venice
// function's scheduled routes.
//
// In production, supabase/schema.sql schedules six pg_net dispatches:
//   - `nak_trigger_embed_backfill()` every 5 minutes -> POST /backfill
//     (drains pending embeddings server-side);
//   - `nak_trigger_wiki_sweep()` hourly -> POST /wiki-sweep (runs the
//     autonomous wiki agent on day-gate-eligible threads);
//   - `nak_trigger_wiki_librarian_sweep()` hourly -> POST
//     /wiki-librarian-sweep (runs the librarian for the most-overdue
//     eligible user; the 12h cadence lives in its claim RPC);
//   - `nak_trigger_rem_sweep()` hourly -> POST /rem-sweep and
//     `nak_trigger_deep_sleep_sweep()` hourly -> POST /deep-sleep-sweep
//     (the two memory librarians; same most-overdue-user claim shape
//     with their own 12h cadences);
//   - `nak_trigger_reflection_sweep()` hourly -> POST /reflection-sweep
//     (reflection's catch-up drain - the chat-turn tail is the primary
//     driver, this reaches queues whose owners stopped conversing).
// The local Supabase stack (`mise run dev-start`) ships neither pg_cron
// nor pg_net, so those schedules are guarded to no-op locally - nothing
// drains any queue without this shim (the browser workers that used
// to do this work were deleted when the features moved server-side).
//
// This script reproduces exactly what the cron jobs do: every N seconds
// it POSTs each route on the LOCAL stack with the legacy service-role
// key, the same call pg_net makes in prod. One shared interval for all
// routes - prod cadences differ but locally you want fast feedback on
// whichever queue you're testing, and an empty-queue tick is nearly
// free.
//
// It is local-only by construction: it reads the stack endpoints from
// `supabase status` and refuses any non-loopback API target, so a shell with
// prod creds in the environment can never point it at the hosted project.
//
// See docs/dev/embeddings.md, docs/dev/wiki.md, and
// docs/dev/in-progress/venice-edge-functions/embeddings.md.
// ===========================================================================
import { runCapture } from './lib/shell.mjs';
import { banner, info, ok, warn, bail, style } from './lib/ui.mjs';

// Prod cron fires every 5 minutes; locally a tighter cadence gives faster
// feedback while testing. Override with the first CLI arg (seconds) or
// NAK_BACKFILL_INTERVAL.
const DEFAULT_INTERVAL_SECONDS = 60;

function parseInterval() {
  const raw = process.argv[2] ?? process.env.NAK_BACKFILL_INTERVAL;
  if (!raw) return DEFAULT_INTERVAL_SECONDS;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) {
    bail(`Invalid interval "${raw}".`, 'Pass a positive number of seconds.');
  }
  return n;
}

// Refuse anything but a loopback target. Mirrors the guard in
// scripts/dev-local.mjs - this shim must never reach the hosted project even if
// the ambient environment carries prod credentials.
function assertLoopback(url) {
  const host = new URL(url).hostname;
  if (host !== '127.0.0.1' && host !== 'localhost' && host !== '::1') {
    bail(
      `Refusing non-loopback API target: ${url}`,
      'This shim is local-only. Is the local stack actually running?'
    );
  }
}

// Read API_URL + the legacy JWT SERVICE_ROLE_KEY from the running local stack.
// The /backfill handler compares the bearer against its injected
// SUPABASE_SERVICE_ROLE_KEY, which the local functions runtime sets to this
// same legacy key - so this is the bearer that authenticates as the service
// role (the opaque sb_secret_ key is not a JWT and the gateway rejects it).
async function readLocalStack() {
  const res = await runCapture('supabase', ['status', '-o', 'json']);
  if (res.code !== 0) {
    bail('Could not read `supabase status`.', 'Is the local stack up? Run `mise run dev-start`.');
  }
  let s;
  try {
    s = JSON.parse(res.stdout);
  } catch {
    bail('`supabase status -o json` did not return JSON.', 'Check your supabase CLI version.');
  }
  if (!s.API_URL || !s.SERVICE_ROLE_KEY) {
    bail('supabase status is missing API_URL / SERVICE_ROLE_KEY.', 'CLI output shape changed.');
  }
  assertLoopback(s.API_URL);
  return { apiUrl: s.API_URL.replace(/\/$/, ''), serviceRoleKey: s.SERVICE_ROLE_KEY };
}

// POST one scheduled route with the service-role bearer and return the
// parsed JSON summary, or null on a transport/HTTP failure (already
// logged). Never throws - a failed tick logs a warning and the next
// tick retries, exactly as a fire-and-forget cron job would.
async function postRoute(apiUrl, serviceRoleKey, route, stamp) {
  try {
    const res = await fetch(`${apiUrl}/functions/v1/venice/${route}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${serviceRoleKey}` },
      body: '{}',
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      warn(`[${stamp}] ${route} HTTP ${res.status}: ${JSON.stringify(body)}`);
      return null;
    }
    // Agent sweeps run detached server-side (EdgeRuntime.waitUntil) and
    // acknowledge immediately - their outcomes land in the in-app Logs
    // drawer, not this response. Print the dispatch and stop here so
    // the per-route printers don't render an "unknown" summary.
    if (body && body.accepted === true) {
      info(`[${stamp}] ${route}: dispatched (runs async; outcome in the Logs drawer)`);
      return null;
    }
    return body;
  } catch (err) {
    warn(`[${stamp}] ${route} tick failed: ${err.message}`);
    return null;
  }
}

// One cron tick: POST /backfill and report the BackfillSummary.
async function tickBackfill(apiUrl, serviceRoleKey) {
  const stamp = new Date().toISOString().slice(11, 19);
  const body = await postRoute(apiUrl, serviceRoleKey, 'backfill', stamp);
  if (!body) return;
  const { embedded = 0, rejected = 0, noEmbedding = 0, errors = 0, rateLimited = false } = body;
  const headline = embedded > 0 ? style.green(`embedded ${embedded}`) : style.dim('nothing pending');
  const extras =
    rejected || noEmbedding || errors || rateLimited
      ? ` (rejected ${rejected}, noEmbedding ${noEmbedding}, errors ${errors}, rateLimited ${rateLimited})`
      : '';
  info(`[${stamp}] backfill: ${headline}${extras}`);
}

// One cron tick: POST /wiki-sweep and report the WikiSweepSummary.
async function tickWikiSweep(apiUrl, serviceRoleKey) {
  const stamp = new Date().toISOString().slice(11, 19);
  const body = await postRoute(apiUrl, serviceRoleKey, 'wiki-sweep', stamp);
  if (!body) return;
  const {
    claimed = 0,
    processed = 0,
    emptySlice = 0,
    skipped = 0,
    released = 0,
    claimLost = 0,
    errors = 0,
  } = body;
  const headline =
    claimed > 0 ? style.green(`claimed ${claimed}, processed ${processed}`) : style.dim('nothing eligible');
  const extras =
    emptySlice || skipped || released || claimLost || errors
      ? ` (emptySlice ${emptySlice}, skipped ${skipped}, released ${released}, claimLost ${claimLost}, errors ${errors})`
      : '';
  info(`[${stamp}] wiki-sweep: ${headline}${extras}`);
}

// One cron tick: POST /wiki-librarian-sweep and report the outcome.
async function tickWikiLibrarianSweep(apiUrl, serviceRoleKey) {
  const stamp = new Date().toISOString().slice(11, 19);
  const body = await postRoute(apiUrl, serviceRoleKey, 'wiki-librarian-sweep', stamp);
  if (!body) return;
  const { outcome = 'unknown', toolCalls = 0, articleCount = 0 } = body;
  const headline =
    outcome === 'reviewed'
      ? style.green(`reviewed ${articleCount} articles (${toolCalls} tool calls)`)
      : outcome === 'no-user'
        ? style.dim('nobody due')
        : outcome;
  info(`[${stamp}] wiki-librarian: ${headline}`);
}

// One cron tick: POST /rem-sweep and report the RemSweepSummary.
async function tickRemSweep(apiUrl, serviceRoleKey) {
  const stamp = new Date().toISOString().slice(11, 19);
  const body = await postRoute(apiUrl, serviceRoleKey, 'rem-sweep', stamp);
  if (!body) return;
  const { outcome = 'unknown', conversationsProcessed = 0, toolCalls = 0 } = body;
  const headline =
    outcome === 'reviewed'
      ? style.green(`reviewed ${conversationsProcessed} conversation(s) (${toolCalls} tool calls)`)
      : outcome === 'no-user'
        ? style.dim('nobody due')
        : outcome;
  info(`[${stamp}] rem: ${headline}`);
}

// One cron tick: POST /deep-sleep-sweep and report the DeepSleepSweepSummary.
async function tickDeepSleepSweep(apiUrl, serviceRoleKey) {
  const stamp = new Date().toISOString().slice(11, 19);
  const body = await postRoute(apiUrl, serviceRoleKey, 'deep-sleep-sweep', stamp);
  if (!body) return;
  const { outcome = 'unknown', toolCalls = 0, batchSize = 0 } = body;
  const headline =
    outcome === 'reviewed'
      ? style.green(`reviewed ${batchSize}-memory neighborhood (${toolCalls} tool calls)`)
      : outcome === 'no-user'
        ? style.dim('nobody due')
        : outcome;
  info(`[${stamp}] deep-sleep: ${headline}`);
}

// One cron tick: POST /reflection-sweep and report the cycle result.
async function tickReflectionSweep(apiUrl, serviceRoleKey) {
  const stamp = new Date().toISOString().slice(11, 19);
  const body = await postRoute(apiUrl, serviceRoleKey, 'reflection-sweep', stamp);
  if (!body) return;
  const { outcome = 'unknown', threadId = '', toolCalls = 0 } = body;
  const headline =
    outcome === 'reflected'
      ? style.green(`reflected thread ${threadId} (${toolCalls} tool calls)`)
      : outcome === 'no-thread'
        ? style.dim('nothing eligible')
        : outcome;
  info(`[${stamp}] reflection: ${headline}`);
}

// Run the scheduled routes sequentially, cheapest first, so the heavy
// LLM sweeps never queue the backfill tick behind them.
async function tick(apiUrl, serviceRoleKey) {
  await tickBackfill(apiUrl, serviceRoleKey);
  await tickWikiSweep(apiUrl, serviceRoleKey);
  await tickWikiLibrarianSweep(apiUrl, serviceRoleKey);
  await tickRemSweep(apiUrl, serviceRoleKey);
  await tickDeepSleepSweep(apiUrl, serviceRoleKey);
  await tickReflectionSweep(apiUrl, serviceRoleKey);
}

async function main() {
  const intervalSeconds = parseInterval();
  banner('Venice cron shim (DEV): backfill + wiki + memory-librarian + reflection sweeps');
  const { apiUrl, serviceRoleKey } = await readLocalStack();
  ok(`Targeting ${style.cyan(apiUrl)} every ${style.bold(intervalSeconds + 's')}. Ctrl-C to stop.`);
  info(style.dim('Local stand-in for the hosted pg_cron jobs (prod: backfill every 5 min, agent sweeps hourly).'));

  // Fire once immediately so you do not wait a full interval for the first run.
  await tick(apiUrl, serviceRoleKey);
  const timer = setInterval(() => void tick(apiUrl, serviceRoleKey), intervalSeconds * 1000);

  const stop = () => {
    clearInterval(timer);
    console.log('');
    ok('Cron shim stopped.');
    process.exit(0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

main();
