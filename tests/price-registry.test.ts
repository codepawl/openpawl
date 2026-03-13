import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.stubGlobal("localStorage", {
  getItem: vi.fn(),
  setItem: vi.fn(),
  removeItem: vi.fn(),
  clear: vi.fn(),
});

const mockPriceData = {
  version: "test",
  updatedAt: new Date().toISOString(),
  models: {
    "gpt-4o": { inputPerM: 2.50, outputPerM: 10.00, cachedPerM: 1.25 },
    "gpt-4o-mini": { inputPerM: 0.15, outputPerM: 0.60, cachedPerM: 0.075 },
    "claude-3-5-sonnet": { inputPerM: 3.00, outputPerM: 15.00, cachedPerM: 0.375 },
    "claude-3-opus": { inputPerM: 15.00, outputPerM: 75.00, cachedPerM: 1.875 },
  },
};

const { PriceRegistry } = await import("../src/web/client/src/utils/PriceRegistry.js");

describe("PriceRegistry", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(localStorage.getItem).mockReturnValue(null);
  });

  describe("init", () => {
    it("initializes with default pricing when fetch fails and no cache", async () => {
      vi.stubGlobal("fetch", vi.fn(() => Promise.reject(new Error("Network error"))));

      const registry = new PriceRegistry();
      await registry.init();

      const pricing = registry.getPricing("gpt-4o");
      expect(pricing.inputPerM).toBe(2.50);
    });

    it("uses cache when valid", async () => {
      const cachedData = {
        data: mockPriceData,
        timestamp: Date.now(),
      };
      vi.mocked(localStorage.getItem).mockReturnValue(JSON.stringify(cachedData));

      const registry = new PriceRegistry();
      await registry.init();

      const pricing = registry.getPricing("gpt-4o");
      expect(pricing.inputPerM).toBe(2.50);
      expect(fetch).not.toHaveBeenCalled();
    });

    it("falls back to stale cache when fetch fails", async () => {
      const staleCache = {
        data: mockPriceData,
        timestamp: Date.now() - 25 * 60 * 60 * 1000, // 25 hours ago
      };
      vi.mocked(localStorage.getItem).mockReturnValue(JSON.stringify(staleCache));
      vi.stubGlobal("fetch", vi.fn(() => Promise.reject(new Error("Network error"))));

      const registry = new PriceRegistry();
      await registry.init();

      const pricing = registry.getPricing("gpt-4o");
      expect(pricing.inputPerM).toBe(2.50);
    });

    it("fetches fresh data when cache is expired", async () => {
      const expiredCache = {
        data: { ...mockPriceData, version: "old" },
        timestamp: Date.now() - 25 * 60 * 60 * 1000,
      };
      vi.mocked(localStorage.getItem).mockReturnValue(JSON.stringify(expiredCache));
      
      vi.stubGlobal("fetch", vi.fn(() => 
        Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ ...mockPriceData, version: "new" }),
        } as any)
      ));

      const registry = new PriceRegistry();
      await registry.init();

      expect(fetch).toHaveBeenCalled();
    });
  });

  describe("getPricing", () => {
    it("returns pricing for exact model match", async () => {
      const registry = new PriceRegistry();
      vi.spyOn(registry as any, 'init').mockImplementation(async () => {
        (registry as any).data = mockPriceData;
        (registry as any).initialized = true;
      });
      
      await registry.init();

      const pricing = registry.getPricing("gpt-4o");
      expect(pricing.inputPerM).toBe(2.50);
      expect(pricing.outputPerM).toBe(10.00);
    });

    it("normalizes versioned model names (gpt-4o-2024-08-06 -> gpt-4o)", async () => {
      const registry = new PriceRegistry();
      vi.spyOn(registry as any, 'init').mockImplementation(async () => {
        (registry as any).data = mockPriceData;
        (registry as any).initialized = true;
      });
      
      await registry.init();

      const pricing = registry.getPricing("gpt-4o-2024-08-06");
      expect(pricing.inputPerM).toBe(2.50);
    });

    it("normalizes claude-3-5-sonnet-20240620", async () => {
      const registry = new PriceRegistry();
      vi.spyOn(registry as any, 'init').mockImplementation(async () => {
        (registry as any).data = mockPriceData;
        (registry as any).initialized = true;
      });
      
      await registry.init();

      const pricing = registry.getPricing("claude-3-5-sonnet-20240620");
      expect(pricing.inputPerM).toBe(3.00);
    });

    it("detects mini models", async () => {
      const registry = new PriceRegistry();
      vi.spyOn(registry as any, 'init').mockImplementation(async () => {
        (registry as any).data = mockPriceData;
        (registry as any).initialized = true;
      });
      
      await registry.init();

      const pricing = registry.getPricing("gpt-4o-mini-2024-07-18");
      expect(pricing.inputPerM).toBe(0.15);
    });

    it("detects opus model", async () => {
      const registry = new PriceRegistry();
      vi.spyOn(registry as any, 'init').mockImplementation(async () => {
        (registry as any).data = mockPriceData;
        (registry as any).initialized = true;
      });
      
      await registry.init();

      const pricing = registry.getPricing("claude-opus-3");
      expect(pricing.inputPerM).toBe(15.00);
    });

    it("falls back to default pricing for unknown models", async () => {
      const registry = new PriceRegistry();
      vi.spyOn(registry as any, 'init').mockImplementation(async () => {
        (registry as any).data = { version: "test", updatedAt: "", models: {} };
        (registry as any).initialized = true;
      });
      
      await registry.init();

      const pricing = registry.getPricing("unknown-model");
      expect(pricing.inputPerM).toBe(0.15); // default
    });

    it("normalizes model names to lowercase", async () => {
      const registry = new PriceRegistry();
      vi.spyOn(registry as any, 'init').mockImplementation(async () => {
        (registry as any).data = mockPriceData;
        (registry as any).initialized = true;
      });
      
      await registry.init();

      const pricing = registry.getPricing("GPT-4O");
      expect(pricing.inputPerM).toBe(2.50);
    });
  });

  describe("getCachedPricing", () => {
    it("calculates cached price when cachedPerM is available", async () => {
      const registry = new PriceRegistry();
      vi.spyOn(registry as any, 'init').mockImplementation(async () => {
        (registry as any).data = mockPriceData;
        (registry as any).initialized = true;
      });
      
      await registry.init();

      const cachedPricing = registry.getCachedPricing("gpt-4o");
      expect(cachedPricing.cachedPerM).toBe(1.25);
    });

    it("estimates cached price as 10% of input when cachedPerM is missing", async () => {
      const registry = new PriceRegistry();
      vi.spyOn(registry as any, 'init').mockImplementation(async () => {
        (registry as any).data = {
          version: "test",
          updatedAt: "",
          models: {
            "gpt-4o": { inputPerM: 2.50, outputPerM: 10.00 }, // no cachedPerM
          },
        };
        (registry as any).initialized = true;
      });
      
      await registry.init();

      const cachedPricing = registry.getCachedPricing("gpt-4o");
      expect(cachedPricing.cachedPerM).toBe(0.25); // 10% of 2.50
    });
  });

  describe("edge cases", () => {
    it("handles empty model string", async () => {
      const registry = new PriceRegistry();
      vi.spyOn(registry as any, 'init').mockImplementation(async () => {
        (registry as any).data = mockPriceData;
        (registry as any).initialized = true;
      });
      
      await registry.init();

      const pricing = registry.getPricing("");
      expect(pricing.inputPerM).toBe(0.15); // defaults to mini
    });

    it("handles whitespace in model name", async () => {
      const registry = new PriceRegistry();
      vi.spyOn(registry as any, 'init').mockImplementation(async () => {
        (registry as any).data = mockPriceData;
        (registry as any).initialized = true;
      });
      
      await registry.init();

      const pricing = registry.getPricing("  gpt-4o  ");
      expect(pricing.inputPerM).toBe(2.50);
    });
  });
});
