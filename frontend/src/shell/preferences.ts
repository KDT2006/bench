import { create } from "zustand";
import { persist } from "zustand/middleware";

export type Theme = "system" | "light" | "dark";
type Keymap = "default" | "vim";

interface Preferences {
  theme: Theme;
  keymap: Keymap;
  fontSize: number;
  autosave: boolean;
  setTheme: (theme: Theme) => void;
  setKeymap: (keymap: Keymap) => void;
  setFontSize: (fontSize: number) => void;
  setAutosave: (autosave: boolean) => void;
}

export const usePreferences = create<Preferences>()(persist(
  (set) => ({
    theme: "system",
    keymap: "default",
    fontSize: 13,
    autosave: true,
    setTheme: (theme) => set({ theme }),
    setKeymap: (keymap) => set({ keymap }),
    setFontSize: (fontSize) => set({ fontSize }),
    setAutosave: (autosave) => set({ autosave }),
  }),
  { name: "benchscope-settings", version: 1 },
));
