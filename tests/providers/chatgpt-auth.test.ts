import { describe, it, expect, vi, beforeEach } from "vitest";

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

vi.mock("open", () => ({ default: vi.fn().mockResolvedValue(undefined) }));
vi.mock("../../src/providers/oauth-helpers.js", () => ({
  startOAuthCallbackServer: vi.fn(),
}));

import {
  generatePKCE,
  exchangeChatGPTToken,
  refreshChatGPTToken,
} from "../../src/providers/chatgpt-auth.js";

describe("generatePKCE", () => {
  it("produces valid base64url verifier and challenge", () => {
    const { verifier, challenge } = generatePKCE();

    // base64url chars only (no +, /, =)
    expect(verifier).toMatch(/^[A-Za-z0-9\-_]+$/);
    expect(challenge).toMatch(/^[A-Za-z0-9\-_]+$/);

    // verifier: 32 bytes → ceil(32 * 4/3) = 43 base64url chars (no padding)
    expect(verifier.length).toBe(43);

    // challenge: SHA256 = 32 bytes → 43 base64url chars
    expect(challenge.length).toBe(43);

    // verifier and challenge are different
    expect(verifier).not.toBe(challenge);
  });

  it("produces unique values on each call", () => {
    const a = generatePKCE();
    const b = generatePKCE();
    expect(a.verifier).not.toBe(b.verifier);
    expect(a.challenge).not.toBe(b.challenge);
  });
});

describe("exchangeChatGPTToken", () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it("returns ok with tokens on success", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        access_token: "at_abc123",
        refresh_token: "rt_xyz789",
        expires_in: 3600,
      }),
    });

    const result = await exchangeChatGPTToken("auth-code", "verifier-value");

    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value.accessToken).toBe("at_abc123");
      expect(result.value.refreshToken).toBe("rt_xyz789");
      expect(result.value.expiresIn).toBe(3600);
    }

    expect(mockFetch).toHaveBeenCalledWith(
      "https://auth.openai.com/oauth/token",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          "Content-Type": "application/x-www-form-urlencoded",
        }),
      }),
    );
  });

  it("returns err on 400 response", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 400,
      json: async () => ({ error: "invalid_grant" }),
    });

    const result = await exchangeChatGPTToken("bad-code", "verifier");

    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error.message).toContain("400");
      expect(result.error.code).toBe("invalid_grant");
    }
  });

  it("returns err on 401 response", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 401,
      json: async () => ({ error: "unauthorized_client" }),
    });

    const result = await exchangeChatGPTToken("code", "verifier");

    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error.message).toContain("401");
    }
  });

  it("returns err on network error", async () => {
    mockFetch.mockRejectedValueOnce(new Error("ECONNREFUSED"));

    const result = await exchangeChatGPTToken("code", "verifier");

    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error.message).toContain("Network error");
    }
  });
});

describe("refreshChatGPTToken", () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it("returns ok with refreshed tokens", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        access_token: "at_new_abc",
        refresh_token: "rt_new_xyz",
        expires_in: 7200,
      }),
    });

    const result = await refreshChatGPTToken("old-refresh-token");

    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value.accessToken).toBe("at_new_abc");
      expect(result.value.refreshToken).toBe("rt_new_xyz");
      expect(result.value.expiresIn).toBe(7200);
    }

    expect(mockFetch).toHaveBeenCalledWith(
      "https://auth.openai.com/oauth/token",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          "Content-Type": "application/x-www-form-urlencoded",
        }),
      }),
    );
  });

  it("returns err on 400 response", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 400,
      json: async () => ({ error: "invalid_token" }),
    });

    const result = await refreshChatGPTToken("expired-refresh-token");

    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error.message).toContain("400");
      expect(result.error.code).toBe("invalid_token");
    }
  });
});
