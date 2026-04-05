import { describe, it, expect } from "vitest";
import { Sparkline } from "../../../src/tui/rich-content/sparkline.js";

describe("Sparkline", () => {
  const spark = new Sparkline();

  it("renders correct block elements for values", () => {
    const result = spark.render([0, 25, 50, 75, 100], { width: 5 });
    expect(result.length).toBe(5);
    expect(result[0]).toBe("▁"); // lowest
    expect(result[4]).toBe("█"); // highest
  });

  it("respects width limit", () => {
    const values = Array.from({ length: 100 }, (_, i) => i);
    const result = spark.render(values, { width: 10 });
    expect(result.length).toBe(10);
  });

  it("handles empty values", () => {
    expect(spark.render([])).toBe("");
  });

  it("handles single value", () => {
    const result = spark.render([42]);
    expect(result.length).toBe(1);
  });
});
