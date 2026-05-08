/**
 * `lazyTool` - wrap a schema + dynamic-import loader into a ToolDef
 * whose `execute` fetches the impl chunk on first dispatch.
 *
 * Used by both `./index.ts` (main chat's gated tools) and the
 * agent toolbox files (`./memory_toolbox`, `./recall_toolbox`,
 * `./conversation_recall_toolbox`) so the tool impl modules don't
 * end up statically imported by anyone. With every consumer going
 * through the lazy path, Vite emits a single chunk per impl module
 * regardless of which toolbox dispatches into it.
 *
 * Vite needs a LITERAL string inside `import('...')` to do its
 * code-splitting analysis; passing a path through a parameter
 * defeats that. So callers pass a thunk that closes over the
 * literal string at the call site:
 *
 *   const memorySearch = lazyTool(
 *     memorySearchSchema,
 *     () => import('./memory_search'),
 *     'memorySearch',
 *   );
 *
 * `name` is the named export inside the loaded module that carries
 * the full ToolDef (the impl). TypeScript can't infer it from the
 * thunk's return type, so callers spell it explicitly. A typo
 * surfaces the first time the tool fires (the runtime check below
 * throws), and the unit tests under `tests/tools.test.ts` exercise
 * dispatch for every tool, so a typo would fail in CI before
 * deploying.
 *
 * Worker note: this helper is safe to use inside agent-toolbox
 * files even though those files get bundled into Web Workers. The
 * background-worker managers spawn their workers with
 * `type: 'module'` (see `BaseWorkerManager.createWorker`), which
 * lets Vite emit ESM chunks for the worker bundle - dynamic imports
 * inside worker-reachable code work the same as in main-thread
 * chunks. The legacy IIFE-only constraint that motivated the
 * original eager-import shape no longer applies.
 */
import type { ToolDef } from './types';

export function lazyTool(
  schema: Omit<ToolDef, 'execute'>,
  load: () => Promise<Record<string, unknown>>,
  name: string
): ToolDef {
  return {
    ...schema,
    async execute(args, ctx) {
      const m = await load();
      const impl = m[name] as ToolDef | undefined;
      if (!impl || typeof impl.execute !== 'function') {
        throw new Error(
          `lazyTool: '${name}' not found in lazy-loaded module ` +
            'or does not have an execute function'
        );
      }
      return impl.execute(args, ctx);
    },
  };
}
