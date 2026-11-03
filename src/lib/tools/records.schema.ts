/**
 * Schema-only export for `records` - the wiki-record combination
 * tool. One tool, one `op` enum discriminator (list / get / search /
 * create / update / delete) with flat per-op parameters, replacing
 * the six record_list / record_get / record_search / record_create /
 * record_update / record_delete verb tools. The combo form follows
 * the `skills` precedent; per-op required fields cannot be expressed
 * in one flat JSON Schema, so the edge impl routes validation on
 * `op` with ArgErrors (supabase/functions/venice/tools/records.ts).
 *
 * DECISION (plan D1): the record FILE tools (record_file_attach /
 * record_file_remove) and LINK tools (record_link_create /
 * record_link_delete) stay separate verb tools - a 10-op flat param
 * space crowds descriptions with per-op qualifiers, and keeping them
 * verbal keeps the agents' file/link wires untouched.
 *
 * The create/update description is a prompt surface: it carries the
 * journey-vs-current-state line (records document discrete events,
 * distinct from the article body) and the changelog audit trail.
 */

// $shared resolves in BOTH runtimes (vite.config.ts for the browser,
// supabase/functions/deno.json for the Deno island) - the pin test
// that reads this schema from the Deno side needs a resolvable import.
import {
  MAX_WIKI_RECORD_CONTENT_CHARS,
  MAX_WIKI_RECORD_TAGS,
  MAX_WIKI_RECORD_TAG_CHARS,
} from '$shared/wiki-limits';

function formatRecordsArgs(args: Record<string, unknown>): string {
  const lines: string[] = [];
  // The op leads: the detail panel should read what kind of record
  // call this is before any operand.
  if (typeof args.op === 'string' && args.op) {
    lines.push(`**Op:** ${args.op}`);
  }
  for (const key of ['id', 'article_id', 'date', 'query'] as const) {
    const v = args[key];
    if (typeof v === 'string' && v) lines.push(`**${key}:** ${v}`);
  }
  if (Array.isArray(args.tags) && args.tags.length > 0) {
    lines.push(`**Tags:** ${args.tags.map((t) => String(t)).join(', ')}`);
  }
  if (typeof args.content === 'string' && args.content) {
    lines.push('', args.content);
  }
  return lines.join('\n');
}

export const recordsSchema = {
  name: 'records',
  description:
    "Maintain a wiki article's dated records: discrete events, " +
    'experiments, observations, or milestones for a topic (the ' +
    "journey) - distinct from the article body (the current state). " +
    'One tool, one op. create: log a dated event on an article ' +
    '(article_id + date + content required); use the date from the ' +
    'conversation, not today, when the event is in the past; it ' +
    'appends a history entry to the article changelog the user ' +
    'reviews. list: one article\'s timeline, newest first, with ' +
    'date-range + tag-AND filters and per-record file/link counts - ' +
    'survey it before writing or updating the article body. get: ' +
    'one record with its attached files (docs expose their text) ' +
    'and its cross-links from this record\'s point of view. search: ' +
    'semantic search across ALL the user\'s records (ranked by ' +
    'meaning; returns [] when the embedder is unreachable - prefer ' +
    'list when you already know the article). update: edit date / ' +
    'content / tags - omitted fields are left unchanged; passing ' +
    'tags replaces the whole array. delete: hard-remove; returns ' +
    '{deleted: false, reason} when nothing matched - check the flag ' +
    'rather than assuming the delete landed. Every write appends ' +
    'the article\'s changelog.',
  shortDescription: 'maintain wiki article records (the journey)',
  formatArgs: formatRecordsArgs,
  parameters: {
    type: 'object',
    properties: {
      op: {
        type: 'string',
        enum: ['list', 'get', 'search', 'create', 'update', 'delete'],
        description:
          'REQUIRED on every call. The operation to run. create: ' +
          'log a dated event. list: one article\'s timeline. get: ' +
          'one record + files + links. search: semantic across ' +
          'all. update: edit a record. delete: remove.',
      },
      id: {
        type: 'string',
        description:
          'Record UUID. get: the record to fetch (required). ' +
          'update: the record to edit (required). delete: the ' +
          'record to remove (required). From the list or search ' +
          'ops.',
      },
      article_id: {
        type: 'string',
        description:
          'Article UUID (from the wiki tool). list: scopes the ' +
          'timeline (required). create: parents the record ' +
          '(required).',
      },
      date: {
        type: 'string',
        description:
          'ISO 8601 calendar date ("YYYY-MM-DD"). create: required ' +
          '- the day the event occurred, from the conversation, ' +
          'not today, when it is in the past. update: optional ' +
          'new date.',
      },
      content: {
        type: 'string',
        minLength: 1,
        maxLength: MAX_WIKI_RECORD_CONTENT_CHARS,
        description:
          `create: required - the Markdown body (max ` +
          `${MAX_WIKI_RECORD_CONTENT_CHARS} chars). update: ` +
          'optional new body.',
      },
      tags: {
        type: 'array',
        items: { type: 'string', maxLength: MAX_WIKI_RECORD_TAG_CHARS },
        maxItems: MAX_WIKI_RECORD_TAGS,
        description:
          'create / update only. Optional keyword tags for ' +
          'filtering; update replaces the whole array.',
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
          'search only (required). Natural-language description of ' +
          'what to find.',
      },
      limit: {
        type: 'number',
        description:
          'list: max records (default 50, max 200). search: max ' +
          'hits (default 10, max 30).',
      },
    },
    required: ['op'],
    // Per-op required fields - flat JSON Schema cannot express them
    // (only the discriminator is unconditionally required). Consumed by
    // the edge validator (validateToolArgs) so a compound fumble -
    // wrong op + missing fields - reports everything in one throw.
    // Ops absent from the map keep handler-only validation.
    'x-per-op-required': {
      list: ['article_id'],
      get: ['id'],
      search: ['query'],
      create: ['article_id', 'date', 'content'],
      update: ['id'],
      delete: ['id'],
    },
    additionalProperties: false,
  },
} as const;
