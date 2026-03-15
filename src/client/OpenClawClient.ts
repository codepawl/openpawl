/**
 * OpenClawClient — high-level client that abstracts all OpenClaw WebSocket
 * connection complexity (v3 device-authenticated handshake, heartbeat,
 * reconnection) behind a clean async interface.
 *
 * Streaming uses HTTP SSE (Server-Sent Events) against the gateway's
 * OpenAI-compatible `/v1/chat/completions` endpoint, while the WebSocket
 * connection is maintained for telemetry and real-time coordination.
 */

import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import WebSocket from "ws";
import {
  OpenClawClientConfigSchema,
  OpenClawError,
  type OpenClawClientConfig,
  type OpenClawClientEvents,
  type StreamChunk,
  type StreamOptions,
} from "./types.js";
import {
  loadOrCreateDeviceIdentity,
  signDevicePayload,
  publicKeyRawBase64Url,
  buildDeviceAuthPayloadV3,
} from "../core/device-identity.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Convert a WS URL to an HTTP base URL, applying the +2 port offset. */
function wsToHttpBase(wsUrl: string): string {
  const raw = wsUrl.trim().replace(/\/$/, "");
  const asHttp = raw
    .replace(/^wss:\/\//i, "https://")
    .replace(/^ws:\/\//i, "http://");
  try {
    const u = new URL(asHttp);
    if (u.port) {
      u.port = String(Number(u.port) + 2);
    }
    return u.origin;
  } catch {
    return asHttp;
  }
}

/** Strip the ?token= param from a WS URL (avoid leaking in upgrade headers). */
function stripTokenFromUrl(url: string): { cleanUrl: string; urlToken: string } {
  const parsed = new URL(url);
  const urlToken = parsed.searchParams.get("token") ?? "";
  parsed.searchParams.delete("token");
  return { cleanUrl: parsed.href, urlToken };
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

export class OpenClawClient extends EventEmitter<OpenClawClientEvents> {
  private readonly config: OpenClawClientConfig;
  private ws: WebSocket | null = null;
  private connected = false;
  private handshakeCompleted = false;
  private reconnectAttempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private pongTimer: ReturnType<typeof setTimeout> | null = null;
  private intentionalClose = false;
  private connectPromise: Promise<void> | null = null;

  private static readonly HEARTBEAT_MS = 15_000;
  private static readonly PONG_TIMEOUT_MS = 8_000;
  private static readonly CONNECT_TIMEOUT_MS = 10_000;

  /**
   * Create a new OpenClawClient.
   * @throws {OpenClawError} if the config is invalid
   */
  constructor(config: OpenClawClientConfig) {
    super();
    const parsed = OpenClawClientConfigSchema.safeParse(config);
    if (!parsed.success) {
      throw new OpenClawError(
        "CONFIG_INVALID",
        `Invalid config: ${parsed.error.issues.map((i) => i.message).join(", ")}`,
      );
    }
    this.config = parsed.data;
  }

  // -----------------------------------------------------------------------
  // Public API
  // -----------------------------------------------------------------------

  /**
   * Open the WebSocket connection and complete the v3 handshake.
   * Resolves when the handshake succeeds; rejects on failure or timeout.
   */
  async connect(): Promise<void> {
    if (this.connected) return;
    if (this.connectPromise) return this.connectPromise;

    this.intentionalClose = false;
    this.connectPromise = this.openSocket();

    try {
      await this.connectPromise;
    } finally {
      this.connectPromise = null;
    }
  }

  /**
   * Gracefully close the connection. Disables auto-reconnect.
   */
  async disconnect(): Promise<void> {
    this.intentionalClose = true;
    this.clearTimers();
    if (this.ws) {
      const sock = this.ws;
      this.ws = null;
      this.connected = false;
      this.handshakeCompleted = false;
      try { sock.close(1000, "client disconnect"); } catch { /* no-op */ }
    }
    this.emit("disconnected", "client disconnect");
  }

  /** Whether the WebSocket is open and the handshake has completed. */
  isConnected(): boolean {
    return this.connected && this.ws?.readyState === WebSocket.OPEN;
  }

  /**
   * Stream a chat completion from the OpenClaw gateway.
   *
   * Uses HTTP SSE against the gateway's OpenAI-compatible endpoint.
   * The WebSocket connection is NOT required for streaming — this method
   * works independently via HTTP, but having WS open enables telemetry.
   *
   * @returns An async iterator yielding {@link StreamChunk} objects.
   */
  async *stream(
    prompt: string,
    options?: StreamOptions,
  ): AsyncGenerator<StreamChunk, void, undefined> {
    const httpBase = wsToHttpBase(this.config.gatewayUrl);
    const chatUrl = `${httpBase}/v1/chat/completions`;

    const messages: Array<{ role: string; content: string }> = [];
    if (options?.systemPrompt) {
      messages.push({ role: "system", content: options.systemPrompt });
    }
    messages.push({ role: "user", content: prompt });

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (this.config.apiKey) {
      headers.Authorization = `Bearer ${this.config.apiKey}`;
    }

    const body = JSON.stringify({
      model: options?.model ?? "",
      messages,
      temperature: options?.temperature ?? 0.7,
      stream: true,
    });

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.config.timeout);

    // Link external signal if provided
    if (options?.signal) {
      if (options.signal.aborted) {
        clearTimeout(timeout);
        throw new OpenClawError("STREAM_FAILED", "Aborted before request");
      }
      options.signal.addEventListener("abort", () => controller.abort(), { once: true });
    }

    let res: Response;
    try {
      res = await fetch(chatUrl, {
        method: "POST",
        headers,
        body,
        signal: controller.signal,
      });
    } catch (err) {
      clearTimeout(timeout);
      if (err instanceof DOMException && err.name === "AbortError") {
        throw new OpenClawError("TIMEOUT", `Request timed out after ${this.config.timeout}ms`);
      }
      throw new OpenClawError("STREAM_FAILED", `Fetch failed: ${String(err)}`, err);
    }

    if (!res.ok) {
      clearTimeout(timeout);
      const text = await res.text().catch(() => "");
      throw new OpenClawError(
        "STREAM_FAILED",
        `HTTP ${res.status}: ${text.slice(0, 200)}`,
      );
    }

    if (!res.body) {
      clearTimeout(timeout);
      throw new OpenClawError("STREAM_FAILED", "Response has no body");
    }

    try {
      yield* this.consumeSSE(res.body);
    } finally {
      clearTimeout(timeout);
    }
  }

  // -----------------------------------------------------------------------
  // SSE consumption
  // -----------------------------------------------------------------------

  private async *consumeSSE(
    body: ReadableStream<Uint8Array>,
  ): AsyncGenerator<StreamChunk, void, undefined> {
    const decoder = new TextDecoder();
    const reader = body.getReader();
    let buffer = "";

    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || trimmed.startsWith(":")) continue;
          if (!trimmed.startsWith("data:")) continue;
          const data = trimmed.slice(5).trim();
          if (data === "[DONE]") {
            yield { content: "", done: true };
            return;
          }

          try {
            const parsed = JSON.parse(data) as {
              choices?: Array<{ delta?: { content?: string } }>;
              usage?: { prompt_tokens?: number; completion_tokens?: number };
            };
            const content = parsed.choices?.[0]?.delta?.content ?? "";
            const usage = parsed.usage
              ? {
                  promptTokens: parsed.usage.prompt_tokens ?? 0,
                  completionTokens: parsed.usage.completion_tokens ?? 0,
                }
              : undefined;
            if (content || usage) {
              yield { content, done: false, usage };
            }
          } catch {
            // skip malformed JSON chunks
          }
        }
      }
    } finally {
      reader.releaseLock();
    }

    // Stream ended without [DONE]
    yield { content: "", done: true };
  }

  // -----------------------------------------------------------------------
  // WebSocket connection & handshake
  // -----------------------------------------------------------------------

  private openSocket(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const { cleanUrl, urlToken } = stripTokenFromUrl(this.config.gatewayUrl);
      const token = this.config.apiKey ?? urlToken;

      const ws = new WebSocket(cleanUrl);
      this.ws = ws;
      let settled = false;

      const connectTimeout = setTimeout(() => {
        finish(new OpenClawError("TIMEOUT", "WebSocket connect timed out"));
        try { ws.close(); } catch { /* no-op */ }
      }, OpenClawClient.CONNECT_TIMEOUT_MS);

      const finish = (err?: OpenClawError) => {
        if (settled) return;
        settled = true;
        clearTimeout(connectTimeout);
        if (err) {
          reject(err);
        } else {
          resolve();
        }
      };

      ws.on("open", () => {
        // Wait for the challenge event from the gateway
      });

      ws.on("message", (raw) => {
        const text = Buffer.isBuffer(raw) ? raw.toString() : String(raw);
        let msg: Record<string, unknown>;
        try {
          msg = JSON.parse(text) as Record<string, unknown>;
        } catch {
          return;
        }

        // Handshake step 1: receive challenge
        if (!settled && msg.type === "event" && msg.event === "connect.challenge") {
          const payload = msg.payload as Record<string, unknown> | undefined;
          const nonce = String(payload?.nonce ?? "");
          this.sendHandshakeResponse(ws, token, nonce);
          return;
        }

        // Handshake step 3: receive connect response
        if (!settled && msg.type === "res") {
          if (msg.ok === true) {
            this.connected = true;
            this.handshakeCompleted = true;
            this.reconnectAttempts = 0;
            this.startHeartbeat();
            this.emit("connected");
            finish();
          } else {
            const detail = JSON.stringify(msg.error ?? msg.payload ?? "unknown");
            finish(new OpenClawError("HANDSHAKE_REJECTED", `Handshake rejected: ${detail}`));
          }
          return;
        }
      });

      ws.on("pong", () => {
        if (this.pongTimer) {
          clearTimeout(this.pongTimer);
          this.pongTimer = null;
        }
      });

      ws.on("error", (err) => {
        const wrapped = new OpenClawError("CONNECTION_FAILED", String(err), err);
        this.emit("error", wrapped);
        finish(wrapped);
      });

      ws.on("close", (_code, reason) => {
        const wasConnected = this.connected;
        this.connected = false;
        this.clearHeartbeatTimers();
        if (this.ws === ws) this.ws = null;
        if (!settled) {
          finish(new OpenClawError("CONNECTION_FAILED", "WebSocket closed during handshake"));
        }
        if (wasConnected) {
          this.emit("disconnected", reason?.toString() ?? "connection lost");
        }
        if (!this.intentionalClose && this.handshakeCompleted) {
          this.scheduleReconnect();
        }
      });
    });
  }

  /** Build and send the v3 device-authenticated connect request. */
  private sendHandshakeResponse(ws: WebSocket, token: string, nonce: string): void {
    try {
      const identity = loadOrCreateDeviceIdentity();
      const clientId = "teamclaw-client";
      const clientMode = "backend";
      const role = "operator";
      const scopes = ["telemetry", "chat"];
      const signedAt = Date.now();
      const platform = process.platform;
      const deviceFamily = platform;

      const sigPayload = buildDeviceAuthPayloadV3({
        deviceId: identity.deviceId,
        clientId,
        clientMode,
        role,
        scopes,
        signedAt,
        token,
        nonce,
        platform,
        deviceFamily,
      });

      const signature = signDevicePayload(identity.privateKeyPem, sigPayload);
      const publicKey = publicKeyRawBase64Url(identity.publicKeyPem);

      ws.send(JSON.stringify({
        type: "req",
        id: randomUUID(),
        method: "connect",
        params: {
          minProtocol: 3,
          maxProtocol: 3,
          client: {
            id: clientId,
            version: "0.1.0",
            platform,
            deviceFamily,
            mode: clientMode,
          },
          role,
          scopes,
          auth: { token },
          device: {
            id: identity.deviceId,
            publicKey,
            signature,
            signedAt,
            nonce,
          },
        },
      }));
    } catch (err) {
      this.emit("error", new OpenClawError("CONNECTION_FAILED", `Handshake request failed: ${String(err)}`, err));
    }
  }

  // -----------------------------------------------------------------------
  // Heartbeat
  // -----------------------------------------------------------------------

  private startHeartbeat(): void {
    this.clearHeartbeatTimers();
    this.heartbeatTimer = setInterval(() => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
      try { this.ws.ping(); } catch { return; }

      if (this.pongTimer) clearTimeout(this.pongTimer);
      this.pongTimer = setTimeout(() => {
        if (this.ws) {
          try { this.ws.terminate(); } catch { /* no-op */ }
        }
      }, OpenClawClient.PONG_TIMEOUT_MS);
      this.pongTimer.unref();
    }, OpenClawClient.HEARTBEAT_MS);
    this.heartbeatTimer.unref();
  }

  // -----------------------------------------------------------------------
  // Reconnection
  // -----------------------------------------------------------------------

  private scheduleReconnect(): void {
    if (this.intentionalClose) return;
    if (this.reconnectAttempts >= this.config.maxReconnectAttempts) {
      this.emit("error", new OpenClawError(
        "CONNECTION_FAILED",
        `Max reconnect attempts (${this.config.maxReconnectAttempts}) reached`,
      ));
      return;
    }

    this.clearReconnectTimer();
    this.reconnectAttempts++;
    this.emit("reconnecting", this.reconnectAttempts, this.config.maxReconnectAttempts);

    const delay = Math.min(
      30_000,
      this.config.reconnectDelay * 2 ** (this.reconnectAttempts - 1),
    );

    this.reconnectTimer = setTimeout(async () => {
      try {
        await this.openSocket();
      } catch {
        this.scheduleReconnect();
      }
    }, delay);
    this.reconnectTimer.unref();
  }

  // -----------------------------------------------------------------------
  // Timer cleanup
  // -----------------------------------------------------------------------

  private clearHeartbeatTimers(): void {
    if (this.heartbeatTimer) { clearInterval(this.heartbeatTimer); this.heartbeatTimer = null; }
    if (this.pongTimer) { clearTimeout(this.pongTimer); this.pongTimer = null; }
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
  }

  private clearTimers(): void {
    this.clearHeartbeatTimers();
    this.clearReconnectTimer();
  }
}
