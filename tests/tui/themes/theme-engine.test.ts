import { describe, it, expect, beforeEach } from "vitest";
import { ThemeEngine } from "../../../src/tui/themes/theme-engine.js";

describe("ThemeEngine", () => {
  let engine: ThemeEngine;

  beforeEach(() => {
    engine = new ThemeEngine();
  });

  it("default theme is catppuccin-mocha", () => {
    expect(engine.getCurrentId()).toBe("catppuccin-mocha");
  });

  it("lists 11 built-in themes", () => {
    const themes = engine.listThemes();
    expect(themes).toHaveLength(11);
  });

  it("switchTheme changes current theme", () => {
    const ok = engine.switchTheme("nord");
    expect(ok).toBe(true);
    expect(engine.getCurrentId()).toBe("nord");
  });

  it("switchTheme returns false for unknown theme", () => {
    const ok = engine.switchTheme("nonexistent");
    expect(ok).toBe(false);
    expect(engine.getCurrentId()).toBe("catppuccin-mocha");
  });

  it("getTheme returns a complete Theme object", () => {
    const theme = engine.getTheme();
    expect(typeof theme.primary).toBe("function");
    expect(typeof theme.success).toBe("function");
    expect(typeof theme.error).toBe("function");
    expect(theme.agentColors.length).toBeGreaterThan(0);
    expect(theme.symbols.success).toBe("✓");
  });

  it("emits theme:changed on switch", () => {
    let emittedId = "";
    engine.on("theme:changed", (id: string) => { emittedId = id; });
    engine.switchTheme("gruvbox-dark");
    expect(emittedId).toBe("gruvbox-dark");
  });

  it("all themes have complete palettes", () => {
    for (const info of engine.listThemes()) {
      const td = engine.getThemeById(info.id);
      expect(td).toBeDefined();
      expect(td!.palette.textPrimary).toMatch(/^#[0-9a-fA-F]{6}$/);
      expect(td!.palette.success).toMatch(/^#[0-9a-fA-F]{6}$/);
      expect(td!.palette.error).toMatch(/^#[0-9a-fA-F]{6}$/);
      expect(td!.palette.agentCoder).toMatch(/^#[0-9a-fA-F]{6}$/);
    }
  });

  it("catppuccin-mocha base palette is correct", () => {
    const td = engine.getDefinition();
    expect(td.palette.textPrimary).toBe("#cdd6f4");
    expect(td.palette.statusBarBg).toBe("#181825");
    expect(td.palette.prompt).toBe("#cba6f7");
  });

  it("gruvbox-dark fg is NOT pure white", () => {
    const td = engine.getThemeById("gruvbox-dark")!;
    expect(td.palette.textPrimary).not.toBe("#ffffff");
    expect(td.palette.textPrimary).toBe("#ebdbb2");
  });

  it("includes both dark and light variants", () => {
    const themes = engine.listThemes();
    const darkCount = themes.filter((t) => t.variant === "dark").length;
    const lightCount = themes.filter((t) => t.variant === "light").length;
    expect(darkCount).toBeGreaterThan(0);
    expect(lightCount).toBeGreaterThan(0);
  });

  it("maxBrightness defaults to 1.0", () => {
    expect(engine.getMaxBrightness()).toBe(1.0);
  });

  it("setMaxBrightness clamps to 0-1 range", () => {
    engine.setMaxBrightness(0.5);
    expect(engine.getMaxBrightness()).toBe(0.5);
    engine.setMaxBrightness(-1);
    expect(engine.getMaxBrightness()).toBe(0);
    engine.setMaxBrightness(2);
    expect(engine.getMaxBrightness()).toBe(1);
  });
});
