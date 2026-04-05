/**
 * Hash-based file content cache — avoids re-reading unchanged files.
 */

import { stat } from "node:fs/promises";
import { createHash } from "node:crypto";

export interface CachedFile {
  content: string;
  hash: string;
  mtime: number;
  cachedAt: number;
}

const MAX_ENTRIES = 100;

export class FileContentCache {
  private cache = new Map<string, CachedFile>();
  private accessOrder: string[] = [];
  private hits = 0;
  private misses = 0;

  async get(filePath: string): Promise<CachedFile | null> {
    const cached = this.cache.get(filePath);
    if (!cached) {
      this.misses++;
      return null;
    }

    // Check mtime
    try {
      const s = await stat(filePath);
      if (s.mtimeMs !== cached.mtime) {
        this.cache.delete(filePath);
        this.misses++;
        return null;
      }
    } catch {
      this.cache.delete(filePath);
      this.misses++;
      return null;
    }

    this.hits++;
    this.touchAccess(filePath);
    return cached;
  }

  async set(filePath: string, content: string): Promise<void> {
    try {
      const s = await stat(filePath);
      const hash = createHash("sha256").update(content).digest("hex").slice(0, 16);

      this.cache.set(filePath, {
        content,
        hash,
        mtime: s.mtimeMs,
        cachedAt: Date.now(),
      });

      this.touchAccess(filePath);
      this.evictIfNeeded();
    } catch { /* skip */ }
  }

  invalidate(filePath: string): void {
    this.cache.delete(filePath);
  }

  invalidateAll(): void {
    this.cache.clear();
    this.accessOrder = [];
  }

  getStats(): { entries: number; hitRate: number } {
    const total = this.hits + this.misses;
    return { entries: this.cache.size, hitRate: total > 0 ? this.hits / total : 0 };
  }

  private touchAccess(filePath: string): void {
    this.accessOrder = this.accessOrder.filter((p) => p !== filePath);
    this.accessOrder.push(filePath);
  }

  private evictIfNeeded(): void {
    while (this.cache.size > MAX_ENTRIES && this.accessOrder.length > 0) {
      const oldest = this.accessOrder.shift()!;
      this.cache.delete(oldest);
    }
  }
}
