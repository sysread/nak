/**
 * The always-on meta-tool. Replaces the thread's
 * `threads.toolboxes_enabled` column with a new set of enabled gated
 * toolboxes. The LLM calls this to bring a toolbox online before
 * using any of the tools inside it, and to put it away when the
 * current task is done.
 *
 * Also reachable from the UI via the composer toolbox popover - the
 * column is the single source of truth for both paths.
 *
 * The tool description below is deliberately terse. The ambient
 * "what's the catalog, when should you toggle" policy lives in the
 * baseline system prompt (`buildSystemPrompt` in ../chat-prompt.ts)
 * so it's visible before any gated tool schemas are on the wire and
 * stays dynamic as toolboxes are added or removed. A tool description
 * is a per-call contract, not a place to teach the model
 * conversation-level rules.
 *
 * Validation: the always_on toolbox name is dropped silently (it's
 * implicit and cannot be disabled), and any name not in the
 * `GATED_TOOLBOX_NAMES` list is dropped silently (the tool's return
 * value tells the model exactly what took effect). Silent drops over
 * throws because a typo or rename should not abort the chat turn -
 * the tool result carrying the accepted set is enough for the model
 * to self-correct on the next call.
 */
import type { ToolDef } from './types';

export const toggleToolbox: ToolDef = {
  name: 'toggle_toolbox',
  description:
    'Replace the set of gated toolboxes active for this conversation. ' +
    'Pass {enabled: ["cooking", "memories"]} to enable exactly those two, ' +
    'or {enabled: []} to turn every gated toolbox off. The always_on ' +
    'toolbox is implicit and cannot be listed or disabled. Returns the ' +
    'accepted set; unknown names are silently dropped.',
  shortDescription: 'enable or disable gated toolboxes for this conversation',
  parameters: {
    type: 'object',
    properties: {
      enabled: {
        type: 'array',
        items: { type: 'string' },
        description:
          'The gated toolboxes that should be active. Replaces the ' +
          'current set; any toolbox not listed is disabled. The ' +
          'always_on toolbox is implicit and cannot be listed or disabled.',
      },
    },
    required: ['enabled'],
    additionalProperties: false,
  },
  async execute(args, ctx) {
    // Deferred import to avoid a module-load cycle: this file is
    // imported by ./index.ts (which defines GATED_TOOLBOX_NAMES),
    // and importing the other direction at the top would have the
    // names set to `undefined` at first reference.
    const { GATED_TOOLBOX_NAMES, alwaysOnToolbox } = await import('./index');
    const raw = Array.isArray(args.enabled) ? (args.enabled as unknown[]) : [];
    const gated = new Set(GATED_TOOLBOX_NAMES);
    const seen = new Set<string>();
    const accepted: string[] = [];
    for (const item of raw) {
      if (typeof item !== 'string') continue;
      if (item === alwaysOnToolbox.name) continue;
      if (!gated.has(item)) continue;
      if (seen.has(item)) continue;
      seen.add(item);
      accepted.push(item);
    }
    await ctx.supabase.setThreadToolboxesEnabled(ctx.threadId, accepted);
    return { enabled: accepted };
  },
};
