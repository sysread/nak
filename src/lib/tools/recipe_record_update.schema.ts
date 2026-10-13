/**
 * Schema-only export for recipe_record_update. Impl lives in
 * `./recipe_record_update` (edge:
 * supabase/functions/venice/tools/recipe_record_update.ts).
 */
import {
  MAX_RECIPE_RECORD_CONTENT_CHARS,
  MAX_RECIPE_RECORD_TAGS,
  MAX_RECIPE_RECORD_TAG_CHARS,
} from '$shared/recipe-record-limits';

function formatRecipeRecordUpdateArgs(args: Record<string, unknown>): string {
  const lines: string[] = [];
  if (typeof args.id === 'string') lines.push(`**Record:** ${args.id}`);
  if (typeof args.date === 'string' && args.date) lines.push(`**Date:** ${args.date}`);
  if (typeof args.outcome === 'string' && args.outcome) {
    lines.push(`**Outcome:** ${args.outcome}`);
  }
  if (Array.isArray(args.tags)) {
    lines.push(`**Tags:** ${args.tags.map((t) => String(t)).join(', ') || '(cleared)'}`);
  }
  if (typeof args.content === 'string' && args.content) {
    lines.push('', args.content);
  }
  return lines.join('\n');
}

export const recipeRecordUpdateSchema = {
  name: 'recipe_record_update',
  description:
    "Edit an existing cooking record's date, content, tags, or " +
    'outcome. Provide id (from recipe_record_list or ' +
    'recipe_record_search) and at least one of date, content, tags, ' +
    "outcome. MERGE, DON'T DUPLICATE: details arrive piecemeal ('the " +
    "crumb was actually fine on day two') - recipe_record_get the " +
    'record first and pass the merged body; content is a ' +
    'full-replacement patch, so an update that omits it leaves the ' +
    'body untouched. Passing tags replaces the whole array. outcome ' +
    '(success | mixed | failure) is optional: omit this field unless ' +
    'setting or clearing the outcome - passing null counts as the ' +
    'one required field and clears the classification. Returns the ' +
    'updated record row.',
  shortDescription: 'edit a cooking record',
  formatArgs: formatRecipeRecordUpdateArgs,
  parameters: {
    type: 'object',
    properties: {
      id: {
        type: 'string',
        description: 'Required. UUID of the record to edit.',
      },
      date: {
        type: 'string',
        description: 'Optional. New ISO 8601 date ("YYYY-MM-DD").',
      },
      content: {
        type: 'string',
        minLength: 1,
        maxLength: MAX_RECIPE_RECORD_CONTENT_CHARS,
        description: `Optional. New Markdown body (max ${MAX_RECIPE_RECORD_CONTENT_CHARS} chars) - full replacement, so merge with the existing body first.`,
      },
      tags: {
        type: 'array',
        items: { type: 'string', maxLength: MAX_RECIPE_RECORD_TAG_CHARS },
        maxItems: MAX_RECIPE_RECORD_TAGS,
        description: 'Optional. Replacement tag array (replaces all existing tags).',
      },
      outcome: {
        // `null` is a real value here (clears the classification) -
        // the array-typed schema is what lets the central validator
        // admit it (a plain type:'string' rejects null before the
        // handler runs; house pattern: followup_save, recipe_save).
        type: ['string', 'null'],
        enum: ['success', 'mixed', 'failure', null],
        description:
          'Optional. Omit unless setting or clearing the outcome; ' +
          'passing null clears the classification (counts as the one ' +
          'required field).',
      },
    },
    required: ['id'],
    additionalProperties: false,
  },
} as const;
