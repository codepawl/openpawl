import { describe, test, expect } from "bun:test";
import { columns, labelValue } from "../../../src/tui/primitives/columns.js";
import { visibleWidth } from "../../../src/tui/utils/text-width.js";

describe("columns", () => {
  test("two auto columns with gap", () => {
    const line = columns([
      { content: "Name" },
      { content: "Value" },
    ], { gap: 2 });
    expect(line).toContain("Name");
    expect(line).toContain("Value");
  });

  test("fixed width column pads content", () => {
    const line = columns([
      { content: "Hi", width: 10 },
      { content: "World" },
    ], { gap: 0 });
    // "Hi" should be padded to 10 chars
    expect(line.startsWith("Hi        ")).toBe(true);
  });

  test("fill column takes remaining space", () => {
    const line = columns([
      { content: "Key", width: 5 },
      { content: "Val", width: "fill" },
    ], { totalWidth: 40, gap: 2 });
    expect(visibleWidth(line)).toBe(40);
  });

  test("right-aligned column", () => {
    const line = columns([
      { content: "42", width: 10, align: "right" },
    ], { gap: 0 });
    expect(line).toContain("        42");
  });

  test("padding adds left margin", () => {
    const line = columns([{ content: "x" }], { padding: 4 });
    expect(line.startsWith("    ")).toBe(true);
  });
});

describe("labelValue", () => {
  test("renders label and value", () => {
    const line = labelValue("Name:", "Alice");
    expect(line).toContain("Name:");
    expect(line).toContain("Alice");
  });

  test("fixed label width", () => {
    const line = labelValue("A:", "B", { labelWidth: 10 });
    expect(line).toContain("A:");
  });
});
