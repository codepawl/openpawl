/**
 * Streak tracking via LanceDB activity_streak table.
 * Uses vector: [0] placeholder — no embeddings needed.
 */

import type { Connection, Table } from "@lancedb/lancedb";
import type { StreakEntry } from "./types.js";

export class StreakTracker {
  private table: Table | null = null;

  async init(db: Connection): Promise<void> {
    try {
      this.table = await db.openTable("activity_streak");
    } catch {
      // Table doesn't exist yet — create it
      this.table = await db.createTable("activity_streak", [
        { date: "1970-01-01", sessionCount: 0, recordedAt: 0, vector: [0] },
      ]);
      // Remove the seed row
      await this.table.delete('date = "1970-01-01"');
    }
  }

  async recordDay(date: string, sessionCount: number): Promise<void> {
    if (!this.table) return;
    // Upsert: delete existing then add
    try {
      await this.table.delete(`date = "${date}"`);
    } catch {
      // May not exist
    }
    await this.table.add([
      { date, sessionCount, recordedAt: Date.now(), vector: [0] },
    ]);
  }

  async getCurrentStreak(): Promise<number> {
    if (!this.table) return 0;
    const rows = await this.table.query().toArray();
    if (rows.length === 0) return 0;

    // Sort by date descending
    const sorted = rows
      .map((r) => ({ date: r.date as string, recordedAt: r.recordedAt as number }))
      .sort((a, b) => b.date.localeCompare(a.date));

    // Check if the most recent entry is within 48h of now
    const now = Date.now();
    const msIn48h = 48 * 60 * 60 * 1000;
    const mostRecentDate = new Date(sorted[0]!.date + "T00:00:00");
    if (now - mostRecentDate.getTime() > msIn48h) return 0;

    // Count consecutive days (allowing 48h gap between each)
    let streak = 1;
    for (let i = 1; i < sorted.length; i++) {
      const current = new Date(sorted[i]!.date + "T00:00:00");
      const previous = new Date(sorted[i - 1]!.date + "T00:00:00");
      const gap = previous.getTime() - current.getTime();
      if (gap <= msIn48h) {
        streak++;
      } else {
        break;
      }
    }

    return streak;
  }

  async getWeekEntries(mondayDate: string): Promise<StreakEntry[]> {
    if (!this.table) return [];
    const rows = await this.table.query().toArray();
    const monday = new Date(mondayDate + "T00:00:00");
    const sunday = new Date(monday);
    sunday.setDate(sunday.getDate() + 6);
    const mondayStr = mondayDate;
    const sundayStr = sunday.toISOString().slice(0, 10);

    return rows
      .filter((r) => {
        const d = r.date as string;
        return d >= mondayStr && d <= sundayStr;
      })
      .map((r) => ({
        date: r.date as string,
        sessionCount: r.sessionCount as number,
        recordedAt: r.recordedAt as number,
      }));
  }
}
