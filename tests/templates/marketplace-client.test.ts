import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { MarketplaceClient } from "@/templates/marketplace-client.js";
import type { TemplateIndex, TeamClawTemplate } from "@/templates/types.js";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DIR = path.join(os.tmpdir(), "teamclaw-test-marketplace-" + Date.now());
const originalHomedir = os.homedir;

const mockIndex: TemplateIndex = {
  version: "0.0.1",
  updatedAt: "2026-03-18",
  templates: [
    {
      id: "content-creator",
      name: "Content Creator Team",
      description: "Research → Script → SEO → Review pipeline",
      author: "nxank4",
      version: "0.0.1",
      tags: ["content", "youtube", "social-media"],
      estimatedCostPerRun: 0.07,
      stars: 142,
      downloads: 891,
      createdAt: "2026-03-18",
      path: "templates/content-creator/template.json",
    },
    {
      id: "indie-hacker",
      name: "Indie Hacker Team",
      description: "Architect → Engineer → QA → RFC pipeline",
      author: "nxank4",
      version: "0.0.1",
      tags: ["coding", "saas"],
      estimatedCostPerRun: 0.12,
      stars: 89,
      downloads: 445,
      createdAt: "2026-03-18",
      path: "templates/indie-hacker/template.json",
    },
  ],
};

describe("MarketplaceClient", () => {
  beforeEach(() => {
    process.env.HOME = TEST_DIR;
    mkdirSync(TEST_DIR, { recursive: true });
  });

  afterEach(() => {
    process.env.HOME = originalHomedir();
    if (existsSync(TEST_DIR)) {
      rmSync(TEST_DIR, { recursive: true, force: true });
    }
    vi.restoreAllMocks();
  });

  it("fetches and parses index.json correctly", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(mockIndex),
    }));

    const client = new MarketplaceClient();
    const index = await client.fetchIndex();

    expect(index.version).toBe("0.0.1");
    expect(index.templates).toHaveLength(2);
    expect(index.templates[0].id).toBe("content-creator");
  });

  it("falls back to cache when GitHub unreachable", async () => {
    // Pre-populate cache
    const cacheDir = path.join(TEST_DIR, ".teamclaw", "templates", "cache");
    mkdirSync(cacheDir, { recursive: true });
    writeFileSync(
      path.join(cacheDir, "index.json"),
      JSON.stringify({ data: mockIndex, fetchedAt: Date.now() - 2 * 60 * 60 * 1000 }),
    );

    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("Network error")));

    const client = new MarketplaceClient();
    const index = await client.fetchIndex();

    expect(index.templates).toHaveLength(2);
    expect(index.templates[0].id).toBe("content-creator");
  });

  it("returns stale cache within TTL", async () => {
    // Pre-populate fresh cache (within 1 hour)
    const cacheDir = path.join(TEST_DIR, ".teamclaw", "templates", "cache");
    mkdirSync(cacheDir, { recursive: true });
    writeFileSync(
      path.join(cacheDir, "index.json"),
      JSON.stringify({ data: mockIndex, fetchedAt: Date.now() - 30 * 60 * 1000 }),
    );

    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const client = new MarketplaceClient();
    const index = await client.fetchIndex();

    expect(fetchMock).not.toHaveBeenCalled();
    expect(index.templates).toHaveLength(2);
  });

  it("throws when no cache and GitHub unreachable", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("Network error")));

    const client = new MarketplaceClient();
    await expect(client.fetchIndex()).rejects.toThrow("Failed to fetch marketplace index");
  });

  it("searches index by query", () => {
    const client = new MarketplaceClient();

    const results = client.searchIndex(mockIndex, "youtube");
    expect(results).toHaveLength(1);
    expect(results[0].id).toBe("content-creator");
  });

  it("searches by description", () => {
    const client = new MarketplaceClient();
    const results = client.searchIndex(mockIndex, "RFC");
    expect(results).toHaveLength(1);
    expect(results[0].id).toBe("indie-hacker");
  });

  it("filters by tag", () => {
    const client = new MarketplaceClient();
    const results = client.filterByTag(mockIndex, "coding");
    expect(results).toHaveLength(1);
    expect(results[0].id).toBe("indie-hacker");
  });

  it("sorts by downloads", () => {
    const client = new MarketplaceClient();
    const sorted = client.sortTemplates(mockIndex.templates, "downloads");
    expect(sorted[0].id).toBe("content-creator");
    expect(sorted[1].id).toBe("indie-hacker");
  });

  it("sorts by stars", () => {
    const client = new MarketplaceClient();
    const sorted = client.sortTemplates(mockIndex.templates, "stars");
    expect(sorted[0].id).toBe("content-creator");
  });

  it("sorts by name", () => {
    const client = new MarketplaceClient();
    const sorted = client.sortTemplates(mockIndex.templates, "name");
    expect(sorted[0].id).toBe("content-creator");
    expect(sorted[1].id).toBe("indie-hacker");
  });
});
