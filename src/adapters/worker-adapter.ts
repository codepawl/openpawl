/**
 * WorkerAdapter - OpenClaw worker interface for TeamClaw.
 * Uses `openclaw agent` CLI for LLM completions (reliable, handles auth).
 */

import type { TaskRequest, TaskResult } from "../core/state.js";
import { CONFIG } from "../core/config.js";
import { logger, isDebugMode } from "../core/logger.js";
import { getTrafficController } from "../core/traffic-control.js";
import { resolveModelForAgent } from "../core/model-config.js";
import { extractFileBlocks, writeFileBlocks } from "../utils/file-block-parser.js";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import pc from "picocolors";
import { openclawEvents } from "../core/openclaw-events.js";

export type WorkerAdapterType = "openclaw";

export interface WorkerAdapter {
  executeTask(task: TaskRequest, options?: { signal?: AbortSignal }): Promise<TaskResult>;
  complete(messages: { role: string; content: string }[], options?: { signal?: AbortSignal }): Promise<string>;
  healthCheck(): Promise<boolean>;
  getStatus(): Promise<Record<string, unknown>>;
  reset(): Promise<void>;
  readonly adapterType: WorkerAdapterType;
}

export type StreamChunkCallback = (chunk: string) => void;
export type StreamDoneCallback = (error?: { message: string }) => void;
export type TokenUsageCallback = (inputTokens: number, outputTokens: number, cachedInputTokens: number, model: string) => void;
export type ReasoningCallback = (reasoning: string) => void;

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

/**
 * Extract a concise, actionable error from an execFile failure.
 * Node's execFile embeds the full command in err.message — strip that
 * and prefer stderr or known patterns.
 */
