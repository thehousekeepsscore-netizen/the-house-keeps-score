import { useEffect } from 'react';

export interface ThemeDefinition {
  id: string;
  label: string;
  description: string;
  // Swatch colors for the picker UI — mirrors the palette defined in index.css
  // for this theme, kept here too since the picker needs to render its own
  // previews before the user has actually switched data-theme.
  swatch: { bg: string; surface: string; accent: string; accent2: string };
}

export const THEMES: ThemeDefinition[] = [
  {
    id: 'arctic-bluff',
    label: 'Arctic Bluff',
    description: 'Nordic slate & icy teal',
    swatch: { bg: '#0F172A', surface: '#1E293B', accent: '#2DD4BF', accent2: '#FBBF24' },
  },
  {
    id: 'emerald-gold',
    label: 'Emerald Club',
    description: 'Emerald & antique gold',
    swatch: { bg: '#0A150E', surface: '#0F2116', accent: '#D4AF37', accent2: '#2F9E68' },
  },
  {
    id: 'royal-purple',
    label: 'Royal Purple',
    description: 'Royal purple & platinum',
    swatch: { bg: '#14101F', surface: '#241B36', accent: '#8B5CF6', accent2: '#C7C9D9' },
  },
  {
    id: 'midnight-ruby',
    label: 'Midnight Ruby',
    description: 'Midnight & ruby red',
    swatch: { bg: '#0B0B0F', surface: '#1A1A1F', accent: '#E11D48', accent2: '#D9BE9C' },
  },
  {
    id: 'poker-lounge',
    label: 'Poker Lounge',
    description: 'Light mode',
    swatch: { bg: '#F8FAFC', surface: '#FFFFFF', accent: '#2563EB', accent2: '#D9A441' },
  },
];

export const DEFAULT_THEME_ID = 'emerald-gold';

export function isValidThemeId(id: string | undefined | null): id is string {
  return !!id && THEMES.some((t) => t.id === id);
}

// Applies the given theme (falling back to the default whenever the value
// isn't one of ours, e.g. logged-out screens with no user yet) by setting
// data-theme on <html> — every color in the app is a CSS var keyed off this
// attribute (see index.css), so this one line re-colors the whole page.
export function useApplyTheme(themeId: string | undefined | null) {
  useEffect(() => {
    const id = isValidThemeId(themeId) ? themeId : DEFAULT_THEME_ID;
    document.documentElement.dataset.theme = id;
  }, [themeId]);
}
