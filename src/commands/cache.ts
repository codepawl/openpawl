/**
 * CLI command: openpawl cache
 * Manage response cache: stats, clear, prune, enable/disable.
 */

import { logger } from "../core/logger.js";
import { ResponseCacheStore } from "../cache/cache-store.js";
import pc from "picocolors";

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const secs = Math.floor(ms / 1000);
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  const remSecs = secs % 60;
  return remSecs > 0 ? `${mins}m ${remSecs}s` : `${mins}m`;
}

function formatTimeAgo(ts: number): string {
  if (ts === 0) return "n/a";
  const diff = Date.now() - ts;
  const mins = Math.floor(diff / 60000);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days} day${days > 1 ? "s" : ""} ago`;
}

export async function runCacheCommand(args: string[]): Promise<void> {
  const sub = args[0];

  if (!sub || sub === "--help" || sub === "-h") {
    logger.plain("Usage: openpawl cache <subcommand>");
    logger.plain("");
    logger.plain("Subcommands:");
    logger.plain("  stats     Show cache hit rate, savings, and entry count");
    logger.plain("  clear     Remove all cache entries");
    logger.plain("  prune     Remove expired entries only");
    logger.plain("  disable   Disable response caching");
    logger.plain("  enable    Enable response caching");
    return;
  }

  const store = new ResponseCacheStore();

  if (sub === "stats") {
    const stats = await store.stats();
    const sep = pc.dim("━".repeat(41));
    logger.plain(sep);
    logger.plain(pc.bold("Response Cache Stats"));
    logger.plain(sep);
    logger.plain(`  Entries:      ${stats.totalEntries}`);
    logger.plain(`  Hit rate:     ${stats.totalEntries > 0 ? Math.round(stats.hitRate * 100) : 0}%`);
    logger.plain(`  Total hits:   ${stats.totalHits}`);
    logger.plain(`  Time saved:   ${formatDuration(stats.totalSavedMs)}`);
    logger.plain(`  Oldest entry: ${formatTimeAgo(stats.oldestEntry)}`);
    logger.plain(sep);
    return;
  }

  if (sub === "clear") {
    await store.clear();
    logger.success("Cache cleared.");
    return;
  }

  if (sub === "prune") {
    const pruned = await store.prune();
    if (pruned > 0) {
      logger.success(`Pruned ${pruned} expired cache entries.`);
    } else {
      logger.plain("No expired entries to prune.");
    }
    return;
  }

  if (sub === "disable") {
    const { readGlobalConfigWithDefaults, writeGlobalConfig } = await import("../core/global-config.js");
    const config = readGlobalConfigWithDefaults();
    (config as unknown as Record<string, unknown>).cacheEnabled = false;
    writeGlobalConfig(config);
    logger.success("Response caching disabled.");
    return;
  }

  if (sub === "enable") {
    const { readGlobalConfigWithDefaults, writeGlobalConfig } = await import("../core/global-config.js");
    const config = readGlobalConfigWithDefaults();
    (config as unknown as Record<string, unknown>).cacheEnabled = true;
    writeGlobalConfig(config);
    logger.success("Response caching enabled.");
    return;
  }

  logger.error(`Unknown cache subcommand: ${sub}`);
  logger.error("Run `openpawl cache --help` for usage.");
  process.exit(1);
}
