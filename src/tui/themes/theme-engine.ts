/**
 * Theme engine — singleton that manages theme loading, switching, and resolution.
 * Default theme: Catppuccin Mocha.
 */
import { EventEmitter } from "node:events";
import type { Theme } from "./theme.js";
import type { ThemeDefinition } from "./theme-types.js";
import { getBuiltInThemes } from "./built-in/index.js";
import { setActiveTheme } from "./default.js";

export class ThemeEngine extends EventEmitter {
  private themes = new Map<string, ThemeDefinition>();
  private current: ThemeDefinition;
  private maxBrightness = 1.0;

  constructor() {
    super();
    // Register all built-in themes
    for (const td of getBuiltInThemes()) {
      this.themes.set(td.id, td);
    }
    // Default to catppuccin-mocha
    this.current = this.themes.get("catppuccin-mocha")!;
  }

  /** Get the currently active theme. */
  getTheme(): Theme {
    return this.current.theme;
  }

  /** Get the current theme definition (with palette). */
  getDefinition(): ThemeDefinition {
    return this.current;
  }

  /** Get the current theme ID. */
  getCurrentId(): string {
    return this.current.id;
  }

  /** Switch to a different theme by ID. Updates the global defaultTheme proxy. */
  switchTheme(themeId: string): boolean {
    const td = this.themes.get(themeId);
    if (!td) return false;
    this.current = td;
    setActiveTheme(td.theme);
    this.emit("theme:changed", themeId);
    return true;
  }

  /** List all available theme IDs. */
  listThemes(): { id: string; name: string; variant: string }[] {
    return [...this.themes.values()].map((t) => ({
      id: t.id,
      name: t.name,
      variant: t.variant,
    }));
  }

  /** Register a custom theme. */
  registerTheme(td: ThemeDefinition): void {
    this.themes.set(td.id, td);
  }

  /** Set max brightness (0.0–1.0). Affects computed colors. */
  setMaxBrightness(value: number): void {
    this.maxBrightness = Math.max(0, Math.min(1, value));
  }

  getMaxBrightness(): number {
    return this.maxBrightness;
  }

  /** Get a theme by ID (for preview). */
  getThemeById(id: string): ThemeDefinition | undefined {
    return this.themes.get(id);
  }
}

/** Singleton instance. */
let _engine: ThemeEngine | null = null;

export function getThemeEngine(): ThemeEngine {
  if (!_engine) _engine = new ThemeEngine();
  return _engine;
}

export function resetThemeEngine(): void {
  _engine = null;
}
