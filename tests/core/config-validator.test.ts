import { describe, it, expect } from "bun:test";
import { validateConfig, migrateConfig, OpenPawlConfigSchema } from "../../src/core/config-validator.js";

describe("validateConfig", () => {
  it("accepts valid minimal config", () => {
    const result = validateConfig({ version: 1, dashboardPort: 9001, debugMode: false });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.dashboardPort).toBe(9001);
    }
  });

  it("accepts full config with all optional fields", () => {
    const result = validateConfig({
      version: 1,
      dashboardPort: 9001,
      debugMode: true,
      providers: [
        { type: "anthropic", apiKey: "sk-ant-test" },
        { type: "openai", apiKey: "sk-test" },
      ],
      agentModels: { coordinator: "claude-sonnet-4-6" },
      fallbackChain: ["anthropic", "openai"],
      confidenceScoring: { enabled: true, thresholds: { autoApprove: 0.85 } },
      handoff: { autoGenerate: true },
      personality: { enabled: true },
      workspaceDir: "./workspace",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.providers).toHaveLength(2);
    }
  });

  it("applies default values correctly", () => {
    const result = validateConfig({});
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.dashboardPort).toBe(9001);
      expect(result.data.debugMode).toBe(false);
    }
  });

  it("rejects config with invalid dashboardPort type", () => {
    const result = validateConfig({ dashboardPort: "not-a-number" });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.errors.some(e => e.includes("dashboardPort"))).toBe(true);
    }
  });

  it("allows extra fields via passthrough", () => {
    const result = validateConfig({
      version: 1,
      dashboardPort: 9001,
      debugMode: false,
      someNewField: "future feature",
    });
    expect(result.success).toBe(true);
  });

  it("validates provider entry structure", () => {
    const result = validateConfig({
      providers: [{ type: "anthropic" }],
    });
    expect(result.success).toBe(true);
  });

  it("rejects provider with invalid authMethod", () => {
    const result = validateConfig({
      providers: [{ type: "anthropic", authMethod: "invalid-method" }],
    });
    expect(result.success).toBe(false);
  });

  it("no longer accepts setup-token as authMethod", () => {
    const result = validateConfig({
      providers: [{ type: "anthropic", authMethod: "setup-token" }],
    });
    expect(result.success).toBe(false);
  });
});

describe("dashboard config section", () => {
  it("applies dashboard defaults when section is present", () => {
    const result = validateConfig({ dashboard: {} });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.dashboard).toEqual({
        port: 9001,
        persistent: true,
        autoOpen: false,
      });
    }
  });

  it("accepts custom dashboard values", () => {
    const result = validateConfig({
      dashboard: { port: 8080, persistent: false, autoOpen: true },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.dashboard?.port).toBe(8080);
      expect(result.data.dashboard?.persistent).toBe(false);
      expect(result.data.dashboard?.autoOpen).toBe(true);
    }
  });

  it("rejects dashboard port below 1024", () => {
    const result = validateConfig({ dashboard: { port: 80 } });
    expect(result.success).toBe(false);
  });

  it("rejects dashboard port above 65535", () => {
    const result = validateConfig({ dashboard: { port: 70000 } });
    expect(result.success).toBe(false);
  });
});

describe("work config section", () => {
  it("applies work defaults when section is present", () => {
    const result = validateConfig({ work: {} });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.work).toEqual({
        interactive: true,
        sessionCount: 0,
      });
    }
  });

  it("accepts custom work values", () => {
    const result = validateConfig({
      work: { interactive: false, sessionCount: 5 },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.work?.interactive).toBe(false);
      expect(result.data.work?.sessionCount).toBe(5);
    }
  });
});

describe("timeouts config section", () => {
  it("applies timeout defaults when section is present", () => {
    const result = validateConfig({ timeouts: {} });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.timeouts).toEqual({
        firstChunkMs: 15000,
        requestMs: 60000,
      });
    }
  });

  it("accepts custom timeout values", () => {
    const result = validateConfig({
      timeouts: { firstChunkMs: 5000, requestMs: 120000 },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.timeouts?.firstChunkMs).toBe(5000);
      expect(result.data.timeouts?.requestMs).toBe(120000);
    }
  });
});

