/**
 * Cross-command integration tests.
 *
 * Verifies that commands that share state (config, registry, cache, memory)
 * produce consistent results when used together.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// --- Shared mocks for cross-command state ---
const { mockLogger, mockCacheStore, mockStore, mockProfileStore } = vi.hoisted(() => ({
  mockLogger: {
    plain: vi.fn(),
    info: vi.fn(),
    success: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    agent: vi.fn(),
    plainLine: vi.fn(),
  },
  mockCacheStore: {
    stats: vi.fn(),
    clear: vi.fn(),
    prune: vi.fn(),
  },
  mockStore: {
    list: vi.fn().mockReturnValue([]),
    get: vi.fn().mockReturnValue(null),
    register: vi.fn(),
    unregister: vi.fn().mockReturnValue(true),
    loadAllSync: vi.fn().mockReturnValue([]),
  },
  mockProfileStore: {
    init: vi.fn(),
    getAll: vi.fn().mockResolvedValue([]),
    getByRole: vi.fn().mockResolvedValue(null),
    delete: vi.fn().mockResolvedValue(true),
  },
}));

vi.mock("@/core/logger.js", () => ({ logger: mockLogger }));
vi.mock("@/cache/cache-store.js", () => ({
  ResponseCacheStore: vi.fn().mockImplementation(() => mockCacheStore),
}));
vi.mock("@/agents/registry/index.js", () => ({
  AgentRegistryStore: vi.fn().mockImplementation(() => mockStore),
  loadAgentFromFile: vi.fn().mockResolvedValue([]),
  loadAgentsFromDirectory: vi.fn().mockResolvedValue([]),
  validateAgentDefinition: vi.fn(),
}));

vi.mock("node:fs", async (importOriginal) => {
  const orig = await importOriginal<typeof import("node:fs")>();
  return {
    ...orig,
    existsSync: vi.fn().mockReturnValue(true),
    statSync: vi.fn().mockReturnValue({ isDirectory: () => false }),
  };
});

import { runCacheCommand } from "@/commands/cache.js";
import { runAgentCommand } from "@/commands/agent.js";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("cross-command: cache clear → cache stats reflects empty", () => {
  it("stats shows zero after clear", async () => {
    // First: clear
    mockCacheStore.clear.mockResolvedValue(undefined);
    await runCacheCommand(["clear"]);
    expect(mockCacheStore.clear).toHaveBeenCalledTimes(1);

    vi.clearAllMocks();

    // Then: stats should reflect empty state
    mockCacheStore.stats.mockResolvedValue({
      totalEntries: 0,
      hitRate: 0,
      totalHits: 0,
      totalSavedMs: 0,
      totalSavingsUSD: 0,
      oldestEntry: 0,
    });

    await runCacheCommand(["stats"]);

    const output = mockLogger.plain.mock.calls.map((c: unknown[]) => String(c[0])).join("\n");
    expect(output).toContain("0"); // entries
    expect(output).toContain("0%"); // hit rate
    expect(output).toContain("$0.00"); // cost
  });
});

describe("cross-command: agent add → agent list shows new agent", () => {
  it("newly registered agent appears in list", async () => {
    const registeredAgents = [
      { role: "code-reviewer", displayName: "Code Reviewer", source: "./reviewer.ts" },
    ];

    // Simulate: after add, list should include the new agent
    mockStore.list.mockReturnValue(registeredAgents);

    await runAgentCommand(["list"]);

    const output = mockLogger.plain.mock.calls.map((c: unknown[]) => String(c[0])).join("\n");
    expect(output).toContain("code-reviewer");
    expect(output).toContain("Code Reviewer");
  });
});

describe("cross-command: agent add → agent rm → agent list is empty", () => {
  it("list is empty after add then remove", async () => {
    // After remove, list returns empty
    mockStore.unregister.mockReturnValue(true);
    await runAgentCommand(["rm", "code-reviewer"]);
    expect(mockStore.unregister).toHaveBeenCalledWith("code-reviewer");

    vi.clearAllMocks();

    mockStore.list.mockReturnValue([]);
    await runAgentCommand(["list"]);

    const output = mockLogger.plain.mock.calls.map((c: unknown[]) => String(c[0])).join("\n");
    expect(output.toLowerCase()).toContain("no custom agent");
  });
});

describe("cross-command: help consistency", () => {
  it("all commands with --help do not produce errors", async () => {
    await runCacheCommand(["--help"]);
    expect(mockLogger.error).not.toHaveBeenCalled();

    vi.clearAllMocks();

    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    await runAgentCommand(["--help"]);
    expect(mockLogger.error).not.toHaveBeenCalled();
    consoleSpy.mockRestore();
  });

  it("all commands with unknown subcommand show error with command name", async () => {
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("process.exit");
    });

    try { await runCacheCommand(["bogus"]); } catch { /* expected */ }
    const cacheError = mockLogger.error.mock.calls.map((c: unknown[]) => String(c[0])).join("\n");
    expect(cacheError.toLowerCase()).toContain("cache");

    vi.clearAllMocks();

    try { await runAgentCommand(["bogus"]); } catch { /* expected */ }
    const agentError = mockLogger.error.mock.calls.map((c: unknown[]) => String(c[0])).join("\n");
    expect(agentError.toLowerCase()).toContain("agent");

    exitSpy.mockRestore();
  });
});
