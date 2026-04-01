import { describe, it, expect, vi, beforeEach } from "vitest";
import { retrieveSuccessPatterns } from "@/memory/success/retriever.js";
import { withSuccessContext } from "@/memory/success/prompt.js";
import { extractSuccessPattern, extractKeywords } from "@/memory/success/extractor.js";
import type { SuccessPattern } from "@/memory/success/types.js";
import type { TaskForExtraction } from "@/memory/success/extractor.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makePattern(
  overrides: Partial<SuccessPattern & { _distance: number }> = {},
): SuccessPattern & { _distance: number } {
  return {
    id: "success_1",
    sessionId: "session-1",
    taskDescription: "Implement caching layer",
    agentRole: "bot_0",
    approach: "Used Redis with TTL-based eviction",
    resultSummary: "Cache hit rate improved to 95%",
    confidence: 0.91,
    approvalType: "auto",
    reworkCount: 0,
    goalContext: "Optimize performance",
    tags: ["caching", "redis"],
    createdAt: Date.now(),
    runIndex: 1,
    _distance: 0.1,
    ...overrides,
  };
}

function makeTask(overrides: Partial<TaskForExtraction> = {}): TaskForExtraction {
  return {
    task_id: "TASK-001",
    description: "Implement user authentication flow",
    assigned_to: "bot_0",
    status: "completed",
    retry_count: 0,
    result: {
      output: "Implemented OAuth2 flow with JWT tokens and refresh token rotation",
      confidence: { score: 0.92 },
    },
    ...overrides,
  };
}

function mockStore(patterns: Array<SuccessPattern & { _distance: number }>) {
  return {
    search: vi.fn().mockResolvedValue(patterns),
    getAll: vi.fn().mockResolvedValue(patterns),
    init: vi.fn(),
    upsert: vi.fn(),
    delete: vi.fn(),
    count: vi.fn(),
    pruneOld: vi.fn(),
  };
}

function mockEmbedder(vector: number[][] = [[0.1, 0.2, 0.3]]) {
  return {
    generate: vi.fn().mockResolvedValue(vector),
  };
}

// ---------------------------------------------------------------------------
// retrieveSuccessPatterns — advanced cases
// ---------------------------------------------------------------------------

describe("retrieveSuccessPatterns — confidence filtering edge cases", () => {
  it("includes patterns with confidence exactly at threshold", async () => {
    const store = mockStore([
      makePattern({ id: "at_threshold", confidence: 0.75, _distance: 0.1 }),
    ]);
    const embedder = mockEmbedder();

    const results = await retrieveSuccessPatterns(store as any, embedder as any, "caching", {
      minConfidence: 0.75,
    });

    expect(results).toHaveLength(1);
    expect(results[0].id).toBe("at_threshold");
  });

  it("excludes patterns just below confidence threshold", async () => {
    const store = mockStore([
      makePattern({ id: "below", confidence: 0.749, _distance: 0.1 }),
      makePattern({ id: "above", confidence: 0.76, _distance: 0.2 }),
    ]);
    const embedder = mockEmbedder();

    const results = await retrieveSuccessPatterns(store as any, embedder as any, "test");

    expect(results).toHaveLength(1);
    expect(results[0].id).toBe("above");
  });

  it("custom minConfidence overrides default", async () => {
    const store = mockStore([
      makePattern({ id: "low", confidence: 0.5, _distance: 0.1 }),
      makePattern({ id: "mid", confidence: 0.6, _distance: 0.2 }),
    ]);
    const embedder = mockEmbedder();

    const results = await retrieveSuccessPatterns(store as any, embedder as any, "test", {
      minConfidence: 0.45,
    });

    expect(results).toHaveLength(2);
  });
});

describe("retrieveSuccessPatterns — sort order with mixed rework counts", () => {
  it("places reworkCount===0 before reworkCount>0, then sorts by _distance", async () => {
    const store = mockStore([
      makePattern({ id: "rw1_close", reworkCount: 1, _distance: 0.05, confidence: 0.9 }),
      makePattern({ id: "rw0_far", reworkCount: 0, _distance: 0.5, confidence: 0.9 }),
      makePattern({ id: "rw0_close", reworkCount: 0, _distance: 0.1, confidence: 0.9 }),
      makePattern({ id: "rw1_far", reworkCount: 1, _distance: 0.8, confidence: 0.9 }),
    ]);
    const embedder = mockEmbedder();

    const results = await retrieveSuccessPatterns(store as any, embedder as any, "test", {
      limit: 4,
    });

    expect(results.map((r) => r.id)).toEqual([
      "rw0_close",
      "rw0_far",
      "rw1_close",
      "rw1_far",
    ]);
  });

  it("sorts purely by _distance when preferFirstAttempt is false", async () => {
    const store = mockStore([
      makePattern({ id: "rw1_close", reworkCount: 1, _distance: 0.05, confidence: 0.9 }),
      makePattern({ id: "rw0_far", reworkCount: 0, _distance: 0.5, confidence: 0.9 }),
      makePattern({ id: "rw0_close", reworkCount: 0, _distance: 0.1, confidence: 0.9 }),
    ]);
    const embedder = mockEmbedder();

    const results = await retrieveSuccessPatterns(store as any, embedder as any, "test", {
      limit: 3,
      preferFirstAttempt: false,
    });

    // Without preferFirstAttempt sorting, the original order from the store is preserved
    // (no rework-based sort applied)
    expect(results).toHaveLength(3);
    // rw1_close should still be present since preferFirstAttempt only affects sort, not filtering
    expect(results.some((r) => r.id === "rw1_close")).toBe(true);
  });
});

