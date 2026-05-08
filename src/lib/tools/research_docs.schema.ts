/**
 * Schema-only export for the research_docs tool. Lives in its own
 * file so `tools/index.ts` can include it in the gated-toolbox
 * catalog without dragging the full impl module (and its
 * `../docs` glob hook) into the main chunk. The full ToolDef
 * arrives via dynamic import on first dispatch - see the lazy
 * wrapper in `tools/index.ts` and the impl in `./research_docs`.
 */
export const researchDocsSchema = {
  name: 'research_docs',
  description:
    'Research a question about Nak itself - its features, settings, ' +
    'keyboard shortcuts, privacy posture, model tiers, memory system, ' +
    'cookbook, attachments, or any other user-facing behavior - by ' +
    'delegating to a sub-agent that reads the bundled in-app help ' +
    'documentation (the same corpus the Help button in the drawer ' +
    'footer renders). Use this whenever the user asks how to do ' +
    'something in Nak, what a setting does, whether a feature exists, ' +
    'or what a UI element means. The docs are authoritative; prefer ' +
    'this over answering from memory whenever the question is about ' +
    'Nak itself, because training-data drift makes answers about app ' +
    'behavior unreliable.\n\n' +
    'For internal / engineering questions - architecture, subsystem ' +
    'boundaries, how an existing feature is wired, "how would we add ' +
    'X to Nak" planning questions - pass ' +
    '`include_internal_dev_docs: true`. That expands the sub-agent\'s ' +
    'corpus to also cover `docs/dev/` (architecture + per-feature dev ' +
    'notes), so it can cross-reference user-facing behavior against ' +
    'internal design notes in a single pass. Leave the flag off (the ' +
    'default) for ordinary user-help questions; the dev corpus is ' +
    'roughly 4x the size of the user manual and loading it on every ' +
    'call is wasteful.\n\n' +
    'This tool lives in the gated `research` toolbox rather than ' +
    'always-on - most conversations are about the user\'s actual ' +
    'work, not meta-questions about the app, and paying a tool- ' +
    'schema tax on every request would be wasteful. If a user turn ' +
    'is clearly a meta-question about Nak and the `research` toolbox ' +
    'is off, call `toggle_toolbox({enabled: ["research", ...]})` to ' +
    'enable it (preserving any other toolboxes the user had on), then ' +
    'call `research_docs` on the next round. Keep it on for the rest ' +
    'of a research-oriented thread; turn it off again once the ' +
    'conversation shifts back to regular work.\n\n' +
    'Takes `query` (the question to research, phrased in plain prose), ' +
    'optional `context_hint` (1-2 sentences on why the caller is ' +
    'asking, to keep the sub-agent on task), and optional ' +
    '`include_internal_dev_docs` (boolean, default false). Returns ' +
    '`{answer, sources}`. In the default mode `sources` entries are ' +
    'filenames like `"settings.md"`; when dev docs are included they ' +
    'carry the tree prefix like `"docs/user/memory.md"` or ' +
    '`"docs/dev/memory.md"` so the two corpuses can be told apart ' +
    '(several filenames collide across the trees).',
  shortDescription: 'research a question in the in-app help docs',
  parameters: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description:
          'The question to research about Nak, phrased in plain prose ' +
          '(a direct question works fine).',
      },
      context_hint: {
        type: 'string',
        description:
          'Optional 1-2 sentences of caller context so the sub-agent ' +
          'knows why it is looking. Helps keep the synthesis focused ' +
          'when the query alone is ambiguous.',
      },
      include_internal_dev_docs: {
        type: 'boolean',
        description:
          'Opt in to the developer-docs corpus (`docs/dev/`) on top of ' +
          'the default user-manual corpus. Set true only for questions ' +
          'about Nak\'s internals, architecture, or planning changes to ' +
          'the app itself - the dev tree is ~4x the size of the user ' +
          'tree and loading it on every call is wasteful. Defaults to ' +
          'false.',
      },
    },
    required: ['query'],
    additionalProperties: false,
  },
} as const;
