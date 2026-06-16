// Mint-toast delivery over Realtime Broadcast.
//
// A freshly minted tier-1/tier-2 samskara should pop the mood-pill toast
// in any open client. The formation pipeline runs server-side in the
// venice function (turn tail + hourly sweep), so the browser can't learn
// of a mint through an in-process callback - it needs a wire event.
//
// Delivery used to ride a postgres_changes INSERT subscription on the
// `samskaras` table. That forced `samskaras` into the supabase_realtime
// publication, and realtime.list_changes then decoded EVERY write to the
// table off the WAL to match it against subscriptions - including the
// fire-bookkeeping UPDATEs (fire_count / last_fired_at / health) the fire
// path bumps on every fire. Those updates outnumber inserts by ~10,000x
// (a 150-row pool took 20M+ updates vs 2k inserts), and no client ever
// subscribed to them - the toast only cared about INSERTs - so the
// decode-and-discard was the single largest consumer of database time.
//
// Broadcast carries only the event we explicitly send, so `samskaras`
// leaves the postgres_changes publication entirely (see
// supabase/schema.sql) and the fire-bookkeeping churn stops touching the
// WAL decoder. Transport mirrors edge-log.ts / agent-progress.ts: a POST
// to the Realtime broadcast endpoint under the service key, on the
// private `samskaras:<user-uuid>` topic the browser subscribes to.

export interface SamskaraMintDetail {
  tier: 1 | 2;
  valence: number;
  confidence: number;
}

export interface PublishSamskaraMintOpts {
  /** Override the broadcast transport. Tests inject a fake fetch. */
  fetchImpl?: typeof fetch;
  /** Override the project URL (defaults to SUPABASE_URL). */
  supabaseUrl?: string;
  /** Override the service key (defaults to SUPABASE_SERVICE_ROLE_KEY). */
  serviceKey?: string;
}

/**
 * Publish one mint event to the user's private topic. No-ops when the
 * Supabase env is absent, mirroring edge-log.ts - unit tests without a
 * stack still exercise the calling code.
 *
 * Best-effort and awaitable: a toast is decoration, never worth failing
 * a mint for, so a transport error is logged and swallowed rather than
 * propagated. The caller awaits so the POST settles before the route or
 * sweep tick returns, rather than risk the runtime dropping an in-flight
 * fetch (the same trailing-event hazard agent-progress.flush() guards).
 */
export async function publishSamskaraMint(
  userId: string,
  detail: SamskaraMintDetail,
  opts: PublishSamskaraMintOpts = {},
): Promise<void> {
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch;
  const url = opts.supabaseUrl ?? Deno.env.get('SUPABASE_URL') ?? '';
  const serviceKey =
    opts.serviceKey ?? Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
  if (!url || !serviceKey) return;

  const endpoint = `${url}/realtime/v1/api/broadcast`;
  const topic = `samskaras:${userId}`;
  try {
    const r = await fetchImpl(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        apikey: serviceKey,
        Authorization: `Bearer ${serviceKey}`,
      },
      body: JSON.stringify({
        messages: [
          { topic, event: 'samskara-mint', payload: detail, private: true },
        ],
      }),
    });
    if (!r.ok) {
      console.error(`[samskara-mint] broadcast HTTP ${r.status} topic=${topic}`);
    }
  } catch (e) {
    console.error(
      `[samskara-mint] broadcast fetch failed: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
}
