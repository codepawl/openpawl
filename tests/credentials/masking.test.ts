import { describe, it, expect } from "bun:test";
import { maskCredential, looksLikeCredential, redactCredentials } from "../../src/credentials/masking.js";

describe("maskCredential", () => {
  it('masks "sk-ant-api03-abcdefghijk..." correctly', () => {
    const masked = maskCredential("sk-ant-api03-abcdefghijk1234567890xyz");
    expect(masked.startsWith("sk-ant")).toBe(true);
    expect(masked.endsWith("0xyz")).toBe(true);
    expect(masked).toContain("...");
    expect(masked.length).toBeLessThan("sk-ant-api03-abcdefghijk1234567890xyz".length);
  });

  it("masks short values entirely", () => {
    expect(maskCredential("short")).toBe("•••••");
  });

  it("masks medium values with partial reveal", () => {
    const masked = maskCredential("sk-ant-12345");
    expect(masked).toContain("...");
  });
});

describe("looksLikeCredential", () => {
  it("detects sk-ant- pattern", () => {
    expect(looksLikeCredential("sk-ant-api03-abcdefghijk")).toBe(true);
  });

  it("detects gsk_ pattern", () => {
    expect(looksLikeCredential("gsk_abcdefghij1234567890")).toBe(true);
  });

  it("returns false for normal text", () => {
    expect(looksLikeCredential("hello world")).toBe(false);
    expect(looksLikeCredential("just a normal string")).toBe(false);
  });

  it("detects xai- pattern", () => {
    expect(looksLikeCredential("xai-abcdefghij1234567890")).toBe(true);
  });
});

describe("redactCredentials", () => {
  it("replaces keys in larger text", () => {
    const text = "Using key sk-ant-api03-abcdefghijklmnopq for requests";
    const redacted = redactCredentials(text);
    expect(redacted).not.toContain("abcdefghijklmnopq");
    expect(redacted).toContain("sk-ant");
    expect(redacted).toContain("...");
  });

  it("handles multiple keys in one string", () => {
    const text = "Keys: sk-ant-api03-aaaa1234567890bbb and gsk_cccc1234567890ddd";
    const redacted = redactCredentials(text);
    expect(redacted).not.toContain("aaaa1234567890bbb");
    expect(redacted).not.toContain("cccc1234567890ddd");
  });
});
