/**
 * TUI E2E tests — exercise the full TUI app with VirtualTerminal.
 *
 * These tests launch the actual launchTUI() function with a VirtualTerminal,
 * simulate user input, and assert on rendered output. LLM providers are
 * mocked via TEAMCLAW_MOCK_LLM=true to avoid real API calls.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { TUIHarness } from "./helpers/tui-harness.js";

// Mock the provider factory to avoid real provider initialization
const { mockProviderManager } = vi.hoisted(() => ({
  mockProviderManager: {
    getProviders: vi.fn().mockReturnValue([
      { name: "mock", isAvailable: () => true, healthCheck: async () => true, setAvailable: () => {} },
    ]),
    stream: vi.fn(async function* () {
      yield { content: "mock response", done: true, usage: { promptTokens: 10, completionTokens: 5 } };
    }),
    generate: vi.fn().mockResolvedValue({ text: "mock", usage: { promptTokens: 10, completionTokens: 5 } }),
    getStats: vi.fn().mockReturnValue({ fallbacksTriggered: 0 }),
    resetStats: vi.fn(),
  },
}));

vi.mock("@/providers/provider-factory.js", () => ({
  getGlobalProviderManager: () => mockProviderManager,
  setGlobalProviderManager: vi.fn(),
  resetGlobalProviderManager: vi.fn(),
}));

vi.mock("@/core/global-config.js", () => ({
  readGlobalConfig: vi.fn().mockReturnValue({
    providers: [{ name: "mock", type: "anthropic", apiKey: "sk-test", enabled: true }],
    model: "claude-sonnet-4-6",
    dashboardPort: 9001,
  }),
  readGlobalConfigWithDefaults: vi.fn().mockReturnValue({
    providers: [{ name: "mock", type: "anthropic", apiKey: "sk-test", enabled: true }],
    model: "claude-sonnet-4-6",
    dashboardPort: 9001,
    memoryBackend: "local_json",
  }),
}));

vi.mock("@/core/team-config.js", () => ({
  loadTeamConfig: vi.fn().mockResolvedValue({
    template: "maker_reviewer",
    roster: [{ role: "architect", count: 1, description: "Architect" }],
  }),
}));

vi.mock("@/core/team-templates.js", () => ({
  buildTeamFromRoster: vi.fn().mockReturnValue([{ id: "architect-1", name: "Architect", role_id: "architect" }]),
  buildTeamFromTemplate: vi.fn().mockReturnValue([{ id: "maker-1", name: "Maker" }]),
}));

describe("TUI E2E", () => {
  let harness: TUIHarness;

  afterEach(async () => {
    try {
      await harness?.stop();
    } catch {
      // Cleanup errors are non-critical in tests
    }
  });

  describe("launch and basic interaction", () => {
    it("shows welcome message on launch", async () => {
      harness = new TUIHarness();
      await harness.start();

      await harness.waitFor("TeamClaw", 5000);
      const output = harness.getVisibleOutput();
      expect(output).toContain("TeamClaw");
    });

    it("shows /help hint in welcome", async () => {
      harness = new TUIHarness();
      await harness.start();

      await harness.waitFor("/help", 5000);
      const output = harness.getVisibleOutput();
      expect(output).toContain("/help");
      expect(output).toContain("just type");
    });
  });

  describe("/help command", () => {
    it("lists control commands (not /work — that's natural language)", async () => {
      harness = new TUIHarness();
      await harness.start();

      harness.command("help");
      await harness.waitFor("Available commands", 5000);

      const output = harness.getVisibleOutput();
      // Control commands should be listed
      expect(output).toContain("/status");
      expect(output).toContain("/config");
      expect(output).toContain("/quit");
      // /work should NOT be a slash command anymore
      expect(output).not.toMatch(/\/work\b/);
    });
  });

  describe("/status command", () => {
    it("shows provider health", async () => {
      harness = new TUIHarness();
      await harness.start();

      harness.command("status");
      await harness.waitFor("Provider", 5000);

      const output = harness.getVisibleOutput();
      expect(output).toContain("mock");
      expect(output).toMatch(/available|health/i);
    });

    it("shows team info", async () => {
      harness = new TUIHarness();
      await harness.start();

      harness.command("status");
      await harness.waitFor("Team", 5000);

      const output = harness.getVisibleOutput();
      expect(output).toContain("Team");
    });
  });

  describe("unknown command", () => {
    it("shows error with help suggestion", async () => {
      harness = new TUIHarness();
      await harness.start();

      harness.command("notacommand");
      await harness.waitFor("Unknown command", 5000);

      const output = harness.getVisibleOutput();
      expect(output).toContain("Unknown command");
      expect(output).toContain("/help");
    });
  });

  describe("natural language input", () => {
    it("routes natural language to agent pipeline (not /work required)", async () => {
      harness = new TUIHarness();
      await harness.start();

      harness.submit("Build an auth system");
      // Should show user message and start working (or show error if no providers)
      await harness.waitFor("Build an auth system", 5000);

      const output = harness.getVisibleOutput();
      // Should NOT show "Use /work" guidance — natural language goes to agent
      expect(output).not.toContain("Use /work");
      expect(output).toContain("Build an auth system");
    });
  });

  describe("/config command", () => {
    it("shows usage when called without args", async () => {
      harness = new TUIHarness();
      await harness.start();

      harness.command("config help");
      await harness.waitFor("Usage", 5000);

      const output = harness.getVisibleOutput();
      expect(output).toContain("/config get");
      expect(output).toContain("/config set");
    });
  });

  describe("session persistence", () => {
    it("creates session JSONL file", async () => {
      harness = new TUIHarness();
      await harness.start();

      harness.submit("test message");
      await harness.waitFor("test message", 3000);

      // Session file should exist in the harness sessions dir
      const { readdirSync, readFileSync } = await import("node:fs");
      const path = await import("node:path");
      const dirs = readdirSync(harness.sessionsDir).filter((d) => d.startsWith("tui-"));
      expect(dirs.length).toBeGreaterThan(0);

      const sessionDir = path.join(harness.sessionsDir, dirs[0]!);
      const jsonl = readFileSync(path.join(sessionDir, "messages.jsonl"), "utf-8");
      const lines = jsonl.trim().split("\n");

      // First line is metadata
      const meta = JSON.parse(lines[0]!);
      expect(meta.type).toBe("meta");

      // Should have user messages
      const entries = lines.slice(1).map((l) => JSON.parse(l));
      expect(entries.some((e: Record<string, unknown>) => e.role === "user")).toBe(true);
    });
  });
});
