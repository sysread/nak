/**
 * Schema-only export for the `context` tool. Impl lives in `./context`.
 *
 * The umbrella over the three persistent layers (memories, prior
 * conversations, wiki). One call runs all three searches in parallel
 * and returns a works-cited index: memory facts verbatim, plus related
 * conversations and wiki articles by id for drill-down. The preferred
 * first step when the main model wants broad persistent context about
 * the user.
 */
export const contextSchema = {
  name: 'context',
  description:
    'Pull broad persistent context about the user from every long- ' +
    'term store in parallel: memories (atomic facts and preferences), ' +
    'prior conversations (what was worked through together), and the ' +
    'wiki (encyclopedic articles about projects, people, places, and ' +
    'topics in their life). ' +
    'Returns {memories: [{id, label, data, confidence_tag}], ' +
    'conversations: [{id, title}], wiki: [{id, title}]}. Memory facts ' +
    'are inlined verbatim - use them directly. Conversations and wiki ' +
    'articles come back as a title + id index: call conversation_get ' +
    'or wiki_get with an id to read the transcript or article body when ' +
    'one looks relevant. Empty arrays mean nothing matched that layer. ' +
    'PREFERRED FIRST STEP when you need broad context on the user, ' +
    'their past, their projects, or what you have worked through ' +
    'together - a single round-trip instead of three separate searches. ' +
    'For an LLM-synthesized read of one layer use memory_recall, ' +
    'conversation_recall, or wiki_recall; for raw search hits by phrase ' +
    'use memory_search, conversation_search, or wiki_search.',
  shortDescription:
    'broad persistent context about the user across memories, ' +
    'conversations, and the wiki',
  parameters: {
    type: 'object',
    properties: {
      topic: {
        type: 'string',
        description:
          'Optional phrase to seed every layer\'s search. Pass the ' +
          'user-facing topic ("the herb garden", "my dad", "the move ' +
          'to Lisbon") so all three searches bias toward it. Omit to ' +
          'derive the query from the current conversation.',
      },
    },
    additionalProperties: false,
  },
} as const;
