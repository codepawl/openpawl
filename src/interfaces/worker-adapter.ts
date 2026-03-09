/**
 * WorkerAdapter - OpenClaw-only worker interface for TeamClaw.
 */

import type { TaskRequest, TaskResult } from "../core/state.js";
import { CONFIG } from "../core/config.js";
import { logger } from "../core/logger.js";
import WebSocket from "ws";

export type WorkerAdapterType = "openclaw";

export interface WorkerAdapter {
  executeTask(task: TaskRequest): Promise<TaskResult>;
  healthCheck(): Promise<boolean>;
  getStatus(): Promise<Record<string, unknown>>;
  reset(): Promise<void>;
  readonly adapterType: WorkerAdapterType;
}

function normalizeWorkerKey(input: string): string {
  return input.trim().toLowerCase().replace(/[\s_-]+/g, "");
}

/**
 * Resolve worker URL for a bot using prioritized keys:
 * - exact/prefixed bot id
 * - exact/prefixed bot name
 * - exact/prefixed role id
 * - exact/prefixed role label (for dynamic roster role-based mapping)
 * Falls back to global OPENCLAW_WORKER_URL.
 */
export function resolveTargetUrl(
  bot: { id: string; name?: string; role_id?: string; worker_url?: string | null; traits?: Record<string, unknown> },
  workerUrls: Record<string, string> = {},
  fallbackUrl = CONFIG.openclawWorkerUrl
): string {
  const local = (bot.worker_url ?? "").trim();
  if (local) return local;

  const roleLabel =
    typeof bot.traits?.["role_label"] === "string" ? String(bot.traits["role_label"]).trim() : "";

  const candidates = [
    bot.id,
    `id:${bot.id}`,
    bot.name ?? "",
    bot.name ? `name:${bot.name}` : "",
    bot.role_id ?? "",
    bot.role_id ? `role:${bot.role_id}` : "",
    roleLabel,
    roleLabel ? `role:${roleLabel}` : "",
  ]
    .map((x) => x.trim())
    .filter(Boolean);

  for (const key of candidates) {
    const direct = workerUrls[key];
    if (typeof direct === "string" && direct.trim()) return direct.trim();
  }

  const normalizedMap = new Map<string, string>();
  for (const [k, v] of Object.entries(workerUrls)) {
    if (!v?.trim()) continue;
    normalizedMap.set(normalizeWorkerKey(k), v.trim());
  }
  for (const key of candidates) {
    const hit = normalizedMap.get(normalizeWorkerKey(key));
    if (hit) return hit;
  }

  return (fallbackUrl ?? "").trim();
}

function log(msg: string): void {
  if (CONFIG.verboseLogging) {
    logger.agent(msg);
  }
}

function redactToken(raw: string): string {
  return raw.replace(/"token":"[^"]*"/g, '"token":"***"');
}

function debugIngest(
  hypothesisId: string,
  location: string,
  message: string,
  data: Record<string, unknown>,
  runId = "pre-fix-1",
): void {
  // #region agent log
  fetch("http://127.0.0.1:7903/ingest/407ab213-7292-4e0c-8886-3187558b1cc3", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Debug-Session-Id": "0414e3",
    },
    body: JSON.stringify({
      sessionId: "0414e3",
      runId,
      hypothesisId,
      location,
      message,
      data,
      timestamp: Date.now(),
    }),
  }).catch(() => {});
  // #endregion
}

const MAX_RETRIES = 5;
const DEFAULT_TIMEOUT_MS = 120_000;
const AUTH_ACK_TIMEOUT_MS = 5_000;

function shortFrame(frame: unknown): string {
  try {
    const text = JSON.stringify(frame);
    return text.length > 100 ? `${text.slice(0, 100)}...` : text;
  } catch {
    return String(frame);
  }
}

function socketEvent(msg: Record<string, unknown>): string {
  return String(msg.event ?? msg.type ?? "").toLowerCase();
}

function challengeNonce(msg: Record<string, unknown>): string {
  const payload = (msg.payload ?? null) as Record<string, unknown> | null;
  const nonce = payload?.nonce ?? msg.nonce;
  return typeof nonce === "string" ? nonce.trim() : "";
}

