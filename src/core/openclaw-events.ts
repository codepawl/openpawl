/**
 * OpenClaw structured log events — emitted from llm-client and worker-adapter
 * so the dashboard can display LLM request activity in real time.
 */

import { EventEmitter } from "node:events";

export type OpenClawLogLevel = "info" | "success" | "warn" | "error";

export interface OpenClawLogEntry {
  id: string;
  level: OpenClawLogLevel;
  source: "llm-client" | "worker-adapter";
  action: string;
  model: string;
  botId: string;
  message: string;
  meta?: Record<string, unknown>;
  timestamp: number;
}

export interface OpenClawStreamChunk {
  botId: string;
  model: string;
  chunk: string;
  timestamp: number;
}

export const openclawEvents = new EventEmitter();
