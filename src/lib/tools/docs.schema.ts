/**
 * Schema-only export for `docs` - the Library combination tool. One
 * tool, one `op` enum discriminator (list / get / grep / read / save
 * / delete) with flat per-op parameters, replacing the six doc_list /
 * doc_get / doc_grep / doc_read / doc_save / doc_delete verb tools.
 * The combo form follows the `skills` precedent (see that schema's
 * header for the calibration record); per-op required fields cannot
 * be expressed in one flat JSON Schema, so the edge impl routes
 * validation on `op` with ArgErrors
 * (supabase/functions/venice/tools/docs.ts).
 *
 * The grep-then-read loop is the surface's spine: grep finds line
 * numbers, read pulls the range. The two ops' parameters stay flat
 * and per-op-scoped in their descriptions.
 */

/** The original per-op schema constants, kept under the same names. */
export const DOC_LIST_DEFAULT_LIMIT = 100;
export const DOC_LIST_MAX_LIMIT = 500;
export const DOC_GREP_DEFAULT_CONTEXT = 2;
export const DOC_GREP_MAX_CONTEXT = 5;
export const DOC_GREP_DEFAULT_MAX_MATCHES = 50;
export const DOC_GREP_MAX_MATCHES = 200;
export const DOC_READ_MAX_SPAN = 500;

function formatDocsArgs(args: Record<string, unknown>): string {
  const lines: string[] = [];
  // The op leads: the detail panel should read what kind of Library
  // call this is before any operand.
  if (typeof args.op === 'string' && args.op) {
    lines.push(`**Op:** ${args.op}`);
  }
  for (const key of ['id', 'document_id', 'pattern', 'query'] as const) {
    const v = args[key];
    if (typeof v === 'string' && v) lines.push(`**${key}:** ${v}`);
  }
  if (typeof args.start_line === 'number') {
    lines.push(`**Lines:** ${args.start_line}-${args.end_line ?? '?'}`);
  }
  for (const key of ['title', 'description'] as const) {
    const v = args[key];
    if (typeof v === 'string' && v) lines.push(`**${key}:** ${v}`);
  }
  return lines.join('\n');
}

export const docsSchema = {
  name: 'docs',
  description:
    "Read, search, save, and remove the user's Library: permanent " +
    'searchable documents promoted from files they attached to a ' +
    'conversation. One tool, one op. list: survey the Library ' +
    '(newest first, with descriptions - read those to pick which ' +
    'document a question is about). get: one document overview by ' +
    'id - metadata + line count WITHOUT the text. grep: exact ' +
    "POSIX-regex search inside documents, like `grep -n` - every " +
    'matching line with its line number + context; omit ' +
    'document_id to search across every document; broaden with ' +
    'alternations ("water|flood|leak|seepage") when the user\'s ' +
    'wording may differ from the document\'s; an invalid regex ' +
    'comes back as {error} to fix and retry. read: a numbered line ' +
    `range - at most ${DOC_READ_MAX_SPAN} lines per call, page ` +
    'with successive reads. The loop: grep to pinpoint, read to ' +
    'pull the section. save: promote an attached file into a ' +
    'permanent document (filename of an attachment in this ' +
    'conversation + a description - the description is what makes ' +
    'it findable later), or update an existing document\'s ' +
    'title/description by id; creating with a filename that ' +
    'exactly matches an existing document updates it instead, and ' +
    'a near-match is refused with the candidates named; the ' +
    'document TEXT is bound to the uploaded file and is not ' +
    'editable here - replacing content is a user re-upload. ' +
    'delete: permanently remove a document, its searchable text, ' +
    'and its stored original - irreversible.',
  shortDescription: 'read, search, save, and remove Library documents',
  formatArgs: formatDocsArgs,
  parameters: {
    type: 'object',
    properties: {
      op: {
        type: 'string',
        enum: ['list', 'get', 'grep', 'read', 'save', 'delete'],
        description:
          'REQUIRED on every call. The operation to run. list: ' +
          'browse the Library. get: one overview by id. grep: ' +
          'regex-search inside documents. read: a line range. ' +
          'save: promote or update metadata. delete: remove.',
      },
      id: {
        type: 'string',
        description:
          'Document UUID. get: the document (required). save: the ' +
          'document to update (omit to promote an attachment). ' +
          'delete: the document to remove (required).',
      },
      document_id: {
        type: 'string',
        description:
          'grep: restrict to one document (omit to search all). ' +
          'read: the document to read (required). From list or ' +
          'grep hits.',
      },
      pattern: {
        type: 'string',
        minLength: 1,
        description:
          'grep only (required). POSIX regular expression, ' +
          'case-insensitive by default (e.g. "late fee|penalty").',
      },
      start_line: {
        type: 'integer',
        minimum: 1,
        description:
          'read only (required). 1-based first line, inclusive.',
      },
      end_line: {
        type: 'integer',
        minimum: 1,
        description:
          `read only (required). Last line, inclusive; clamped so ` +
          `the span is at most ${DOC_READ_MAX_SPAN} lines.`,
      },
      case_sensitive: {
        type: 'boolean',
        description: 'grep only. Match case exactly (default false).',
      },
      context: {
        type: 'integer',
        minimum: 0,
        maximum: DOC_GREP_MAX_CONTEXT,
        description: `grep only. Context lines around each match (default ${DOC_GREP_DEFAULT_CONTEXT}, max ${DOC_GREP_MAX_CONTEXT}).`,
      },
      max_matches: {
        type: 'integer',
        minimum: 1,
        maximum: DOC_GREP_MAX_MATCHES,
        description: `grep only. Match cap (default ${DOC_GREP_DEFAULT_MAX_MATCHES}, max ${DOC_GREP_MAX_MATCHES}).`,
      },
      filename: {
        type: 'string',
        minLength: 1,
        description:
          'save only (required on create). Exact filename of the ' +
          'attachment in this conversation - the model cannot ' +
          'upload files; this promotes a file the user attached.',
      },
      title: {
        type: 'string',
        description:
          'save only. Display title (defaults to the filename on ' +
          'create).',
      },
      description: {
        type: 'string',
        description:
          "save only. What this document is for (e.g. \"2024 Aetna " +
          'health insurance policy - deductibles, exclusions") - ' +
          'required on create; it is what list shows for picking ' +
          'the right document later.',
      },
      limit: {
        type: 'integer',
        minimum: 1,
        maximum: DOC_LIST_MAX_LIMIT,
        description: `list only. Max documents (default ${DOC_LIST_DEFAULT_LIMIT}, max ${DOC_LIST_MAX_LIMIT}).`,
      },
    },
    required: ['op'],
    additionalProperties: false,
  },
} as const;
