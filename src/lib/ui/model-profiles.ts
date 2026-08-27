/**
 * UI-behavior primitives for the Settings Model-profiles pane: the pure
 * list transforms behind add / edit / delete / reorder / set-default,
 * the name validation the autosave gates on, and the per-card
 * view-model assembly over the live Venice catalog. The Settings
 * component calls these and schedules persistence; nothing here touches
 * component state or Supabase. Companion to src/lib/models (the
 * ModelProfile domain type + coercion) and ./model-picker (the
 * catalog-generic option/chip/format primitives this reuses).
 */
import type { CatalogModel } from '../models/catalog';
import {
  normalizeDefaultProfile,
  seedModelProfiles,
  type ModelProfile,
} from '../models';
import {
  buildModelOptions,
  capabilityChips,
  formatContextWindow,
  formatPricing,
  privacyChip,
  type CapabilityChip,
  type ModelOption,
} from './model-picker';

/** Next non-colliding "New profile" / "New profile N" name. */
function nextProfileName(list: readonly ModelProfile[]): string {
  const taken = new Set(list.map((p) => p.name.trim().toLowerCase()));
  if (!taken.has('new profile')) return 'New profile';
  let n = 2;
  while (taken.has(`new profile ${n}`)) n += 1;
  return `New profile ${n}`;
}

/**
 * A fresh profile with a client-generated id, carrying the same model
 * and defaults as the starter profile so a new card is fully usable
 * before the user touches anything. Auto-named to dodge the unique-name
 * rule; flagged default only when the list is empty (the exactly-one-
 * default invariant demands one).
 */
export function createProfile(list: readonly ModelProfile[]): ModelProfile {
  const seed = seedModelProfiles()[0];
  return {
    ...seed,
    id: crypto.randomUUID(),
    name: nextProfileName(list),
    isDefault: list.length === 0,
  };
}

/** Append a fresh profile to the end of the list. */
export function addProfile(list: ModelProfile[]): ModelProfile[] {
  return [...list, createProfile(list)];
}

/** Patch one profile in place by id, leaving the rest untouched. */
export function updateProfile(
  list: ModelProfile[],
  id: string,
  patch: Partial<ModelProfile>
): ModelProfile[] {
  return list.map((p) => (p.id === id ? { ...p, ...patch } : p));
}

/**
 * Re-snapshot a profile onto a live catalog model: model id, capability
 * fields, and display label all refresh together so the persisted
 * snapshot can never pair one model's id with another model's
 * capabilities. The profile's name, reasoning/verbosity defaults, and
 * default flag are untouched - the user re-pointed the profile, not
 * reconfigured it.
 */
export function profileWithCatalogModel(
  profile: ModelProfile,
  model: CatalogModel
): ModelProfile {
  return {
    ...profile,
    modelId: model.id,
    contextWindow: model.contextWindow,
    supportsReasoning: model.supportsReasoning,
    supportsVision: model.supportsVision,
    supportsResponseFormat: model.supportsResponseFormat,
    modelLabel: model.name,
  };
}

/**
 * Drop one profile by id. The last remaining profile is undeletable -
 * the list comes back unchanged (as a copy, so callers treat the result
 * uniformly). Deleting the default promotes the first survivor via the
 * normalize pass, so the exactly-one-default invariant holds without
 * the caller thinking about it.
 */
export function deleteProfile(list: ModelProfile[], id: string): ModelProfile[] {
  if (list.length <= 1) return [...list];
  return normalizeDefaultProfile(list.filter((p) => p.id !== id));
}

/**
 * Flag `id` as the default and clear the flag everywhere else - the
 * "selecting a default deselects the others" radio semantic. Unknown
 * ids return the list unchanged rather than leaving it defaultless.
 */
export function setDefaultProfile(list: ModelProfile[], id: string): ModelProfile[] {
  if (!list.some((p) => p.id === id)) return [...list];
  return list.map((p) =>
    p.isDefault === (p.id === id) ? p : { ...p, isDefault: p.id === id }
  );
}

/**
 * Move the profile at `from` to sit at index `to`, shifting the rest.
 * Out-of-range or no-op indices return the list unchanged (a new array
 * is still returned so callers can treat the result uniformly). Array
 * half of the drag-and-drop reorder, same shape as reorderPrompts.
 */
export function reorderProfiles(
  list: ModelProfile[],
  from: number,
  to: number
): ModelProfile[] {
  if (
    from === to ||
    from < 0 ||
    to < 0 ||
    from >= list.length ||
    to >= list.length
  ) {
    return [...list];
  }
  const next = [...list];
  const [moved] = next.splice(from, 1);
  next.splice(to, 0, moved);
  return next;
}