function isConnectChallenge(msg: Record<string, unknown>): boolean {
  return socketEvent(msg) === "connect.challenge";
}

function isConnectSuccess(msg: Record<string, unknown>): boolean {
  const event = socketEvent(msg);
  return event === "connect.success" || event.endsWith("connect.success");
}

function isConnectFailure(msg: Record<string, unknown>): boolean {
  const event = socketEvent(msg);
  const status = String(msg.status ?? "").toLowerCase();
  const error = String(msg.error ?? msg.message ?? msg.reason ?? "").toLowerCase();
  return (
    event === "connect.error" ||
    event.endsWith("connect.error") ||
    status === "unauthorized" ||
    status === "forbidden" ||
    status === "failed" ||
    error.includes("unauthorized") ||
    error.includes("forbidden") ||
    error.includes("invalid token")
  );
}

function toWebSocketUrl(baseUrl: string, _token: string | null): string {
  const trimmed = baseUrl.trim().replace(/\/$/, "");
  const withProtocol = /^wss?:\/\//i.test(trimmed)
    ? trimmed
    : /^https?:\/\//i.test(trimmed)
      ? trimmed.replace(/^http/i, "ws")
      : `ws://${trimmed}`;
  const url = new URL(withProtocol);
  if (url.hostname === "localhost") {
    url.hostname = "127.0.0.1";
  }
  return url.href;
}

function websocketHeaders(wsUrl: string): Record<string, string> {
  const parsed = new URL(wsUrl);
  const originProtocol = parsed.protocol === "wss:" ? "https:" : "http:";
  return {
    Host: "127.0.0.1:8001",
    "User-Agent": "TeamClaw/0.1.0",
    Origin: `${originProtocol}//127.0.0.1:8001`,
  };
}

type HandshakeVariant =
  | "event-connect-response-payload-token-last"
  | "action-connect-response-payload-token-last"
  | "action-connect-response-payload-raw-challenge"
  | "event-connect-response-payload-raw-challenge"
  | "action-connect-response-payload-nonce-only";

function buildConnectResponseFrame(
  token: string,
  nonce: string,
  ts: number | null,
  rawChallenge: Record<string, unknown> | null,
  variant: HandshakeVariant,
): Record<string, unknown> {
  if (variant === "event-connect-response-payload-token-last") {
    return {
      type: "event",
      event: "connect.response",
      payload: {
        nonce,
        ...(typeof ts === "number" ? { ts } : {}),
        token,
      },
    };
  }
  if (variant === "action-connect-response-payload-token-last") {
    return {
      type: "action",
      action: "connect.response",
      payload: {
        nonce,
        ...(typeof ts === "number" ? { ts } : {}),
        token,
      },
    };
  }
  if (variant === "action-connect-response-payload-raw-challenge") {
    return {
      type: "action",
      action: "connect.response",
      payload: {
        token,
        challenge:
          rawChallenge && typeof rawChallenge === "object"
            ? rawChallenge
            : {
                nonce,
                ...(typeof ts === "number" ? { ts } : {}),
              },
      },
    };
  }
  if (variant === "event-connect-response-payload-raw-challenge") {
    return {
      type: "event",
      event: "connect.response",
      payload: {
        token,
        challenge:
          rawChallenge && typeof rawChallenge === "object"
            ? rawChallenge
            : {
                nonce,
                ...(typeof ts === "number" ? { ts } : {}),
              },
      },
    };
  }
  if (variant === "action-connect-response-payload-nonce-only") {
    return {
      type: "action",
      action: "connect.response",
      payload: {
        token,
        nonce,
      },
    };
  }
  return { type: "action", action: "connect.response", payload: { token, nonce } };
}

function challengeTs(msg: Record<string, unknown>): number | null {
  const payload = (msg.payload ?? null) as Record<string, unknown> | null;
  const raw = payload?.ts ?? msg.ts;
  return typeof raw === "number" && Number.isFinite(raw) ? raw : null;
}

