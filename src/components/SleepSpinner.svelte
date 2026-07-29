<!--
  In-flight cue for the memory librarian's progress strip
  (`src/screens/Memories.svelte`). Three Z's climbing a staircase, with
  a brightness wave travelling up them - the comic-book shorthand for
  sleeping, which is on the nose for a subsystem whose two passes are
  named after sleep stages (deep-sleep for slow-wave, rem for REM).

  The wiki librarian's strip shares the layout but not the conceit and
  keeps `<AsciiSpinner>`; the contrast is load-bearing, since the glyph
  is how you tell at a glance which librarian a strip belongs to.

  Why a travelling wave is legible when the strip's old pulsing
  ellipsis was not: that one modulated one glyph's opacity uniformly,
  so nothing moved and the eye read it as static. Here the bright spot
  changes POSITION, which reads as motion the way marquee bulbs do even
  though no glyph ever changes shape.

  Why CSS keyframes rather than the JS interval `<AsciiSpinner>` uses:
  a three-phase chase is exactly what staggered `animation-delay` is
  for, and it buys two things a timer cannot. The animation never
  mutates the DOM, so the surrounding `aria-live="polite"` region has
  nothing to announce - the failure mode that forces every AsciiSpinner
  call site into an `aria-hidden` wrapper cannot arise here. And
  reduced motion is a live media query rather than a value sampled once
  at mount.

  Marked `aria-hidden` at the root because it is purely decorative:
  the row's text already says what is happening, and "ZZZ" announced
  beside it is noise.
-->
<!-- This block is empty and must stay. The component takes no props and
  holds no state - everything below is static markup driven by CSS - but
  svelte-check cannot synthesise a component declaration for a
  script-less `.svelte` file, so importers fail with "Could not find a
  declaration file for module ... implicitly has an 'any' type". Every
  other component in `src/components/` has a script for real reasons;
  this one has it to stay typed. -->
<script lang="ts"></script>

<span class="sleep-spinner" aria-hidden="true"
  ><span class="z z-low">Z</span><span class="z z-mid">Z</span><span
    class="z z-high">Z</span
  ></span
>

<style>
  .sleep-spinner {
    /* Pinned to the mono stack even though the app body already uses
       it - the 3ch reservation below only holds if the glyphs actually
       advance one cell each, so it must not depend on an ancestor. */
    font-family: var(--font-mono);
    display: inline-block;
    width: 3ch;
    white-space: pre;
  }

  .z {
    display: inline-block;
    width: 1ch;
    /* Uniform font-size across the three, deliberately: sizing them
       into a growing ramp would make each `1ch` a different width
       (ch resolves against the element's OWN font-size) and the trio
       would no longer total the 3ch the parent reserves. */
    font-size: inherit;
  }

  /* The staircase is `transform`, not `vertical-align` or sub/sup
     markup. Transforms do not participate in layout, so the glyphs
     keep their 1ch advance and the line box keeps its height - a
     `<sub>`/`<sup>` pair would shrink the font, change the advance
     width, and grow the row. Kept to 0.15em so the excursion stays
     inside the row's leading and cannot collide with the rows above
     and below.

     The base opacities also ARE the reduced-motion state: brightest at
     the bottom fading as it rises, which reads as dissipating smoke
     while standing still. */
  .z-low {
    transform: translateY(0.15em);
    opacity: 1;
  }

  .z-mid {
    transform: translateY(0);
    opacity: 0.75;
  }

  .z-high {
    transform: translateY(-0.15em);
    opacity: 0.5;
  }

  @media (prefers-reduced-motion: no-preference) {
    .z {
      animation: sleep-chase 1.05s ease-in-out infinite;
    }

    /* Peak brightness must travel UPWARD to match smoke rising, so the
       three peaks want to land a third of a cycle apart in low -> mid
       -> high order.

       The delays are NEGATIVE because a positive delay holds an
       element at its base opacity until the delay elapses, which shows
       as a visible settling-in on the first cycle. A negative delay
       instead starts the animation already that far along, so all
       three are in their correct relative phase on the very first
       frame.

       An element peaks at animation progress 0, so one started `x`
       seconds in next peaks at (duration - x). Wanting peaks at 0,
       D/3 and 2D/3 therefore means offsets of 0, -2D/3 and -D/3 -
       which is why mid's delay looks like it belongs to high. */
    .z-low {
      animation-delay: 0s;
    }

    .z-mid {
      animation-delay: -0.7s;
    }

    .z-high {
      animation-delay: -0.35s;
    }
  }

  /* Opacity against the INHERITED colour, never literal greys: the
     strip hands this element full text contrast on a pending row, and
     the same cascade tints settled rows with the accent or danger
     colour. Hardcoded greys would ignore the active theme and flatten
     dark mode. */
  @keyframes sleep-chase {
    0%,
    100% {
      opacity: 1;
    }

    50% {
      opacity: 0.45;
    }
  }
</style>
