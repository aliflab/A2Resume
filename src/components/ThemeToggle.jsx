import { useSyncExternalStore } from 'react';

import Icon from './Icon.jsx';
import { getTheme, setTheme, subscribeTheme, THEME_LABELS, THEMES } from '../services/themeService.js';

const ICONS = { system: 'device', light: 'sun', dim: 'dim', dark: 'moon' };

/**
 * System / Light / Dim / Dark, as a segmented radio group in the header.
 *
 * Real radio inputs, visually hidden, so arrow keys move between options and
 * a screen reader announces "Colour theme, Dim, 3 of 4" with no ARIA to
 * maintain. The icons are decorative; each option's name is in the label.
 */
export default function ThemeToggle() {
  const theme = useSyncExternalStore(subscribeTheme, getTheme);

  return (
    <fieldset className="theme-toggle">
      <legend className="visually-hidden">Colour theme</legend>
      {THEMES.map((id) => (
        <label key={id} className="theme-toggle__option" title={`${THEME_LABELS[id]} theme`}>
          <input
            type="radio"
            name="a2resume-theme"
            value={id}
            checked={theme === id}
            onChange={() => setTheme(id)}
            className="visually-hidden"
          />
          <Icon name={ICONS[id]} size={15} />
          <span className="visually-hidden">{THEME_LABELS[id]}</span>
        </label>
      ))}
    </fieldset>
  );
}