function handshakeVariantForAttempt(attempt: number): HandshakeVariant {
  if (attempt === 1) return "event-connect-response-payload-token-last";
  if (attempt === 2) return "action-connect-response-payload-token-last";
  if (attempt === 3) return "action-connect-response-payload-raw-challenge";
  if (attempt === 4) return "event-connect-response-payload-raw-challenge";
  return "action-connect-response-payload-nonce-only";
}

function sendConnectResponseFrame(
  ws: WebSocket,
  token: string,
  nonce: string,
  ts: number | null,
  rawChallenge: Record<string, unknown> | null,
  variant: HandshakeVariant,
): string {
  const frame = buildConnectResponseFrame(token, nonce, ts, rawChallenge, variant);
  const rawFrame = JSON.stringify(frame);
  const redactedFrame = redactToken(rawFrame);
  // Keep exact emitted string visible for protocol debugging.
  console.log("[WS] Outgoing Frame:", redactedFrame);
  console.log("[WS] Outgoing Frame (Final):", redactedFrame);
  log(`[WS] Sending payload: ${shortFrame(frame)}`);
  ws.send(rawFrame);
  return rawFrame;
}

function sendConnectChallengeResponse(
  ws: WebSocket,
  msg: Record<string, unknown>,
  token: string,
  variant: HandshakeVariant,
): { rawFrame: string; nonce: string; ts: number | null } {
  const nonce = challengeNonce(msg);
  const ts = challengeTs(msg);
  const payload = (msg.payload ?? null) as Record<string, unknown> | null;
  const rawFrame = sendConnectResponseFrame(ws, token, nonce, ts, payload, variant);
  return { rawFrame, nonce, ts };
}

function ensureAuthTokenAndNonce(
  nonce: string,
  token: string | null | undefined,
): { ok: true; token: string } | { ok: false } {
  if (!nonce || !token?.trim()) return { ok: false };
  return { ok: true, token: token.trim() };
}

function authFailedError(): Error {
  return new Error(
    "❌ OpenClaw Authentication Failed: Please check if your OPENCLAW_TOKEN is correct in teamclaw config",
  );
}

function ingestChallengeDebug(
  handshakeVariant: HandshakeVariant,
  outgoingFrame: string,
  nonce: string,
  ts: number | null,
): void {
  // #region agent log
  debugIngest("H3", "src/interfaces/worker-adapter.ts:executeTask(challenge)", "Sent challenge response frame", {
    outgoingFrame: redactToken(outgoingFrame),
    nonceLength: nonce.length,
    challengeTs: ts,
    handshakeVariant,
  });
  // #endregion
}

