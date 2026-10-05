/**
 * The colour theme: a per-browser preference, not part of the session.
 *
 * Stored as `a2resume:theme` through storageService, beside the session rather
 * than inside it, so "Start over" keeps it and it survives with no resume
 * loaded (AppContext's `settings` is only stored when the session has
 * content).
 *
 * Applied as `data-theme` on <html>. "system" removes the attribute, and the
 * stylesheet's `prefers-color-scheme` block takes over, so following the OS
 * needs no JavaScript listener and an OS switch applies live. main.jsx applies
 * the stored preference before React renders, so the first paint of the app
 * is already in the right theme.
 *
 * Never throws: blocked or corrupt storage means "system".
 */
import { get, set } from './storageService.js';

const STORAGE_NAME = 'theme';

export const THEMES = ['system', 'light', 'dim', 'dark'];
export const DEFAULT_THEME = 'system';

export const THEME_LABELS = {
  system: 'System',
  light: 'Light',
  dim: 'Dim',
  dark: 'Dark',
};

export const resolveTheme = (value) => (THEMES.includes(value) ? value : DEFAULT_THEME);

function readStored() {
  try {
    return resolveTheme(get(STORAGE_NAME));
  } catch {
    return DEFAULT_THEME;
  }
}

let current = readStored();
const listeners = new Set();

export function applyTheme(theme) {
  const root = document.documentElement;
  if (theme === 'system') root.removeAttribute('data-theme');
  else root.setAttribute('data-theme', theme);
}

/** Applies the stored preference. Call once, before the first render. */
export function initTheme() {
  applyTheme(current);
}

export const getTheme = () => current;

export function subscribeTheme(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/**
 * Applies the theme even when it cannot be stored: the choice still holds for
 * this page load, it just will not survive a reload.
 */
export function setTheme(value) {
  const theme = resolveTheme(value);
  current = theme;
  applyTheme(theme);
  try {
    set(STORAGE_NAME, theme);
  } catch {
    // Storage blocked or full. Nothing else to do; see above.
  }
  listeners.forEach((listener) => listener());
}
