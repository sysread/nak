// Blocked-model policy (server side). Mirror of
// src/lib/models/blocked-models.ts - this island cannot import from
// src/lib; keep the two in sync.
//
// NO Grok (xAI) model may be used anywhere in the app - chat, image
// generation, image editing, anything. Owner directive, 2026-10-12.
// The browser pickers filter the catalogs and scrub stored settings,
// but the browser is not trusted: a settings row or a request body can
// carry any id (stale override, older client, hand-crafted call), so
// every route that forwards a model id to Venice checks it here, at
// the only layer that holds the API key. Same case-insensitive
// "grok" substring contract as the browser copy - see that file for
// why substring rather than an id list.

const BLOCKED_MODEL_PATTERN = /grok/i;

/** True when the model id matches the blocked list. */
export function isBlockedModelId(id: string): boolean {
  return BLOCKED_MODEL_PATTERN.test(id);
}

/**
 * Remove blocked entries from a relayed /models catalog body before it
 * reaches the browser. Venice's envelope carries the rows under
 * `data`; any other shape passes through unchanged. The browser
 * coercion filters again on its side, so this is the source-side net
 * that also covers stale clients.
 */
export function stripBlockedCatalogEntries(body: unknown): unknown {
  if (typeof body !== 'object' || body === null) return body;
  const rows = (body as { data?: unknown }).data;
  if (!Array.isArray(rows)) return body;
  const kept = rows.filter((row) => {
    const id = (row as { id?: unknown } | null)?.id;
    return typeof id !== 'string' || !isBlockedModelId(id);
  });
  return { ...(body as Record<string, unknown>), data: kept };
}
