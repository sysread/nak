// dispatch --------------------------------------------------------------------
//
// MCP tool-call dispatcher plumbed into `performToolCall`. The static
// tool registry in `../performToolCall.ts` lists every built-in tool
// the browser composes into the wire `tools` array. MCP-routed tools
// are NOT in that registry - they live per-user, resolved at dispatch
// time from the `mcp_integration_tools` cache and dispatched by an
// outbound JSON-RPC `tools/call` to the integration's MCP server URL
// with the user's bearer token. The two-tier dispatch shape:
//
//   performToolCall:
//     1. Look up name in the static registry -> run native impl
//     2. Else if name starts with `mcp:` -> dispatchMcpTool (this file)
//     3. Else throw ToolNotImplementedError
//
// Tool name format: `mcp:<integrationId>:<serverToolName>`. The
// integrationId is a UUID (no colons), so the split on the first
// colon after the `mcp:` prefix is unambiguous. The wire schema's
// `mcp_integration_tools.wire_name` column (cached) carries this
// string verbatim so the augmentation block in `getStreamingResponse`
// emits the exact name `dispatchMcpTool` knows how to parse.
//
// All DB access is b-strict service-role with `.eq('user_id', userId)`
// on every query - service-role bypasses RLS, the userId filter is
// the only ownership boundary (see docs/dev/edge-function-auth.md).

import { callMcpTool } from './oauth.ts';
import { VeniceError } from '../../_shared/venice.ts';
import { withUntrustedNotice } from '../untrusted-content.ts';
import {
  getIntegration,
  getValidAccessToken,
} from './token-store.ts';
import type { ToolContext } from '../performToolCall.ts';
import type { ToolCallRequest } from '../../_shared/venice-stream.ts';

const MCP_PREFIX = 'mcp:';

/** True when `name` is a per-user MCP-routed tool (`mcp:<id>:<tool>`). */
export function isMcpToolName(name: string): boolean {
  return name.startsWith(MCP_PREFIX);
}

/**
 * Split `mcp:<integrationId>:<serverToolName>` into its parts. The
 * integrationId is a UUID (36 chars, hyphens only, no colons); the
 * serverToolName is the MCP spec's tool name (lowercase ASCII with
 * hyphens/underscores per the MCP convention). We split on the FIRST
 * colon after the prefix so a hypothetical colon in a server tool name
 * is preserved; v1 servers do not emit those, so the simple split is
 * safe and reads clearly.
 */
function parseMcpToolName(name: string): {
  integrationId: string;
  serverToolName: string;
} {
  const rest = name.slice(MCP_PREFIX.length);
  const sep = rest.indexOf(':');
  if (sep <= 0) {
    throw new Error(
      `malformed MCP tool name (missing \`<integrationId>:<serverToolName>\` separator): ${name}`,
    );
  }
  const integrationId = rest.slice(0, sep);
  const serverToolName = rest.slice(sep + 1);
  if (integrationId.length === 0 || serverToolName.length === 0) {
    throw new Error(
      `malformed MCP tool name (empty integrationId or serverToolName): ${name}`,
    );
  }
  return { integrationId, serverToolName };
}

/**
 * Resolve one MCP tool call to its integration + bearer token, send a
 * JSON-RPC `tools/call` to the MCP server URL, return the `content`
 * array the server returned under an untrusted-content notice. The
 * orchestrator (`getStreamingResponse`) passes the return value through
 * `encodeToolContent`, which JSON-stringifies it into the tool-result
 * row's `content` column.
 *
 * Token refresh is delegated to `getValidAccessToken` so the dispatcher
 * sees an opaque "give me a live token" contract; the refresh dance
 * (expire check, refresh API call, atomic row update) lives in the
// token-store helper, not here.
 *
 * Failure modes:
 *   - integration row missing or auth_status != 'authorized' -> throw
 *     a plain Error; the orchestrator renders it as a tool-result
 *     error the model sees on the next round.
 *   - VeniceError from the MCP `tools/call` (auth/HTTP/network/parse)
 *     bubbles unchanged; the orchestrator's try/catch converts it to
 *     a tool-result row carrying the message.
 *   - tool-level `isError: true` from the MCP server is NOT an error
 *     here; we return it as a successful call so the model sees the
 *     server's "I ran but the call itself returned an error" payload
 *     rather than a transport-failure row.
 */
export async function dispatchMcpTool(
  request: ToolCallRequest,
  ctx: ToolContext,
): Promise<unknown> {
  const { integrationId, serverToolName } = parseMcpToolName(request.name);

  const integration = await getIntegration(ctx.adminClient, ctx.userId, integrationId);
  if (!integration) {
    throw new Error(
      `MCP tool ${request.name} could not resolve integration ${integrationId} for user`,
    );
  }
  if (integration.auth_status !== 'authorized') {
    // The model can still emit the name when the catalog listed it
    // earlier in the session - the user may have revoked between
    // turns. Surfacing the auth_status gives the model enough to tell
    // the user the integration needs re-authorizing.
    throw new Error(
      `MCP integration ${integration.label} (status: ${integration.auth_status}) is not authorized; re-authorize it in Settings -> Integrations`,
    );
  }

  const accessToken = await getValidAccessToken(
    ctx.adminClient,
    ctx.userId,
    integrationId,
  );

  try {
    const result = await callMcpTool(
      integration.server_url,
      accessToken,
      serverToolName,
      request.args,
    );
    // Every byte in `result.content` was authored by a server the user
    // pasted a URL for, not by nak - tag it so the model reads it as
    // data. See ../untrusted-content.ts for why the notice is a
    // sibling key rather than a prose prefix.
    return withUntrustedNotice(`the "${integration.label}" MCP integration`, {
      content: result.content,
      isError: result.isError,
    });
  } catch (err) {
    // A 401 here means the access token was revoked server-side (the
    // refresh path above already tried rotating it; this 401 is the
    // fresh-rotated token being rejected). Re-surfacing as a
    // VeniceError keeps the orchestrator's terminal classification
    // intact; the user needs to re-authorize from settings.
    if (err instanceof VeniceError && err.kind === 'auth') {
      throw new Error(
        `MCP server rejected the access token for ${integration.label}; re-authorize it in Settings -> Integrations`,
      );
    }
    // Re-throw as an Error so the chat-loop's tool-result path
    // renders a stable message; a non-Error throw (rare from fetch)
    // gets stringified into one so the model still sees a payload.
    throw err instanceof Error
      ? err
      : new Error(`MCP tools/call to ${integration.label} failed: ${String(err)}`);
  }
}