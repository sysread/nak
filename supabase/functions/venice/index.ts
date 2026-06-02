// The `venice` edge function - the single deployed function that wraps our
// Venice.ai calls (Supabase's "fat function" guidance: few large functions,
// not many small). It routes internally by trailing path segment:
//   /embed     - browser-triggered, one vector for a search query or (legacy)
//                a single backfill row. Authenticated as the calling user.
//   /usage     - browser-triggered, one page of billing usage. The browser's
//                paging loop calls it once per page so it can drive a per-page
//                progress indicator. Authenticated as the calling user.
//   /backfill  - cron-triggered (pg_cron -> pg_net), drains pending embeddings
//                across every table server-side. Service-role only.
//   /text-parser - browser-triggered, forwards a multipart file upload to
//                  Venice's /augment/text-parser. Bug-driven: browser direct
//                  calls were CORS-rejected on non-image files; the function
//                  fixes both the chat-attachment and Library-upload paths.
//   /image-generate - browser-triggered, forwards a prompt + options to
//                     Venice's /image/generate. The generate_image tool calls
//                     it; the function pins variants=1/return_binary=false
//                     so the response is a single base64 image ready for the
//                     attachments path.
//   /complete - browser-triggered, thin proxy for Venice's /chat/completions
//               (non-streaming). The body-shaping helper buildChatBody lives
//               in src/lib/venice.ts and runs browser-side; this route just
//               attaches the shared key, forwards, and relays Venice's
//               response - including a parsed retryAfterMs on 429 so the
//               browser's retry loop can act on Venice's hint. The streaming
//               sibling (streamChat) is the project's final attractor and
//               does not move yet.
//
// The handlers are intentionally thin: request/response shaping, the Venice
// call, and the backfill orchestration live in ../_shared/* (pure, unit-tested
// offline). This file owns only the glue - CORS, routing, auth, sourcing the
// shared key, and error mapping.
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import {
  veniceComplete,
  veniceEmbed,
  veniceExtractText,
  veniceFetchUsagePage,
  veniceGenerateImage,
  VeniceError,
} from '../_shared/venice.ts';
import { EMBED_SOURCES } from '../_shared/embed-input.ts';
import {
  runBackfill,
  VENICE_EMBEDDING_MODEL,
  type BackfillDeps,
} from '../_shared/backfill.ts';

const CORS_HEADERS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

// Backfill tunables. One invocation processes at most BACKFILL_MAX_ROWS rows or
// runs for at most BACKFILL_TIME_BUDGET_MS, whichever comes first, then returns;
// the */5 cron tick resumes from the same claim state. The budget sits well
// under the edge runtime's wall-clock limit - nearly all of it is spent
// awaiting Venice (I/O, not CPU). ROW_CLAIM_TTL_SECONDS is longer than a single
// invocation so an overlapping tick can't steal a row this one is still saving.
const BACKFILL_MAX_ROWS = 50;
const BACKFILL_TIME_BUDGET_MS = 25_000;
const ROW_CLAIM_TTL_SECONDS = 120;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
  });
}

/**
 * Build a service-role Supabase client from the env the edge runtime injects.
 * The service role bypasses RLS, which is what lets the function read the shared
 * app_config key and run the global (cross-member) backfill RPCs. Returns null
 * when the env is missing so callers can turn that into a 503.
 */
function adminClient(): SupabaseClient | null {
  const url = Deno.env.get('SUPABASE_URL');
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!url || !serviceKey) return null;
  return createClient(url, serviceKey, { auth: { persistSession: false } });
}

/**
 * Read the project-global shared Venice key from app_config using the service
 * role (app_config has only an authenticated-read policy and no write policy;
 * the service role bypasses RLS). Returns null when the row is unseeded.
 */
async function readVeniceKey(admin: SupabaseClient): Promise<string | null> {
  const { data, error } = await admin
    .from('app_config')
    .select('venice_api_key')
    .eq('id', true)
    .maybeSingle();
  if (error || !data) return null;
  const key = (data as { venice_api_key?: string | null }).venice_api_key;
  return typeof key === 'string' && key.length > 0 ? key : null;
}

