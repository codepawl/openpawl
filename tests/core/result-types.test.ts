import { describe, it, expect } from "bun:test";
import { classifyProviderError, safeAsync, ok, err } from "../../src/core/result-types.js";
import { formatProviderErrorType } from "../../src/core/errors.js";

describe("classifyProviderError", () => {
  it("classifies rate limit errors", () => {
    const e = new Error("Rate limit exceeded (429)");
    const result = classifyProviderError("anthropic", e);
    expect(result.type).toBe("rate_limit");
    expect(result.provider).toBe("anthropic");
  });

  it("classifies timeout errors", () => {
    const e = new Error("Request timed out");
    const result = classifyProviderError("openai", e);
    expect(result.type).toBe("timeout");
  });

  it("classifies auth errors", () => {
    const e = new Error("401 Unauthorized");
    const result = classifyProviderError("anthropic", e);
    expect(result.type).toBe("auth_failed");
  });

  it("classifies context length errors", () => {
    const e = new Error("Context too long for model");
    const result = classifyProviderError("openai", e);
    expect(result.type).toBe("context_too_long");
  });

  it("classifies model not found errors", () => {
    const e = new Error("Model gpt-5 not found");
    const result = classifyProviderError("openai", e);
    expect(result.type).toBe("model_not_found");
  });

  it("classifies unknown non-Error values", () => {
    const result = classifyProviderError("openai", "string error");
    expect(result.type).toBe("unknown");
  });

  it("classifies generic Error as network", () => {
    const e = new Error("Connection refused");
    const result = classifyProviderError("anthropic", e);
    expect(result.type).toBe("network");
  });
});

describe("safeAsync", () => {
  it("returns ok() on success", async () => {
    const result = await safeAsync("test", async () => "hello");
    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap()).toBe("hello");
  });

  it("returns err() on failure", async () => {
    const result = await safeAsync("test", async () => { throw new Error("Rate limit 429"); });
    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr().type).toBe("rate_limit");
  });
});

describe("formatProviderErrorType", () => {
  it("formats rate_limit with retryAfterMs", () => {
    const msg = formatProviderErrorType({ type: "rate_limit", provider: "anthropic", retryAfterMs: 5000 });
    expect(msg).toContain("Rate limit");
    expect(msg).toContain("5s");
  });

  it("formats rate_limit without retryAfterMs", () => {
    const msg = formatProviderErrorType({ type: "rate_limit", provider: "anthropic" });
    expect(msg).toContain("next provider");
  });

  it("formats timeout", () => {
    const msg = formatProviderErrorType({ type: "timeout", provider: "openai", timeoutMs: 15000 });
    expect(msg).toContain("15000ms");
  });

  it("formats auth_failed", () => {
    const msg = formatProviderErrorType({ type: "auth_failed", provider: "anthropic", message: "bad key" });
    expect(msg).toContain("Authentication failed");
    expect(msg).toContain("openpawl providers add");
  });

  it("formats model_not_found", () => {
    const msg = formatProviderErrorType({ type: "model_not_found", provider: "openai", model: "gpt-5" });
    expect(msg).toContain("gpt-5");
  });

  it("formats context_too_long", () => {
    const msg = formatProviderErrorType({ type: "context_too_long", provider: "openai", maxTokens: 8000 });
    expect(msg).toContain("Context too long");
  });

  it("formats unknown", () => {
    const msg = formatProviderErrorType({ type: "unknown", provider: "test", cause: "boom" });
    expect(msg).toContain("Unexpected error");
    expect(msg).toContain("boom");
  });
});
