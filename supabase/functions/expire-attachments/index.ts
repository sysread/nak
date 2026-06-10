// The `expire-attachments` edge function - the server-side replacement for the
// old browser attachment_expiry worker (Stage 2 of the attachments-storage
// migration). Cron-triggered (pg_cron -> pg_net -> here; see
// nak_trigger_attachment_expiry in schema.sql). Service-role only.
//
// It is deliberately NOT a route on the `venice` function: expiry never calls
// Venice, it only deletes Supabase Storage objects and marks rows, so it has no
// business sharing that function. The auth/client helpers below are duplicated
// from venice/index.ts on purpose - keeping the two functions independent is
// worth a few lines over coupling them through a shared module.
//
// The sweep orchestration is pure and unit-tested in
// ../_shared/expire-attachments.ts; this file owns only the glue: auth, the
// service-role client, and wiring the RPC + Storage I/O into the deps.
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
// edge-log is a _shared module like the expiry driver itself, so importing it
// here doesn't breach the "no helpers shared with venice/index.ts" stance in
// the header - that stance is about the auth/client glue, not _shared.
import { createEdgeLogger } from '../_shared/edge-log.ts';
import { runExpiry, type ExpireDeps } from '../_shared/expire-attachments.ts';

const CORS_HEADERS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

// Dormancy window (days since the owning thread's updated_at) and per-
// invocation bounds. Hourly cron + a generous cap keeps each tick small; the
// next tick resumes if a backlog ever exceeds the cap.
const EXPIRY_DAYS = 30;
const BATCH_SIZE = 100;
const MAX_ROWS = 2000;
const TIME_BUDGET_MS = 25_000;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
  });
}

function adminClient(): SupabaseClient | null {
  const url = Deno.env.get('SUPABASE_URL');
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!url || !serviceKey) return null;
  return createClient(url, serviceKey, { auth: { persistSession: false } });
}

// True when the bearer's decoded `role` claim is service_role. Safe to trust
// the decoded payload only because the gateway's verify_jwt has already
// validated the signature (see the longer note in venice/index.ts). Do NOT
// disable verify_jwt for this function without replacing this with signature
// verification.
function isServiceRole(req: Request): boolean {
  const auth = req.headers.get('Authorization') ?? '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
  const parts = token.split('.');
  if (parts.length !== 3) return false;
  try {
    let b64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    while (b64.length % 4) b64 += '=';
    const payload = JSON.parse(atob(b64)) as { role?: unknown };
    return payload.role === 'service_role';
  } catch {
    return false;
  }
}

async function handleExpire(req: Request): Promise<Response> {
  if (!isServiceRole(req)) return json({ error: 'forbidden' }, 403);

  const admin = adminClient();
  if (!admin) return json({ error: 'function env missing SUPABASE_* secrets' }, 503);

  // Per-user attribution for the Logs drawer: listBatch records each row's
  // owner; markExpired tallies the ids it successfully submits against that
  // map. The pure driver stays attribution-blind on purpose - it summarizes
  // counts, not ids - so the glue carries the ownership context. The
  // mark_attachments_expired RPC returns only an aggregate count, so the
  // per-user numbers count rows submitted for marking: exact unless a row
  // vanished between list and mark, in which case they over-count by that row.
  const ownerByRowId = new Map<string, string>();
  const expiredByUser = new Map<string, number>();

  const deps: ExpireDeps = {
    listBatch: async (batchSize) => {
      const { data, error } = await admin.rpc('list_expirable_attachments', {
        p_days: EXPIRY_DAYS,
        p_limit: batchSize,
      });
      if (error) throw error;
      return (
        (data ?? []) as Array<{ id: string; storage_path: string; user_id: string }>
      ).map((r) => {
        ownerByRowId.set(r.id, r.user_id);
        return { id: r.id, storagePath: r.storage_path };
      });
    },
    deleteObjects: async (paths) => {
      if (paths.length === 0) return;
      const { error } = await admin.storage.from('attachments').remove(paths);
      if (error) throw error;
    },
    markExpired: async (ids) => {
      if (ids.length === 0) return 0;
      const { data, error } = await admin.rpc('mark_attachments_expired', { p_ids: ids });
      if (error) throw error;
      for (const id of ids) {
        const owner = ownerByRowId.get(id);
        if (owner) expiredByUser.set(owner, (expiredByUser.get(owner) ?? 0) + 1);
      }
      return typeof data === 'number' ? data : 0;
    },
  };

  try {
    const summary = await runExpiry(deps, {
      batchSize: BATCH_SIZE,
      maxRows: MAX_ROWS,
      timeBudgetMs: TIME_BUDGET_MS,
    });
    return json(summary);
  } catch (err) {
    return json({ error: (err as Error).message }, 500);
  } finally {
    // One drawer line per affected user, emitted even when the sweep died
    // mid-run (earlier batches were already marked). The finally block runs
    // before the returned Response settles, so every broadcast is flushed
    // before the function resolves (see edge-log.ts header).
    for (const [userId, count] of expiredByUser) {
      const log = createEdgeLogger(userId, 'attachment-expiry');
      log.info(`expired ${count} dormant attachment(s)`);
      await log.flush();
    }
  }
}

Deno.serve(async (req: Request): Promise<Response> => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS_HEADERS });
  if (req.method === 'POST') return handleExpire(req);
  return json({ error: 'not found' }, 404);
});
