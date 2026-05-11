/**
 * Schema-only export for wiki_recall. Impl lives in `./wiki_recall`.
 */
export const wikiRecallSchema = {
  name: 'wiki_recall',
  description:
    "Run a recall pass over the user's wiki - flat encyclopedic " +
    'articles about projects, people, places, and topics in their ' +
    "life. Returns either `{kind:\"none\"}` (nothing worth injecting) " +
    'or `{kind:"note", note:"<first-person paragraph>"}` to fold into ' +
    'your next reply as your own recollection. Call when the user ' +
    'references one of their own projects/people/places at a topic ' +
    'boundary; for raw article retrieval by phrase use wiki_search.',
  shortDescription: "recall the user's wiki entries relevant to this thread",
  parameters: {
    type: 'object',
    properties: {
      topic: {
        type: 'string',
        description:
          "Optional phrase to seed the recall agent's first search. " +
          'Pass the user-facing topic ("the herb garden", "Maya"); ' +
          'omit to let the agent infer from the conversation.',
      },
    },
    additionalProperties: false,
  },
} as const;
