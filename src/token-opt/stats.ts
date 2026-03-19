/**
 * Token optimization stats — per-sprint accumulator for all optimization layers.
 *
 * Same singleton pattern as SessionCacheStats in cache-interceptor.ts.
 */

import pc from "picocolors";

export interface TokenOptStats {
  // Layer 1: Prompt cache
  promptCacheHits: number;
  promptCacheCreations: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;

  // Layer 2B: Payload compression
  payloadTruncations: number;
  charsSavedByTruncation: number;

  // Layer 3: Semantic cache
  semanticCacheHits: number;
  semanticCacheMisses: number;

  // Layer 4: Model routing
  tierDowngrades: number;
  tierDowngradeDetails: Array<{ role: string; model: string }>;
}

const stats: TokenOptStats = createEmpty();

function createEmpty(): TokenOptStats {
  return {
    promptCacheHits: 0,
    promptCacheCreations: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    payloadTruncations: 0,
    charsSavedByTruncation: 0,
    semanticCacheHits: 0,
    semanticCacheMisses: 0,
    tierDowngrades: 0,
    tierDowngradeDetails: [],
  };
}

export function getTokenOptStats(): TokenOptStats {
  return { ...stats, tierDowngradeDetails: [...stats.tierDowngradeDetails] };
}

export function resetTokenOptStats(): void {
  Object.assign(stats, createEmpty());
}

export function recordPromptCacheHit(readTokens: number): void {
  stats.promptCacheHits++;
  stats.cacheReadTokens += readTokens;
}

export function recordPromptCacheCreation(creationTokens: number): void {
  stats.promptCacheCreations++;
  stats.cacheCreationTokens += creationTokens;
}

export function recordPayloadTruncation(charsSaved: number): void {
  stats.payloadTruncations++;
  stats.charsSavedByTruncation += charsSaved;
}

export function recordSemanticCacheHit(): void {
  stats.semanticCacheHits++;
}

export function recordSemanticCacheMiss(): void {
  stats.semanticCacheMisses++;
}

export function recordTierDowngrade(role: string, model: string): void {
  stats.tierDowngrades++;
  stats.tierDowngradeDetails.push({ role, model });
}

export function formatTokenOptSummary(): string {
  const s = stats;
  const hasActivity =
    s.promptCacheHits > 0 ||
    s.promptCacheCreations > 0 ||
    s.payloadTruncations > 0 ||
    s.semanticCacheHits > 0 ||
    s.semanticCacheMisses > 0 ||
    s.tierDowngrades > 0;

  if (!hasActivity) return "";

  const parts: string[] = [];

  if (s.promptCacheHits > 0 || s.promptCacheCreations > 0) {
    parts.push(
      `cache-reads=${s.promptCacheHits} cache-writes=${s.promptCacheCreations} tokens-saved=${s.cacheReadTokens}`,
    );
  }

  if (s.tierDowngrades > 0) {
    parts.push(`tier-downgrades=${s.tierDowngrades}`);
  }

  if (s.payloadTruncations > 0) {
    const kb = (s.charsSavedByTruncation / 1024).toFixed(1);
    parts.push(`truncations=${s.payloadTruncations} (${kb}KB saved)`);
  }

  const semanticTotal = s.semanticCacheHits + s.semanticCacheMisses;
  if (semanticTotal > 0) {
    parts.push(`semantic-hits=${s.semanticCacheHits}/${semanticTotal}`);
  }

  return `${pc.cyan("TOKEN OPTIMIZATION")} ${parts.join(" | ")}`;
}
