/**
 * Schema-only export for `wiki` - the wiki article combination tool.
 * One tool, one `op` enum discriminator (search / list / get / save /
 * delete) with flat per-op parameters, replacing the five wiki_search
 * / wiki_list / wiki_get / wiki_save / wiki_delete verb tools. The
 * combo form follows the `skills` precedent (see that schema's
 * header for the calibration record); per-op required fields cannot
 * be expressed in one flat JSON Schema, so the edge impl routes
 * validation on `op` with ArgErrors
 * (supabase/functions/venice/tools/wiki.ts).
 *
 * The `message` field is required on save + delete (unlike
 * memory_save's optional changelog line): a save has no sensible
 * label-derived default, and the user wants the "why" recorded in
 * the wiki changelog.
 *
 * Agent wires deliberately drift: the agents carry their own
 * per-agent flavored combo wires (narrowed op enums) - see
 * agents/wiki.ts + agents/wiki_librarian.ts.
 */

import {
  MAX_WIKI_TITLE_CHARS,
  MAX_WIKI_CONTENT_CHARS,
  MAX_WIKI_CHANGELOG_MESSAGE_CHARS,
} from '../wiki';

function formatWikiArgs(args: Record<string, unknown>): string {
  const lines: string[] = [];
  // The op leads: the detail panel should read what kind of wiki
  // call this is before any operand.
  if (typeof args.op === 'string' && args.op) {
    lines.push(`**Op:** ${args.op}`);
  }
  if (typeof args.id === 'string' && args.id) {
    lines.push(`**Article id:** ${args.id}`);
  }
  if (typeof args.message === 'string' && args.message) {
    lines.push(`**Why:** ${args.message}`);
  }
  if (typeof args.query === 'string' && args.query) {
    lines.push(`**Query:** ${args.query}`);
  }
  if (typeof args.title === 'string' && args.title) {
    lines.push(`**Title:** ${args.title}`);
  }
  if (typeof args.content === 'string' && args.content) {
    lines.push('', args.content);
  }
  return lines.join('\n');
}

export const wikiSchema = {
  name: 'wiki',
  description:
    "Read and maintain the user's wiki: encyclopedic articles about " +
    'the topics in their life. One tool, one op. search: semantic ' +
    'lookup by topic phrase. list: alphabetical survey with short ' +
    'excerpts - use it when the user asks about the wiki\'s shape ' +
    '(duplicates, coverage). get: one article\'s full body by id ' +
    '(cheaper than search when you know the id). save: create ' +
    '(title + content required) or update by id, passing only the ' +
    'fields that change; titles are unique per user - creating ' +
    'with a title that exactly matches an existing article updates ' +
    'that article instead, and a near-match is refused with the ' +
    'candidates named; preserve existing facts unless the user has ' +
    'explicitly contradicted them. delete: use only for ' +
    'consolidation - when one article is now strictly subsumed by ' +
    'another you just updated; never delete because the user said ' +
    'something contradictory today (update the article instead). ' +
    'message is required on save + delete: one imperative-voice ' +
    'line on WHY ("Add Jeff\'s sister Maya, recently moved to ' +
    'Seattle") - it lands in the changelog the user browses from ' +
    'the Wiki top bar. Returns the saved row (save) or the delete ' +
    'receipt.',
  shortDescription: 'read and maintain wiki articles',
  formatArgs: formatWikiArgs,
  parameters: {
    type: 'object',
    properties: {
      op: {
        type: 'string',
        enum: ['search', 'list', 'get', 'save', 'delete'],
        description:
          'REQUIRED on every call. The operation to run. search: ' +
          'semantic lookup. list: alphabetical survey. get: full ' +
          'body by id. save: create or update. delete: remove for ' +
          'consolidation.',
      },
      id: {
        type: 'string',
        description:
          'Article UUID. get: the article to fetch (required). ' +
          'save: the article to update (omit to create). delete: ' +
          'the article to remove (required). From the search or ' +
          'list ops.',
      },
      query: {
        type: 'string',
        minLength: 1,
        description:
          'search only (required). Topic phrase - semantic match, ' +
          'paraphrases work.',
      },
      title: {
        type: 'string',
        minLength: 1,
        maxLength: MAX_WIKI_TITLE_CHARS,
        description:
          'save only. Article title (the topic name); required to ' +
          'create.',
      },
      content: {
        type: 'string',
        minLength: 1,
        maxLength: MAX_WIKI_CONTENT_CHARS,
        description:
          'save only. Article body, encyclopedic third-person ' +
          'prose; required to create.',
      },
      message: {
        type: 'string',
        minLength: 1,
        maxLength: MAX_WIKI_CHANGELOG_MESSAGE_CHARS,
        description:
          'save + delete (required). One-line summary of why - ' +
          'imperative voice ("Correct Maya\'s employer to Bar"). ' +
          'Lands in the changelog the user browses from the Wiki ' +
          'top bar.',
      },
      limit: {
        type: 'integer',
        minimum: 1,
        maximum: 500,
        description:
          'search: max hits (default 5, max 20). list: max rows ' +
          '(default 100, max 500; alphabetical).',
      },
    },
    required: ['op'],
    additionalProperties: false,
  },
} as const;
