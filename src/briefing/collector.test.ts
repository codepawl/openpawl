import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock modules before importing collector
vi.mock("../replay/session-index.js", () => ({
  listSessions: vi.fn(),
}));

vi.mock("../replay/storage.js", () => ({
  readRecordingEvents: vi.fn(),
}));

import { collectBriefingData } from "./collector.js";
import { listSessions } from "../replay/session-index.js";
import { readRecordingEvents } from "../replay/storage.js";
import type { SessionIndexEntry } from "../replay/types.js";
import type { RecordingEvent } from "../replay/types.js";

const mockListSessions = vi.mocked(listSessions);
const mockReadRecordingEvents = vi.mocked(readRecordingEvents);

function makeSession(overrides: Partial<SessionIndexEntry> = {}): SessionIndexEntry {
  return {
    sessionId: "sess-test-123",
    goal: "Build auth module",
    createdAt: Date.now() - 2 * 24 * 60 * 60 * 1000,
    completedAt: Date.now() - 2 * 24 * 60 * 60 * 1000,
    totalRuns: 3,
    totalCostUSD: 0.13,
    averageConfidence: 0.85,
    recordingPath: "",
    recordingSizeBytes: 0,
    teamComposition: ["worker", "reviewer"],
    ...overrides,
  };
}

function makeExitEvent(stateAfter: Record<string, unknown>): RecordingEvent {
  return {
    id: "evt-1",
    sessionId: "sess-test-123",
    runIndex: 1,
    nodeId: "coordinator",
    phase: "exit",
    timestamp: Date.now(),
    stateAfter,
  };
}

beforeEach(() => {
  vi.resetAllMocks();
});

describe("collectBriefingData", () => {
  it("returns null lastSession when no previous sessions exist", async () => {
    mockListSessions.mockReturnValue([]);
    const data = await collectBriefingData();
    expect(data.lastSession).toBeNull();
  });

  it("returns null lastSession when sessions exist but none completed", async () => {
    mockListSessions.mockReturnValue([makeSession({ completedAt: 0 })]);
    const data = await collectBriefingData();
    expect(data.lastSession).toBeNull();
  });

  it("populates lastSession from most recent completed session", async () => {
    mockListSessions.mockReturnValue([makeSession()]);
    mockReadRecordingEvents.mockResolvedValue([]);
    const data = await collectBriefingData();
    expect(data.lastSession).not.toBeNull();
    expect(data.lastSession!.sessionId).toBe("sess-test-123");
    expect(data.lastSession!.daysAgo).toBe(2);
  });

  it("correctly pulls leftOpen from next_sprint_backlog", async () => {
    mockListSessions.mockReturnValue([makeSession()]);
    mockReadRecordingEvents.mockResolvedValue([
      makeExitEvent({
        next_sprint_backlog: [
          { description: "Add rate limiting", reason: "escalated" },
          { description: "Fix timeout", reason: "deferred" },
        ],
        task_queue: [],
      }),
    ]);
    const data = await collectBriefingData();
    expect(data.leftOpen).toHaveLength(2);
    expect(data.leftOpen[0]!.reason).toBe("escalated");
    expect(data.leftOpen[1]!.reason).toBe("deferred");
  });

  it("correctly identifies openRFCs from session state", async () => {
    mockListSessions.mockReturnValue([makeSession()]);
    mockReadRecordingEvents.mockResolvedValue([
      makeExitEvent({
        rfc_document: "# Caching Layer RFC\nThis RFC proposes...",
        task_queue: [],
      }),
    ]);
    const data = await collectBriefingData();
    expect(data.openRFCs).toHaveLength(1);
    expect(data.openRFCs[0]).toBe("Caching Layer RFC");
  });

  it("limits whatWasBuilt to 5 items max", async () => {
    const tasks = Array.from({ length: 10 }, (_, i) => ({
      task_id: `t-${i}`,
      description: `Task${i} item${i} work`,
      status: "completed",
    }));
    mockListSessions.mockReturnValue([makeSession()]);
    mockReadRecordingEvents.mockResolvedValue([
      makeExitEvent({ task_queue: tasks }),
    ]);
    const data = await collectBriefingData();
    expect(data.whatWasBuilt.length).toBeLessThanOrEqual(5);
  });

  it("limits leftOpen to 3 items max", async () => {
    const backlog = Array.from({ length: 10 }, (_, i) => ({
      description: `Backlog item ${i}`,
      reason: "deferred",
    }));
    mockListSessions.mockReturnValue([makeSession()]);
    mockReadRecordingEvents.mockResolvedValue([
      makeExitEvent({ next_sprint_backlog: backlog, task_queue: [] }),
    ]);
    const data = await collectBriefingData();
    expect(data.leftOpen.length).toBeLessThanOrEqual(3);
  });

  it("does not crash when recording read fails", async () => {
    mockListSessions.mockReturnValue([makeSession()]);
    mockReadRecordingEvents.mockRejectedValue(new Error("corrupt"));
    const data = await collectBriefingData();
    expect(data.lastSession).not.toBeNull();
    expect(data.whatWasBuilt).toEqual([]);
  });

  it("extracts team performance from agent profiles in state", async () => {
    mockListSessions.mockReturnValue([makeSession()]);
    mockReadRecordingEvents.mockResolvedValue([
      makeExitEvent({
        task_queue: [],
        agent_profiles: [
          {
            agentRole: "worker_bot",
            overallScore: 0.85,
            scoreHistory: [0.7, 0.78, 0.85],
            taskTypeScores: [],
          },
        ],
      }),
    ]);
    const data = await collectBriefingData();
    expect(data.teamPerformance).toHaveLength(1);
    expect(data.teamPerformance[0]!.agentRole).toBe("worker_bot");
    expect(data.teamPerformance[0]!.trend).toBe("improving");
  });
});
