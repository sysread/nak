<!--
  "A new version is available — reload" pill. Pinned to the top-right
  of the viewport, visible across every phase (setup / locked /
  unlocked) so the prompt can't hide behind a modal. Only renders when
  `updateState.available` is true — so in a fresh session there's zero
  visual footprint until the service worker surfaces a waiting build.

  The Reload button calls `applyUpdate()`, which posts SKIP_WAITING to
  the waiting SW and reloads. Between the click and the page swap the
  banner shows "Reloading…" so a double-click doesn't look like
  nothing happened; we don't guard against the double-post since
  SKIP_WAITING is idempotent, but the visual beat matters.
-->
<script lang="ts">
  import { updateState, applyUpdate } from '$lib/update.svelte';

  let reloading = $state(false);

  async function onReload(): Promise<void> {
    reloading = true;
    try {
      await applyUpdate();
    } catch {
      // `applyUpdate` itself catches registration-side errors; the
      // only failure mode that reaches here is a rejected
      // `window.location.reload()`, which effectively can't happen.
      // Reset the label so the user can try again.
      reloading = false;
    }
  }
</script>

{#if updateState.available}
  <div class="update-banner" role="status" aria-live="polite">
    <span class="update-banner-text">A new version is available.</span>
    <button
      type="button"
      class="update-banner-btn"
      onclick={onReload}
      disabled={reloading}
    >
      {reloading ? 'Reloading…' : 'Reload'}
    </button>
  </div>
{/if}
