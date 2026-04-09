import { randomUUID } from "node:crypto";
import WebSocket from "ws";
import { logger } from "./logger.js";
import { VERSION } from "../version.js";
import {
  loadOrCreateDeviceIdentity,
  signDevicePayload,
  publicKeyRawBase64Url,
  buildDeviceAuthPayloadV3,
} from "./device-identity.js";

type MessageHandler = (payload: unknown) => void;

export interface HandshakeOpts {
  token?: string;
  role?: string;
  scopes?: string[];
  clientId?: string;
  clientMode?: string;
  clientVersion?: string;
}

/**
 * Singleton WebSocket manager used as the single source of truth for outbound WS connections.
 */
export class WebSocketManager {
  private static instance: WebSocketManager | null = null;

  private ws: WebSocket | null = null;
  private currentUrl: string | null = null;
  private isConnected = false;
  private shouldReconnect = false;
  private reconnectAttempts = 0;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private connectPromise: Promise<boolean> | null = null;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private pongTimer: NodeJS.Timeout | null = null;
  private handshakeOpts: HandshakeOpts | undefined;
  private readonly messageHandlers = new Set<MessageHandler>();
  private readonly queue: string[] = [];

  private readonly connectTimeoutMs = 10_000;
  private readonly maxReconnectDelayMs = 30_000;
  private readonly maxReconnectAttempts = 5;
  private readonly heartbeatIntervalMs = 15_000;
  private readonly pongTimeoutMs = 8_000;

  private constructor() {}

  /**
   * Returns the singleton manager instance.
   */
  static getInstance(): WebSocketManager {
    if (!WebSocketManager.instance) {
      WebSocketManager.instance = new WebSocketManager();
    }
    return WebSocketManager.instance;
  }

  /**
   * Connects to a WebSocket endpoint and enables auto-reconnect.
   * When handshakeOpts is provided, performs the gateway challenge-response handshake.
   */
  async connect(
    url: string,
    handshakeOpts?: HandshakeOpts,
  ): Promise<boolean> {
    const nextUrl = url.trim();
    if (!nextUrl) return false;

    if (handshakeOpts) {
      this.handshakeOpts = handshakeOpts;
    }

    const previousUrl = this.currentUrl;
    this.shouldReconnect = true;

    if (
      this.ws &&
      this.ws.readyState === WebSocket.OPEN &&
      previousUrl === nextUrl
    ) {
      return true;
    }

    if (
      this.ws &&
      this.ws.readyState === WebSocket.CONNECTING &&
      previousUrl === nextUrl &&
      this.connectPromise
    ) {
      return this.connectPromise;
    }

    if (this.ws && previousUrl && previousUrl !== nextUrl) {
      this.disposeSocket();
    }

    this.currentUrl = nextUrl;

    this.connectPromise = this.openSocket(nextUrl);
    return this.connectPromise;
  }

