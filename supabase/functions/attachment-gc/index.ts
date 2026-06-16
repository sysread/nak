// The `attachment-gc` edge function - the daily backstop that reclaims
// attachments-bucket objects orphaned by thread deletion. A deleted thread
// cascades its message_attachments rows away, but SQL can't reach Storage to
// drop the bucket objects those rows pointed at; the client's deleteThread
// removes them inline, and this sweep mops up whatever that missed (a failed
// inline remove, or any object predating it). Cron-triggered (pg_cron ->
// pg_net -> here; nak_trigger_attachment_gc in schema.sql). Service-role only.
//
// Standalone like expire-attachments / recipe-image-gc: it only touches
// Postgres + Storage, never Venice, so it isn't a venice route. The auth/client
// helpers are duplicated from venice/index.ts on purpose - independent
// functions over a shared module. The sweep orchestration is pure and
// unit-tested in ../_shared/attachment-gc.ts; this file is glue.
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
// edge-log is a _shared module like the GC driver itself - the "independent
// functions" stance in the header is about the auth/client glue, not _shared.
import { createEdgeLogger } from '../_shared/edge-log.ts';
import { runAttachmentGc, type AttachmentGcDeps } from '../_shared/attachment-gc.ts';

const CORS_HEADERS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

// Grace window keeping an in-flight send's object (uploaded a beat before its
// row insert commits) from being mistaken for an orphan, plus per-invocation
// bounds. Daily cron + a generous cap keeps each tick small; the next tick
// resumes if a backlog ever exceeds the cap.
const MIN_AGE_SECONDS = 3600;
const BATCH_SIZE = 100;
const MAX_ROWS = 5000;
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

// Trust the decoded bearer `role` only because the gateway's verify_jwt has
// already validated the signature (see the longer note in venice/index.ts). Do
// NOT disable verify_jwt without replacing this with signature verification.
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

async function handleGc(req: Request): Promise<Response> {
  if (!isServiceRole(req)) return json({ error: 'forbidden' }, 403);

  const admin = adminClient();
  if (!admin) return json({ error: 'function env missing SUPABASE_* secrets' }, 503);

  // Per-user attribution for the Logs drawer. Every key is
  // `<user_id>/<attachment_id>/<filename>` (the bucket RLS prefix), so the
  // owner is the first path segment - no DB lookup needed, and the deleted
  // thread's row is gone anyway. Tally as objects are confirmed deleted.
  const reclaimedByUser = new Map<string, number>();

  const deps: AttachmentGcDeps = {
    listOrphans: async (batchSize) => {
      const { data, error } = await admin.rpc('list_orphan_attachment_objects', {
        p_min_age_seconds: MIN_AGE_SECONDS,
        p_limit: batchSize,
      });
      if (error) throw error;
      return ((data ?? []) as Array<{ name: string }>).map((r) => r.name);
    },
    deleteObjects: async (paths) => {
      if (paths.length === 0) return;
      const { error } = await admin.storage.from('attachments').remove(paths);
      if (error) throw error;
      for (const p of paths) {
        const userId = p.split('/')[0];
        if (userId) reclaimedByUser.set(userId, (reclaimedByUser.get(userId) ?? 0) + 1);
      }
    },
  };

  try {
    const summary = await runAttachmentGc(deps, {
      batchSize: BATCH_SIZE,
      maxRows: MAX_ROWS,
      timeBudgetMs: TIME_BUDGET_MS,
    });
    return json(summary);
  } catch (err) {
    return json({ error: (err as Error).message }, 500);
  } finally {
    // One drawer line per affected user, emitted even when the sweep died
    // mid-run (earlier batches were already deleted). The finally block runs
    // before the returned Response settles, so every broadcast is flushed
    // before the function resolves (see edge-log.ts header).
    for (const [userId, count] of reclaimedByUser) {
      const log = createEdgeLogger(userId, 'attachment-gc');
      log.info(`reclaimed ${count} orphaned attachment object(s)`);
      await log.flush();
    }
  }
}

Deno.serve(async (req: Request): Promise<Response> => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS_HEADERS });
  if (req.method === 'POST') return handleGc(req);
  return json({ error: 'not found' }, 404);
});
