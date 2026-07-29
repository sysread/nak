// MCP catalog refresh sweep (function-side, cron-driven). Daily tick
// that re-fetches the tool catalog for every authorized integration
// across all users. Uses the stored access token (auto-refreshed via
// getValidAccessToken) so no user interaction is needed.
//
// The tool catalog is cached in mcp_integration_tools at connect time
// (handleMcpTokenExchange). Without a periodic refresh, an MCP server
// that changes its tool catalog (adds, removes, or renames tools) is
// invisible to nak until the user disconnects and reconnects. This
// sweep closes that gap.
//
// Best-effort by contract: one integration failing must not stop the
// next. Token refresh failures (revoked grant, expired refresh token)
// mark the integration `expired` so the Settings UI can surface a
// re-authorize badge (Q8). Catalog fetch failures are logged and
// skipped - the old catalog stays in place.
//
// No claim-RPC: the refresh is idempotent and read-only from the DB's
// perspective. Two overlapping ticks re-fetch the same catalog and
// the second upsert wins, which is harmless.

import type { SupabaseClient } from '@supabase/supabase-js';
import { createEdgeLogger } from '../../_shared/edge-log.ts';
import {
  listAllAuthorizedIntegrations,
  getValidAccessToken,
  storeToolCatalog,
  updateIntegrationStatus,
} from './token-store.ts';
import { listMcpTools } from './oauth.ts';

/**
 * Daily catalog refresh tick. Iterates every authorized integration
 * across all users, re-fetches its tool catalog, and upserts the
 * cached schemas. Non-throwing by contract - failures are caught and
 * logged per-integration so the sweep handler never sees a rejection.
 */
export async function runMcpCatalogRefreshTick(
  admin: SupabaseClient,
): Promise<void> {
  const log = createEdgeLogger('system', 'mcp-catalog-refresh');

  let integrations;
  try {
    integrations = await listAllAuthorizedIntegrations(admin);
  } catch (err) {
    log.error(`failed to list authorized integrations: ${(err as Error).message}`);
    return;
  }

  if (integrations.length === 0) {
    log.info('no authorized integrations; nothing to refresh');
    return;
  }

  let refreshed = 0;
  let failed = 0;
  let expired = 0;

  for (const integ of integrations) {
    try {
      const accessToken = await getValidAccessToken(
        admin,
        integ.user_id,
        integ.id,
      );

      const tools = await listMcpTools(integ.server_url, accessToken);
      await storeToolCatalog(admin, integ.user_id, integ.id, tools);
      refreshed += 1;
      log.info(
        `refreshed ${integ.label}: ${tools.length} tools`,
        { userId: integ.user_id, integrationId: integ.id },
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);

      // A token refresh failure means the grant is dead or expired.
      // Mark the integration `expired` so the Settings UI can show a
      // re-authorize badge. Other failures (server unreachable,
      // tools/list error) leave the old catalog in place and are
      // just logged - the integration is still usable for tool calls.
      if (message.includes('invalid_grant') || message.includes('refresh')) {
        try {
          await updateIntegrationStatus(admin, integ.user_id, integ.id, 'expired');
          expired += 1;
          log.info(
            `marked ${integ.label} expired (token refresh failed)`,
            { userId: integ.user_id, integrationId: integ.id },
          );
        } catch {
          failed += 1;
          log.error(
            `failed to mark ${integ.label} expired: ${message}`,
            { userId: integ.user_id, integrationId: integ.id },
          );
        }
      } else {
        failed += 1;
        log.error(
          `refresh failed for ${integ.label}: ${message}`,
          { userId: integ.user_id, integrationId: integ.id },
        );
      }
    }
  }

  log.info(
    `tick complete: ${refreshed} refreshed, ${expired} expired, ${failed} failed`,
  );
}
