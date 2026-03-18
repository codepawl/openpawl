/**
 * WorkerAdapter — LLM interface for TeamClaw agent tasks.
 * Uses ProviderManager for LLM completions (no external binary needed).
 */

import type { TaskRequest, TaskResult } from "../core/state.js";
import { CONFIG } from "../core/config.js";
import { logger, isDebugMode } from "../core/logger.js";
import { getTrafficController } from "../core/traffic-control.js";
import { resolveModelForAgent } from "../core/model-config.js";
import { extractFileBlocks, writeFileBlocks } from "../utils/file-block-parser.js";
import { existsSync } from "node:fs";
import path from "node:path";

import { llmEvents } from "../core/llm-events.js";
import { isMockLlmEnabled, generateMockResponse } from "../core/mock-llm.js";
import { getGlobalProviderManager } from "../providers/provider-factory.js";

export type WorkerAdapterType = "provider";

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

function log(msg: string): void {
  if (isDebugMode()) {
    logger.agent(msg);
  }
}

const DEFAULT_TIMEOUT_MS = 120_000;

export class UniversalWorkerAdapter implements WorkerAdapter {
  readonly adapterType: WorkerAdapterType = "provider";
  private timeout: number;
  private workspacePath: string;
  private configuredModel: string;
  private botId: string;
  private systemPromptOverride: string | undefined;
  tasksProcessed = 0;
  onStreamChunk: StreamChunkCallback | undefined;
  onStreamDone: StreamDoneCallback | undefined;
  onTokenUsage: TokenUsageCallback | undefined;
  onReasoning: ReasoningCallback | undefined;
  private lastReasoning = "";