  /**
   * Sends a payload through the active socket, or queues it until connected.
   */
  send(payload: unknown): void {
    const serialized = JSON.stringify(payload);
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(serialized);
      return;
    }
    this.queue.push(serialized);
  }

  /**
   * Registers a message handler for incoming WS messages.
   */
  onMessage(handler: MessageHandler): () => void {
    this.messageHandlers.add(handler);
    return () => {
      this.messageHandlers.delete(handler);
    };
  }

  /**
   * Closes the socket and disables reconnect behavior.
   */
  close(): void {
    this.shouldReconnect = false;
    this.reconnectAttempts = 0;
    this.clearReconnectTimer();
    this.clearHeartbeatTimers();

    if (this.ws) {
      const current = this.ws;
      this.ws = null;
      try {
        current.close();
      } catch {
        // no-op
      }
    }

    this.isConnected = false;
    this.connectPromise = null;
  }

  private async openSocket(url: string): Promise<boolean> {
    this.disposeSocket();

    // Extract token from URL query and strip it from the WS URL
    // to avoid sending credentials in HTTP upgrade headers
    const parsed = new URL(url);
    const urlToken = parsed.searchParams.get("token") ?? undefined;
    parsed.searchParams.delete("token");
    const cleanUrl = parsed.href;

    // Merge URL token with handshake opts
    const opts = this.handshakeOpts;
    const token = opts?.token ?? urlToken ?? "";

    return await new Promise<boolean>((resolve) => {
      const ws = new WebSocket(cleanUrl);
      this.ws = ws;

      let settled = false;
      const timeout = setTimeout(() => {
        finish(false);
        try {
          ws.close();
        } catch {
          // no-op
        }
      }, this.connectTimeoutMs);

      const finish = (ok: boolean) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        resolve(ok);
      };

      ws.on("open", () => {
        if (!opts) {
          // No handshake needed — legacy behavior
          this.isConnected = true;
          this.reconnectAttempts = 0;
          this.startHeartbeat();
          this.flushQueue();
          finish(true);
          return;
        }
        // Wait for the challenge event — handled in the message listener below
      });

      ws.on("message", (raw) => {
        const rawText = Buffer.isBuffer(raw) ? raw.toString() : String(raw);
        let parsed: unknown = rawText;
        try {
          parsed = JSON.parse(rawText);
        } catch {
          // keep raw string as payload
        }

        // Handle handshake messages before the connection is established
        if (!settled && opts && parsed && typeof parsed === "object") {
          const msg = parsed as Record<string, unknown>;

          // Step 1: receive connect.challenge
          if (
            msg["type"] === "event" &&
            msg["event"] === "connect.challenge"
          ) {
            const payload = msg["payload"] as
              | Record<string, unknown>
              | undefined;
            const nonce = String(payload?.["nonce"] ?? "");
            this.sendConnectRequest(ws, token, nonce, opts);
            return;
          }

          // Step 3: receive connect response
          if (msg["type"] === "res") {
            if (msg["ok"] === true) {
              this.isConnected = true;
              this.reconnectAttempts = 0;
              this.startHeartbeat();
              this.flushQueue();
              finish(true);
            } else {
              logger.warn(
                `WS handshake rejected: ${JSON.stringify(msg["error"] ?? msg["payload"])}`,
              );
              finish(false);
            }
            return;
          }
        }

        // Normal message dispatch
        for (const handler of this.messageHandlers) {
          try {
            handler(parsed);
          } catch (err) {
            logger.warn(`WS message handler failed: ${String(err)}`);
          }
        }
      });

      ws.on("pong", () => {
        if (this.pongTimer) {
          clearTimeout(this.pongTimer);
          this.pongTimer = null;
        }
      });

      ws.on("error", (err) => {
        logger.warn(`WS manager error: ${String(err)}`);
        finish(false);
      });

      ws.on("close", () => {
        const wasConnected = this.isConnected;
        this.isConnected = false;
        this.clearHeartbeatTimers();
        if (this.ws === ws) {
          this.ws = null;
        }
        if (wasConnected || !settled) {
          finish(false);
        }
        this.scheduleReconnect();
      });
    });
  }

  /**
   * Sends the gateway v3 connect request with device auth.
   */
  private sendConnectRequest(
    ws: WebSocket,
    token: string,
    nonce: string,
    opts: HandshakeOpts,
  ): void {
    try {
      const identity = loadOrCreateDeviceIdentity();
      const clientId = opts.clientId ?? "gateway-client";
      const clientMode = opts.clientMode ?? "backend";
      const role = opts.role ?? "operator";
      const scopes = opts.scopes ?? ["telemetry"];
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

      const frame = {
        type: "req",
        id: randomUUID(),
        method: "connect",
        params: {
          minProtocol: 3,
          maxProtocol: 3,
          client: {
            id: clientId,
            version: opts.clientVersion ?? VERSION,
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
      };

      ws.send(JSON.stringify(frame));
    } catch (err) {
      logger.warn(`WS handshake connect request failed: ${String(err)}`);
    }
  }

  private flushQueue(): void {
    while (
      this.queue.length > 0 &&
      this.ws &&
      this.ws.readyState === WebSocket.OPEN
    ) {
      const next = this.queue.shift();
      if (!next) continue;
      this.ws.send(next);
    }
  }

  private startHeartbeat(): void {
    this.clearHeartbeatTimers();
    this.heartbeatTimer = setInterval(() => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
      try {
        this.ws.ping();
      } catch {
        return;
      }

      if (this.pongTimer) clearTimeout(this.pongTimer);
      this.pongTimer = setTimeout(() => {
        if (!this.ws) return;
        try {
          this.ws.terminate();
        } catch {
          // no-op
        }
      }, this.pongTimeoutMs);
      this.pongTimer.unref();
    }, this.heartbeatIntervalMs);
    this.heartbeatTimer.unref();
  }

  private scheduleReconnect(): void {
    if (!this.shouldReconnect || !this.currentUrl) return;
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      logger.warn("WS max reconnect attempts reached, giving up");
      this.shouldReconnect = false;
      return;
    }
    this.clearReconnectTimer();
    const delay = Math.min(
      this.maxReconnectDelayMs,
      1000 * 2 ** this.reconnectAttempts,
    );
    this.reconnectAttempts += 1;
    this.reconnectTimer = setTimeout(() => {
      const url = this.currentUrl;
      if (!url) return;
      this.connect(url).catch((err) => {
        logger.warn(`WS reconnect failed: ${String(err)}`);
      });
    }, delay);
    this.reconnectTimer.unref();
  }

  private clearReconnectTimer(): void {
    if (!this.reconnectTimer) return;
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
  }

  private clearHeartbeatTimers(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    if (this.pongTimer) {
      clearTimeout(this.pongTimer);
      this.pongTimer = null;
    }
  }

  private disposeSocket(): void {
    if (!this.ws) return;
    const current = this.ws;
    this.ws = null;
    try {
      current.terminate();
    } catch {
      // no-op
    }
    this.isConnected = false;
    this.clearHeartbeatTimers();
  }
}

export const wsManager = WebSocketManager.getInstance();
