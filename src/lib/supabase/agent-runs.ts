/**
 * Agent-runs domain slice of the Supabase data layer: the browser
 * side of the server-side background agents. Covers the kick routes
 * into the `venice` edge function (wiki librarian, rem, deep-sleep,
 * the per-thread wiki retry, the per-article manual update), the
 * wiki-skipped-threads read that backs the Skipped panel, and the
 * wiki pipeline reset. These serve the generic agent-run progress UI
 * (the facade's subscribeToAgentRunProgress / lease readers in its
 * realtime group), not just the wiki - hence a module of their own
 * rather than a wiki-satellite home.
 *
 * The run routes normalize their functions.invoke failures through
 * veniceFunctionError (./venice-proxy) so transport/auth errors
 * surface as the same VeniceError shape the proxy routes produce.
 *
 * Plain async functions taking the shared SupabaseClient as their
 * first argument - no class, no state - so each can be unit-tested
 * against a stubbed client without constructing SupabaseService. The
 * SupabaseService facade (../supabase.ts) delegates its agent-run
 * methods here one-for-one under the same names; UI code calls
 * `app.supabase.<method>()` and should not import this module
 * directly. Result types live in ./types.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { SupabaseError } from './error';
import { veniceFunctionError } from './venice-proxy';
import type { WikiRetryResult, WikiManualUpdateResult } from './types';

/**
 * Nuke the wiki subsystem for the current user. Deletes every
 * `wiki_articles` row and nulls `last_wiki_processed_msg_id` + the
 * wiki claim columns on the user's threads so the per-conversation
 * agent re-evaluates from scratch. Wraps both statements in a single
 * server-side transaction (see `reset_wiki_data` in schema.sql) so
 * the articles and the per-thread pipeline state stay in lockstep.
 *
 * Callers (Settings -> Wiki -> Reset) MUST gate this behind an
 * explicit user confirmation - it's irreversible.
 */
export async function resetWikiData(client: SupabaseClient): Promise<void> {
  const { error } = await client.rpc('reset_wiki_data');
  if (error) throw new SupabaseError(error.message);
}

/**
 * List the user's wiki-skipped threads, most recent first. The
 * Wiki tab's Skipped panel renders this; a row drops off the list
 * automatically when the next successful wiki run on that thread
 * clears the skip marker (mark_thread_wiki_processed_if_claimed
 * nulls both columns in one update).
 */
export async function listWikiSkippedThreads(client: SupabaseClient): Promise<
  {
    threadId: string;
    title: string | null;
    lastSkipAt: string;
    lastSkipReason: string | null;
    /**
     * A per-thread wiki claim is currently held - a manual retry (or
     * the sweep's recovery branch) is processing this thread. The
     * Skipped panel renders it as "Retrying..." and recovers the
     * in-flight state across a reload, since the claim is durable
     * server state rather than the panel's in-memory spinner.
     */
    retrying: boolean;
  }[]
> {
  const { data, error } = await client.rpc('list_wiki_skipped_threads');
  if (error) throw new SupabaseError(error.message);
  const rows = (data ?? []) as {
    thread_id: string;
    title: string | null;
    last_skip_at: string;
    last_skip_reason: string | null;
    retrying: boolean | null;
  }[];
  return rows.map((r) => ({
    threadId: r.thread_id,
    title: r.title,
    lastSkipAt: r.last_skip_at,
    lastSkipReason: r.last_skip_reason,
    retrying: r.retrying === true,
  }));
}

/**
 * Ask the venice function to re-run the wiki agent against one
 * skipped thread (the Skipped panel's Retry button). The whole retry
 * cycle - per-thread claim, terminal-message resolution, the agent's
 * tool loop with the content-filter fallback, the pointer advance that
 * clears the skip marker, claim release - runs server-side under
 * EdgeRuntime.waitUntil, so it survives a reload mid-retry; this is a
 * thin authenticated POST. `busy` means the thread was already claimed
 * (the sweep, or a concurrent retry). Agent-level failures come back as
 * `kind: 'error'` in the union (an application outcome, not a transport
 * error); only transport/auth failures throw.
 */
export async function retryWikiThread(
  client: SupabaseClient,
  threadId: string
): Promise<WikiRetryResult> {
  const { data, error } = await client.functions.invoke('venice/wiki-retry', {
    body: { threadId },
  });
  if (error) throw await veniceFunctionError(error);
  const result = data as Partial<WikiRetryResult> | null;
  // Boundary validation: the function returns the union below; an
  // unrecognised shape collapses to an error result rather than
  // letting a malformed payload masquerade as success.
  if (result && result.kind === 'ok' && typeof result.terminalMsgId === 'string') {
    return {
      kind: 'ok',
      terminalMsgId: result.terminalMsgId,
      toolCalls: typeof result.toolCalls === 'number' ? result.toolCalls : 0,
      reasoning: typeof result.reasoning === 'string' ? result.reasoning : '(none)',
    };
  }
  if (result && result.kind === 'no-op' && typeof result.reason === 'string') {
    return { kind: 'no-op', reason: result.reason };
  }
  if (result && result.kind === 'error' && typeof result.error === 'string') {
    return { kind: 'error', error: result.error };
  }
  return { kind: 'error', error: 'wiki-retry returned an unrecognised response' };
}

