import { describe, it, expect } from 'vitest';
import type { CatalogModel } from '../src/lib/models/catalog';
import { SEED_MODEL_PROFILE_ID, type ModelProfile } from '../src/lib/models';
import {
  addProfile,
  createProfile,
  deleteProfile,
  profileNamesError,
  profileRowView,
  profileWithCatalogModel,
  profilesMatch,
  reorderProfiles,
  setDefaultProfile,
  updateProfile,
} from '../src/lib/ui/model-profiles';

function profile(over: Partial<ModelProfile> = {}): ModelProfile {
  return {
    id: 'p1',
    name: 'Everyday',
    modelId: 'deepseek-v4-flash',
    thinking: 'low',
    verbosity: 'medium',
    isDefault: true,
    contextWindow: 1_000_000,
    supportsReasoning: true,
    supportsVision: false,
    supportsResponseFormat: true,
    modelLabel: 'DeepSeek V4 Flash',
    ...over,
  };
}

const CATALOG_MODEL: CatalogModel = {
  id: 'glm-5-1',
  name: 'GLM 5.1',
  contextWindow: 200_000,
  supportsVision: true,
  supportsReasoning: true,
  supportsFunctionCalling: true,
  supportsResponseFormat: true,
  inputUsdPerM: 0.3,
  outputUsdPerM: 1.2,
  deprecated: false,
  privacy: null,
  supportsE2EE: false,
};

describe('createProfile / addProfile', () => {
  it('mints a usable profile with a fresh id and non-colliding name', () => {
    const list = [profile()];
    const fresh = createProfile(list);
    expect(fresh.id).not.toBe(SEED_MODEL_PROFILE_ID);
    expect(fresh.id).not.toBe('p1');
    expect(fresh.name).toBe('New profile');
    expect(fresh.modelId).toBe('deepseek-v4-flash');
    expect(fresh.isDefault).toBe(false);
  });
  it('numbers the name past an existing "New profile"', () => {
    const list = [profile({ name: 'New profile' })];
    expect(createProfile(list).name).toBe('New profile 2');
    const two = [
      profile({ name: 'New profile' }),
      profile({ id: 'p2', name: 'new profile 2', isDefault: false }),
    ];
    expect(createProfile(two).name).toBe('New profile 3');
  });
  it('flags the new profile default only when the list is empty', () => {
    expect(createProfile([]).isDefault).toBe(true);
    expect(createProfile([profile()]).isDefault).toBe(false);
  });
  it('addProfile appends without touching existing entries', () => {
    const list = [profile()];
    const next = addProfile(list);
    expect(next).toHaveLength(2);
    expect(next[0]).toBe(list[0]);
  });
});

describe('updateProfile', () => {
  it('patches only the addressed profile', () => {
    const list = [profile(), profile({ id: 'p2', name: 'Other', isDefault: false })];
    const next = updateProfile(list, 'p2', { thinking: 'off' });
    expect(next[0]).toBe(list[0]);
    expect(next[1].thinking).toBe('off');
  });
});

describe('profileWithCatalogModel', () => {
  it('re-snapshots model id, capabilities, and label together', () => {
    const next = profileWithCatalogModel(profile(), CATALOG_MODEL);
    expect(next.modelId).toBe('glm-5-1');
    expect(next.modelLabel).toBe('GLM 5.1');
    expect(next.contextWindow).toBe(200_000);
    expect(next.supportsVision).toBe(true);
    // The user re-pointed the profile, not reconfigured it.
    expect(next.name).toBe('Everyday');
    expect(next.thinking).toBe('low');
    expect(next.verbosity).toBe('medium');
    expect(next.isDefault).toBe(true);
  });
});

describe('deleteProfile', () => {
  it('refuses to delete the last profile', () => {
    const list = [profile()];
    const next = deleteProfile(list, 'p1');
    expect(next).toEqual(list);
    expect(next).not.toBe(list);
  });
  it('promotes the first survivor when the default is deleted', () => {
    const list = [
      profile(),
      profile({ id: 'p2', name: 'Other', isDefault: false }),
      profile({ id: 'p3', name: 'Third', isDefault: false }),
    ];
    const next = deleteProfile(list, 'p1');
    expect(next.map((p) => p.id)).toEqual(['p2', 'p3']);
    expect(next.map((p) => p.isDefault)).toEqual([true, false]);
  });
  it('keeps the existing default when a non-default is deleted', () => {
    const list = [profile(), profile({ id: 'p2', name: 'Other', isDefault: false })];
    const next = deleteProfile(list, 'p2');
    expect(next).toHaveLength(1);
    expect(next[0].isDefault).toBe(true);
  });
});

