import { describe, it, expect, vi, beforeEach } from "vitest";
import { ROLE_TEMPLATES } from "@/core/bot-definitions.js";
import { KNOWN_FLAGS } from "@/graph/confidence/types.js";

// Mock the adapter to avoid needing OpenClaw
vi.mock("@/adapters/worker-adapter.js", () => ({
  UniversalOpenClawAdapter: class {
    constructor(public options: Record<string, unknown>) {}
    executeTask = vi.fn().mockResolvedValue({
      task_id: "test",
      success: true,
      output: "done",
      quality_score: 0.8,
    });
    healthCheck = vi.fn().mockResolvedValue(true);
    complete = vi.fn().mockResolvedValue("ok");
    getStatus = vi.fn().mockResolvedValue({});
    reset = vi.fn();
    adapterType = "provider" as const;
  },
}));

vi.mock("@/core/config.js", () => ({
  CONFIG: {
    openclawWorkerUrl: "http://localhost:8001",
    openclawToken: "test",
  },
}));

describe("createCustomWorkerBots", () => {
  beforeEach(() => {
    // Clean up any dynamically added templates
    for (const key of Object.keys(ROLE_TEMPLATES)) {
      if (key.startsWith("code_reviewer") || key === "security_auditor") {
        delete ROLE_TEMPLATES[key];
      }
    }
  });

  it("creates bots and registers role templates", async () => {
    const { createCustomWorkerBots } = await import("@/agents/registry/node-factory.js");

    const agents = [
      {
        role: "code-reviewer",
        displayName: "Code Reviewer",
        description: "Reviews code",
        taskTypes: ["review"],
        systemPrompt: "You are a code reviewer.",
      },
    ];

    const { bots, botDefs } = createCustomWorkerBots(agents, "/tmp/workspace");

    expect(Object.keys(bots)).toHaveLength(1);
    expect(bots["custom-code-reviewer"]).toBeDefined();
    expect(botDefs).toHaveLength(1);
    expect(botDefs[0].id).toBe("custom-code-reviewer");
    expect(botDefs[0].role_id).toBe("code_reviewer");
    expect(botDefs[0].name).toBe("Code Reviewer");

    // Verify role template was registered
    expect(ROLE_TEMPLATES["code_reviewer"]).toBeDefined();
    expect(ROLE_TEMPLATES["code_reviewer"].task_types).toEqual(["review"]);
  });

  it("passes systemPromptOverride to adapter", async () => {
    const { createCustomWorkerBots } = await import("@/agents/registry/node-factory.js");

    const agents = [
      {
        role: "security-auditor",
        displayName: "Security Auditor",
        description: "Audits for security issues",
        taskTypes: ["audit"],
        systemPrompt: "You are a security auditor. Check for vulnerabilities.",
      },
    ];

    const { bots } = createCustomWorkerBots(agents, "/tmp/workspace");
    const bot = bots["custom-security-auditor"];
    const adapter = bot.adapter as unknown as { options: Record<string, unknown> };
    expect(adapter.options.systemPromptOverride).toBe(
      "You are a security auditor. Check for vulnerabilities.",
    );
  });

  it("registers custom confidence flags", async () => {
    const { createCustomWorkerBots } = await import("@/agents/registry/node-factory.js");

    const agents = [
      {
        role: "code-reviewer",
        displayName: "Code Reviewer",
        description: "Reviews code",
        taskTypes: ["review"],
        systemPrompt: "Review code.",
        confidenceConfig: {
          flags: ["style-violation", "security-issue"],
        },
      },
    ];

    createCustomWorkerBots(agents, "/tmp/workspace");

    expect(KNOWN_FLAGS.has("style-violation")).toBe(true);
    expect(KNOWN_FLAGS.has("security-issue")).toBe(true);
  });
});
