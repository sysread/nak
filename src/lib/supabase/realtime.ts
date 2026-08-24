/**
 * Realtime domain slice of the Supabase data layer: every subscribe*
 * channel the UI holds open (the per-thread message echo stream, the
 * sidebar's thread relay, the coarse "something changed" relays for
 * wiki articles / records, memories and recipes, the private
 * Broadcast channels for edge-function logs, samskara mints and
 * agent-run progress, and the profiles-row relays for the in-flight
 * lease and last-run outcome), plus the point reads paired with those
 * channels (getMessage for the end-of-turn hydration race, the
 * on-mount lease-expiry and last-run-outcome reads that recover state
 * a closed tab missed).
 *
 * Two channel flavors live here. postgres_changes relays ride the
 * replication stream with a server-side filter layered on top of RLS;
 * Broadcast channels (`private: true`) ride realtime.messages
 * policies and carry events the edge functions publish under
 * service_role. Every subscription returns an unsubscribe closure
 * that detaches its channel fire-and-forget.
 *
 * Plain functions taking the shared SupabaseClient as their first
 * argument - no class, no state - so each can be unit-tested against
 * a stubbed client without constructing SupabaseService. The
 * SupabaseService facade (../supabase.ts) delegates its realtime
 * methods here one-for-one under the same names; UI code calls
 * `app.supabase.<method>()` and should not import this module
 * directly. Row types and coercers live in ./types.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  createLogger,
  type SerializableLogEntry,
} from '../logger.svelte';
import { SupabaseError } from './error';
import type {
  Thread,
  Message,
  AgentRunProgressEvent,
  InflightLeaseColumn,
  LastRunOutcomeColumn,
  ManualRunOutcome,
} from './types';
import { coerceManualRunOutcome } from './types';

const log = createLogger('supabase');

/**
 * Realtime: stream INSERTs for a single thread's messages. Keeps a
 * thread open on two devices in sync — when device A's chat-loop
 * commits a user / assistant / tool row, device B sees it land in
 * the transcript without a refresh. Filtering happens server-side
 * (`filter: thread_id=eq.<id>`), layered on top of RLS so a
 * compromised client can't just listen to other users' threads.
 *
 * The caller is responsible for deduping — the inserting device
 * also receives an echo of its own write, and a race can push the
 * echo ahead of the promise resolution for `addMessage`. Dedupe by
 * `Message.id` at the append site handles both orderings.
 */
export function subscribeToMessages(
  client: SupabaseClient,
  threadId: string,
  onMessage: (msg: Message) => void
): () => void {
  // Defend the realtime channel: if the consumer throws, the
  // postgres_changes subscription dies silently and the transcript
  // stops receiving echoes for this thread until the user re-selects
  // it. Log and swallow so subsequent echoes still arrive.
  //
  // Normalize `position` before dispatch: REST reads return numeric
  // columns as JSON numbers, but realtime's change-payload type
  // conversion has treated numeric like bigint (a precision-preserving
  // string) in some client versions. A string position would satisfy
  // the cast below and then poison any later position sort with
  // string/number comparisons - normalize here so Message.position is
  // number | null everywhere downstream.
  const dispatch = (raw: Message): void => {
    let msg = raw;
    const pos = (raw as { position?: unknown }).position;
    if (typeof pos === 'string') {
      const n = Number(pos);
      msg = { ...raw, position: Number.isFinite(n) ? n : null };
    }
    try {
      onMessage(msg);
    } catch (err) {
      log.error('subscribeToMessages handler threw', err);
    }
  };
  const channel = client
    .channel(`messages:${threadId}`)
    .on(
      // `postgres_changes` is the realtime-js event shape for
      // replication-stream rows. Typed loose here — the supabase-js
      // generic is over a whole DB schema and we don't have one.
      'postgres_changes' as never,
      {
        event: 'INSERT',
        schema: 'public',
        table: 'messages',
        filter: `thread_id=eq.${threadId}`,
      },
      (payload: { new: Message }) => {
        dispatch(payload.new);
      }
    )
    .on(
      // UPDATE echoes are how the streaming-root assistant row arrives
      // in its terminal state. The function INSERTs the row with
      // `status='streaming'` at first content delta (which the
      // subscriber filters out) and later UPDATEs the same row when
      // the round chain settles - flipping status to `'complete' |
      // 'aborted' | 'error' | 'suspended_for_ask_user'` and pinning
      // the canonical content/reasoning/citations. Without listening
      // for UPDATEs the terminal row would never enter the local
      // `messages` array; the consumer's id-keyed append handles the
      // INSERT-then-UPDATE ordering.
      'postgres_changes' as never,
      {
        event: 'UPDATE',
        schema: 'public',
        table: 'messages',
        filter: `thread_id=eq.${threadId}`,
      },
      (payload: { new: Message }) => {
        dispatch(payload.new);
      }
    )
    .subscribe();
  return () => {
    // removeChannel returns a promise but we don't care to await —
    // the caller is teardown path, and stray events after this
    // would be no-ops (the channel is detached). Fire-and-forget
    // matches the onAuthChange unsubscribe contract in the facade's
    // auth group (../supabase.ts).
    void client.removeChannel(channel);
  };
}

