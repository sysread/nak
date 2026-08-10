// Tool-catalog rearming for mid-turn toolbox toggles.
//
// The browser composes the turn's wire `tools` array once, at envelope-
// POST time, from the thread's toolboxes_enabled. The orchestrator's
// round chain reuses that array for every round - so when the model
// calls toggle_toolbox mid-turn, the newly enabled toolbox's write
// tools were absent from the remaining rounds' wire. Most model
// backends papered over the gap by accepting calls to tools the
// request never declared; a backend that holds the model to the
// declared list turns the same flow into a visible failure (the model
// tries to call a write it cannot name, and the call comes out as the
// nearest declared tool instead).
//
// The fix: the envelope now also carries the FULL tool catalog -
// always-on defs plus every gated toolbox's defs keyed by toolbox
// name - and the orchestrator rebuilds `body.tools` from it whenever a
// round's toggle_toolbox call succeeds. The browser stays the single
// source of truth for what tools exist (this module never defines a
// tool); the server only filters and dedupes what it was shipped.
//
// This module is deliberately dependency-free pure functions:
// tests/tool-catalog-parity.test.ts (vitest) imports it alongside the
// browser registry to pin that a rebuild from the catalog reproduces
// buildToolList byte-for-byte, and the Deno unit tests
// (supabase/functions/tests/tool-catalog.test.ts) cover the boundary
// coercion. Keep it import-free so both runtimes can load it.

/**
 * The envelope's catalog shape. Tool defs are opaque to the server -
 * they are already wire-shaped by the browser (toOpenAIToolDef,
 * activity param included) and go onto `body.tools` verbatim. The
 * only field the server reads inside a def is `function.name`, for
 * dedupe.
 *
 * `gated` key order is meaningful: the browser writes boxes in
 * catalog order (static TOOLBOXES order, then MCP integrations), and
 * the rebuild iterates keys in insertion order so the rebuilt array
 * matches what buildToolList would have produced for the same
 * enabled set.
 */
export interface ToolCatalog {
  alwaysOn: unknown[];
  gated: Record<string, unknown[]>;
}

/**
 * Boundary check for the envelope's optional toolCatalog field.
 * Returns null on anything malformed rather than throwing - an
 * envelope without a usable catalog degrades to the pre-catalog
 * behavior (the turn's tools array stays frozen), never a failed
 * turn. Older browser builds that predate the field land here as
 * undefined and get the same graceful null.
 */
export function coerceToolCatalog(raw: unknown): ToolCatalog | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const obj = raw as Record<string, unknown>;
  if (!Array.isArray(obj.alwaysOn)) return null;
  const gatedRaw = obj.gated;
  if (!gatedRaw || typeof gatedRaw !== 'object' || Array.isArray(gatedRaw)) {
    return null;
  }
  const gated: Record<string, unknown[]> = {};
  for (const [name, defs] of Object.entries(gatedRaw as Record<string, unknown>)) {
    if (!Array.isArray(defs)) return null;
    gated[name] = defs;
  }
  return { alwaysOn: obj.alwaysOn, gated };
}

/** The wire name of a tool def, when it has one. */
function wireName(def: unknown): string | null {
  if (!def || typeof def !== 'object') return null;
  const fn = (def as Record<string, unknown>).function;
  if (!fn || typeof fn !== 'object') return null;
  const name = (fn as Record<string, unknown>).name;
  return typeof name === 'string' ? name : null;
}

/**
 * Rebuild the wire `tools` array from the catalog and an enabled-
 * toolbox-name set. Mirrors buildToolList's semantics
 * (src/lib/tools/index.ts): always-on first, then each enabled gated
 * toolbox in catalog order; unknown enabled names are ignored;
 * duplicate tool names across boxes dedupe first-seen. A def the
 * browser shipped without a readable name is passed through undeduped
 * rather than dropped - the server has no business discarding catalog
 * content it merely can't index.
 */
export function buildToolsFromCatalog(
  catalog: ToolCatalog,
  enabled: readonly string[],
): unknown[] {
  const enabledSet = new Set(enabled);
  const seen = new Set<string>();
  const out: unknown[] = [];
  const push = (def: unknown) => {
    const name = wireName(def);
    if (name !== null) {
      if (seen.has(name)) return;
      seen.add(name);
    }
    out.push(def);
  };
  for (const def of catalog.alwaysOn) push(def);
  for (const [boxName, defs] of Object.entries(catalog.gated)) {
    if (!enabledSet.has(boxName)) continue;
    for (const def of defs) push(def);
  }
  return out;
}

/**
 * Extract the accepted enabled-set from a toggle_toolbox result
 * (`{enabled: string[]}`). Null on any other shape so a malformed
 * result skips the rearm instead of arming an empty set - the toggle
 * already persisted whatever it persisted, and the next turn's
 * envelope rebuilds from the thread row regardless.
 */
export function enabledSetFromToggleResult(result: unknown): string[] | null {
  if (!result || typeof result !== 'object') return null;
  const enabled = (result as Record<string, unknown>).enabled;
  if (!Array.isArray(enabled)) return null;
  if (!enabled.every((n): n is string => typeof n === 'string')) return null;
  return enabled;
}

/**
 * Build a name -> parameters lookup from the catalog. Used by the
 * central validator in performToolCall to find the JSON Schema for a
 * called tool without scanning the catalog on every call.
 *
 * Returns null when the catalog is null (no catalog shipped). An empty
 * map means the catalog shipped but no defs had readable names - the
 * validator will be a no-op for every call, which is safe.
 */
export function schemaMapFromCatalog(
  catalog: ToolCatalog | null,
): Map<string, Record<string, unknown>> | null {
  if (!catalog) return null;
  const map = new Map<string, Record<string, unknown>>();
  for (const def of [...catalog.alwaysOn, ...Object.values(catalog.gated).flat()]) {
    const name = wireName(def);
    if (!name) continue;
    const fn = (def as Record<string, unknown>).function as Record<string, unknown> | undefined;
    const params = fn?.parameters;
    if (params && typeof params === 'object') {
      map.set(name, params as Record<string, unknown>);
    }
  }
  return map;
}
