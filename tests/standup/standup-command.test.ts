import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/core/logger.js", () => ({
  logger: { plain: vi.fn() },
}));

vi.mock("@/standup/collector.js", () => ({
  collectStandupData: vi.fn(),
  collectWeeklySummary: vi.fn(),
}));

vi.mock("@/standup/suggester.js", () => ({
  generateSuggestions: vi.fn().mockReturnValue([]),
}));

vi.mock("@/standup/renderer.js", () => ({
  renderStandup: vi.fn().mockReturnValue("rendered standup"),
  exportMarkdown: vi.fn().mockReturnValue("# Standup"),
  renderWeeklySummary: vi.fn().mockReturnValue("weekly summary"),
}));

import { runStandupCommand } from "@/commands/standup.js";
import { logger } from "@/core/logger.js";
import { collectStandupData, collectWeeklySummary } from "@/standup/collector.js";
import { renderWeeklySummary } from "@/standup/renderer.js";

const mockData = {
  date: "Wednesday, March 18 2026",
  yesterday: { sessions: [], totalCostUSD: 0, totalTasks: 0, teamLearnings: [] },
  blocked: [],
  suggested: [],
  streak: 0,
  weekCostUSD: 0,
  globalPatternsCount: 0,
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(collectStandupData).mockResolvedValue(mockData);
  vi.mocked(collectWeeklySummary).mockResolvedValue({ days: [], totals: { sessions: 0, cost: 0, tasks: 0 } });
});

describe("runStandupCommand", () => {
  it("--help prints usage without collecting data", async () => {
    await runStandupCommand(["--help"]);

    expect(logger.plain).toHaveBeenCalledTimes(1);
    const output = vi.mocked(logger.plain).mock.calls[0][0] as string;
    expect(output.toLowerCase()).toContain("standup");
    expect(collectStandupData).not.toHaveBeenCalled();
  });

  it("--since 2d parses duration correctly", async () => {
    const before = Date.now() - 2 * 24 * 60 * 60 * 1000;
    await runStandupCommand(["--since", "2d"]);
    const after = Date.now() - 2 * 24 * 60 * 60 * 1000;

    expect(collectStandupData).toHaveBeenCalledTimes(1);
    const { since } = vi.mocked(collectStandupData).mock.calls[0][0] as { since: number };
    expect(since).toBeGreaterThanOrEqual(before);
    expect(since).toBeLessThanOrEqual(after);
  });

  it("--today sets since to midnight local time", async () => {
    await runStandupCommand(["--today"]);

    expect(collectStandupData).toHaveBeenCalledTimes(1);
    const { since } = vi.mocked(collectStandupData).mock.calls[0][0] as { since: number };

    const midnight = new Date();
    midnight.setHours(0, 0, 0, 0);
    expect(since).toBe(midnight.getTime());
  });

  it("--week sets since to Monday 00:00", async () => {
    await runStandupCommand(["--week"]);

    expect(collectStandupData).toHaveBeenCalledTimes(1);
    const { since } = vi.mocked(collectStandupData).mock.calls[0][0] as { since: number };

    const now = new Date();
    const day = now.getDay();
    const diff = day === 0 ? 6 : day - 1;
    const monday = new Date(now);
    monday.setDate(monday.getDate() - diff);
    monday.setHours(0, 0, 0, 0);

    expect(since).toBe(monday.getTime());
  });

  it("--out without --export prints error", async () => {
    await runStandupCommand(["--out", "file.md"]);

    expect(logger.plain).toHaveBeenCalledTimes(1);
    const output = vi.mocked(logger.plain).mock.calls[0][0] as string;
    expect(output).toContain("--out requires --export");
  });

  it("--week-summary calls collectWeeklySummary", async () => {
    await runStandupCommand(["--week-summary"]);

    expect(collectWeeklySummary).toHaveBeenCalledTimes(1);
    expect(renderWeeklySummary).toHaveBeenCalledTimes(1);
  });
});
