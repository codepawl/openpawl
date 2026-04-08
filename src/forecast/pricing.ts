/**
 * Model pricing — deprecated, returns zero costs.
 * Dollar cost estimation removed; only token counts are tracked.
 */

import type { ModelPricing } from "./types.js";

const ZERO_PRICING: ModelPricing = { inputPer1M: 0, outputPer1M: 0 };

/** @deprecated Returns zero pricing. Dollar cost estimation removed. */
export function getModelPricing(
  _model: string,
  _configOverrides?: Record<string, ModelPricing>,
): ModelPricing {
  return ZERO_PRICING;
}

/** @deprecated Returns 0. Dollar cost estimation removed. */
export function computeTokenCost(
  _inputTokens: number,
  _outputTokens: number,
  _pricing: ModelPricing,
): number {
  return 0;
}

/** @deprecated Returns empty object. Dollar cost estimation removed. */
export function getAllPricing(
  _configOverrides?: Record<string, ModelPricing>,
): Record<string, ModelPricing> {
  return {};
}
