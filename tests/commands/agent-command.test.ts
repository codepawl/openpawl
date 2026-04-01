import { describe, it, expect, vi, beforeEach } from "vitest";

// --- Mocks ---
const { mockLogger, mockStore, mockLoadAgentFromFile, mockLoadAgentsFromDirectory, mockValidateAgentDefinition } = vi.hoisted(() => ({
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
  mockStore: {
    list: vi.fn().mockReturnValue([]),
    get: vi.fn().mockReturnValue(null),
    register: vi.fn(),
    remove: vi.fn().mockReturnValue(true),
    unregister: vi.fn().mockReturnValue(true),
    loadAllSync: vi.fn().mockReturnValue([]),
  },
  mockLoadAgentFromFile: vi.fn(),
  mockLoadAgentsFromDirectory: vi.fn(),
  mockValidateAgentDefinition: vi.fn(),
}));
vi.mock("@/core/logger.js", () => ({ logger: mockLogger }));
vi.mock("@/agents/registry/index.js", () => ({
  AgentRegistryStore: vi.fn().mockImplementation(() => mockStore),
  loadAgentFromFile: (...args: unknown[]) => mockLoadAgentFromFile(...args),
  loadAgentsFromDirectory: (...args: unknown[]) => mockLoadAgentsFromDirectory(...args),
  validateAgentDefinition: (...args: unknown[]) => mockValidateAgentDefinition(...args),
}));

// Mock node:fs for existsSync/statSync
vi.mock("node:fs", async (importOriginal) => {
  const orig = await importOriginal<typeof import("node:fs")>();
  return {
    ...orig,
    existsSync: vi.fn().mockReturnValue(true),
    statSync: vi.fn().mockReturnValue({ isDirectory: () => false }),
  };
});

import { runAgentCommand } from "@/commands/agent.js";
import { existsSync, statSync } from "node:fs";

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(existsSync).mockReturnValue(true);
  vi.mocked(statSync).mockReturnValue({ isDirectory: () => false } as ReturnType<typeof statSync>);
});

