<script lang="ts">
  /*
   * Drawer "chapter" header used to separate buckets of rows in the
   * left-rail listings. Each consumer renders one BucketHeader per
   * bucket (Recent / Older in Chat, Upcoming / Favorites / All recipes
   * in RecipeList).
   *
   * Set `flourish` to render the dinkus ornament above the label - two
   * opposing swashes flanking a center dot, the classic book-chapter
   * break. Pass true for every section after the first one and the
   * ornament will sit between the previous section's rows and this
   * header. The first section in a listing should leave `flourish`
   * off so a single-section listing stays clean and so the very top
   * of the listing doesn't open with an ornament.
   *
   * The header element itself keeps the global `.bucket-header` class
   * (defined in styles.css) so spacing / typography stay in lockstep
   * across consumers.
   */
  interface Props {
    label: string;
    flourish?: boolean;
  }
  const { label, flourish = false }: Props = $props();
</script>

{#if flourish}
  <!-- Dinkus. Purely visual; aria-hidden so screen readers skip it
       and just read the header that follows. -->
  <div class="bucket-flourish" aria-hidden="true">
    <svg
      viewBox="0 0 72 12"
      width="60"
      height="10"
      fill="none"
      stroke="currentColor"
      stroke-width="1"
      stroke-linecap="round"
    >
      <path d="M 4 6 Q 14 -2 24 6 T 33 6" />
      <circle cx="36" cy="6" r="1.2" fill="currentColor" stroke="none" />
      <path d="M 39 6 Q 48 14 58 6 T 68 6" />
    </svg>
  </div>
{/if}
<h3 class="bucket-header">{label}</h3>

<style>
  /* Muted so the ornament reads as a divider, not a control. Centered
     with breathing room above and below so the adjacent rows / header
     don't collide with it. */
  .bucket-flourish {
    display: flex;
    justify-content: center;
    align-items: center;
    color: var(--muted);
    opacity: 0.7;
    margin: 0.6rem 0 0.2rem;
    padding: 0 0.55rem;
  }
</style>
