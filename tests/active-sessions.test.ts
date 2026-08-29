import { describe, it, expect } from 'vitest';
import {
  COOKING_SESSION_MAX_AGE_HOURS,
  cookingProgressLabel,
  cookingToggleLabel,
  isSessionKeyActive,
  pruneExpiredSessions,
  usedIngredientAriaLabel,
  withCookingSession,
  withShoppingTrip,
  withUsedIngredient,
} from '../src/lib/ui/active-sessions';
import {
  coerceActiveSessions,
  coerceSettings,
  cookingSessionKey,
  isCookingSessionKey,
  SHOPPING_SESSION_KEY,
} from '../src/lib/supabase';

const MORNING = new Date(2026, 6, 15, 8, 0);
const EVENING = new Date(2026, 6, 15, 20, 0);
const NEXT_DAY = new Date(2026, 6, 16, 0, 1);
const MORNING_ISO = MORNING.toISOString();

describe('session keys', () => {
  it('builds and classifies cooking keys', () => {
    expect(cookingSessionKey('abc')).toBe('cooking:abc');
    expect(isCookingSessionKey('cooking:abc')).toBe(true);
    expect(isCookingSessionKey('cooking:')).toBe(true);
    expect(isCookingSessionKey('shopping')).toBe(false);
  });
});

describe('isSessionKeyActive', () => {
  it('is active for the rest of the calendar day it started on', () => {
    expect(isSessionKeyActive('shopping', MORNING_ISO, EVENING)).toBe(true);
  });

  it('expires at local midnight (next day reads inactive)', () => {
    expect(isSessionKeyActive('shopping', MORNING_ISO, NEXT_DAY)).toBe(false);
  });

  it('cooking sessions additionally expire after the age ceiling', () => {
    const fiveHoursLater = new Date(MORNING.getTime() + 5 * 3_600_000);
    const sevenHoursLater = new Date(MORNING.getTime() + 7 * 3_600_000);
    expect(isSessionKeyActive('cooking:r1', MORNING_ISO, fiveHoursLater)).toBe(
      true
    );
    expect(
      isSessionKeyActive('cooking:r1', MORNING_ISO, sevenHoursLater)
    ).toBe(false);
    // The boundary itself is inclusive (age == ceiling is still active).
    const exact = new Date(
      MORNING.getTime() + COOKING_SESSION_MAX_AGE_HOURS * 3_600_000
    );
    expect(isSessionKeyActive('cooking:r1', MORNING_ISO, exact)).toBe(true);
    // The ceiling must not cut short a still-fresh day: an evening
    // session on the same day is fine, and the NEXT DAY the same
    // wall-clock time is expired by both rules.
    expect(isSessionKeyActive('shopping', MORNING_ISO, fiveHoursLater)).toBe(
      true
    );
    expect(isSessionKeyActive('shopping', MORNING_ISO, sevenHoursLater)).toBe(
      true
    );
    expect(isSessionKeyActive('cooking:r1', MORNING_ISO, NEXT_DAY)).toBe(false);
  });

  it('rejects missing, malformed, and future timestamps', () => {
    expect(isSessionKeyActive('shopping', undefined, EVENING)).toBe(false);
    expect(isSessionKeyActive('shopping', 'garbage', EVENING)).toBe(false);
    const future = new Date(Date.now() + 3_600_000).toISOString();
    expect(isSessionKeyActive('shopping', future, new Date())).toBe(false);
  });
});

describe('pruneExpiredSessions', () => {
  it('drops expired entries and keeps active ones', () => {
    const map = {
      shopping: { startedAt: MORNING_ISO, used: [] },
      'cooking:old': { startedAt: '2020-01-01T00:00:00Z', used: ['salt'] },
    };
    expect(pruneExpiredSessions(map, EVENING)).toEqual({
      shopping: { startedAt: MORNING_ISO, used: [] },
    });
  });

  it('returns the same object when nothing expired', () => {
    const map = { shopping: { startedAt: MORNING_ISO, used: [] } };
    expect(pruneExpiredSessions(map, EVENING)).toBe(map);
  });
});

describe('withShoppingTrip', () => {
  it('starts a trip with an empty used list', () => {
    const next = withShoppingTrip({}, '2026-07-15T12:00:00Z', EVENING);
    expect(next['shopping']).toEqual({
      startedAt: '2026-07-15T12:00:00Z',
      used: [],
    });
  });

  it('finishing removes the entry but keeps other sessions', () => {
    // The cooking session starts near `now` so the prune pass (which
    // runs inside every map write) does not sweep it - an 8am cooking
    // session at 8pm is past its ceiling and correctly pruned.
    const map = {
      shopping: { startedAt: MORNING_ISO, used: [] },
      [cookingSessionKey('r1')]: { startedAt: EVENING.toISOString(), used: ['salt'] },
    };
    const next = withShoppingTrip(map, undefined, EVENING);
    expect(next['shopping']).toBeUndefined();
    expect(next[cookingSessionKey('r1')]).toBeDefined();
  });
});

