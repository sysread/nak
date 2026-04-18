/**
 * The always-on meta-tool. Flips `threads.tools_enabled` so the next
 * request to the model either includes every registered tool's schema
 * (when true) or just this one tool (when false). The LLM calls this
 * before trying to use any of the CRUD tools listed in the catalog.
 *
 * Also reachable from the UI via the composer toolbox button — the
 * state column is the single source of truth for both paths.
 */
import type { ToolDef } from './types';

export const toggleTools: ToolDef = {
  name: 'toggle_tools',
  description:
    'Turn the full tool set on or off for this conversation. When OFF, only ' +
    'this meta-tool is available — call it with {enable: true} before ' +
    "attempting any other tool. When ON, every tool in the catalog is " +
    'callable. Call with {enable: false} when the current task is done, ' +
    'to keep future turns cheap.',
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
