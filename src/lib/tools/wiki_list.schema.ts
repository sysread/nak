/**
 * Schema-only export for wiki_list. Impl lives in `./wiki_list`.
 *
 * The excerpt cap mirrors `LIBRARIAN_EXCERPT_CHARS` (400) - same
 * projection the wiki-librarian agent uses for its planning input.
 * Sharing the value keeps "what the librarian sees" and "what the
 * main chat sees" symmetric, which matters when the model wants to
 * plan a librarian run based on the listing it just read.
 */
export const WIKI_LIST_DEFAULT_LIMIT = 100;
export const WIKI_LIST_MAX_LIMIT = 500;
export const WIKI_LIST_EXCERPT_CHARS = 400;

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
