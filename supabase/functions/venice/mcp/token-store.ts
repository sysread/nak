// token-store -----------------------------------------------------------------
//
// Per-user MCP integration + OAuth token storage helpers, all b-strict.
// Every read/write goes through the service-role `adminClient` and
// MUST filter by `userId` explicitly - service-role bypasses RLS so
// the userId filter is the only ownership boundary (see
// docs/dev/edge-function-auth.md).
//
// Two tables (schema in supabase/schema.sql):
//   mcp_integrations   - one row per remote MCP server a user has
//                        connected; carries label, server_url, OAuth
//                        client_id, cached discovery metadata, auth_status.
//   mcp_oauth_tokens   - 1:1 with mcp_integrations; the access + refresh
//                        tokens. Written server-side only - the
//                        browser never reads this table.
//   mcp_integration_tools - cached tool catalog per integration, used
//                           to build the wire `tools` array entry the
//                           model sees on each chat turn.
//
// `getValidAccessToken` is the load-bearing helper: the dispatcher
// (dispatch.ts) calls it before every MCP tool call, and it owns the
// refresh-if-expired choreography so callers see an opaque "give me a
// live token" contract. Single-device v1: refresh is a straightforward
// UPDATE; cross-device mutual-exclusion (RFC 8707-rotation cones) is
// deferred per the schema's plan open question.

import type { SupabaseClient } from '@supabase/supabase-js';
import {
  refreshToken as refreshOauthToken,
  type AuthServerMetadata,
  type McpToolDescriptor,
} from './oauth.ts';

// ---------------------------------------------------------------------------
// Row shapes (mirrors of schema.sql columns)
// ---------------------------------------------------------------------------

/** Cached discovery metadata stored on the integration row as jsonb. */
export interface McpIntegrationMetadata {
  /** Canonical resource URL - the RFC 8707 `resource` value. */
  resource: string;
  /** Raw RFC 9728 Protected Resource Metadata. */
  resourceMetadata: Record<string, unknown>;
  /** One entry per `authorization_servers` issuer (RFC 8414 + raw). */
  authServers: AuthServerMetadata[];
  /** True when any auth server advertised a `registration_endpoint`. */
  supportsDcr: boolean;
  /** True when the server required no OAuth (mcp_discover returns early). */
  authNotRequired?: boolean;
}

/** A row from `mcp_integrations` as the edge function reads it. */
export interface McpIntegrationRow {
  id: string;
  user_id: string;
  label: string;
  server_url: string;
  supports_dcr: boolean;
  client_id: string | null;
  client_secret: string | null;
  registered_redirect_uri: string | null;
  auth_status: string;
  discovered_metadata: McpIntegrationMetadata | null;
  granted_scopes: string[] | null;
  created_at: string;
  updated_at: string;
}

/** A row from `mcp_oauth_tokens` as the edge function reads it. */
export interface McpTokenRow {
  id: string;
  integration_id: string;
  user_id: string;
  access_token: string;
  /** Epoch ms; null when the server omitted `expires_in`. */
  access_token_expires_at: number | null;
  refresh_token: string | null;
  refresh_token_rotated_at: string | null;
  last_refreshed_at: string | null;
}

