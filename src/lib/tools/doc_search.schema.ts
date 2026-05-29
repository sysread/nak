/**
 * Schema-only export for doc_search. Impl lives in `./doc_search`.
 */
export const DOC_SEARCH_DEFAULT_LIMIT = 8;
export const DOC_SEARCH_MAX_LIMIT = 20;

export const docSearchSchema = {
  name: 'doc_search',
  description:
    "Semantic search over the user's Library - persistent reference " +
    'documents they uploaded (contracts, insurance policies, tax docs, ' +
    'HOA agreements, etc.). Searches the documents’ text passage-by-' +
    'passage and returns the best-matching passages with their source ' +
    'document, so a question like "what is my deductible" finds the exact ' +
    'paragraph even in a long PDF. Returns ' +
    '{document_id, title, filename, description, chunk_index, content, ' +
    'similarity?}[]. Documents are NEVER auto-injected; this is the only ' +
    'way to reach their contents. Use doc_get to read a whole document.',
  shortDescription: 'search the user’s uploaded documents',
  parameters: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        minLength: 1,
        description: 'Natural-language question or topic to find in the documents.',
      },
      limit: {
        type: 'integer',
        minimum: 1,
        maximum: DOC_SEARCH_MAX_LIMIT,
        description: `Max passages (default ${DOC_SEARCH_DEFAULT_LIMIT}, max ${DOC_SEARCH_MAX_LIMIT}).`,
      },
    },
    required: ['query'],
    additionalProperties: false,
  },
} as const;
