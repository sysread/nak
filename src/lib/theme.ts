/**
 * Theme tokens for the app. Three concerns are tracked independently:
 *
 *   colorMode : light | dark | system   (how the background looks)
 *   accent    : blue | green | ... | red  (the tint on buttons, links, etc.)
 *   uiStyle   : soft | terminal         (rounded cards vs. square ANSI look)
 *
 * The CSS uses three attributes on <html>:
 *   [data-theme='light' | 'dark']
 *   [data-accent='<accent>']
 *   [data-style='soft' | 'terminal']
 *
 * Colors are chosen so each accent has a dark-mode pastel variant AND a
 * light-mode sharp variant — switching modes preserves the "same" color
 * identity. Every accent/mode pairing clears WCAG AA contrast (>= 4.5:1)
 * against its surface.
 */

export type ColorMode = 'light' | 'dark' | 'system';
export type EffectiveMode = 'light' | 'dark';
export type Accent = 'blue' | 'green' | 'purple' | 'orange' | 'red';
export type UiStyle = 'soft' | 'terminal';

export const MODES: readonly ColorMode[] = ['system', 'light', 'dark'];
export const STYLES: readonly UiStyle[] = ['soft', 'terminal'];
export const ACCENTS: readonly Accent[] = [
  'blue',
  'green',
  'purple',
  'orange',
  'red',
];

export const DEFAULT_MODE: ColorMode = 'system';
export const DEFAULT_ACCENT: Accent = 'blue';
export const DEFAULT_STYLE: UiStyle = 'soft';

/** Human labels for UI. */
export const MODE_LABELS: Record<ColorMode, string> = {
  system: 'System',
  light: 'Light',
  dark: 'Dark',
};

export const STYLE_LABELS: Record<UiStyle, string> = {
  soft: 'Soft',
  terminal: 'Terminal',
};

/** One-line descriptions under each style option in Settings. */
export const STYLE_DESCRIPTIONS: Record<UiStyle, string> = {
  soft: 'rounded corners and soft shadows',
  terminal: 'square corners, flat ANSI-era panels',
};

export const ACCENT_LABELS: Record<Accent, string> = {
  blue: 'Blue',
  green: 'Green',
  purple: 'Purple',
  orange: 'Orange',
  red: 'Red',
};

/**
 * Per-accent swatch used in the Settings picker, keyed by UI style
 * because each style has its own accent palette (soft pastels/sharps
 * vs. bright/normal ANSI). Values mirror the --accent pairings in
 * styles.css - keep in sync.
 */
export const ACCENT_SWATCHES: Record<
  UiStyle,
  Record<Accent, { light: string; dark: string }>
> = {
  soft: {
    blue: { light: '#1d4ed8', dark: '#8ab4ff' },
    green: { light: '#15803d', dark: '#86efac' },
    purple: { light: '#7e22ce', dark: '#c4b5fd' },
    orange: { light: '#c2410c', dark: '#fdba74' },
    red: { light: '#b91c1c', dark: '#fca5a5' },
  },
  terminal: {
    blue: { light: '#0000cc', dark: '#7a7aff' },
    green: { light: '#007700', dark: '#55ff55' },
    purple: { light: '#9900cc', dark: '#ff66ff' },
    orange: { light: '#b34700', dark: '#ff8700' },
    red: { light: '#cc0000', dark: '#ff5555' },
  },
};

export function isColorMode(v: unknown): v is ColorMode {
  return v === 'light' || v === 'dark' || v === 'system';
}

export function isAccent(v: unknown): v is Accent {
  return typeof v === 'string' && (ACCENTS as readonly string[]).includes(v);
}

export function isUiStyle(v: unknown): v is UiStyle {
  return v === 'soft' || v === 'terminal';
}

/** Resolve `system` to the actual preferred mode via matchMedia. */
export function effectiveMode(mode: ColorMode): EffectiveMode {
  if (mode === 'light' || mode === 'dark') return mode;
  if (typeof window === 'undefined') return 'dark';
  return window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

/** Write the three data attributes onto <html> so CSS can react. */
export function applyTheme(mode: ColorMode, accent: Accent, style: UiStyle): void {
  if (typeof document === 'undefined') return;
  const root = document.documentElement;
  root.setAttribute('data-theme', effectiveMode(mode));
  root.setAttribute('data-accent', accent);
  root.setAttribute('data-style', style);
}

const CACHE_KEY = 'nak:theme:v1';

/**
 * Cache the user's picked mode+accent+style locally. Used by the inline
 * boot script in index.html to avoid a flash-of-wrong-theme on next load
 * before Supabase settles. Non-sensitive — just three enum values.
 */
export function cacheTheme(mode: ColorMode, accent: Accent, style: UiStyle): void {
  try {
    localStorage.setItem(CACHE_KEY, `${mode}|${accent}|${style}`);
  } catch {
    // quota / private mode — treat as no-op
  }
}

export function readCachedTheme(): { mode: ColorMode; accent: Accent; style: UiStyle } | null {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (!raw) return null;
    // Caches written before the style axis existed carry only two
    // fields; treat the missing third as the default rather than
    // discarding the whole cache.
    const [mode, accent, style] = raw.split('|');
    if (!isColorMode(mode) || !isAccent(accent)) return null;
    return { mode, accent, style: isUiStyle(style) ? style : DEFAULT_STYLE };
  } catch {
    return null;
  }
}

export const __cacheKey = CACHE_KEY;
