/**
 * Price registry — deprecated, returns zero pricing.
 * Dollar cost estimation removed; only token counts are tracked.
 */

interface ModelPricing {
  inputPerM: number;
  outputPerM: number;
  cachedPerM?: number;
}

const ZERO: ModelPricing = { inputPerM: 0, outputPerM: 0, cachedPerM: 0 };

export class PriceRegistry {
  async init(): Promise<void> {
    // No-op — pricing removed
  }

  getPricing(_model: string): ModelPricing {
    return ZERO;
  }

  getCachedPricing(_model: string): ModelPricing & { cachedPerM: number } {
    return { ...ZERO, cachedPerM: 0 };
  }
}

/** Module-level singleton kept for API compat. */
export const priceRegistry = new PriceRegistry();
