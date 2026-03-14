import WebSocket from "ws";
import { logger } from "./logger.js";

type MessageHandler = (payload: unknown) => void;

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
  private readonly messageHandlers = new Set<MessageHandler>();
  private readonly queue: string[] = [];

  private readonly connectTimeoutMs = 5000;
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
   */
  async connect(url: string): Promise<boolean> {
    const nextUrl = url.trim();
    if (!nextUrl) return false;

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

    return await new Promise<boolean>((resolve) => {
      const ws = new WebSocket(url);
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
        this.isConnected = true;
        this.reconnectAttempts = 0;
        this.startHeartbeat();
        this.flushQueue();
        finish(true);
      });

      ws.on("message", (raw) => {
        const rawText = Buffer.isBuffer(raw) ? raw.toString() : String(raw);
        let parsed: unknown = rawText;
        try {
          parsed = JSON.parse(rawText);
        } catch {
          // keep raw string as payload
        }
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