describe('setDefaultProfile', () => {
  it('selecting a default deselects every other profile', () => {
    const list = [
      profile(),
      profile({ id: 'p2', name: 'Other', isDefault: false }),
    ];
    const next = setDefaultProfile(list, 'p2');
    expect(next.map((p) => p.isDefault)).toEqual([false, true]);
  });
  it('ignores an unknown id rather than clearing the default', () => {
    const list = [profile()];
    expect(setDefaultProfile(list, 'ghost').map((p) => p.isDefault)).toEqual([true]);
  });
});

describe('reorderProfiles', () => {
  const list = [
    profile(),
    profile({ id: 'p2', name: 'B', isDefault: false }),
    profile({ id: 'p3', name: 'C', isDefault: false }),
  ];
  it('moves an entry and shifts the rest', () => {
    expect(reorderProfiles(list, 0, 2).map((p) => p.id)).toEqual(['p2', 'p3', 'p1']);
    expect(reorderProfiles(list, 2, 0).map((p) => p.id)).toEqual(['p3', 'p1', 'p2']);
  });
  it('returns a copy unchanged for out-of-range or no-op indices', () => {
    expect(reorderProfiles(list, 0, 0).map((p) => p.id)).toEqual(['p1', 'p2', 'p3']);
    expect(reorderProfiles(list, -1, 2)).toEqual(list);
    expect(reorderProfiles(list, 0, 3)).toEqual(list);
  });
});

describe('profilesMatch', () => {
  it('matches by value, not reference', () => {
    expect(profilesMatch([profile()], [profile()])).toBe(true);
  });
  it('detects a changed field, order, or length', () => {
    expect(profilesMatch([profile()], [profile({ verbosity: 'high' })])).toBe(false);
    expect(profilesMatch([profile()], [])).toBe(false);
    const a = [profile(), profile({ id: 'p2', name: 'B', isDefault: false })];
    const b = [a[1], a[0]];
    expect(profilesMatch(a, b)).toBe(false);
  });
});

describe('profileNamesError', () => {
  it('passes a clean list', () => {
    const list = [profile(), profile({ id: 'p2', name: 'Fast', isDefault: false })];
    expect(profileNamesError(list)).toBeNull();
  });
  it('flags a blank name', () => {
    expect(profileNamesError([profile({ name: '   ' })])).toMatch(/needs a name/);
  });
  it('flags duplicates case-insensitively and ignoring whitespace', () => {
    const list = [
      profile({ name: 'Fast' }),
      profile({ id: 'p2', name: ' fast ', isDefault: false }),
    ];
    expect(profileNamesError(list)).toMatch(/unique/);
  });
});

describe('profileRowView', () => {
  it('prefers the live catalog row for chips and price', () => {
    const p = profileWithCatalogModel(profile(), CATALOG_MODEL);
    const row = profileRowView(p, [CATALOG_MODEL]);
    expect(row.priceLabel).toBe('$0.30 in / $1.20 out per 1M');
    expect(row.chips.map((c) => c.label)).toContain('Vision');
    // Context comes from the profile snapshot (what the send path uses).
    expect(row.contextLabel).toBe('200k');
    // The current pick is a real catalog row, so no synthetic option.
    expect(row.options).toHaveLength(1);
  });
  it('leads the chip row with the privacy chip for a classified catalog model', () => {
    const anonymized = { ...CATALOG_MODEL, privacy: 'anonymized' as const };
    const p = profileWithCatalogModel(profile(), anonymized);
    const row = profileRowView(p, [anonymized]);
    expect(row.chips[0].label).toBe('Anonymized');
  });
  it('falls back to the snapshot for an off-catalog model', () => {
    const row = profileRowView(profile(), [CATALOG_MODEL]);
    expect(row.priceLabel).toBe('Pricing n/a');
    // Snapshot says reasoning-capable, no vision.
    expect(row.chips.map((c) => c.label)).toEqual(['Reasoning']);
    expect(row.contextLabel).toBe('1M');
    // The off-catalog current pick surfaces as a synthetic option.
    expect(row.options[0].id).toBe('deepseek-v4-flash');
    expect(row.options[0].label).toContain('current');
  });
});