describe('withCookingSession', () => {
  it('starting begins a FRESH session - stale used marks do not leak', () => {
    const map = { [cookingSessionKey('r1')]: { startedAt: MORNING_ISO, used: ['salt'] } };
    const next = withCookingSession(map, 'r1', EVENING.toISOString(), EVENING);
    expect(next[cookingSessionKey('r1')]).toEqual({
      startedAt: EVENING.toISOString(),
      used: [],
    });
  });

  it('ending removes the entry', () => {
    const map = { [cookingSessionKey('r1')]: { startedAt: MORNING_ISO, used: ['salt'] } };
    expect(
      withCookingSession(map, 'r1', undefined, EVENING)[cookingSessionKey('r1')]
    ).toBeUndefined();
  });

  it('two recipes cook at once under their own keys', () => {
    let map: Record<string, { startedAt: string; used: string[] }> = {};
    map = withCookingSession(map, 'main', EVENING.toISOString(), EVENING);
    map = withCookingSession(map, 'side', EVENING.toISOString(), EVENING);
    expect(Object.keys(map).sort()).toEqual(
      [cookingSessionKey('main'), cookingSessionKey('side')].sort()
    );
  });

  it('an expired cooking session is pruned when the map is next written', () => {
    const map = { [cookingSessionKey('r1')]: { startedAt: '2020-01-01T00:00:00Z', used: [] } };
    const next = withCookingSession(map, 'r2', EVENING.toISOString(), EVENING);
    expect(next[cookingSessionKey('r1')]).toBeUndefined();
    expect(next[cookingSessionKey('r2')]).toBeDefined();
  });
});

describe('withUsedIngredient', () => {
  it('toggles a name on and off', () => {
    let map: Record<string, { startedAt: string; used: string[] }> = {
      [cookingSessionKey('r1')]: { startedAt: MORNING_ISO, used: [] },
    };
    map = withUsedIngredient(map, 'r1', 'salt');
    expect(map[cookingSessionKey('r1')].used).toEqual(['salt']);
    map = withUsedIngredient(map, 'r1', 'pepper');
    expect(map[cookingSessionKey('r1')].used).toEqual(['salt', 'pepper']);
    map = withUsedIngredient(map, 'r1', 'salt');
    expect(map[cookingSessionKey('r1')].used).toEqual(['pepper']);
  });

  it('is a no-op when the recipe has no session entry', () => {
    const map = { [cookingSessionKey('other')]: { startedAt: MORNING_ISO, used: [] } };
    expect(withUsedIngredient(map, 'r1', 'salt')).toBe(map);
  });
});

describe('cooking-mode labels', () => {
  it('toggle reads Make this now / Done cooking', () => {
    expect(cookingToggleLabel(false)).toBe('Make this now');
    expect(cookingToggleLabel(true)).toBe('Done cooking');
  });

  it('progress speaks counts', () => {
    expect(cookingProgressLabel(2, 8)).toBe('2 of 8 used');
  });

  it('aria label names the cooking verb', () => {
    expect(usedIngredientAriaLabel('olive oil')).toBe('Mark olive oil as used');
  });
});

describe('coerceActiveSessions', () => {
  it('passes a well-formed map through', () => {
    const map = {
      shopping: { startedAt: MORNING_ISO, used: [] },
      [cookingSessionKey('r1')]: { startedAt: MORNING_ISO, used: ['salt'] },
    };
    expect(coerceActiveSessions(map)).toEqual(map);
  });

  it('drops malformed entries and returns undefined when nothing survives', () => {
    expect(coerceActiveSessions({ bad: { startedAt: 'nope', used: [] } })).toBeUndefined();
    expect(coerceActiveSessions({ bad: 'nope' })).toBeUndefined();
    expect(coerceActiveSessions({ '': { startedAt: MORNING_ISO, used: [] } })).toBeUndefined();
    expect(coerceActiveSessions('nope')).toBeUndefined();
    expect(coerceActiveSessions(null)).toBeUndefined();
  });

  it('filters junk out of the used list and caps it', () => {
    const result = coerceActiveSessions({
      [cookingSessionKey('r1')]: {
        startedAt: MORNING_ISO,
        used: ['salt', '', 42, null, 'a'.repeat(201)],
      },
    });
    expect(result?.[cookingSessionKey('r1')].used).toEqual(['salt']);
    const many = coerceActiveSessions({
      [cookingSessionKey('r1')]: {
        startedAt: MORNING_ISO,
        used: Array.from({ length: 200 }, (_, i) => `n${i}`),
      },
    });
    expect(many?.[cookingSessionKey('r1')].used.length).toBe(128);
  });
});

describe('coerceSettings activeSessions', () => {
  it('reads a valid map', () => {
    const map = { shopping: { startedAt: MORNING_ISO, used: [] } };
    expect(coerceSettings({ activeSessions: map })).toEqual({ activeSessions: map });
  });

  it('migrates the legacy groceryShoppingStartedAt into the map', () => {
    expect(
      coerceSettings({ groceryShoppingStartedAt: MORNING_ISO })
    ).toEqual({
      activeSessions: { [SHOPPING_SESSION_KEY]: { startedAt: MORNING_ISO, used: [] } },
    });
  });

  it('the map wins when it already carries the shopping trip', () => {
    const map = {
      [SHOPPING_SESSION_KEY]: { startedAt: EVENING.toISOString(), used: [] },
    };
    expect(
      coerceSettings({ groceryShoppingStartedAt: MORNING_ISO, activeSessions: map })
    ).toEqual({ activeSessions: map });
  });

  it('carries a legacy trip alongside an existing cooking session', () => {
    const result = coerceSettings({
      groceryShoppingStartedAt: MORNING_ISO,
      activeSessions: { [cookingSessionKey('r1')]: { startedAt: MORNING_ISO, used: [] } },
    });
    expect(result.activeSessions?.[SHOPPING_SESSION_KEY]).toEqual({
      startedAt: MORNING_ISO,
      used: [],
    });
    expect(result.activeSessions?.[cookingSessionKey('r1')]).toBeDefined();
  });

  it('omits the map when absent and no legacy trip exists', () => {
    expect(coerceSettings({ colorMode: 'dark' })).toEqual({ colorMode: 'dark' });
    expect(coerceSettings({ groceryShoppingStartedAt: 'garbage' })).toEqual({});
  });
});