  constructor(options: {
    timeout?: number;
    workspacePath?: string;
    model?: string;
    botId?: string;
    systemPromptOverride?: string;
    onStreamChunk?: StreamChunkCallback;
    onStreamDone?: StreamDoneCallback;
    onTokenUsage?: TokenUsageCallback;
    onReasoning?: ReasoningCallback;
  } = {}) {
    this.botId = options.botId ?? "worker";
    this.timeout = options.timeout ?? DEFAULT_TIMEOUT_MS;
    this.workspacePath = options.workspacePath ?? process.cwd();
    this.configuredModel = (options.model ?? "").trim();
    this.onStreamChunk = options.onStreamChunk;
    this.onStreamDone = options.onStreamDone;
    this.onTokenUsage = options.onTokenUsage;
    this.systemPromptOverride = options.systemPromptOverride;
    this.onReasoning = options.onReasoning;
    llmEvents.emit("log", {
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
    log(`UniversalWorkerAdapter → model=${this.configuredModel || "default"} (workspace: ${this.workspacePath})`);
  }

  private async chatComplete(
    messages: { role: string; content: string }[],
    _onChunk?: (chunk: string) => void,
    onDone?: (error?: { message: string }) => void,
    _onUsage?: (input: number, output: number) => void,
    signal?: AbortSignal
  ): Promise<string> {
    const model = this.configuredModel || resolveModelForAgent(this.botId || "worker");
    const tokenUsageCb = _onUsage ?? this.onTokenUsage;
    const streamDone = onDone ?? this.onStreamDone;

    const systemMsg = messages.find((m) => m.role === "system");
    const userMsg = messages[messages.length - 1]!.content;
    this.lastReasoning = "";

    const requestId = `wa-${Date.now()}-req`;
    llmEvents.emit("log", {
      id: requestId,
      level: "info",
      source: "worker-adapter",
      action: "request_start",
      model,
      botId: this.botId,
      message: `LLM request → ${model}`,
      meta: { messageLength: userMsg.length },
      timestamp: Date.now(),
    });
    log(`[provider] generate → model=${model} msgLen=${userMsg.length}`);

    // Mock LLM mode
    if (isMockLlmEnabled()) {
      const mockText = generateMockResponse(userMsg, this.botId);
      if (tokenUsageCb) tokenUsageCb(500, 200, 0, "mock-model");
      llmEvents.emit("log", {
        id: `wa-${Date.now()}-mock`,
        level: "success",
        source: "worker-adapter",
        action: "mock_response",
        model: "mock-model",
        botId: this.botId,
        message: `[mock] Response generated (${mockText.length} chars)`,
        meta: { mock: true, responseLength: mockText.length },
        timestamp: Date.now(),
      });
      if (streamDone) streamDone();
      return mockText;
    }

    const startedAt = Date.now();

    try {
      if (signal?.aborted) throw new Error("Aborted");

      const mgr = getGlobalProviderManager();
      const timeoutSignal = AbortSignal.timeout(this.timeout);
      const combinedSignal = signal
        ? AbortSignal.any([signal, timeoutSignal])
        : timeoutSignal;

      const result = await mgr.generate(userMsg, {
        model: model || undefined,
        systemPrompt: systemMsg?.content,
        signal: combinedSignal,
      });

      const text = result.text;

      // Extract thinking/reasoning from <think> tags
      const thinkRegex = /<think>([\s\S]*?)<\/think>/gi;
      const thinkMatches: string[] = [];
      let thinkMatch: RegExpExecArray | null;
      while ((thinkMatch = thinkRegex.exec(text)) !== null) {
        const content = thinkMatch[1]!.trim();
        if (content) thinkMatches.push(content);
      }
      const cleanedText = text.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
      const reasoning = thinkMatches.join("\n\n");

      // Token usage callback
      if (result.usage && tokenUsageCb) {
        tokenUsageCb(result.usage.promptTokens, result.usage.completionTokens, 0, model);
      }

      // Fire reasoning callback
      if (reasoning) {
        this.lastReasoning = reasoning;
        if (this.onReasoning) {
          this.onReasoning(reasoning);
        }
      }

      llmEvents.emit("log", {
        id: `wa-${Date.now()}-ok`,
        level: "success",
        source: "worker-adapter",
        action: "request_end",
        model,
        botId: this.botId,
        message: `LLM response received (${cleanedText.length} chars)`,
        meta: {
          elapsedMs: Date.now() - startedAt,
          responseLength: cleanedText.length,
          ...(result.usage ? { tokensUsed: result.usage } : {}),
        },
        timestamp: Date.now(),
      });
      if (streamDone) streamDone();
      return cleanedText || "";
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      llmEvents.emit("log", {
        id: `wa-${Date.now()}-err`,
        level: "error",
        source: "worker-adapter",
        action: "provider_error",
        model,
        botId: this.botId,
        message: `Provider error: ${errMsg}`,
        meta: { elapsedMs: Date.now() - startedAt },
        timestamp: Date.now(),
      });
      log(`[provider] error: ${errMsg}`);
      if (this.onReasoning) {
        this.onReasoning(`[provider error] ${errMsg}`);
      }
      if (streamDone) streamDone({ message: errMsg });
      throw new Error(errMsg);
    }
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
    log("UniversalWorkerAdapter reset");
  }
}

// Backward-compat aliases
export const OpenClawAdapter = UniversalWorkerAdapter;
export const UniversalOpenClawAdapter = UniversalWorkerAdapter;

function normalizeWorkerKey(input: string): string {
  return input.trim().toLowerCase().replace(/[\s_-]+/g, "");
}

/** Resolve worker URL for a bot from workerUrls map. */
export function resolveTargetUrl(
  bot: { id: string; name?: string; role_id?: string; worker_url?: string | null; traits?: Record<string, unknown> },
  workerUrls: Record<string, string> = {},
  fallbackUrl = "",
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

export function createWorkerAdapter(
  bot: { id: string; name?: string; role_id?: string; worker_url?: string | null; traits?: Record<string, unknown> },
  _workerUrls: Record<string, string> = {},
  workspacePath?: string
): WorkerAdapter {
  return new UniversalWorkerAdapter({ workspacePath, botId: bot.id, timeout: CONFIG.llmTimeoutMs });
}

export function createRoutingAdapters(
  bot: { id: string; worker_url?: string | null },
  workerUrls: Record<string, string> = {},
  workspacePath?: string
): { light: WorkerAdapter; heavy: WorkerAdapter | null } {
  const universal = createWorkerAdapter(bot, workerUrls, workspacePath);
  return { light: universal, heavy: universal };
}
