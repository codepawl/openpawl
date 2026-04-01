import { describe, it, expect, vi, beforeEach } from "vitest";

// --- Mocks ---
vi.mock("@clack/prompts", () => ({
  intro: vi.fn(),
  outro: vi.fn(),
  note: vi.fn(),
}));

const mockProvider = {
  name: "anthropic",
  isAvailable: vi.fn().mockReturnValue(true),
  healthCheck: vi.fn().mockResolvedValue(true),
};
vi.mock("@/providers/provider-factory.js", () => ({
  getGlobalProviderManager: vi.fn().mockReturnValue({
    getProviders: () => [mockProvider],
  }),
}));

vi.mock("@/core/team-config.js", () => ({
  loadTeamConfig: vi.fn().mockResolvedValue({
    roster: [
      { role: "architect", count: 1, description: "Architect" },
    ],
    template: "game_dev",
  }),
}));

vi.mock("@/core/team-templates.js", () => ({
  buildTeamFromRoster: vi.fn().mockReturnValue([
    { id: "architect-1", name: "Architect" },
  ]),
  buildTeamFromTemplate: vi.fn().mockReturnValue([]),
}));

import { runStatusCommand } from "@/commands/status.js";
import { intro, note, outro } from "@clack/prompts";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("teamclaw status", () => {
  it("displays provider status", async () => {
    await runStatusCommand();

    expect(intro).toHaveBeenCalledWith("TeamClaw Status");
    expect(note).toHaveBeenCalledWith(
      expect.stringContaining("anthropic"),
      "Providers",
    );
  });

  it("displays team roster", async () => {
    await runStatusCommand();

    expect(note).toHaveBeenCalledWith(
      expect.stringContaining("architect"),
      "Roster",
    );
  });

  it("displays system resource info", async () => {
    await runStatusCommand();

    expect(note).toHaveBeenCalledWith(
      expect.stringMatching(/RSS|Heap|CPU/),
      "System",
    );
  });

  it("shows outro on completion", async () => {
    await runStatusCommand();
    expect(outro).toHaveBeenCalledWith("Status complete.");
  });

  it("handles unhealthy provider", async () => {
    mockProvider.healthCheck.mockResolvedValue(false);
    mockProvider.isAvailable.mockReturnValue(false);

    await runStatusCommand();

    expect(note).toHaveBeenCalledWith(
      expect.stringContaining("unavailable"),
      "Providers",
    );
  });

  describe("UX: execution flow order", () => {
    it("follows correct order: intro → providers → roster → system → outro", async () => {
      const callOrder: string[] = [];
      vi.mocked(intro).mockImplementation(() => { callOrder.push("intro"); });
      vi.mocked(note).mockImplementation((_msg: string, title?: string) => { callOrder.push(`note:${title}`); });
      vi.mocked(outro).mockImplementation(() => { callOrder.push("outro"); });

      await runStatusCommand();

      expect(callOrder).toEqual([
        "intro",
        "note:Providers",
        "note:Roster",
        "note:System",
        "outro",
      ]);
    });

    it("provider health check shows both availability and health status", async () => {
      mockProvider.isAvailable.mockReturnValue(true);
      mockProvider.healthCheck.mockResolvedValue(true);

      await runStatusCommand();

      const providerNote = vi.mocked(note).mock.calls.find(
        (c) => c[1] === "Providers",
      );
      expect(providerNote).toBeDefined();
      const content = providerNote![0] as string;
      expect(content).toContain("anthropic");
      expect(content).toContain("available");
      expect(content).toContain("ok");
    });
  });
});
