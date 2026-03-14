/**
 * Tests for src/core/ws-manager.ts
 *
 * Covers: connect lifecycle, reconnect limit, close, send/queue, message dispatch.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/* ------------------------------------------------------------------ */
/*  Mock ws module                                                     */
/* ------------------------------------------------------------------ */

const { MockWebSocket } = vi.hoisted(() => {
  class MockWebSocket {
    static OPEN = 1;
    static CONNECTING = 0;
    static CLOSING = 2;
    static CLOSED = 3;

    readyState = 0; // CONNECTING
    private listeners = new Map<string, Function[]>();
    send = vi.fn();
    close = vi.fn();
    terminate = vi.fn();
    ping = vi.fn();

    on(event: string, cb: Function) {
      if (!this.listeners.has(event)) this.listeners.set(event, []);
      this.listeners.get(event)!.push(cb);
      return this;
    }

    /** Fire an event on this mock socket */
    __emit(event: string, ...args: unknown[]) {
      for (const cb of this.listeners.get(event) ?? []) cb(...args);
    }
  }
  return { MockWebSocket };
});

type MockWS = InstanceType<typeof MockWebSocket>;

// Track every constructed instance so tests can grab the latest one
let wsInstances: MockWS[] = [];
const MockWebSocketConstructor = vi.fn((..._args: unknown[]) => {
  const instance = new MockWebSocket();
  wsInstances.push(instance);
  return instance;
}) as unknown as typeof MockWebSocket;

// Copy statics
Object.assign(MockWebSocketConstructor, {
  OPEN: MockWebSocket.OPEN,
  CONNECTING: MockWebSocket.CONNECTING,
  CLOSING: MockWebSocket.CLOSING,
  CLOSED: MockWebSocket.CLOSED,
});

vi.mock("ws", () => ({
  default: MockWebSocketConstructor,
  WebSocket: MockWebSocketConstructor,
}));

// Suppress logger output
vi.mock("../src/core/logger.js", () => ({
  logger: { warn: vi.fn(), info: vi.fn(), agent: vi.fn(), debug: vi.fn() },
  isDebugMode: () => false,
}));

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

function latestWs(): MockWS {
  return wsInstances[wsInstances.length - 1];
}

/** Simulate a successful open on the latest mock socket */
function openLatest() {
  const ws = latestWs();
  ws.readyState = MockWebSocket.OPEN;
  ws.__emit("open");
}

/** Simulate connection failure (close without open) on the latest mock socket */
function failLatest() {
  const ws = latestWs();
  ws.__emit("error", new Error("connect ECONNREFUSED"));
  ws.__emit("close");
}

/* ------------------------------------------------------------------ */
/*  Tests                                                              */
/* ------------------------------------------------------------------ */