/**
 * Fetch a single message by id. Returns null when the row doesn't
 * exist or is owned by another user (RLS filters those rows out, so
 * the two cases are indistinguishable). Used by the chat-loop at
 * END time to hydrate the assistant row the streaming function just
 * committed so the slot's persistedRows replay buffer carries a
 * canonical record - the realtime UPDATE echo also delivers the
 * same row separately for the live `messages` view, but the
 * end-of-turn synth path needs the row before the echo races in.
 */
export async function getMessage(
  client: SupabaseClient,
  id: string
): Promise<Message | null> {
  const { data, error } = await client
    .from('messages')
    .select('*')
    .eq('id', id)
    .maybeSingle();
  if (error) throw new SupabaseError(error.message);
  return (data as Message | null) ?? null;
}

/**
 * Realtime: stream INSERT / UPDATE / DELETE on the current user's
 * threads. Keeps the sidebar in sync across devices — a rename on
 * phone reflects on desktop, a newly-created thread appears in the
 * list, and the `updated_at` bump that each message triggers
 * reorders the list newest-first without polling. RLS enforces the
 * user_id scoping; the filter here just narrows the wire traffic.
 *
 * DELETE payloads only carry the primary key (the default
 * `replica identity` — we don't need old-column values), so the
 * handler receives just the id.
 */
export function subscribeToThreads(
  client: SupabaseClient,
  userId: string,
  handlers: {
    onInsert?: (thread: Thread) => void;
    onUpdate?: (thread: Thread) => void;
    onDelete?: (id: string) => void;
  }
): () => void {
  const channel = client
    .channel(`threads:${userId}`)
    .on(
      'postgres_changes' as never,
      {
        event: 'INSERT',
        schema: 'public',
        table: 'threads',
        filter: `user_id=eq.${userId}`,
      },
      (payload: { new: Thread }) => {
        handlers.onInsert?.(payload.new);
      }
    )
    .on(
      'postgres_changes' as never,
      {
        event: 'UPDATE',
        schema: 'public',
        table: 'threads',
        filter: `user_id=eq.${userId}`,
      },
      (payload: { new: Thread }) => {
        handlers.onUpdate?.(payload.new);
      }
    )
    .on(
      'postgres_changes' as never,
      {
        event: 'DELETE',
        schema: 'public',
        table: 'threads',
        filter: `user_id=eq.${userId}`,
      },
      (payload: { old: { id: string } }) => {
        handlers.onDelete?.(payload.old.id);
      }
    )
    .subscribe();
  return () => {
    void client.removeChannel(channel);
  };
}

/**
 * Subscribe to the signed-in user's edge-function log channel. Server-
 * side background work (reflection, and the agent fleets as they
 * migrate off the browser) publishes structured entries to the private
 * `logs:<userId>` Broadcast topic; this feeds each one to `onEntry`,
 * which the caller routes into the Logs drawer via `appendFromEdge`.
 *
 * `private: true` engages the "log channel: owner subscribe" policy on
 * realtime.messages (supabase/schema.sql) - a user only receives their
 * own logs. The edge function publishes under service_role and bypasses
 * the policy. Returns an unsubscribe teardown, same shape as
 * subscribeToThreads.
 */
export function subscribeToUserLogs(
  client: SupabaseClient,
  userId: string,
  onEntry: (entry: SerializableLogEntry) => void
): () => void {
  const channel = client
    .channel(`logs:${userId}`, { config: { private: true } })
    .on('broadcast', { event: 'nak-log' }, ({ payload }) => {
      onEntry(payload as SerializableLogEntry);
    })
    // Surface the channel lifecycle at debug so a future "edge logs
    // aren't reaching the drawer" report can confirm whether the
    // private subscribe reached SUBSCRIBED (vs CHANNEL_ERROR /
    // TIMED_OUT). Drawer-only; not console noise.
    .subscribe((status, err) => {
      log.debug(`logs channel subscribe status: ${status}`, err ?? '');
    });
  return () => {
    void client.removeChannel(channel);
  };
}

