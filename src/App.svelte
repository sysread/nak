<script lang="ts">
  import { onMount } from 'svelte';
  import { app } from '$lib/state.svelte';
  import { hasStoredConfig } from '$lib/config';
  import Setup from './screens/Setup.svelte';
  import Unlock from './screens/Unlock.svelte';
  import Chat from './screens/Chat.svelte';

  onMount(() => {
    app.phase = hasStoredConfig() ? 'locked' : 'setup';
  });
</script>

{#if app.phase === 'loading'}
  <div class="center"><p class="subtle">Loading…</p></div>
{:else if app.phase === 'setup'}
  <Setup />
{:else if app.phase === 'locked'}
  <Unlock />
{:else}
  <Chat />
{/if}
