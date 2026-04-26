<script lang="ts">
  /*
   * Samskara diagnostics modal. Read-only window into the samskara
   * pipeline's state for the currently-selected conversation, plus
   * corpus-level counters and the compound summary that's being
   * injected into every system prompt.
   *
   * Reached from the fist-icon button in the Logs drawer footer;
   * opens via `navigate({ modal: 'samskara' })` and reads `route.cid`
   * to know which thread to fetch for. Non-thread-scoped sections
   * (counters, compound summary) render regardless, so the modal is
   * still useful on the empty thread-picker state.
   *
   * Chrome mirrors Memories/Help (single scrolling column). The panel
   * deliberately does NOT show substrate embeddings (2048 floats per
   * row is too fat to wire), fires older than the current thread (a
   * full history view is out of scope for this first cut), or any
   * corpus-wide samskara list (same reason). When/if the user asks
   * for those, they're additional sections below the existing ones.
   */
  import { onMount } from 'svelte';
  import { app } from '$lib/state.svelte';
  import { route } from '$lib/routing.svelte';
  import type {
    SamskaraSubstrateDiagnosticRow,
    SamskaraFireDiagnosticRow,
  } from '$lib/supabase';
  import {
    MOOD_TABLE,
    CONFIDENCE_CUT,
    cellFor,
    type MoodColumn,
  } from '$lib/samskara/events';
  import { moodState } from '$lib/samskara/mood.svelte';

  interface Props {
    onClose: () => void;
  }
  let { onClose }: Props = $props();

  // Deliberately NO createLogger here. The diagnostics screen is the
  // observer; its own fetches would clutter the drawer the user is
  // likely watching alongside it. Errors surface in the in-component
  // `error` state instead.

  interface CompoundSummary {
    summary: string | null;
    lastRegenAt: string | null;
    samskaraCountAtRegen: number;
  }
  interface Counts {
    totalSamskaras: number;
    tier1Samskaras: number;
    tier2Samskaras: number;
    substrateInThread: number;
    firesInThread: number;
    associations: number;
  }

  let loading = $state(true);
  let error = $state<string | null>(null);
  let compound = $state<CompoundSummary | null>(null);
  let counts = $state<Counts | null>(null);
  let substrate = $state<SamskaraSubstrateDiagnosticRow[]>([]);
  let fires = $state<SamskaraFireDiagnosticRow[]>([]);
  // fire_id -> cluster assignment within its cohort. Populated by the
  // samskara_cluster_thread_fires RPC after the fires fetch lands. An
  // empty map (RPC failed, or no fires) falls back to one-cluster-per-
  // fire in the derivation below, so the renderer always has clusters
  // to walk.
  let clusterMap = $state<Map<string, { clusterSeq: number; clusterSize: number }>>(
    new Map()
  );
  // Per-cluster expand state: keys are `${cohortId}:${clusterSeq}`.
  // Singleton clusters never collapse (no chevron rendered) so they
  // don't need entries here.
  let expandedClusters = $state<Set<string>>(new Set());
  // Per-cohort "show raw fires" override. When a cohort id is present
  // in this set, the renderer bypasses clustering and shows the
  // original flat fires list. Toggle lives on each cohort header.
  let rawCohorts = $state<Set<string>>(new Set());
  // Cosine-similarity threshold for the cluster RPC. Read from
  // localStorage on mount so the user's chosen value sticks across
  // sessions. 0.7 is the documented default - sits in BGE-M3's
  // "topically similar" band (paraphrases run 0.65-0.78) without
  // collapsing genuinely-different ideas. Slider lives in the cohort-
  // fires section header so the user can tune live; persisted on
  // every settle (input event), not just commit (change event), so a
  // back-button doesn't lose the dial position.
  const THRESHOLD_KEY = 'nak:samskara:cluster-threshold:v1';
  const DEFAULT_THRESHOLD = 0.7;
  function readStoredThreshold(): number {
    try {
      const raw = localStorage.getItem(THRESHOLD_KEY);
      if (!raw) return DEFAULT_THRESHOLD;
      const n = Number.parseFloat(raw);
      // Reject NaN and out-of-range values rather than silently
      // clamping - a corrupt stored value should fall back to the
      // documented default, not anchor the user at -2.
      if (!Number.isFinite(n) || n < 0.5 || n > 0.95) return DEFAULT_THRESHOLD;
      return n;
    } catch {
      return DEFAULT_THRESHOLD;
    }
  }
  function persistThreshold(v: number): void {
    try {
      localStorage.setItem(THRESHOLD_KEY, v.toFixed(2));
    } catch {
      // private mode / quota - drop silently. The slider still
      // affects the live session; just won't carry across reloads.
    }
  }
  let clusterThreshold = $state<number>(readStoredThreshold());
  // Generation counter to drop stale RPC responses when the slider
  // moves faster than the network. Without it, a slow response from
  // an earlier threshold can land after a faster response from the
  // current threshold and overwrite the right answer.
  let clusterGen = 0;
  let clusterReclustering = $state(false);
  // Snapshot route.cid ONCE at mount. The modal is full-screen so
  // the user can't switch threads without first closing us; a fresh
  // open re-runs onMount. Intentionally NOT reactive to avoid the
  // effect-retriggering stampede that an earlier version produced
  // during the cold-load path when route.cid + app.supabase were
  // both still settling.
  const threadId = route.cid;

  // Group fires by cohort so the renderer draws "one cohort" cards
  // instead of one row per (cohort, samskara) pair. Cohort order
  // preserved from the original array (newest fired_at first). Each
  // cohort also carries a clusters[] view derived from clusterMap,
  // which the renderer prefers over the flat fires list unless the
  // user toggled "Show raw fires" on this cohort.
  interface ClusterView {
    seq: number;
    representative: SamskaraFireDiagnosticRow;
    siblings: SamskaraFireDiagnosticRow[];
  }
  interface CohortGroup {
    cohortId: string;
    firedAt: string;
    wasConfirmed: boolean | null;
    fires: SamskaraFireDiagnosticRow[];
    clusters: ClusterView[];
  }
  const cohortGroups: CohortGroup[] = $derived.by(() => {
    const groups = new Map<string, CohortGroup>();
    for (const f of fires) {
      const existing = groups.get(f.cohortId);
      if (existing) {
        existing.fires.push(f);
        // Within a cohort every row shares cohort_id + fired_at +
        // was_confirmed, so the first wins. Ordering inside the
        // cohort is highest-score-first.
      } else {
        groups.set(f.cohortId, {
          cohortId: f.cohortId,
          firedAt: f.firedAt,
          wasConfirmed: f.wasConfirmed,
          fires: [f],
          clusters: [],
        });
      }
    }
    for (const g of groups.values()) {
      g.fires.sort((a, b) => b.score - a.score);
      // Build clusters off clusterMap. Fires without an entry (RPC
      // hadn't loaded, or failed) fall through to a singleton cluster
      // each, which means the worst case still renders something
      // sensible - just no abstraction.
      const bySeq = new Map<number, SamskaraFireDiagnosticRow[]>();
      let nextFallbackSeq = -1;
      for (const f of g.fires) {
        const assigned = clusterMap.get(f.id);
        const seq = assigned?.clusterSeq ?? nextFallbackSeq--;
        const bucket = bySeq.get(seq);
        if (bucket) bucket.push(f);
        else bySeq.set(seq, [f]);
      }
      // Order clusters by their representative's score (descending)
      // so the most-relevant theme leads. The representative is the
      // first member after the per-cohort score-desc sort above.
      const clusters: ClusterView[] = [...bySeq.values()]
        .map((members) => ({
          seq: clusterMap.get(members[0].id)?.clusterSeq ?? 0,
          representative: members[0],
          siblings: members.slice(1),
        }))
        .sort((a, b) => b.representative.score - a.representative.score);
      g.clusters = clusters;
    }
    return [...groups.values()];
  });

  // Where the mood pill currently sits in MOOD_TABLE, for the
  // legend's "you are here" dot. Reads through the shared moodState
  // so it stays in lockstep with the pill the user clicked to open
  // this modal - SamskaraToasts updates moodState on every mint and
  // on the seed-from-history path, so this derived recomputes
  // automatically whenever the pill itself changes. Null when there
  // is no current mood (brand-new chat, or a thread that has never
  // fired and whose seed hasn't returned).
  const currentCell: { row: number; column: MoodColumn } | null = $derived.by(
    () => {
      const m = moodState.current;
      if (!m) return null;
      return cellFor(m.valence, m.confidence);
    }
  );

  function clusterKey(cohortId: string, seq: number): string {
    return `${cohortId}:${seq}`;
  }
  function toggleCluster(cohortId: string, seq: number): void {
    const key = clusterKey(cohortId, seq);
    const next = new Set(expandedClusters);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    expandedClusters = next;
  }
  function toggleRaw(cohortId: string): void {
    const next = new Set(rawCohorts);
    if (next.has(cohortId)) next.delete(cohortId);
    else next.add(cohortId);
    rawCohorts = next;
  }

  // Re-cluster fires at a new threshold. Driven by the slider's
  // input event so the user sees the grouping shift live as they
  // drag. Each call bumps clusterGen so a slow response from a
  // previous threshold doesn't clobber a faster response from the
  // current one - the user can drag past several positions and the
  // last commit always wins.
  //
  // Fires/substrate are not refetched because the threshold only
  // affects how the existing fires bucket - the underlying data
  // doesn't change. expandedClusters resets because cluster_seq
  // values shift across thresholds; a stale "open this cluster"
  // flag would point at a different cluster after re-clustering.
  async function reCluster(threshold: number): Promise<void> {
    if (!app.supabase || !threadId) return;
    persistThreshold(threshold);
    expandedClusters = new Set();
    clusterGen++;
    const thisGen = clusterGen;
    clusterReclustering = true;
    try {
      const map = await app.supabase.samskaraClusterThreadFires(threadId, threshold);
      if (thisGen === clusterGen) clusterMap = map;
    } catch {
      if (thisGen === clusterGen) clusterMap = new Map();
    } finally {
      if (thisGen === clusterGen) clusterReclustering = false;
    }
  }

  function onThresholdInput(e: Event): void {
    const v = Number.parseFloat((e.currentTarget as HTMLInputElement).value);
    if (!Number.isFinite(v)) return;
    clusterThreshold = v;
    void reCluster(v);
  }

  // Sequenced fetch. Earlier version ran 4 top-level queries in
  // Promise.all and the counts helper ran 6 more underneath, for a
  // fan-out of up to 9 concurrent Supabase calls. On a cold-load
  // path those all hit `@supabase/gotrue-js`'s navigator.locks-
  // based auth-token lock at once, alongside the main-thread
  // refreshSettings and five worker clients. The lock's 5s timeout
  // triggered, supabase-js force-acquired, and in-flight fetches
  // failed with "TypeError: Failed to fetch". Running the queries
  // sequentially keeps the lock uncontested; the full modal loads
  // in ~500-800ms, which is fine for an explicitly-opened panel.
  //
  // Each section is wrapped independently so a single-query failure
  // doesn't blank the whole screen. The section either renders its
  // data or shows its own "couldn't load" line.
  async function refresh(): Promise<void> {
    if (!app.supabase) {
      error = 'Not connected to Supabase yet.';
      loading = false;
      return;
    }
    loading = true;
    error = null;
    const sb = app.supabase;

    try {
      compound = await sb.samskaraGetCompoundSummary();
    } catch (err) {
      compound = null;
      error = `Compound summary: ${err instanceof Error ? err.message : String(err)}`;
    }

    try {
      // When no thread is selected we still fetch corpus counters
      // with a zero-UUID stand-in, so the modal's Overview remains
      // useful on the empty state.
      const effectiveThread = threadId ?? '00000000-0000-0000-0000-000000000000';
      counts = await sb.samskaraDiagnosticsCounts(effectiveThread);
    } catch (err) {
      counts = null;
      error = error ?? `Counts: ${err instanceof Error ? err.message : String(err)}`;
    }

    if (threadId) {
      try {
        substrate = await sb.samskaraListSubstrateForThread(threadId);
      } catch (err) {
        substrate = [];
        error = error ?? `Substrate: ${err instanceof Error ? err.message : String(err)}`;
      }

      try {
        fires = await sb.samskaraListFiresForThread(threadId);
      } catch (err) {
        fires = [];
        error = error ?? `Fires: ${err instanceof Error ? err.message : String(err)}`;
      }

      // Cluster the fires by prediction-embedding cosine so the
      // renderer can collapse 22-row cohorts down to a few themes.
      // Soft-failure: an empty map falls through to one-cluster-per-
      // fire in the cohortGroups derivation, so the panel still
      // renders if the RPC isn't deployed yet (fresh schema not
      // synced) or errors out. Bumps clusterGen so any in-flight
      // slider-triggered call from a prior render is treated as
      // stale.
      clusterGen++;
      const thisGen = clusterGen;
      try {
        const map = await sb.samskaraClusterThreadFires(threadId, clusterThreshold);
        if (thisGen === clusterGen) clusterMap = map;
      } catch (err) {
        if (thisGen === clusterGen) {
          clusterMap = new Map();
          error = error ?? `Clusters: ${err instanceof Error ? err.message : String(err)}`;
        }
      }
    } else {
      substrate = [];
      fires = [];
      clusterMap = new Map();
    }
    // Drop any per-cohort UI state from a prior refresh; the cohort
    // ids may be the same but the cluster assignments could differ if
    // the threshold or underlying samskaras changed between loads.
    expandedClusters = new Set();
    rawCohorts = new Set();

    loading = false;
  }

  onMount(() => {
    void refresh();
  });

  // --- formatters ---------------------------------------------------------

  function formatRelative(iso: string | null | undefined): string {
    if (!iso) return 'never';
    const then = new Date(iso).getTime();
    if (Number.isNaN(then)) return iso ?? 'never';
    const diffMs = Date.now() - then;
    const diffSec = Math.round(diffMs / 1000);
    if (diffSec < 60) return `${diffSec}s ago`;
    const diffMin = Math.round(diffSec / 60);
    if (diffMin < 60) return `${diffMin}m ago`;
    const diffHr = Math.round(diffMin / 60);
    if (diffHr < 24) return `${diffHr}h ago`;
    const diffDay = Math.round(diffHr / 24);
    if (diffDay < 30) return `${diffDay}d ago`;
    const diffMo = Math.round(diffDay / 30);
    if (diffMo < 12) return `${diffMo}mo ago`;
    const diffYr = Math.round(diffMo / 12);
    return `${diffYr}y ago`;
  }

  function formatValence(v: number | null): string {
    if (v === null) return '—';
    const sign = v > 0 ? '+' : '';
    return `${sign}${v.toFixed(2)}`;
  }

  // Three-state label for a cohort's resolution status. The data
  // model stores was_confirmed as boolean | null with null meaning
  // "reaction-classify hasn't looked at this cohort yet". Distinguish
  // "recently fired, waiting" from "aged out without resolution" by
  // the 10-minute window the classifier uses.
  function resolutionLabel(wasConfirmed: boolean | null, firedAt: string): string {
    if (wasConfirmed === true) return 'confirmed';
    if (wasConfirmed === false) return 'disconfirmed';
    const ageMs = Date.now() - new Date(firedAt).getTime();
    if (ageMs < 60 * 1000) return 'waiting (in-flight)';
    if (ageMs < 10 * 60 * 1000) return 'waiting (resolution window open)';
    return 'aged out (no reaction)';
  }

  function assimilationStatus(r: SamskaraSubstrateDiagnosticRow): string {
    if (r.situation === null) return 'pending assimilation';
    if (r.embeddingModel === null) return 'assimilated, pending embed';
    return 'assimilated + embedded';
  }

  // Copy-to-clipboard: build one self-contained JSON blob that
  // mirrors what the panel renders, so pasting it into a separate
  // conversation gives an assistant enough context to reason about
  // the samskara state without needing DB access. The blob includes
  // a capture timestamp + the build fingerprint so a pasted report
  // can be correlated with a specific deploy. Opaque ids are kept
  // so the reader can cross-reference against the log drawer.
  let copyState = $state<'idle' | 'copied' | 'error'>('idle');
  let copyResetTimer: ReturnType<typeof setTimeout> | null = null;

  function buildSnapshot(): string {
    const snapshot = {
      capturedAt: new Date().toISOString(),
      buildCommit: __APP_COMMIT__,
      buildTime: __APP_BUILD_TIME__,
      threadId,
      counts,
      compoundSummary: compound,
      substrate: substrate.map((r) => ({
        id: r.id,
        createdAt: r.createdAt,
        userMessageId: r.userMessageId,
        assistantMessageId: r.assistantMessageId,
        status: assimilationStatus(r),
        situation: r.situation,
        outcome: r.outcome,
        valence: r.valence,
        embeddingModel: r.embeddingModel,
      })),
      cohortFires: cohortGroups.map((g) => ({
        cohortId: g.cohortId,
        firedAt: g.firedAt,
        resolution: resolutionLabel(g.wasConfirmed, g.firedAt),
        wasConfirmed: g.wasConfirmed,
        // Full member detail is preserved in the export even when the
        // panel is rendering a collapsed-by-theme view. clusterSeq is
        // included so a reader can reconstruct the same grouping the
        // panel produced (or reason about why two fires landed in the
        // same theme) without re-running the clustering RPC.
        members: g.fires.map((f) => ({
          id: f.id,
          samskaraId: f.samskaraId,
          score: f.score,
          clusterSeq: clusterMap.get(f.id)?.clusterSeq ?? null,
          samskara: f.samskara,
        })),
      })),
    };
    return JSON.stringify(snapshot, null, 2);
  }

  // Manual trigger for the co-firing-based dedup RPC. The samskara
  // worker runs the same RPC each rotation as its `dedup` phase, so
  // this button is a "do it now without waiting for the 60s idle
  // tick" escape hatch rather than the only way collapses happen.
  // Per-call cap (20 merges) is enforced inside the RPC; click a few
  // times in a row if the diagnostic panel still shows redundancy.
  // Idempotent - a second click against a clean pool returns 0 - so
  // re-running is safe. We still confirm because it deletes rows; a
  // mistake isn't catastrophic (provenance + fires are migrated to
  // the keeper) but a surprise is worth avoiding.
  let collapseState = $state<'idle' | 'running' | 'done' | 'error'>('idle');
  let collapsedCount = $state<number | null>(null);
  let collapseResetTimer: ReturnType<typeof setTimeout> | null = null;

  async function collapseDuplicates(): Promise<void> {
    if (!app.supabase) return;
    const ok = window.confirm(
      'Consolidate samskaras?\n\n' +
        'Tier-1 samskaras that reliably co-fire in the same cohort ' +
        '(Hebbian redundancy) are merged into their oldest ' +
        'representative. Fires and provenance move with the merge; ' +
        'losers are deleted. A population-count safety cap kicks in ' +
        'if the pool is still over target after the co-firing pass. ' +
        'Capped at 20 merges per click - re-click to drain further. ' +
        'Idempotent.'
    );
    if (!ok) return;
    collapseState = 'running';
    collapsedCount = null;
    if (collapseResetTimer !== null) {
      clearTimeout(collapseResetTimer);
      collapseResetTimer = null;
    }
    try {
      const n = await app.supabase.samskaraCollapseByCofiring();
      collapsedCount = n;
      collapseState = 'done';
      // Reload so the counters + cohort list reflect the post-collapse
      // state. A user who just clicked the button wants to see the
      // outcome, not stale numbers.
      await refresh();
    } catch {
      collapseState = 'error';
    }
    collapseResetTimer = setTimeout(() => {
      collapseState = 'idle';
      collapsedCount = null;
      collapseResetTimer = null;
    }, 4000);
  }

  async function copySnapshot(): Promise<void> {
    const text = buildSnapshot();
    try {
      await navigator.clipboard.writeText(text);
      copyState = 'copied';
    } catch {
      // Fallback: some browsers (older Safari in non-secure contexts,
      // or when the Clipboard API is blocked) reject writeText. A
      // hidden textarea + execCommand('copy') still works in those
      // environments; good enough for a debug surface.
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      try {
        document.execCommand('copy');
        copyState = 'copied';
      } catch {
        copyState = 'error';
      } finally {
        document.body.removeChild(ta);
      }
    }
    if (copyResetTimer !== null) clearTimeout(copyResetTimer);
    copyResetTimer = setTimeout(() => {
      copyState = 'idle';
      copyResetTimer = null;
    }, 2000);
  }

  // Aggregated transient feedback for the icon toolbar. The icon
  // buttons themselves never change shape, so any "Copied", "Loading",
  // "Consolidated N" message has to land in this companion span. Order
  // matters - loading wins because Refresh is the only button that
  // disables the rest, and an in-flight collapse beats a stale "Copied"
  // toast from the previous action.
  const toolbarStatus: string | null = $derived.by(() => {
    if (loading) return 'Loading…';
    if (collapseState === 'running') return 'Consolidating…';
    if (collapseState === 'done') {
      return collapsedCount === 0
        ? 'Nothing to consolidate'
        : `Consolidated ${collapsedCount}`;
    }
    if (collapseState === 'error') return 'Consolidation failed';
    if (copyState === 'copied') return 'Copied!';
    if (copyState === 'error') return 'Copy failed';
    return null;
  });