/** Wire-array entry shape `listEnabledToolSchemas` returns. */
export interface McpWireToolSchema {
  integrationId: string;
  /** Tool name as the MCP server defines it (e.g. `search_email`). */
  serverToolName: string;
  /** Namespaced name the model emits: `mcp:<integrationId>:<serverToolName>`. */
  wireName: string;
  description: string;
  shortDescription: string;
  inputSchema: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Safety margin (ms) applied to the access-token expiry check so a
 * token that expires "now" is treated as already expired - avoids the
 * race where we hand back a token that expires mid-dispatch.
 */
const EXPIRY_SAFETY_MS = 30_000; // 30s front pad

function fallbackTokenEndpoint(meta: McpIntegrationMetadata | null): string | null {
  if (!meta || !Array.isArray(meta.authServers)) return null;
  for (const s of meta.authServers) {
    if (s && typeof s.token_endpoint === 'string' && s.token_endpoint.length > 0) {
      return s.token_endpoint;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Token storage / refresh
// ---------------------------------------------------------------------------

/**
 * Upsert the access + refresh token pair for an integration. Called on
 * every successful code-exchange AND every refresh (rotation may hand
 * us back a NEW refresh_token we must persist, or the SAME one for
 * non-rotating servers). The `unique (integration_id)` constraint on
 * `mcp_oauth_tokens` makes this a 1:1 upsert.
 */
export async function storeTokens(
  adminClient: SupabaseClient,
  userId: string,
  integrationId: string,
  accessToken: string,
  refreshToken: string | null,
  expiresInSeconds: number | null,
): Promise<void> {
  // RLS OFF: filter by userId via the integration_id -> user_id join
  // enforced upstream when the handler resolved the integration row
  // to this user; the upsert columns carry both keys for belt-and-
  // braces. service-role bypasses RLS so the userId filter is load-
  // bearing here.
  const now = Date.now();
  const expiresAt =
    typeof expiresInSeconds === 'number' && expiresInSeconds > 0
      ? now + expiresInSeconds * 1000
      : null;
  const { error } = await adminClient.from('mcp_oauth_tokens').upsert(
    {
      integration_id: integrationId,
      user_id: userId,
      access_token: accessToken,
      refresh_token: refreshToken,
      access_token_expires_at: expiresAt,
      // Track when the refresh token column last changed so a future
      // cross-device coordinator can detect a stale refresh-token
      // value. For v1 we always stamp it on the upsert; a no-rotation
      // refresh re-stamps the same logical instant (now), which is
      // harmless under single-device use.
      refresh_token_rotated_at: refreshToken ? new Date(now).toISOString() : null,
      last_refreshed_at: new Date(now).toISOString(),
    },
    { onConflict: 'integration_id' },
  );
  if (error) {
    throw new Error(`storeTokens upsert failed: ${error.message}`);
  }
}

/**
 * Resolve a live access token for the integration, refreshing if the
 * cached one is expired-or-near-expiry (or the server never gave an
 * expiry - we treat null as already-expired so a deferred refresh
 * fires on first use). Throws VenicyError-shaped errors on permanent
 * refresh failure (the dispatcher propagates a clear tool result).
 *
 * Single-device v1: no claim coordination. If two devices (or two
 * same-turn parallel MCP tool calls) race a refresh, the second
 * attempt gets `invalid_grant` from the server after the first one
 * rotated the token. We retry once on that code: re-read the row,
 * which now carries the fresh token the other caller just stored,
 * and use it. One retry is sufficient for the same-turn case.
 */
export async function getValidAccessToken(
  adminClient: SupabaseClient,
  userId: string,
  integrationId: string,
  retryOnConflict = true,
): Promise<string> {
  // RLS OFF: filter by userId - service-role bypasses RLS, the
  // `.eq('user_id', userId)` clause is the only ownership boundary.
  const { data: tokenRow, error } = await adminClient
    .from('mcp_oauth_tokens')
    .select('access_token, access_token_expires_at, refresh_token')
    .eq('integration_id', integrationId)
    .eq('user_id', userId)
    .maybeSingle();
  if (error) {
    throw new Error(`getValidAccessToken read failed: ${error.message}`);
  }
  if (!tokenRow) {
    throw new Error(
      `no token row for integration ${integrationId} (auth_status may be revoked)`,
    );
  }

  const expiresAt =
    typeof tokenRow.access_token_expires_at === 'number'
      ? tokenRow.access_token_expires_at
      : null;
  const stillFresh =
    expiresAt !== null && expiresAt > Date.now() + EXPIRY_SAFETY_MS;
  if (stillFresh) {
    return tokenRow.access_token;
  }

  // Refresh path.
  const integration = await getIntegration(adminClient, userId, integrationId);
  if (!integration) {
    throw new Error(
      `integration ${integrationId} no longer exists for user`,
    );
  }
  if (!integration.client_id) {
    throw new Error(
      `integration ${integrationId} has no client_id; cannot refresh (auth_status=${integration.auth_status})`,
    );
  }
  const tokenEndpoint = fallbackTokenEndpoint(integration.discovered_metadata);
  if (!tokenEndpoint) {
    throw new Error(
      `integration ${integrationId} has no cached token_endpoint in discovered_metadata; cannot refresh`,
    );
  }
  if (!tokenRow.refresh_token) {
    throw new Error(
      `integration ${integrationId} has no refresh_token; user must re-authorize`,
    );
  }

  try {
    const refreshed = await refreshOauthToken(
      tokenEndpoint,
      integration.client_id,
      tokenRow.refresh_token,
    );

    await storeTokens(
      adminClient,
      userId,
      integrationId,
      refreshed.access_token,
      refreshed.refresh_token,
      refreshed.expires_in,
    );
    return refreshed.access_token;
  } catch (err) {
    const msg = (err as Error).message ?? String(err);
    if (retryOnConflict && msg.includes('invalid_grant')) {
      // Another concurrent caller rotated the token before we did;
      // re-read the row — it should now carry the fresh token.
      return getValidAccessToken(adminClient, userId, integrationId, false);
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Integration CRUD
// ---------------------------------------------------------------------------

/** One integration row for the user, or null when it does not exist. */
export async function getIntegration(
  adminClient: SupabaseClient,
  userId: string,
  integrationId: string,
): Promise<McpIntegrationRow | null> {
  // RLS OFF: filter by userId.
  const { data, error } = await adminClient
    .from('mcp_integrations')
    .select('*')
    .eq('id', integrationId)
    .eq('user_id', userId)
    .maybeSingle();
  if (error) {
    throw new Error(`getIntegration read failed: ${error.message}`);
  }
  if (!data) return null;
  return coerceIntegrationRow(data);
}

/** Every integration row owned by the user, newest-first. */
export async function listIntegrations(
  adminClient: SupabaseClient,
  userId: string,
): Promise<McpIntegrationRow[]> {
  // RLS OFF: filter by userId.
  const { data, error } = await adminClient
    .from('mcp_integrations')
    .select('*')
    .eq('user_id', userId)
    .order('updated_at', { ascending: false });
  if (error) {
    throw new Error(`listIntegrations read failed: ${error.message}`);
  }
  if (!Array.isArray(data)) return [];
  return data.map((row) => coerceIntegrationRow(row));
}

/**
 * Update an integration's `auth_status` plus arbitrary optional
 * columns (supports_dcr, client_id, discovered_metadata,
 * registered_redirect_uri, granted_scopes, ...). The status is
 * required because the typical use of this helper is status-led
 * (pending -> authorized -> revoked); ad-hoc column patches ride
 * via the optional `patch`.
 */
export async function updateIntegrationStatus(
  adminClient: SupabaseClient,
  userId: string,
  integrationId: string,
  status: string,
  patch?: Partial<Omit<McpIntegrationRow, 'id' | 'user_id' | 'auth_status'>>,
): Promise<void> {
  // RLS OFF: filter by userId.
  const updates: Record<string, unknown> = {
    auth_status: status,
    updated_at: new Date().toISOString(),
    ...(patch ?? {}),
  };
  // Drop undefined values so we don't write NULLs into columns the
  // caller didn't intend to touch.
  for (const k of Object.keys(updates)) {
    if (updates[k] === undefined) delete updates[k];
  }
  const { error } = await adminClient
    .from('mcp_integrations')
    .update(updates)
    .eq('id', integrationId)
    .eq('user_id', userId);
  if (error) {
    throw new Error(`updateIntegrationStatus failed: ${error.message}`);
  }
}

/**
 * Atomically replace an integration's cached tool catalog. Delete-
 * then-insert under service-role keeps the per-integration table
 * tiny; the FK CASCADE on `mcp_integrations` cleans up the rows on
 * integration delete, so this is only the within-integration refresh
 * path. Caller passes the post-OAuth tool list from `listMcpTools`.
 *
 * The `short_description` column is filled per-row with a hard 50-char
 * ceiling - the system-prompt catalog renders one short line per tool
 * and MCP descriptions can run to paragraphs, so the wire schema's
 * `description` (long) and this catalog `short_description` (<50) are
 * both persisted.
 */
export async function storeToolCatalog(
  adminClient: SupabaseClient,
  userId: string,
  integrationId: string,
  tools: McpToolDescriptor[],
): Promise<void> {
  // RLS OFF: filter by userId on the delete + on the insert payload.
  await adminClient
    .from('mcp_integration_tools')
    .delete()
    .eq('integration_id', integrationId)
    .eq('user_id', userId);
  if (tools.length === 0) return;
  const rows = tools.map((t) => ({
    integration_id: integrationId,
    user_id: userId,
    server_tool_name: t.name,
    description: t.description ?? '',
    short_description: shortDescriptionOf(t.description),
    wire_schema: t.inputSchema ?? {},
    last_refreshed_at: new Date().toISOString(),
  }));
  const { error } = await adminClient
    .from('mcp_integration_tools')
    .insert(rows);
  if (error) {
    throw new Error(`storeToolCatalog insert failed: ${error.message}`);
  }
}

/**
 * Wire-tool schemas for every authorized integration the user owns.
 * Joined mcp_integrations (auth_status='authorized') <-
 * mcp_integration_tools. The dispatcher's caller (the stream-prep
 * augmentation block) projects these into OpenAI-style tool defs
 * with namespaced `mcp:<id>:<tool>` names so the model emits one
 * the dispatcher can resolve.
 *
 * Returns an empty array when the user has no authorized integration
 * or its tool catalog is empty - callers MUST treat empty as "no MCP
 * tools this turn," never as an error.
 */
export async function listEnabledToolSchemas(
  adminClient: SupabaseClient,
  userId: string,
): Promise<McpWireToolSchema[]> {
  // RLS OFF: filter by userId; the auth_status gate inside the
  // query is a capability selector, not an ownership boundary.
  const { data, error } = await adminClient
    .from('mcp_integration_tools')
    .select(
      'integration_id, server_tool_name, description, short_description, wire_schema, mcp_integrations!inner(auth_status)',
    )
    .eq('user_id', userId)
    .eq('mcp_integrations.auth_status', 'authorized');
  if (error) {
    console.error(`listEnabledToolSchemas query failed: ${error.message}`);
    return [];
  }
  if (!Array.isArray(data)) return [];
  const out: McpWireToolSchema[] = [];
  for (const row of data) {
    const r = row as {
      integration_id: string;
      server_tool_name: string;
      description: string | null;
      short_description: string | null;
      wire_schema: Record<string, unknown> | null;
    };
    out.push({
      integrationId: r.integration_id,
      serverToolName: r.server_tool_name,
      wireName: `mcp:${r.integration_id}:${r.server_tool_name}`,
      description: r.description ?? '',
      shortDescription: r.short_description ?? '',
      inputSchema: r.wire_schema ?? {},
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Coercion
// ---------------------------------------------------------------------------

function shortDescriptionOf(description: string): string {
  const trimmed = description.trim();
  if (trimmed.length <= 50) return trimmed;
  // Hard 50-char ceiling: prefer a clean word-break so the catalog
  // line doesn't read as garbled mid-word. If a single word exceeds
  // the ceiling (rare on MCP tools), floor it at the first 50 chars.
  const slice = trimmed.slice(0, 50);
  const space = slice.lastIndexOf(' ');
    // 20 chars is the shortest readable fragment worth a mid-word cut —
    // shorter fragments read as garbled anyway.
    if (space > 20) return slice.slice(0, space);
  return slice;
}

function coerceIntegrationRow(raw: Record<string, unknown>): McpIntegrationRow {
  const meta = raw.discovered_metadata as McpIntegrationMetadata | null | undefined;
  return {
    id: String(raw.id),
    user_id: String(raw.user_id),
    label: String(raw.label ?? ''),
    server_url: String(raw.server_url ?? ''),
    supports_dcr: Boolean(raw.supports_dcr),
    client_id:
      typeof raw.client_id === 'string' ? raw.client_id : null,
    client_secret:
      typeof raw.client_secret === 'string' ? raw.client_secret : null,
    registered_redirect_uri:
      typeof raw.registered_redirect_uri === 'string'
        ? raw.registered_redirect_uri
        : null,
    auth_status: String(raw.auth_status ?? 'pending'),
    discovered_metadata:
      meta && typeof meta === 'object' && 'resource' in meta
        ? meta
        : null,
    granted_scopes:
      Array.isArray(raw.granted_scopes)
        ? (raw.granted_scopes as unknown[]).filter(
            (s): s is string => typeof s === 'string',
          )
        : null,
    created_at: String(raw.created_at ?? ''),
    updated_at: String(raw.updated_at ?? ''),
  };
}

// ---------------------------------------------------------------------------
// Catalog refresh sweep
// ---------------------------------------------------------------------------

/**
 * Every authorized integration across all users. The catalog-refresh
 * sweep iterates this list to re-fetch each integration's tool catalog
 * using its stored (auto-refreshed) access token. No claim-RPC needed:
 * a catalog refresh is idempotent and read-only from the DB's
 * perspective - two overlapping ticks just re-fetch the same catalog
 * and the second upsert wins, which is harmless.
 *
 * RLS OFF: the service-role client bypasses RLS. The query selects
 * only the columns the sweep needs (id, user_id, label, server_url)
 * and filters to `auth_status = 'authorized'` so a revoked or pending
 * integration is never probed.
 */
export async function listAllAuthorizedIntegrations(
  adminClient: SupabaseClient,
): Promise<Array<{ id: string; user_id: string; label: string; server_url: string }>> {
  const { data, error } = await adminClient
    .from('mcp_integrations')
    .select('id, user_id, label, server_url')
    .eq('auth_status', 'authorized');
  if (error) {
    throw new Error(`listAllAuthorizedIntegrations failed: ${error.message}`);
  }
  if (!Array.isArray(data)) return [];
  return data.map((row) => ({
    id: String(row.id),
    user_id: String(row.user_id),
    label: String(row.label ?? ''),
    server_url: String(row.server_url ?? ''),
  }));
}