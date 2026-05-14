/**
 * Schema-only export for the `context` tool. Impl lives in `./context`.
 *
 * The umbrella over the three per-layer recall tools (memory_recall,
 * conversation_recall, wiki_recall). One call, three agents in
 * parallel, one stitched first-person paragraph back. The preferred
 * first step when the main model wants to look up broad persistent
 * context about the user.
 */
export const contextSchema = {
  name: 'context',
  description:
    'Pull broad persistent context about the user from every long- ' +
    'term store in parallel: memories (atomic facts and preferences), ' +
    'prior conversations (what was worked through together), and the ' +
    'wiki (encyclopedic articles about projects, people, places, and ' +
    'topics in their life). ' +
    'Returns either `{kind:"none"}` (nothing worth injecting) or ' +
    '`{kind:"note", note:"<first-person paragraph>"}` stitched across ' +
    'whichever layers carried signal, ready to fold into your next reply ' +
    'as your own recollection. ' +
    'PREFERRED FIRST STEP when you need broad context on the user, ' +
    'their past, their projects, or what you have worked through ' +
    'together - a single round-trip instead of three separate recall ' +
    'calls. For targeted drill-downs on one layer use memory_recall, ' +
    'conversation_recall, or wiki_recall; for raw search hits by ' +
    'phrase use memory_search, conversation_search, or wiki_search.',
  shortDescription:
    'broad persistent context about the user across memories, ' +
    'conversations, and the wiki',
  parameters: {
    type: 'object',
    properties: {
      topic: {
        type: 'string',
        description:
          'Optional phrase to seed every layer\'s first search. Pass the ' +
          'user-facing topic ("the herb garden", "my dad", "the move ' +
          'to Lisbon") so all three agents bias toward it. Omit to let ' +
          'each agent infer from the conversation; the memory layer ' +
          'always infers regardless.',
      },
    },
    additionalProperties: false,
  },
} as const;
