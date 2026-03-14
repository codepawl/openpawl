/**
 * Tests for src/core/canvas-telemetry.ts
 *
 * Covers: URL normalization, connect/disconnect lifecycle, reconnect-flood fix.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

/* ------------------------------------------------------------------ */
/*  Mock wsManager                                                     */
/* ------------------------------------------------------------------ */

const { mockConnect, mockClose, mockOnMessage, mockSend } = vi.hoisted(() => ({
  mockConnect: vi.fn(),
  mockClose: vi.fn(),
  mockOnMessage: vi.fn(() => vi.fn()), // returns unsubscribe fn
  mockSend: vi.fn(),
}));

vi.mock("../src/core/ws-manager.js", () => ({
  wsManager: {
    connect: mockConnect,
    close: mockClose,
    onMessage: mockOnMessage,
    send: mockSend,
  },
}));

/* ------------------------------------------------------------------ */
/*  Mock CONFIG                                                        */
/* ------------------------------------------------------------------ */

const mockConfig = vi.hoisted(() => ({
  openclawWorkerUrl: "http://localhost:18789",
  openclawToken: "",
}));

vi.mock("../src/core/config.js", () => ({
  CONFIG: mockConfig,
}));

// Suppress logger output
vi.mock("../src/core/logger.js", () => ({
  logger: { warn: vi.fn(), info: vi.fn(), agent: vi.fn(), debug: vi.fn() },
  isDebugMode: () => false,
}));

/* ------------------------------------------------------------------ */
/*  Helper: create a fresh CanvasTelemetry with given config           */
/* ------------------------------------------------------------------ */

async function createTelemetry(url: string, token = "") {
  mockConfig.openclawWorkerUrl = url;
  mockConfig.openclawToken = token;

  // Re-import to get a fresh class that reads the current mockConfig
  const mod = await import("../src/core/canvas-telemetry.js");
  return new mod.CanvasTelemetry();
}

/* ------------------------------------------------------------------ */
/*  Tests                                                              */
/* ------------------------------------------------------------------ */

describe("CanvasTelemetry", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
  });

  /* ------ URL normalization ------ */

  describe("URL normalization", () => {
    it("converts http:// to ws://", async () => {
      mockConnect.mockResolvedValue(true);
      const t = await createTelemetry("http://example.com:8080");
      await t.connect();
      expect(mockConnect).toHaveBeenCalledWith(
        expect.stringMatching(/^ws:\/\/example\.com:8080/),
      );
    });

    it("converts https:// to wss://", async () => {
      mockConnect.mockResolvedValue(true);
      const t = await createTelemetry("https://example.com");
      await t.connect();
      expect(mockConnect).toHaveBeenCalledWith(
        expect.stringMatching(/^wss:\/\/example\.com/),
      );
    });

    it("keeps ws:// as-is", async () => {
      mockConnect.mockResolvedValue(true);
      const t = await createTelemetry("ws://example.com:9000");
      await t.connect();
      expect(mockConnect).toHaveBeenCalledWith(
        expect.stringMatching(/^ws:\/\/example\.com:9000/),
      );
    });

    it("keeps wss:// as-is", async () => {
      mockConnect.mockResolvedValue(true);
      const t = await createTelemetry("wss://secure.example.com");
      await t.connect();
      expect(mockConnect).toHaveBeenCalledWith(
        expect.stringMatching(/^wss:\/\/secure\.example\.com/),
      );
    });

    it("adds ws:// to bare hostname (no scheme)", async () => {
      mockConnect.mockResolvedValue(true);
      const t = await createTelemetry("localhost:18789");
      await t.connect();
      expect(mockConnect).toHaveBeenCalledWith(
        expect.stringMatching(/^ws:\/\/localhost:18789/),
      );
    });

    it("does NOT double-prefix (regression: http → ws://ws://)", async () => {
      mockConnect.mockResolvedValue(true);
      const t = await createTelemetry("http://example.com");
      await t.connect();
      const url = mockConnect.mock.calls[0][0] as string;
      expect(url).not.toMatch(/ws:\/\/ws:\/\//);
      expect(url).toMatch(/^ws:\/\/example\.com/);
    });

    it("appends token as query param when set", async () => {
      mockConnect.mockResolvedValue(true);
      const t = await createTelemetry("http://example.com", "my-secret-token");
      await t.connect();
      const url = mockConnect.mock.calls[0][0] as string;
      expect(url).toContain("token=my-secret-token");
    });
  });

  /* ------ connect ------ */

  describe("connect", () => {
    it("calls wsManager.connect with normalized URL", async () => {
      mockConnect.mockResolvedValue(true);
      const t = await createTelemetry("http://localhost:18789");
      await t.connect();
      expect(mockConnect).toHaveBeenCalledTimes(1);
      expect(mockConnect).toHaveBeenCalledWith(
        expect.stringMatching(/^ws:\/\/localhost:18789/),
      );
    });

    it("returns true on success", async () => {
      mockConnect.mockResolvedValue(true);
      const t = await createTelemetry("http://localhost:18789");
      expect(await t.connect()).toBe(true);
    });

    it("calls wsManager.close() when connect fails (regression: reconnect flood)", async () => {
      mockConnect.mockResolvedValue(false);
      const t = await createTelemetry("http://localhost:18789");
      await t.connect();
      expect(mockClose).toHaveBeenCalledTimes(1);
    });

    it("does not call wsManager.close() on success", async () => {
      mockConnect.mockResolvedValue(true);
      const t = await createTelemetry("http://localhost:18789");
      await t.connect();
      expect(mockClose).not.toHaveBeenCalled();
    });
  });

  /* ------ disconnect ------ */

  describe("disconnect", () => {
    it("calls wsManager.close()", async () => {
      mockConnect.mockResolvedValue(true);
      const t = await createTelemetry("http://localhost:18789");
      await t.connect();
      mockClose.mockClear();

      t.disconnect();
      expect(mockClose).toHaveBeenCalledTimes(1);
    });

    it("unsubscribes message handler", async () => {
      const mockUnsub = vi.fn();
      mockOnMessage.mockReturnValue(mockUnsub);
      mockConnect.mockResolvedValue(true);

      const t = await createTelemetry("http://localhost:18789");
      await t.connect();

      t.disconnect();
      expect(mockUnsub).toHaveBeenCalledTimes(1);
    });
  });
});