/**
 * True when the request is authenticated as the service role. The cron job
 * (pg_net) sends the project's service-role JWT as the bearer (the gateway
 * needs a JWT, so the cron secret is the legacy JWT key, not the modern opaque
 * `sb_secret_` one - same reason the local realtime stack rejects
 * `sb_publishable_`).
 *
 * We decode the bearer's `role` claim rather than string-comparing it to the
 * injected SUPABASE_SERVICE_ROLE_KEY. That equality check shipped first and
 * 403'd every cron call: the bearer must be a JWT for the gateway to accept it,
 * but SUPABASE_SERVICE_ROLE_KEY is not guaranteed to be the same string (legacy
 * JWT vs modern `sb_secret_`), so the bytes differ even though both grant the
 * service role. Checking the claim is robust to which key format the project
 * uses. SECURITY: this trusts the decoded payload, which is only safe because
 * the gateway's `verify_jwt` (on by default, per supabase/config.toml; no
 * per-route override) has already validated the signature. Do NOT disable
 * verify_jwt for this function without replacing this with signature
 * verification - otherwise a forged `role: service_role` token would pass.
 */
function isServiceRole(req: Request): boolean {
  const auth = req.headers.get('Authorization') ?? '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
  const parts = token.split('.');
  if (parts.length !== 3) return false; // not a JWT
  try {
    let b64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    while (b64.length % 4) b64 += '=';
    const payload = JSON.parse(atob(b64)) as { role?: unknown };
    return payload.role === 'service_role';
  } catch {
    return false;
  }
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

  const admin = adminClient();
  if (!admin) return json({ error: 'function env missing SUPABASE_* secrets' }, 503);
  const apiKey = await readVeniceKey(admin);
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

interface UsageRequestBody {
  page?: number;
  limit?: number;
  sortOrder?: string;
  startDate?: string;
  endDate?: string;
  currency?: string;
}

/**
 * Browser-triggered single-page proxy for GET /billing/usage. The browser's
 * paging loop (src/lib/usage.ts) calls this once per page, so the per-page
 * progress indicator in the Usage pane keeps working - a single fat response
 * could not report page-by-page progress. Authenticated as the calling user:
 * the gateway's verify_jwt has already validated the session JWT (same model as
 * /embed, no service-role check). Usage is account-scoped, so any project member
 * sees the one shared key's usage - consistent with the shared-key trust model.
 *
 * Forwards one page to Venice with the shared key and relays the rows verbatim;
 * row coercion and the paging cap live in the browser loop, keeping this a thin
 * passthrough with no UsageRow knowledge.
 */
async function handleUsage(req: Request): Promise<Response> {
  let body: UsageRequestBody;
  try {
    body = (await req.json()) as UsageRequestBody;
  } catch {
    return json({ error: 'invalid JSON body' }, 400);
  }

  const admin = adminClient();
  if (!admin) return json({ error: 'function env missing SUPABASE_* secrets' }, 503);
  const apiKey = await readVeniceKey(admin);
  if (!apiKey) {
    return json({ error: 'no Venice key configured (app_config unseeded)' }, 503);
  }

  try {
    const result = await veniceFetchUsagePage({
      apiKey,
      params: {
        page: typeof body.page === 'number' ? body.page : 1,
        limit: typeof body.limit === 'number' ? body.limit : 500,
        sortOrder: typeof body.sortOrder === 'string' ? body.sortOrder : 'desc',
        startDate: body.startDate,
        endDate: body.endDate,
        currency: body.currency,
      },
    });
    return json(result);
  } catch (err) {
    if (err instanceof VeniceError) {
      // Mirror handleEmbed: surface Venice's 429 as a 429 so the browser loop
      // can back off; everything else collapses to 502 (bad upstream).
      return json({ error: err.message, kind: err.kind }, err.kind === 'rate_limit' ? 429 : 502);
    }
    return json({ error: (err as Error).message }, 500);
  }
}

/**
 * Browser-triggered thin proxy for POST /chat/completions. The browser
 * already builds Venice's wire-shape body via the exported buildChatBody
 * helper in src/lib/venice.ts; the function forwards it untouched with the
 * shared key attached and returns Venice's JSON verbatim. parseChatCompletion
 * on the browser side handles response shaping.
 *
 * Auth: verify_jwt on (the gateway has already validated the session JWT),
 * shared key from app_config via the service role - same model as /embed.
 * No service-role check, since this is user-triggered.
 *
 * Error relay: VeniceError carries kind + status; on rate_limit we also
 * include retryAfterMs in the JSON body so the browser's retry loop can
 * read Venice's Retry-After / x-ratelimit-reset-* hint rather than picking
 * a backoff blindly. Other VeniceErrors collapse to 502; non-VeniceError
 * exceptions to 500.
 */
async function handleComplete(req: Request): Promise<Response> {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return json({ error: 'invalid JSON body' }, 400);
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return json({ error: 'body must be a JSON object' }, 400);
  }

  const admin = adminClient();
  if (!admin) return json({ error: 'function env missing SUPABASE_* secrets' }, 503);
  const apiKey = await readVeniceKey(admin);
  if (!apiKey) {
    return json({ error: 'no Venice key configured (app_config unseeded)' }, 503);
  }

  try {
    const result = await veniceComplete({
      apiKey,
      body: body as Record<string, unknown>,
    });
    return json(result);
  } catch (err) {
    if (err instanceof VeniceError) {
      if (err.kind === 'rate_limit') {
        // Surface Retry-After / x-ratelimit-reset-* through the JSON body
        // so the browser's retry loop can act on Venice's hint - the
        // headers themselves do not survive the functions.invoke round
        // trip cleanly.
        return json(
          { error: err.message, kind: err.kind, retryAfterMs: err.retryAfterMs ?? null },
          429
        );
      }
      return json({ error: err.message, kind: err.kind }, 502);
    }
    return json({ error: (err as Error).message }, 500);
  }
}

