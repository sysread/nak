/**
 * Skills char-limit constants for the edge function side. Mirrors
 * the five limits in src/lib/skills.ts. Consolidated here so the
 * skills tool (venice/tools/skills.ts) references one source instead
 * of maintaining an independent copy.
 *
 * The browser-side src/lib/skills.ts remains the canonical source.
 * Only the three per-field caps are read on this side - the two
 * index caps are enforced browser-side in the metadata skills-index
 * section (src/lib/chat/prompt-assembly.ts), which the edge function
 * never renders - but all five are mirrored so the pair stays a
 * complete copy of the canonical set: a partial mirror invites drift
 * the next time a constant is added. Keep in lockstep with the
 * browser original.
 */

export const MAX_SKILL_NAME_CHARS = 64;
export const MAX_SKILL_DESCRIPTION_CHARS = 300;
export const MAX_SKILL_BODY_CHARS = 32000;
export const MAX_SKILL_INDEX_ENTRIES = 50;
export const MAX_SKILL_INDEX_CHARS = 4000;
