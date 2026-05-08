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
// Imported from `./index` even though `./index` itself imports
// `toggleToolbox` from this file - the cycle resolves cleanly via
// ESM live bindings because both bindings below are only read inside
// `execute()` at tool-invocation time, well after both modules have
// finished initialising. A previous incarnation deferred the import
// via `await import('./index')` to break the cycle defensively, but
// that was a misread of ESM cycle semantics: the dynamic import was
// neither preventing TDZ access (the references aren't at module
// top level) nor enabling code-splitting (every other importer
// pulled `./index` statically anyway, so the bundler kept it in the
// main chunk).
import { GATED_TOOLBOX_NAMES, alwaysOnToolbox } from './index';
import { toggleToolboxSchema } from './toggle_tools.schema';

export const toggleToolbox: ToolDef = {
  ...toggleToolboxSchema,
  async execute(args, ctx) {
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