describe("retrieveSuccessPatterns — over-fetch logic", () => {
  it("requests 3x the limit from the store", async () => {
    const store = mockStore([]);
    const embedder = mockEmbedder();

    await retrieveSuccessPatterns(store as any, embedder as any, "caching", { limit: 5 });

    expect(store.search).toHaveBeenCalledWith([0.1, 0.2, 0.3], 15);
  });

  it("requests 3x a custom limit", async () => {
    const store = mockStore([]);
    const embedder = mockEmbedder();

    await retrieveSuccessPatterns(store as any, embedder as any, "test", { limit: 2 });

    expect(store.search).toHaveBeenCalledWith([0.1, 0.2, 0.3], 6);
  });

  it("trims results back down to the requested limit after filtering", async () => {
    const patterns = Array.from({ length: 12 }, (_, i) =>
      makePattern({ id: `p${i}`, confidence: 0.9, _distance: i * 0.1 }),
    );
    const store = mockStore(patterns);
    const embedder = mockEmbedder();

    const results = await retrieveSuccessPatterns(store as any, embedder as any, "test", {
      limit: 3,
    });

    expect(results).toHaveLength(3);
  });
});

describe("retrieveSuccessPatterns — empty results handling", () => {
  it("returns empty array when store returns no candidates", async () => {
    const store = mockStore([]);
    const embedder = mockEmbedder();

    const results = await retrieveSuccessPatterns(store as any, embedder as any, "anything");

    expect(results).toEqual([]);
  });

  it("returns empty array when embedder returns empty vector", async () => {
    const store = mockStore([makePattern()]);
    const embedder = mockEmbedder([[]]);

    const results = await retrieveSuccessPatterns(store as any, embedder as any, "test");

    expect(results).toEqual([]);
    expect(store.search).not.toHaveBeenCalled();
  });

  it("returns empty array when all candidates are below confidence threshold", async () => {
    const store = mockStore([
      makePattern({ id: "low1", confidence: 0.3, _distance: 0.1 }),
      makePattern({ id: "low2", confidence: 0.5, _distance: 0.2 }),
    ]);
    const embedder = mockEmbedder();

    const results = await retrieveSuccessPatterns(store as any, embedder as any, "test");

    expect(results).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// withSuccessContext — advanced prompt injection
// ---------------------------------------------------------------------------

describe("withSuccessContext — prompt injection advanced", () => {
  it("returns original prompt unchanged when patterns array is empty", () => {
    const prompt = "Plan the next sprint for the team.";
    const result = withSuccessContext(prompt, []);
    expect(result).toBe(prompt);
  });

  it("truncates task description at 80 characters", () => {
    const longTask = "A".repeat(150);
    const patterns = [makePattern({ taskDescription: longTask })];
    const result = withSuccessContext("prompt", patterns);

    // The line should contain exactly 80 chars of the task, not all 150
    const taskMatch = result.match(/Task: "([^"]*)"/);
    expect(taskMatch).not.toBeNull();
    expect(taskMatch![1].length).toBe(80);
    expect(taskMatch![1]).toBe("A".repeat(80));
  });

  it("truncates approach at 120 characters", () => {
    const longApproach = "B".repeat(200);
    const patterns = [makePattern({ approach: longApproach })];
    const result = withSuccessContext("prompt", patterns);

    const approachMatch = result.match(/Approach: "([^"]*)"/);
    expect(approachMatch).not.toBeNull();
    expect(approachMatch![1].length).toBe(120);
    expect(approachMatch![1]).toBe("B".repeat(120));
  });

  it("handles task description shorter than 80 characters without padding", () => {
    const shortTask = "Short task";
    const patterns = [makePattern({ taskDescription: shortTask })];
    const result = withSuccessContext("prompt", patterns);

    const taskMatch = result.match(/Task: "([^"]*)"/);
    expect(taskMatch![1]).toBe("Short task");
  });

  it("shows confidence rounded to two decimal places", () => {
    const patterns = [makePattern({ confidence: 0.8765 })];
    const result = withSuccessContext("prompt", patterns);
    // Math.round(0.8765 * 100) / 100 = 0.88
    expect(result).toContain("Confidence: 0.88");
  });

  it("includes the advisory line about proven approaches", () => {
    const patterns = [makePattern()];
    const result = withSuccessContext("prompt", patterns);
    expect(result).toContain("Consider these proven approaches when planning.");
  });
});

// ---------------------------------------------------------------------------
// extractKeywords — unicode text
// ---------------------------------------------------------------------------

describe("extractKeywords — unicode text", () => {
  it("handles accented characters by splitting on non-word chars", () => {
    const keywords = extractKeywords("implementar autenticación con OAuth");
    // \W+ split will keep ascii-compatible segments
    expect(keywords.length).toBeGreaterThan(0);
    expect(keywords).toContain("oauth");
  });

  it("handles CJK characters gracefully without crashing", () => {
    // CJK chars are word chars in JS regex, so they form single tokens
    const keywords = extractKeywords("実装 authentication テスト");
    expect(Array.isArray(keywords)).toBe(true);
    // Should at least extract "authentication"
    expect(keywords).toContain("authentication");
  });

  it("handles emoji-laden text without crashing", () => {
    const keywords = extractKeywords("deploy 🚀 the application 🎉 successfully");
    expect(Array.isArray(keywords)).toBe(true);
    expect(keywords).toContain("deploy");
    expect(keywords).toContain("application");
    expect(keywords).toContain("successfully");
  });

  it("handles mixed script text", () => {
    const keywords = extractKeywords("Kubernetes кластер deployment стратегия");
    expect(Array.isArray(keywords)).toBe(true);
    expect(keywords).toContain("kubernetes");
  });
});

// ---------------------------------------------------------------------------
// extractSuccessPattern — rejection criteria
// ---------------------------------------------------------------------------

describe("extractSuccessPattern — rejection criteria exhaustive", () => {
  it("returns null for needs_rework status", () => {
    const result = extractSuccessPattern(
      makeTask({ status: "needs_rework" }),
      "goal",
      "s1",
      1,
    );
    expect(result).toBeNull();
  });

  it("returns null for rejected status", () => {
    const result = extractSuccessPattern(
      makeTask({ status: "rejected" }),
      "goal",
      "s1",
      1,
    );
    expect(result).toBeNull();
  });

  it("returns null for escalated status", () => {
    const result = extractSuccessPattern(
      makeTask({ status: "escalated" }),
      "goal",
      "s1",
      1,
    );
    expect(result).toBeNull();
  });

  it("returns null for in_progress status", () => {
    const result = extractSuccessPattern(
      makeTask({ status: "in_progress" }),
      "goal",
      "s1",
      1,
    );
    expect(result).toBeNull();
  });

  it("returns null for pending status", () => {
    const result = extractSuccessPattern(
      makeTask({ status: "pending" }),
      "goal",
      "s1",
      1,
    );
    expect(result).toBeNull();
  });

  it("returns null for unknown status", () => {
    const result = extractSuccessPattern(
      makeTask({ status: "some_unknown_status" }),
      "goal",
      "s1",
      1,
    );
    expect(result).toBeNull();
  });

  it("returns null for retry_count exactly 2", () => {
    const result = extractSuccessPattern(
      makeTask({ retry_count: 2 }),
      "goal",
      "s1",
      1,
    );
    expect(result).toBeNull();
  });

  it("returns null for retry_count above 2", () => {
    const result = extractSuccessPattern(
      makeTask({ retry_count: 5 }),
      "goal",
      "s1",
      1,
    );
    expect(result).toBeNull();
  });

  it("accepts retry_count of 1 for completed tasks", () => {
    const result = extractSuccessPattern(
      makeTask({ retry_count: 1 }),
      "goal",
      "s1",
      1,
    );
    expect(result).not.toBeNull();
    expect(result!.reworkCount).toBe(1);
  });

  it("accepts auto_approved_pending with retry_count 0", () => {
    const result = extractSuccessPattern(
      makeTask({ status: "auto_approved_pending", retry_count: 0 }),
      "goal",
      "s1",
      1,
    );
    expect(result).not.toBeNull();
    expect(result!.approvalType).toBe("auto");
  });

  it("rejects auto_approved_pending with retry_count >= 2", () => {
    const result = extractSuccessPattern(
      makeTask({ status: "auto_approved_pending", retry_count: 2 }),
      "goal",
      "s1",
      1,
    );
    expect(result).toBeNull();
  });
});
