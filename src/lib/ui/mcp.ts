/**
 * Pure UI-behavior primitives for the MCP-integrations feature.
 *
 * Per the Svelte-is-glue convention (docs/dev/frontend-organization.md)
 * these are framework-agnostic transforms the Settings Integrations
 * pane and the chat-loop's MCP-toolbox builder call; the .svelte file
 * holds only prop destructuring, event handlers that delegate here,
 * and the markup. No `$state`, no DOM, no side effects - everything
 * here is a pure function over its arguments.
 *
 * Toolbox-name convention: each authorized integration becomes a
 * gated toolbox named `mcp:<id>`, and each tool inside it is wired as
 * `mcp:<integrationId>:<serverToolName>`. The `mcp:` prefix is the
 * contract the server-side toggle handler
 * (supabase/functions/venice/tools/toggle_tools.ts) accepts as a
 * runtime-discovered toolbox - it can't sit in the static
 * GATED_TOOLBOX_NAMES mirror because the ids are per-user.
 */
import type { McpIntegration, McpToolSchema } from '../supabase';
import type { Toolbox, ToolDef } from '../tools';
import { serverSideTool } from '../tools/server_side';

/**
 * The app URL nak returns to after an OAuth redirect. OAuth 2.1 forbids
 * fragments (`#`) in redirect URIs, so callbacks use query params and
 * routing.svelte.ts stashes `code` + `state` in sessionStorage on boot.
 */
export function mcpAppReturnUri(): string {
  return window.location.origin + window.location.pathname;
}

/**
 * Redirect URI registered with the MCP server. The app URL is the
 * only callback target: localhost works for local dev, and manually
 * registered hosted clients can register the deployed PWA URL directly.
 */
export function mcpRedirectUri(): string {
  return mcpAppReturnUri();
}

/** Human-readable label for an integration's auth status. */
export function mcpStatusLabel(status: McpIntegration['authStatus']): string {
  switch (status) {
    case 'authorized':
      return 'Connected';
    case 'revoked':
      return 'Disconnected';
    case 'expired':
      return 'Authorization expired';
    case 'pending':
    default:
      return 'Awaiting authorization';
  }
}

/**
 * True when an integration's auth status indicates a problem the user
 * should act on - the grant expired or was revoked, so the server's
 * tools are unavailable until the user re-authorizes. The Settings
 * Integrations pane uses this to show a badge and a Reauthorize button
 * alongside the status label.
 */
export function mcpStatusNeedsAttention(
  status: McpIntegration['authStatus'],
): boolean {
  return status === 'expired' || status === 'revoked';
}

/**
 * Short explanatory hint for an attention-worthy status. The expired
 * case covers two scenarios: the OAuth code-exchange window timed out
 * (the user didn't complete the consent redirect quickly enough), or
 * the daily catalog-refresh sweep found the refresh token dead (the
 * server revoked the grant or the refresh token expired). Both resolve
 * the same way - reauthorize to restart the OAuth flow.
 */
export function mcpStatusHint(status: McpIntegration['authStatus']): string | null {
  switch (status) {
    case 'expired':
      return 'The authorization has expired - reauthorize to reconnect.';
    case 'revoked':
      return 'The server revoked access - reauthorize to reconnect.';
    default:
      return null;
  }
}

/**
 * The gated-toolbox name for one integration - the string that lives
 * in `threads.toolboxes_enabled` and that toggle_toolbox validates.
 * The `mcp:` prefix is the contract the server-side toggle handler
 * accepts as a runtime-discovered toolbox (see toggle_tools.ts); the
 * label is a per-user unique slug chosen at integration time, so
 * the model reads `mcp:Fastmail` rather than a uuid.
 */
export function mcpIntegrationToolboxName(
  integration: Pick<McpIntegration, 'label'>
): string {
  return `mcp:${integration.label}`;
}

/**
 * The wire tool name for one MCP tool - namespaced by integration id
 * so tools from different servers can't collide, and so the edge
 * function's performToolCall can split on `mcp:` to resolve the
 * integration id + the server-side tool name for dispatch.
 */
export function mcpToolWireName(
  integrationId: string,
  serverToolName: string
): string {
  return `mcp:${integrationId}:${serverToolName}`;
}

/**
 * Build the dynamic `Toolbox` entries for the chat-loop from the
 * authorized integrations + their cached tool catalog. Each
  * `authorized` integration becomes one gated toolbox named
  * `mcp:<label>` (the label is a per-user unique slug); every cached
  * tool becomes a schema-only ToolDef whose wire name is
 * `mcp:<integrationId>:<serverToolName>`. The toolbox toggle gates
 * on the label, dispatch resolves the immutable uuid - so renaming
 * a label doesn't break existing `toolboxes_enabled` entries.
 *
 * `pending` / `revoked` integrations are dropped: only `authorized`
 * integrations expose tools to the model. The chat-loop passes the
 * result as the optional `mcpToolboxes` arg to buildToolList,
 * buildCatalog, and buildToolboxStateBlock so the static + dynamic
 * catalogs compose under one dedup-by-name pass. Integrations with no
 * cached tools still produce an (empty) toolbox so the toggle state
 * block reports them - the model sees the integration exists even
 * before the catalog finishes populating.
 */
