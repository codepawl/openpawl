import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { PALETTE_IDS, type PaletteId } from "./palettes";

const STORAGE_KEY = "teamclaw-theme";
const PALETTE_STORAGE_KEY = "teamclaw-palette";
const FONT_SIZE_STORAGE_KEY = "teamclaw-font-size";

export type ThemePreference = "light" | "dark" | "system";

const DEFAULT_FONT_SIZE = 15;
const MIN_FONT_SIZE = 10;
const MAX_FONT_SIZE = 24;

function getSystemPrefersDark(): boolean {
  if (typeof window === "undefined") return false;
  return window.matchMedia("(prefers-color-scheme: dark)").matches;
}

function getStoredTheme(): ThemePreference {
  if (typeof window === "undefined") return "system";
  const stored = localStorage.getItem(STORAGE_KEY) as ThemePreference | null;
  if (stored === "light" || stored === "dark" || stored === "system") return stored;
  return "system";
}

function getStoredPalette(): PaletteId {
  if (typeof window === "undefined") return "default";
  const stored = localStorage.getItem(PALETTE_STORAGE_KEY);
  if (stored && (PALETTE_IDS as string[]).includes(stored)) return stored as PaletteId;
  return "default";
}

function resolveIsDark(theme: ThemePreference): boolean {
  if (theme === "dark") return true;
  if (theme === "light") return false;
  return getSystemPrefersDark();
}

function applyDarkClass(isDark: boolean): void {
  if (typeof document === "undefined") return;
  if (isDark) {
    document.documentElement.classList.add("dark");
  } else {
    document.documentElement.classList.remove("dark");
  }
}

function applyPalette(id: PaletteId): void {
  if (typeof document === "undefined") return;
  if (id === "default") {
    delete document.documentElement.dataset.palette;
  } else {
    document.documentElement.dataset.palette = id;
  }
}

function persistTheme(theme: ThemePreference): void {
  if (typeof window === "undefined") return;
  if (theme === "system") {
    localStorage.removeItem(STORAGE_KEY);
  } else {
    localStorage.setItem(STORAGE_KEY, theme);
  }
}

function persistPalette(id: PaletteId): void {
  if (typeof window === "undefined") return;
  if (id === "default") {
    localStorage.removeItem(PALETTE_STORAGE_KEY);
  } else {
    localStorage.setItem(PALETTE_STORAGE_KEY, id);
  }
}

function clampFontSize(px: number): number {
  return Math.max(MIN_FONT_SIZE, Math.min(MAX_FONT_SIZE, Math.round(px)));
}

function getStoredFontSize(): number {
  if (typeof window === "undefined") return DEFAULT_FONT_SIZE;
  const stored = localStorage.getItem(FONT_SIZE_STORAGE_KEY);
  if (stored) {
    const parsed = Number(stored);
    if (!Number.isNaN(parsed)) return clampFontSize(parsed);
  }
  return DEFAULT_FONT_SIZE;
}

function applyFontSize(px: number): void {
  if (typeof document === "undefined") return;
  document.documentElement.style.fontSize = `${px}px`;
}

function persistFontSize(px: number): void {
  if (typeof window === "undefined") return;
  if (px === DEFAULT_FONT_SIZE) {
    localStorage.removeItem(FONT_SIZE_STORAGE_KEY);
  } else {
    localStorage.setItem(FONT_SIZE_STORAGE_KEY, String(px));
  }
}

interface ThemeContextValue {
  theme: ThemePreference;
  isDark: boolean;
  setTheme: (theme: ThemePreference) => void;
  palette: PaletteId;
  setPalette: (id: PaletteId) => void;
  fontSize: number;
  setFontSize: (px: number) => void;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const [theme, setThemeState] = useState<ThemePreference>(getStoredTheme);
  const [isDark, setIsDark] = useState(resolveIsDark(theme));
  const [palette, setPaletteState] = useState<PaletteId>(getStoredPalette);
  const [fontSizeState, setFontSizeState] = useState<number>(getStoredFontSize);

  const setTheme = useCallback((next: ThemePreference) => {
    setThemeState(next);
    const resolved = resolveIsDark(next);
    setIsDark(resolved);
    applyDarkClass(resolved);
    persistTheme(next);
  }, []);

  const setPalette = useCallback((id: PaletteId) => {
    setPaletteState(id);
    applyPalette(id);
    persistPalette(id);
  }, []);

  const setFontSize = useCallback((px: number) => {
    const clamped = clampFontSize(px);
    setFontSizeState(clamped);
    applyFontSize(clamped);
    persistFontSize(clamped);
  }, []);

  useEffect(() => {
    applyDarkClass(isDark);
  }, [isDark]);

  useEffect(() => {
    applyPalette(palette);
  }, [palette]);

  useEffect(() => {
    applyFontSize(fontSizeState);
  }, [fontSizeState]);

  useEffect(() => {
    if (theme !== "system") return;
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const handler = () => {
      const resolved = getSystemPrefersDark();
      setIsDark(resolved);
      applyDarkClass(resolved);
    };
    mq.addEventListener("change", handler);
    return () => mq.removeEventListener("change", handler);
  }, [theme]);

  const value = useMemo(
    () => ({ theme, isDark, setTheme, palette, setPalette, fontSize: fontSizeState, setFontSize }),
    [theme, isDark, setTheme, palette, setPalette, fontSizeState, setFontSize]
  );

  return (
    <ThemeContext.Provider value={value}>
      {children}
    </ThemeContext.Provider>
  );
}

export function useTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error("useTheme must be used within ThemeProvider");
  return ctx;
}