/**
 * Read whether a background-agent in-flight lease is currently held
 * for this user. The wiki/memory librarian manual + scheduled runs
 * claim a lease on the profiles row (<agent>_inflight_expires_at);
 * held = a future expiry. RLS lets a user read their own profile.
 * Returns the expiry ISO string when held, else null. The caller
 * derives "running" and arms a timer at the expiry for the crash/TTL
 * case - a lease that lapses without an explicit release writes no
 * row, so no realtime UPDATE fires.
 */
export async function getInflightLeaseExpiry(
  client: SupabaseClient,
  userId: string,
  column: InflightLeaseColumn
): Promise<string | null> {
  const { data, error } = await client
    .from('profiles')
    .select(column)
    .eq('user_id', userId)
    .maybeSingle();
  if (error) throw new Error(`getInflightLeaseExpiry failed: ${error.message}`);
  const exp = (data as Record<string, unknown> | null)?.[column];
  if (typeof exp !== 'string') return null;
  return new Date(exp).getTime() > Date.now() ? exp : null;
}

/**
 * Subscribe to in-flight lease transitions for this user via realtime
 * profiles UPDATEs (requires profiles in the supabase_realtime
 * publication - schema.sql). Calls back with the lease expiry ISO when
 * a run claims/holds it, or null when released. Does NOT fire on a TTL
 * lapse (that writes no row) - the caller's expiry timer covers that.
 * Filtering on user_id is safe for UPDATE delivery because the new
 * tuple always carries it (no replica-identity index needed, unlike
 * the DELETE-delivery relays). Returns an unsubscribe.
 */
export function subscribeToInflightLease(
  client: SupabaseClient,
  userId: string,
  column: InflightLeaseColumn,
  onChange: (expiry: string | null) => void
): () => void {
  const channel = client
    .channel(`inflight_lease:${column}:${userId}`)
    .on(
      'postgres_changes' as never,
      {
        event: 'UPDATE',
        schema: 'public',
        table: 'profiles',
        filter: `user_id=eq.${userId}`,
      },
      (payload: { new?: Record<string, unknown> | null }) => {
        const exp = payload.new?.[column];
        if (typeof exp !== 'string') {
          onChange(null);
          return;
        }
        onChange(new Date(exp).getTime() > Date.now() ? exp : null);
      }
    )
    .subscribe();
  return () => {
    void client.removeChannel(channel);
  };
}

/**
 * Read the most-recent manual-run outcome for this user from the
 * `*_last_run_outcome` profiles column. Returns the coerced envelope
 * (runId / source / finishedAt / result) or null when no run has
 * finished yet or the stored shape is unrecognised. Paired with
 * subscribeToLastRunOutcome: this is the on-mount read that recovers a
 * run that finished while the tab was away; the subscription delivers
 * one that finishes while the tab is open. RLS lets a user read their
 * own profile.
 */
export async function getLastRunOutcome(
  client: SupabaseClient,
  userId: string,
  column: LastRunOutcomeColumn
): Promise<ManualRunOutcome | null> {
  const { data, error } = await client
    .from('profiles')
    .select(column)
    .eq('user_id', userId)
    .maybeSingle();
  if (error) throw new Error(`getLastRunOutcome failed: ${error.message}`);
  return coerceManualRunOutcome((data as Record<string, unknown> | null)?.[column]);
}

/**
 * Subscribe to manual-run-outcome writes for this user via realtime
 * profiles UPDATEs (the same row + publication the in-flight lease
 * rides). The venice function writes the outcome column when a detached
 * run finishes, so the UPDATE's new tuple carries the fresh envelope -
 * delivering it race-free without a re-read. Calls back with the
 * coerced outcome, or null if the new tuple's column is empty/garbage.
 * Returns an unsubscribe.
 */
export function subscribeToLastRunOutcome(
  client: SupabaseClient,
  userId: string,
  column: LastRunOutcomeColumn,
  onOutcome: (outcome: ManualRunOutcome | null) => void
): () => void {
  const channel = client
    .channel(`last_run_outcome:${column}:${userId}`)
    .on(
      'postgres_changes' as never,
      {
        event: 'UPDATE',
        schema: 'public',
        table: 'profiles',
        filter: `user_id=eq.${userId}`,
      },
      (payload: { new?: Record<string, unknown> | null }) => {
        onOutcome(coerceManualRunOutcome(payload.new?.[column]));
      }
    )
    .subscribe();
  return () => {
    void client.removeChannel(channel);
  };
}

