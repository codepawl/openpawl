/**
 * Model swap suggestions — recommends cheaper models when appropriate.
 * Only suggests downgrades backed by profile data.
 */

import type { ModelSuggestion } from "./types.js";

export interface AgentCostData {
  agentRole: string;
  currentModel: string;
  estimatedCostUSD: number;
  averageConfidence: number;
}

/**
 * Generate model swap suggestions for agents where savings are possible.
 * Dollar cost tracking removed — returns empty until token-based suggestions are implemented.
 */
export function suggestModelSwaps(
  _agents: AgentCostData[],
): ModelSuggestion[] {
  // Dollar cost tracking removed — no pricing data available for comparisons
  return [];
}
