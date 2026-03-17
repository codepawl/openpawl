import { describe, it, expect, vi, beforeEach } from "vitest";
import { detectContradiction, checkSupersession } from "./supersession.js";
import type { Decision } from "./types.js";
import type { DecisionStore } from "./store.js";

function makeDecision(overrides: Partial<Decision> = {}): Decision {
  return {
    id: "dec-1",
    sessionId: "sess-123",
    runIndex: 1,
    capturedAt: Date.now(),
    topic: "OAuth flow",
    decision: "Use PKCE flow",
    reasoning: "More secure",
    recommendedBy: "tech_lead",
    confidence: 0.91,
    taskId: "t-1",
    goalContext: "Build auth",
    tags: ["oauth"],
    embedding: [],
    status: "active",
    ...overrides,
  };
}

describe("detectContradiction", () => {
  it("detects 'use X' vs 'avoid X' contradiction", () => {
    expect(detectContradiction("Use Redis for caching", "Avoid Redis for sessions")).toBe(true);
  });

  it("detects 'prefer X' vs 'don't use X'", () => {
    expect(detectContradiction("Prefer MongoDB", "Don't use MongoDB")).toBe(true);
  });

  it("detects 'choose X' vs 'reject X'", () => {
    expect(detectContradiction("Choose PostgreSQL", "Reject PostgreSQL")).toBe(true);
  });

  it("detects 'enable X' vs 'disable X'", () => {
    expect(detectContradiction("Enable logging", "Disable logging")).toBe(true);
  });

  it("detects 'add X' vs 'remove X'", () => {
    expect(detectContradiction("Add caching layer", "Remove caching layer")).toBe(true);
  });

  it("does not flag non-contradicting decisions", () => {
    expect(detectContradiction("Use Redis for caching", "Use PostgreSQL for storage")).toBe(false);
  });

  it("handles reversed order", () => {
    expect(detectContradiction("Avoid Redis", "Use Redis")).toBe(true);
  });
});

describe("checkSupersession", () => {
  let mockStore: DecisionStore;
  const supersedeIds: Array<{ oldId: string; newId: string }> = [];

  beforeEach(() => {
    supersedeIds.length = 0;
    mockStore = {
      getAll: vi.fn(),
      supersede: vi.fn().mockImplementation(async (oldId: string, newId: string) => {
        supersedeIds.push({ oldId, newId });
      }),
    } as unknown as DecisionStore;
  });

  it("generates alert when new decision contradicts old", async () => {
    const oldDec = makeDecision({
      id: "old-1",
      decision: "Use Redis for session storage",
      topic: "session storage Redis",
    });
    const newDec = makeDecision({
      id: "new-1",
      decision: "Avoid Redis for session storage",
      topic: "session storage Redis",
    });

    vi.mocked(mockStore.getAll).mockResolvedValue([oldDec]);

    const alerts = await checkSupersession(newDec, mockStore);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]!.oldDecision.id).toBe("old-1");
    expect(alerts[0]!.newDecision.id).toBe("new-1");
  });

  it("marks old decision as superseded", async () => {
    const oldDec = makeDecision({
      id: "old-1",
      decision: "Use Redis for caching",
      topic: "caching Redis",
    });
    const newDec = makeDecision({
      id: "new-1",
      decision: "Avoid Redis for caching",
      topic: "caching Redis",
    });

    vi.mocked(mockStore.getAll).mockResolvedValue([oldDec]);

    await checkSupersession(newDec, mockStore);
    expect(mockStore.supersede).toHaveBeenCalledWith("old-1", "new-1");
  });

  it("skips already-superseded decisions", async () => {
    const oldDec = makeDecision({
      id: "old-1",
      decision: "Use Redis",
      status: "superseded",
    });
    const newDec = makeDecision({ id: "new-1", decision: "Avoid Redis" });

    vi.mocked(mockStore.getAll).mockResolvedValue([oldDec]);

    const alerts = await checkSupersession(newDec, mockStore);
    expect(alerts).toHaveLength(0);
  });

  it("skips when topics are unrelated", async () => {
    const oldDec = makeDecision({
      id: "old-1",
      decision: "Use Redis for caching",
      topic: "caching Redis",
    });
    const newDec = makeDecision({
      id: "new-1",
      decision: "Avoid GraphQL for mobile API",
      topic: "mobile API GraphQL",
    });

    vi.mocked(mockStore.getAll).mockResolvedValue([oldDec]);

    const alerts = await checkSupersession(newDec, mockStore);
    expect(alerts).toHaveLength(0);
  });

  it("returns empty when no prior decisions exist", async () => {
    vi.mocked(mockStore.getAll).mockResolvedValue([]);

    const newDec = makeDecision({ id: "new-1" });
    const alerts = await checkSupersession(newDec, mockStore);
    expect(alerts).toHaveLength(0);
  });
});
