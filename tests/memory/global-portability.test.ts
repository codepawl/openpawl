import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@lancedb/lancedb", () => ({
  connect: vi.fn(),
}));

vi.mock("node:fs/promises", () => ({
  mkdir: vi.fn().mockResolvedValue(undefined),
}));

import { exportGlobalMemory, importGlobalMemory } from "@/memory/global/portability.js";
import type { MemoryExport, GlobalSuccessPattern, GlobalFailureLesson } from "@/memory/global/types.js";

describe("Global Memory Portability", () => {
  let mockPatternStore: Record<string, ReturnType<typeof vi.fn>>;
  let mockKnowledgeGraph: Record<string, ReturnType<typeof vi.fn>>;
  let mockGlobalManager: Record<string, unknown>;
  let mockEmbedder: Record<string, ReturnType<typeof vi.fn>>;

  beforeEach(() => {
    mockPatternStore = {
      getAll: vi.fn().mockResolvedValue([]),
      count: vi.fn().mockResolvedValue(0),
      upsert: vi.fn().mockResolvedValue(true),
    };

    mockKnowledgeGraph = {
      getGraph: vi.fn().mockResolvedValue({ nodes: [], edges: [] }),
      getEdges: vi.fn().mockResolvedValue([]),
      addEdge: vi.fn().mockResolvedValue(true),
    };

    mockGlobalManager = {
      getPatternStore: vi.fn().mockReturnValue(mockPatternStore),
      getKnowledgeGraph: vi.fn().mockReturnValue(mockKnowledgeGraph),
      getAllLessons: vi.fn().mockResolvedValue([]),
      upsertLesson: vi.fn().mockResolvedValue(true),
    };

    mockEmbedder = {
      generate: vi.fn().mockResolvedValue([[0.1, 0.2, 0.3]]),
    };
  });

  it("should export patterns, lessons, and edges", async () => {
    const pattern: GlobalSuccessPattern = {
      id: "pat-1",
      sessionId: "s1",
      taskDescription: "Test",
      agentRole: "worker",
      approach: "Direct",
      resultSummary: "OK",
      confidence: 0.9,
      approvalType: "auto",
      reworkCount: 0,
      goalContext: "Test",
      tags: [],
      createdAt: Date.now(),
      runIndex: 1,
      promotedAt: Date.now(),
      promotedBy: "auto",
      sourceSessionId: "s1",
      globalQualityScore: 0.85,
    };

    mockPatternStore.getAll.mockResolvedValue([pattern]);
    (mockGlobalManager.getAllLessons as ReturnType<typeof vi.fn>).mockResolvedValue([
      { id: "l1", text: "Learn from errors", sessionId: "s1", retrievalCount: 2, helpedAvoidFailure: true, createdAt: Date.now(), promotedAt: Date.now(), promotedBy: "auto" },
    ]);

    const result = await exportGlobalMemory(mockGlobalManager as never);
    expect(result.version).toBe("0.0.1");
    expect(result.globalSuccessPatterns).toHaveLength(1);
    expect(result.globalFailureLessons).toHaveLength(1);
    expect(result.exportedAt).toBeGreaterThan(0);
  });

  it("should skip existing patterns on import (idempotent)", async () => {
    const existingPattern: GlobalSuccessPattern = {
      id: "pat-existing",
      sessionId: "s1",
      taskDescription: "Existing",
      agentRole: "worker",
      approach: "Direct",
      resultSummary: "OK",
      confidence: 0.9,
      approvalType: "auto",
      reworkCount: 0,
      goalContext: "Test",
      tags: [],
      createdAt: Date.now(),
      runIndex: 1,
      promotedAt: Date.now(),
      promotedBy: "auto",
      sourceSessionId: "s1",
      globalQualityScore: 0.85,
    };

    mockPatternStore.getAll.mockResolvedValue([existingPattern]);

    const data: MemoryExport = {
      exportedAt: Date.now(),
      version: "0.0.1",
      globalSuccessPatterns: [existingPattern], // Same pattern
      globalFailureLessons: [],
      knowledgeGraph: [],
    };

    const result = await importGlobalMemory(mockGlobalManager as never, data, mockEmbedder as never);
    expect(result.patternsImported).toBe(0);
    expect(result.skipped).toBe(1);
    expect(mockPatternStore.upsert).not.toHaveBeenCalled();
  });

  it("should import new patterns and lessons", async () => {
    mockPatternStore.getAll.mockResolvedValue([]);

    const data: MemoryExport = {
      exportedAt: Date.now(),
      version: "0.0.1",
      globalSuccessPatterns: [{
        id: "new-pat",
        sessionId: "s1",
        taskDescription: "New",
        agentRole: "worker",
        approach: "New approach",
        resultSummary: "OK",
        confidence: 0.85,
        approvalType: "auto",
        reworkCount: 0,
        goalContext: "Test",
        tags: [],
        createdAt: Date.now(),
        runIndex: 1,
        promotedAt: Date.now(),
        promotedBy: "auto",
        sourceSessionId: "s1",
        globalQualityScore: 0.85,
      }],
      globalFailureLessons: [{
        id: "new-lesson",
        text: "New lesson",
        sessionId: "s1",
        retrievalCount: 0,
        helpedAvoidFailure: false,
        createdAt: Date.now(),
        promotedAt: Date.now(),
        promotedBy: "auto",
      }],
      knowledgeGraph: [],
    };

    const result = await importGlobalMemory(mockGlobalManager as never, data, mockEmbedder as never);
    expect(result.patternsImported).toBe(1);
    expect(result.lessonsImported).toBe(1);
    expect(result.skipped).toBe(0);
  });

  it("should handle running import twice idempotently", async () => {
    // First import
    mockPatternStore.getAll.mockResolvedValue([]);
    const data: MemoryExport = {
      exportedAt: Date.now(),
      version: "0.0.1",
      globalSuccessPatterns: [{
        id: "pat-once",
        sessionId: "s1",
        taskDescription: "Once",
        agentRole: "worker",
        approach: "Direct",
        resultSummary: "OK",
        confidence: 0.9,
        approvalType: "auto",
        reworkCount: 0,
        goalContext: "Test",
        tags: [],
        createdAt: Date.now(),
        runIndex: 1,
        promotedAt: Date.now(),
        promotedBy: "auto",
        sourceSessionId: "s1",
        globalQualityScore: 0.9,
      }],
      globalFailureLessons: [],
      knowledgeGraph: [],
    };

    const r1 = await importGlobalMemory(mockGlobalManager as never, data, mockEmbedder as never);
    expect(r1.patternsImported).toBe(1);

    // Second import — now the pattern exists
    mockPatternStore.getAll.mockResolvedValue([data.globalSuccessPatterns[0]]);
    const r2 = await importGlobalMemory(mockGlobalManager as never, data, mockEmbedder as never);
    expect(r2.patternsImported).toBe(0);
    expect(r2.skipped).toBe(1);
  });
});
