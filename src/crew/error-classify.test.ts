import { describe, expect, it } from "bun:test";

import { classifyTaskError, shouldRetry } from "./error-classify.js";
import { CrewTaskSchema } from "./types.js";

const TASK = CrewTaskSchema.parse({
  id: "t1",
  phase_id: "p1",
  description: "Run the build",
  assigned_agent: "coder",
});

describe("classifyTaskError — shell signals", () => {
  it("exit 127 → env_command_not_found, no retry", () => {
    const r = classifyTaskError(
      { source: "shell_exec", exit_code: 127, stderr: "bun: command not found" },
      TASK,
    );
    expect(r.kind).toBe("env_command_not_found");
    expect(r.retry_eligible).toBe(false);
  });

  it("stderr 'command not found' (any exit) → env_command_not_found", () => {
    const r = classifyTaskError(
      { source: "shell_exec", exit_code: 1, stderr: "sh: 1: foo: command not found" },
      TASK,
    );
    expect(r.kind).toBe("env_command_not_found");
  });

  it("'Cannot find module' → env_missing_dep, no retry", () => {
    const r = classifyTaskError(
      {
        source: "shell_exec",
        exit_code: 1,
        stderr: "Error: Cannot find module 'foo'",
      },
      TASK,
    );
    expect(r.kind).toBe("env_missing_dep");
    expect(r.retry_eligible).toBe(false);
  });

  it("MODULE_NOT_FOUND → env_missing_dep", () => {
    const r = classifyTaskError(
      { source: "shell_exec", exit_code: 1, stderr: "MODULE_NOT_FOUND" },
      TASK,
    );
    expect(r.kind).toBe("env_missing_dep");
  });

  it("EACCES / permission denied → env_perm", () => {
    const r = classifyTaskError(
      { source: "shell_exec", exit_code: 1, stderr: "EACCES: permission denied" },
      TASK,
    );
    expect(r.kind).toBe("env_perm");
    expect(r.retry_eligible).toBe(false);
  });

  it("EADDRINUSE → env_port_in_use", () => {
    const r = classifyTaskError(
      { source: "shell_exec", exit_code: 1, stderr: "Error: listen EADDRINUSE: address already in use :::3000" },
      TASK,
    );
    expect(r.kind).toBe("env_port_in_use");
    expect(r.retry_eligible).toBe(false);
  });

  it("'timed out' in stderr → timeout, no retry", () => {
    const r = classifyTaskError(
      { source: "shell_exec", exit_code: 1, stderr: "operation timed out" },
      TASK,
    );
    expect(r.kind).toBe("timeout");
    expect(r.retry_eligible).toBe(false);
  });

  it("non-zero exit with no env signature → agent_logic, retry-eligible", () => {
    const r = classifyTaskError(
      { source: "shell_exec", exit_code: 1, stderr: "Test failed: expected 1 got 2" },
      TASK,
    );
    expect(r.kind).toBe("agent_logic");
    expect(r.retry_eligible).toBe(true);
  });
});

describe("classifyTaskError — validator + timeout + agent_error", () => {
  it("validator failure → agent_logic, retry-eligible", () => {
    const r = classifyTaskError(
      { source: "validator", reason: "claimed src/foo.ts missing on disk" },
      TASK,
    );
    expect(r.kind).toBe("agent_logic");
    expect(r.retry_eligible).toBe(true);
    expect(r.reason).toContain("validator");
  });

  it("wall-time exceeded → timeout, no retry", () => {
    const r = classifyTaskError(
      { source: "timeout", budget_ms: 60_000, elapsed_ms: 90_000 },
      TASK,
    );
    expect(r.kind).toBe("timeout");
    expect(r.retry_eligible).toBe(false);
  });

  it("agent_error catch-all → agent_logic, retry-eligible", () => {
    const r = classifyTaskError(
      { source: "agent_error", message: "LLM returned malformed JSON" },
      TASK,
    );
    expect(r.kind).toBe("agent_logic");
    expect(r.retry_eligible).toBe(true);
  });
});

describe("shouldRetry — retry caps", () => {
  it("agent_logic retries up to 2x", () => {
    const c = { kind: "agent_logic" as const, retry_eligible: true, reason: "" };
    expect(shouldRetry(c, 0)).toBe(true);
    expect(shouldRetry(c, 1)).toBe(true);
    expect(shouldRetry(c, 2)).toBe(false);
  });

  it("env_* never retries even with retry_eligible coerced true", () => {
    const c = { kind: "env_command_not_found" as const, retry_eligible: false, reason: "" };
    expect(shouldRetry(c, 0)).toBe(false);
  });

  it("timeout never retries", () => {
    const c = { kind: "timeout" as const, retry_eligible: false, reason: "" };
    expect(shouldRetry(c, 0)).toBe(false);
  });

  it("unknown retries once", () => {
    const c = { kind: "unknown" as const, retry_eligible: true, reason: "" };
    expect(shouldRetry(c, 0)).toBe(true);
    expect(shouldRetry(c, 1)).toBe(false);
  });
});
