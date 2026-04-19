/**
 * The always-on meta-tool. Flips `threads.tools_enabled` so the next
 * request to the model either includes every registered tool's schema
 * (when true) or just this one tool (when false). The LLM calls this
 * before trying to use any of the CRUD tools listed in the catalog.
 *
 * Also reachable from the UI via the composer toolbox button — the
 * state column is the single source of truth for both paths.
 *
 * The tool description below is deliberately terse. The ambient
 * "what's the catalog, when should you toggle" policy lives in the
 * baseline system prompt (`buildSystemPrompt` in ./index.ts) so it's
 * visible before any tool schemas are on the wire and stays dynamic
 * as tools are added or removed. A tool description is a per-call
 * contract, not a place to teach the model conversation-level rules.
 */
import type { ToolDef } from './types';

export const toggleTools: ToolDef = {
  name: 'toggle_tools',
  description:
    'Toggle the full tool set for this conversation. Pass ' +
    '{enable: true} to expose every tool listed in the system prompt; ' +
    '{enable: false} to put them back behind the gate when the current ' +
    'task is done.',
  shortDescription: 'turn the full tool set on or off',
  parameters: {
    type: 'object',
    properties: {
      enable: {
        type: 'boolean',
        description:
          'true to make every other tool available, false to hide them ' +
          'all except this one.',
      },
    },
    required: ['enable'],
    additionalProperties: false,
  },
  async execute(args, ctx) {
    const enable = Boolean(args.enable);
    await ctx.supabase.setThreadToolsEnabled(ctx.threadId, enable);
    return { enabled: enable };
  },
};
