<!--
  Minimal reproduction of the composer-bar click-outside pattern used in
  Chat.svelte. Exists only for the companion vitest file — lets us test
  the document-listener dismissal logic without mounting Chat.svelte
  (which is too coupled to live app state).
-->
<script lang="ts">
  let promptsMenuOpen = $state(false);
  let modelMenuOpen = $state(false);
  let composerBarEl: HTMLDivElement | undefined = $state();

  function closeMenus(): void {
    promptsMenuOpen = false;
    modelMenuOpen = false;
  }

  function onDocClick(e: MouseEvent): void {
    if (!promptsMenuOpen && !modelMenuOpen) return;
    if (composerBarEl && composerBarEl.contains(e.target as Node)) return;
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
<div class="composer-bar" bind:this={composerBarEl}>
  <button
    data-testid="prompts-toggle"
    onclick={() => {
      modelMenuOpen = false;
      promptsMenuOpen = !promptsMenuOpen;
    }}
  >
    prompts
  </button>
  <button
    data-testid="model-toggle"
    onclick={() => {
      promptsMenuOpen = false;
      modelMenuOpen = !modelMenuOpen;
    }}
  >
    model
  </button>
  {#if promptsMenuOpen}
    <div data-testid="prompts-menu">prompts-menu</div>
  {/if}
  {#if modelMenuOpen}
    <div data-testid="model-menu">model-menu</div>
  {/if}
</div>
