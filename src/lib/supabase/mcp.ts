/**
 * MCP-integration domain slice of the Supabase data layer: the
 * browser-side reads of `mcp_integrations` (the Settings list) and
 * `mcp_integration_tools` (the cached tool catalog the dynamic-
 * toolbox builder reads), plus the venice edge-function proxy calls
 * that drive the OAuth flow (discover, register, token-exchange,
 * refresh, disconnect).
 *
 * Plain async functions taking the shared SupabaseClient as their
 * first argument - no class, no state - so each is unit-testable
 * against a stubbed client without constructing SupabaseService. The
 * SupabaseService facade (../supabase.ts) delegates its MCP methods
 * here one-for-one under the same names; UI code calls
 * `app.supabase.<method>()` and should not import this module
 * directly. Row types and coercers live in ./types/mcp.ts.
 *
 * Token storage (`mcp_oauth_tokens`) is NEVER read here - access and
 * refresh tokens are bearer credentials the edge function owns. The
 * browser only triggers the OAuth flow and reads the integration +
 * tool-catalog rows the function populates.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { SupabaseError } from './error';
import { coerceMcpIntegration, coerceMcpToolSchema } from './types';
import type { McpIntegration, McpToolSchema } from './types';

/**
 * The cached metadata returned by discover - the shape the Settings
 * pane shows the user ("found N tools, DCR available") before kicking
 * off the authorization redirect. The edge function's mcp-discover
 * route returns this verbatim after walking the RFC 9728 + RFC 8414
 * well-known chain.
 */
export interface McpDiscoveredMetadata {
  /** Whether the server's auth advertised RFC 7591 DCR. */
  supportsDcr: boolean;
  /**
   * Human-readable name of the server / resource, when the metadata
   * carried one. Falls back to the host when absent.
   */
  serverName?: string;
  /** The authorization endpoint URL, when discovery resolved one. */
  authorizationEndpoint?: string;
  /** The token endpoint URL, when discovery resolved one. */
  tokenEndpoint?: string;
  /** The DCR registration endpoint URL, when supportsDcr is true. */
  registrationEndpoint?: string;
  /** Scopes the server advertised as available. */
  scopes?: string[];
  /** A preview of the tools the server exposes (tools/list pre-auth). */
  tools?: { name: string; description?: string }[];
}

/**
 * The register step's return. The integration row has been created
 * (status `pending`), and the browser is handed the authorization
 * URL to redirect to plus the PKCE material + state it must remember
 * across the OAuth round-trip.
 *
 * `codeVerifier` is included even though the client only sends
 * `codeChallenge` in the authorization request, because the PKCE
 * verifier has to come back to the token-exchange step - and that
 * step runs after a full-page redirect away from this tab. The
 * browser stashes the verifier in sessionStorage (see
 * src/lib/ui/mcp.ts) so the callback hop can hand it to
 * invokeMcpTokenExchange. The edge function generates the pair
 * server-side so S256 derivation stays in one place.
 */
export interface McpRegisterResult {
  integrationId: string;
  authzUrl: string;
  codeChallenge: string;
  codeVerifier: string;
  state: string;
}

/** The token-exchange / refresh step's return. */
export interface McpTokenExchangeResult {
  integrationId: string;
  toolCount: number;
}

/**
 * Read the user's connected MCP integrations for the Settings list.
 * Selects only the columns the browser needs (no client_id /
 * client_secret / discovered_metadata) so the secrets stay off the
 * wire even though RLS would permit reading them. Newest first by
 * updated_at.
 */
export async function listMcpIntegrations(
  client: SupabaseClient
): Promise<McpIntegration[]> {
  const { data, error } = await client
    .from('mcp_integrations')
    .select(
      'id, label, server_url, supports_dcr, auth_status, granted_scopes, created_at, updated_at'
    )
    .order('updated_at', { ascending: false });
  if (error) throw new SupabaseError(error.message);
  return (data ?? [])
    .map((row) => coerceMcpIntegration(row as Record<string, unknown>))
    .filter((m): m is McpIntegration => m !== null);
}

/**
 * Read the cached MCP tool catalog across every integration. One row
 * per (integration, server_tool_name); the dynamic-toolbox builder
 * (src/lib/ui/mcp.ts buildMcpToolboxes) groups these by
 * integration_id at chat-loop entry to assemble each authorized
 * integration's `mcp:<id>` toolbox. Refreshed server-side after OAuth
 * and periodically thereafter - the browser only reads.
 */
export async function listMcpToolSchemas(
  client: SupabaseClient
): Promise<McpToolSchema[]> {
  const { data, error } = await client
    .from('mcp_integration_tools')
    .select(
      'id, integration_id, server_tool_name, description, short_description, wire_schema, last_refreshed_at'
    )
    .order('integration_id', { ascending: true });
  if (error) throw new SupabaseError(error.message);
  return (data ?? [])
    .map((row) => coerceMcpToolSchema(row as Record<string, unknown>))
    .filter((m): m is McpToolSchema => m !== null);
}

/**
 * Delete an integration row. Cascades its `mcp_oauth_tokens` and
 * `mcp_integration_tools` rows (FK on delete cascade in schema.sql).
 * Does NOT call the server's revocation endpoint - use
 * invokeMcpDisconnect for that (revocation + flip to `revoked`,
 * keeping the row for re-authorization); this is the "remove it
 * entirely" path the Settings delete button uses.
 */
