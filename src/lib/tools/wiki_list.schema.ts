/**
 * Schema-only export for wiki_list. The tool dispatches server-side in
 * the venice edge function; this file supplies the catalog metadata the
 * browser ships in the wire `tools` array.
 */
export const WIKI_LIST_DEFAULT_LIMIT = 100;
export const WIKI_LIST_MAX_LIMIT = 500;

export const wikiListSchema = {
  name: 'wiki_list',
  description:
    "List the user's wiki articles alphabetically. Returns " +
    '{id, title, excerpt}[] - excerpt is the first ~400 chars of the ' +
    'body. Use this to survey the wiki when the user asks about its ' +
    'shape (duplicates, coverage, what is in there) or when planning ' +
    'a wiki_librarian run with custom instructions. Call wiki_get for ' +
    'the full body of a specific article; call wiki_search for ' +
    'semantic lookup when you do not know the id.',
  shortDescription: "list the user's wiki articles",
  parameters: {
    type: 'object',
    properties: {
      limit: {
        type: 'integer',
        minimum: 1,
        maximum: WIKI_LIST_MAX_LIMIT,
        description: `Max results (default ${WIKI_LIST_DEFAULT_LIMIT}, max ${WIKI_LIST_MAX_LIMIT}). Articles are sorted alphabetically by title.`,
      },
    },
    additionalProperties: false,
  },
} as const;
