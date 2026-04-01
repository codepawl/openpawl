/**
 * Tests for work-runner/session-finalize.ts — audit export, context generation, composition rules.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockBuildAuditTrail, mockRenderAuditMarkdown, mockWriteFile, mockMkdir, mockAgentRegistryStore } = vi.hoisted(() => ({
  mockBuildAuditTrail: vi.fn().mockResolvedValue({ events: [] }),
  mockRenderAuditMarkdown: vi.fn().mockReturnValue("# Audit\nContent"),
  mockWriteFile: vi.fn().mockResolvedValue(undefined),
  mockMkdir: vi.fn().mockResolvedValue(undefined),
  mockAgentRegistryStore: {
    loadAllSync: vi.fn().mockReturnValue([]),
  },
}));

vi.mock("@/audit/index.js", () => ({
  buildAuditTrail: mockBuildAuditTrail,
  renderAuditMarkdown: mockRenderAuditMarkdown,
}));
vi.mock("node:fs/promises", () => ({
  writeFile: mockWriteFile,
  mkdir: mockMkdir,
}));
vi.mock("@/agents/registry/index.js", () => ({
  AgentRegistryStore: vi.fn().mockImplementation(() => mockAgentRegistryStore),
}));
vi.mock("@/core/knowledge-base.js", () => ({
  VectorMemory: vi.fn().mockImplementation(() => ({
    init: vi.fn(),
    getEmbedder: vi.fn().mockReturnValue(null),
  })),
}));
vi.mock("@/core/config.js", () => ({
  CONFIG: { vectorStorePath: "/tmp/v", memoryBackend: "local_json" },
}));

import { autoExportAudit, buildCustomCompositionRules } from "@/work-runner/session-finalize.js";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("autoExportAudit", () => {
  it("builds audit trail and writes to session directory", async () => {
    await autoExportAudit("session-123", 1, { task_queue: [] }, Date.now(), []);

    expect(mockBuildAuditTrail).toHaveBeenCalledWith(
      "session-123",
      1,
      expect.any(Object),
      expect.any(Number),
      expect.any(Number),
      [],
    );
    expect(mockMkdir).toHaveBeenCalledWith(
      expect.stringContaining("session-123"),
      { recursive: true },
    );
    expect(mockWriteFile).toHaveBeenCalledWith(
      expect.stringContaining("audit.md"),
      "# Audit\nContent",
      "utf-8",
    );
  });

  it("never throws — swallows all errors", async () => {
    mockBuildAuditTrail.mockRejectedValue(new Error("audit failure"));
    await expect(autoExportAudit("s1", 1, {}, 0, [])).resolves.not.toThrow();
  });
});

describe("buildCustomCompositionRules", () => {
  it("returns empty array when no custom agents", () => {
    mockAgentRegistryStore.loadAllSync.mockReturnValue([]);
    const rules = buildCustomCompositionRules();
    expect(rules).toEqual([]);
  });

  it("builds rules from agents with compositionRules", () => {
    mockAgentRegistryStore.loadAllSync.mockReturnValue([
      {
        role: "code-reviewer",
        description: "Reviews code",
        compositionRules: {
          required: true,
          includeKeywords: ["review", "quality"],
          excludeKeywords: ["quick"],
        },
      },
      {
        role: "tester",
        description: "Runs tests",
        // No compositionRules — should be excluded
      },
    ]);

    const rules = buildCustomCompositionRules();

    expect(rules).toHaveLength(1);
    expect(rules[0]).toEqual({
      role: "code-reviewer",
      required: true,
      keywords: ["review", "quality"],
      negativeKeywords: ["quick"],
      description: "Reviews code",
    });
  });

  it("returns empty array on registry error", () => {
    mockAgentRegistryStore.loadAllSync.mockImplementation(() => { throw new Error("registry broken"); });
    const rules = buildCustomCompositionRules();
    expect(rules).toEqual([]);
  });
});
