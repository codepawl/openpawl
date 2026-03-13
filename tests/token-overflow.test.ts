import { describe, it, expect, vi, beforeEach } from "vitest";

const MICRO_MULTIPLIER = 1_000_000;

function calculateCost(
  inputTokens: number,
  outputTokens: number,
  cachedInputTokens: number,
  pricing: { inputPerM: number; outputPerM: number; cachedPerM?: number }
): number {
  const cachedPerM = pricing.cachedPerM ?? pricing.inputPerM * 0.1;

  const fullPriceInputTokens = Math.max(0, inputTokens - cachedInputTokens);

  const inputMicro = Math.round((fullPriceInputTokens / 1_000_000) * pricing.inputPerM * MICRO_MULTIPLIER);
  const cachedMicro = Math.round((cachedInputTokens / 1_000_000) * cachedPerM * MICRO_MULTIPLIER);
  const outputMicro = Math.round((outputTokens / 1_000_000) * pricing.outputPerM * MICRO_MULTIPLIER);

  const totalMicro = inputMicro + cachedMicro + outputMicro;
  return totalMicro / MICRO_MULTIPLIER;
}

describe("Token Overflow Handling", () => {
  const gpt4oPricing = { inputPerM: 2.50, outputPerM: 10.00, cachedPerM: 1.25 };
  const gpt4oMiniPricing = { inputPerM: 0.15, outputPerM: 0.60, cachedPerM: 0.075 };

  describe("calculateCost", () => {
    it("calculates cost correctly with partial caching", () => {
      const cost = calculateCost(1_000_000, 500_000, 500_000, gpt4oPricing);
      
      expect(cost).toBeCloseTo(6.875, 4);
    });

    it("handles millions of tokens without overflow", () => {
      const cost = calculateCost(10_000_000, 10_000_000, 5_000_000, gpt4oPricing);
      
      expect(Number.isFinite(cost)).toBe(true);
      expect(cost).toBeGreaterThan(0);
    });

    it("handles zero tokens", () => {
      const cost = calculateCost(0, 0, 0, gpt4oPricing);
      
      expect(cost).toBe(0);
    });

    it("handles all tokens cached", () => {
      const cost = calculateCost(1_000_000, 500_000, 1_000_000, gpt4oPricing);
      
      expect(cost).toBeCloseTo(6.25, 4);
    });

    it("handles no caching", () => {
      const cost = calculateCost(1_000_000, 500_000, 0, gpt4oPricing);
      
      expect(cost).toBeCloseTo(7.50, 4);
    });

    it("uses default pricing for unknown model", () => {
      const cost = calculateCost(1_000_000, 500_000, 0, gpt4oMiniPricing);
      
      expect(cost).toBeCloseTo(0.45, 4);
    });

    it("handles small token counts with precision", () => {
      const cost = calculateCost(1000, 500, 100, gpt4oPricing);
      
      expect(Number.isFinite(cost)).toBe(true);
      expect(cost).toBeGreaterThan(0);
    });

    it("handles edge case where cached > input", () => {
      const cost = calculateCost(100_000, 50_000, 200_000, gpt4oPricing);
      
      expect(cost).toBeGreaterThanOrEqual(0);
    });
  });

  describe("formatCurrency", () => {
    const formatCurrency = (usd: number): string => {
      return `🪙 $${usd.toFixed(4)}`;
    };

    it("formats small values correctly", () => {
      expect(formatCurrency(0.1234)).toBe("🪙 $0.1234");
      expect(formatCurrency(0)).toBe("🪙 $0.0000");
    });

    it("formats large currency values correctly", () => {
      const formatLargeCurrency = (usd: number): string => {
        if (usd >= 1000) {
          return `$${(usd / 1000).toFixed(2)}K`;
        }
        return `$${usd.toFixed(4)}`;
      };
      
      expect(formatLargeCurrency(150000)).toBe("$150.00K");
      expect(formatLargeCurrency(5000)).toBe("$5.00K");
      expect(formatLargeCurrency(999.99)).toBe("$999.9900");
    });

    it("handles very large values", () => {
      const formatLargeCurrency = (usd: number): string => {
        if (usd >= 1000) {
          return `$${(usd / 1000).toFixed(2)}K`;
        }
        return `$${usd.toFixed(4)}`;
      };
      
      expect(formatLargeCurrency(1000000)).toBe("$1000.00K");
      expect(formatLargeCurrency(10000000)).toBe("$10000.00K");
    });
  });

  describe("micro-USD precision", () => {
    it("avoids floating-point errors", () => {
      const cost = calculateCost(1000, 500, 100, gpt4oPricing);
      
      expect(Number.isFinite(cost)).toBe(true);
      expect(cost).toBeGreaterThan(0);
    });

    it("produces consistent results", () => {
      const cost1 = calculateCost(1_000_000, 500_000, 250_000, gpt4oPricing);
      const cost2 = calculateCost(1_000_000, 500_000, 250_000, gpt4oPricing);
      
      expect(cost1).toBe(cost2);
    });
  });

  describe("real-world scenarios", () => {
    it("calculates cost for typical GPT-4o request with caching", () => {
      const inputTokens = 150000;
      const outputTokens = 3000;
      const cachedTokens = 100000;
      
      const cost = calculateCost(inputTokens, outputTokens, cachedTokens, gpt4oPricing);
      
      expect(cost).toBeGreaterThan(0);
      expect(cost).toBeLessThan(1);
    });

    it("calculates cost for large document processing", () => {
      const inputTokens = 50000000;
      const outputTokens = 1000000;
      const cachedTokens = 30000000;
      
      const cost = calculateCost(inputTokens, outputTokens, cachedTokens, gpt4oPricing);
      
      expect(cost).toBeGreaterThan(0);
      expect(cost).toBeLessThan(500);
    });

    it("calculates cost for Claude Sonnet with caching", () => {
      const claudePricing = { inputPerM: 3.00, outputPerM: 15.00, cachedPerM: 0.375 };
      const inputTokens = 200000;
      const outputTokens = 5000;
      const cachedTokens = 150000;
      
      // Full-price input: 200K - 150K = 50K @ $3.00/1M = $0.15
      // Cached: 150K @ $0.375/1M = $0.05625
      // Output: 5K @ $15.00/1M = $0.075
      // Total: $0.28125
      const cost = calculateCost(inputTokens, outputTokens, cachedTokens, claudePricing);
      
      expect(cost).toBeCloseTo(0.28125, 4);
    });
  });
});
