/**
 * Schema-only export for recipe_record_create. Impl lives in
 * `./recipe_record_create` (edge:
 * supabase/functions/venice/tools/recipe_record_create.ts).
 *
 * Carries a `formatArgs` override so the tool-call detail panel renders
 * the date + outcome + tags as a header and the Markdown content as a
 * section, rather than burying the body in a generic field bullet.
 *
 * The description is a prompt surface, not just documentation: it
 * carries the capture trigger (when to log a record at all - capture
 * is manual by design; there is no background sweep) and the dedup
 * guard (check-list-first). Both are pinned by
 * supabase/functions/tests/recipe_record_tools.test.ts.
 */
import {
  MAX_RECIPE_RECORD_CONTENT_CHARS,
  MAX_RECIPE_RECORD_TAGS,
  MAX_RECIPE_RECORD_TAG_CHARS,
} from '$shared/recipe-record-limits';

function formatRecipeRecordCreateArgs(args: Record<string, unknown>): string {
  const lines: string[] = [];
  if (typeof args.date === 'string' && args.date) lines.push(`**Date:** ${args.date}`);
  if (typeof args.outcome === 'string' && args.outcome) {
    lines.push(`**Outcome:** ${args.outcome}`);
  }
  if (Array.isArray(args.tags) && args.tags.length > 0) {
    lines.push(`**Tags:** ${args.tags.map((t) => String(t)).join(', ')}`);
  }
  if (typeof args.content === 'string' && args.content) {
    lines.push('', args.content);
  }
  return lines.join('\n');
}

export const recipeRecordCreateSchema = {
  name: 'recipe_record_create',
  description:
    'Log a dated record in a recipe\'s cooking log: what happened when ' +
    'the user cooked it - the iteration, results, observations, ideas ' +
    '- distinct from the recipe\'s cooklang (the current state) and ' +
    "from the History panel (which tracks source edits). CAPTURE " +
    'TRIGGER: when the user reports having cooked a recipe and how it ' +
    'went, log the record with this tool and say so in the reply. Use ' +
    'the day the cook happened (read it from the conversation), not ' +
    'today, when the cook is in the past. When it is unclear which ' +
    'recipe is meant or whether a real cook happened, ask instead of ' +
    'guessing. DEDUP GUARD: call recipe_record_list for the recipe ' +
    'first and look for the same EVENT, not the same date - if the ' +
    'event is already logged, recipe_record_update that record ' +
    'instead of stacking a duplicate; two cooks on one date are ' +
    'separate records. The result also lists the recipe\'s same-date ' +
    'records and its most recent earlier record, so a likely ' +
    'duplicate is visible without a second call. Optional outcome ' +
    '(success | mixed | failure) classifies the cook - omit unless ' +
    'setting or clearing it; null clears. Tags are freeform filter ' +
    'keywords. After logging, fold any resulting recipe change (a ' +
    'tweak to the cooklang) into a separate recipe_save edit so the ' +
    "History panel keeps the two apart. Returns {record, " +
    'same_date_siblings, most_recent_prior} - the dedup payload names ' +
    "its parts so a duplicate is visible without a second call.",
  shortDescription: 'log a dated cooking record on a recipe',
  formatArgs: formatRecipeRecordCreateArgs,
  parameters: {
    type: 'object',
    properties: {
      recipe_id: {
        type: 'string',
        description:
          'Required. UUID of the recipe this record belongs to (from ' +
          'recipe_list or recipe_get).',
      },
      date: {
        type: 'string',
        description:
          'Required. ISO 8601 calendar date the cook happened ' +
          '("YYYY-MM-DD"). Use the date from the conversation, not ' +
          'today, when the cook is in the past.',
      },
      content: {
        type: 'string',
        minLength: 1,
        maxLength: MAX_RECIPE_RECORD_CONTENT_CHARS,
        description: `Required. Markdown body (max ${MAX_RECIPE_RECORD_CONTENT_CHARS} chars).`,
      },
      tags: {
        type: 'array',
        items: { type: 'string', maxLength: MAX_RECIPE_RECORD_TAG_CHARS },
        maxItems: MAX_RECIPE_RECORD_TAGS,
        description: 'Optional. Keyword tags for filtering this record.',
      },
      outcome: {
        // Array-typed so a model echoing null passes validation (the
        // handler treats absent and null alike on a create - there is
        // nothing to clear yet; house pattern: followup_save).
        type: ['string', 'null'],
        enum: ['success', 'mixed', 'failure', null],
        description:
          'Optional. How the cook went. Omit unless setting the ' +
          'outcome; the model may echo null (treated as omitting).',
      },
    },
    required: ['recipe_id', 'date', 'content'],
    additionalProperties: false,
  },
} as const;
