import { describe, it, expect } from "vitest";
import { SmartModelRouter } from "../../src/providers/smart-router.js";
import type { SmartRouterCandidate } from "../../src/providers/smart-router.js";

const candidates: SmartRouterCandidate[] = [
  { provider: "anthropic", model: "claude-sonnet-4", healthy: true, avgLatencyMs: 300, costPerMToken: 3.0 },
  { provider: "groq", model: "llama-3.1-8b", healthy: true, avgLatencyMs: 50, costPerMToken: 0.05 },
  { provider: "deepseek", model: "deepseek-chat", healthy: true, avgLatencyMs: 200, costPerMToken: 0.14 },
  { provider: "offline", model: "broken", healthy: false, avgLatencyMs: 0, costPerMToken: 0 },
];

describe("SmartModelRouter", () => {
  const router = new SmartModelRouter();

  it("selects cheapest when preferCost", () => {
    const result = router.selectModel(candidates, { preferCost: true });
    expect(result).not.toBeNull();
    expect(result!.provider).toBe("groq"); // cheapest
  });

  it("selects fastest when preferSpeed", () => {
    const result = router.selectModel(candidates, { preferSpeed: true });
    expect(result).not.toBeNull();
    expect(result!.provider).toBe("groq"); // fastest
  });

  it("excludes unhealthy providers", () => {
    const result = router.selectModel(candidates, {});
    expect(result!.provider).not.toBe("offline");
  });

  it("respects maxLatencyMs", () => {
    const result = router.selectModel(candidates, { maxLatencyMs: 100 });
    expect(result).not.toBeNull();
    expect(result!.estimatedLatencyMs).toBeLessThanOrEqual(100);
  });

  it("returns null when no candidates available", () => {
    const result = router.selectModel([{ provider: "x", model: "y", healthy: false, avgLatencyMs: 0, costPerMToken: 0 }], {});
    expect(result).toBeNull();
  });
});
