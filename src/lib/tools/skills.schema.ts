/**
 * Schema-only export for `skills` - the first combination-tool
 * surface in nak. One tool, one `op` enum discriminator
 * (list / get / search / save / delete) with flat optional per-op
 * parameters, instead of five verb tools. The combo form is the
 * design, not a fallback: a 2026-10-29 live calibration against the
 * serving backend found no tools-array cap and the model composing
 * op + params reliably under free choice; the enum form is smaller
 * on the wire than the oneOf variant form and every parameter stays
 * individually describable.
 *
 * Impl lives in the venice edge function
 * (supabase/functions/venice/tools/skills.ts), which self-registers
 * for dispatch. Per-op required fields (name + description + body on
 * create, query on search, name-or-id on get and delete) cannot be
 * expressed in one flat JSON Schema, so the edge impl routes
 * validation on `op` with ArgErrors - the per-param descriptions
 * below carry the pairing so the model rarely needs the round trip.
 */
import {
  MAX_SKILL_NAME_CHARS,
  MAX_SKILL_DESCRIPTION_CHARS,
  MAX_SKILL_BODY_CHARS,
} from '../skills';

function formatSkillsArgs(args: Record<string, unknown>): string {
  const lines: string[] = [];
  // The op leads: the detail panel should read what kind of skills
  // call this is before any operand.
  if (typeof args.op === 'string' && args.op) {
    lines.push(`**Op:** ${args.op}`);
  }
  if (typeof args.id === 'string' && args.id) {
    lines.push(`**Skill id:** ${args.id}`);
  }
  if (typeof args.name === 'string' && args.name) {
    lines.push(`**Name:** ${args.name}`);
  }
  if (typeof args.query === 'string' && args.query) {
    lines.push(`**Query:** ${args.query}`);
  }
  if (typeof args.description === 'string' && args.description) {
    lines.push(`**Description:** ${args.description}`);
  }
  if (typeof args.body === 'string' && args.body) {
    lines.push('', args.body);
  }
  return lines.join('\n');
}

export const skillsSchema = {
  name: 'skills',
  description:
    "Read and maintain the user's saved skills: reusable task " +
    'guidance (formats, procedures, checklists) loaded on demand. ' +
    'One tool, one op. list: every skill (name, description, ' +
    "updated_at). get: one skill's full body, by name or id. " +
    'search: skills matching a phrase. save: create, or update by ' +
    'id or exact name (there is no commit-message parameter - ' +
    'skills keep no changelog; the announce-in-the-reply rule in ' +
    'the system prompt covers visibility). delete: by id or name. ' +
    'When a recurring ask ' +
    'or hard-won guidance is not yet a skill, capture it with ' +
    'op=save and say so in the reply.',
  shortDescription: 'read and maintain skills',
  formatArgs: formatSkillsArgs,
  parameters: {
    type: 'object',
    properties: {
      op: {
        type: 'string',
        enum: ['list', 'get', 'search', 'save', 'delete'],
        description:
          'The operation to run. list: browse every skill. get: ' +
          "load one skill's full body to follow it. search: find " +
          'skills matching a phrase. save: create or update a ' +
          'skill. delete: remove a skill.',
      },
      id: {
        type: 'string',
        description:
          'Skill uuid (from list or search). get: fetches that ' +
          'skill. save: updates it, passing only the fields that ' +
          'change. delete: removes it. Preferred over name when ' +
          'known.',
      },
      name: {
        type: 'string',
        minLength: 1,
        maxLength: MAX_SKILL_NAME_CHARS,
        description:
          'Skill name - the case-insensitive unique key. get: the ' +
          'skill to load (alternative to id). save: required to ' +
          'create; an exact existing name (case-insensitive) routes ' +
          "to that skill's update instead of duplicating. delete: " +
          'alternative to id.',
      },
      description: {
        type: 'string',
        minLength: 1,
        maxLength: MAX_SKILL_DESCRIPTION_CHARS,
        description:
          'save only. One to two sentences on when to use this ' +
          'skill - the trigger surface. Rides the per-turn skills ' +
          'index, so keep it short; the detail belongs in body.',
      },
      body: {
        type: 'string',
        minLength: 1,
        maxLength: MAX_SKILL_BODY_CHARS,
        description:
          "save only. The skill's full markdown instructions, " +
          'loaded on demand when a task matches. Required to ' +
          'create.',
      },
      query: {
        type: 'string',
        minLength: 1,
        description:
          'search only. A phrase matched case-insensitively against ' +
          'skill names, descriptions, and bodies. Results carry ' +
          'name and description, not bodies - use get to load one. ' +
          'The sweep is capped at 20 results.',
      },
    },
    required: ['op'],
    additionalProperties: false,
  },
} as const;
