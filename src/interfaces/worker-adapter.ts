/**
 * WorkerAdapter - OpenClaw WebSocket worker interface for TeamClaw.
 * Uses WebSocket with Challenge-Response authentication for LLM completions.
 */

import type { TaskRequest, TaskResult } from "../core/state.js";
import { CONFIG } from "../core/config.js";
import { logger, isDebugMode } from "../core/logger.js";
import { getTrafficController } from "../core/traffic-control.js";
import { resolveModelForAgent } from "../core/model-config.js";
import WebSocket from "ws";
import pc from "picocolors";

export type WorkerAdapterType = "openclaw";

export interface WorkerAdapter {
  executeTask(task: TaskRequest): Promise<TaskResult>;
  healthCheck(): Promise<boolean>;
  getStatus(): Promise<Record<string, unknown>>;
  reset(): Promise<void>;
  readonly adapterType: WorkerAdapterType;
}

export type StreamChunkCallback = (chunk: string) => void;
export type StreamDoneCallback = (error?: { message: string }) => void;
export type TokenUsageCallback = (inputTokens: number, outputTokens: number, cachedInputTokens: number, model: string) => void;

function normalizeWorkerKey(input: string): string {
  return input.trim().toLowerCase().replace(/[\s_-]+/g, "");
}

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
  if (isDebugMode()) {
    logger.agent(msg);
  }
}

function formatAdapterError(title: string, details: string[]): string {
  return [
    pc.red(`❌ ${title}`),
    ...details.map((detail) => pc.dim(`• ${detail}`)),
  ].join("\n");
}

const DEFAULT_TIMEOUT_MS = 120_000;

export class UniversalOpenClawAdapter implements WorkerAdapter {
  readonly adapterType: WorkerAdapterType = "openclaw";
  private wsUrl: string;
  private timeout: number;
  private workspacePath: string;
  private configuredModel: string;
  private authToken: string;
  private botId: string;
  tasksProcessed = 0;
  onStreamChunk: StreamChunkCallback | undefined;
  onStreamDone: StreamDoneCallback | undefined;
  onTokenUsage: TokenUsageCallback | undefined;

