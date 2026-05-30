// The `recipe-image-gc` edge function - the idempotent server-side
// replacement for the old AFTER DELETE orphan trigger on
// recipe_version_images (see
// docs/dev/in-progress/recipe-images-storage-migration.md). Cron-triggered
// (pg_cron -> pg_net -> here; nak_trigger_recipe_image_gc in schema.sql).
// Service-role only.
//
// Standalone like expire-attachments: it only touches Postgres + Storage,
// never Venice, so it isn't a venice route. The auth/client helpers are
// duplicated from venice/index.ts on purpose - independent functions over a
// shared module. The sweep orchestration is pure and unit-tested in
// ../_shared/recipe-image-gc.ts; this file is glue.
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
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

  const deps: RecipeImageGcDeps = {
    listOrphans: async (batchSize) => {
      const { data, error } = await admin.rpc('list_orphan_recipe_images', {
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
      const { data, error } = await admin.rpc('delete_orphan_recipe_images', { p_ids: ids });
      if (error) throw error;
      const rows = (data ?? []) as Array<{ id: string; storage_path: string | null }>;
      return {
        deleted: rows.length,
        paths: rows
          .map((r) => r.storage_path)
          .filter((p): p is string => typeof p === 'string' && p.length > 0),
      };
    },
    deleteObjects: async (paths) => {
      if (paths.length === 0) return;
      const { error } = await admin.storage.from('recipe-images').remove(paths);
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
  }
}

Deno.serve(async (req: Request): Promise<Response> => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS_HEADERS });
  if (req.method === 'POST') return handleGc(req);
  return json({ error: 'not found' }, 404);
});
