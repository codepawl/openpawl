import { describe, test, expect } from "bun:test";
import { separator } from "../../../src/tui/primitives/separator.js";

function strip(s: string): string {
  return s.replace(/\x1b\[[0-9;]*m/g, "");
}

describe("separator", () => {
  test("default uses ─ character", () => {
    const line = strip(separator({ width: 20 }));
    expect(line).toBe("─".repeat(20));
  });

  test("custom char", () => {
    const line = strip(separator({ width: 10, char: "=" }));
    expect(line).toBe("=".repeat(10));
  });

  test("centered label", () => {
    const line = strip(separator({ width: 30, label: "Title" }));
    expect(line).toContain(" Title ");
    expect(line.length).toBe(30);
  });

  test("left-aligned label", () => {
    const line = strip(separator({ width: 30, label: "Title", labelAlign: "left" }));
    expect(line).toContain(" Title ");
    expect(line.startsWith("──")).toBe(true);
  });

  test("padding adds left margin", () => {
    const line = strip(separator({ width: 10, padding: 4 }));
    expect(line.startsWith("    ")).toBe(true);
  });
});
