import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { StreakTracker } from "@/standup/streak.js";

function createMockTable() {
  let rows: Array<Record<string, unknown>> = [];
  return {
    add: vi.fn(async (data: Array<Record<string, unknown>>) => {
      rows.push(...data);
    }),
    delete: vi.fn(async (filter: string) => {
      const match = filter.match(/date = "(.+)"/);
      if (match) rows = rows.filter((r) => r.date !== match[1]);
    }),
    query: vi.fn(() => ({
      toArray: vi.fn(async () => [...rows]),
    })),
  };
}

function createMockConnection(table: ReturnType<typeof createMockTable>) {
  return {
    openTable: vi.fn(async () => table),
    createTable: vi.fn(async () => table),
  };
}

describe("StreakTracker", () => {
  let tracker: StreakTracker;
  let table: ReturnType<typeof createMockTable>;
  let connection: ReturnType<typeof createMockConnection>;

  beforeEach(() => {
    vi.useFakeTimers();
    // Set "now" to 2026-03-18 12:00 UTC
    vi.setSystemTime(new Date("2026-03-18T12:00:00Z"));
    tracker = new StreakTracker();
    table = createMockTable();
    connection = createMockConnection(table);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("initializes by opening existing table", async () => {
    await tracker.init(connection as never);
    expect(connection.openTable).toHaveBeenCalledWith("activity_streak");
    expect(connection.createTable).not.toHaveBeenCalled();
  });

  it("creates table when openTable fails", async () => {
    connection.openTable.mockRejectedValueOnce(new Error("not found"));
    await tracker.init(connection as never);
    expect(connection.createTable).toHaveBeenCalledWith(
      "activity_streak",
      expect.any(Array),
    );
  });

  it("increments streak for consecutive days", async () => {
    await tracker.init(connection as never);
    await tracker.recordDay("2026-03-16", 2, 0.5);
    await tracker.recordDay("2026-03-17", 1, 0.3);
    await tracker.recordDay("2026-03-18", 3, 1.0);

    const streak = await tracker.getCurrentStreak();
    expect(streak).toBe(3);
  });

  it("resets after 48h gap, not 24h", async () => {
    await tracker.init(connection as never);
    // Entry on March 15, then skip March 16 and 17, entry on March 18
    // Gap between 15 and 18 is 3 days (72h) > 48h, so streak should reset
    await tracker.recordDay("2026-03-15", 1, 0.2);
    await tracker.recordDay("2026-03-18", 1, 0.4);

    const streak = await tracker.getCurrentStreak();
    expect(streak).toBe(1);
  });

  it("does not reset for a 24h gap (within 48h tolerance)", async () => {
    await tracker.init(connection as never);
    // March 16 then March 18 — gap is 2 days (48h), should still count
    await tracker.recordDay("2026-03-16", 1, 0.2);
    await tracker.recordDay("2026-03-18", 1, 0.4);

    const streak = await tracker.getCurrentStreak();
    expect(streak).toBe(2);
  });

  it("does not reset for same-day multiple sessions", async () => {
    await tracker.init(connection as never);
    // Record same day twice — upsert replaces the first entry
    await tracker.recordDay("2026-03-18", 1, 0.3);
    await tracker.recordDay("2026-03-18", 2, 0.6);

    const streak = await tracker.getCurrentStreak();
    expect(streak).toBe(1);
  });

  it("returns 0 for empty table", async () => {
    await tracker.init(connection as never);

    const streak = await tracker.getCurrentStreak();
    expect(streak).toBe(0);
  });

  it("returns 0 when most recent entry is older than 48h", async () => {
    await tracker.init(connection as never);
    // Record an entry 3 days ago — older than 48h from "now"
    await tracker.recordDay("2026-03-15", 1, 0.2);

    const streak = await tracker.getCurrentStreak();
    expect(streak).toBe(0);
  });

  it("getWeekEntries returns entries for Mon-Sun range", async () => {
    await tracker.init(connection as never);
    await tracker.recordDay("2026-03-16", 2, 0.5); // Monday
    await tracker.recordDay("2026-03-17", 1, 0.3); // Tuesday
    await tracker.recordDay("2026-03-18", 3, 1.0); // Wednesday
    await tracker.recordDay("2026-03-23", 1, 0.1); // Next Monday (outside range)

    const entries = await tracker.getWeekEntries("2026-03-16");
    expect(entries).toHaveLength(3);
    expect(entries.map((e) => e.date)).toEqual([
      "2026-03-16",
      "2026-03-17",
      "2026-03-18",
    ]);
  });
});