describe("teamclaw agent", () => {
  describe("argument parsing", () => {
    it("--help prints usage", async () => {
      // agent command uses console.log directly for help
      const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
      await runAgentCommand(["--help"]);
      const output = consoleSpy.mock.calls.map((c) => String(c[0])).join("\n");
      expect(output).toContain("agent");
      expect(output).toContain("add");
      expect(output).toContain("list");
      consoleSpy.mockRestore();
    });

    it("no args prints help with all subcommands", async () => {
      const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
      await runAgentCommand([]);
      const output = consoleSpy.mock.calls.map((c) => String(c[0])).join("\n");
      expect(output).toContain("add");
      expect(output).toContain("list");
      expect(output).toContain("show");
      expect(output).toContain("remove");
      expect(output).toContain("validate");
      consoleSpy.mockRestore();
    });

    it("unknown subcommand shows error and exits", async () => {
      const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => {
        throw new Error("process.exit");
      });

      await expect(runAgentCommand(["bogus"])).rejects.toThrow("process.exit");
      expect(mockLogger.error).toHaveBeenCalledWith(
        expect.stringContaining("Unknown subcommand"),
      );

      exitSpy.mockRestore();
    });
  });

  describe("agent list subcommand", () => {
    it("shows 'no custom agents' when registry is empty", async () => {
      mockStore.list.mockReturnValue([]);

      await runAgentCommand(["list"]);

      const output = mockLogger.plain.mock.calls.map((c: unknown[]) => String(c[0])).join("\n");
      expect(output.toLowerCase()).toContain("no custom agent");
    });

    it("lists registered agents", async () => {
      mockStore.list.mockReturnValue([
        { role: "code-reviewer", displayName: "Code Reviewer", source: "./reviewer.ts" },
        { role: "tester", displayName: "Tester", source: "./tester.ts" },
      ]);

      await runAgentCommand(["list"]);

      const output = mockLogger.plain.mock.calls.map((c: unknown[]) => String(c[0])).join("\n");
      expect(output).toContain("code-reviewer");
      expect(output).toContain("tester");
    });

    it("ls is an alias for list", async () => {
      mockStore.list.mockReturnValue([]);
      await runAgentCommand(["ls"]);
      expect(mockStore.list).toHaveBeenCalled();
    });
  });

  describe("agent add subcommand", () => {
    it("errors when no source is provided", async () => {
      const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => {
        throw new Error("process.exit");
      });

      await expect(runAgentCommand(["add"])).rejects.toThrow("process.exit");
      expect(mockLogger.error).toHaveBeenCalledWith(
        expect.stringContaining("Usage"),
      );

      exitSpy.mockRestore();
    });

    it("errors when source file does not exist", async () => {
      vi.mocked(existsSync).mockReturnValue(false);
      const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => {
        throw new Error("process.exit");
      });

      await expect(runAgentCommand(["add", "./nonexistent.ts"])).rejects.toThrow("process.exit");
      expect(mockLogger.error).toHaveBeenCalledWith(
        expect.stringContaining("not found"),
      );

      exitSpy.mockRestore();
    });

    it("loads agent from file when source is a file", async () => {
      vi.mocked(existsSync).mockReturnValue(true);
      vi.mocked(statSync).mockReturnValue({ isDirectory: () => false } as ReturnType<typeof statSync>);
      mockLoadAgentFromFile.mockResolvedValue([
        { role: "reviewer", description: "Reviewer" },
      ]);
      mockStore.register.mockResolvedValue({
        role: "reviewer",
        displayName: "Reviewer",
        source: "./reviewer.ts",
        registeredAt: new Date().toISOString(),
        description: "Reviewer",
      });

      await runAgentCommand(["add", "./reviewer.ts"]);

      expect(mockLoadAgentFromFile).toHaveBeenCalledWith(
        expect.stringContaining("reviewer.ts"),
      );
      expect(mockStore.register).toHaveBeenCalledWith(
        expect.objectContaining({ role: "reviewer" }),
        expect.stringContaining("reviewer.ts"),
      );
      // Success message includes role name and count
      const successCalls = mockLogger.success.mock.calls.map((c: unknown[]) => String(c[0])).join("\n");
      expect(successCalls).toContain("Reviewer");
      expect(successCalls).toContain("1 agent(s)");
    });

    it("loads agents from directory and registers each with directory-relative path", async () => {
      vi.mocked(existsSync).mockReturnValue(true);
      vi.mocked(statSync).mockReturnValue({ isDirectory: () => true } as ReturnType<typeof statSync>);
      mockLoadAgentsFromDirectory.mockResolvedValue([
        { role: "a", description: "A" },
        { role: "b", description: "B" },
      ]);
      mockStore.register
        .mockResolvedValueOnce({ role: "a", displayName: "A", source: "./agents/a.ts", registeredAt: "", description: "" })
        .mockResolvedValueOnce({ role: "b", displayName: "B", source: "./agents/b.ts", registeredAt: "", description: "" });

      await runAgentCommand(["add", "./agents/"]);

      expect(mockLoadAgentsFromDirectory).toHaveBeenCalled();
      expect(mockStore.register).toHaveBeenCalledTimes(2);
      const successCalls = mockLogger.success.mock.calls.map((c: unknown[]) => String(c[0])).join("\n");
      expect(successCalls).toContain("2 agent(s)");
    });
  });

  describe("agent remove subcommand", () => {
    it("errors when no role is provided", async () => {
      const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => {
        throw new Error("process.exit");
      });

      await expect(runAgentCommand(["remove"])).rejects.toThrow("process.exit");

      exitSpy.mockRestore();
    });

    it("rm is an alias for remove", async () => {
      mockStore.unregister.mockReturnValue(true);
      await runAgentCommand(["rm", "code-reviewer"]);
      expect(mockStore.unregister).toHaveBeenCalledWith("code-reviewer");
    });
  });

  describe("agent validate subcommand", () => {
    it("errors when no file is provided", async () => {
      const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => {
        throw new Error("process.exit");
      });

      await expect(runAgentCommand(["validate"])).rejects.toThrow("process.exit");

      exitSpy.mockRestore();
    });
  });
});