function parseSocketMessage(raw: WebSocket.RawData): Record<string, unknown> | null {
  try {
    return JSON.parse(String(raw)) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function executeFrames(task: TaskRequest, model: string): Array<Record<string, unknown>> {
  return [
    {
      type: "execute_task",
      task_id: task.task_id,
      model,
      task: {
        task_id: task.task_id,
        description: task.description,
        priority: task.priority,
        estimated_cost: task.estimated_cost ?? 0,
      },
    },
    {
      action: "execute",
      task_id: task.task_id,
      model,
      description: task.description,
      priority: task.priority,
      estimated_cost: task.estimated_cost ?? 0,
    },
  ];
}

function extractCompletion(
  msg: Record<string, unknown>,
  expectedTaskId: string
): TaskResult | null {
  const taskId = String(msg.task_id ?? msg.id ?? expectedTaskId);
  if (taskId && taskId !== expectedTaskId) return null;

  const type = String(msg.type ?? msg.event ?? "").toLowerCase();
  const action = String(msg.action ?? "").toLowerCase();
  const status = String(msg.status ?? "").toLowerCase();

  if (type.includes("error") || action.includes("error") || status === "failed") {
    const errorText =
      String(msg.error ?? msg.message ?? msg.reason ?? "WebSocket worker execution failed");
    return {
      task_id: expectedTaskId,
      success: false,
      output: errorText,
      quality_score: 0,
    };
  }

  const maybeOutput =
    msg.output ??
    msg.result ??
    msg.content ??
    (msg.message && typeof msg.message === "string" ? msg.message : null);
  const outputText = maybeOutput != null ? String(maybeOutput).trim() : "";
  const isDone =
    type.includes("complete") ||
    type.includes("done") ||
    type.includes("result") ||
    action.includes("complete") ||
    action.includes("done") ||
    status === "completed" ||
    typeof msg.success === "boolean";

  if (!isDone && !outputText) return null;
  return {
    task_id: expectedTaskId,
    success: typeof msg.success === "boolean" ? Boolean(msg.success) : true,
    output: outputText || "Task completed",
    quality_score:
      typeof msg.quality_score === "number"
        ? msg.quality_score
        : typeof msg.score === "number"
          ? msg.score
          : 0.7,
  };
}

export class UniversalOpenClawAdapter implements WorkerAdapter {
  readonly adapterType: WorkerAdapterType = "openclaw";
  readonly workerUrl: string;
  private readonly authToken: string | null;
  private readonly timeout: number;
  private isAuthenticated = false;
  tasksProcessed = 0;

  constructor(options: { workerUrl?: string; authToken?: string | null; timeout?: number } = {}) {
    this.workerUrl = (options.workerUrl ?? CONFIG.openclawWorkerUrl ?? "").replace(/\/$/, "");
    this.authToken = options.authToken ?? (CONFIG.openclawToken || null);
    this.timeout = options.timeout ?? DEFAULT_TIMEOUT_MS;
    log(`UniversalOpenClawAdapter → ${this.workerUrl}`);
  }

  async healthCheck(): Promise<boolean> {
    if (!this.workerUrl) return false;
    try {
      const wsUrl = toWebSocketUrl(this.workerUrl, this.authToken);
      log(`[WS] Attempting to connect to ${wsUrl}...`);
      await new Promise<void>((resolve, reject) => {
        const ws = new WebSocket(wsUrl, { headers: websocketHeaders(wsUrl) });
        const timer = setTimeout(() => {
          ws.terminate();
          reject(new Error("WebSocket health check timeout"));
        }, 5000);
        ws.on("open", () => {
          log("[WS] Connection opened successfully.");
          log("[WS] Connection established, authenticating...");
        });
        ws.on("message", (raw) => {
          log(`[WS] Message received from Gateway: ${String(raw)}`);
          const msg = parseSocketMessage(raw);
          if (!msg) return;
          if (isConnectChallenge(msg)) {
            const nonce = challengeNonce(msg);
            const tokenCheck = ensureAuthTokenAndNonce(nonce, this.authToken);
            if (!tokenCheck.ok) {
              clearTimeout(timer);
              ws.close();
              reject(authFailedError());
              return;
            }
            log(`[WS] Received challenge (nonce: ${nonce}). Sending response...`);
            sendConnectResponseFrame(
              ws,
              tokenCheck.token,
              nonce,
              challengeTs(msg),
              (msg.payload ?? null) as Record<string, unknown> | null,
              "event-connect-response-payload-token-last",
            );
            return;
          }
          if (isConnectFailure(msg)) {
            clearTimeout(timer);
            ws.close();
            reject(authFailedError());
            return;
          }
          if (isConnectSuccess(msg)) {
            this.isAuthenticated = true;
            log("[WS] Authentication successful! Preparing to decompose goal.");
            clearTimeout(timer);
            ws.close();
            resolve();
          }
        });
        ws.on("close", (code, reason) => {
          const closeReason = String(reason ?? "");
          log(`[WS] Connection closed with code ${code}. reason=${closeReason || "n/a"}`);
          if (code === 1008) {
            this.isAuthenticated = false;
          }
        });
        ws.on("error", (err) => {
          clearTimeout(timer);
          reject(err);
        });
      });
      return true;
    } catch (err) {
      log(`OpenClaw health check failed: ${err}`);
      return false;
    }
  }

  async executeTask(task: TaskRequest): Promise<TaskResult> {
    const model = CONFIG.openclawModel?.trim() || "team-default";
    const payload = {
      model,
      task,
    };

    let lastErr: Error | null = null;
    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      try {
        const wsUrl = toWebSocketUrl(this.workerUrl, this.authToken);
        log(`[WS] Attempting to connect to ${wsUrl}...`);
        log(`[WS] Cached authentication state: ${this.isAuthenticated ? "authenticated" : "unauthenticated"}`);
        // #region agent log
        debugIngest("H1", "src/interfaces/worker-adapter.ts:executeTask(connect)", "Opening websocket for executeTask", {
          wsUrl,
          hasToken: Boolean(this.authToken?.trim()),
          hasQueryToken: wsUrl.includes("token="),
          workerUrl: this.workerUrl,
          adapterProbeVersion: "src-probe-20260309-b",
          variantAttempt1: handshakeVariantForAttempt(1),
          tokenLength: (this.authToken ?? "").length,
          tokenHasWhitespace: /\s/.test(this.authToken ?? ""),
          tokenHasNonPrintable: /[^\x20-\x7E]/.test(this.authToken ?? ""),
        });
        // #endregion
        const result = await new Promise<TaskResult>((resolve, reject) => {
          const ws = new WebSocket(wsUrl, { headers: websocketHeaders(wsUrl) });
          let settled = false;
          let executeSent = false;
          let authConfirmed = !this.authToken?.trim();
          let authAckTimer: NodeJS.Timeout | null = null;
          let lastSentRaw = "";
          const recentInbound: string[] = [];
          const handshakeVariant = handshakeVariantForAttempt(attempt);
          const timer = setTimeout(() => {
            if (settled) return;
            settled = true;
            ws.terminate();
            reject(new Error(`WebSocket execution timeout (${this.timeout}ms)`));
          }, this.timeout);
          const cleanup = () => {
            clearTimeout(timer);
            if (authAckTimer) {
              clearTimeout(authAckTimer);
              authAckTimer = null;
            }
            try {
              ws.close();
            } catch {
              // ignore
            }
          };
          const sendExecuteFrames = () => {
            if (executeSent || settled) return;
            executeSent = true;
            for (const frame of executeFrames(payload.task, payload.model)) {
              const raw = JSON.stringify(frame);
              lastSentRaw = raw;
              log(`[WS] Sending payload: ${shortFrame(frame)}`);
              ws.send(raw);
            }
          };

          ws.on("open", () => {
            log("[WS] Connection opened successfully.");
            log("[WS] Connection established, authenticating...");
            // #region agent log
            debugIngest("H4", "src/interfaces/worker-adapter.ts:executeTask(open)", "Socket open; waiting for challenge", {
              authConfirmed,
              headers: websocketHeaders(wsUrl),
            });
            // #endregion
            if (authConfirmed) {
              this.isAuthenticated = true;
              sendExecuteFrames();
              return;
            }
            authAckTimer = setTimeout(() => {
              if (authConfirmed || settled) {
                return;
              }
              settled = true;
              cleanup();
              reject(
                new Error(
                  "❌ OpenClaw Authentication Failed: Please check if your OPENCLAW_TOKEN is correct in teamclaw config",
                ),
              );
            }, AUTH_ACK_TIMEOUT_MS);
          });

          ws.on("message", (raw) => {
            log(`[WS] Message received from Gateway: ${String(raw)}`);
            const rawText = String(raw);
            recentInbound.push(rawText);
            if (recentInbound.length > 3) recentInbound.shift();
            const msg = parseSocketMessage(raw);
            if (!msg) return;
            // #region agent log
            debugIngest("H2", "src/interfaces/worker-adapter.ts:executeTask(message)", "Inbound message observed", {
              event: String(msg.event ?? ""),
              type: String(msg.type ?? ""),
              status: String(msg.status ?? ""),
              keys: Object.keys(msg),
              payloadKeys:
                msg.payload && typeof msg.payload === "object"
                  ? Object.keys(msg.payload as Record<string, unknown>)
                  : [],
              challengeTs:
                msg.payload && typeof msg.payload === "object"
                  ? (msg.payload as Record<string, unknown>).ts ?? null
                  : null,
            });
            // #endregion
            if (!authConfirmed && isConnectChallenge(msg)) {
              const nonce = challengeNonce(msg);
              const tokenCheck = ensureAuthTokenAndNonce(nonce, this.authToken);
              if (!tokenCheck.ok) {
                settled = true;
                cleanup();
                reject(authFailedError());
                return;
              }
              log(`[WS] Received challenge (nonce: ${nonce}). Sending response...`);
              const sent = sendConnectChallengeResponse(ws, msg, tokenCheck.token, handshakeVariant);
              lastSentRaw = sent.rawFrame;
              ingestChallengeDebug(handshakeVariant, sent.rawFrame, sent.nonce, sent.ts);
              return;
            }
            if (!authConfirmed && isConnectFailure(msg)) {
              settled = true;
              this.isAuthenticated = false;
              cleanup();
              reject(authFailedError());
              return;
            }
            if (!authConfirmed && isConnectSuccess(msg)) {
              authConfirmed = true;
              this.isAuthenticated = true;
              log("[WS] Authentication successful! Preparing to decompose goal.");
              if (authAckTimer) {
                clearTimeout(authAckTimer);
                authAckTimer = null;
              }
              sendExecuteFrames();
              return;
            }
            const completion = extractCompletion(msg, task.task_id);
            if (!completion) return;
            settled = true;
            cleanup();
            resolve(completion);
          });

          ws.on("error", (err) => {
            if (settled) return;
            settled = true;
            cleanup();
            reject(err);
          });

          ws.on("close", (code, reason) => {
            const closeReason = String(reason ?? "");
            log(`[WS] Connection closed with code ${code}. reason=${closeReason || "n/a"}`);
            // #region agent log
            debugIngest("H5", "src/interfaces/worker-adapter.ts:executeTask(close)", "Socket closed during executeTask", {
              code,
              reason: closeReason || "n/a",
              lastSentFrame: redactToken(lastSentRaw || ""),
              lastThreeInbound: recentInbound,
            });
            // #endregion
            if (settled) return;
            settled = true;
            cleanup();
            if (code === 1008 || closeReason.toLowerCase().includes("invalid request frame")) {
              log(`[WS] Last frame before 1008/invalid-frame: ${lastSentRaw || "(none)"}`);
              this.isAuthenticated = false;
              reject(authFailedError());
              return;
            }
            reject(new Error(`WebSocket closed before completion (code ${code})`));
          });
        });

        this.tasksProcessed += 1;
        return result;
      } catch (err) {
        lastErr = err instanceof Error ? err : new Error(String(err));
        log(`Worker failed (attempt ${attempt}/${MAX_RETRIES}): ${lastErr.message}`);
      }
    }

    return {
      task_id: task.task_id,
      success: false,
      output: `Worker unreachable: ${lastErr}`,
      quality_score: 0,
    };
  }

  async getStatus(): Promise<Record<string, unknown>> {
    try {
      const wsUrl = toWebSocketUrl(this.workerUrl, this.authToken);
      log(`[WS] Attempting to connect to ${wsUrl}...`);
      return await new Promise<Record<string, unknown>>((resolve, reject) => {
        const ws = new WebSocket(wsUrl, { headers: websocketHeaders(wsUrl) });
        const timer = setTimeout(() => {
          ws.terminate();
          reject(new Error("WebSocket status timeout"));
        }, 5000);
        ws.on("open", () => {
          log("[WS] Connection opened successfully.");
          log("[WS] Connection established, authenticating...");
        });
        ws.on("message", (raw) => {
          log(`[WS] Message received from Gateway: ${String(raw)}`);
          const msg = parseSocketMessage(raw);
          if (!msg) return;
          if (isConnectChallenge(msg)) {
            const nonce = challengeNonce(msg);
            const tokenCheck = ensureAuthTokenAndNonce(nonce, this.authToken);
            if (!tokenCheck.ok) {
              clearTimeout(timer);
              ws.close();
              reject(authFailedError());
              return;
            }
            log(`[WS] Received challenge (nonce: ${nonce}). Sending response...`);
            sendConnectResponseFrame(
              ws,
              tokenCheck.token,
              nonce,
              challengeTs(msg),
              (msg.payload ?? null) as Record<string, unknown> | null,
              "event-connect-response-payload-token-last",
            );
            return;
          }
          if (isConnectFailure(msg)) {
            clearTimeout(timer);
            ws.close();
            reject(authFailedError());
            return;
          }
          if (isConnectSuccess(msg)) {
            this.isAuthenticated = true;
            log("[WS] Authentication successful! Preparing to decompose goal.");
            const statusFrame = { type: "status" };
            log(`[WS] Sending payload: ${shortFrame(statusFrame)}`);
            ws.send(JSON.stringify(statusFrame));
            return;
          }
          clearTimeout(timer);
          ws.close();
          resolve(msg);
        });
        ws.on("close", (code, reason) => {
          const closeReason = String(reason ?? "");
          log(`[WS] Connection closed with code ${code}. reason=${closeReason || "n/a"}`);
        });
        ws.on("error", (err) => {
          clearTimeout(timer);
          reject(err);
        });
      });
    } catch (err) {
      return { status: "unreachable", error: String(err) };
    }
  }

  async reset(): Promise<void> {
    try {
      const wsUrl = toWebSocketUrl(this.workerUrl, this.authToken);
      log(`[WS] Attempting to connect to ${wsUrl}...`);
      await new Promise<void>((resolve, reject) => {
        const ws = new WebSocket(wsUrl, { headers: websocketHeaders(wsUrl) });
        const timer = setTimeout(() => {
          ws.terminate();
          reject(new Error("WebSocket reset timeout"));
        }, 5000);
        ws.on("open", () => {
          log("[WS] Connection opened successfully.");
          log("[WS] Connection established, authenticating...");
        });
        ws.on("message", (raw) => {
          log(`[WS] Message received from Gateway: ${String(raw)}`);
          const msg = parseSocketMessage(raw);
          if (!msg) return;
          if (isConnectChallenge(msg)) {
            const nonce = challengeNonce(msg);
            const tokenCheck = ensureAuthTokenAndNonce(nonce, this.authToken);
            if (!tokenCheck.ok) {
              clearTimeout(timer);
              ws.close();
              reject(authFailedError());
              return;
            }
            log(`[WS] Received challenge (nonce: ${nonce}). Sending response...`);
            sendConnectResponseFrame(
              ws,
              tokenCheck.token,
              nonce,
              challengeTs(msg),
              (msg.payload ?? null) as Record<string, unknown> | null,
              "event-connect-response-payload-token-last",
            );
            return;
          }
          if (isConnectFailure(msg)) {
            clearTimeout(timer);
            ws.close();
            reject(authFailedError());
            return;
          }
          if (isConnectSuccess(msg)) {
            this.isAuthenticated = true;
            log("[WS] Authentication successful! Preparing to decompose goal.");
            const resetFrame = { type: "reset" };
            log(`[WS] Sending payload: ${shortFrame(resetFrame)}`);
            ws.send(JSON.stringify(resetFrame));
            clearTimeout(timer);
            ws.close();
            resolve();
          }
        });
        ws.on("close", (code, reason) => {
          const closeReason = String(reason ?? "");
          log(`[WS] Connection closed with code ${code}. reason=${closeReason || "n/a"}`);
          if (code === 1008) {
            this.isAuthenticated = false;
          }
        });
        ws.on("error", (err) => {
          clearTimeout(timer);
          reject(err);
        });
      });
      this.tasksProcessed = 0;
    } catch (err) {
      log(`Reset failed: ${err}`);
    }
  }
}

export const OpenClawAdapter = UniversalOpenClawAdapter;

export function createWorkerAdapter(
  bot: { id: string; name?: string; role_id?: string; worker_url?: string | null; traits?: Record<string, unknown> },
  workerUrls: Record<string, string> = {}
): WorkerAdapter {
  const url = resolveTargetUrl(bot, workerUrls, CONFIG.openclawWorkerUrl);
  return new UniversalOpenClawAdapter({ workerUrl: url, authToken: CONFIG.openclawToken });
}

export function createRoutingAdapters(
  bot: { id: string; worker_url?: string | null },
  workerUrls: Record<string, string> = {}
): { light: WorkerAdapter; heavy: WorkerAdapter | null } {
  const universal = createWorkerAdapter(bot, workerUrls);
  return { light: universal, heavy: universal };
}
