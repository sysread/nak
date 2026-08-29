/**
 * Shared active-session mechanics for the two live user activities
 * that follow the account: the grocery shopping trip ("Start
 * shopping") and per-recipe cooking sessions ("Make this now").
 * Both persist in `UserSettings.activeSessions` - one map, several
 * cooking sessions may be open at once (a main and a side).
 *
 * The wire shape, key builders, and coercer live in the settings
 * boundary (`supabase/types/settings.ts`); the read-modify-write IO
 * lives in the settings slice (`supabase/settings.ts`
 * `updateActiveSessions`). This module owns the expiry POLICY and
 * the small pure mutators the screens fold into that helper. Pure
 * functions only - no runes, no Svelte, no DOM, no IO.
 */
import {
  cookingSessionKey,
  isCookingSessionKey,
  SHOPPING_SESSION_KEY,
  type ActiveSession,
} from '../supabase';

/**
 * How long a cooking session stays active: the rest of the calendar
 * day it started on, but never more than this many hours. The
 * same-day rule handles the common "cooked dinner, forgot to hit
 * Done" case at midnight; the age ceiling handles an overnight cook
 * (started 11pm, still marked in-progress the next morning). The
 * shopping trip has no age bound - midnight only.
 */
export const COOKING_SESSION_MAX_AGE_HOURS = 6;

/**
 * Whether a timestamp falls on the same local calendar day as `now`
 * (comparing days, not a 24h window, is what makes expiry happen at
 * midnight in the user's timezone with no cleanup write).
 */
function isSameLocalDay(started: Date, now: Date): boolean {
  return (
    started.getFullYear() === now.getFullYear() &&
    started.getMonth() === now.getMonth() &&
    started.getDate() === now.getDate()
  );
}

/**
 * Whether the session stored under `key` is still active. A session
 * is active when its startedAt parses, is not in the future, and
 * falls on the same local calendar day as `now`; cooking sessions
 * are additionally capped at COOKING_SESSION_MAX_AGE_HOURS. An
 * expired entry simply reads as inactive - no write is needed.
 */
export function isSessionKeyActive(
  key: string,
  startedAt: string | undefined,
  now: Date
): boolean {
  if (!startedAt) return false;
  const started = new Date(startedAt);
  if (Number.isNaN(started.getTime())) return false;
  if (started > now) return false;
  if (!isSameLocalDay(started, now)) return false;
  if (isCookingSessionKey(key)) {
    if (now.getTime() - started.getTime() > COOKING_SESSION_MAX_AGE_HOURS * 3_600_000) {
      return false;
    }
  }
  return true;
}

/**
 * Copy of `map` with every expired entry dropped. Returns the SAME
 * map object when nothing was pruned so callers can cheaply detect
 * "no change". Callers fold this into any session-map write, which
 * keeps the map bounded without a dedicated cleanup sweep - a
 * cooking session whose user never hit "Done cooking" would
 * otherwise sit in the settings blob forever.
 */
export function pruneExpiredSessions(
  map: Record<string, ActiveSession>,
  now: Date
): Record<string, ActiveSession> {
  let changed = false;
  const out: Record<string, ActiveSession> = {};
  for (const [key, entry] of Object.entries(map)) {
    if (isSessionKeyActive(key, entry.startedAt, now)) out[key] = entry;
    else changed = true;
  }
  return changed ? out : map;
}

/**
 * Copy of `map` with the shopping trip started (startedAt set) or
 * stopped (undefined), pruning expired sessions first.
 */
export function withShoppingTrip(
  map: Record<string, ActiveSession>,
  startedAt: string | undefined,
  now: Date
): Record<string, ActiveSession> {
  const next = pruneExpiredSessions(map, now);
  if (startedAt === undefined) delete next[SHOPPING_SESSION_KEY];
  else next[SHOPPING_SESSION_KEY] = { startedAt, used: [] };
  return next;
}

/**
 * Copy of `map` with a recipe's cooking session started or ended.
 * Starting always begins a FRESH session (empty used list) - stale
 * marks from a same-day session the user abandoned should not leak
 * into the new one. Ending removes the entry entirely.
 */
export function withCookingSession(
  map: Record<string, ActiveSession>,
  recipeId: string,
  startedAt: string | undefined,
  now: Date
): Record<string, ActiveSession> {
  const next = pruneExpiredSessions(map, now);
  const key = cookingSessionKey(recipeId);
  if (startedAt === undefined) delete next[key];
  else next[key] = { startedAt, used: [] };
  return next;
}

/**
 * Copy of `map` with `name` toggled in a recipe's cooking session's
 * used list (checking an ingredient = "used", unchecking = not used
 * yet). No-op when the recipe has no session entry - the caller only
 * renders used-toggles while the session is active, so a missing
 * entry means the session expired between render and click; the
 * caller re-derives its state from the returned settings and the
 * checkbox rolls back.
 */
export function withUsedIngredient(
  map: Record<string, ActiveSession>,
  recipeId: string,
  name: string
): Record<string, ActiveSession> {
  const next = { ...map };
  const key = cookingSessionKey(recipeId);
  const entry = next[key];
  if (!entry) return map;
  const used = entry.used.includes(name)
    ? entry.used.filter((n) => n !== name)
    : [...entry.used, name];
  next[key] = { ...entry, used };
  return next;
}

/** Label for the cooking-mode toggle button. */
export function cookingToggleLabel(active: boolean): string {
  return active ? 'Done cooking' : 'Make this now';
}

/** Progress line under/next to the toggle while cooking. */
export function cookingProgressLabel(usedCount: number, total: number): string {
  return `${usedCount} of ${total} used`;
}

/** Accessible label for an ingredient checkbox in cooking mode. */
export function usedIngredientAriaLabel(name: string): string {
  return `Mark ${name} as used`;
}
