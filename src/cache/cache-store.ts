/**
 * Response cache store — filesystem-first with LanceDB for analytics.
 *
 * Filesystem at ~/.openpawl/cache/<key>.json is the primary read path (fast).
 * LanceDB table `response_cache` is for management and aggregate stats.
 */

import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { CacheEntry, CacheStats } from "./types.js";

const CACHE_DIR = path.join(os.homedir(), ".openpawl", "cache");

/**
 * Build a deterministic cache key from prompt + model + agent role.
 * Normalizes: lowercase, collapse whitespace, strip timestamps.
 */
export function buildCacheKey(prompt: string, model: string, role: string): string {
  // Strip ISO timestamps (2024-01-15T10:30:00.000Z patterns)
  const noTimestamps = prompt.replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[.\dZ]*/g, "");
  // Strip unix timestamps (13-digit numbers)
  const noUnix = noTimestamps.replace(/\b\d{13}\b/g, "");
  const normalized = noUnix.toLowerCase().trim().replace(/\s+/g, " ");
  const input = `${normalized}|${model}|${role}`;
  return crypto.createHash("sha256").update(input).digest("hex");
}

/**
 * Check if a prompt contains session-specific IDs that should prevent caching.
 */
export function hasSessionSpecificContent(prompt: string): boolean {
  // UUID patterns (session IDs)
  if (/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i.test(prompt)) return true;
  // ISO timestamps
  if (/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/i.test(prompt)) return true;
  return false;
}

function entryPath(key: string): string {
  return path.join(CACHE_DIR, `${key}.json`);
}

export class ResponseCacheStore {
  private initialized = false;

  async init(): Promise<void> {
    if (this.initialized) return;
    await fsp.mkdir(CACHE_DIR, { recursive: true });
    this.initialized = true;
  }

  async get(key: string): Promise<CacheEntry | null> {
    const fp = entryPath(key);
    try {
      const raw = await fsp.readFile(fp, "utf-8");
      const entry = JSON.parse(raw) as CacheEntry;
      if (Date.now() > entry.expiresAt) {
        // Expired — clean up async
        fsp.unlink(fp).catch(() => {});
        return null;
      }
      // Update hit count and lastHitAt
      entry.hitCount += 1;
      entry.lastHitAt = Date.now();
      // Write updated entry async (don't block)
      fsp.writeFile(fp, JSON.stringify(entry), "utf-8").catch(() => {});
      return entry;
    } catch {
      return null;
    }
  }

  async set(entry: CacheEntry): Promise<void> {
    await this.init();
    const fp = entryPath(entry.key);
    await fsp.writeFile(fp, JSON.stringify(entry), "utf-8");
  }

  async delete(key: string): Promise<void> {
    const fp = entryPath(key);
    try {
      await fsp.unlink(fp);
    } catch {
      // Already deleted or never existed
    }
  }

  async clear(): Promise<void> {
    try {
      const files = await fsp.readdir(CACHE_DIR);
      await Promise.all(
        files
          .filter((f) => f.endsWith(".json"))
          .map((f) => fsp.unlink(path.join(CACHE_DIR, f)).catch(() => {})),
      );
    } catch {
      // Directory may not exist
    }
  }

  async prune(): Promise<number> {
    const now = Date.now();
    let pruned = 0;
    try {
      const files = await fsp.readdir(CACHE_DIR);
      for (const file of files) {
        if (!file.endsWith(".json")) continue;
        const fp = path.join(CACHE_DIR, file);
        try {
          const raw = await fsp.readFile(fp, "utf-8");
          const entry = JSON.parse(raw) as CacheEntry;
          if (now > entry.expiresAt) {
            await fsp.unlink(fp);
            pruned++;
          }
        } catch {
          // Corrupt entry — remove it
          await fsp.unlink(fp).catch(() => {});
          pruned++;
        }
      }
    } catch {
      // Directory may not exist
    }
    return pruned;
  }

  async stats(): Promise<CacheStats> {
    const result: CacheStats = {
      totalEntries: 0,
      totalHits: 0,
      totalSavedMs: 0,
      hitRate: 0,
      oldestEntry: 0,
      newestEntry: 0,
    };

    try {
      const files = await fsp.readdir(CACHE_DIR);
      let totalMisses = 0;
      for (const file of files) {
        if (!file.endsWith(".json")) continue;
        try {
          const raw = await fsp.readFile(path.join(CACHE_DIR, file), "utf-8");
          const entry = JSON.parse(raw) as CacheEntry;
          if (Date.now() > entry.expiresAt) continue; // Skip expired
          result.totalEntries++;
          result.totalHits += entry.hitCount;
          // Estimate ~3s saved per cache hit
          result.totalSavedMs += entry.hitCount * 3000;
          if (result.oldestEntry === 0 || entry.createdAt < result.oldestEntry) {
            result.oldestEntry = entry.createdAt;
          }
          if (entry.createdAt > result.newestEntry) {
            result.newestEntry = entry.createdAt;
          }
          // Count first write as a miss
          totalMisses++;
        } catch {
          // Skip corrupt entries
        }
      }
      const total = result.totalHits + totalMisses;
      result.hitRate = total > 0 ? result.totalHits / total : 0;
    } catch {
      // Directory may not exist
    }

    return result;
  }

  /**
   * List all valid (non-expired) cache entries.
   */
  async list(): Promise<CacheEntry[]> {
    const entries: CacheEntry[] = [];
    const now = Date.now();
    try {
      const files = await fsp.readdir(CACHE_DIR);
      for (const file of files) {
        if (!file.endsWith(".json")) continue;
        try {
          const raw = await fsp.readFile(path.join(CACHE_DIR, file), "utf-8");
          const entry = JSON.parse(raw) as CacheEntry;
          if (now <= entry.expiresAt) entries.push(entry);
        } catch {
          // Skip corrupt
        }
      }
    } catch {
      // Directory may not exist
    }
    return entries;
  }

  /** Check if the cache directory exists with entries */
  exists(): boolean {
    try {
      return fs.existsSync(CACHE_DIR) && fs.readdirSync(CACHE_DIR).some((f) => f.endsWith(".json"));
    } catch {
      return false;
    }
  }
}
