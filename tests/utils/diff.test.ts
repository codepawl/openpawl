import { describe, test, expect } from "bun:test";
import { generateDiff } from "../../src/utils/diff.js";

describe("generateDiff", () => {
  test("new file shows first 15 lines as added", () => {
    const lines = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`);
    const after = lines.join("\n");
    const result = generateDiff("", after);

    expect(result.added).toBe(20);
    expect(result.removed).toBe(0);
    expect(result.lines.filter((l) => l.type === "added")).toHaveLength(15);
    expect(result.lines[result.lines.length - 1]!.type).toBe("collapsed");
    expect(result.lines[result.lines.length - 1]!.content).toContain("+5");
  });

  test("small new file shows all lines", () => {
    const result = generateDiff("", "hello\nworld");
    expect(result.added).toBe(2);
    expect(result.removed).toBe(0);
    expect(result.lines.filter((l) => l.type === "added")).toHaveLength(2);
    expect(result.lines.some((l) => l.type === "collapsed")).toBe(false);
  });

  test("identical files produce no diff lines", () => {
    const content = "foo\nbar\nbaz";
    const result = generateDiff(content, content);
    expect(result.added).toBe(0);
    expect(result.removed).toBe(0);
    expect(result.lines).toHaveLength(0);
  });

  test("single line change shows context", () => {
    const before = "a\nb\nc\nd\ne\nf\ng\nh";
    const after = "a\nb\nc\nX\ne\nf\ng\nh";
    const result = generateDiff(before, after);

    expect(result.added).toBe(1);
    expect(result.removed).toBe(1);

    const types = result.lines.map((l) => l.type);
    expect(types).toContain("added");
    expect(types).toContain("removed");
    expect(types).toContain("context");
  });

  test("collapses unchanged sections", () => {
    const lines = Array.from({ length: 50 }, (_, i) => `line ${i}`);
    const before = lines.join("\n");
    const modified = [...lines];
    modified[25] = "CHANGED";
    const after = modified.join("\n");

    const result = generateDiff(before, after);
    expect(result.added).toBe(1);
    expect(result.removed).toBe(1);
    expect(result.lines.some((l) => l.type === "collapsed")).toBe(true);
  });

  test("addition only (no removal)", () => {
    const before = "a\nb\nc";
    const after = "a\nb\nNEW\nc";
    const result = generateDiff(before, after);
    expect(result.added).toBe(1);
    expect(result.removed).toBe(0);
  });

  test("removal only (no addition)", () => {
    const before = "a\nb\nc";
    const after = "a\nc";
    const result = generateDiff(before, after);
    expect(result.added).toBe(0);
    expect(result.removed).toBe(1);
  });

  test("large files return counts only", () => {
    const bigBefore = Array.from({ length: 300 }, (_, i) => `line ${i}`).join("\n");
    const bigAfter = Array.from({ length: 300 }, (_, i) => `line ${i + 1}`).join("\n");
    const result = generateDiff(bigBefore, bigAfter);
    // 600 total lines > 500 threshold → counts only
    expect(result.lines).toHaveLength(0);
    expect(result.added).toBeGreaterThan(0);
  });

  test("binary content returns counts only", () => {
    const binary = "hello\x00world";
    const result = generateDiff("", binary);
    expect(result.lines).toHaveLength(0);
    expect(result.added).toBeGreaterThan(0);
  });
});
