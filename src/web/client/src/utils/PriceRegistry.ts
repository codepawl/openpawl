/**
 * Model pricing registry with localStorage caching and remote fetch.
 */

interface ModelPricing {
  inputPerM: number;
  outputPerM: number;
  cachedPerM?: number;
}

interface PriceData {
  version: string;
  updatedAt: string;
  models: Record<string, ModelPricing>;
}

interface CachedEntry {
  data: PriceData;
  timestamp: number;
}

const CACHE_KEY = "teamclaw_price_data";
const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

const DEFAULT_PRICING: PriceData = {
  version: "default",
  updatedAt: "",
  models: {
    "gpt-4o": { inputPerM: 2.5, outputPerM: 10.0, cachedPerM: 1.25 },
    "gpt-4o-mini": { inputPerM: 0.15, outputPerM: 0.6, cachedPerM: 0.075 },
    "claude-3-5-sonnet": { inputPerM: 3.0, outputPerM: 15.0, cachedPerM: 0.375 },
    "claude-3-opus": { inputPerM: 15.0, outputPerM: 75.0, cachedPerM: 1.875 },
  },
};

const FALLBACK_PRICING: ModelPricing = {
  inputPerM: 0.15,
  outputPerM: 0.6,
  cachedPerM: 0.075,
};

function normalizeModelName(model: string): string {
  const trimmed = model.trim().toLowerCase();
  // Strip date-based version suffixes (e.g. -20240620, -2024-08-06)
  return trimmed.replace(/-\d{4}[-]?\d{2}[-]?\d{2}$/, "");
}

function resolveModel(normalized: string, models: Record<string, ModelPricing>): ModelPricing | null {
  // Exact match
  if (models[normalized]) return models[normalized];

  // Pattern-based matching
  if (normalized.includes("mini")) {
    const key = Object.keys(models).find((k) => k.includes("mini"));
    if (key) return models[key];
  }
  if (normalized.includes("opus")) {
    const key = Object.keys(models).find((k) => k.includes("opus"));
    if (key) return models[key];
  }
  if (normalized.includes("sonnet")) {
    const key = Object.keys(models).find((k) => k.includes("sonnet"));
    if (key) return models[key];
  }
  // Base model match (e.g. gpt-4o-xxx → gpt-4o)
  for (const key of Object.keys(models)) {
    if (normalized.startsWith(key)) return models[key];
  }
  return null;
}

export class PriceRegistry {
  private data: PriceData = DEFAULT_PRICING;

  async init(): Promise<void> {
    // Try localStorage cache first
    try {
      const raw = localStorage.getItem(CACHE_KEY);
      if (raw) {
        const cached: CachedEntry = JSON.parse(raw);
        const age = Date.now() - cached.timestamp;
        if (age < CACHE_TTL_MS) {
          this.data = cached.data;
          // loaded
          return;
        }
        // Cache expired — try fetch, fall back to stale cache
        try {
          await this.fetchFresh();
        } catch {
          this.data = cached.data;
        }
        return;
      }
    } catch {
      // localStorage unavailable or corrupt
    }

    // No cache — try fetch, fall back to defaults
    try {
      await this.fetchFresh();
    } catch {
      this.data = DEFAULT_PRICING;
    }
  }

  private async fetchFresh(): Promise<void> {
    const resp = await fetch("/api/pricing");
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const data: PriceData = await resp.json();
    this.data = data;
    try {
      localStorage.setItem(
        CACHE_KEY,
        JSON.stringify({ data, timestamp: Date.now() } satisfies CachedEntry),
      );
    } catch {
      // localStorage full or unavailable
    }
  }

  getPricing(model: string): ModelPricing {
    const normalized = normalizeModelName(model);
    const match = resolveModel(normalized, this.data.models);
    return match ?? FALLBACK_PRICING;
  }

  getCachedPricing(model: string): ModelPricing & { cachedPerM: number } {
    const pricing = this.getPricing(model);
    const cachedPerM = pricing.cachedPerM ?? pricing.inputPerM * 0.1;
    return { ...pricing, cachedPerM };
  }
}
