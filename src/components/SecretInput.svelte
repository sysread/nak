<script lang="ts">
  /*
   * Password / secret input with a reveal toggle (eye icon).
   * Used for master password fields and for the three long API keys
   * (where seeing what you pasted is the difference between a working
   * app and a "Supabase rejected the anon key" error).
   *
   * autocomplete is disabled so browsers don't try to autofill the
   * Supabase anon key into a credit-card form somewhere.
   */
  interface Props {
    id: string;
    value: string;
    required?: boolean;
    minlength?: number;
    placeholder?: string;
  }
  let {
    id,
    value = $bindable(''),
    required = false,
    minlength,
    placeholder,
  }: Props = $props();

  let revealed = $state(false);
</script>

<div class="secret-wrap">
  <input
    {id}
    type={revealed ? 'text' : 'password'}
    bind:value
    {required}
    minlength={minlength}
    {placeholder}
    autocomplete="off"
  />
  <button
    type="button"
    class="reveal-btn"
    title={revealed ? 'Hide' : 'Show'}
    aria-label={revealed ? 'Hide value' : 'Show value'}
    aria-pressed={revealed}
    onclick={() => (revealed = !revealed)}
  >
    {#if revealed}
      <!-- eye-off (slashed) -->
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor"
           stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24" />
        <line x1="1" y1="1" x2="23" y2="23" />
      </svg>
    {:else}
      <!-- eye -->
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor"
           stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
        <circle cx="12" cy="12" r="3" />
      </svg>
    {/if}
  </button>
</div>
