/**
 * Schema-only export for wiki_delete. Impl lives in the venice edge
 * function (supabase/functions/venice/tools/wiki_delete.ts), which also
 * self-registers the tool for dispatch.
 *
 * Kept byte-aligned with the agent-side wire schema in
 * supabase/functions/venice/agents/wiki.ts (WIKI_DELETE_WIRE_SCHEMA) so
 * the main chat and the agents present the model one contract.
 */
import { MAX_WIKI_CHANGELOG_MESSAGE_CHARS } from '../wiki';

function formatWikiDeleteArgs(args: Record<string, unknown>): string {
  if (typeof args.message === 'string' && args.message) {
    return `**Why:** ${args.message}`;
  }
  return '';
}

export const wikiDeleteSchema = {
  name: 'wiki_delete',
  description:
    'Delete a wiki article by id. Use only for consolidation - when one ' +
    'article is now strictly subsumed by another article you just updated. ' +
    'Never delete on the basis of "the user said something contradictory ' +
    'today" alone; in that case, update the article to reflect the new view. ' +
    'message is a one-line commit-message-style summary of WHY you are ' +
    `removing this article (max ${MAX_WIKI_CHANGELOG_MESSAGE_CHARS} chars); ` +
    'it lands in the wiki changelog so the user can audit the deletion.',
  shortDescription: 'delete a wiki article',
  formatArgs: formatWikiDeleteArgs,
  parameters: {
    type: 'object',
    properties: {
      id: {
        type: 'string',
        description: 'UUID of the article (from wiki_search).',
      },
      message: {
        type: 'string',
        minLength: 1,
        maxLength: MAX_WIKI_CHANGELOG_MESSAGE_CHARS,
        description:
          'One-line summary of why this article is being removed. Written ' +
          "in the imperative voice (\"Delete 'Kermit protocol' as out-of-" +
          'scope") so the changelog reads as a log of discrete decisions. ' +
          'Lands in the wiki changelog the user can browse from the Wiki ' +
          'top bar.',
      },
    },
    required: ['id', 'message'],
    additionalProperties: false,
  },
} as const;
