<!--
  Minimal reproduction of the composer-bar click-outside pattern used in
  Chat.svelte. Exists only for the companion vitest file — lets us test
  the document-listener dismissal logic without mounting Chat.svelte
  (which is too coupled to live app state).

  "Inside" is the open popover + its trigger, not the whole bar. Empty
  bar filler counts as outside — a click there dismisses.
-->
<script lang="ts">
  let promptsMenuOpen = $state(false);
  let modelMenuOpen = $state(false);

  function closeMenus(): void {
    promptsMenuOpen = false;
    modelMenuOpen = false;
  }

  function onDocClick(e: MouseEvent): void {
    if (!promptsMenuOpen && !modelMenuOpen) return;
    const tgt = e.target;
    if (
      tgt instanceof Element &&
      (tgt.closest('.composer-menu') || tgt.closest('[aria-haspopup="true"]'))
    ) {
      return;
    }
    closeMenus();
  }

  $effect(() => {
    const anyOpen = promptsMenuOpen || modelMenuOpen;
    if (!anyOpen) return;
    document.addEventListener('click', onDocClick);
    return () => {
      document.removeEventListener('click', onDocClick);
    };
  });
</script>

<div data-testid="outside">outside-marker</div>
<div class="composer-bar">
  <button
    data-testid="prompts-toggle"
    aria-haspopup="true"
    onclick={() => {
      modelMenuOpen = false;
      promptsMenuOpen = !promptsMenuOpen;
    }}
  >
    prompts
  </button>
  <button
    data-testid="model-toggle"
    aria-haspopup="true"
    onclick={() => {
      promptsMenuOpen = false;
      modelMenuOpen = !modelMenuOpen;
    }}
  >
    model
  </button>
  <!-- Empty filler inside the bar. Standing in for the gaps between
       the toggle group and the send button where a click should still
       dismiss the popover. -->
  <span data-testid="bar-filler" class="filler">&nbsp;</span>
  {#if promptsMenuOpen}
    <div class="composer-menu" data-testid="prompts-menu">prompts-menu</div>
  {/if}
  {#if modelMenuOpen}
    <div class="composer-menu" data-testid="model-menu">model-menu</div>
  {/if}
</div>
