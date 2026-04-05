/**
 * Query and aggregate audit entries.
 */

import { createReadStream, existsSync } from "node:fs";
import { createInterface } from "node:readline";
import path from "node:path";
import os from "node:os";
import type { ToolAuditEntry as AuditEntry, ToolAuditQuery as AuditQuery, ToolAuditStats as AuditStats } from "./tool-audit-types.js";

export class AuditQuerier {
  private logPath: string;

  constructor(logDir?: string) {
    const dir = logDir ?? path.join(os.homedir(), ".openpawl");
    this.logPath = path.join(dir, "audit.jsonl");
  }

  async query(filters: AuditQuery): Promise<AuditEntry[]> {
    const limit = filters.limit ?? 100;
    const results: AuditEntry[] = [];

    await this.readEntries((entry) => {
      if (results.length >= limit) return false;
      if (matchesFilters(entry, filters)) {
        results.push(entry);
      }
      return true;
    });

    return results;
  }

  async aggregate(filters: AuditQuery): Promise<AuditStats> {
    const stats: AuditStats = {
      totalEntries: 0,
      byTool: {},
      byAgent: {},
      byCategory: {},
      successRate: 0,
      averageDuration: 0,
      totalAlerts: 0,
      filesModifiedCount: 0,
      topModifiedFiles: [],
    };

    let successCount = 0;
    let totalDuration = 0;
    const fileModCounts = new Map<string, number>();

    await this.readEntries((entry) => {
      if (!matchesFilters(entry, filters)) return true;

      stats.totalEntries++;
      stats.byTool[entry.toolName] = (stats.byTool[entry.toolName] ?? 0) + 1;
      stats.byAgent[entry.agentId] = (stats.byAgent[entry.agentId] ?? 0) + 1;
      stats.byCategory[entry.category] = (stats.byCategory[entry.category] ?? 0) + 1;
      if (entry.success) successCount++;
      totalDuration += entry.duration;
      stats.totalAlerts += entry.injectionAlerts + entry.chainAlerts;

      for (const file of entry.filesModified) {
        fileModCounts.set(file, (fileModCounts.get(file) ?? 0) + 1);
        stats.filesModifiedCount++;
      }

      return true;
    });

    stats.successRate = stats.totalEntries > 0 ? successCount / stats.totalEntries : 0;
    stats.averageDuration = stats.totalEntries > 0 ? totalDuration / stats.totalEntries : 0;
    stats.topModifiedFiles = [...fileModCounts.entries()]
      .map(([p, count]) => ({ path: p, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 10);

    return stats;
  }

  async recent(count: number): Promise<AuditEntry[]> {
    const all: AuditEntry[] = [];
    await this.readEntries((entry) => { all.push(entry); return true; });
    return all.slice(-count);
  }

  private async readEntries(callback: (entry: AuditEntry) => boolean): Promise<void> {
    if (!existsSync(this.logPath)) return;

    const stream = createReadStream(this.logPath, "utf-8");
    const rl = createInterface({ input: stream, crlfDelay: Infinity });

    for await (const line of rl) {
      if (!line.trim()) continue;
      try {
        const entry = JSON.parse(line) as AuditEntry;
        if (!callback(entry)) break;
      } catch { /* skip malformed */ }
    }
  }
}

function matchesFilters(entry: AuditEntry, filters: AuditQuery): boolean {
  if (filters.sessionId && entry.sessionId !== filters.sessionId) return false;
  if (filters.agentId && entry.agentId !== filters.agentId) return false;
  if (filters.toolName && entry.toolName !== filters.toolName) return false;
  if (filters.category && entry.category !== filters.category) return false;
  if (filters.success !== undefined && entry.success !== filters.success) return false;
  if (filters.hasAlerts && entry.injectionAlerts + entry.chainAlerts === 0) return false;

  if (filters.since) {
    const sinceDate = parseRelativeTime(filters.since);
    if (sinceDate && new Date(entry.timestamp) < sinceDate) return false;
  }

  return true;
}

function parseRelativeTime(value: string): Date | null {
  const match = value.match(/^(\d+)([smhd])$/);
  if (!match) {
    try { return new Date(value); } catch { return null; }
  }
  const [, num, unit] = match;
  const ms = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 }[unit!] ?? 0;
  return new Date(Date.now() - Number(num) * ms);
}
