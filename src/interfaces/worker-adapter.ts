/**
 * WorkerAdapter - OpenClaw HTTP REST worker interface for TeamClaw.
 * Uses OpenAI-compatible HTTP API endpoint.
 */

import type { TaskRequest, TaskResult } from "../core/state.js";
import { CONFIG } from "../core/config.js";
import { logger } from "../core/logger.js";

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

const DEFAULT_TIMEOUT_MS = 120_000;

export class UniversalOpenClawAdapter implements WorkerAdapter {
  readonly adapterType: WorkerAdapterType = "openclaw";
  private baseUrl: string;
  private authToken: string | null;
  private timeout: number;
  private workspacePath: string;
  tasksProcessed = 0;

  constructor(options: { workerUrl?: string; authToken?: string | null; timeout?: number; workspacePath?: string } = {}) {
    let url = (options.workerUrl ?? CONFIG.openclawWorkerUrl ?? "").trim() || "http://127.0.0.1:18789";
    url = url.replace(/^ws:/i, "http:").replace(/^wss:/i, "https:").replace(/\/$/, "");
    this.baseUrl = url;
    this.authToken = options.authToken ?? (CONFIG.openclawToken || null);
    this.timeout = options.timeout ?? DEFAULT_TIMEOUT_MS;
    this.workspacePath = options.workspacePath ?? process.cwd();
    log(`UniversalOpenClawAdapter (HTTP) → ${this.baseUrl}/v1/chat/completions (workspace: ${this.workspacePath})`);
  }

  private async chatComplete(messages: { role: string; content: string }[]): Promise<string> {
    const model = CONFIG.openclawModel?.trim() || "github-copilot/gpt-5-mini";
    const url = `${this.baseUrl}/v1/chat/completions`;

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (this.authToken) {
      headers["Authorization"] = `Bearer ${this.authToken}`;
    }

    const response = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify({
        model,
        messages,
        stream: false,
      }),
      signal: AbortSignal.timeout(this.timeout),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`HTTP ${response.status}: ${error}`);
    }

    const data = await response.json() as {
      choices?: Array<{ message?: { content?: string } }>;
      error?: { message?: string };
    };

    if (data.error) {
      throw new Error(data.error.message || "Unknown API error");
    }

    return data.choices?.[0]?.message?.content || "";
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
    try {
      const systemPrompt = `You are a helpful AI assistant. Execute the given task and return the result.
You are confined to a strict workspace directory. Treat this workspace as your root directory.
WORKSPACE PATH: ${this.workspacePath}
All file operations (read, write, create, edit) MUST be performed within this directory.
Do not attempt to read or write files outside of it.`;
      const messages = [
        {
          role: "system",
          content: systemPrompt,
        },
        {
          role: "user",
          content: task.description,
        },
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
  return new UniversalOpenClawAdapter({ workerUrl: url, authToken: CONFIG.openclawToken, workspacePath });
}

export function createRoutingAdapters(
  bot: { id: string; worker_url?: string | null },
  workerUrls: Record<string, string> = {},
  workspacePath?: string
): { light: WorkerAdapter; heavy: WorkerAdapter | null } {
  const universal = createWorkerAdapter(bot, workerUrls, workspacePath);
  return { light: universal, heavy: universal };
}
