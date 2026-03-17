/**
 * LLM Response Cache - LRU+TTL in-memory cache for generate() responses.
 *
 * Avoids redundant API calls in multi-run work sessions where planning-phase
 * agents produce identical prompts across runs.
 */

import { createHash } from "node:crypto";

export interface LlmCacheConfig {
  maxEntries: number;
  ttlMs: number;
}

interface CacheEntry {
  response: string;
  createdAt: number;
  promptChars: number;
  model: string;
}

export interface CacheStats {
  hits: number;
  misses: number;
  evictions: number;
  size: number;
  estimatedSavedChars: number;
}

const DEFAULT_CONFIG: LlmCacheConfig = {
  maxEntries: 128,
  ttlMs: 30 * 60 * 1000, // 30 minutes
};

export class LlmCache {
  private store = new Map<string, CacheEntry>();
  private readonly maxEntries: number;
  private readonly ttlMs: number;
  private stats: CacheStats = {
    hits: 0,
    misses: 0,
    evictions: 0,
    size: 0,
    estimatedSavedChars: 0,
  };

  constructor(config: Partial<LlmCacheConfig> = {}) {
    const cfg = { ...DEFAULT_CONFIG, ...config };
    this.maxEntries = cfg.maxEntries;
    this.ttlMs = cfg.ttlMs;
  }

  buildKey(prompt: string, model: string, temperature: number): string {
    return createHash("sha256")
      .update(prompt + "\0" + model + "\0" + temperature.toFixed(4))
      .digest("hex");
  }

  get(key: string): string | null {
    const entry = this.store.get(key);
    if (!entry) {
      this.stats.misses++;
      return null;
    }

    if (entry.createdAt + this.ttlMs <= Date.now()) {
      this.store.delete(key);
      this.stats.size = this.store.size;
      this.stats.misses++;
      return null;
    }

    // LRU: delete and re-insert to move to end
    this.store.delete(key);
    this.store.set(key, entry);

    this.stats.hits++;
    this.stats.estimatedSavedChars += entry.promptChars;
    return entry.response;
  }

  set(key: string, response: string, promptChars: number, model: string): void {
    // If key already exists, delete first to refresh position
    if (this.store.has(key)) {
      this.store.delete(key);
    }

    // Evict oldest if at capacity
    while (this.store.size >= this.maxEntries) {
      const oldest = this.store.keys().next().value;
      if (oldest !== undefined) {
        this.store.delete(oldest);
        this.stats.evictions++;
      }
    }

    this.store.set(key, {
      response,
      createdAt: Date.now(),
      promptChars,
      model,
    });
    this.stats.size = this.store.size;
  }

  getStats(): CacheStats {
    this.stats.size = this.store.size;
    return { ...this.stats };
  }

  clear(): void {
    this.store.clear();
    this.stats = {
      hits: 0,
      misses: 0,
      evictions: 0,
      size: 0,
      estimatedSavedChars: 0,
    };
  }
}

let globalCache: LlmCache | null = null;

export function getLlmCache(config?: Partial<LlmCacheConfig>): LlmCache {
  if (!globalCache) {
    globalCache = new LlmCache(config);
  }
  return globalCache;
}

export function resetLlmCache(): void {
  globalCache = null;
}
