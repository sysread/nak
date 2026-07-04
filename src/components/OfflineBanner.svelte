<script lang="ts">
  /*
   * Connectivity indicator. Renders a fixed, bottom-centered banner
   * whenever the device is offline, naming how many records are saved
   * for offline reading so the user knows what they can still open (and
   * why some write controls are disabled and photos show placeholders).
   * Reads the reactive `offlineStatus` that offline-sync owns; the copy
   * decision lives in the offlineBannerText primitive. Mounted once by
   * Chat.svelte. Fixed-position on purpose so it overlays rather than
   * reflowing the shell's flex layout.
   */
  import { offlineStatus } from '$lib/offline-sync.svelte';
  import { offlineBannerText } from '$lib/ui/offline-status';

  const text = $derived(
    offlineBannerText({
      online: offlineStatus.online,
      articleCount: offlineStatus.articleCount,
      recipeCount: offlineStatus.recipeCount,
    }),
  );
</script>

{#if text}
  <div class="offline-banner" role="status" aria-live="polite">
    <svg
      width="15"
      height="15"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="2"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
    >
      <!-- A cloud with a slash - the conventional "no connection" mark. -->
      <path d="M17.5 19a4.5 4.5 0 0 0 .5-8.96 6 6 0 0 0-10.6-2.3" />
      <path d="M3 3l18 18" />
    </svg>
    <span>{text}</span>
  </div>
{/if}

<style>
  .offline-banner {
    position: fixed;
    left: 50%;
    bottom: 1rem;
    transform: translateX(-50%);
    z-index: 40;
    display: inline-flex;
    align-items: center;
    gap: 0.5rem;
    max-width: min(92vw, 30rem);
    padding: 0.5rem 0.9rem;
    font-size: 0.85rem;
    color: var(--text);
    background: color-mix(in srgb, var(--surface) 94%, transparent);
    border: 1px solid color-mix(in srgb, var(--border) 80%, transparent);
    border-radius: var(--radius-pill);
    box-shadow: 0 4px 14px rgba(0, 0, 0, 0.25);
    backdrop-filter: blur(6px);
    -webkit-backdrop-filter: blur(6px);
  }
  .offline-banner svg {
    flex: none;
    color: var(--danger, #c0392b);
  }
</style>
