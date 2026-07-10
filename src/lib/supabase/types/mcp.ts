/**
 * MCP-integration domain types and coercers: the browser-side shape
 * of a `mcp_integrations` row (`McpIntegration`) and a cached
 * `mcp_integration_tools` row (`McpToolSchema`), plus the coercers
 * that scrub the raw Supabase rows into well-typed values. Re-
 * exported through `../../supabase.ts` so consumers keep importing
 * from `$lib/supabase`.
 *
 * The browser NEVER reads `mcp_oauth_tokens` - access and refresh
 * tokens are bearer credentials owned by the edge function (see the
 * `mcp_oauth_tokens` block in supabase/schema.sql). `McpIntegration`
 * deliberately omits `client_id`, `client_secret`,
 * `registered_redirect_uri`, and `discovered_metadata`: those are
 * edge-function-only fields. The browser surface is the minimum the
 * Settings Integrations list and the dynamic-toolbox builder need.
 */

export type McpAuthStatus = 'pending' | 'authorized' | 'revoked';

/**
 * One connected remote MCP server. Mirrors the columns the browser
 * selects from `mcp_integrations` (see ./../mcp.ts listMcpIntegrations)
 * - every field the browser reads is here, every field only the edge
 * function touches is not. The auth_status drives both the Settings
 * list badge and which integrations the toolbox builder exposes to
 * the chat model (only `authorized` ones do).
 */
export interface McpIntegration {
  id: string;
  label: string;
  serverUrl: string;
  /** Whether the server's auth advertised RFC 7591 DCR. */
  supportsDcr: boolean;
  authStatus: McpAuthStatus;
  /** Scopes the user actually granted at authorization. */
  grantedScopes: string[];
  createdAt: string;
  updatedAt: string;
}

export function isMcpAuthStatus(v: unknown): v is McpAuthStatus {
  return v === 'pending' || v === 'authorized' || v === 'revoked';
}

/**
 * Scrub a raw `mcp_integrations` row into a well-typed McpIntegration.
 * Returns null when the identifying columns (id / label / server_url)
 * are missing or malformed so a half-written row degrades to "skipped"
 * in the list rather than crashing the Settings pane. auth_status
 * falls back to `pending` (the schema default) on an unknown value so
 * a future status the browser doesn't recognise yet still renders.
 */
export function coerceMcpIntegration(raw: unknown): McpIntegration | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as Record<string, unknown>;
  const id = typeof r.id === 'string' ? r.id : null;
  const label = typeof r.label === 'string' ? r.label : null;
  const serverUrl = typeof r.server_url === 'string' ? r.server_url : null;
  if (id === null || label === null || serverUrl === null) return null;
  const supportsDcr = r.supports_dcr === true;
  const authStatus: McpAuthStatus = isMcpAuthStatus(r.auth_status)
    ? r.auth_status
    : 'pending';
  const grantedScopes = Array.isArray(r.granted_scopes)
    ? r.granted_scopes.filter((s): s is string => typeof s === 'string')
    : [];
  const createdAt = typeof r.created_at === 'string' ? r.created_at : '';
  const updatedAt = typeof r.updated_at === 'string' ? r.updated_at : '';
  return {
    id,
    label,
    serverUrl,
    supportsDcr,
    authStatus,
    grantedScopes,
    createdAt,
    updatedAt,
  };
}

/**
 * One cached tool from an integration's `mcp_integration_tools` row.
 * The wire_schema is the JSON Schema the MCP server's tools/list
 * returned as `inputSchema`; the toolbox builder projects it verbatim
 * onto the wire `tools` array, so the browser never interprets it.
 */
export interface McpToolSchema {
  id: string;
  integrationId: string;
  /** Tool name as the MCP server defines it (e.g. "search_email"). */
  serverToolName: string;
  /** Full description from the MCP server (rides the wire tools array). */
  description: string;
  /** <50-char brief for the system-prompt catalog line. */
  shortDescription: string;
  /** JSON Schema for the tool's input parameters (inputSchema). */
  wireSchema: Record<string, unknown>;
  lastRefreshedAt: string;
}

/**
 * Scrub a raw `mcp_integration_tools` row into a well-typed
 * McpToolSchema. Returns null when the identifying columns are
 * missing. wire_schema coerces to `{}` when absent or malformed so a
 * server that omitted inputSchema still produces a dispatchable
 * (parameterless) tool rather than crashing the toolbox builder.
 */
export function coerceMcpToolSchema(raw: unknown): McpToolSchema | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as Record<string, unknown>;
  const id = typeof r.id === 'string' ? r.id : null;
  const integrationId =
    typeof r.integration_id === 'string' ? r.integration_id : null;
  const serverToolName =
    typeof r.server_tool_name === 'string' ? r.server_tool_name : null;
  if (id === null || integrationId === null || serverToolName === null) {
    return null;
  }
  const description = typeof r.description === 'string' ? r.description : '';
  const shortDescription =
    typeof r.short_description === 'string' ? r.short_description : '';
  const wireSchema =
    typeof r.wire_schema === 'object' &&
    r.wire_schema !== null &&
    !Array.isArray(r.wire_schema)
      ? (r.wire_schema as Record<string, unknown>)
      : {};
  const lastRefreshedAt =
    typeof r.last_refreshed_at === 'string' ? r.last_refreshed_at : '';
  return {
    id,
    integrationId,
    serverToolName,
    description,
    shortDescription,
    wireSchema,
    lastRefreshedAt,
  };
}
