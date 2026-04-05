/**
 * Exact-match response cache for identical prompts + context.
 */

export interface CacheKey {
  prompt: string;
  systemPromptHash: string;
  modelName: string;
  agentId: string;
}

export interface CachedResponse {
  content: string;
  tokenCount: number;
  cachedAt: number;
}

export class ResponseCache {
  private cache = new Map<string, { response: CachedResponse; expiresAt: number }>();
  private hits = 0;
  private misses = 0;

  async get(key: CacheKey): Promise<CachedResponse | null> {
    const k = this.hashKey(key);
    const entry = this.cache.get(k);
    if (!entry || Date.now() > entry.expiresAt) {
      if (entry) this.cache.delete(k);
      this.misses++;
      return null;
    }
    this.hits++;
    return entry.response;
  }

  async set(key: CacheKey, response: CachedResponse, ttlMs = 300_000): Promise<void> {
    const k = this.hashKey(key);
    this.cache.set(k, { response, expiresAt: Date.now() + ttlMs });
  }

  invalidate(pattern: string): void {
    for (const [k] of this.cache) {
      if (k.includes(pattern)) this.cache.delete(k);
    }
  }

  getStats(): { entries: number; hitRate: number; sizeMB: number } {
    const total = this.hits + this.misses;
    return {
      entries: this.cache.size,
      hitRate: total > 0 ? this.hits / total : 0,
      sizeMB: 0, // Approximate — would need deep size calculation
    };
  }

  clear(): void {
    this.cache.clear();
    this.hits = 0;
    this.misses = 0;
  }

  private hashKey(key: CacheKey): string {
    return `${key.agentId}:${key.modelName}:${key.systemPromptHash}:${key.prompt}`;
  }
}
