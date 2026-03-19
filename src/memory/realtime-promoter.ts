/**
 * Real-time memory promotion — promotes high-signal scratchpad discoveries
 * to global memory mid-sprint, without waiting for sprint end.
 */

import type { ScratchpadEntry } from "./sprint-scratchpad.js";
import type { GlobalMemoryManager } from "./global/store.js";
import type { HttpEmbeddingFunction } from "../core/knowledge-base.js";
import { clearSprintScratchpad, type SprintScratchpad } from "./sprint-scratchpad.js";
import { logger, isDebugMode } from "../core/logger.js";

function log(msg: string): void {
  if (isDebugMode()) {
    logger.info(msg);
  }
}

const PROVISIONAL_TABLE = "provisional_memories";

export interface ProvisionalMemory {
  id: string;
  sprintId: string;
  content: string;
  tags: string[];
  confidence: number;
  provisional: boolean;
  createdAt: number;
}

/**
 * Promote a scratchpad discovery to global memory if it meets criteria:
 * 1. Corroborated by 2+ agents (readBy.length >= 2)
 * 2. High-signal type (decision or warning)
 * 3. Not already in provisional memory for this sprint
 */
export async function maybePromoteDiscovery(
  entry: ScratchpadEntry,
  globalManager: GlobalMemoryManager,
  embedder: HttpEmbeddingFunction,
): Promise<boolean> {
  const isCorroborated = entry.readBy.length >= 2;
  const isHighSignal = entry.type === "decision" || entry.type === "warning";

  if (!isCorroborated || !isHighSignal) return false;

  const db = globalManager.getDb();
  if (!db) return false;

  // Check if already promoted from this sprint
  try {
    const tableNames = await db.tableNames();
    if (tableNames.includes(PROVISIONAL_TABLE)) {
      const table = await db.openTable(PROVISIONAL_TABLE);
      const existing = (await table
        .query()
        .where(`id = '${entry.id.replace(/'/g, "''")}'`)
        .toArray()) as Array<Record<string, unknown>>;
      if (existing.length > 0) return false;
    }
  } catch {
    // Proceed with promotion attempt
  }

  // Write provisional memory
  try {
    const embedding = (await embedder.generate([entry.content]))[0] ?? [];
    const row = {
      id: entry.id,
      sprint_id: entry.sprintId,
      content: entry.content,
      tags_json: JSON.stringify(entry.tags),
      confidence: 0.7,
      provisional: 1,
      created_at: Date.now(),
      vector: embedding.length > 0 ? embedding : [0],
    };

    const tableNames = await db.tableNames();
    if (!tableNames.includes(PROVISIONAL_TABLE)) {
      await db.createTable(PROVISIONAL_TABLE, [row]);
    } else {
      const table = await db.openTable(PROVISIONAL_TABLE);
      await table.add([row]);
    }

    log(`Promoted discovery to provisional global memory: "${entry.content.slice(0, 60)}..."`);
    return true;
  } catch (err) {
    log(`Failed to promote discovery: ${err}`);
    return false;
  }
}

/**
 * At sprint end — confirm or reject provisional memories based on sprint outcome.
 * On success: bump confidence to 0.9, mark as confirmed.
 * On failure: remove provisional memories — patterns may be wrong.
 */
export async function finalizeSprintMemories(
  sprintId: string,
  sprintSuccessful: boolean,
  globalManager: GlobalMemoryManager,
  _scratchpad: SprintScratchpad | null,
): Promise<{ confirmed: number; removed: number }> {
  const result = { confirmed: 0, removed: 0 };
  const db = globalManager.getDb();
  if (!db) return result;

  try {
    const tableNames = await db.tableNames();
    if (!tableNames.includes(PROVISIONAL_TABLE)) return result;

    const table = await db.openTable(PROVISIONAL_TABLE);
    const rows = (await table
      .query()
      .where(`sprint_id = '${sprintId}'`)
      .toArray()) as Array<Record<string, unknown>>;

    if (sprintSuccessful) {
      // Confirm: update confidence and mark as non-provisional
      for (const row of rows) {
        const id = String(row.id ?? "");
        if (!id) continue;
        try {
          await table.delete(`id = '${id.replace(/'/g, "''")}'`);
          await table.add([{ ...row, confidence: 0.9, provisional: 0 }]);
          result.confirmed++;
        } catch {
          // Skip individual row failures
        }
      }
      log(`Confirmed ${result.confirmed} provisional memories for sprint ${sprintId}`);
    } else {
      // Remove all provisional memories from failed sprint
      for (const row of rows) {
        const id = String(row.id ?? "");
        if (!id) continue;
        try {
          await table.delete(`id = '${id.replace(/'/g, "''")}'`);
          result.removed++;
        } catch {
          // Skip individual row failures
        }
      }
      log(`Removed ${result.removed} provisional memories for failed sprint ${sprintId}`);
    }
  } catch (err) {
    log(`Failed to finalize sprint memories: ${err}`);
  }

  // Clean up scratchpad singleton
  clearSprintScratchpad(sprintId);

  return result;
}
