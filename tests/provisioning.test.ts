import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock CONFIG before importing provisioning
vi.mock("../src/core/config.js", () => ({
  CONFIG: {
    openclawHttpUrl: "",
    openclawToken: "",
    openclawModel: "",
    openclawProvisionTimeout: 5000,
  },
}));

vi.mock("../src/core/openclaw-events.js", () => ({
  openclawEvents: { emit: vi.fn() },
}));

describe("provisionOpenClaw", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  async function importProvision() {
    const mod = await import("../src/core/provisioning.js");
    return mod.provisionOpenClaw;
  }

  it("returns ok when API responds 200 with JSON", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers({ "content-type": "application/json" }),
      text: () => Promise.resolve("{}"),
    });
    const provisionOpenClaw = await importProvision();
    const result = await provisionOpenClaw({ workerUrl: "ws://localhost:8001" });
    expect(result.ok).toBe(true);
  });

  it("returns ok when API responds 401 (auth rejection = reachable)", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      headers: new Headers({ "content-type": "application/json" }),
      text: () => Promise.resolve("Unauthorized"),
    });
    const provisionOpenClaw = await importProvision();
    const result = await provisionOpenClaw({ workerUrl: "ws://localhost:8001" });
    expect(result.ok).toBe(true);
  });

  it("returns ok when response is HTML (SPA gateway — still proves process is alive)", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 404,
      headers: new Headers({ "content-type": "text/html; charset=utf-8" }),
      text: () => Promise.resolve("<html><body>Not Found</body></html>"),
    });
    const provisionOpenClaw = await importProvision();
    const result = await provisionOpenClaw({ workerUrl: "ws://localhost:8001" });
    expect(result.ok).toBe(true);
  });

  it("returns ok when 404 with JSON (API reachable, endpoint not implemented)", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 404,
      headers: new Headers({ "content-type": "application/json" }),
      text: () => Promise.resolve('{"error": "not found"}'),
    });
    const provisionOpenClaw = await importProvision();
    const result = await provisionOpenClaw({ workerUrl: "ws://localhost:8001" });
    expect(result.ok).toBe(true);
  });

  it("returns error on network failure (ECONNREFUSED)", async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error("fetch failed (ECONNREFUSED)"));
    const provisionOpenClaw = await importProvision();
    const result = await provisionOpenClaw({ workerUrl: "ws://localhost:8001" });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("ECONNREFUSED");
  });
});
