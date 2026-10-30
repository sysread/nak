/**
 * Canonical char-limit constants for the skills feature. A skill is
 * named, described markdown instructions the user and the chat model
 * both maintain; the caps keep each field honest about the surface it
 * rides on.
 *
 * The asymmetry is the design. The description rides EVERY chat turn
 * in the per-turn metadata index (src/lib/chat/prompt-assembly.ts),
 * so it carries the tight cap; the body is loaded on demand through
 * the skills tool's op=get, so it carries the loose one. The two
 * index caps bound the always-on cost of a growing skill store.
 *
 * Browser-side consumers: the wire schema (src/lib/tools/
 * skills.schema.ts) enforces the per-field caps, and the metadata
 * skills-index section enforces the two index caps. The edge-side
 * skills tool enforces the same per-field caps through the
 * Deno-island mirror in supabase/functions/_shared/skills-limits.ts
 * (the edge function cannot import browser modules; see
 * supabase/functions/README.md). This file is canonical - keep the
 * mirror in lockstep.
 */

/**
 * Length ceiling on a skill's name (64 chars). The name is the
 * invocation key: it rides every index line and every tool lookup,
 * and slug-ish names stay well under this in practice. The cap
 * blocks the runaway sentence-as-name, not normal use.
 */
export const MAX_SKILL_NAME_CHARS = 64;

/**
 * Length ceiling on a skill's description (300 chars). The
 * description is the trigger surface - one to two sentences saying
 * when to use the skill - and it is rendered into the per-turn
 * metadata index on EVERY turn. It is the only field with a hard
 * pressure to stay short, and the cap is what keeps that pressure
 * enforceable.
 */
export const MAX_SKILL_DESCRIPTION_CHARS = 300;

/**
 * Length ceiling on a skill's body (32000 chars). The body loads on
 * demand only, so it can carry real detail: procedures, formats,
 * checklists, examples. 32000 was set from a calibration read over
 * 42 shipped real-world skill bodies (median ~7KB, p90 ~25KB): it
 * covers the full p90 envelope with headroom for a genuinely dense
 * skill, blocks the "one skill doing two jobs" class outright, and
 * caps the one-shot on-demand load at roughly 8k tokens.
 */
export const MAX_SKILL_BODY_CHARS = 32000;

/**
 * Entry cap on the per-turn metadata skills index (50 entries). The
 * index section stops at this many skills; entries are taken in the
 * fetched name-asc order so the selection under both caps is
 * deterministic.
 */
export const MAX_SKILL_INDEX_ENTRIES = 50;

/**
 * Character cap on the per-turn metadata skills index (4000 chars).
 * The index rides at the tail of the request, outside the cacheable
 * prompt prefix, so its bytes are re-paid every turn: 50 entries at
 * the ~370-char rendered-line ceiling (64-char name + 300-char
 * description + separators) would be ~18KB, roughly 4.5k tokens of
 * per-turn cost. The section stops at whichever cap - entries or
 * chars - hits first, and the overflow line points the model at the
 * skills tool's op=list for the drill-down.
 */
export const MAX_SKILL_INDEX_CHARS = 4000;
