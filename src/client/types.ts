/**
 * Shared types and interfaces for the OpenClaw client.
 */

import { z } from "zod";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export const OpenClawClientConfigSchema = z.object({
  /** WebSocket gateway URL (ws:// or wss://) */
  gatewayUrl: z.string().url(),
  /** Optional auth token for Bearer authentication */
  apiKey: z.string().optional(),
  /** Delay between reconnection attempts in ms (default 3000) */
  reconnectDelay: z.number().int().positive().optional().default(3000),
  /** Maximum reconnection attempts before giving up (default 5) */
  maxReconnectAttempts: z.number().int().min(0).optional().default(5),
  /** Per-request timeout in ms (default 30000) */
  timeout: z.number().int().positive().optional().default(30_000),
});

export type OpenClawClientConfig = z.infer<typeof OpenClawClientConfigSchema>;

// ---------------------------------------------------------------------------
// Streaming
// ---------------------------------------------------------------------------

export interface StreamOptions {
  /** Model to use for the completion */
  model?: string;
  /** Temperature (0-2) */
  temperature?: number;
  /** System prompt prepended to the conversation */
  systemPrompt?: string;
  /** AbortSignal to cancel the stream mid-flight */
  signal?: AbortSignal;
}

export interface StreamChunk {
  /** Incremental text content from the model */
  content: string;
  /** True when this is the final chunk (stream finished) */
  done: boolean;
  /** Token usage stats, present only on the final chunk when reported */
  usage?: { promptTokens: number; completionTokens: number };
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export type OpenClawErrorCode =
  | "CONNECTION_FAILED"
  | "HANDSHAKE_REJECTED"
  | "STREAM_FAILED"
  | "TIMEOUT"
  | "DISCONNECTED"
  | "CONFIG_INVALID";

export class OpenClawError extends Error {
  readonly code: OpenClawErrorCode;
  readonly cause?: unknown;

  constructor(code: OpenClawErrorCode, message: string, cause?: unknown) {
    super(message);
    this.name = "OpenClawError";
    this.code = code;
    this.cause = cause;
  }
}

// ---------------------------------------------------------------------------
// Lifecycle events
// ---------------------------------------------------------------------------

export interface OpenClawClientEvents {
  connected: [];
  disconnected: [reason: string];
  error: [error: OpenClawError];
  reconnecting: [attempt: number, maxAttempts: number];
}
