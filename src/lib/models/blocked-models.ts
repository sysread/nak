/**
 * Blocked-model policy: NO Grok (xAI) model may be used anywhere in
 * this app - chat profiles, image generation, image editing, the
 * background agents, anything that resolves to a Venice model id. This
 * is a hard owner directive (Jeff, 2026-10-12), not a pricing or
 * capability preference.
 *
 * Enforcement is layered, and this module is the browser half:
 *
 *   - Every catalog coercion (./catalog.ts, ./image-catalog.ts,
 *     ./edit-image-catalog.ts) drops matching rows, so no picker can
 *     ever offer a Grok model.
 *   - Persisted state is scrubbed on read: a stored profile or an
 *     image/edit model override pointing at a blocked id is treated as
 *     absent (see coerceModelProfile and coerceSettings).
 *   - The venice edge function enforces the same predicate against
 *     request bodies and stored settings at the layer that holds the
 *     API key. Its mirror lives in
 *     supabase/functions/_shared/blocked-models.ts - the two islands
 *     cannot import from each other; keep the pattern in sync.
 *
 * The match is a case-insensitive "grok" substring on the model id,
 * covering every current and future Venice listing for the family:
 * text ids like `grok-41-fast`, image ids like `grok-imagine`. A
 * substring match is deliberate: Venice renumbers and adds models
 * without warning, so an id allowlist/denylist would rot. The
 * failure mode of over-matching (a model wrongly hidden) is exactly
 * what a hard exclusion wants; the failure mode of under-matching (a
 * Grok model silently serving requests) is not.
 */

const BLOCKED_MODEL_PATTERN = /grok/i;

/**
 * True when the model id matches the blocked list. Catalog rows pass
 * the display name as the second argument so a rename on Venice's side
 * cannot smuggle the model past the picker.
 */
export function isBlockedModelId(id: string, displayName?: string): boolean {
  if (BLOCKED_MODEL_PATTERN.test(id)) return true;
  return displayName !== undefined && BLOCKED_MODEL_PATTERN.test(displayName);
}
