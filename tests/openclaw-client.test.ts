import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "node:events";

// ---------------------------------------------------------------------------
// Mock ws and device-identity before any imports
// ---------------------------------------------------------------------------

class MockWebSocket extends EventEmitter {
  static OPEN = 1;
  static CONNECTING = 0;
  static CLOSING = 2;
  static CLOSED = 3;
  readyState = MockWebSocket.OPEN;
  send = vi.fn();
  close = vi.fn();
  terminate = vi.fn();
  ping = vi.fn();
}

let lastMockWs: MockWebSocket | null = null;

vi.mock("ws", () => {
  return {
    default: class extends MockWebSocket {
      constructor(_url: string) {
        super();
        lastMockWs = this;
        // Simulate async open
        setTimeout(() => this.emit("open"), 5);
      }
    },
    __esModule: true,
  };
});

vi.mock("../src/core/device-identity.js", () => ({
  loadOrCreateDeviceIdentity: () => ({
    deviceId: "test-device-id",
    publicKeyPem: "-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEAtest\n-----END PUBLIC KEY-----",
    privateKeyPem: "-----BEGIN PRIVATE KEY-----\nMC4CAQAwBQYDK2VwBCIEIAtest\n-----END PRIVATE KEY-----",
  }),
  signDevicePayload: () => "mock-signature",
  publicKeyRawBase64Url: () => "mock-public-key",
  buildDeviceAuthPayloadV3: () => "v3|test-payload",
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function simulateHandshake(ws: MockWebSocket): void {
  // Server sends challenge
  const challenge = JSON.stringify({
    type: "event",
    event: "connect.challenge",
    payload: { nonce: "test-nonce-123" },
  });
  ws.emit("message", Buffer.from(challenge));

  // After client sends response, server acks
  setTimeout(() => {
    const ack = JSON.stringify({ type: "res", ok: true });
    ws.emit("message", Buffer.from(ack));
  }, 5);
}

function simulateHandshakeReject(ws: MockWebSocket): void {
  const challenge = JSON.stringify({
    type: "event",
    event: "connect.challenge",
    payload: { nonce: "test-nonce" },
  });
  ws.emit("message", Buffer.from(challenge));

  setTimeout(() => {
    const ack = JSON.stringify({ type: "res", ok: false, error: "bad token" });
    ws.emit("message", Buffer.from(ack));
  }, 5);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("OpenClawClient", () => {
  let OpenClawClient: typeof import("../src/client/OpenClawClient.js").OpenClawClient;
  let OpenClawError: typeof import("../src/client/types.js").OpenClawError;

  beforeEach(async () => {
    lastMockWs = null;
    const mod = await import("../src/client/OpenClawClient.js");
    OpenClawClient = mod.OpenClawClient;
    const types = await import("../src/client/types.js");
    OpenClawError = types.OpenClawError;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    lastMockWs = null;
  });

  // -- Config validation ---------------------------------------------------

  describe("config validation", () => {
    it("throws OpenClawError for invalid config", () => {
      expect(() => new OpenClawClient({ gatewayUrl: "" } as never)).toThrow("Invalid config");
    });

    it("accepts valid config with defaults", () => {
      const client = new OpenClawClient({ gatewayUrl: "ws://localhost:18789" });
      expect(client).toBeDefined();
    });
  });

  // -- Connect / Disconnect ------------------------------------------------

  describe("connect", () => {
    it("connects and completes handshake", async () => {
      const client = new OpenClawClient({
        gatewayUrl: "ws://localhost:18789",
        apiKey: "test-token",
      });

      const connectedSpy = vi.fn();
      client.on("connected", connectedSpy);

      const connectPromise = client.connect();
      // Wait for MockWebSocket to be created
      await new Promise((r) => setTimeout(r, 10));
      expect(lastMockWs).not.toBeNull();
      simulateHandshake(lastMockWs!);

      await connectPromise;
      expect(client.isConnected()).toBe(true);
      expect(connectedSpy).toHaveBeenCalledOnce();
    });

    it("rejects on handshake failure", async () => {
      const client = new OpenClawClient({
        gatewayUrl: "ws://localhost:18789",
        apiKey: "bad-token",
      });

      const connectPromise = client.connect();
      await new Promise((r) => setTimeout(r, 10));
      simulateHandshakeReject(lastMockWs!);

      await expect(connectPromise).rejects.toThrow("Handshake rejected");
      expect(client.isConnected()).toBe(false);
    });

    it("resolves immediately if already connected", async () => {
      const client = new OpenClawClient({ gatewayUrl: "ws://localhost:18789" });

      const p = client.connect();
      await new Promise((r) => setTimeout(r, 10));
      simulateHandshake(lastMockWs!);
      await p;

      // Second call should resolve immediately
      await client.connect();
      expect(client.isConnected()).toBe(true);
    });

    it("sends the handshake request with correct structure", async () => {
      const client = new OpenClawClient({
        gatewayUrl: "ws://localhost:18789",
        apiKey: "my-token",
      });

      const p = client.connect();
      await new Promise((r) => setTimeout(r, 10));
      const ws = lastMockWs!;

      // Send challenge
      ws.emit("message", Buffer.from(JSON.stringify({
        type: "event",
        event: "connect.challenge",
        payload: { nonce: "abc123" },
      })));

      // Client should have sent the connect request
      expect(ws.send).toHaveBeenCalledOnce();
      const sentRaw = ws.send.mock.calls[0][0] as string;
      const sent = JSON.parse(sentRaw) as Record<string, unknown>;
      expect(sent.type).toBe("req");
      expect(sent.method).toBe("connect");
      const params = sent.params as Record<string, unknown>;
      expect(params.minProtocol).toBe(3);
      expect(params.maxProtocol).toBe(3);
      expect((params.auth as Record<string, string>).token).toBe("my-token");
      expect((params.device as Record<string, string>).nonce).toBe("abc123");

      // Finish handshake
      ws.emit("message", Buffer.from(JSON.stringify({ type: "res", ok: true })));
      await p;
    });
  });

  describe("disconnect", () => {
    it("closes the socket and emits disconnected", async () => {
      const client = new OpenClawClient({ gatewayUrl: "ws://localhost:18789" });

      const p = client.connect();
      await new Promise((r) => setTimeout(r, 10));
      simulateHandshake(lastMockWs!);
      await p;

      const disconnectedSpy = vi.fn();
      client.on("disconnected", disconnectedSpy);

      await client.disconnect();
      expect(client.isConnected()).toBe(false);
      expect(disconnectedSpy).toHaveBeenCalledWith("client disconnect");
    });
  });

  // -- Reconnection --------------------------------------------------------

  describe("auto-reconnect", () => {
    it("emits reconnecting event on connection drop", async () => {
      const client = new OpenClawClient({
        gatewayUrl: "ws://localhost:18789",
        reconnectDelay: 50,
        maxReconnectAttempts: 3,
      });

      const p = client.connect();
      await new Promise((r) => setTimeout(r, 10));
      const ws = lastMockWs!;
      simulateHandshake(ws);
      await p;

      const reconnectSpy = vi.fn();
      client.on("reconnecting", reconnectSpy);

      // Simulate connection drop
      ws.readyState = MockWebSocket.CLOSED;
      ws.emit("close", 1006, "connection lost");

      await new Promise((r) => setTimeout(r, 20));
      expect(reconnectSpy).toHaveBeenCalledWith(1, 3);
    });

    it("does not reconnect after intentional disconnect", async () => {
      const client = new OpenClawClient({
        gatewayUrl: "ws://localhost:18789",
        reconnectDelay: 50,
      });

      const p = client.connect();
      await new Promise((r) => setTimeout(r, 10));
      simulateHandshake(lastMockWs!);
      await p;

      const reconnectSpy = vi.fn();
      client.on("reconnecting", reconnectSpy);

      await client.disconnect();
      expect(reconnectSpy).not.toHaveBeenCalled();
    });
  });

  // -- Stream (HTTP SSE) ---------------------------------------------------

  describe("stream", () => {
    it("yields chunks from SSE response", async () => {
      const sseBody = [
        'data: {"choices":[{"delta":{"content":"Hello"}}]}\n\n',
        'data: {"choices":[{"delta":{"content":" world"}}]}\n\n',
        "data: [DONE]\n\n",
      ].join("");

      const mockResponse = {
        ok: true,
        status: 200,
        body: new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(sseBody));
            controller.close();
          },
        }),
        text: () => Promise.resolve(""),
      };
      globalThis.fetch = vi.fn().mockResolvedValue(mockResponse);

      const client = new OpenClawClient({
        gatewayUrl: "ws://localhost:18789",
        apiKey: "test-token",
      });

      const chunks: string[] = [];
      for await (const chunk of client.stream("say hello")) {
        if (chunk.content) chunks.push(chunk.content);
        if (chunk.done) break;
      }

      expect(chunks).toEqual(["Hello", " world"]);

      // Verify fetch was called with correct URL (port + 2)
      const fetchCall = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(fetchCall[0]).toBe("http://localhost:18791/v1/chat/completions");
      const opts = fetchCall[1] as RequestInit;
      expect((opts.headers as Record<string, string>).Authorization).toBe("Bearer test-token");
    });

    it("includes system prompt when provided", async () => {
      const mockResponse = {
        ok: true,
        status: 200,
        body: new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode("data: [DONE]\n\n"));
            controller.close();
          },
        }),
        text: () => Promise.resolve(""),
      };
      globalThis.fetch = vi.fn().mockResolvedValue(mockResponse);

      const client = new OpenClawClient({ gatewayUrl: "ws://localhost:18789" });

      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      for await (const _ of client.stream("test", { systemPrompt: "You are helpful" })) {
        // consume
      }

      const body = JSON.parse(
        (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0][1].body as string,
      ) as { messages: Array<{ role: string; content: string }> };
      expect(body.messages[0]).toEqual({ role: "system", content: "You are helpful" });
      expect(body.messages[1]).toEqual({ role: "user", content: "test" });
    });

    it("throws on HTTP error", async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
        body: null,
        text: () => Promise.resolve("Internal Server Error"),
      });

      const client = new OpenClawClient({ gatewayUrl: "ws://localhost:18789" });

      await expect(async () => {
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        for await (const _ of client.stream("test")) {
          // should not reach
        }
      }).rejects.toThrow("HTTP 500");
    });

    it("includes usage in final chunk when reported", async () => {
      const sseBody = [
        'data: {"choices":[{"delta":{"content":"Hi"}}]}\n',
        'data: {"choices":[],"usage":{"prompt_tokens":10,"completion_tokens":5}}\n',
        "data: [DONE]\n",
      ].join("");

      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        body: new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(sseBody));
            controller.close();
          },
        }),
        text: () => Promise.resolve(""),
      });

      const client = new OpenClawClient({ gatewayUrl: "ws://localhost:18789" });
      const allChunks: import("../src/client/types.js").StreamChunk[] = [];
      for await (const chunk of client.stream("test")) {
        allChunks.push(chunk);
      }

      const usageChunk = allChunks.find((c) => c.usage);
      expect(usageChunk?.usage).toEqual({ promptTokens: 10, completionTokens: 5 });
    });

    it("supports concurrent streams", async () => {
      let callCount = 0;
      globalThis.fetch = vi.fn().mockImplementation(() => {
        const id = ++callCount;
        const sseBody = `data: {"choices":[{"delta":{"content":"stream-${id}"}}]}\ndata: [DONE]\n`;
        return Promise.resolve({
          ok: true,
          status: 200,
          body: new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode(sseBody));
              controller.close();
            },
          }),
          text: () => Promise.resolve(""),
        });
      });

      const client = new OpenClawClient({ gatewayUrl: "ws://localhost:18789" });

      async function collectStream(prompt: string): Promise<string[]> {
        const chunks: string[] = [];
        for await (const chunk of client.stream(prompt)) {
          if (chunk.content) chunks.push(chunk.content);
        }
        return chunks;
      }

      const [r1, r2, r3] = await Promise.all([
        collectStream("prompt-1"),
        collectStream("prompt-2"),
        collectStream("prompt-3"),
      ]);

      expect(r1).toHaveLength(1);
      expect(r2).toHaveLength(1);
      expect(r3).toHaveLength(1);
      // Each stream got a unique response
      const all = [...r1, ...r2, ...r3].sort();
      expect(all).toEqual(["stream-1", "stream-2", "stream-3"]);
      expect(globalThis.fetch).toHaveBeenCalledTimes(3);
    });
  });

  // -- Error types ---------------------------------------------------------

  describe("OpenClawError", () => {
    it("has code and message", () => {
      const err = new OpenClawError("TIMEOUT", "request timed out");
      expect(err.code).toBe("TIMEOUT");
      expect(err.message).toBe("request timed out");
      expect(err.name).toBe("OpenClawError");
      expect(err).toBeInstanceOf(Error);
    });
  });
});