/**
 * Ask the venice function to run the manual per-article wiki agent
 * (the "Ask agent to update" panel). The prompt build, the single
 * JSON completion, and the article + record reads all happen
 * server-side; this is a thin authenticated POST. Returns the
 * preview / noop the panel renders. The function's union also has a
 * kind:'error' for parse / read / transport failures - this method
 * turns that (and any transport/auth failure) into a thrown Error so
 * the panel's existing catch shows a retry banner; callers only ever
 * see preview or noop on a resolved promise.
 */
export async function runWikiManualUpdate(
  client: SupabaseClient,
  args: {
    articleId: string;
    instructions: string;
  }
): Promise<WikiManualUpdateResult> {
  const { data, error } = await client.functions.invoke('venice/wiki-manual-update', {
    body: { articleId: args.articleId, instructions: args.instructions },
  });
  if (error) throw await veniceFunctionError(error);
  // Boundary validation: the function returns the preview / noop /
  // error union below. An error outcome becomes a throw (the panel
  // wants a banner, not an inline kind); an unrecognised shape throws
  // too rather than masquerading as a no-op.
  const result = data as
    | Partial<WikiManualUpdateResult>
    | { kind?: string; error?: unknown }
    | null;
  if (
    result &&
    result.kind === 'preview' &&
    typeof (result as { title?: unknown }).title === 'string' &&
    typeof (result as { content?: unknown }).content === 'string'
  ) {
    const preview = result as Extract<WikiManualUpdateResult, { kind: 'preview' }>;
    return {
      kind: 'preview',
      title: preview.title,
      content: preview.content,
      reason: typeof preview.reason === 'string' ? preview.reason : '',
      recordOps: Array.isArray(preview.recordOps) ? preview.recordOps : [],
    };
  }
  if (result && result.kind === 'noop') {
    const reason =
      typeof (result as { reason?: unknown }).reason === 'string'
        ? (result as { reason: string }).reason
        : 'No change applied.';
    return { kind: 'noop', reason };
  }
  if (
    result &&
    result.kind === 'error' &&
    typeof (result as { error?: unknown }).error === 'string'
  ) {
    throw new Error((result as { error: string }).error);
  }
  throw new Error('wiki-manual-update returned an unrecognised response');
}

/**
 * Ask the venice function to run the wiki librarian now (the Wiki
 * panel's sparkles button). The whole run - article snapshot,
 * prompt build, the tool loop, the in-flight guard shared with the
 * scheduled sweep and the chat-dispatched path - happens
 * server-side; this is a thin authenticated POST. `runId` is the
 * client-minted demux key for the live step events: subscribe via
 * subscribeToAgentRunProgress BEFORE calling this, or the first
 * events race the subscription.
 */
export async function runWikiLibrarian(
  client: SupabaseClient,
  args: {
    instructions: string | null;
    runId: string;
  }
): Promise<void> {
  // Detached route: the body is {accepted:true} and the run continues
  // in the background past the gateway window. The outcome arrives
  // later as a `result` event on the agent-runs channel (await it via
  // awaitDetachedRun), so this POST only KICKS the run - a non-error
  // response means accepted. A transport/auth failure throws.
  const { error } = await client.functions.invoke('venice/wiki-librarian-run', {
    body: { instructions: args.instructions, runId: args.runId },
  });
  if (error) throw await veniceFunctionError(error);
}

/**
 * Ask the venice function to run the rem (associative integration)
 * memory-librarian pass now (the Memories panel's manual button).
 * The whole run - eligibility pick, prompt build, the tool loop,
 * the in-flight guard shared with the scheduled sweeps and the
 * deep-sleep paths - happens server-side; this is a thin
 * authenticated POST. `runId` is the client-minted demux key for
 * the live step events: subscribe via subscribeToAgentRunProgress
 * BEFORE calling this, or the first events race the subscription.
 */
export async function runRem(
  client: SupabaseClient,
  args: { runId: string }
): Promise<void> {
  // Detached route: the body is {accepted:true} and the run continues
  // in the background past the gateway window. The RemRunResult arrives
  // later as a `result` event on the agent-runs channel (await it via
  // awaitDetachedRun), so this POST only KICKS the run - a non-error
  // response means accepted. A transport/auth failure throws.
  const { error } = await client.functions.invoke('venice/rem-run', {
    body: { runId: args.runId },
  });
  if (error) throw await veniceFunctionError(error);
}

/**
 * Ask the venice function to run the deep-sleep memory-librarian
 * pass now. Same contract as runRem (and the wiki librarian's
 * runWikiLibrarian): subscribe to the progress channel before the
 * POST; the in-flight collision comes back as kind 'busy'.
 */
export async function runDeepSleep(
  client: SupabaseClient,
  args: { runId: string }
): Promise<void> {
  // Detached route, same contract as runRem: returns {accepted:true};
  // the DeepSleepRunResult arrives as a `result` event on the
  // agent-runs channel (await via awaitDetachedRun). KICK only.
  const { error } = await client.functions.invoke('venice/deep-sleep-run', {
    body: { runId: args.runId },
  });
  if (error) throw await veniceFunctionError(error);
}
