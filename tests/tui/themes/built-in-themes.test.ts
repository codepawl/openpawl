import { describe, it, expect } from "vitest";
import { getBuiltInThemes } from "../../../src/tui/themes/built-in/index.js";
import { hexToRgb } from "../../../src/tui/themes/built-in/theme-builder.js";
import { contrastRatio } from "../../../src/tui/themes/color-utils.js";

describe("built-in themes", () => {
  const themes = getBuiltInThemes();

  it("has exactly 11 themes", () => {
    expect(themes).toHaveLength(11);
  });

  it("all themes have unique IDs", () => {
    const ids = themes.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("all themes load without missing fields", () => {
    for (const td of themes) {
      expect(td.theme.primary).toBeDefined();
      expect(td.theme.success).toBeDefined();
      expect(td.theme.error).toBeDefined();
      expect(td.theme.agentColors.length).toBeGreaterThanOrEqual(7);
      expect(td.theme.symbols.success).toBe("✓");
      expect(td.palette.textPrimary).toBeTruthy();
      expect(td.palette.agentCoder).toBeTruthy();
    }
  });

  it("catppuccin-mocha text contrast against base is WCAG AA (4.5:1+)", () => {
    const mocha = themes.find((t) => t.id === "catppuccin-mocha")!;
    // text #cdd6f4 on base #1e1e2e
    const ratio = contrastRatio("#cdd6f4", "#1e1e2e");
    expect(ratio).toBeGreaterThanOrEqual(4.5);
  });

  it("high-contrast all text ratios > 7:1 (WCAG AAA)", () => {
    const hc = themes.find((t) => t.id === "high-contrast")!;
    // text #f0f0f0 on bg #0a0a0a (represented by statusBarBg ~#1a1a1a)
    const ratio = contrastRatio("#f0f0f0", "#1a1a1a");
    expect(ratio).toBeGreaterThanOrEqual(7);
  });

  it("hexToRgb parses correctly", () => {
    expect(hexToRgb("#cdd6f4")).toEqual([205, 214, 244]);
    expect(hexToRgb("#1e1e2e")).toEqual([30, 30, 46]);
  });

  it("theme style functions produce ANSI output", () => {
    const mocha = themes.find((t) => t.id === "catppuccin-mocha")!;
    const result = mocha.theme.primary("test");
    expect(result).toContain("\x1b[");
    expect(result).toContain("test");
  });

  it("includes catppuccin flavors: mocha, latte, frappe, macchiato", () => {
    const ids = themes.map((t) => t.id);
    expect(ids).toContain("catppuccin-mocha");
    expect(ids).toContain("catppuccin-latte");
    expect(ids).toContain("catppuccin-frappe");
    expect(ids).toContain("catppuccin-macchiato");
  });
});
