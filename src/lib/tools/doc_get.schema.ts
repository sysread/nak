/**
 * Schema-only export for doc_get. Impl lives in `./doc_get`.
 */

/**
 * Cap on the extracted text doc_get returns inline. A long contract's full
 * text would blow up the context window; past this we return the head and tell
 * the model to use doc_search for targeted retrieval into the rest.
 */
export const DOC_GET_MAX_TEXT_CHARS = 20000;

export const docGetSchema = {
  name: 'doc_get',
  description:
    'Fetch one Library document by id, including its extracted text. Returns ' +
    '{found: true, document: {id, title, description, filename, mime_type, ' +
    'size_bytes, extraction_status, text, text_truncated, created_at, ' +
    'updated_at}} or {found: false}. For documents longer than the inline ' +
    'cap, `text` is the head and `text_truncated` is true - use doc_search ' +
    'to pull specific passages from the remainder. Discover ids with ' +
    'doc_list or doc_search.',
  shortDescription: 'read a document’s text by id',
  parameters: {
    type: 'object',
    properties: {
      id: {
        type: 'string',
        description: 'UUID of the document (from doc_list or doc_search).',
      },
    },
    required: ['id'],
    additionalProperties: false,
  },
} as const;