interface ImageGenerateRequestBody {
  model?: string;
  prompt?: string;
  negativePrompt?: string;
  stylePreset?: string;
  width?: number;
  height?: number;
  seed?: number;
  steps?: number;
  cfgScale?: number;
  safeMode?: boolean;
  hideWatermark?: boolean;
  format?: 'webp' | 'png' | 'jpeg';
}

/**
 * Browser-triggered image-generation proxy for POST /image/generate. Mirrors
 * /embed's auth: the gateway's verify_jwt has already validated the session
 * JWT; we read the shared key from app_config via the service role. The body
 * keeps the camel-cased shape the browser's generate_image tool already uses;
 * veniceGenerateImage handles the snake_case translation Venice expects, the
 * variants=1 / return_binary=false defaults, and the content-policy header
 * check. Response is `{ imageBase64, mimeType }` ready to drop into a
 * message_attachments row.
 */
async function handleImageGenerate(req: Request): Promise<Response> {
  let body: ImageGenerateRequestBody;
  try {
    body = (await req.json()) as ImageGenerateRequestBody;
  } catch {
    return json({ error: 'invalid JSON body' }, 400);
  }
  if (typeof body.model !== 'string' || typeof body.prompt !== 'string') {
    return json({ error: 'body must include `model` and `prompt`' }, 400);
  }

  const admin = adminClient();
  if (!admin) return json({ error: 'function env missing SUPABASE_* secrets' }, 503);
  const apiKey = await readVeniceKey(admin);
  if (!apiKey) {
    return json({ error: 'no Venice key configured (app_config unseeded)' }, 503);
  }

  try {
    const result = await veniceGenerateImage({
      apiKey,
      model: body.model,
      prompt: body.prompt,
      negativePrompt: body.negativePrompt,
      stylePreset: body.stylePreset,
      width: body.width,
      height: body.height,
      seed: body.seed,
      steps: body.steps,
      cfgScale: body.cfgScale,
      safeMode: body.safeMode,
      hideWatermark: body.hideWatermark,
      format: body.format,
    });
    return json(result);
  } catch (err) {
    if (err instanceof VeniceError) {
      return json({ error: err.message, kind: err.kind }, err.kind === 'rate_limit' ? 429 : 502);
    }
    return json({ error: (err as Error).message }, 500);
  }
}

/**
 * Browser-triggered text extraction proxy for POST /augment/text-parser. The
 * browser cannot reach this Venice endpoint directly - Venice CORS-enables
 * chat/image/embeddings but not text-parser, which surfaced as a confusing
 * "Failed to fetch" on any non-image attachment. Forwarding through the
 * function makes the call server-side where browser CORS does not apply and
 * the shared key already lives. Authenticated as the calling user (gateway's
 * verify_jwt has already validated the session JWT - same model as /embed,
 * no service-role check).
 *
 * Multipart in, JSON out: the request body is a multipart/form-data with a
 * `file` part (Blob + filename); the response is `{ text }`. Forwarding
 * preserves the file's filename so Venice's content-type sniffing still
 * works. Failures relay through the VeniceError -> { error, kind } shape the
 * other routes use; 429 surfaces as 429, everything else collapses to 502.
 */
