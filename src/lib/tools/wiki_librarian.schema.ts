/**
 * Schema-only export for wiki_librarian. Impl lives in `./wiki_librarian`.
 */
export const wikiLibrarianSchema = {
  name: 'wiki_librarian',
  description:
    "Delegate a wiki maintenance task to the user's wiki-librarian " +
    'sub-agent. The librarian reads every wiki article, then carries ' +
    'out the `instructions` you pass (e.g. "merge the two Maya articles ' +
    'into one", "delete the stub about the broken kettle", "split the ' +
    'household article - move kitchen things into their own page"). ' +
    'Side effects (creates, updates, deletes) land directly on the ' +
    "user's wiki; returns {summary, articleCount, toolCalls} where " +
    '`summary` is the librarian\'s 1-2 sentence operator note of what ' +
    'it merged, deleted, or considered-but-left-alone. Use wiki_list / ' +
    'wiki_get to scope your instructions BEFORE calling - vague ' +
    'instructions burn tokens and produce vague results. One run at a ' +
    'time; a concurrent run from the Wiki panel returns an error.',
  shortDescription: 'delegate a wiki maintenance task',
  parameters: {
    type: 'object',
    properties: {
      instructions: {
        type: 'string',
        minLength: 1,
        description:
          'What you want the librarian to do, in plain prose. Be ' +
          'specific - reference article titles or ids when possible, ' +
          'and name the desired outcome (merge, delete, split, ' +
          'rename, rewrite). The librarian carries out your ' +
          'instructions plus only the follow-on edits needed to keep ' +
          'the wiki coherent.',
      },
    },
    required: ['instructions'],
    additionalProperties: false,
  },
} as const;
