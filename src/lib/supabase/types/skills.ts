/**
 * Skills-domain row types: the full skill row and the body-less
 * summary projection the per-turn index and the search path share.
 * Re-exported through `../../supabase.ts` so consumers keep importing
 * from `$lib/supabase`.
 */

/**
 * One saved skill: named, described markdown instructions that the
 * user and the chat model both maintain. `name` is the
 * case-insensitive unique invocation key (one skill per user per
 * lowercased name); `description` is the trigger surface - it rides
 * every chat turn in the per-turn metadata index, so it stays short;
 * `body` is the full instruction text, loaded only when a task
 * matches. `last_author` records which surface wrote the current
 * contents: 'user' for panel writes, 'assistant' for the skills chat
 * tool. It is the whole edit trail in v1 (no changelog table).
 * Mirrors `public.skills` in supabase/schema.sql.
 */
export interface Skill {
  id: string;
  name: string;
  description: string;
  body: string;
  last_author: 'user' | 'assistant';
  created_at: string;
  updated_at: string;
}

/**
 * The body-less projection of a skill row: the fields the per-turn
 * index and the sidebar search render, without the body a matched
 * skill delivers only through getSkill. listSkills and searchSkills
 * return these so neither surface ships bodies wholesale - a broad
 * search would otherwise dump every body onto the wire (and, on the
 * tool side, into context).
 */
export interface SkillSummary {
  id: string;
  name: string;
  description: string;
  updated_at: string;
  last_author: 'user' | 'assistant';
}

/**
 * Defensive coercion of a skills row. `last_author` is
 * check-constrained at the DB boundary, but realtime payloads and RPC
 * results bypass the checked write path, so anything other than
 * 'assistant' collapses to 'user' (the column default) rather than
 * trusting the wire shape.
 */
export function coerceSkill(raw: Record<string, unknown>): Skill {
  return {
    id: String(raw.id),
    name: typeof raw.name === 'string' ? raw.name : '',
    description: typeof raw.description === 'string' ? raw.description : '',
    body: typeof raw.body === 'string' ? raw.body : '',
    last_author: raw.last_author === 'assistant' ? 'assistant' : 'user',
    created_at: String(raw.created_at ?? raw.updated_at ?? ''),
    updated_at: String(raw.updated_at ?? raw.created_at ?? ''),
  };
}

/** Coerce the body-less projection; same wire-boundary posture as
 *  coerceSkill, minus the fields the projection never selects. */
export function coerceSkillSummary(raw: Record<string, unknown>): SkillSummary {
  return {
    id: String(raw.id),
    name: typeof raw.name === 'string' ? raw.name : '',
    description: typeof raw.description === 'string' ? raw.description : '',
    updated_at: String(raw.updated_at ?? raw.created_at ?? ''),
    last_author: raw.last_author === 'assistant' ? 'assistant' : 'user',
  };
}