async function handleTextParser(req: Request): Promise<Response> {
  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return json({ error: 'invalid multipart body' }, 400);
  }
  const filePart = form.get('file');
  // A File satisfies Blob (it extends Blob in the browser/Deno standard), so
  // the Blob check covers both - File-ness is checked separately only to
  // recover the original filename.
  if (!(filePart instanceof Blob)) {
    return json({ error: 'body must include a `file` part' }, 400);
  }
  const filename =
    filePart instanceof File && filePart.name ? filePart.name : 'attachment';

  const admin = adminClient();
  if (!admin) return json({ error: 'function env missing SUPABASE_* secrets' }, 503);
  const apiKey = await readVeniceKey(admin);
  if (!apiKey) {
    return json({ error: 'no Venice key configured (app_config unseeded)' }, 503);
  }

  try {
    const text = await veniceExtractText({ apiKey, file: filePart, filename });
    return json({ text });
  } catch (err) {
    if (err instanceof VeniceError) {
      return json({ error: err.message, kind: err.kind }, err.kind === 'rate_limit' ? 429 : 502);
    }
    return json({ error: (err as Error).message }, 500);
  }
}

/**
 * Cron-driven server-side backfill. Claims pending rows across every embeddable
 * table, embeds them with the shared key, and writes the vectors back through
 * the service-definer claim/save RPCs. Bounded per invocation (see the tunables
 * above); the schedule resumes the drain.
 */
async function handleBackfill(req: Request): Promise<Response> {
  if (!isServiceRole(req)) return json({ error: 'forbidden' }, 403);

  const admin = adminClient();
  if (!admin) return json({ error: 'function env missing SUPABASE_* secrets' }, 503);
  const apiKey = await readVeniceKey(admin);
  if (!apiKey) {
    return json({ error: 'no Venice key configured (app_config unseeded)' }, 503);
  }

  // One holder id per invocation. The claim/save RPCs guard on it so an
  // overlapping invocation (a slow tick still running when the next fires)
  // can't save over a row this one claimed.
  const holderId = crypto.randomUUID();

  const deps: BackfillDeps = {
    claim: async (sourceIndex) => {
      const source = EMBED_SOURCES[sourceIndex];
      const { data, error } = await admin.rpc(source.claimRpc, {
        p_holder_id: holderId,
        p_ttl_seconds: ROW_CLAIM_TTL_SECONDS,
      });
      if (error) throw error;
      const row = (Array.isArray(data) ? data[0] : data) as Record<string, unknown> | undefined;
      if (!row) return null;
      return { id: String(row.id), input: source.buildInput(row) };
    },
    embed: async (input) => {
      const resp = await veniceEmbed({ apiKey, model: VENICE_EMBEDDING_MODEL, input });
      return resp.data[0]?.embedding;
    },
    save: async (sourceIndex, id, embedding) => {
      const source = EMBED_SOURCES[sourceIndex];
      const { data, error } = await admin.rpc(source.saveRpc, {
        p_id: id,
        p_holder_id: holderId,
        p_embedding: embedding,
        p_embedding_model: VENICE_EMBEDDING_MODEL,
      });
      if (error) throw error;
      return data === true;
    },
  };

  const summary = await runBackfill(deps, {
    sourceCount: EMBED_SOURCES.length,
    maxRows: BACKFILL_MAX_ROWS,
    timeBudgetMs: BACKFILL_TIME_BUDGET_MS,
    isRateLimit: (err) => err instanceof VeniceError && err.kind === 'rate_limit',
  });

  return json(summary);
}

Deno.serve(async (req: Request): Promise<Response> => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS_HEADERS });

  // Route by the trailing path segment so a single function can host every
  // Venice endpoint. Deployed at /functions/v1/venice, so /functions/v1/venice/embed
  // lands here with a trailing `embed`.
  const route = new URL(req.url).pathname.split('/').filter(Boolean).pop();
  if (route === 'embed' && req.method === 'POST') return handleEmbed(req);
  if (route === 'usage' && req.method === 'POST') return handleUsage(req);
  if (route === 'backfill' && req.method === 'POST') return handleBackfill(req);
  if (route === 'text-parser' && req.method === 'POST') return handleTextParser(req);
  if (route === 'image-generate' && req.method === 'POST') return handleImageGenerate(req);
  if (route === 'complete' && req.method === 'POST') return handleComplete(req);

  return json({ error: 'not found' }, 404);
});
