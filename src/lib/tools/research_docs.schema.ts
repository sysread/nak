/**
 * Schema-only export for the research_docs tool. Lives in its own
 * file so `tools/index.ts` can include it in the catalog without
 * dragging the impl module's `../docs` glob hook into the main
 * chunk. The full ToolDef arrives via dynamic import on first
 * dispatch - see the lazy wrapper in `tools/index.ts` and the impl
 * in `./research_docs`.
 */
export const researchDocsSchema = {
  name: 'research_docs',
  description:
    'Answer questions about Nak itself by delegating to a sub-agent ' +
    'that reads the bundled in-app help docs (the same corpus the ' +
    'Help button renders). Use whenever the user asks how to do ' +
    'something in Nak, what a setting does, whether a feature exists, ' +
    'or what a UI element means - the docs are authoritative; do not ' +
    'answer about app behaviour from training data. Pass ' +
    '`include_internal_dev_docs: true` for engineering questions ' +
    '(architecture, subsystem boundaries, planning changes); leave ' +
    'off for ordinary user-help questions since the dev corpus is ~4x ' +
    'the size. Returns {answer, sources}; sources are filenames ' +
    "(\"settings.md\") in the default mode and tree-prefixed paths " +
    "(\"docs/user/memory.md\", \"docs/dev/memory.md\") when dev docs " +
    'are included.',
  shortDescription: 'research a question in the in-app help docs',
  parameters: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: 'The question to research, in plain prose.',
      },
      context_hint: {
        type: 'string',
        description:
          'Optional 1-2 sentences of caller context to keep the ' +
          'sub-agent on task.',
      },
      include_internal_dev_docs: {
        type: 'boolean',
        description:
          'Opt in to the docs/dev/ corpus on top of the user manual. ' +
          'Set true for internal/architecture questions only.',
      },
    },
    required: ['query'],
    additionalProperties: false,
  },
} as const;