export async function deleteMcpIntegration(
  client: SupabaseClient,
  integrationId: string
): Promise<void> {
  const { error } = await client
    .from('mcp_integrations')
    .delete()
    .eq('id', integrationId);
  if (error) throw new SupabaseError(error.message);
}

/**
 * Run the OAuth discovery chain against a pasted server URL. The edge
 * function follows the RFC 9728 protected-resource metadata -> RFC
 * 8414 authorization-server metadata trail and reports whether DCR is
 * available, the endpoints it found, and a preview of the tool
 * catalog. The browser uses the result to show the user what nak
 * found before kicking off the authorization redirect.
 */
export async function invokeMcpDiscover(
  client: SupabaseClient,
  serverUrl: string
): Promise<McpDiscoveredMetadata> {
  const { data, error } = await client.functions.invoke('venice/mcp-discover', {
    body: { serverUrl },
  });
  if (error) throw new SupabaseError(await extractFunctionError(error));
  return (data ?? {}) as McpDiscoveredMetadata;
}

/**
 * Register an OAuth client against the server (via DCR when the
 * discovery supported it) and create the pending `mcp_integrations`
 * row. Returns the authorization URL the browser should redirect to,
 * plus the PKCE verifier + state the token-exchange step needs to
 * complete the flow. The caller must stash the verifier + state +
 * integration id + redirect URI in sessionStorage BEFORE redirecting
 * to authzUrl - the OAuth round-trip is a full page navigation, so
 * nothing in memory survives it. See src/lib/ui/mcp.ts for the
 * sessionStorage keys + src/lib/routing.svelte.ts for the
 * `#mcp-callback` detection that picks the code + state back up.
 */
export async function invokeMcpRegister(
  client: SupabaseClient,
  serverUrl: string,
  redirectUri: string,
  label: string
): Promise<McpRegisterResult> {
  const { data, error } = await client.functions.invoke('venice/mcp-register', {
    body: { serverUrl, redirectUri, label },
  });
  if (error) throw new SupabaseError(await extractFunctionError(error));
  return (data ?? {}) as McpRegisterResult;
}

/**
 * Complete the OAuth flow: swap the authorization code for access +
 * refresh tokens (stored server-side in mcp_oauth_tokens), flip the
 * integration's auth_status to authorized, and seed the
 * mcp_integration_tools cache via a tools/list call. Returns the
 * integration id and the number of tools cached. The PKCE verifier
 * must match the challenge the register step sent; the state must
 * match the one register returned (the caller stashed both in
 * sessionStorage across the redirect).
 */
export async function invokeMcpTokenExchange(
  client: SupabaseClient,
  integrationId: string,
  code: string,
  codeVerifier: string,
  state: string,
  redirectUri: string
): Promise<McpTokenExchangeResult> {
  const { data, error } = await client.functions.invoke(
    'venice/mcp-token-exchange',
    { body: { integrationId, code, codeVerifier, state, redirectUri } }
  );
  if (error) throw new SupabaseError(await extractFunctionError(error));
  return (data ?? { integrationId, toolCount: 0 }) as McpTokenExchangeResult;
}

/**
 * Force a refresh of the cached tool catalog for one integration
 * (re-runs tools/list with the stored token, refreshing the token
 * first if it has expired). Used from the Settings list when the user
 * wants to pick up newly-added server-side tools without re-running
 * OAuth. Returns the integration id + the new tool count.
 */
export async function invokeMcpRefresh(
  client: SupabaseClient,
  integrationId: string
): Promise<McpTokenExchangeResult> {
  const { data, error } = await client.functions.invoke('venice/mcp-refresh', {
    body: { integrationId },
  });
  if (error) throw new SupabaseError(await extractFunctionError(error));
  return (data ?? { integrationId, toolCount: 0 }) as McpTokenExchangeResult;
}

/**
 * Revoke an integration: the edge function calls the server's
 * revocation endpoint (when the discovery advertised one) and flips
 * auth_status to `revoked`. The row stays so the user can
 * re-authorize from the settings list without re-pasting the URL;
 * use deleteMcpIntegration to remove it entirely.
 */
export async function invokeMcpDisconnect(
  client: SupabaseClient,
  integrationId: string
): Promise<void> {
  const { error } = await client.functions.invoke('venice/mcp-disconnect', {
    body: { integrationId },
  });
  if (error) throw new SupabaseError(await extractFunctionError(error));
}

/**
 * Pull the { error } string off a functions.invoke failure. The
 * venice function normalizes every error body to `{ error: string }`
 * (optionally `{ error, kind, retryAfterMs }`); a non-JSON or
 * transport failure falls back to a generic message. Kept
 * slice-local rather than reusing venice-proxy's veniceFunctionError
 * because MCP errors are not VeniceErrors - they surface as plain
 * SupabaseError so the Settings pane renders them through its
 * existing error path instead of the chat-loop's VeniceError handling.
 */
async function extractFunctionError(error: unknown): Promise<string> {
  const ctx = (error as { context?: unknown }).context;
  if (ctx instanceof Response) {
    try {
      const payload = (await ctx.clone().json()) as {
        error?: string;
      } | null;
      if (payload && typeof payload.error === 'string') return payload.error;
    } catch {
      // Non-JSON body - fall through to the status line.
    }
    return `MCP function request failed (HTTP ${ctx.status})`;
  }
  return error instanceof Error ? error.message : String(error);
}