/**
 * Field-wise equality of two profile lists. Backs the resync guard that
 * decides whether a fresh Supabase pull (app.modelProfiles) should
 * overwrite the local draft - comparing by value rather than reference
 * so a re-fetch that returned an identical array doesn't clobber the
 * draft and lose cursor position mid-edit.
 */
export function profilesMatch(
  a: readonly ModelProfile[],
  b: readonly ModelProfile[]
): boolean {
  return (
    a.length === b.length &&
    a.every((p, i) => {
      const other = b[i];
      return (
        other.id === p.id &&
        other.name === p.name &&
        other.modelId === p.modelId &&
        other.thinking === p.thinking &&
        other.verbosity === p.verbosity &&
        other.isDefault === p.isDefault &&
        other.contextWindow === p.contextWindow &&
        other.supportsReasoning === p.supportsReasoning &&
        other.supportsVision === p.supportsVision &&
        other.supportsResponseFormat === p.supportsResponseFormat &&
        other.modelLabel === p.modelLabel
      );
    })
  );
}

/**
 * True when the model's backend is known to reject the verbosity knob
 * outright. `rejections` is the model_feature_rejections snapshot
 * (app.modelFeatureRejections), keyed by model id; the recorded
 * feature name is the wire FIELD the backend rejected - 'text',
 * because verbosity ships as the OpenAI-shape `text.verbosity` object
 * - so this helper owns the field-to-control mapping. Settings uses
 * it to disable the profile card's verbosity dropdown; the edge
 * function strips the field from outgoing requests regardless, so
 * this is a UX affordance, not the enforcement point.
 */
export function verbosityRejectedForModel(
  rejections: Readonly<Record<string, readonly string[]>>,
  modelId: string
): boolean {
  return rejections[modelId]?.includes('text') ?? false;
}

/**
 * True when the model's backend refuses to run without a thinking
 * pass ("Reasoning is mandatory" - recorded under the
 * venice_parameters.disable_thinking wire path; observed on
 * z-ai-glm-5-3). Settings and the composer use it to disable the
 * "Off" thinking option for that model; the edge function strips the
 * flag from outgoing requests regardless, so - like the verbosity
 * twin above - this is a UX affordance, not the enforcement point.
 */
export function thinkingOffRejectedForModel(
  rejections: Readonly<Record<string, readonly string[]>>,
  modelId: string
): boolean {
  return (
    rejections[modelId]?.includes('venice_parameters.disable_thinking') ?? false
  );
}

/**
 * The validation the autosave gates on: every profile needs a non-empty
 * name and names must be unique (case-insensitive, ignoring surrounding
 * whitespace, so "Fast" and "fast " can't coexist as visually-identical
 * menu rows). Returns the user-facing error, or null when the list is
 * saveable.
 */
export function profileNamesError(list: readonly ModelProfile[]): string | null {
  const seen = new Set<string>();
  for (const p of list) {
    const trimmed = p.name.trim();
    if (trimmed.length === 0) return 'Every profile needs a name.';
    const key = trimmed.toLowerCase();
    if (seen.has(key)) {
      return `Profile names must be unique - "${trimmed}" is used more than once.`;
    }
    seen.add(key);
  }
  return null;
}

/** Everything one profile card needs to render beyond the profile itself. */
export interface ProfileRowView {
  /** Model dropdown options, with the current pick guaranteed present. */
  readonly options: ModelOption[];
  /** Capability chips for the selected model. */
  readonly chips: CapabilityChip[];
  /** Pre-formatted context window, e.g. "1M". */
  readonly contextLabel: string;
  /** Pre-formatted price, e.g. "$0.30 in / $1.20 out per 1M". */
  readonly priceLabel: string;
}

/**
 * Assemble the view-model for one profile card from the profile and the
 * live catalog. Capability chips, context, and price prefer the live
 * catalog row for the selected model (richer + carries pricing); they
 * fall back to the profile's snapshotted capabilities when the model
 * isn't a live catalog entry (retired, or hidden by the price cap), in
 * which case price reads "n/a" because the snapshot doesn't carry
 * pricing.
 */
export function profileRowView(
  profile: ModelProfile,
  catalog: readonly CatalogModel[]
): ProfileRowView {
  const selected = catalog.find((m) => m.id === profile.modelId) ?? null;
  // Privacy leads the chip row so the serving classification reads
  // before the feature list. Catalog rows only - the profile snapshot
  // doesn't carry privacy, so an off-catalog pick shows no privacy chip
  // rather than a stale or guessed one.
  const privacy = selected ? privacyChip(selected) : null;
  return {
    options: buildModelOptions(catalog, {
      id: profile.modelId,
      label: profile.modelLabel,
    }),
    chips: [...(privacy ? [privacy] : []), ...capabilityChips(selected ?? profile)],
    contextLabel: formatContextWindow(profile.contextWindow),
    priceLabel: selected ? formatPricing(selected) : 'Pricing n/a',
  };
}
