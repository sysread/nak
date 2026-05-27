// The `venice` edge function - the single deployed function that wraps our
// Venice.ai calls (Supabase's "fat function" guidance: few large functions,
// not many small). It routes internally by trailing path segment; today only
// `/embed` is live. `/complete`, `/usage`, and `/text-parser` are the planned
// siblings - see docs/dev/in-progress/venice-edge-functions/.
//
// The handler is intentionally thin: request/response shaping and the Venice
// call live in ../_shared/venice.ts (pure, unit-tested offline). This file
// owns only the glue - CORS, routing, sourcing the shared key, and error
// mapping.
import { createClient } from '@supabase/supabase-js';
import { veniceEmbed, VeniceError } from '../_shared/venice.ts';

const CORS_HEADERS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
  });
}

/**
 * Read the project-global shared Venice key from app_config using the service
 * role (which bypasses RLS - app_config has no write policy and only an
 * authenticated-read one, so the function reads it as the service role the
 * edge runtime injects). Returns null when the row is unseeded or the env is
 * missing; the caller turns that into a 503 so the worker keeps its local-key
 * fallback meaningful.
 */
async function readVeniceKey(): Promise<string | null> {
  const url = Deno.env.get('SUPABASE_URL');
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!url || !serviceKey) return null;
  const admin = createClient(url, serviceKey, { auth: { persistSession: false } });
  const { data, error } = await admin
    .from('app_config')
    .select('venice_api_key')
    .eq('id', true)
    .maybeSingle();
  if (error || !data) return null;
  const key = (data as { venice_api_key?: string | null }).venice_api_key;
  return typeof key === 'string' && key.length > 0 ? key : null;
}

interface EmbedRequestBody {
  input?: string | string[];
  model?: string;
}

async function handleEmbed(req: Request): Promise<Response> {
  let body: EmbedRequestBody;
  try {
    body = (await req.json()) as EmbedRequestBody;
  } catch {
    return json({ error: 'invalid JSON body' }, 400);
  }
  if (!body.input || !body.model) {
    return json({ error: 'body must include `input` and `model`' }, 400);
  }

  const apiKey = await readVeniceKey();
  if (!apiKey) {
    return json({ error: 'no Venice key configured (app_config unseeded)' }, 503);
  }

  try {
    const result = await veniceEmbed({ apiKey, model: body.model, input: body.input });
    return json(result);
  } catch (err) {
    if (err instanceof VeniceError) {
      // Surface Venice's 429 as a 429 so the caller can apply its rate-limit
      // back-off; everything else collapses to 502 (bad upstream).
      return json({ error: err.message, kind: err.kind }, err.kind === 'rate_limit' ? 429 : 502);
    }
    return json({ error: (err as Error).message }, 500);
  }
}

Deno.serve(async (req: Request): Promise<Response> => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS_HEADERS });

  // Route by the trailing path segment so a single function can host every
  // Venice endpoint. Deployed at /functions/v1/venice, so /functions/v1/venice/embed
  // lands here with a trailing `embed`.
  const route = new URL(req.url).pathname.split('/').filter(Boolean).pop();
  if (route === 'embed' && req.method === 'POST') return handleEmbed(req);

  return json({ error: 'not found' }, 404);
});