export function buildMcpToolboxes(
  integrations: readonly McpIntegration[],
  toolSchemas: readonly McpToolSchema[]
): Toolbox[] {
  const byIntegration = new Map<string, McpToolSchema[]>();
  for (const s of toolSchemas) {
    const list = byIntegration.get(s.integrationId) ?? [];
    list.push(s);
    byIntegration.set(s.integrationId, list);
  }
  const out: Toolbox[] = [];
  for (const integ of integrations) {
    if (integ.authStatus !== 'authorized') continue;
    const rows = byIntegration.get(integ.id) ?? [];
    const tools: ToolDef[] = rows.map((row) =>
      serverSideTool({
        name: mcpToolWireName(integ.id, row.serverToolName),
        description: row.description,
        shortDescription: row.shortDescription,
        parameters: row.wireSchema,
      })
    );
    out.push({
      name: mcpIntegrationToolboxName({ label: integ.label }),
      // The toolbox description the system-prompt catalog renders is
      // the user's label for the integration ("Fastmail"), so the
      // model reads a human-meaningful name rather than a uuid.
      description: integ.label,
      tools,
    });
  }
  return out;
}

/**
 * Lightweight extraction of the {name, description} pairs from
 * authorized MCP integrations for the toolbox popup. The popup only
 * needs name + description to render a checkbox; `buildMcpToolboxes`
 * carries the full ToolDef[] payload that the chat-loop needs.
 */
export function mcpToolboxMetaItems(
  integrations: readonly McpIntegration[]
): readonly { name: string; description: string }[] {
  return integrations
    .filter((i) => i.authStatus === 'authorized')
    .map((i) => ({
      name: mcpIntegrationToolboxName(i),
      description: i.label,
    }));
}

// --- OAuth round-trip sessionStorage keys ----------------------------
//
// The OAuth flow is a full-page redirect away from this tab and back,
// so nothing in memory survives it. The register step stashes the
// PKCE verifier + state + integration id + redirect URI here before
// the redirect; the routing layer stashes the code + state it parses
// out of the query params on return; the Settings Integrations
// pane reads both halves on mount to complete the token exchange, then
// clears them. Centralised here so the writer (Settings pane) and the
// reader (routing + Settings pane) stay in sync without a shared
// string literal drifting across modules.

/** PKCE verifier the register step returned; needed at token exchange. */
export const MCP_REGISTER_VERIFIER_KEY = 'nak:mcp-pkce:verifier';
/** OAuth state the register step returned; must match on callback. */
export const MCP_REGISTER_STATE_KEY = 'nak:mcp-pkce:state';
/** Integration id the register step created. */
export const MCP_REGISTER_ID_KEY = 'nak:mcp-pkce:integration-id';
/** Redirect URI used at register; must match at token exchange. */
export const MCP_REGISTER_REDIRECT_KEY = 'nak:mcp-pkce:redirect';
/** Authorization code the routing layer parsed off the callback query params. */
export const MCP_CALLBACK_CODE_KEY = 'nak:mcp-callback:code';
/** State the routing layer parsed off the callback query params. */
export const MCP_CALLBACK_STATE_KEY = 'nak:mcp-callback:state';

/**
 * Stash the register step's PKCE material so the OAuth callback hop
 * can complete the token exchange. Writer: the Settings Integrations
 * pane, immediately before `window.location.href = authzUrl`. Reader:
 * the same pane on mount, after the routing layer has stashed the
 * code + state from the callback query params.
 */
export function stashMcpRegisterContext(ctx: {
  integrationId: string;
  codeVerifier: string;
  state: string;
  redirectUri: string;
}): void {
  sessionStorage.setItem(MCP_REGISTER_ID_KEY, ctx.integrationId);
  sessionStorage.setItem(MCP_REGISTER_VERIFIER_KEY, ctx.codeVerifier);
  sessionStorage.setItem(MCP_REGISTER_STATE_KEY, ctx.state);
  sessionStorage.setItem(MCP_REGISTER_REDIRECT_KEY, ctx.redirectUri);
}

/**
 * Read + clear the stashed register context. Returns null when no
 * register is in flight (no callback pending, or the keys were
 * already consumed). Clears the keys unconditionally so a stale
 * register from a previous attempt can't drive a second exchange.
 */
export function consumeMcpRegisterContext(): {
  integrationId: string;
  codeVerifier: string;
  state: string;
  redirectUri: string;
} | null {
  const integrationId = sessionStorage.getItem(MCP_REGISTER_ID_KEY);
  const codeVerifier = sessionStorage.getItem(MCP_REGISTER_VERIFIER_KEY);
  const state = sessionStorage.getItem(MCP_REGISTER_STATE_KEY);
  const redirectUri = sessionStorage.getItem(MCP_REGISTER_REDIRECT_KEY);
  clearMcpRegisterContext();
  if (
    !integrationId ||
    !codeVerifier ||
    !state ||
    !redirectUri
  ) {
    return null;
  }
  return { integrationId, codeVerifier, state, redirectUri };
}

/** Drop the stashed register context without reading it. */
export function clearMcpRegisterContext(): void {
  sessionStorage.removeItem(MCP_REGISTER_ID_KEY);
  sessionStorage.removeItem(MCP_REGISTER_VERIFIER_KEY);
  sessionStorage.removeItem(MCP_REGISTER_STATE_KEY);
  sessionStorage.removeItem(MCP_REGISTER_REDIRECT_KEY);
}

/**
 * Read + clear the OAuth callback code + state the routing layer
 * stashed off the callback query params. Returns null when no callback
 * landed (the keys are absent or were already consumed). Clears the
 * keys unconditionally so a stale callback can't drive a second
 * exchange.
 */
export function consumeMcpCallback(): { code: string; state: string } | null {
  const code = sessionStorage.getItem(MCP_CALLBACK_CODE_KEY);
  const state = sessionStorage.getItem(MCP_CALLBACK_STATE_KEY);
  sessionStorage.removeItem(MCP_CALLBACK_CODE_KEY);
  sessionStorage.removeItem(MCP_CALLBACK_STATE_KEY);
  if (!code || !state) return null;
  return { code, state };
}