function classifyExecError(err: Error & { code?: number | string | null; killed?: boolean }, stderr?: string): string {
  const stderrClean = stderr?.trim() ?? "";

  // Process killed (timeout from Node side)
  if (err.killed) {
    return "Gateway timeout: openclaw agent process was killed (exceeded timeout)";
  }

  // ENOENT — openclaw binary not found
  if (err.code === "ENOENT") {
    return "openclaw CLI not found — ensure OpenClaw is installed and on PATH";
  }

  // stderr often has the real error from the gateway
  if (stderrClean) {
    // Look for known patterns in stderr
    if (/ECONNREFUSED/i.test(stderrClean)) {
      return "Gateway unreachable (ECONNREFUSED) — is the OpenClaw gateway running?";
    }
    if (/401|403|unauthorized|forbidden/i.test(stderrClean)) {
      return "Gateway authentication failed — check OPENCLAW_TOKEN";
    }
    if (/timeout|timed?\s*out/i.test(stderrClean)) {
      return `Gateway timeout — ${stderrClean.slice(0, 200)}`;
    }
    // Return stderr as-is (truncated) — it's usually more useful than err.message
    return stderrClean.length > 300 ? stderrClean.slice(0, 297) + "..." : stderrClean;
  }

  // Fallback: strip the "Command failed: openclaw agent -m <huge prompt>" noise
  const rawMsg = err.message ?? String(err);
  const cmdPrefix = "Command failed: ";
  if (rawMsg.startsWith(cmdPrefix)) {
    // err.message = "Command failed: openclaw agent -m <prompt...>\n<actual error>"
    // The actual error (if any) is after the first newline
    const newlineIdx = rawMsg.indexOf("\n");
    if (newlineIdx > 0) {
      const afterNewline = rawMsg.slice(newlineIdx + 1).trim();
      if (afterNewline) {
        return afterNewline.length > 300 ? afterNewline.slice(0, 297) + "..." : afterNewline;
      }
    }
    // No useful info after the command — generic message with exit code
    const exitCode = typeof err.code === "number" ? err.code : "unknown";
    return `openclaw agent exited with code ${exitCode}`;
  }

  return rawMsg.length > 300 ? rawMsg.slice(0, 297) + "..." : rawMsg;
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
  private systemPromptOverride: string | undefined;
  tasksProcessed = 0;
  onStreamChunk: StreamChunkCallback | undefined;
  onStreamDone: StreamDoneCallback | undefined;
  onTokenUsage: TokenUsageCallback | undefined;
  onReasoning: ReasoningCallback | undefined;
  private lastReasoning = "";

  constructor(options: { workerUrl?: string; authToken?: string | null; timeout?: number; workspacePath?: string; model?: string; botId?: string; systemPromptOverride?: string; onStreamChunk?: StreamChunkCallback; onStreamDone?: StreamDoneCallback; onTokenUsage?: TokenUsageCallback; onReasoning?: ReasoningCallback } = {}) {
    const baseWsUrl = (options.workerUrl ?? CONFIG.openclawWorkerUrl ?? "").trim();
    if (!baseWsUrl) {
      throw new Error("OPENCLAW_WORKER_URL is not configured. Run `teamclaw setup`.");
    }
    const token = (options.authToken ?? CONFIG.openclawToken ?? "").trim();
    this.botId = options.botId ?? "worker";
    // Normalize WebSocket URL - handle ws://, wss://, http://, https://
    if (baseWsUrl.startsWith("wss://")) {
      this.wsUrl = baseWsUrl;
    } else if (baseWsUrl.startsWith("ws://")) {
      this.wsUrl = baseWsUrl;
    } else if (baseWsUrl.startsWith("https://")) {
      this.wsUrl = baseWsUrl.replace(/^https:\/\//, "wss://");
    } else if (baseWsUrl.startsWith("http://")) {
      this.wsUrl = baseWsUrl.replace(/^http:\/\//, "ws://");
    } else {
      this.wsUrl = `ws://${baseWsUrl.replace(/\/$/, "")}`;
    }
    this.authToken = token;
    this.timeout = options.timeout ?? DEFAULT_TIMEOUT_MS;
    this.workspacePath = options.workspacePath ?? process.cwd();
    this.configuredModel = (options.model ?? CONFIG.openclawModel ?? "").trim();
    this.onStreamChunk = options.onStreamChunk;
    this.onStreamDone = options.onStreamDone;
    this.onTokenUsage = options.onTokenUsage;
    this.systemPromptOverride = options.systemPromptOverride;
    this.onReasoning = options.onReasoning;
    openclawEvents.emit("log", {
      id: `wa-${Date.now()}-init`,
      level: "info",
      source: "worker-adapter",
      action: "session_start",
      model: this.configuredModel || "default",
      botId: this.botId,
      message: `Adapter initialized for ${this.botId} (model: ${this.configuredModel || "default"})`,
      meta: { workspace: this.workspacePath, timeout: this.timeout },
      timestamp: Date.now(),
    });
    log(`UniversalOpenClawAdapter → model=${this.configuredModel || "default"} (workspace: ${this.workspacePath})`);
  }

  /**
   * Send a chat completion via `openclaw agent` CLI.
   * This handles auth, session management, and model routing internally.
   */
  private async chatComplete(
    messages: { role: string; content: string }[],
    _onChunk?: (chunk: string) => void,
    onDone?: (error?: { message: string }) => void,
    _onUsage?: (input: number, output: number) => void,
    signal?: AbortSignal
  ): Promise<string> {
    const model = this.configuredModel || resolveModelForAgent(this.botId || "worker");
    const timeoutSec = Math.ceil(this.timeout / 1000);
    const tokenUsageCb = _onUsage ?? this.onTokenUsage;
    const streamDone = onDone ?? this.onStreamDone;

    // Build the full prompt from messages
    const systemMsg = messages.find((m) => m.role === "system");
    const userMsg = messages[messages.length - 1].content;
    const thinkLevel = CONFIG.thinkingLevel || "off";
    const thinkPrefix = thinkLevel !== "off" ? `/think:${thinkLevel}\n` : "";
    const fullMessage = systemMsg
      ? `${systemMsg.content}\n\n---\n\n${thinkPrefix}${userMsg}`
      : `${thinkPrefix}${userMsg}`;
    this.lastReasoning = "";

    const sessionId = `teamclaw-${this.botId}-${Date.now()}`;
    openclawEvents.emit("log", {
      id: `wa-${Date.now()}-req`,
      level: "info",
      source: "worker-adapter",
      action: "request_start",
      model,
      botId: this.botId,
      message: `CLI request → ${model} (session: ${sessionId})`,
      meta: { sessionId, messageLength: fullMessage.length },
      timestamp: Date.now(),
    });
    log(`[openclaw] agent → session=${sessionId} model=${model} msgLen=${fullMessage.length}`);

    return new Promise((resolve, reject) => {
      if (signal?.aborted) {
        reject(new Error("Aborted"));
        return;
      }
      const startedAt = Date.now();

      const args = [
        "agent",
        "-m", fullMessage,
        "--session-id", sessionId,
        "--json",
        "--timeout", String(timeoutSec),
      ];
      if (thinkLevel !== "off") {
        args.push("--thinking", thinkLevel);
      }

      const child = execFile("openclaw", args, {
        maxBuffer: 10 * 1024 * 1024,
        timeout: this.timeout + 5000,
        signal: signal,
      }, (err, stdout, stderr) => {
        if (err) {
          if (err.name === "AbortError") {
            if (streamDone) streamDone({ message: "Aborted" });
            reject(new Error("Aborted"));
            return;
          }
          // Extract a meaningful error instead of echoing the full command
          const errMsg = classifyExecError(err, stderr);
          openclawEvents.emit("log", {
            id: `wa-${Date.now()}-err`,
            level: "error",
            source: "worker-adapter",
            action: "cli_error",
            model,
            botId: this.botId,
            message: `CLI error: ${errMsg}`,
            meta: { classifiedError: errMsg },
            timestamp: Date.now(),
          });
          log(`[openclaw] error: ${errMsg}`);
          // Surface gateway errors through the reasoning channel so they
          // appear on the dashboard and terminal even when no LLM response arrives
          if (this.onReasoning) {
            this.onReasoning(`[gateway error] ${errMsg}`);
          }
          if (streamDone) streamDone({ message: errMsg });
          reject(new Error(errMsg));
          return;
        }

        // stderr may contain fallback warnings — log them
        if (stderr?.trim()) {
          log(`[openclaw stderr] ${stderr.trim().slice(0, 500)}`);
        }

        try {
          const result = JSON.parse(stdout) as Record<string, unknown>;
          const status = result.status as string;
          if (status !== "ok") {
            const errMsg = String(result.error ?? result.summary ?? "Agent command failed");
            if (this.onReasoning) {
              this.onReasoning(`[gateway error] ${errMsg}`);
            }
            if (streamDone) streamDone({ message: errMsg });
            reject(new Error(errMsg));
            return;
          }

          // Extract text from payloads
          const resultObj = result.result as Record<string, unknown> | undefined;
          const payloads = resultObj?.payloads as Array<{ text?: string }> | undefined;
          const text = payloads?.map((p) => p.text ?? "").join("") ?? "";

          // Extract thinking/reasoning from <think> tags before stripping
          const thinkRegex = /<think>([\s\S]*?)<\/think>/gi;
          const thinkMatches: string[] = [];
          let thinkMatch: RegExpExecArray | null;
          while ((thinkMatch = thinkRegex.exec(text)) !== null) {
            const content = thinkMatch[1].trim();
            if (content) thinkMatches.push(content);
          }
          const cleanedText = text.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
          const reasoning = thinkMatches.join("\n\n");

          // Extract token usage
          const meta = resultObj?.meta as Record<string, unknown> | undefined;
          const agentMeta = meta?.agentMeta as Record<string, unknown> | undefined;
          if (agentMeta && tokenUsageCb) {
            const usage = agentMeta.usage as Record<string, unknown> | undefined;
            if (usage) {
              const input = (usage.input ?? 0) as number;
              const output = (usage.output ?? 0) as number;
              const cached = (usage.cacheRead ?? 0) as number;
              const usedModel = String(agentMeta.model ?? model);
              tokenUsageCb(input, output, cached, usedModel);
            }
          }

          // Fire reasoning callback — from <think> tags or agentMeta.thinking
          const metaThinking = (agentMeta?.thinking as string | undefined)?.trim();
          const finalReasoning = reasoning || metaThinking || "";
          if (finalReasoning) {
            this.lastReasoning = finalReasoning;
            if (this.onReasoning) {
              this.onReasoning(finalReasoning);
            }
          }

          openclawEvents.emit("log", {
            id: `wa-${Date.now()}-ok`,
            level: "success",
            source: "worker-adapter",
            action: "request_end",
            model: String(agentMeta?.model ?? model),
            botId: this.botId,
            message: `CLI response received (${cleanedText.length} chars)`,
            meta: {
              elapsedMs: Date.now() - startedAt,
              responseLength: cleanedText.length,
              ...(agentMeta?.usage ? { tokensUsed: agentMeta.usage } : {}),
            },
            timestamp: Date.now(),
          });
          if (streamDone) streamDone();
          resolve(cleanedText || "");
        } catch {
          // stdout wasn't JSON — might be raw text output
          const output = stdout.trim() || stderr.trim();
          if (output) {
            if (streamDone) streamDone();
            resolve(output);
          } else {
            if (streamDone) streamDone({ message: "Empty response from openclaw agent" });
            reject(new Error("Empty response from openclaw agent"));
          }
        }
      });

      // Stream stderr — emit structured logs so gateway warnings reach the dashboard
      child.stderr?.on("data", (data: Buffer) => {
        const text = data.toString().trim();
        if (text) {
          log(`[openclaw] ${text.slice(0, 300)}`);
          openclawEvents.emit("log", {
            id: `wa-${Date.now()}-stderr`,
            level: /error|fail|refused|timeout/i.test(text) ? "error" : "warn",
            source: "worker-adapter",
            action: "cli_stderr",
            model,
            botId: this.botId,
            message: text.slice(0, 300),
            meta: { raw: text.slice(0, 500) },
            timestamp: Date.now(),
          });
        }
      });
    });
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

  async complete(
    messages: { role: string; content: string }[],
    options?: { signal?: AbortSignal }
  ): Promise<string> {
    return this.chatComplete(messages, undefined, undefined, undefined, options?.signal);
  }

  async executeTask(task: TaskRequest, options?: { signal?: AbortSignal }): Promise<TaskResult> {
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
      const archDocPath = path.join(this.workspacePath, "docs", "ARCHITECTURE.md");
      const hasArchDoc = existsSync(archDocPath);
      const archBlock = hasArchDoc
        ? `\nCRITICAL: Before performing any task, you MUST read docs/ARCHITECTURE.md.\nYour code MUST strictly follow the architecture, folder structure, and tech stack\ndefined by the Tech Lead in docs/ARCHITECTURE.md.\n`
        : "";
      const basePrompt = this.systemPromptOverride
        ? `${this.systemPromptOverride}\n\nYou are working in a strictly defined workspace. Treat this workspace as your root directory.\nWORKSPACE PATH: ${this.workspacePath}\n${archBlock}`
        : `You are a helpful AI assistant (Maker/Software Engineer). Execute the given task and return the result.\nYou are working in a strictly defined workspace. Treat this workspace as your root directory.\nWORKSPACE PATH: ${this.workspacePath}\n${archBlock}`;
      const systemPrompt = `${basePrompt}
IMPORTANT: Do NOT create arbitrary subdirectories unless explicitly specified in the task.
Output files directly to the root of the provided workspace path unless the task explicitly requires a specific structure (like 'assets/' or 'src/components/').

OUTPUT FORMAT: For every file you create or modify, output it as a fenced code block with the filename on the opening fence line:

\`\`\`lang filename.ext
file content here
\`\`\`

Example:
\`\`\`javascript index.js
console.log("hello");
\`\`\`

This format is REQUIRED — your file outputs will be extracted and written to disk automatically.`;
      const messages = [
        { role: "system", content: systemPrompt },
        { role: "user", content: task.description },
      ];

      const output = await this.chatComplete(messages, undefined, undefined, undefined, options?.signal);
      this.tasksProcessed += 1;

      // Extract file blocks from LLM response and write them to the workspace
      let filesWritten: string[] = [];
      if (this.workspacePath) {
        const blocks = extractFileBlocks(output || "");
        if (blocks.length > 0) {
          filesWritten = await writeFileBlocks(blocks, this.workspacePath);
          if (filesWritten.length > 0) {
            log(`[worker] Wrote ${filesWritten.length} file(s) to workspace: ${filesWritten.join(", ")}`);
          }
        }
      }

      const summary = filesWritten.length > 0
        ? `\n\n---\nFiles written: ${filesWritten.join(", ")}`
        : "";

      return {
        task_id: task.task_id,
        success: true,
        output: (output || "Task completed") + summary,
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
  const url = resolveTargetUrl(bot, workerUrls, CONFIG.openclawWorkerUrl);
  return new UniversalOpenClawAdapter({ workerUrl: url, authToken: CONFIG.openclawToken, workspacePath, botId: bot.id, timeout: CONFIG.llmTimeoutMs });
}

export function createRoutingAdapters(
  bot: { id: string; worker_url?: string | null },
  workerUrls: Record<string, string> = {},
  workspacePath?: string
): { light: WorkerAdapter; heavy: WorkerAdapter | null } {
  const universal = createWorkerAdapter(bot, workerUrls, workspacePath);
  return { light: universal, heavy: universal };
}
