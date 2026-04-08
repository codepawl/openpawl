/** @deprecated Dollar cost estimation removed. */
export async function initPriceRegistry(): Promise<void> {
  // No-op — pricing removed
}

/** @deprecated Returns 0. Dollar cost estimation removed. */
export function calculateCost(
  _inputTokens: number,
  _outputTokens: number,
  _cachedInputTokens: number,
  _model: string
): number {
  return 0;
}

export function formatCurrency(_usd: number): string {
  return "";
}

export function formatTokens(count: number): string {
  if (count < 1000) return String(count);
  if (count < 10_000) return `${(count / 1000).toFixed(1)}k`;
  if (count < 1_000_000) return `${Math.round(count / 1000)}k`;
  return `${(count / 1_000_000).toFixed(1)}M`;
}
