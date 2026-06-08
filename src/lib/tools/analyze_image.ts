/**
 * Schema-only browser registration for analyze_image.
 *
 * The tool's IMPLEMENTATION is server-side, in
 * `supabase/functions/venice/tools/analyze_image.ts`. A streamed chat
 * turn dispatches tools in the edge function (`performToolCall`), not
 * the browser - see docs/dev/architecture.md "Production-path
 * ownership". This module exists only so `buildToolList` can advertise
 * analyze_image in the wire `tools` array the browser composes for the
 * model; the schema half of the contract is still browser-owned.
 *
 * `execute()` therefore never runs in production. It throws if called
 * so a regression that re-routes dispatch browser-side surfaces loudly
 * here instead of silently running stale logic (e.g. against the wrong
 * vision model) that has drifted from the live edge implementation.
 */

import type { ToolDef } from './types';
import { analyzeImageSchema } from './analyze_image.schema';

export const analyzeImage: ToolDef = {
  ...analyzeImageSchema,
  execute() {
    throw new Error(
      'analyze_image executes server-side in the venice edge function ' +
        '(supabase/functions/venice/tools/analyze_image.ts); the browser ToolDef ' +
        'is schema-only. Reaching this means tool dispatch was wrongly routed ' +
        'browser-side.'
    );
  },
};