describe("WebSocketManager", () => {
  let manager: import("../src/core/ws-manager.js").WebSocketManager;

  beforeEach(async () => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    wsInstances = [];
    MockWebSocketConstructor.mockClear();

    // Reset the singleton so each test gets a fresh instance
    const mod = await import("../src/core/ws-manager.js");
    // Access private static to reset
    (mod.WebSocketManager as any).instance = null;
    manager = mod.WebSocketManager.getInstance();
  });

  afterEach(() => {
    manager.close();
    vi.useRealTimers();
  });

  /* ------ connect ------ */

  describe("connect", () => {
    it("returns false for empty URL", async () => {
      expect(await manager.connect("")).toBe(false);
      expect(await manager.connect("   ")).toBe(false);
      expect(MockWebSocketConstructor).not.toHaveBeenCalled();
    });

    it("returns true when connection succeeds", async () => {
      const promise = manager.connect("ws://localhost:1234");
      openLatest();
      expect(await promise).toBe(true);
    });

    it("returns false when connection times out", async () => {
      const promise = manager.connect("ws://localhost:1234");
      // Advance past the 5s connect timeout
      vi.advanceTimersByTime(6000);
      expect(await promise).toBe(false);
    });

    it("reuses existing connection for same URL when already open", async () => {
      const p1 = manager.connect("ws://localhost:1234");
      openLatest();
      await p1;

      const result = await manager.connect("ws://localhost:1234");
      expect(result).toBe(true);
      // Should not create a second WebSocket
      expect(wsInstances.length).toBe(1);
    });
  });

  /* ------ scheduleReconnect — max attempts ------ */

  describe("scheduleReconnect — max attempts", () => {
    it("stops reconnecting after maxReconnectAttempts (5) failures", async () => {
      // Initial connect creates WS #1 and fails → scheduleReconnect sets attempts=1
      const p = manager.connect("ws://localhost:1234");
      failLatest();
      await p;

      // Reconnect attempts: each scheduleReconnect increments counter then schedules.
      // attempts goes 0→1→2→3→4→5. At attempts=5, scheduleReconnect gives up.
      // So we need 5 reconnect cycles (WS #2 through #6) to exhaust the limit.
      for (let attempt = 0; attempt < 5; attempt++) {
        const delay = 1000 * 2 ** attempt;
        await vi.advanceTimersByTimeAsync(delay + 100);
        failLatest();
      }

      // After exhausting all 5 reconnect attempts, no more should be scheduled
      const countBefore = wsInstances.length;
      await vi.advanceTimersByTimeAsync(60_000);
      expect(wsInstances.length).toBe(countBefore);
    });

    it("logs warning when giving up", async () => {
      const { logger } = await import("../src/core/logger.js");

      const p = manager.connect("ws://localhost:1234");
      failLatest();
      await p;

      for (let attempt = 0; attempt < 5; attempt++) {
        const delay = 1000 * 2 ** attempt;
        await vi.advanceTimersByTimeAsync(delay + 100);
        failLatest();
      }

      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringContaining("max reconnect"),
      );
    });

    it("resets attempt counter on successful reconnect", async () => {
      const p = manager.connect("ws://localhost:1234");
      failLatest();
      await p;

      // First reconnect attempt succeeds
      await vi.advanceTimersByTimeAsync(1100);
      openLatest();

      // Close the connection to trigger reconnect again
      latestWs().__emit("close");

      // Should be able to reconnect (counter was reset)
      await vi.advanceTimersByTimeAsync(1100);
      // A new instance should have been created
      expect(wsInstances.length).toBeGreaterThanOrEqual(3);
    });
  });

  /* ------ close ------ */

  describe("close", () => {
    it("stops reconnect loop (shouldReconnect = false)", async () => {
      const p = manager.connect("ws://localhost:1234");
      failLatest();
      await p;

      manager.close();

      // Advancing timers should not trigger any reconnect
      const countBefore = wsInstances.length;
      await vi.advanceTimersByTimeAsync(60_000);
      expect(wsInstances.length).toBe(countBefore);
    });

    it("clears pending reconnect timer", async () => {
      const p = manager.connect("ws://localhost:1234");
      failLatest();
      await p;

      // A reconnect timer is now scheduled
      manager.close();

      // Should not reconnect
      const countBefore = wsInstances.length;
      await vi.advanceTimersByTimeAsync(60_000);
      expect(wsInstances.length).toBe(countBefore);
    });
  });

  /* ------ send ------ */

  describe("send", () => {
    it("queues messages when not connected", async () => {
      manager.send({ type: "hello" });
      // No ws instance yet, so no send call
      expect(wsInstances.length).toBe(0);

      // Now connect — queued messages should flush
      const p = manager.connect("ws://localhost:1234");
      openLatest();
      await p;

      expect(latestWs().send).toHaveBeenCalledWith(
        JSON.stringify({ type: "hello" }),
      );
    });

    it("sends directly when connected", async () => {
      const p = manager.connect("ws://localhost:1234");
      openLatest();
      await p;

      manager.send({ foo: "bar" });
      expect(latestWs().send).toHaveBeenCalledWith(
        JSON.stringify({ foo: "bar" }),
      );
    });
  });

  /* ------ onMessage ------ */

  describe("onMessage", () => {
    it("dispatches parsed JSON to registered handlers", async () => {
      const handler = vi.fn();
      manager.onMessage(handler);

      const p = manager.connect("ws://localhost:1234");
      openLatest();
      await p;

      const data = JSON.stringify({ type: "test", value: 42 });
      latestWs().__emit("message", Buffer.from(data));

      expect(handler).toHaveBeenCalledWith({ type: "test", value: 42 });
    });

    it("unsubscribe function removes handler", async () => {
      const handler = vi.fn();
      const unsub = manager.onMessage(handler);

      const p = manager.connect("ws://localhost:1234");
      openLatest();
      await p;

      unsub();

      latestWs().__emit("message", Buffer.from('{"x":1}'));
      expect(handler).not.toHaveBeenCalled();
    });
  });
});
