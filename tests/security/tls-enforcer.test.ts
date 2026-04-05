import { describe, it, expect } from "vitest";
import { TlsEnforcer } from "../../src/security/tls-enforcer.js";

describe("TlsEnforcer", () => {
  const enforcer = new TlsEnforcer();

  it("accepts HTTPS URLs", () => {
    expect(enforcer.validateUrl("https://api.anthropic.com").isOk()).toBe(true);
  });

  it("rejects HTTP URLs (except localhost)", () => {
    expect(enforcer.validateUrl("http://api.anthropic.com").isErr()).toBe(true);
  });

  it("allows HTTP for localhost", () => {
    expect(enforcer.validateUrl("http://localhost:11434").isOk()).toBe(true);
    expect(enforcer.validateUrl("http://127.0.0.1:1234").isOk()).toBe(true);
  });
});
