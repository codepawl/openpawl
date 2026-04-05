import { describe, it, expect } from "vitest";
import { ErrorPresenter } from "../../src/recovery/error-presenter.js";

describe("ErrorPresenter", () => {
  const presenter = new ErrorPresenter();

  it("rate_limit → correct message with provider name", () => {
    const result = presenter.present({ type: "rate_limit", provider: "anthropic" }, { provider: "anthropic" });
    expect(result.category).toBe("rate_limit");
    expect(result.userMessage).toContain("anthropic");
    expect(result.recoverable).toBe(true);
  });

  it("timeout → correct message", () => {
    const result = presenter.present({ type: "timeout", code: "ETIMEDOUT" }, { provider: "openai" });
    expect(result.category).toBe("network");
    expect(result.userMessage).toContain("timed out");
  });

  it("auth_failed → message includes auth set command", () => {
    const result = presenter.present({ type: "auth_failed" }, { provider: "anthropic" });
    expect(result.category).toBe("auth");
    expect(result.actionHint).toContain("openpawl auth set");
    expect(result.recoverable).toBe(false);
  });

  it("tool execution_failed → message names the tool", () => {
    const result = presenter.present({ type: "execution_failed" }, { toolName: "shell_exec" });
    expect(result.category).toBe("tool");
    expect(result.userMessage).toContain("shell_exec");
  });

  it("session error → message suggests recovery", () => {
    const result = presenter.present({ type: "not_found", id: "abc" }, {});
    expect(result.category).toBe("session");
    expect(result.actionHint).toContain("checkpoint");
  });

  it("unknown error → generic message with session saved", () => {
    const result = presenter.present(new Error("something weird"), {});
    expect(result.category).toBe("unknown");
    expect(result.actionHint).toContain("session is saved");
  });

  it("formatForChat returns array of lines", () => {
    const error = presenter.present({ type: "rate_limit" }, { provider: "test" });
    const lines = presenter.formatForChat(error);
    expect(Array.isArray(lines)).toBe(true);
    expect(lines.length).toBeGreaterThanOrEqual(1);
  });

  it("formatForStatusBar returns single string", () => {
    const error = presenter.present({ type: "timeout" }, {});
    const bar = presenter.formatForStatusBar(error);
    expect(typeof bar).toBe("string");
    expect(bar.length).toBeLessThanOrEqual(50);
  });

  it("formatForLog includes timestamp", () => {
    const error = presenter.present(new Error("test"), {});
    const log = presenter.formatForLog(error);
    expect(log).toContain("T"); // ISO timestamp marker
  });
});
