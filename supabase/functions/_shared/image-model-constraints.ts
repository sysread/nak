// Per-model image-sizing constraints from Venice's live /models?type=image
// catalog.
//
// Why this exists: the image tool's generate op historically shipped a
// hardcoded aspect-ratio dimension table tuned to the default pixel-
// dimensioned model (venice-sd35), and passed width/height to EVERY model.
// Ratio-based models (qwen-image) reject width/height outright and want
// `aspect_ratio` - a deterministic 400, not a transient failure. The
// consumer is venice/tools/image.ts generateOp; the constraint field
// reference is the vendored venice-models skill (model_spec.constraints,
// image family); the full design record lives in
// docs/dev/plans/upscaler-liveness-image-models-plan.md.
//
// The discriminator is the catalog itself (vendored venice-models skill):
// image models carry `constraints.widthHeightDivisor`; ONLY ratio/
// resolution-based models also carry `constraints.aspectRatios[]` +
// `defaultAspectRatio`. Presence of a non-empty aspectRatios list = ratio
// mode.
//
// Fail-open posture: on any catalog fetch/parse trouble this returns null
// and callers keep the legacy pixel-table behavior - a catalog hiccup must
// never fail an image. The raw catalog is shared with the price-cap check
// (veniceRawCatalogCached), so a capped deployment pays no extra fetch.

import { veniceRawCatalogCached } from './venice.ts';

export interface ImageModelConstraints {
  /** 'ratio' = send aspect_ratio; 'pixel' = send width/height. */
  mode: 'ratio' | 'pixel';
  /** Pixel models: both dimensions must be divisible by this. */
  divisor?: number;
  /** Ratio models: the accepted ratio labels. */
  aspectRatios?: string[];
  /** Ratio models: the model's own default, used when the request's label isn't listed. */
  defaultAspectRatio?: string;
}

/** Flatten the raw /models?type=image envelope into id -> constraints. */
export function extractImageModelConstraints(raw: unknown): Map<string, ImageModelConstraints> {
  const envelope = raw as { data?: unknown } | null;
  const list = Array.isArray(raw)
    ? raw
    : Array.isArray(envelope?.data)
      ? (envelope!.data as unknown[])
      : [];
  const out = new Map<string, ImageModelConstraints>();
  for (const item of list) {
    const entry = item as { id?: unknown; model_spec?: { constraints?: Record<string, unknown> } } | null;
    if (typeof entry?.id !== 'string' || entry.id.length === 0) continue;
    const c = entry.model_spec?.constraints;
    if (c == null || typeof c !== 'object') continue;

    const ratios = Array.isArray(c.aspectRatios)
      ? c.aspectRatios.filter((r): r is string => typeof r === 'string' && r.length > 0)
      : [];
    if (ratios.length > 0) {
      out.set(entry.id, {
        mode: 'ratio',
        aspectRatios: ratios,
        defaultAspectRatio:
          typeof c.defaultAspectRatio === 'string' && c.defaultAspectRatio.length > 0
            ? c.defaultAspectRatio
            : undefined,
      });
      continue;
    }
    if (typeof c.widthHeightDivisor === 'number' && c.widthHeightDivisor > 0) {
      out.set(entry.id, { mode: 'pixel', divisor: c.widthHeightDivisor });
    }
    // No constraints the generate path can use (or an unlisted shape):
    // absent from the map = legacy table behavior for that id.
  }
  return out;
}

/**
 * Constraints for the generate path. Null on catalog failure - callers
 * fall back to the legacy dimension table (fail-open, mirroring the
 * price-cap posture).
 */
export async function loadImageModelConstraints(
  apiKey: string,
  fetchImpl?: typeof fetch
): Promise<Map<string, ImageModelConstraints> | null> {
  try {
    return extractImageModelConstraints(await veniceRawCatalogCached(apiKey, 'image', fetchImpl));
  } catch {
    return null;
  }
}
