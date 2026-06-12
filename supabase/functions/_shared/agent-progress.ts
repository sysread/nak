// Live step events for user-triggered agent runs, published to the
// browser over Realtime Broadcast.
//
// The Wiki librarian's manual-run strip renders a step list (model
// rounds, tool calls with their narration) while the run is in
// flight. When the librarian ran in the browser those events were a
// plain callback; server-side they cross the wire: the venice route
// publishes each event to the user's private 'agent-runs:<user-uuid>'
// topic and the browser subscribes BEFORE issuing the POST (the
// pre-subscribe rule streaming chat established - subscribing after
// would race the first events).
//
// Per-USER topic rather than per-run: channel authorization is the
// "agent-run channel: owner subscribe" policy on realtime.messages
// (supabase/schema.sql), a literal topic-name equality - one policy
// covers every run. The payload carries the runId; consumers demux
// client-side. Same transport + flush contract as edge-log.ts: each
// publish is a fire-and-forget POST to the broadcast HTTP endpoint
// with the service key, and callers MUST await flush() before the
// route responds or the runtime can drop the trailing events (the
// 'done' event, the one the UI needs to stop its spinner).

export interface CreateAgentProgressPublisherOpts {
  /** Override the broadcast transport. Tests inject a fake fetch. */
  fetchImpl?: typeof fetch;
  /** Override the project URL (defaults to SUPABASE_URL). */
  supabaseUrl?: string;
  /** Override the service key (defaults to SUPABASE_SERVICE_ROLE_KEY). */
  serviceKey?: string;
}

export interface AgentProgressPublisher {
  /** Publish one step event; the payload gains the runId. */
  publish(event: Record<string, unknown>): void;
  /** Await every publish started so far. Safe to call repeatedly. */
  flush(): Promise<void>;
}

/**
 * Build a publisher bound to one user + one run. No-ops (publishes
 * nothing) when the Supabase env is absent, mirroring edge-log.ts -
 * unit tests without a stack still exercise the calling code.
 */
export function createAgentProgressPublisher(
  userId: string,
  runId: string,
  opts: CreateAgentProgressPublisherOpts = {},
): AgentProgressPublisher {
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch;
  const url = opts.supabaseUrl ?? Deno.env.get('SUPABASE_URL') ?? '';
  const serviceKey =
    opts.serviceKey ?? Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
  const endpoint = url ? `${url}/realtime/v1/api/broadcast` : '';
  const topic = `agent-runs:${userId}`;

  const pending: Promise<void>[] = [];

  return {
    publish(event) {
      if (!endpoint || !serviceKey) return;
      const p = fetchImpl(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          apikey: serviceKey,
          Authorization: `Bearer ${serviceKey}`,
        },
        body: JSON.stringify({
          messages: [
            {
              topic,
              event: 'agent-progress',
              payload: { runId, ...event },
              private: true,
            },
          ],
        }),
      })
        // Log a failed publish but never propagate it - progress is
        // observability, not control flow, and the run's outcome still
        // reaches the browser in the route's response body.
        .then((r) => {
          if (!r.ok) {
            console.error(`[agent-progress] broadcast HTTP ${r.status} topic=${topic}`);
          }
        })
        .catch((e) =>
          console.error(
            `[agent-progress] broadcast fetch failed: ${e instanceof Error ? e.message : String(e)}`,
          ),
        );
      pending.push(p);
    },
    async flush() {
      const inflight = pending.splice(0, pending.length);
      await Promise.allSettled(inflight);
    },
  };
}
