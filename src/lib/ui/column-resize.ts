// UI-behavior primitives for the user-resizable desktop side columns
// (the threads sidebar on the left, the logs panel on the right of
// .shell). The .svelte glue owns the pointer drag and writes the live
// width into a CSS custom property; this module owns the bounds math
// and the localStorage round-trip so both stay framework-agnostic and
// unit-testable.
//
// Only relevant on desktop: at <= 720px both panels become fixed-width
// slide-overs (see the media query in styles.css), so the drag handles
// are display:none there and these helpers are never exercised.

export type ColumnKind = 'sidebar' | 'logs';

const STORAGE_KEY = 'nak:cols:v1';

// Lower bounds keep each panel wide enough to stay usable; upper bounds
// (combined with the viewport-relative cap in clampColumnWidth) keep the
// chat column from being squeezed away on a narrow desktop window.
const BOUNDS: Record<ColumnKind, { min: number; max: number }> = {
  sidebar: { min: 180, max: 560 },
  logs: { min: 240, max: 680 },
};

// No side column may exceed this fraction of the viewport, so the chat
// column keeps a usable minimum even with a saved width carried over
// from a much wider monitor.
const VIEWPORT_CAP = 0.4;

export function clampColumnWidth(
  kind: ColumnKind,
  px: number,
  viewportWidth: number
): number {
  const { min, max } = BOUNDS[kind];
  const cap = Math.min(max, Math.round(viewportWidth * VIEWPORT_CAP));
  // cap can fall below min on a very narrow window; min wins so the
  // panel never collapses past usability mid-drag.
  return Math.max(min, Math.min(Math.max(cap, min), Math.round(px)));
}

type Stored = Partial<Record<ColumnKind, number>>;

function readAll(): Stored {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return {};
    const out: Stored = {};
    for (const kind of ['sidebar', 'logs'] as const) {
      const v = (parsed as Record<string, unknown>)[kind];
      if (typeof v === 'number' && Number.isFinite(v)) out[kind] = v;
    }
    return out;
  } catch {
    // malformed JSON / quota / private mode - treat as no preference
    return {};
  }
}

export function readColumnWidth(kind: ColumnKind): number | null {
  return readAll()[kind] ?? null;
}

export function storeColumnWidth(kind: ColumnKind, px: number): void {
  try {
    const next = { ...readAll(), [kind]: Math.round(px) };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    // quota / private mode - treat as no-op
  }
}

export const __storageKey = STORAGE_KEY;
