import { describe, test, expect } from "bun:test";
import { renderPanel } from "../../src/tui/components/panel.js";
import { visibleWidth } from "../../src/tui/utils/text-width.js";

// Strip ANSI for assertion convenience
function strip(s: string): string {
  return s.replace(/\x1b\[[0-9;]*m/g, "");
}

describe("renderPanel", () => {
  test("renders basic panel with title", () => {
    const lines = renderPanel({ title: "Test" }, ["hello", "world"]);
    const top = strip(lines[0]!);
    expect(top).toContain("┌");
    expect(top).toContain("Test");
    expect(top).toContain("┐");
    // Content lines have borders
    const contentLine = strip(lines.find((l) => strip(l).includes("hello"))!);
    expect(contentLine).toContain("│");
    expect(contentLine).toContain("hello");
    // Bottom border
    const bottom = strip(lines[lines.length - 1]!);
    expect(bottom).toContain("└");
    expect(bottom).toContain("┘");
  });

  test("renders footer", () => {
    const lines = renderPanel({ title: "T", footer: "hint text" }, ["content"]);
    const footerLine = lines.find((l) => strip(l).includes("hint text"));
    expect(footerLine).toBeDefined();
  });

  test("auto width fits content", () => {
    const short = renderPanel({ title: "T" }, ["hi"]);
    const long = renderPanel({ title: "T" }, ["a".repeat(50)]);
    const shortW = visibleWidth(strip(short[0]!));
    const longW = visibleWidth(strip(long[0]!));
    expect(longW).toBeGreaterThan(shortW);
  });

  test("maxWidth caps auto sizing", () => {
    const lines = renderPanel({ title: "T", maxWidth: 30 }, ["a".repeat(100)]);
    const topW = visibleWidth(strip(lines[0]!).trim());
    expect(topW).toBeLessThanOrEqual(30);
  });

  test("fixed width overrides auto", () => {
    const lines = renderPanel({ title: "T", width: 40 }, ["short"]);
    // All lines should have same visible width (borders are uniform)
    const topW = visibleWidth(strip(lines[0]!).trim());
    expect(topW).toBe(40);
  });

  test("center alignment adds left padding", () => {
    const lines = renderPanel({ title: "T", width: 20, align: "center", termWidth: 80 }, ["hi"]);
    const top = strip(lines[0]!);
    // Should have leading spaces for centering: (80 - 20) / 2 = 30
    const leadingSpaces = top.length - top.trimStart().length;
    expect(leadingSpaces).toBe(30);
  });

  test("rounded border uses round corners", () => {
    const lines = renderPanel({ title: "T", border: "rounded" }, ["x"]);
    const top = strip(lines[0]!);
    expect(top).toContain("╭");
    expect(top).toContain("╮");
    const bottom = strip(lines[lines.length - 1]!);
    expect(bottom).toContain("╰");
    expect(bottom).toContain("╯");
  });

  test("no border mode skips box drawing", () => {
    const lines = renderPanel({ border: "none" }, ["hello"]);
    for (const line of lines) {
      expect(strip(line)).not.toContain("┌");
      expect(strip(line)).not.toContain("│");
    }
    expect(lines.some((l) => strip(l).includes("hello"))).toBe(true);
  });

  test("content lines are padded to uniform width", () => {
    const lines = renderPanel({ title: "T", width: 30 }, ["short", "a longer line here"]);
    const contentLines = lines.filter((l) => strip(l).includes("short") || strip(l).includes("longer"));
    for (const line of contentLines) {
      const w = visibleWidth(strip(line).trim());
      expect(w).toBe(30);
    }
  });

  test("long content is truncated", () => {
    const long = "x".repeat(200);
    const lines = renderPanel({ title: "T", maxWidth: 40 }, [long]);
    const contentLine = lines.find((l) => strip(l).includes("x"))!;
    const w = visibleWidth(strip(contentLine).trim());
    expect(w).toBeLessThanOrEqual(40);
  });
});