/**
 * Subscribe to any change on the signed-in user's wiki articles.
 * The autonomous wiki agent writes articles server-side (the
 * cron-driven sweep), where the browser's emitWikiChange event bus
 * is unreachable - this replication-stream subscription is how an
 * open Wiki panel learns a background write landed. The caller
 * (Chat.svelte) routes the notification into emitWikiChange so
 * every existing wiki surface refetches through the path it
 * already had.
 *
 * Coarse on purpose: no per-event payloads, just "something
 * changed". The wiki surfaces refetch their own lists; pushing row
 * deltas through would duplicate their loaders for no win.
 */
export function subscribeToWikiArticleChanges(
  client: SupabaseClient,
  userId: string,
  onChange: () => void
): () => void {
  const channel = client
    .channel(`wiki_articles:${userId}`)
    .on(
      'postgres_changes' as never,
      {
        event: '*',
        schema: 'public',
        table: 'wiki_articles',
        filter: `user_id=eq.${userId}`,
      },
      () => {
        onChange();
      }
    )
    .subscribe();
  return () => {
    void client.removeChannel(channel);
  };
}

/**
 * Subscribe to any change on the signed-in user's wiki records. Twin
 * of subscribeToWikiArticleChanges - the extraction agent, the
 * librarian, the chat record tools, and the in-app compose form all
 * write records, so the open article view refetches its Records
 * section on a coarse "something changed" signal.
 */
export function subscribeToWikiRecordChanges(
  client: SupabaseClient,
  userId: string,
  onChange: () => void
): () => void {
  // One channel, three tables: the record rows plus their two relations
  // (files + links). A server-side write on any of them - chat tool,
  // extraction agent, librarian - flows into the same coarse
  // "something changed" notification, and an open article view refetches
  // its records / files / links. Each table's DELETE delivery rides its
  // (id, user_id) replica-identity index (see schema.sql).
  const channel = client.channel(`wiki_records:${userId}`);
  for (const table of ['wiki_records', 'wiki_record_files', 'wiki_record_links']) {
    channel.on(
      'postgres_changes' as never,
      {
        event: '*',
        schema: 'public',
        table,
        filter: `user_id=eq.${userId}`,
      },
      () => {
        onChange();
      }
    );
  }
  channel.subscribe();
  return () => {
    void client.removeChannel(channel);
  };
}

/**
 * Subscribe to any change on the signed-in user's grocery list. One
 * channel, three tables (products + entries + sections) folded into
 * the same coarse "something changed" notification - the caller
 * (Chat.svelte) routes it into emitGroceryChange and the Groceries
 * tab refetches whole. This is how a checkbox click in the Cookbook
 * detail pane, the recipe-edit invalidation trigger's delete, and a
 * second device at the store all reach an open list. DELETE delivery
 * rides each table's (id, user_id) replica-identity index (see
 * schema.sql). Products and entries are separate members because
 * either can change alone (a section filing touches only the
 * product; a buy touches only the entry).
 */
export function subscribeToGroceryChanges(
  client: SupabaseClient,
  userId: string,
  onChange: () => void
): () => void {
  const channel = client.channel(`grocery:${userId}`);
  for (const table of [
    'grocery_products',
    'grocery_list_entries',
    'grocery_sections',
  ]) {
    channel.on(
      'postgres_changes' as never,
      {
        event: '*',
        schema: 'public',
        table,
        filter: `user_id=eq.${userId}`,
      },
      () => {
        onChange();
      }
    );
  }
  channel.subscribe();
  return () => {
    void client.removeChannel(channel);
  };
}

/**
 * Subscribe to any change on the signed-in user's memories. The
 * wiki-articles twin above, for the memory writers that all live
 * server-side now (the hourly reflection sweep, the rem and
 * deep-sleep librarian sweeps): the caller (Chat.svelte) routes the
 * notification into emitMemoryChange so an open Memories panel
 * refetches through the path it already had. Same coarse contract -
 * "something changed", no row deltas.
 */
export function subscribeToMemoryChanges(
  client: SupabaseClient,
  userId: string,
  onChange: () => void
): () => void {
  const channel = client
    .channel(`memories:${userId}`)
    .on(
      'postgres_changes' as never,
      {
        event: '*',
        schema: 'public',
        table: 'memories',
        filter: `user_id=eq.${userId}`,
      },
      () => {
        onChange();
      }
    )
    .subscribe();
  return () => {
    void client.removeChannel(channel);
  };
}

