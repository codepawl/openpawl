import { describe, it, expect, beforeEach } from "vitest";
import {
  getTokenOptStats,
  resetTokenOptStats,
  recordPromptCacheHit,
  recordPromptCacheCreation,
  recordPayloadTruncation,
  recordSemanticCacheHit,
  recordSemanticCacheMiss,
  recordTierDowngrade,
  formatTokenOptSummary,
} from "../src/token-opt/stats.js";

describe("TokenOptStats", () => {
  beforeEach(() => {
    resetTokenOptStats();
  });

  it("initializes all fields to zero", () => {
    const s = getTokenOptStats();
    expect(s.promptCacheHits).toBe(0);
    expect(s.promptCacheCreations).toBe(0);
    expect(s.cacheReadTokens).toBe(0);
    expect(s.cacheCreationTokens).toBe(0);
    expect(s.payloadTruncations).toBe(0);
    expect(s.charsSavedByTruncation).toBe(0);
    expect(s.semanticCacheHits).toBe(0);
    expect(s.semanticCacheMisses).toBe(0);
    expect(s.tierDowngrades).toBe(0);
    expect(s.tierDowngradeDetails).toEqual([]);
  });

  it("accumulates prompt cache stats", () => {
    recordPromptCacheHit(100);
    recordPromptCacheHit(200);
    recordPromptCacheCreation(500);
    const s = getTokenOptStats();
    expect(s.promptCacheHits).toBe(2);
    expect(s.cacheReadTokens).toBe(300);
    expect(s.promptCacheCreations).toBe(1);
    expect(s.cacheCreationTokens).toBe(500);
  });

  it("accumulates payload truncation stats", () => {
    recordPayloadTruncation(1000);
    recordPayloadTruncation(2000);
    const s = getTokenOptStats();
    expect(s.payloadTruncations).toBe(2);
    expect(s.charsSavedByTruncation).toBe(3000);
  });

  it("accumulates semantic cache stats", () => {
    recordSemanticCacheHit();
    recordSemanticCacheMiss();
    recordSemanticCacheMiss();
    const s = getTokenOptStats();
    expect(s.semanticCacheHits).toBe(1);
    expect(s.semanticCacheMisses).toBe(2);
  });

  it("accumulates tier downgrade stats", () => {
    recordTierDowngrade("tester", "claude-haiku-4-5");
    recordTierDowngrade("standup", "gpt-4o-mini");
    const s = getTokenOptStats();
    expect(s.tierDowngrades).toBe(2);
    expect(s.tierDowngradeDetails).toEqual([
      { role: "tester", model: "claude-haiku-4-5" },
      { role: "standup", model: "gpt-4o-mini" },
    ]);
  });

  it("reset clears all stats", () => {
    recordPromptCacheHit(100);
    recordTierDowngrade("tester", "haiku");
    recordSemanticCacheHit();
    resetTokenOptStats();
    const s = getTokenOptStats();
    expect(s.promptCacheHits).toBe(0);
    expect(s.tierDowngrades).toBe(0);
    expect(s.semanticCacheHits).toBe(0);
    expect(s.tierDowngradeDetails).toEqual([]);
  });

  it("getTokenOptStats returns a copy", () => {
    recordTierDowngrade("tester", "haiku");
    const s1 = getTokenOptStats();
    s1.tierDowngrades = 999;
    s1.tierDowngradeDetails.push({ role: "fake", model: "fake" });
    const s2 = getTokenOptStats();
    expect(s2.tierDowngrades).toBe(1);
    expect(s2.tierDowngradeDetails).toHaveLength(1);
  });

  it("formatTokenOptSummary returns empty string when no activity", () => {
    expect(formatTokenOptSummary()).toBe("");
  });

  it("formatTokenOptSummary includes active layers", () => {
    recordPromptCacheHit(100);
    recordTierDowngrade("tester", "haiku");
    recordSemanticCacheHit();
    recordSemanticCacheMiss();
    const summary = formatTokenOptSummary();
    expect(summary).toContain("cache-reads=1");
    expect(summary).toContain("tier-downgrades=1");
    expect(summary).toContain("semantic-hits=1/2");
  });
});
