/**
 * Shared state + main-thread runner for the wiki librarian. Two
 * surfaces live here that don't fit cleanly in either the worker
 * manager (which has no $state because manager.ts is not .svelte.ts)
 * or the agent itself (which is a pure logic class):
 *
 * 1. `wikiLibrarianRunner` rune. Two booleans the Wiki top-bar reads:
 *    - `workerBusy`: true while the scheduled background worker is in
 *      the middle of an `agent.run()`. Set/cleared by the manager
 *      intercepting `{type:'busy'}` messages from the worker.
 *    - `manualBusy`: true while a main-thread manual run started from
 *      this module is in flight. Set/cleared inside `runManually`.
 *    The UI disables the manual-run button when either is true so a
 *    user-clicked run never collides with the periodic sweep.
 *
 * 2. `runManually()`. The Wiki top-bar's confirmation strip calls
 *    this with an optional custom-instructions string. It runs the
 *    librarian agent on the main thread - same `WikiLibrarianAgent`
 *    class, same toolbox, just using the app's existing Supabase +
 *    Venice clients instead of the worker's. Crucially, it does NOT
 *    call `claim_wiki_librarian_run`, so a manual run does not
 *    reset the 12h cadence that gates the scheduled worker.
 *
 * Why main-thread, not "kick the worker"? The worker's loop is
 * idle-driven (polling + lease + atomic claim) and would require a
 * new message-shape plus an out-of-band path around the claim RPC.
 * Running on the main thread is simpler, lighter on the worker
 * protocol, and gives the UI a single Promise to await. The agent
 * is all `fetch`-based - no CPU-bound work the worker offload was
 * protecting against.
 */
import type { SupabaseService } from '../../supabase';
import type { VeniceClient } from '../../venice';
import { createLogger } from '../../logger.svelte';
import { emitWikiChange } from '../../wiki-events';
import { WikiLibrarianAgent } from './agent';
import type { WikiLibrarianUserProfile } from './prompt';
import { LIBRARIAN_EXCERPT_CHARS } from './types';

const log = createLogger('wiki-librarian-worker');

interface RunnerState {
  workerBusy: boolean;
  manualBusy: boolean;
}

const state = $state<RunnerState>({ workerBusy: false, manualBusy: false });

export const wikiLibrarianRunner = {
  get workerBusy(): boolean {
    return state.workerBusy;
  },
  get manualBusy(): boolean {
    return state.manualBusy;
  },
  /** True when either a scheduled or a manual run is in flight. */
  get busy(): boolean {
    return state.workerBusy || state.manualBusy;
  },
  /**
   * Called by the manager when the worker posts `{type:'busy', busy:bool}`
   * around its `agent.run()` invocation. Public so the manager can
   * write to the same singleton the UI reads from.
   */
  setWorkerBusy(busy: boolean): void {
    state.workerBusy = busy;
  },
};

function buildProfile(
  name: string,
  location: string
): WikiLibrarianUserProfile | null {
  const n = name.trim();
  const l = location.trim();
  if (n.length === 0 && l.length === 0) return null;
  return {
    name: n.length > 0 ? n : null,
    location: l.length > 0 ? l : null,
  };
}

export interface RunManuallyOpts {
  supabase: SupabaseService;
  venice: VeniceClient;
  userId: string;
  userName: string;
  userLocation: string;
  /**
   * When non-empty, threads through to the prompt's custom-instructions
   * variant. When empty/null, runs the standard periodic sweep prompt -
   * same shape the scheduled worker uses, just without the claim RPC.
   */
  customInstructions: string | null;
  signal?: AbortSignal;
}

export interface RunManuallyResult {
  kind: 'ok' | 'error';
  /** The librarian's one-or-two-sentence summary (or empty on error). */
  finalText: string;
  toolCalls: number;
  articleCount: number;
  /** Human-readable error message when `kind === 'error'`. */
  error?: string;
}

/**
 * Run the wiki librarian agent on the main thread, bypassing the
 * scheduled worker's claim gate. Sets `manualBusy` for the duration.
 *
 * Why no min-articles short-circuit (the scheduled loop refuses to
 * run on a wiki with fewer than LIBRARIAN_MIN_ARTICLES): the user is
 * explicitly asking for a run from the Wiki panel, and custom
 * instructions like "delete the X article" are valid even on a tiny
 * wiki. Spending the tokens is the user's call, not ours.
 */
export async function runManually(
  opts: RunManuallyOpts
): Promise<RunManuallyResult> {
  if (state.manualBusy) {
    return {
      kind: 'error',
      finalText: '',
      toolCalls: 0,
      articleCount: 0,
      error: 'A manual librarian run is already in flight.',
    };
  }
  state.manualBusy = true;
  const variant =
    opts.customInstructions && opts.customInstructions.trim().length > 0
      ? 'custom-instructions'
      : 'standard';
  log.info(`manual librarian run requested (${variant})`);
  try {
    const articles = await opts.supabase.listWikiArticles({ limit: 500 });
    const projection = articles.map((a) => ({
      id: a.id,
      title: a.title,
      excerpt: a.content.slice(0, LIBRARIAN_EXCERPT_CHARS),
    }));

    const agent = new WikiLibrarianAgent(
      opts.venice,
      opts.supabase,
      undefined,
      buildProfile(opts.userName, opts.userLocation)
    );

    const runResult = await agent.run({
      input: {
        articles: projection,
        customInstructions: opts.customInstructions ?? null,
      },
      userId: opts.userId,
      signal: opts.signal,
    });

    // The agent emits its own log lines for the actual review; we
    // mirror the cycle-driver's "finished" line here so the manual
    // path shows up in the drawer with the same shape as the
    // scheduled path. Reasoning is normalised to one line.
    const reasoning =
      runResult.output.finalText.replace(/\s+/g, ' ').trim() || '(none)';
    if (runResult.stoppedReason === 'error') {
      log.warn(
        `manual librarian run errored: ${runResult.error ?? '(no message)'}`
      );
      return {
        kind: 'error',
        finalText: '',
        toolCalls: runResult.toolCalls,
        articleCount: runResult.output.articleCount,
        error: runResult.error ?? 'Librarian run failed without a message.',
      };
    }
    log.info(
      `manual librarian finished (${runResult.toolCalls} tool calls over ` +
        `${runResult.output.articleCount} articles, reasoning="${reasoning}")`
    );
    // Always emit a wiki-change so an open Wiki panel refetches the
    // article list - some manual runs make no edits, but the panel
    // refetch is cheap and keeps the surface honest when edits did
    // land.
    emitWikiChange();
    return {
      kind: 'ok',
      finalText: runResult.output.finalText,
      toolCalls: runResult.toolCalls,
      articleCount: runResult.output.articleCount,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.warn(`manual librarian run threw: ${msg}`);
    return {
      kind: 'error',
      finalText: '',
      toolCalls: 0,
      articleCount: 0,
      error: msg,
    };
  } finally {
    state.manualBusy = false;
  }
}
