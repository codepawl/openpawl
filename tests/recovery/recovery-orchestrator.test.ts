import { describe, it, expect, vi } from "vitest";
import { RecoveryOrchestrator } from "../../src/recovery/recovery-orchestrator.js";

describe("RecoveryOrchestrator", () => {
  it("routes provider timeout to network category", async () => {
    const orch = new RecoveryOrchestrator();
    const result = await orch.handleError({ type: "timeout", code: "ETIMEDOUT" }, { provider: "anthropic" });
    expect(result.category).toBe("network");
    expect(result.recoverable).toBe(true);
  });

  it("routes rate_limit correctly", async () => {
    const orch = new RecoveryOrchestrator();
    const result = await orch.handleError({ type: "rate_limit" }, { provider: "openai" });
    expect(result.category).toBe("rate_limit");
  });

  it("routes auth error as non-recoverable", async () => {
    const orch = new RecoveryOrchestrator();
    const result = await orch.handleError({ type: "auth_failed" }, { provider: "anthropic" });
    expect(result.category).toBe("auth");
    expect(result.recoverable).toBe(false);
  });

  it("emits error:occurred on every error", async () => {
    const orch = new RecoveryOrchestrator();
    const events: string[] = [];
    orch.on("error:occurred", () => events.push("occurred"));

    await orch.handleError(new Error("test"), {});
    expect(events).toContain("occurred");
  });

  it("emits error:recovered for recoverable errors", async () => {
    const orch = new RecoveryOrchestrator();
    const events: string[] = [];
    orch.on("error:recovered", () => events.push("recovered"));

    await orch.handleError({ type: "rate_limit" }, { provider: "test" });
    expect(events).toContain("recovered");
  });

  it("emits error:fatal for non-recoverable errors", async () => {
    const orch = new RecoveryOrchestrator();
    const events: string[] = [];
    orch.on("error:fatal", () => events.push("fatal"));

    await orch.handleError({ type: "auth_failed" }, { provider: "test" });
    expect(events).toContain("fatal");
  });

  it("circuit breaker integration: open circuit → fallback", async () => {
    const orch = new RecoveryOrchestrator();
    const cb = orch.getCircuitBreaker();

    // Trip the circuit breaker
    for (let i = 0; i < 5; i++) cb.recordFailure("broken-provider");

    const result = await orch.handleError({ type: "timeout" }, { provider: "broken-provider" });
    expect(result.userMessage).toContain("circuit open");
    expect(result.strategy.type).toBe("fallback");
  });
});
