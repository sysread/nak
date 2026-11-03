/**
 * Schema-only export for `recipe_records` - the cooking-log
 * combination tool. One tool, one `op` enum discriminator (list /
 * get / search / create / update / delete) with flat per-op
 * parameters, replacing the six recipe_record_* verb tools. The
 * combo form follows the `skills` precedent (see that schema's
 * header for the calibration record); per-op required fields cannot
 * be expressed in one flat JSON Schema, so the edge impl routes
 * validation on `op` with ArgErrors
 * (supabase/functions/venice/tools/recipe_records.ts).
 *
 * The description carries two load-bearing prompt surfaces (both
 * test-pinned by supabase/functions/tests/recipe_record_tools.test.ts):
 * the CAPTURE TRIGGER (when to log a record at all - capture is
 * manual by design; there is no background sweep) and the DEDUP
 * GUARD (check-list-first, same EVENT not same date).
 *
 * The update op's content is a FULL-REPLACEMENT patch - get the
 * record first and pass the merged body. The outcome field carries
 * three states on update: absent leaves alone, explicit null
 * clears, a valid enum member sets.
 */

import {
  MAX_RECIPE_RECORD_CONTENT_CHARS,
  MAX_RECIPE_RECORD_TAGS,
  MAX_RECIPE_RECORD_TAG_CHARS,
} from '$shared/recipe-record-limits';

function formatRecipeRecordsArgs(args: Record<string, unknown>): string {
  const lines: string[] = [];
  // The op leads: the detail panel should read what kind of record
  // call this is before any operand.
  if (typeof args.op === 'string' && args.op) {
    lines.push(`**Op:** ${args.op}`);
  }
  if (typeof args.id === 'string' && args.id) {
    lines.push(`**Record id:** ${args.id}`);
  }
  if (typeof args.recipe_id === 'string' && args.recipe_id) {
    lines.push(`**Recipe id:** ${args.recipe_id}`);
  }
  if (typeof args.date === 'string' && args.date) lines.push(`**Date:** ${args.date}`);
  if (typeof args.outcome === 'string' && args.outcome) {
    lines.push(`**Outcome:** ${args.outcome}`);
  }
  if (Array.isArray(args.tags) && args.tags.length > 0) {
    lines.push(`**Tags:** ${args.tags.map((t) => String(t)).join(', ')}`);
  }
  if (typeof args.query === 'string' && args.query) {
    lines.push(`**Query:** ${args.query}`);
  }
  if (typeof args.content === 'string' && args.content) {
    lines.push('', args.content);
  }
  return lines.join('\n');
}

export const recipeRecordsSchema = {
  name: 'recipe_records',
  description:
    "Maintain a recipe's cooking log: dated records of what happened " +
    'when the user cooked it - the iteration, results, observations, ' +
    "ideas - distinct from the recipe's cooklang (its current state) " +
    'and from the History panel (which tracks source edits). One ' +
    'tool, one op. create: log a cook. CAPTURE TRIGGER: when the ' +
    'user reports having cooked a recipe and how it went, log the ' +
    'record with op=create and say so in the reply. Use the day the ' +
    "cook happened (read it from the conversation), not today, when " +
    'the cook is in the past; when it is unclear which recipe is ' +
    'meant or whether a real cook happened, ask instead of guessing. ' +
    'DEDUP GUARD: list or search the log first and look for the same ' +
    'EVENT, not the same date - if the event is already logged, ' +
    'op=update that record instead of stacking a duplicate; two ' +
    'cooks on one date are separate records. create\'s result lists ' +
    "the recipe's same-date records and its most recent earlier " +
    'record, so a likely duplicate is visible without a second call. ' +
    'update: patch date / content / tags / outcome - content is a ' +
    'FULL-REPLACEMENT patch, so get the record first and pass the ' +
    'merged body; outcome absent leaves it alone, explicit null ' +
    'clears it. get: one record by id. list: one recipe\'s log, ' +
    'newest first, with date-range / tag-AND / outcome filters. ' +
    'search: semantic + substring across ALL recipes (both legs ' +
    'always run; embedder-down degrades to substring rather than ' +
    'empty - so a blank result means genuinely nothing matched). ' +
    'delete: hard-remove by id; reports honestly when nothing ' +
    'matched. After logging a cook, fold any resulting recipe change ' +
    '(a tweak to the cooklang) into a separate recipes tool ' +
    'op=save so the History panel keeps the two apart. Optional ' +
    'outcome (success | mixed | failure) classifies a record - omit ' +
    'unless setting or clearing it. Tags are freeform filter keywords.',
  shortDescription: 'maintain a recipe cooking log (list/get/search/create/update/delete)',
  formatArgs: formatRecipeRecordsArgs,
  parameters: {
    type: 'object',
    properties: {
      op: {
        type: 'string',
        enum: ['list', 'get', 'search', 'create', 'update', 'delete'],
        description:
          'REQUIRED on every call. The operation to run. create: ' +
          'log a cook. update: patch an existing record (get it ' +
          'first - content is full-replacement). list: one ' +
          "recipe's log. get: one record by id. search: semantic + " +
          'substring across all recipes. delete: remove by id.',
      },
      id: {
        type: 'string',
        description:
          'Record UUID. get: the record to fetch (required). ' +
          'update: the record to patch (required). delete: the ' +
          'record to remove (required). From list or search.',
      },
      recipe_id: {
        type: 'string',
        description:
          'Recipe UUID (from the recipes tool). list: scopes the ' +
          'log (required). create: parents the record (required). ' +
          'search: optional scope to one recipe\'s log.',
      },
      date: {
        type: 'string',
        description:
          'ISO 8601 calendar date ("YYYY-MM-DD"). create: required ' +
          '- the day the cook happened, from the conversation, not ' +
          'today, when the cook is in the past. update: optional ' +
          'patch field.',
      },
      content: {
        type: 'string',
        minLength: 1,
        maxLength: MAX_RECIPE_RECORD_CONTENT_CHARS,
        description:
          `create: required - the full Markdown body of what ` +
          `happened (max ${MAX_RECIPE_RECORD_CONTENT_CHARS} ` +
          'chars). update: optional; FULL-REPLACEMENT patch - get ' +
          'the record first and pass the merged body.',
      },
      tags: {
        type: 'array',
        items: { type: 'string', maxLength: MAX_RECIPE_RECORD_TAG_CHARS },
        maxItems: MAX_RECIPE_RECORD_TAGS,
        description:
          'create / update only. Optional freeform filter keywords; ' +
          'a record matches a tag filter only when it carries every ' +
          'listed tag. update: replaces the whole tag set.',
      },
      outcome: {
        type: ['string', 'null'],
        enum: ['success', 'mixed', 'failure', null],
        description:
          'create: optional classification - omit unless setting ' +
          'it. update: THREE states - absent leaves the column ' +
          'alone, explicit null CLEARS the classification, a valid ' +
          'enum member sets it. search: optional facet filter.',
      },
      from_date: {
        type: 'string',
        description:
          'list only. Optional inclusive lower bound ("YYYY-MM-DD").',
      },
      to_date: {
        type: 'string',
        description:
          'list only. Optional inclusive upper bound ("YYYY-MM-DD").',
      },
      query: {
        type: 'string',
        minLength: 1,
        description:
          'search only. Required. Natural-language description of ' +
          'what to find (also runs as a substring match).',
      },
      limit: {
        type: 'number',
        description:
          'list: max records (default 50, max 200). search: max ' +
          'hits (default 10, max 30).',
      },
    },
    required: ['op'],
    additionalProperties: false,
  },
} as const;
