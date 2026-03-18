/**
 * Marketplace client — fetches templates from GitHub raw URLs.
 * Caches index.json at ~/.teamclaw/templates/cache/ with 1 hour TTL.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import type { TeamClawTemplate, TemplateIndex, TemplateIndexEntry } from "./types.js";
import { DEFAULT_MARKETPLACE_CONFIG } from "./types.js";

interface CacheEntry<T> {
  data: T;
  fetchedAt: number;
}

function getCacheDir(): string {
  return path.join(os.homedir(), ".teamclaw", "templates", "cache");
}

function ensureCacheDir(): void {
  const dir = getCacheDir();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

function readCache<T>(filename: string): CacheEntry<T> | null {
  const p = path.join(getCacheDir(), filename);
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, "utf-8")) as CacheEntry<T>;
  } catch {
    return null;
  }
}

function writeCache<T>(filename: string, data: T): void {
  ensureCacheDir();
  writeFileSync(
    path.join(getCacheDir(), filename),
    JSON.stringify({ data, fetchedAt: Date.now() }),
  );
}

export class MarketplaceClient {
  private baseUrl: string;
  private timeout: number;
  private cacheTtlMs: number;

  constructor(config?: Partial<typeof DEFAULT_MARKETPLACE_CONFIG>) {
    this.baseUrl = config?.baseUrl ?? DEFAULT_MARKETPLACE_CONFIG.baseUrl;
    this.timeout = config?.timeout ?? DEFAULT_MARKETPLACE_CONFIG.timeout;
    this.cacheTtlMs = config?.cacheTtlMs ?? DEFAULT_MARKETPLACE_CONFIG.cacheTtlMs;
  }

  async fetchIndex(): Promise<TemplateIndex> {
    // Check cache first
    const cached = readCache<TemplateIndex>("index.json");
    if (cached && Date.now() - cached.fetchedAt < this.cacheTtlMs) {
      return cached.data;
    }

    // Fetch from GitHub
    try {
      const res = await fetch(`${this.baseUrl}/index.json`, {
        signal: AbortSignal.timeout(this.timeout),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as TemplateIndex;
      writeCache("index.json", data);
      return data;
    } catch {
      // Fall back to stale cache
      if (cached) return cached.data;
      throw new Error("Failed to fetch marketplace index");
    }
  }

  async fetchTemplate(templatePath: string): Promise<TeamClawTemplate | null> {
    try {
      const res = await fetch(`${this.baseUrl}/${templatePath}`, {
        signal: AbortSignal.timeout(this.timeout),
      });
      if (!res.ok) return null;
      return (await res.json()) as TeamClawTemplate;
    } catch {
      return null;
    }
  }

  async fetchReadme(templateId: string): Promise<string | null> {
    try {
      const res = await fetch(
        `${this.baseUrl}/templates/${templateId}/README.md`,
        { signal: AbortSignal.timeout(this.timeout) },
      );
      if (!res.ok) return null;
      return await res.text();
    } catch {
      return null;
    }
  }

  searchIndex(index: TemplateIndex, query: string): TemplateIndexEntry[] {
    const q = query.toLowerCase();
    return index.templates.filter(
      (e) =>
        e.name.toLowerCase().includes(q) ||
        e.description.toLowerCase().includes(q) ||
        e.tags.some((t) => t.toLowerCase().includes(q)),
    );
  }

  filterByTag(index: TemplateIndex, tag: string): TemplateIndexEntry[] {
    return index.templates.filter((e) => e.tags.includes(tag));
  }

  sortTemplates(entries: TemplateIndexEntry[], field: string): TemplateIndexEntry[] {
    const sorted = [...entries];
    if (field === "downloads") sorted.sort((a, b) => b.downloads - a.downloads);
    else if (field === "stars") sorted.sort((a, b) => b.stars - a.stars);
    else sorted.sort((a, b) => a.name.localeCompare(b.name));
    return sorted;
  }
}