</script>

<svelte:window onkeydown={(e) => { if (e.key === 'Escape') onClose(); }} />

<!-- svelte-ignore a11y_no_static_element_interactions -->
<!-- svelte-ignore a11y_click_events_have_key_events -->
<div
  class="center samskara-backdrop"
  onclick={(e) => { if (e.target === e.currentTarget) onClose(); }}
>
  <div class="samskara-shell" role="dialog" aria-modal="true" aria-label="Samskara diagnostics">
    <button
      type="button"
      class="samskara-close"
      onclick={onClose}
      aria-label="Close diagnostics"
      title="Close"
    >×</button>

    <header class="samskara-header">
      <h1 class="samskara-title">Samskara diagnostics</h1>
      <p class="subtle samskara-blurb">
        Read-only view into the samskara pipeline. Predictions this
        chat fired, substrate the worker recorded, and the compound
        summary currently riding in every system prompt. See
        <em>docs/dev/samskara.md</em> for the underlying design.
      </p>
      <!-- Compact icon bar. Replaced wider labeled buttons that wrapped
           to two rows on phones. Transient state (Copied, Consolidating,
           Consolidated N, etc.) lives in the polite-aria-live status
           span instead of mutating button labels - the buttons stay
           fixed-width so the bar doesn't reflow as actions resolve. -->
      <div class="samskara-toolbar">
        <button
          type="button"
          class="secondary icon-btn samskara-icon-btn"
          onclick={() => void refresh()}
          disabled={loading}
          aria-label="Refresh diagnostics"
          title="Refresh diagnostics"
        >
          <svg
            class="icon"
            class:icon-spinning={loading}
            viewBox="0 0 24 24"
            width="18"
            height="18"
            aria-hidden="true"
          >
            <path
              d="M3.5 12a8.5 8.5 0 0 1 14.5-6l2 2"
              stroke="currentColor"
              stroke-width="2"
              stroke-linecap="round"
              stroke-linejoin="round"
              fill="none"
            />
            <path
              d="M20 3v5h-5"
              stroke="currentColor"
              stroke-width="2"
              stroke-linecap="round"
              stroke-linejoin="round"
              fill="none"
            />
            <path
              d="M20.5 12a8.5 8.5 0 0 1-14.5 6l-2-2"
              stroke="currentColor"
              stroke-width="2"
              stroke-linecap="round"
              stroke-linejoin="round"
              fill="none"
            />
            <path
              d="M4 21v-5h5"
              stroke="currentColor"
              stroke-width="2"
              stroke-linecap="round"
              stroke-linejoin="round"
              fill="none"
            />
          </svg>
        </button>
        <button
          type="button"
          class="secondary icon-btn samskara-icon-btn"
          onclick={() => void copySnapshot()}
          disabled={loading}
          aria-label="Export panel snapshot to clipboard"
          title="Copy everything on this panel as a JSON blob for pasting into a chat / bug report"
        >
          <svg
            class="icon"
            viewBox="0 0 24 24"
            width="18"
            height="18"
            aria-hidden="true"
          >
            <rect
              x="9"
              y="3"
              width="6"
              height="3"
              rx="1"
              stroke="currentColor"
              stroke-width="2"
              fill="none"
            />
            <path
              d="M9 5H6a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2h-3"
              stroke="currentColor"
              stroke-width="2"
              stroke-linecap="round"
              stroke-linejoin="round"
              fill="none"
            />
          </svg>
        </button>
        <button
          type="button"
          class="secondary icon-btn samskara-icon-btn"
          onclick={() => void collapseDuplicates()}
          disabled={loading || collapseState === 'running'}
          aria-label="Consolidate duplicate samskaras"
          title="Merge tier-1 samskaras that reliably co-fire together (primary) and trim the pool to target count (safety cap). Same RPC the background worker runs each rotation; this is the manual 'do it now' trigger. Capped at 20 merges per click."
        >
          <!-- Two parent nodes merging into one - visual shorthand for
               co-firing samskaras being consolidated into a keeper. -->
          <svg
            class="icon"
            class:icon-spinning={collapseState === 'running'}
            viewBox="0 0 24 24"
            width="18"
            height="18"
            aria-hidden="true"
          >
            <circle
              cx="6"
              cy="5"
              r="2"
              stroke="currentColor"
              stroke-width="2"
              fill="none"
            />
            <circle
              cx="18"
              cy="5"
              r="2"
              stroke="currentColor"
              stroke-width="2"
              fill="none"
            />
            <circle
              cx="12"
              cy="19"
              r="2"
              stroke="currentColor"
              stroke-width="2"
              fill="none"
            />
            <path
              d="M7 7l4 10M17 7l-4 10"
              stroke="currentColor"
              stroke-width="2"
              stroke-linecap="round"
              fill="none"
            />
          </svg>
        </button>
        <span
          class="samskara-toolbar-status"
          class:visible={toolbarStatus !== null}
          aria-live="polite"
          aria-atomic="true"
        >
          {toolbarStatus ?? ''}
        </span>
      </div>
    </header>

    <section class="samskara-body">
      {#if error}
        <p class="error">{error}</p>
      {/if}

      <!-- Overview counts. Three thread-scoped numbers (substrate,
           fires, total samskaras) + three corpus-wide (total /
           tier-1 / tier-2 / associations) so you can see at a glance
           whether the pipeline is producing anything. -->
      <h2 class="pane-section">Overview</h2>
      {#if counts}
        <div class="counts-grid">
          <div class="count-card">
            <div class="count-value">{counts.totalSamskaras}</div>
            <div class="count-label">Samskaras (total)</div>
            <div class="count-sub">
              tier 1: {counts.tier1Samskaras} · tier 2: {counts.tier2Samskaras}
            </div>
          </div>
          <div class="count-card">
            <div class="count-value">{counts.associations}</div>
            <div class="count-label">Pair associations</div>
          </div>
          <div class="count-card">
            <div class="count-value">{counts.substrateInThread}</div>
            <div class="count-label">Substrate in this chat</div>
          </div>
          <div class="count-card">
            <div class="count-value">{counts.firesInThread}</div>
            <div class="count-label">Fires in this chat</div>
            <div class="count-sub">
              {cohortGroups.length} cohort{cohortGroups.length === 1 ? '' : 's'}
            </div>
          </div>
        </div>
      {:else if !error}
        <p class="subtle">Loading counts…</p>
      {/if}

      <!-- Mood-pill legend. Renders the (valence x confidence) lookup
           the toast pill reads at mint time, sourced directly from
           MOOD_TABLE so the legend can never drift from the live
           mapping. The current pill position is overlaid as a
           glowing red dot on the matching cell, read from the shared
           moodState so the dot can never drift from the pill the
           user clicked to open us. Wrapped in <details> so the user
           can fold it once they've internalised the axes - the
           cohort-fires section below it can be tall on a busy
           thread. Defaults to open because clicking the pill is
           the moment the "what does that emoji mean?" question is
           likeliest. -->
      <details class="mood-legend" open>
        <summary class="mood-legend-summary">
          What controls the "mood"?
        </summary>
        <p class="mood-legend-blurb">
          Each samskara carries a <strong>valence</strong> [-1, 1]
          (warm/cool) and a <strong>confidence</strong> [0, 1]. The
          pill picks the matching cell below; columns split on
          confidence at {CONFIDENCE_CUT}. The
          <span class="mood-dot-inline" aria-hidden="true"></span>
          dot marks where the pill currently sits.
        </p>
        <div class="mood-legend-table-wrap">
          <table class="mood-legend-table">
            <thead>
              <tr>
                <th class="mood-axis-y" scope="col">
                  <span class="mood-axis-label">valence</span>
                </th>
                <th scope="col">
                  confident
                  <span class="mood-axis-sub">conf &ge; {CONFIDENCE_CUT}</span>
                </th>
                <th scope="col">
                  tentative
                  <span class="mood-axis-sub">conf &lt; {CONFIDENCE_CUT}</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {#each MOOD_TABLE as row, i (i)}
                <tr>
                  <th scope="row" class="mood-row-label">
                    <span class="mood-row-name">{row.confidentLabel}</span>
                    <span class="mood-row-range">
                      {#if i === 0}
                        v &ge; {row.valenceMin}
                      {:else if row.valenceMin === -Infinity}
                        v &lt; {MOOD_TABLE[i - 1].valenceMin}
                      {:else}
                        {row.valenceMin} &le; v &lt; {MOOD_TABLE[i - 1].valenceMin}
                      {/if}
                    </span>
                  </th>
                  <td class="mood-cell">
                    <span class="mood-glyph" aria-hidden="true">{row.confidentEmoji}</span>
                    <span class="mood-cell-label">{row.confidentLabel}</span>
                    {#if currentCell && currentCell.row === i && currentCell.column === 'confident'}
                      <span
                        class="mood-dot"
                        aria-label={`Pill currently here: ${row.confidentLabel}, confidence ${(moodState.current?.confidence ?? 0).toFixed(2)}, valence ${(moodState.current?.valence ?? 0).toFixed(2)}`}
                      ></span>
                    {/if}
                  </td>
                  <td class="mood-cell">
                    <span class="mood-glyph" aria-hidden="true">{row.tentativeEmoji}</span>
                    <span class="mood-cell-label">{row.tentativeLabel}</span>
                    {#if currentCell && currentCell.row === i && currentCell.column === 'tentative'}
                      <span
                        class="mood-dot"
                        aria-label={`Pill currently here: ${row.tentativeLabel}, confidence ${(moodState.current?.confidence ?? 0).toFixed(2)}, valence ${(moodState.current?.valence ?? 0).toFixed(2)}`}
                      ></span>
                    {/if}
                  </td>
                </tr>
              {/each}
            </tbody>
          </table>
        </div>
        {#if currentCell && moodState.current}
          <p class="mood-legend-current subtle">
            Currently at valence {moodState.current.valence.toFixed(2)},
            confidence {moodState.current.confidence.toFixed(2)} -
            tier {moodState.current.tier}.
          </p>
        {:else}
          <p class="mood-legend-current subtle">
            No current mood reading - the pill is on its 💤 placeholder
            because nothing has fired or been minted on this thread yet.
          </p>
        {/if}
        <p class="mood-legend-foot subtle">
          Glyph collisions are intentional - the slight smile shows up
          for both confident "content" and tentative "cheerful"
          because the emoji vocabulary thins out fast on the warm
          side. Hover the pill itself for the disambiguating label.
        </p>
      </details>

      <!-- Compound summary: the prose block always injected. Shows
           what the model actually sees as its predictive-self model
           this session. Stale / empty cases rendered explicitly so
           "nothing shown" reads as data rather than a bug. -->
      <h2 class="pane-section">Compound summary (always on in system prompt)</h2>
      {#if compound === null && !loading && !error}
        <p class="subtle">No compound summary yet - the worker builds one once you have ~5 samskaras.</p>
      {:else if compound}
        {#if compound.summary}
          <div class="compound-block">
            <pre class="compound-text">{compound.summary}</pre>
            <p class="subtle compound-meta">
              Covers {compound.samskaraCountAtRegen} samskara{compound.samskaraCountAtRegen === 1 ? '' : 's'} ·
              regenerated {formatRelative(compound.lastRegenAt)}
            </p>
          </div>
        {:else}
          <p class="subtle">Summary row exists but is empty. Worker hasn't written yet.</p>
        {/if}
      {/if}

      <!-- Cohort fires for this thread. Each card is one cohort (one
           turn's worth of fired predictions). Default view collapses
           the per-cohort fire list into themed clusters by cosine
           similarity of the underlying samskara prediction embeddings
           (RPC samskara_cluster_thread_fires; threshold from the
           live slider, default 0.7). Each theme shows its highest-
           scoring representative; siblings are tucked behind a
           "+N similar" chevron. A per-cohort "Show all" toggle
           bypasses clustering for the diagnostic case. Resolution
           state still reads from the header pill - the abstraction
           only affects density, not the underlying data. -->
      <div class="cohort-section-head">
        <h2 class="pane-section cohort-section-title">
          Cohort fires {threadId ? 'in this chat' : '(no chat selected)'}
        </h2>
        {#if threadId && cohortGroups.length > 0}
          <!-- Threshold slider. Step 0.05 keeps the input snappy
               (each step is one RPC) while still spanning the useful
               range from "near-duplicate only" (0.95) down to
               "loosely related" (0.50). The label shows the live
               value and dims while a re-cluster is in flight so the
               user has feedback that the dial took effect. -->
          <label class="cluster-slider">
            <span class="cluster-slider-label">
              theme threshold
              <span
                class="cluster-slider-value"
                class:reclustering={clusterReclustering}
              >
                {clusterThreshold.toFixed(2)}
              </span>
            </span>
            <input
              type="range"
              min="0.5"
              max="0.95"
              step="0.05"
              value={clusterThreshold}
              oninput={onThresholdInput}
              aria-label="Cosine-similarity threshold for theme clustering"
              title="Lower = fewer, broader themes. Higher = more, tighter themes."
            />
          </label>
        {/if}
      </div>
      {#if !threadId}
        <p class="subtle">Open a conversation to see fires scoped to it.</p>
      {:else if cohortGroups.length === 0 && !loading}
        <p class="subtle">
          No samskaras have fired in this chat yet. Cohorts will appear
          here as the conversation progresses and the worker has
          something to predict against.
        </p>
      {:else}
        <ul class="cohort-list">
          {#each cohortGroups as group (group.cohortId)}
            {@const isRaw = rawCohorts.has(group.cohortId)}
            {@const collapsed = group.clusters.length < group.fires.length}
            <li class="cohort-card">
              <header class="cohort-head">
                <span class="cohort-time">{formatRelative(group.firedAt)}</span>
                <span class="cohort-status status-{group.wasConfirmed === true ? 'confirm' : group.wasConfirmed === false ? 'disconfirm' : 'pending'}">
                  {resolutionLabel(group.wasConfirmed, group.firedAt)}
                </span>
                <span class="cohort-count">
                  {#if collapsed && !isRaw}
                    {group.clusters.length} theme{group.clusters.length === 1 ? '' : 's'}
                    from {group.fires.length} prediction{group.fires.length === 1 ? '' : 's'}
                  {:else}
                    {group.fires.length} prediction{group.fires.length === 1 ? '' : 's'}
                  {/if}
                </span>
                {#if collapsed}
                  <button
                    type="button"
                    class="raw-toggle"
                    onclick={() => toggleRaw(group.cohortId)}
                    title={isRaw
                      ? 'Re-collapse this cohort by theme'
                      : 'Bypass clustering and show every fire individually'}
                  >
                    {isRaw ? 'Group by theme' : 'Show all'}
                  </button>
                {/if}
              </header>
              {#if isRaw}
                <ul class="fire-list">
                  {#each group.fires as fire (fire.id)}
                    <li class="fire-row">
                      {@render fireRow(fire)}
                    </li>
                  {/each}
                </ul>
              {:else}
                <ul class="fire-list">
                  {#each group.clusters as cluster (cluster.seq)}
                    {@const expanded = expandedClusters.has(clusterKey(group.cohortId, cluster.seq))}
                    <li class="fire-row">
                      {@render fireRow(cluster.representative)}
                      {#if cluster.siblings.length > 0}
                        <button
                          type="button"
                          class="cluster-chip"
                          aria-expanded={expanded}
                          onclick={() => toggleCluster(group.cohortId, cluster.seq)}
                          title="Other predictions that fired in this cohort with cosine ≥ 0.85 to the representative"
                        >
                          <span class="cluster-chip-mark" aria-hidden="true">{expanded ? '−' : '+'}</span>
                          {cluster.siblings.length} similar
                        </button>
                        {#if expanded}
                          <ul class="sibling-list">
                            {#each cluster.siblings as sibling (sibling.id)}
                              <li class="sibling-row">
                                {@render fireRow(sibling)}
                              </li>
                            {/each}
                          </ul>
                        {/if}
                      {/if}
                    </li>
                  {/each}
                </ul>
              {/if}
            </li>
          {/each}
        </ul>
      {/if}

      {#snippet fireRow(fire: SamskaraFireDiagnosticRow)}
        <div class="fire-head">
          <span class="fire-tier">T{fire.samskara?.tier ?? '?'}</span>
          <span class="fire-score" title="cosine * sqrt(health * confidence)">
            score {fire.score.toFixed(3)}
          </span>
          {#if fire.samskara}
            <span class="fire-meta">
              val {formatValence(fire.samskara.valence)} ·
              conf {fire.samskara.confidence.toFixed(2)} ·
              health {fire.samskara.health.toFixed(2)}
            </span>
          {:else}
            <span class="fire-meta subtle">samskara deleted since fire</span>
          {/if}
        </div>
        {#if fire.samskara}
          <p class="fire-prediction">{fire.samskara.prediction}</p>
          {#if fire.samskara.innerVoice}
            <p class="fire-inner-voice">
              <em>{fire.samskara.innerVoice}</em>
            </p>
          {/if}
        {/if}
      {/snippet}

      <!-- Substrate: per-turn rows recorded at end-of-round. Shown
           with their lifecycle state (pending assimilation / pending
           embed / fully baked) so you can see the enrichment
           pipeline walking forward behind the chat. -->
      <h2 class="pane-section">
        Substrate {threadId ? 'in this chat' : '(no chat selected)'}
      </h2>
      {#if !threadId}
        <p class="subtle">Open a conversation to see its substrate.</p>
      {:else if substrate.length === 0 && !loading}
        <p class="subtle">
          No substrate recorded for this chat yet. New rows are stubbed
          at the end of every assistant turn and enriched by the
          background worker shortly after.
        </p>
      {:else}
        <ul class="substrate-list">
          {#each substrate as row (row.id)}
            <li class="substrate-card">
              <header class="substrate-head">
                <span class="substrate-time">{formatRelative(row.createdAt)}</span>
                <span class="substrate-status status-{row.situation === null ? 'pending' : row.embeddingModel === null ? 'partial' : 'done'}">
                  {assimilationStatus(row)}
                </span>
                {#if row.valence !== null}
                  <span class="substrate-meta">valence {formatValence(row.valence)}</span>
                {/if}
              </header>
              {#if row.situation}
                <p class="substrate-situation">{row.situation}</p>
              {/if}
              {#if row.outcome}
                <p class="substrate-outcome subtle"><em>Outcome:</em> {row.outcome}</p>
              {/if}
            </li>
          {/each}
        </ul>
      {/if}
    </section>
  </div>
</div>

<style>
  .samskara-backdrop {
    position: fixed;
    inset: 0;
    background: color-mix(in srgb, #000 50%, transparent);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 50;
    padding: 1rem;
  }

  .samskara-shell {
    position: relative;
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 12px;
    box-shadow: var(--shadow-modal);
    width: 100%;
    max-width: 52rem;
    display: grid;
    grid-template-rows: auto 1fr;
    height: min(44rem, 88vh);
    overflow: hidden;
  }

  .samskara-close {
    position: absolute;
    top: 0.5rem;
    right: 0.5rem;
    z-index: 2;
    width: 2rem;
    height: 2rem;
    padding: 0;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    font-size: 1.4rem;
    line-height: 1;
    background: var(--surface);
    color: var(--text);
    border: 1px solid var(--border);
    border-radius: 50%;
    cursor: pointer;
  }

  .samskara-close:hover {
    background: var(--bg-2);
  }

  .samskara-header {
    padding: 1rem 1.25rem 0.75rem;
    border-bottom: 1px solid var(--border);
    background: var(--bg-2);
    /* Grid items default to min-width: auto, which lets a non-shrinking
       child (the toolbar's flex row, see below) push the header wider
       than the shell's track. The shell has overflow: hidden, so any
       overshoot manifests as the blurb and the "Consolidate"
       button getting clipped at the right edge on narrow viewports.
       Allow the header to shrink to its track. */
    min-width: 0;
  }

  .samskara-title {
    font-size: 1.1rem;
    margin: 0 0 0.25rem;
    /* Only the title row vertically overlaps the absolute-positioned
       close button (top: 0.5rem, height: 2rem, so it sits between
       0.5rem and 2.5rem from the shell top). The blurb and toolbar
       fall below the close button and can use the full header width,
       so the gutter goes here rather than on the header. */
    padding-right: 3rem;
  }

  .samskara-blurb {
    margin: 0 0 0.6rem;
    font-size: 0.85rem;
  }

  .samskara-toolbar {
    display: flex;
    gap: 0.4rem;
    align-items: center;
    /* The three icon buttons fit inside any reasonable viewport, but
       a long status message (e.g. "Consolidated 20") still needs a
       wrap target. row-gap is tighter than column gap because wrapped
       rows don't need as much air. */
    flex-wrap: wrap;
    row-gap: 0.3rem;
  }

  /* Compact icon button used in the diagnostics toolbar. Slightly
     tighter than the global .icon-btn so three of them plus a status
     line still feel like a unit instead of a stripe of chrome. */
  .samskara-icon-btn {
    width: 1.9rem;
    height: 1.9rem;
    padding: 0.35rem;
    color: var(--text);
  }
  .samskara-icon-btn:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }
  .samskara-icon-btn .icon {
    display: block;
  }

  /* Spin while a long-running action is in flight - applied to the
     refresh icon during a fetch and the consolidate icon during the
     RPC. Reduced-motion users see the disabled-button opacity drop
     plus the status text and lose nothing. */
  @keyframes samskara-icon-spin {
    to {
      transform: rotate(360deg);
    }
  }
  .icon-spinning {
    animation: samskara-icon-spin 1s linear infinite;
    transform-origin: 50% 50%;
  }
  @media (prefers-reduced-motion: reduce) {
    .icon-spinning {
      animation: none;
    }
  }

  /* Companion status string for the icon bar. Kept out of the layout
     when there's nothing to say (max-width:0 + no padding) so the bar
     stays the width of just the icons; fades in once a message is
     available. aria-live on the element itself means screen readers
     hear "Copied!" / "Consolidated 5" without us refocusing anything. */
  .samskara-toolbar-status {
    font-size: 0.78rem;
    color: var(--muted);
    margin-left: 0.2rem;
    opacity: 0;
    max-width: 0;
    overflow: hidden;
    white-space: nowrap;
    transition: opacity 160ms ease, max-width 160ms ease;
  }
  .samskara-toolbar-status.visible {
    opacity: 1;
    max-width: 16rem;
  }

  .samskara-body {
    padding: 1rem 1.25rem 1.5rem;
    overflow-y: auto;
    min-width: 0;
    font-size: 0.9rem;
  }

  .pane-section {
    font-size: 0.78rem;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: var(--muted);
    margin: 1.2rem 0 0.5rem;
  }
  .pane-section:first-child {
    margin-top: 0;
  }

  .counts-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(10rem, 1fr));
    gap: 0.6rem;
  }

  /* Mood-pill legend. Sits just under the Overview counts because the
     click-the-pill -> open-this-modal flow is where the user is most
     likely asking "what did that emoji mean." <details>/<summary>
     gives us native dismiss-and-remember behaviour without component
     state. margin-top puts a clear gutter between this card and the
     counts-grid above so the section reads as its own block, not as
     an appendix to Overview. */
  .mood-legend {
    border: 1px solid var(--border);
    border-radius: var(--radius);
    background: var(--surface);
    padding: 0.5rem 0.75rem;
    margin-top: 1.2rem;
    margin-bottom: 1rem;
  }

  .mood-legend-summary {
    cursor: pointer;
    font-size: 0.78rem;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: var(--muted);
    /* Native disclosure marker stays - readers expect the triangle
       to telegraph "this folds." Intrinsic contents render with the
       summary's font so summary-padding aligns with body-padding. */
    padding: 0.1rem 0;
    user-select: none;
  }

  .mood-legend-summary:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 2px;
    border-radius: 2px;
  }

  .mood-legend-blurb {
    margin: 0.6rem 0 0.4rem;
    font-size: 0.85rem;
    line-height: 1.45;
  }

  /* Wrap the table so it can scroll horizontally on very narrow
     viewports rather than overflowing the modal shell. min-width
     keeps the cells readable - shrinking below this just turns the
     table into hieroglyphics. */
  .mood-legend-table-wrap {
    overflow-x: auto;
  }

  .mood-legend-table {
    width: 100%;
    min-width: 22rem;
    border-collapse: collapse;
    font-size: 0.85rem;
  }

  .mood-legend-table th,
  .mood-legend-table td {
    border: 1px solid var(--border);
    padding: 0.4rem 0.55rem;
    text-align: center;
    vertical-align: middle;
  }

  .mood-legend-table thead th {
    background: var(--bg-2);
    font-weight: 600;
    font-size: 0.78rem;
    color: var(--muted);
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }

  /* The top-left axis cell carries the y-axis label ("valence")
     while the column headers carry the x-axis split. Two scope=col
     headers + scope=row on the per-row band names give screen
     readers a sensible reading order without an explicit caption. */
  .mood-axis-y {
    text-align: left;
  }

  .mood-axis-label {
    display: inline-block;
    font-style: italic;
    text-transform: none;
    letter-spacing: 0;
    color: var(--muted);
  }

  .mood-axis-sub {
    display: block;
    font-size: 0.7rem;
    font-weight: 400;
    text-transform: none;
    letter-spacing: 0;
    color: var(--muted);
    margin-top: 0.1rem;
  }

  .mood-row-label {
    text-align: left;
    background: var(--bg-2);
  }

  .mood-row-name {
    display: block;
    font-weight: 600;
  }

  .mood-row-range {
    display: block;
    font-size: 0.72rem;
    font-weight: 400;
    color: var(--muted);
    margin-top: 0.1rem;
    /* Math notation can break across the cell awkwardly on narrow
       columns; nowrap keeps each range on one line. The wrapping
       table-wrap above handles overflow at the table level. */
    white-space: nowrap;
  }

  .mood-cell {
    /* Stack the glyph above its label so the emoji reads as the
       primary content and the disambiguating word as a caption.
       position:relative anchors the absolutely-positioned
       .mood-dot when the current pill lands in this cell. */
    line-height: 1.2;
    position: relative;
  }

  /* "You are here" dot. Absolutely positioned in the top-right
     corner of whichever .mood-cell currently matches the pill's
     (valence, confidence). Solid red with a soft red glow so it
     reads instantly against any cell color in either theme; the
     `pulse` keyframe gives a subtle breathing animation so the
     dot is noticed without being demanding. Reduced-motion
     respects users who don't want the pulse. */
  .mood-dot {
    position: absolute;
    top: 0.3rem;
    right: 0.3rem;
    width: 0.6rem;
    height: 0.6rem;
    border-radius: 50%;
    background: #ef4444;
    box-shadow:
      0 0 0 2px color-mix(in srgb, #ef4444 35%, transparent),
      0 0 8px 2px color-mix(in srgb, #ef4444 55%, transparent);
    pointer-events: none;
    animation: mood-dot-pulse 2.4s ease-in-out infinite;
  }

  @keyframes mood-dot-pulse {
    0%,
    100% {
      box-shadow:
        0 0 0 2px color-mix(in srgb, #ef4444 35%, transparent),
        0 0 6px 1px color-mix(in srgb, #ef4444 45%, transparent);
    }
    50% {
      box-shadow:
        0 0 0 3px color-mix(in srgb, #ef4444 45%, transparent),
        0 0 10px 3px color-mix(in srgb, #ef4444 70%, transparent);
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .mood-dot {
      animation: none;
    }
  }

  /* Inline dot used in the legend blurb so the prose can refer to
     "the [dot] dot" without leaving the reader to guess which
     visual we mean. Static (no pulse) since the moving dot is
     already in the table; shape and color match exactly. */
  .mood-dot-inline {
    display: inline-block;
    width: 0.55rem;
    height: 0.55rem;
    border-radius: 50%;
    background: #ef4444;
    box-shadow:
      0 0 0 2px color-mix(in srgb, #ef4444 30%, transparent),
      0 0 4px 1px color-mix(in srgb, #ef4444 45%, transparent);
    /* Nudge to optical-center against the surrounding text. */
    vertical-align: -0.05em;
    margin: 0 0.15rem;
  }

  .mood-legend-current {
    margin: 0.5rem 0 0;
    font-size: 0.78rem;
    line-height: 1.45;
  }

  .mood-glyph {
    display: block;
    font-size: 1.6rem;
    line-height: 1.1;
    /* Same font-family hint as the toast pill - older Android
       WebView's default cascade can miss the system emoji font. */
    font-family: 'Apple Color Emoji', 'Segoe UI Emoji', 'Noto Color Emoji', sans-serif;
  }

  .mood-cell-label {
    display: block;
    font-size: 0.75rem;
    color: var(--muted);
    margin-top: 0.1rem;
  }

  .mood-legend-foot {
    margin: 0.5rem 0 0;
    font-size: 0.78rem;
    line-height: 1.45;
  }

  .count-card {
    border: 1px solid var(--border);
    border-radius: var(--radius);
    background: var(--surface);
    padding: 0.6rem 0.75rem;
  }

  .count-value {
    font-size: 1.3rem;
    font-weight: 600;
  }

  .count-label {
    font-size: 0.78rem;
    color: var(--muted);
    margin-top: 0.2rem;
  }

  .count-sub {
    font-size: 0.72rem;
    color: var(--muted);
    margin-top: 0.15rem;
  }

  .compound-block {
    border: 1px solid var(--border);
    border-radius: var(--radius);
    background: var(--surface);
    padding: 0.6rem 0.75rem;
  }

  .compound-text {
    margin: 0;
    white-space: pre-wrap;
    word-break: break-word;
    font-family: inherit;
    font-size: 0.88rem;
    line-height: 1.45;
  }

  .compound-meta {
    margin: 0.5rem 0 0;
    font-size: 0.75rem;
  }

  .cohort-list,
  .fire-list,
  .substrate-list {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 0.6rem;
  }

  .fire-list {
    gap: 0.35rem;
    margin-top: 0.5rem;
  }

  .cohort-card,
  .substrate-card {
    border: 1px solid var(--border);
    border-radius: var(--radius);
    background: var(--surface);
    padding: 0.6rem 0.75rem;
  }

  .cohort-head,
  .substrate-head {
    display: flex;
    align-items: center;
    gap: 0.6rem;
    flex-wrap: wrap;
    font-size: 0.78rem;
  }

  .cohort-time,
  .substrate-time {
    color: var(--muted);
    font-variant-numeric: tabular-nums;
  }

  .cohort-count {
    color: var(--muted);
    margin-left: auto;
  }

  /* Status pills. Colors echo the log-level badges (green-ish accent
     for good, warm red for bad, muted for in-progress / stale) so
     users reading both panels pick up the vocabulary by osmosis. */
  .cohort-status,
  .substrate-status {
    font-size: 0.7rem;
    font-weight: 600;
    padding: 0 0.4rem;
    border-radius: 2px;
    letter-spacing: 0.03em;
  }
  .status-confirm {
    background: color-mix(in srgb, var(--accent) 20%, transparent);
    color: var(--accent);
  }
  .status-disconfirm {
    background: color-mix(in srgb, #d14343 22%, transparent);
    color: #d14343;
  }
  .status-pending {
    background: color-mix(in srgb, #d89614 22%, transparent);
    color: #d89614;
  }
  .status-partial {
    background: color-mix(in srgb, #d89614 18%, transparent);
    color: #d89614;
  }
  .status-done {
    background: color-mix(in srgb, var(--accent) 18%, transparent);
    color: var(--accent);
  }

  .fire-row {
    border-top: 1px dashed color-mix(in srgb, var(--border) 70%, transparent);
    padding-top: 0.35rem;
  }
  .fire-row:first-child {
    border-top: 0;
    padding-top: 0;
  }

  .fire-head {
    display: flex;
    gap: 0.5rem;
    align-items: baseline;
    flex-wrap: wrap;
    font-size: 0.75rem;
  }

  .fire-tier {
    font-weight: 600;
    color: var(--accent);
  }

  .fire-score {
    font-variant-numeric: tabular-nums;
    color: var(--muted);
  }

  .fire-meta {
    font-size: 0.72rem;
    color: var(--muted);
    font-variant-numeric: tabular-nums;
  }

  .fire-prediction {
    margin: 0.25rem 0 0;
    font-size: 0.85rem;
    line-height: 1.4;
  }

  .fire-inner-voice {
    margin: 0.15rem 0 0;
    font-size: 0.8rem;
    color: var(--muted);
  }

  /* Cohort-fires section header carries the H2 plus the threshold
     slider. Flex row lets the slider shove right against the gutter
     on desktop and wrap below the title on narrow viewports. The
     margin-top sits on this wrapper rather than the H2 because flex
     containers don't collapse margins with the previous element -
     leaving the H2's own margin-top inside a flex parent reads as
     "nearly touching" the prior section. The H2 inside has its
     pane-section top margin zeroed so the spacing isn't doubled. */
  .cohort-section-head {
    display: flex;
    align-items: baseline;
    gap: 0.75rem;
    flex-wrap: wrap;
    margin-top: 1.2rem;
  }
  .cohort-section-title {
    margin-top: 0;
    margin-right: auto;
  }
  .cluster-slider {
    display: inline-flex;
    flex-direction: column;
    gap: 0.15rem;
    font-size: 0.72rem;
    color: var(--muted);
    cursor: pointer;
  }
  .cluster-slider-label {
    display: flex;
    align-items: baseline;
    gap: 0.4rem;
  }
  .cluster-slider-value {
    font-variant-numeric: tabular-nums;
    color: var(--accent);
    font-weight: 600;
    transition: opacity 120ms;
  }
  .cluster-slider-value.reclustering {
    /* Half-fade while the RPC for the new threshold is in flight, so
       the user has a visible "the dial took effect, waiting" signal
       rather than wondering whether the slider hooked up. */
    opacity: 0.5;
  }
  .cluster-slider input[type='range'] {
    width: 11rem;
    accent-color: var(--accent);
    cursor: pointer;
  }

  /* Per-cohort "Show all" / "Group by theme" pivot. Sits at the right
     edge of the cohort header, after the count, so the cohort-count's
     `margin-left: auto` still pushes both elements to the right. Kept
     small and quiet because it's an escape hatch, not the primary
     control. */
  .raw-toggle {
    appearance: none;
    background: transparent;
    border: 1px solid var(--border);
    color: var(--muted);
    border-radius: 2px;
    font-size: 0.7rem;
    padding: 0.05rem 0.4rem;
    cursor: pointer;
    line-height: 1.4;
  }
  .raw-toggle:hover {
    color: var(--accent);
    border-color: var(--accent);
  }

  /* Cluster-expand chip. Sits below the representative's prediction
     so the eye reads "this prediction" then "+N similar" as a
     second-tier signal. Same surface tone as the cohort status pills
     so the visual vocabulary stays consistent. */
  .cluster-chip {
    appearance: none;
    background: color-mix(in srgb, var(--accent) 12%, transparent);
    color: var(--accent);
    border: 0;
    border-radius: 2px;
    font-size: 0.7rem;
    font-weight: 600;
    padding: 0.05rem 0.45rem;
    margin-top: 0.3rem;
    cursor: pointer;
    letter-spacing: 0.02em;
    display: inline-flex;
    align-items: center;
    gap: 0.3rem;
  }
  .cluster-chip:hover {
    background: color-mix(in srgb, var(--accent) 22%, transparent);
  }
  .cluster-chip-mark {
    font-family: var(--font-mono, monospace);
    font-size: 0.85rem;
    line-height: 1;
  }

  /* Sibling list inside an expanded cluster. Indented + slightly
     dimmed so siblings read as subordinate to the representative
     above. Their per-row markup is the same as the representative
     (same fire-head / fire-prediction / fire-inner-voice) so the
     reader doesn't have to context-switch when expanding a cluster. */
  .sibling-list {
    list-style: none;
    margin: 0.4rem 0 0;
    padding: 0 0 0 0.75rem;
    border-left: 2px solid color-mix(in srgb, var(--border) 70%, transparent);
    display: flex;
    flex-direction: column;
    gap: 0.35rem;
  }
  .sibling-row {
    opacity: 0.85;
  }

  .substrate-situation {
    margin: 0.3rem 0 0;
    font-size: 0.85rem;
    line-height: 1.4;
  }

  .substrate-outcome {
    margin: 0.2rem 0 0;
    font-size: 0.8rem;
    line-height: 1.4;
  }

  /* Mobile: claw back the gutter the desktop layout was happy to spend
     so the diagnostic body actually has room for stat cards and long
     substrate / fire entries. Mirrors the pattern in Journal.svelte -
     tighten the backdrop padding and the per-pane paddings instead of
     letting the modal stay 1rem-inset on a 360px screen. */
  @media (max-width: 720px) {
    .samskara-backdrop {
      padding: 0.5rem;
    }
    .samskara-header {
      padding: 0.75rem 0.85rem 0.6rem;
    }
    .samskara-title {
      padding-right: 2.75rem;
    }
    .samskara-body {
      padding: 0.85rem 0.85rem 1.25rem;
    }
    .count-card,
    .compound-block,
    .cohort-card,
    .substrate-card {
      padding: 0.5rem 0.6rem;
    }
    /* Drop the auto-fit minimum so two narrow stat cards fit on a row
       instead of stacking 1-up; minmax(7rem, 1fr) still keeps the
       value+label legible at small sizes. */
    .counts-grid {
      grid-template-columns: repeat(auto-fit, minmax(7rem, 1fr));
    }
  }
</style>
