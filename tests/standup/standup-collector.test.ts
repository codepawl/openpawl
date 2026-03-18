import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/replay/session-index.js", () => ({
  listSessions: vi.fn(() => []),
}));

vi.mock("@/replay/storage.js", () => ({
  readRecordingEvents: vi.fn(async () => []),
}));

vi.mock("@/standup/streak.js", () => ({
  StreakTracker: vi.fn().mockImplementation(() => ({
    init: vi.fn().mockResolvedValue(undefined),
    getCurrentStreak: vi.fn().mockResolvedValue(0),
  })),
}));

vi.mock("@lancedb/lancedb", () => ({
  connect: vi.fn().mockResolvedValue({}),
}));

vi.mock("@/memory/global/store.js", () => ({
  GlobalMemoryManager: vi.fn().mockImplementation(() => ({
    init: vi.fn().mockResolvedValue(undefined),
    getHealth: vi.fn().mockResolvedValue({ totalGlobalPatterns: 0 }),
  })),
}));

vi.mock("@/core/knowledge-base.js", () => ({
  VectorMemory: vi.fn().mockImplementation(() => ({
    init: vi.fn().mockResolvedValue(undefined),
    getEmbedder: vi.fn().mockReturnValue(null),
  })),
}));

vi.mock("@/core/config.js", () => ({
  CONFIG: {
    vectorStorePath: "/tmp/test-vectors",
    memoryBackend: "lancedb",
  },
}));

import { collectStandupData } from "@/standup/collector.js";
import { listSessions } from "@/replay/session-index.js";
import { readRecordingEvents } from "@/replay/storage.js";

function makeSession(overrides: Record<string, unknown> = {}) {
  return {
    sessionId: "sess_1",
    goal: "Build auth module",
    createdAt: Date.now() - 3600_000,
    completedAt: Date.now() - 1800_000,
    totalRuns: 1,
    totalCostUSD: 0.42,
    averageConfidence: 0.85,
    recordingPath: "/tmp/recordings/sess_1",
    recordingSizeBytes: 1024,
    teamComposition: ["tech_lead", "developer"],
    ...overrides,
  };
}

function makeRecordingEvent(overrides: Record<string, unknown> = {}) {
  return {
    id: "evt_1",
    sessionId: "sess_1",
    runIndex: 0,
    nodeId: "worker_task",
    phase: "exit",
    timestamp: Date.now(),
    stateAfter: {},
    ...overrides,
  };
}

