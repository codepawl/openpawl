/**
 * Types for response caching.
 */

export interface CacheEntry {
  key: string;
  prompt: string;
  model: string;
  agentRole: string;
  response: string;
  confidence?: number;
  tokensUsed: number;
  hitCount: number;
  createdAt: number;
  lastHitAt: number;
  expiresAt: number;
}

export interface CacheStats {
  totalEntries: number;
  totalHits: number;
  totalSavedMs: number;
  hitRate: number;
  oldestEntry: number;
  newestEntry: number;
}

export interface SessionCacheStats {
  hits: number;
  misses: number;
  savedMs: number;
}


/** TTL by agent role (milliseconds) */
export const CACHE_TTL: Record<string, number> = {
  "sprint-planner": 24 * 60 * 60 * 1000,
  "coordinator": 12 * 60 * 60 * 1000,
  "tech-lead": 6 * 60 * 60 * 1000,
  "rfc-author": 6 * 60 * 60 * 1000,
  "worker-bot": 1 * 60 * 60 * 1000,
  "qa-reviewer": 30 * 60 * 1000,
  "default": 2 * 60 * 60 * 1000,
};

/** Roles whose responses must never be cached */
export const NEVER_CACHE_ROLES = new Set([
  "human-approval",
  "post-mortem",
  "retrospective",
  "qa-reviewer",
]);

/** Minimum response length to cache (short responses are likely errors) */
export const MIN_CACHE_RESPONSE_LENGTH = 50;