describe("agents config section", () => {
  it("accepts agent with tier field", () => {
    const result = validateConfig({
      agents: {
        coordinator: { model: "claude-opus-4-6", tier: "primary" },
        worker: { tier: "fast" },
      },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.agents?.coordinator?.tier).toBe("primary");
      expect(result.data.agents?.worker?.tier).toBe("fast");
    }
  });

  it("rejects agent with invalid tier", () => {
    const result = validateConfig({
      agents: { coordinator: { tier: "ultra" } },
    });
    expect(result.success).toBe(false);
  });

  it("accepts agent with systemPromptAppend", () => {
    const result = validateConfig({
      agents: { coordinator: { systemPromptAppend: "Always be concise." } },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.agents?.coordinator?.systemPromptAppend).toBe("Always be concise.");
    }
  });
});

describe("meta config section", () => {
  it("accepts meta with timestamps", () => {
    const result = validateConfig({
      meta: {
        version: "1",
        createdAt: "2026-03-21T00:00:00.000Z",
        updatedAt: "2026-03-21T12:00:00.000Z",
        setupVersion: "0.5.0",
      },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.meta?.updatedAt).toBe("2026-03-21T12:00:00.000Z");
    }
  });
});

describe("migrateConfig", () => {
  it("migrates providers.firstChunkTimeoutMs to timeouts.firstChunkMs", () => {
    const raw = {
      providers: {
        chain: ["anthropic"],
        firstChunkTimeoutMs: 10000,
        anthropic: { model: "claude-opus-4-6" },
      },
    };
    const migrated = migrateConfig(raw) as Record<string, unknown>;
    const timeouts = migrated.timeouts as Record<string, unknown>;
    expect(timeouts.firstChunkMs).toBe(10000);
    const providers = migrated.providers as Record<string, unknown>;
    expect(providers.firstChunkTimeoutMs).toBeUndefined();
  });

  it("migrates top-level version to meta.version", () => {
    const raw = { version: "1" };
    const migrated = migrateConfig(raw) as Record<string, unknown>;
    const meta = migrated.meta as Record<string, unknown>;
    expect(meta.version).toBe("1");
  });

  it("does not overwrite existing meta", () => {
    const raw = {
      version: "1",
      meta: { version: "2", createdAt: "2026-01-01T00:00:00Z" },
    };
    const migrated = migrateConfig(raw) as Record<string, unknown>;
    const meta = migrated.meta as Record<string, unknown>;
    expect(meta.version).toBe("2");
  });
});

describe("config with no new sections", () => {
  it("all defaults apply correctly for old-style config", () => {
    const result = validateConfig({
      version: 1,
      dashboardPort: 9001,
      debugMode: false,
      providers: [{ type: "anthropic", apiKey: "sk-ant-test" }],
    });
    expect(result.success).toBe(true);
    if (result.success) {
      // New sections should be undefined (optional)
      expect(result.data.dashboard).toBeUndefined();
      expect(result.data.work).toBeUndefined();
      expect(result.data.timeouts).toBeUndefined();
      expect(result.data.agents).toBeUndefined();
    }
  });
});

describe("config with all new sections", () => {
  it("parses without error", () => {
    const result = validateConfig({
      version: 1,
      meta: { version: "1", updatedAt: "2026-03-21T00:00:00Z" },
      dashboardPort: 9001,
      debugMode: false,
      providers: [{ type: "anthropic", apiKey: "sk-ant-test" }],
      agents: {
        coordinator: { model: "claude-opus-4-6", tier: "primary", maxTokens: 4096 },
        worker: { tier: "fast", systemPromptAppend: "Be brief." },
      },
      timeouts: { firstChunkMs: 10000, requestMs: 90000 },
      dashboard: { port: 8080, persistent: true, autoOpen: true },
      work: { interactive: false, sessionCount: 3 },
      confidenceScoring: { enabled: true },
      handoff: { autoGenerate: true },
      personality: { enabled: true },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.agents?.coordinator?.tier).toBe("primary");
      expect(result.data.timeouts?.firstChunkMs).toBe(10000);
      expect(result.data.dashboard?.port).toBe(8080);
      expect(result.data.work?.interactive).toBe(false);
      expect(result.data.meta?.version).toBe("1");
    }
  });
});