describe("collectStandupData", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("filters sessions by 24h window correctly", async () => {
    const now = Date.now();
    const withinWindow = makeSession({
      sessionId: "sess_recent",
      completedAt: now - 3600_000, // 1 hour ago
      totalCostUSD: 0.50,
    });
    const outsideWindow = makeSession({
      sessionId: "sess_old",
      completedAt: now - 48 * 3600_000, // 48 hours ago
      totalCostUSD: 1.00,
    });

    vi.mocked(listSessions).mockReturnValue([withinWindow, outsideWindow] as any);
    vi.mocked(readRecordingEvents).mockResolvedValue([
      makeRecordingEvent({ sessionId: "sess_recent", stateAfter: { task_queue: [] } }),
    ] as any);

    const since = now - 24 * 3600_000;
    const result = await collectStandupData({ since, label: "Last 24h" });

    expect(result.yesterday.sessions).toHaveLength(1);
    expect(result.yesterday.sessions[0]!.sessionId).toBe("sess_recent");
  });

  it("calculates weekCostUSD since Monday", async () => {
    const now = Date.now();
    // Create sessions: one this week, one last week
    const thisWeek = makeSession({
      sessionId: "sess_week",
      completedAt: now - 1000, // just now
      totalCostUSD: 1.25,
    });
    const lastWeek = makeSession({
      sessionId: "sess_last_week",
      completedAt: now - 8 * 24 * 3600_000, // 8 days ago
      totalCostUSD: 3.00,
    });

    // listSessions is called twice: once for window filtering, once for week cost
    vi.mocked(listSessions).mockReturnValue([thisWeek, lastWeek] as any);
    vi.mocked(readRecordingEvents).mockResolvedValue([
      makeRecordingEvent({ stateAfter: { task_queue: [] } }),
    ] as any);

    const since = now - 24 * 3600_000;
    const result = await collectStandupData({ since, label: "Last 24h" });

    // weekCostUSD should include only sessions since Monday midnight
    // The thisWeek session (completed just now) should be included
    expect(result.weekCostUSD).toBeGreaterThanOrEqual(1.25);
    // The lastWeek session should NOT be included
    expect(result.weekCostUSD).toBeLessThan(4.25);
  });

  it("returns empty yesterday when no sessions in window", async () => {
    vi.mocked(listSessions).mockReturnValue([]);

    const since = Date.now() - 24 * 3600_000;
    const result = await collectStandupData({ since, label: "Last 24h" });

    expect(result.yesterday.sessions).toEqual([]);
    expect(result.yesterday.totalCostUSD).toBe(0);
    expect(result.yesterday.totalTasks).toBe(0);
    expect(result.yesterday.teamLearnings).toEqual([]);
  });

  it("handles missing recording events gracefully", async () => {
    const now = Date.now();
    const session = makeSession({
      sessionId: "sess_no_events",
      completedAt: now - 1000,
      totalCostUSD: 0.30,
    });

    vi.mocked(listSessions).mockReturnValue([session] as any);
    // Return empty events array — no exit events to extract state from
    vi.mocked(readRecordingEvents).mockResolvedValue([] as any);

    const since = now - 24 * 3600_000;
    const result = await collectStandupData({ since, label: "Last 24h" });

    // Should still produce a session summary with zero tasks
    expect(result.yesterday.sessions).toHaveLength(1);
    expect(result.yesterday.sessions[0]!.tasksCompleted).toBe(0);
    expect(result.yesterday.sessions[0]!.reworkCount).toBe(0);
    expect(result.yesterday.sessions[0]!.allApproved).toBe(true);
    expect(result.yesterday.sessions[0]!.costUSD).toBe(0.30);
  });

  it("derives reworkCount from task_queue correctly", async () => {
    const now = Date.now();
    const session = makeSession({
      sessionId: "sess_rework",
      completedAt: now - 1000,
      totalCostUSD: 0.80,
    });

    vi.mocked(listSessions).mockReturnValue([session] as any);
    vi.mocked(readRecordingEvents).mockResolvedValue([
      makeRecordingEvent({
        sessionId: "sess_rework",
        stateAfter: {
          task_queue: [
            { status: "completed", retry_count: 0, description: "Task A" },
            { status: "completed", retry_count: 2, description: "Task B" },
            { status: "completed", retry_count: 1, description: "Task C" },
            { status: "failed", retry_count: 3, description: "Task D" },
          ],
        },
      }),
    ] as any);

    const since = now - 24 * 3600_000;
    const result = await collectStandupData({ since, label: "Last 24h" });

    const summary = result.yesterday.sessions[0]!;
    // Only completed tasks count: A (0 retries), B (2 retries), C (1 retry)
    expect(summary.tasksCompleted).toBe(3);
    // Rework = completed tasks with retry_count > 0: B and C
    expect(summary.reworkCount).toBe(2);
  });

  it("derives allApproved as reworkCount === 0", async () => {
    const now = Date.now();

    // Session with no rework
    const sessionClean = makeSession({
      sessionId: "sess_clean",
      completedAt: now - 2000,
      totalCostUSD: 0.50,
    });
    // Session with rework
    const sessionRework = makeSession({
      sessionId: "sess_rework",
      completedAt: now - 1000,
      totalCostUSD: 0.60,
    });

    vi.mocked(listSessions).mockReturnValue([sessionClean, sessionRework] as any);
    vi.mocked(readRecordingEvents).mockImplementation(async (sessionId: string) => {
      if (sessionId === "sess_clean") {
        return [
          makeRecordingEvent({
            stateAfter: {
              task_queue: [
                { status: "completed", retry_count: 0, description: "Task A" },
                { status: "completed", retry_count: 0, description: "Task B" },
              ],
            },
          }),
        ] as any;
      }
      return [
        makeRecordingEvent({
          stateAfter: {
            task_queue: [
              { status: "completed", retry_count: 0, description: "Task X" },
              { status: "completed", retry_count: 1, description: "Task Y" },
            ],
          },
        }),
      ] as any;
    });

    const since = now - 24 * 3600_000;
    const result = await collectStandupData({ since, label: "Last 24h" });

    const clean = result.yesterday.sessions.find((s) => s.sessionId === "sess_clean")!;
    const rework = result.yesterday.sessions.find((s) => s.sessionId === "sess_rework")!;

    // Clean session: no retries → allApproved true
    expect(clean.reworkCount).toBe(0);
    expect(clean.allApproved).toBe(true);

    // Rework session: has retries → allApproved false
    expect(rework.reworkCount).toBe(1);
    expect(rework.allApproved).toBe(false);
  });
});
