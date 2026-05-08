/**
 * Schema-only export for recipe_delete. Impl lives in `./recipe_delete`.
 */
export const recipeDeleteSchema = {
  name: 'recipe_delete',
  description:
    'Delete a recipe by id. Use recipe_list first. Returns ' +
    '{deleted: true}.',
  shortDescription: 'remove a saved recipe',
  parameters: {
    type: 'object',
    properties: {
      id: {
        type: 'string',
        description: 'UUID of the recipe.',
      },
    },
    required: ['id'],
    additionalProperties: false,
  },
} as const;
