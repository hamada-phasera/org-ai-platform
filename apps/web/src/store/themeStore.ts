import { create } from 'zustand';
import { persist } from 'zustand/middleware';

type Theme = 'light' | 'dark';

interface ThemeState {
  theme: Theme;
  toggle: () => void;
  setTheme: (t: Theme) => void;
}

function apply(theme: Theme): void {
  const el = document.documentElement;
  el.classList.toggle('dark', theme === 'dark');
  el.style.colorScheme = theme;
}

export const useThemeStore = create<ThemeState>()(
  persist(
    (set, get) => ({
      theme: 'light',
      toggle: () => {
        const next: Theme = get().theme === 'dark' ? 'light' : 'dark';
        apply(next);
        set({ theme: next });
      },
      setTheme: (t) => {
        apply(t);
        set({ theme: t });
      },
    }),
    {
      name: 'theme',
      onRehydrateStorage: () => (state) => {
        if (state) apply(state.theme);
      },
    },
  ),
);
