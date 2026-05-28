// ===========================================================================
// DEV SHIM - not used in production, not part of any deploy.
// ===========================================================================
//
// Stands in for the hosted pg_cron job that drives embedding backfill.
//
// In production, supabase/schema.sql schedules `nak_trigger_embed_backfill()`
// every 5 minutes via pg_cron; it POSTs to the venice function's /backfill
// route through pg_net. The local Supabase stack (`mise run dev-start`) ships
// neither pg_cron nor pg_net, so that schedule is guarded to no-op locally -
// nothing drains the embedding queue without an open browser tab anymore (the
// browser worker was deleted when backfill moved server-side).
//
// This script reproduces exactly what the cron job does: every N seconds it
// POSTs to the LOCAL /backfill route with the legacy service-role key, the same
// call pg_net makes in prod. Run it alongside `mise run dev-start` when you want
// the queue to drain on a cadence locally instead of hand-running the curl.
//
// It is local-only by construction: it reads the stack endpoints from
// `supabase status` and refuses any non-loopback API target, so a shell with
// prod creds in the environment can never point it at the hosted project.
//
// See docs/dev/embeddings.md and
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

// One cron tick: POST /backfill and report the BackfillSummary the function
// returns. Never throws - a failed tick logs a warning and the next tick
// retries, exactly as a fire-and-forget cron job would.
async function tick(apiUrl, serviceRoleKey) {
  const stamp = new Date().toISOString().slice(11, 19);
  try {
    const res = await fetch(`${apiUrl}/functions/v1/venice/backfill`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${serviceRoleKey}` },
      body: '{}',
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      warn(`[${stamp}] backfill HTTP ${res.status}: ${JSON.stringify(body)}`);
      return;
    }
    const { embedded = 0, rejected = 0, noEmbedding = 0, errors = 0, rateLimited = false } = body;
    const headline = embedded > 0 ? style.green(`embedded ${embedded}`) : style.dim('nothing pending');
    const extras =
      rejected || noEmbedding || errors || rateLimited
        ? ` (rejected ${rejected}, noEmbedding ${noEmbedding}, errors ${errors}, rateLimited ${rateLimited})`
        : '';
    info(`[${stamp}] ${headline}${extras}`);
  } catch (err) {
    warn(`[${stamp}] tick failed: ${err.message}`);
  }
}

async function main() {
  const intervalSeconds = parseInterval();
  banner('Embedding backfill cron shim (DEV)');
  const { apiUrl, serviceRoleKey } = await readLocalStack();
  ok(`Targeting ${style.cyan(apiUrl)} every ${style.bold(intervalSeconds + 's')}. Ctrl-C to stop.`);
  info(style.dim('Local stand-in for the hosted pg_cron job (prod runs every 5 min).'));

  // Fire once immediately so you do not wait a full interval for the first run.
  await tick(apiUrl, serviceRoleKey);
  const timer = setInterval(() => void tick(apiUrl, serviceRoleKey), intervalSeconds * 1000);

  const stop = () => {
    clearInterval(timer);
    console.log('');
    ok('Backfill shim stopped.');
    process.exit(0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

main();
