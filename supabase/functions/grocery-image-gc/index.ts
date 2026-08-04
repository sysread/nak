// The `grocery-image-gc` edge function - orphan reclamation for
// grocery-item product photos (grocery_item_images + the
// grocery-item-images bucket). Cron-triggered (pg_cron -> pg_net ->
// here; nak_trigger_grocery_image_gc in schema.sql). Service-role only.
//
// A row is orphaned when no grocery_products.image_id references it -
// simpler than the recipe sweep's link-table anti-join, but the same
// list / re-checked-delete / object-remove drain, so this function
// reuses the recipe sweep's pure driver (runRecipeImageGc): the loop is
// table-agnostic and all table/bucket specifics live in the injected
// deps below. The driver (and its unit tests) live in
// ../_shared/recipe-image-gc.ts; this file is glue.
//
// Standalone like attachment-gc: it only touches Postgres + Storage,
// never Venice, so it isn't a venice route. The auth/client helpers are
// duplicated from venice/index.ts on purpose - independent functions
// over a shared module.
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { createEdgeLogger } from '../_shared/edge-log.ts';
import { runRecipeImageGc, type RecipeImageGcDeps } from '../_shared/recipe-image-gc.ts';

const CORS_HEADERS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

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

// Trust the decoded bearer `role` only because the gateway's verify_jwt
// has already validated the signature (see the longer note in
// venice/index.ts). Do NOT disable verify_jwt without replacing this.
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

  // Per-user attribution for the Logs drawer, same shape as the recipe
  // sweep: the delete RPC returns the rows it actually removed (with
  // user_id) and the glue tallies them; the pure driver stays
  // attribution-blind.
  const reclaimedByUser = new Map<string, number>();

  const deps: RecipeImageGcDeps = {
    listOrphans: async (batchSize) => {
      const { data, error } = await admin.rpc('list_orphan_grocery_item_images', {
        p_limit: batchSize,
      });
      if (error) throw error;
      return ((data ?? []) as Array<{ id: string; storage_path: string | null }>).map((r) => ({
        id: r.id,
        storagePath: r.storage_path,
      }));
    },
    deleteRows: async (ids) => {
      if (ids.length === 0) return { deleted: 0, paths: [] };
      const { data, error } = await admin.rpc('delete_orphan_grocery_item_images', {
        p_ids: ids,
      });
      if (error) throw error;
      const rows = (data ?? []) as Array<{
        id: string;
        storage_path: string | null;
        user_id: string;
      }>;
      for (const r of rows) {
        reclaimedByUser.set(r.user_id, (reclaimedByUser.get(r.user_id) ?? 0) + 1);
      }
      return {
        deleted: rows.length,
        paths: rows
          .map((r) => r.storage_path)
          .filter((p): p is string => typeof p === 'string' && p.length > 0),
      };
    },
    deleteObjects: async (paths) => {
      if (paths.length === 0) return;
      const { error } = await admin.storage.from('grocery-item-images').remove(paths);
      if (error) throw error;
    },
  };

  try {
    const summary = await runRecipeImageGc(deps, {
      batchSize: BATCH_SIZE,
      maxRows: MAX_ROWS,
      timeBudgetMs: TIME_BUDGET_MS,
    });
    return json(summary);
  } catch (err) {
    return json({ error: (err as Error).message }, 500);
  } finally {
    // One drawer line per affected user, emitted even when the sweep died
    // mid-run (earlier batches were already deleted).
    for (const [userId, count] of reclaimedByUser) {
      const log = createEdgeLogger(userId, 'grocery-image-gc');
      log.info(`reclaimed ${count} orphaned grocery item image(s)`);
      await log.flush();
    }
  }
}

Deno.serve(async (req: Request): Promise<Response> => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS_HEADERS });
  if (req.method === 'POST') return handleGc(req);
  return json({ error: 'not found' }, 404);
});
