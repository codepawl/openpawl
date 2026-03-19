import { describe, it, expect, beforeEach } from "vitest";
import { compressIfLarge } from "../src/token-opt/payload-compressor.js";
import { resetTokenOptStats, getTokenOptStats } from "../src/token-opt/stats.js";

describe("PayloadCompressor", () => {
  beforeEach(() => {
    resetTokenOptStats();
  });

  it("returns text unchanged when below threshold", () => {
    const result = compressIfLarge("short text", 100);
    expect(result.text).toBe("short text");
    expect(result.truncatedBy).toBe(0);
  });

  it("returns text unchanged when exactly at threshold", () => {
    const text = "a".repeat(2000);
    const result = compressIfLarge(text, 2000);
    expect(result.text).toBe(text);
    expect(result.truncatedBy).toBe(0);
  });

  it("truncates text exceeding threshold", () => {
    const text = "a".repeat(3000);
    const result = compressIfLarge(text, 2000);
    expect(result.truncatedBy).toBe(1000);
    expect(result.text).toContain("a".repeat(2000));
    expect(result.text).toContain("[truncated: 1000 chars omitted]");
    expect(result.text.length).toBeLessThan(text.length);
  });

  it("handles empty string", () => {
    const result = compressIfLarge("", 100);
    expect(result.text).toBe("");
    expect(result.truncatedBy).toBe(0);
  });

  it("uses default threshold of 2000 chars", () => {
    const text = "x".repeat(2500);
    const result = compressIfLarge(text);
    expect(result.truncatedBy).toBe(500);
  });

  it("records truncation in stats", () => {
    compressIfLarge("y".repeat(3000), 1000);
    const stats = getTokenOptStats();
    expect(stats.payloadTruncations).toBe(1);
    expect(stats.charsSavedByTruncation).toBe(2000);
  });

  it("does not record stats when no truncation", () => {
    compressIfLarge("short", 1000);
    const stats = getTokenOptStats();
    expect(stats.payloadTruncations).toBe(0);
  });
});