/**
 * Subscribe to any change on the signed-in user's recipes. Third of
 * the wiki-articles / memories family: the chat-reachable recipe
 * writers (the recipe_* tools) all run server-side, so this is how
 * an open Cookbook modal or the drawer's Recipes tab learns a
 * model-driven recipe write landed. The caller (Chat.svelte) routes
 * the notification into emitCookbookChange. Same coarse contract -
 * "something changed", no row deltas.
 */
export function subscribeToRecipeChanges(
  client: SupabaseClient,
  userId: string,
  onChange: () => void
): () => void {
  const channel = client
    .channel(`recipes:${userId}`)
    .on(
      'postgres_changes' as never,
      {
        event: '*',
        schema: 'public',
        table: 'recipes',
        filter: `user_id=eq.${userId}`,
      },
      () => {
        onChange();
      }
    )
    .subscribe();
  return () => {
    void client.removeChannel(channel);
  };
}

/**
 * Subscribe to the signed-in user's freshly minted samskaras. The
 * formation pipeline runs in the venice function and publishes a
 * `samskara-mint` Broadcast event per mint (insertMint ->
 * publishSamskaraMint); this relay maps its (tier, valence,
 * confidence) payload into the mood-pill toast (the caller routes it to
 * notifySamskaraMint).
 *
 * Broadcast rather than a postgres_changes echo on purpose: only the
 * server-side INSERT emits the event, so dedup-reinforce hits (which
 * UPDATE an existing row) stay silent - the intended toast semantics -
 * and `samskaras` stays out of the realtime publication, where its
 * fire-bookkeeping UPDATE churn used to flood the WAL decoder (see
 * supabase/functions/_shared/samskara-mint.ts). Payloads with an
 * unexpected shape are dropped: a toast is decoration, never worth
 * surfacing an error for.
 *
 * `private: true` engages the "samskara mint channel: owner subscribe"
 * policy on realtime.messages (supabase/schema.sql) - a user only
 * receives their own mints. The edge function publishes under
 * service_role and bypasses the policy.
 */
export function subscribeToSamskaraInserts(
  client: SupabaseClient,
  userId: string,
  onMint: (detail: { tier: 1 | 2; valence: number; confidence: number }) => void
): () => void {
  const channel = client
    .channel(`samskaras:${userId}`, { config: { private: true } })
    .on('broadcast', { event: 'samskara-mint' }, ({ payload }) => {
      const detail = payload as Record<string, unknown> | undefined;
      if (!detail) return;
      const tier = detail.tier;
      if (tier !== 1 && tier !== 2) return;
      onMint({
        tier,
        valence: typeof detail.valence === 'number' ? detail.valence : 0,
        confidence: typeof detail.confidence === 'number' ? detail.confidence : 0.5,
      });
    })
    // Surface the channel lifecycle at debug so a "mint toasts aren't
    // popping" report can tell an RLS-rejected private subscribe
    // (CHANNEL_ERROR / TIMED_OUT) from a publish-side miss. Same
    // breadcrumb subscribeToUserLogs keeps for the logs channel.
    .subscribe((status, err) => {
      log.debug(`samskaras channel subscribe status: ${status}`, err ?? '');
    });
  return () => {
    void client.removeChannel(channel);
  };
}

/**
 * Subscribe to the signed-in user's agent-run progress channel. The
 * venice function publishes live step events (model rounds, tool
 * calls with their narration) for user-triggered agent runs - the
 * Wiki librarian's manual-run strip and the Memories panel's
 * rem / deep-sleep strips are the consumers. Subscribe
 * BEFORE issuing the run's POST (the pre-subscribe rule streaming
 * chat established); filter by runId at the call site since the
 * topic is per-user, not per-run. `private: true` engages the
 * "agent-run channel: owner subscribe" policy on realtime.messages.
 */
export function subscribeToAgentRunProgress(
  client: SupabaseClient,
  userId: string,
  onEvent: (event: AgentRunProgressEvent) => void
): () => void {
  const channel = client
    .channel(`agent-runs:${userId}`, { config: { private: true } })
    .on('broadcast', { event: 'agent-progress' }, ({ payload }) => {
      onEvent(payload as AgentRunProgressEvent);
    })
    .subscribe((status, err) => {
      log.debug(`agent-runs channel subscribe status: ${status}`, err ?? '');
    });
  return () => {
    void client.removeChannel(channel);
  };
}
