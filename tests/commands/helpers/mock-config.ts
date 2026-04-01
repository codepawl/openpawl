/**
 * Shared config mocking utilities.
 * Provides fixture configs and vi.mock factories.
 */

/** Minimal valid global config fixture. */
export function validGlobalConfig() {
  return {
    providers: [
      {
        name: "anthropic",
        type: "anthropic",
        apiKey: "sk-ant-test-key-000000000000",
        enabled: true,
        isDefault: true,
      },
    ],
    defaultModel: "claude-sonnet-4-20250514",
    memoryBackend: "local_json" as const,
    dashboardPort: 9001,
    cacheEnabled: true,
    creativity: 0.7,
    llmTimeoutMs: 60000,
    loggingLevel: "info" as const,
    meta: { updatedAt: new Date().toISOString() },
  };
}

/** Global config with no providers configured. */
export function emptyGlobalConfig() {
  return {
    providers: [],
    defaultModel: "",
    memoryBackend: "local_json" as const,
    dashboardPort: 9001,
    cacheEnabled: false,
    creativity: 0.7,
    llmTimeoutMs: 60000,
    loggingLevel: "info" as const,
    meta: { updatedAt: new Date().toISOString() },
  };
}

/** Minimal valid teamclaw.json fixture. */
export function validTeamConfig() {
  return {
    name: "test-project",
    goal: "Build a test app",
    template: "game_dev",
    roster: [
      { role: "architect", count: 1, description: "System architect" },
      { role: "developer", count: 2, description: "Full-stack dev" },
    ],
    memory_backend: "local_json" as const,
  };
}

/** Empty/missing teamclaw config. */
export function emptyTeamConfig() {
  return null;
}
