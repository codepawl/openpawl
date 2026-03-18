/**
 * CLI command: teamclaw clean
 * Removes session data; preserves global memory by default.
 */

import { rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { logger } from "../core/logger.js";
import { isCancel, confirm } from "@clack/prompts";

export async function runClean(args: string[]): Promise<void> {
  const includeGlobal = args.includes("--include-global");
  const keepCache = args.includes("--keep-cache");

  // Session data paths
  const sessionPaths = [
    "dist",
    "data/vector_store",
  ];

  let removedAny = false;
  for (const rel of sessionPaths) {
    const abs = path.resolve(process.cwd(), rel);
    if (existsSync(abs)) {
      await rm(abs, { recursive: true, force: true });
      logger.plain(`  Removed ${rel}/`);
      removedAny = true;
    }
  }

  if (!removedAny) {
    logger.plain("No session data to clean.");
  }

  if (includeGlobal) {
    const globalPath = path.join(os.homedir(), ".teamclaw", "memory");
    if (existsSync(globalPath)) {
      const canPrompt = Boolean(process.stdout.isTTY && process.stderr.isTTY);
      if (canPrompt) {
        const confirmed = await confirm({
          message: `This will permanently delete global memory at ${globalPath}. Continue?`,
        });
        if (isCancel(confirmed) || !confirmed) {
          logger.plain("Skipped global memory removal.");
          return;
        }
      }
      await rm(globalPath, { recursive: true, force: true });
      logger.plain(`  Removed global memory at ${globalPath}`);
    } else {
      logger.plain("No global memory to clean.");
    }
  } else {
    logger.plain("  Global memory preserved (use --include-global to also remove).");
  }

  // Clear response cache unless --keep-cache
  if (!keepCache) {
    const cachePath = path.join(os.homedir(), ".teamclaw", "cache");
    if (existsSync(cachePath)) {
      await rm(cachePath, { recursive: true, force: true });
      logger.plain("  Removed response cache.");
    }
  } else {
    logger.plain("  Response cache preserved (--keep-cache).");
  }
}
