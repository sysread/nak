/**
 * Theme tokens for the app. Two concerns are tracked independently:
 *
 *   colorMode : light | dark | system   (how the background looks)
 *   accent    : blue | green | ... | red  (the tint on buttons, links, etc.)
 *
 * The CSS uses two attributes on <html>:
 *   [data-theme='light' | 'dark']
 *   [data-accent='<accent>']
 *
 * Colors are chosen so each accent has a dark-mode pastel variant AND a
 * light-mode sharp variant — switching modes preserves the "same" color
 * identity. Every accent/mode pairing clears WCAG AA contrast (>= 4.5:1)
 * against its surface.
 */

export type ColorMode = 'light' | 'dark' | 'system';
export type EffectiveMode = 'light' | 'dark';
export type Accent = 'blue' | 'green' | 'purple' | 'orange' | 'red';

export const MODES: readonly ColorMode[] = ['system', 'light', 'dark'];
export const ACCENTS: readonly Accent[] = [
  'blue',
  'green',
  'purple',
  'orange',
  'red',
];

export const DEFAULT_MODE: ColorMode = 'system';
export const DEFAULT_ACCENT: Accent = 'blue';

/** Human labels for UI. */
export const MODE_LABELS: Record<ColorMode, string> = {
  system: 'System',
  light: 'Light',
  dark: 'Dark',
};

export const ACCENT_LABELS: Record<Accent, string> = {
  blue: 'Blue',
  green: 'Green',
  purple: 'Purple',
  orange: 'Orange',
  red: 'Red',
};

/** Per-accent swatch used in the Settings picker (matches --accent). */
export const ACCENT_SWATCHES: Record<Accent, { light: string; dark: string }> = {
  blue: { light: '#1d4ed8', dark: '#8ab4ff' },
  green: { light: '#15803d', dark: '#86efac' },
  purple: { light: '#7e22ce', dark: '#c4b5fd' },
  orange: { light: '#c2410c', dark: '#fdba74' },
  red: { light: '#b91c1c', dark: '#fca5a5' },
};

export function isColorMode(v: unknown): v is ColorMode {
  return v === 'light' || v === 'dark' || v === 'system';
}

export function isAccent(v: unknown): v is Accent {
  return typeof v === 'string' && (ACCENTS as readonly string[]).includes(v);
}

/** Resolve `system` to the actual preferred mode via matchMedia. */
export function effectiveMode(mode: ColorMode): EffectiveMode {
  if (mode === 'light' || mode === 'dark') return mode;
  if (typeof window === 'undefined') return 'dark';
  return window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

/** Write the two data attributes onto <html> so CSS can react. */
export function applyTheme(mode: ColorMode, accent: Accent): void {
  if (typeof document === 'undefined') return;
  const root = document.documentElement;
  root.setAttribute('data-theme', effectiveMode(mode));
  root.setAttribute('data-accent', accent);
}

const CACHE_KEY = 'nak:theme:v1';

/**
 * Cache the user's picked mode+accent locally. Used by the inline boot
 * script in index.html to avoid a flash-of-wrong-theme on next load before
 * Supabase settles. Non-sensitive — just two enum values.
 */
export function cacheTheme(mode: ColorMode, accent: Accent): void {
  try {
    localStorage.setItem(CACHE_KEY, `${mode}|${accent}`);
  } catch {
    // quota / private mode — treat as no-op
  }
}

export function readCachedTheme(): { mode: ColorMode; accent: Accent } | null {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (!raw) return null;
    const [mode, accent] = raw.split('|');
    if (!isColorMode(mode) || !isAccent(accent)) return null;
    return { mode, accent };
  } catch {
    return null;
  }
}

export const __cacheKey = CACHE_KEY;
