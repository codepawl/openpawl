import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock lancedb
vi.mock("@lancedb/lancedb", () => ({
  connect: vi.fn(),
}));

import { ProfileBuilder } from "../src/agents/profiles/builder.js";
import type { AgentProfile, CompletedTaskResult } from "../src/agents/profiles/types.js";

function makeResult(overrides: Partial<CompletedTaskResult> = {}): CompletedTaskResult {
  return {
    taskId: "TASK-001",
    agentRole: "software_engineer",
    description: "Implement user login feature",
    success: true,
    confidence: 0.8,
    reworkCount: 0,
    ...overrides,
  };
}

describe("ProfileBuilder", () => {
  let mockStore: { getByRole: ReturnType<typeof vi.fn>; upsert: ReturnType<typeof vi.fn> };
  let builder: ProfileBuilder;

  beforeEach(() => {
    mockStore = {
      getByRole: vi.fn().mockResolvedValue(null),
      upsert: vi.fn().mockResolvedValue(true),
    };
    builder = new ProfileBuilder(mockStore as never);
  });

  it("returns empty array for no results", async () => {
    const profiles = await builder.buildFromTaskResults([]);
    expect(profiles).toEqual([]);
  });

  it("builds profile from scratch with implement tasks", async () => {
    const results: CompletedTaskResult[] = [
      makeResult({ taskId: "T1", description: "Implement login feature", success: true, confidence: 0.9 }),
      makeResult({ taskId: "T2", description: "Build registration system", success: true, confidence: 0.8 }),
      makeResult({ taskId: "T3", description: "Create API endpoints", success: false, confidence: 0.5 }),
    ];

    const profiles = await builder.buildFromTaskResults(results);
    expect(profiles).toHaveLength(1);
    expect(profiles[0].agentRole).toBe("software_engineer");
    expect(profiles[0].totalTasksCompleted).toBe(3);
    expect(mockStore.upsert).toHaveBeenCalledOnce();
  });

  it("applies success decay correctly: 0.5 * 1.02 = 0.51", async () => {
    const results = [makeResult({ success: true })];
    const profiles = await builder.buildFromTaskResults(results);
    // Starting from 0.5 (default), one success: 0.5 * 1.02 = 0.51
    expect(profiles[0].overallScore).toBeCloseTo(0.51, 4);
  });

  it("applies failure decay correctly: 0.5 * 0.95 = 0.475", async () => {
    const results = [makeResult({ success: false })];
    const profiles = await builder.buildFromTaskResults(results);
    expect(profiles[0].overallScore).toBeCloseTo(0.475, 4);
  });

  it("caps score at 1.0 on success", async () => {
    mockStore.getByRole.mockResolvedValue({
      agentRole: "software_engineer",
      taskTypeScores: [],
      overallScore: 0.995,
      strengths: [],
      weaknesses: [],
      lastUpdatedAt: Date.now(),
      totalTasksCompleted: 50,
      scoreHistory: [0.99, 0.995],
    } satisfies AgentProfile);

    const results = [makeResult({ success: true })];
    const profiles = await builder.buildFromTaskResults(results);
    expect(profiles[0].overallScore).toBeLessThanOrEqual(1.0);
  });

  it("builds incrementally on existing profile", async () => {
    const existingProfile: AgentProfile = {
      agentRole: "software_engineer",
      taskTypeScores: [{
        taskType: "implement",
        averageConfidence: 0.8,
        successRate: 0.9,
        averageReworkCount: 0.1,
        totalTasksCompleted: 10,
        trend: "stable",
      }],
      overallScore: 0.75,
      strengths: ["implement"],
      weaknesses: [],
      lastUpdatedAt: Date.now() - 10000,
      totalTasksCompleted: 10,
      scoreHistory: [0.7, 0.72, 0.75],
    };
    mockStore.getByRole.mockResolvedValue(existingProfile);

    const results = [
      makeResult({ taskId: "T1", description: "Implement new module", success: true, confidence: 0.85 }),
      makeResult({ taskId: "T2", description: "Build API layer", success: true, confidence: 0.9 }),
    ];

    const profiles = await builder.buildFromTaskResults(results);
    expect(profiles[0].totalTasksCompleted).toBe(12);
    expect(profiles[0].scoreHistory.length).toBe(4);
    // Overall score should have increased from 0.75 with two successes
    expect(profiles[0].overallScore).toBeGreaterThan(0.75);
  });

  it("derives strengths correctly", async () => {
    const existingProfile: AgentProfile = {
      agentRole: "software_engineer",
      taskTypeScores: [{
        taskType: "implement",
        averageConfidence: 0.9,
        successRate: 0.95,
        averageReworkCount: 0.1,
        totalTasksCompleted: 8,
        trend: "stable",
      }],
      overallScore: 0.8,
      strengths: [],
      weaknesses: [],
      lastUpdatedAt: Date.now(),
      totalTasksCompleted: 8,
      scoreHistory: [0.8],
    };
    mockStore.getByRole.mockResolvedValue(existingProfile);

    // Add 2 more successes to pass MIN_TASKS_FOR_LABEL(5) threshold (total 10, 9.5 success)
    const results = [
      makeResult({ taskId: "T1", description: "Implement feature X", success: true, confidence: 0.9 }),
      makeResult({ taskId: "T2", description: "Build feature Y", success: true, confidence: 0.85 }),
    ];

    const profiles = await builder.buildFromTaskResults(results);
    expect(profiles[0].strengths).toContain("implement");
  });

  it("derives weaknesses correctly", async () => {
    const existingProfile: AgentProfile = {
      agentRole: "qa_reviewer",
      taskTypeScores: [{
        taskType: "test",
        averageConfidence: 0.3,
        successRate: 0.3,
        averageReworkCount: 2,
        totalTasksCompleted: 8,
        trend: "degrading",
      }],
      overallScore: 0.4,
      strengths: [],
      weaknesses: [],
      lastUpdatedAt: Date.now(),
      totalTasksCompleted: 8,
      scoreHistory: [0.5, 0.4],
    };
    mockStore.getByRole.mockResolvedValue(existingProfile);

    const results = [
      makeResult({ agentRole: "qa_reviewer", taskId: "T1", description: "Write test suite", success: false, confidence: 0.2 }),
      makeResult({ agentRole: "qa_reviewer", taskId: "T2", description: "Test coverage check", success: false, confidence: 0.3 }),
    ];

    const profiles = await builder.buildFromTaskResults(results);
    expect(profiles[0].weaknesses).toContain("test");
  });

  it("separates multiple roles correctly", async () => {
    const results = [
      makeResult({ agentRole: "software_engineer", taskId: "T1", description: "Implement feature", success: true }),
      makeResult({ agentRole: "qa_reviewer", taskId: "T2", description: "Review and audit code", success: true }),
    ];

    const profiles = await builder.buildFromTaskResults(results);
    expect(profiles).toHaveLength(2);
    const roles = profiles.map((p) => p.agentRole);
    expect(roles).toContain("software_engineer");
    expect(roles).toContain("qa_reviewer");
  });

  it("detects improving trend", async () => {
    const existingProfile: AgentProfile = {
      agentRole: "software_engineer",
      taskTypeScores: [{
        taskType: "implement",
        averageConfidence: 0.5,
        successRate: 0.7,
        averageReworkCount: 0.5,
        totalTasksCompleted: 10,
        trend: "stable",
      }],
      overallScore: 0.6,
      strengths: [],
      weaknesses: [],
      lastUpdatedAt: Date.now(),
      totalTasksCompleted: 10,
      scoreHistory: [0.6],
    };
    mockStore.getByRole.mockResolvedValue(existingProfile);

    // Higher confidence results should push trend to improving
    const results = [
      makeResult({ taskId: "T1", description: "Implement module", success: true, confidence: 0.95 }),
      makeResult({ taskId: "T2", description: "Build component", success: true, confidence: 0.9 }),
    ];

    const profiles = await builder.buildFromTaskResults(results);
    const implScore = profiles[0].taskTypeScores.find((s) => s.taskType === "implement");
    expect(implScore).toBeDefined();
    expect(implScore!.trend).toBe("improving");
  });
});