  constructor(options: { workerUrl?: string; authToken?: string | null; timeout?: number; workspacePath?: string; model?: string; botId?: string; onStreamChunk?: StreamChunkCallback; onStreamDone?: StreamDoneCallback; onTokenUsage?: TokenUsageCallback } = {}) {
    const baseWsUrl = (options.workerUrl ?? CONFIG.openclawWorkerUrl ?? "").trim();
    if (!baseWsUrl) {
      throw new Error("OPENCLAW_WORKER_URL is not configured. Run `teamclaw setup`.");
    }
    const token = (options.authToken ?? CONFIG.openclawToken ?? "").trim();
    this.botId = options.botId ?? "worker";
    // Normalize WebSocket URL - handle ws://, wss://, http://, https://
    if (baseWsUrl.startsWith("wss://")) {
      this.wsUrl = baseWsUrl; // Already correct
    } else if (baseWsUrl.startsWith("ws://")) {
      this.wsUrl = baseWsUrl; // Already correct
    } else if (baseWsUrl.startsWith("https://")) {
      this.wsUrl = baseWsUrl.replace(/^https:\/\//, "wss://");
    } else if (baseWsUrl.startsWith("http://")) {
      this.wsUrl = baseWsUrl.replace(/^http:\/\//, "ws://");
    } else {
      // Bare hostname - assume ws
      this.wsUrl = `ws://${baseWsUrl.replace(/\/$/, "")}`;
    }
    this.authToken = token;
    this.timeout = options.timeout ?? DEFAULT_TIMEOUT_MS;
    this.workspacePath = options.workspacePath ?? process.cwd();
    this.configuredModel = (options.model ?? CONFIG.openclawModel ?? "").trim();
    this.onStreamChunk = options.onStreamChunk;
    this.onStreamDone = options.onStreamDone;
    this.onTokenUsage = options.onTokenUsage;
    log(`UniversalOpenClawAdapter (WS) → ${this.wsUrl} model=${this.configuredModel || "default"} (workspace: ${this.workspacePath})`);
  }

    private async chatComplete(
        messages: { role: string; content: string }[],
        onChunk?: (chunk: string) => void,
        onDone?: (error?: { message: string }) => void,
        onUsage?: (input: number, output: number) => void
    ): Promise<string> {
        const model = this.configuredModel || resolveModelForAgent(this.botId || "worker");
        const timeoutMs = this.timeout;
        const token = this.authToken;
        const requestId = "teamclaw-" + Date.now();
        const tokenUsageCb = onUsage ?? this.onTokenUsage;
        const streamChunk = onChunk ?? this.onStreamChunk;
        const streamDone = onDone ?? this.onStreamDone;

        log(`[Debug] WS → ${this.wsUrl} model=${model} msgCount=${messages.length}`);

        // Use OpenClaw's chat.send method with proper session handling
        const requestPayload = {
            type: "req",
            id: requestId,
            method: "chat.send",
            params: {
                sessionKey: "main",
                message: messages[messages.length - 1].content,
                idempotencyKey: requestId
            }
        };

        log(`[Debug] Payload: ${JSON.stringify(requestPayload).slice(0, 200)}`);

        return new Promise((resolve, reject) => {
            let ws: WebSocket | null = null;
            let resolved = false;
            let rawMessages = "";
            let challengeNonce = "";
            let challengeTs: number | null = null;

            const cleanup = () => {
                if (ws && ws.readyState === WebSocket.OPEN) {
                    ws.close();
                }
            };

            const timeoutId = setTimeout(() => {
                if (!resolved) {
                    resolved = true;
                    cleanup();
                    log(`[Debug] WS Timeout. Raw messages: ${rawMessages.slice(0, 500)}`);
                    if (streamDone) streamDone({ message: `Timeout after ${timeoutMs}ms` });
                    reject(new Error(formatAdapterError("TIMEOUT", [
                        `WebSocket timeout after ${timeoutMs}ms`,
                        `Raw: ${rawMessages.slice(0, 200)}`,
                    ])));
                }
            }, timeoutMs);

            try {
                ws = new WebSocket(this.wsUrl);

                ws.on("open", () => {
                    log("[Debug] WS Connected, awaiting challenge...");
                });

                ws.on("message", (data) => {
                    const msg = data.toString();
                    rawMessages += msg + "\n";
                    log(`[Debug] WS Message: ${msg.slice(0, 500)}`);

                    try {
                        const parsed = JSON.parse(msg) as Record<string, unknown>;
                        const event = String(parsed.event ?? parsed.type ?? "").toLowerCase();

                        // Step 2: Handle connect.challenge - send connect request with nonce in auth
                        if (event === "connect.challenge") {
                            const payload = parsed.payload as Record<string, unknown> | undefined;
                            challengeNonce = String(payload?.nonce ?? "");
                            const tsRaw = payload?.ts;
                            challengeTs = typeof tsRaw === "number" ? tsRaw : null;

                            log(`[Debug] Received challenge: nonce=${challengeNonce} ts=${challengeTs}`);

                            // Send connect request - the nonce isn't needed in auth, 
                            // just sending the token after the challenge is enough
                            const connectRequest = {
                                type: "req",
                                id: "connect-" + Date.now(),
                                method: "connect",
                                params: {
                                    minProtocol: 3,
                                    maxProtocol: 3,
                                    client: {
                                        id: "cli",
                                        version: "1.0.0",
                                        platform: "nodejs",
                                        mode: "cli"
                                    },
                                    role: "operator",
                                    scopes: ["operator.read", "operator.write", "operator.admin"],
                                    auth: { token: token },
                                    locale: "en-US"
                                }
                            };
                            
                            log(`[Debug] Sending connect request: ${JSON.stringify(connectRequest).slice(0, 200)}`);
                            ws?.send(JSON.stringify(connectRequest));
                            return;
                        }

                        // Step 3: Handle connect.success - now we can send the request
                        // Can be either event=connect.success or type=res with ok=true
                        const isConnectSuccess = event === "connect.success" || event === "connect.ok";
                        const isConnectResponse = parsed.type === "res" && String(parsed.id).startsWith("connect-") && parsed.ok === true;
                        if (isConnectSuccess || isConnectResponse) {
                            log("[Debug] Auth successful, sending chat request...");
                            ws?.send(JSON.stringify(requestPayload));
                            return;
                        }

                        // Handle auth failure
                        if (event === "connect.error" || event === "connect.fail" || parsed.status === "unauthorized" || parsed.status === "forbidden") {
                            if (!resolved) {
                                resolved = true;
                                clearTimeout(timeoutId);
                                cleanup();
                                const errMsg = String(parsed.error ?? parsed.message ?? "Authentication failed");
                                reject(new Error(formatAdapterError("AUTH ERROR", [
                                    `Gateway rejected the authentication`,
                                    `Detail: ${errMsg}`,
                                ])));
                            }
                            return;
                        }

                        // Step 4: Handle the chat completion response - must match our request id
                        // OR capture the runId from the initial response for async processing
                        const responseId = parsed.id;
                        const requestIdVal = requestPayload.id;
                        
                        if ((parsed.type === "res" || parsed.type === "resp") && responseId === requestIdVal) {
                            // Check for immediate response content
                            const text = this.extractWsResponse(parsed);
                            if (text && text.length > 10 && !text.includes('"type"')) {
                                // Has actual content, resolve immediately
                                if (!resolved) {
                                    resolved = true;
                                    clearTimeout(timeoutId);
                                    cleanup();
                                    resolve(text);
                                }
                                return;
                            }
                            
                            // No immediate content - wait for async events
                            return;
                        }

                        // Handle chat events (for async responses) - don't filter by runId
                        // because the gateway uses different runIds for request vs agent events
                        if (event === "chat" || event === "agent") {
                            
                            // For chat events
                            if (event === "chat") {
                                const chatPayload = parsed.payload as Record<string, unknown> | undefined;
                                const state = chatPayload?.state;
                                const message = chatPayload?.message as Record<string, unknown> | undefined;
                                const messageContent = message?.content;
                                
                                // Emit streaming content chunks when available
                                if (messageContent) {
                                    let contentText = "";
                                    if (Array.isArray(messageContent)) {
                                        contentText = messageContent
                                            .filter((c): c is { type: string; text: string } => typeof c?.text === "string")
                                            .map((c) => c.text)
                                            .join("");
                                    } else if (typeof messageContent === "string") {
                                        contentText = messageContent;
                                    }
                                    
                                    if (contentText && streamChunk) {
                                        streamChunk(contentText);
                                    }
                                }
                                
                                // Handle state=final with message content only (not delta)
                                if (state === "final") {
                                    // Check message.content which can be an array or string
                                    if (Array.isArray(messageContent)) {
                                        // Content is array of {type, text} objects
                                        const textParts = messageContent
                                            .filter((c): c is { type: string; text: string } => typeof c?.text === "string")
                                            .map((c) => c.text)
                                            .join("");
                                        if (textParts && !resolved) {
                                            resolved = true;
                                            clearTimeout(timeoutId);
                                            cleanup();
                                            if (streamDone) streamDone();
                                            resolve(textParts);
                                            return;
                                        }
                                    } else if (typeof messageContent === "string" && messageContent) {
                                        if (!resolved) {
                                            resolved = true;
                                            clearTimeout(timeoutId);
                                            cleanup();
                                            if (streamDone) streamDone();
                                            resolve(messageContent);
                                            return;
                                        }
                                    }
                                }
                            }
                            
                            // For agent events - stream content as it arrives
                            if (event === "agent") {
                                const agentPayload = parsed.payload as Record<string, unknown> | undefined;
                                const stream = agentPayload?.stream;
                                const data = agentPayload?.data as Record<string, unknown> | undefined;
                                const phase = data?.phase;
                                
                                // Emit content chunks during agent streaming
                                const output = data?.message ?? data?.output ?? data?.content ?? data?.response;
                                if (output && typeof output === "string" && streamChunk) {
                                    streamChunk(output);
                                }
                                
                                // Extract token usage from agent data (with prompt caching support)
                                if (stream === "lifecycle" || stream === "content") {
                                    const usage = data?.usage as Record<string, unknown> | undefined;
                                    if (usage && tokenUsageCb) {
                                        // OpenAI format: usage.prompt_tokens_details.cached_tokens
                                        const promptDetails = usage?.prompt_tokens_details as Record<string, unknown> | undefined;
                                        const cachedTokensOpenAI = (promptDetails?.cached_tokens ?? 0) as number;
                                        
                                        // Anthropic format: usage.cache_read_input_tokens
                                        const cachedTokensAnthropic = (usage?.cache_read_input_tokens ?? 0) as number;
                                        
                                        // Use whichever is available (prefer OpenAI format)
                                        const cachedInputTokens = Math.max(cachedTokensOpenAI, cachedTokensAnthropic);
                                        
                                        const inputTokens = (usage?.input_tokens ?? usage?.prompt_tokens ?? 0) as number;
                                        const outputTokens = (usage?.completion_tokens ?? usage?.output_tokens ?? 0) as number;
                                        
                                        if (inputTokens > 0 || outputTokens > 0 || cachedInputTokens > 0) {
                                            tokenUsageCb(inputTokens, outputTokens, cachedInputTokens, model);
                                        }
                                    }
                                }
                                
                                // Only resolve on lifecycle end/complete - wait for full response
                                if (stream === "lifecycle" && (phase === "complete" || phase === "done" || phase === "end")) {
                                    // Try to extract usage one more time from final data
                                    const finalData = data;
                                    const finalUsage = finalData?.usage as Record<string, unknown> | undefined;
                                    if (finalUsage && tokenUsageCb) {
                                        // OpenAI format: usage.prompt_tokens_details.cached_tokens
                                        const promptDetails = finalUsage?.prompt_tokens_details as Record<string, unknown> | undefined;
                                        const cachedTokensOpenAI = (promptDetails?.cached_tokens ?? 0) as number;
                                        
                                        // Anthropic format: usage.cache_read_input_tokens
                                        const cachedTokensAnthropic = (finalUsage?.cache_read_input_tokens ?? 0) as number;
                                        
                                        const cachedInputTokens = Math.max(cachedTokensOpenAI, cachedTokensAnthropic);
                                        
                                        const inputTokens = (finalUsage?.input_tokens ?? finalUsage?.prompt_tokens ?? 0) as number;
                                        const outputTokens = (finalUsage?.completion_tokens ?? finalUsage?.output_tokens ?? 0) as number;
                                        if (inputTokens > 0 || outputTokens > 0 || cachedInputTokens > 0) {
                                            tokenUsageCb(inputTokens, outputTokens, cachedInputTokens, model);
                                        } else if (!finalUsage?.input_tokens && !finalUsage?.completion_tokens) {
                                            // Fallback: estimate from character count (no cache discount)
                                            const outputText = finalData?.message ?? finalData?.output ?? finalData?.content ?? finalData?.response;
                                            if (typeof outputText === "string" && outputText.length > 0) {
                                                const estimatedOutput = Math.ceil(outputText.length / 4);
                                                tokenUsageCb(0, estimatedOutput, 0, model);
                                            }
                                        }
                                    }
                                    
                                    const finalOutput = data?.message ?? data?.output ?? data?.content ?? data?.response;
                                    if (finalOutput && !resolved) {
                                        resolved = true;
                                        clearTimeout(timeoutId);
                                        cleanup();
                                        if (streamDone) streamDone();
                                        resolve(String(finalOutput));
                                        return;
                                    }
                                }
                                
                                // Handle error phase
                                if (stream === "lifecycle" && phase === "error") {
                                    const errorMsg = data?.error ?? data?.message;
                                    if (errorMsg && !resolved) {
                                        resolved = true;
                                        clearTimeout(timeoutId);
                                        cleanup();
                                        if (streamDone) streamDone({ message: String(errorMsg) });
                                        reject(new Error(formatAdapterError("AGENT ERROR", [String(errorMsg)])));
                                        return;
                                    }
                                }
                            }
                            return;
                        }

                        // Handle error responses
                        if (parsed.type === "error" || event.includes("error")) {
                            if (!resolved) {
                                resolved = true;
                                clearTimeout(timeoutId);
                                cleanup();
                                const errMsg = String(parsed.message ?? parsed.error ?? JSON.stringify(parsed));
                                if (streamDone) streamDone({ message: errMsg });
                                reject(new Error(formatAdapterError("WS ERROR", [
                                    `Error from Gateway: ${errMsg}`,
                                ])));
                            }
                        }
                    } catch {
                        // Ignore parse errors
                    }
                });

                ws.on("error", (err) => {
                    if (!resolved) {
                        resolved = true;
                        clearTimeout(timeoutId);
                        if (streamDone) streamDone({ message: err.message });
                        reject(new Error(formatAdapterError("WS ERROR", [
                            `WebSocket error: ${err.message}`,
                        ])));
                    }
                });

                ws.on("close", (code, reason) => {
                    if (!resolved) {
                        resolved = true;
                        clearTimeout(timeoutId);
                        const reasonStr = reason.toString();
                        log(`[Debug] WS Closed: code=${code} reason=${reasonStr.slice(0, 100)}`);
                        if (streamDone) streamDone({ message: `Connection closed (code ${code})` });
                        reject(new Error(formatAdapterError("WS CLOSED", [
                            `Connection closed (code ${code})`,
                            reasonStr ? `Reason: ${reasonStr}` : "",
                        ])));
                    }
                });
            } catch (err) {
                clearTimeout(timeoutId);
                reject(err);
            }
        });
    }

    private extractWsResponse(data: Record<string, unknown>): string {
        const result = (data.result ?? data.response ?? data) as Record<string, unknown>;
        const choices = (result?.choices ?? data.choices) as Array<{ message?: { content?: unknown }; text?: unknown }> | undefined;
        if (Array.isArray(choices) && choices.length > 0) {
            const content = choices[0]?.message?.content ?? choices[0]?.text;
            if (typeof content === "string") return this.stripMarkdown(content.trim());
        }

        const output = result?.output ?? data.output ?? data.result ?? data.content ?? data.text;
        if (typeof output === "string") return this.stripMarkdown(output.trim());

        return JSON.stringify(data);
    }

    private stripMarkdown(text: string): string {
        // Strip markdown code blocks (```json ... ``` or ``` ... ```)
        let cleaned = text.replace(/^```[\w]*\n?/gm, "").replace(/```$/gm, "");
        // Also handle inline code
        cleaned = cleaned.replace(/`/g, "");
        return cleaned.trim();
    }

  async healthCheck(): Promise<boolean> {
    try {
      const result = await this.chatComplete([
        { role: "user", content: "ping" },
      ]);
      return result.length > 0;
    } catch {
      return false;
    }
  }

  async executeTask(task: TaskRequest): Promise<TaskResult> {
    const botId = this.botId || "worker";
    const trafficController = getTrafficController();

    const canProceed = await trafficController.acquire(botId);
    if (!canProceed) {
      return {
        task_id: task.task_id,
        success: false,
        output: "Traffic control: Session paused due to safety limit. Please restart the work session.",
        quality_score: 0,
      };
    }

    try {
      const systemPrompt = `You are a helpful AI assistant (Maker/Software Engineer). Execute the given task and return the result.
You are working in a strictly defined workspace. Treat this workspace as your root directory.
WORKSPACE PATH: ${this.workspacePath}

CRITICAL: Before performing any task, you MUST read docs/ARCHITECTURE.md.
Your code MUST strictly follow the architecture, folder structure, and tech stack 
defined by the Tech Lead in docs/ARCHITECTURE.md.

IMPORTANT: Do NOT create arbitrary subdirectories unless explicitly specified in the task.
Output files directly to the root of the provided workspace path unless the task explicitly requires a specific structure (like 'assets/' or 'src/components/').
All file operations (read, write, create, edit) MUST be performed within this directory.
Do not attempt to read or write files outside of it.`;
      const messages = [
        { role: "system", content: systemPrompt },
        { role: "user", content: task.description },
      ];

      const output = await this.chatComplete(messages);
      this.tasksProcessed += 1;

      return {
        task_id: task.task_id,
        success: true,
        output: output || "Task completed",
        quality_score: 0.8,
      };
    } catch (err) {
      return {
        task_id: task.task_id,
        success: false,
        output: `Worker error: ${err instanceof Error ? err.message : String(err)}`,
        quality_score: 0,
      };
    } finally {
      trafficController.release(botId);
    }
  }

  async getStatus(): Promise<Record<string, unknown>> {
    try {
      const output = await this.chatComplete([
        { role: "user", content: "What is your status?" },
      ]);
      return { status: "ok", response: output };
    } catch (err) {
      return { error: String(err) };
    }
  }

  async reset(): Promise<void> {
    this.tasksProcessed = 0;
    log("UniversalOpenClawAdapter reset");
  }
}

export const OpenClawAdapter = UniversalOpenClawAdapter;

export function createWorkerAdapter(
  bot: { id: string; name?: string; role_id?: string; worker_url?: string | null; traits?: Record<string, unknown> },
  workerUrls: Record<string, string> = {},
  workspacePath?: string
): WorkerAdapter {
  // Always resolve to a WebSocket-compatible URL (WS/WSS or plain host).
  // The WS gateway URL from CONFIG.openclawWorkerUrl is the correct target.
  const url = resolveTargetUrl(bot, workerUrls, CONFIG.openclawWorkerUrl);
  return new UniversalOpenClawAdapter({ workerUrl: url, authToken: CONFIG.openclawToken, workspacePath, botId: bot.id });
}

export function createRoutingAdapters(
  bot: { id: string; worker_url?: string | null },
  workerUrls: Record<string, string> = {},
  workspacePath?: string
): { light: WorkerAdapter; heavy: WorkerAdapter | null } {
  const universal = createWorkerAdapter(bot, workerUrls, workspacePath);
  return { light: universal, heavy: universal };
}
