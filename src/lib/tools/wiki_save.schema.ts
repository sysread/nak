/**
 * Schema-only export for wiki_save - the create/update-merged wiki
 * write (wiki_create + wiki_update consolidated; see ./upsert.ts for
 * the routing contract). Impl lives in the venice edge function
 * (supabase/functions/venice/tools/wiki_save.ts), which also
 * self-registers the tool for dispatch.
 *
 * Parameter shape kept aligned with the agent-side wire schema in
 * supabase/functions/venice/agents/wiki.ts (WIKI_SAVE_WIRE_SCHEMA);
 * descriptions deliberately drift - agents run without the chat
 * system prompt, so the agent-side description carries the full
 * contract there.
 *
 * The `message` field is required (unlike memory_save's optional
 * changelog line): a save has no sensible label-derived default, and
 * the user wants the "why" recorded in the wiki changelog.
 */
import {
  MAX_WIKI_TITLE_CHARS,
  MAX_WIKI_CONTENT_CHARS,
  MAX_WIKI_CHANGELOG_MESSAGE_CHARS,
} from '../wiki';

function formatWikiWriteArgs(args: Record<string, unknown>): string {
  const lines: string[] = [];
  if (typeof args.id === 'string' && args.id) {
    lines.push(`**Article id:** ${args.id}`);
  }
  if (typeof args.message === 'string' && args.message) {
    lines.push(`**Why:** ${args.message}`);
  }
  if (typeof args.title === 'string' && args.title) {
    lines.push(`**Title:** ${args.title}`);
  }
  if (typeof args.content === 'string' && args.content) {
    lines.push('', args.content);
  }
  return lines.join('\n');
}

export const wikiSaveSchema = {
  name: 'wiki_save',
  description:
    "Save a wiki article: create a new one, or update an existing one " +
    'by id. Omit id to create (title + content required); pass id ' +
    '(from wiki_search) to update, providing only the fields that ' +
    'change. Titles must stay unique per user; creating with a title ' +
    'that exactly matches an existing article updates that article ' +
    'instead, and a near-match is refused with the candidates named. ' +
    'Preserve existing facts unless the user has explicitly ' +
    'contradicted them. Returns the saved row.',
  shortDescription: 'save a wiki article',
  formatArgs: formatWikiWriteArgs,
  parameters: {
    type: 'object',
    properties: {
      id: {
        type: 'string',
        description:
          'UUID of the article to update (from wiki_search). Omit to ' +
          'create a new article.',
      },
      title: {
        type: 'string',
        minLength: 1,
        maxLength: MAX_WIKI_TITLE_CHARS,
        description: 'Article title (the topic name).',
      },
      content: {
        type: 'string',
        minLength: 1,
        maxLength: MAX_WIKI_CONTENT_CHARS,
        description: 'Article body, encyclopedic third-person prose.',
      },
      message: {
        type: 'string',
        minLength: 1,
        maxLength: MAX_WIKI_CHANGELOG_MESSAGE_CHARS,
        description:
          'Required. One-line summary of why this article is being ' +
          'saved. Written in the imperative voice ("Add Jeff\'s sister ' +
          'Maya, recently moved to Seattle" / "Correct Maya\'s employer ' +
          'to Bar") so the changelog reads as a log of discrete ' +
          'decisions. Lands in the wiki changelog the user can browse ' +
          'from the Wiki top bar.',
      },
    },
    required: ['message'],
    additionalProperties: false,
  },
} as const;
