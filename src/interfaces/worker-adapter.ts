/**
 * WorkerAdapter - OpenClaw-only worker interface for TeamClaw.
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

const MAX_RETRIES = 3;
const DEFAULT_TIMEOUT_MS = 120_000;

export class UniversalOpenClawAdapter implements WorkerAdapter {
  readonly adapterType: WorkerAdapterType = "openclaw";
  readonly workerUrl: string;
  private readonly authToken: string | null;
  private readonly timeout: number;
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
      const headers: Record<string, string> = {};
      if (this.authToken) headers.Authorization = `Bearer ${this.authToken}`;
      const res = await fetch(`${this.workerUrl}/health`, {
        method: "GET",
        headers,
        signal: AbortSignal.timeout(5000),
      });
      return res.ok;
    } catch (err) {
      log(`OpenClaw health check failed: ${err}`);
      return false;
    }
  }

  async executeTask(task: TaskRequest): Promise<TaskResult> {
    const payload = {
      task_id: task.task_id,
      description: task.description,
      priority: task.priority,
      estimated_cost: task.estimated_cost ?? 0,
    };

    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (this.authToken) headers["Authorization"] = `Bearer ${this.authToken}`;

    let lastErr: Error | null = null;
    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      try {
        const ctrl = new AbortController();
        const timeout = setTimeout(() => ctrl.abort(), this.timeout);

        const res = await fetch(`${this.workerUrl}/execute`, {
          method: "POST",
          headers,
          body: JSON.stringify(payload),
          signal: ctrl.signal,
        });
        clearTimeout(timeout);

        if (!res.ok) throw new Error(`HTTP ${res.status}`);

        const data = (await res.json()) as {
          task_id: string;
          success: boolean;
          output: string;
          quality_score?: number;
        };

        this.tasksProcessed += 1;
        return {
          task_id: data.task_id,
          success: data.success,
          output: data.output,
          quality_score: data.quality_score ?? 0.5,
        };
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
      const headers: Record<string, string> = {};
      if (this.authToken) headers.Authorization = `Bearer ${this.authToken}`;
      const res = await fetch(`${this.workerUrl}/health`, { headers });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return (await res.json()) as Record<string, unknown>;
    } catch (err) {
      return { status: "unreachable", error: String(err) };
    }
  }

  async reset(): Promise<void> {
    try {
      const headers: Record<string, string> = {};
      if (this.authToken) headers.Authorization = `Bearer ${this.authToken}`;
      const res = await fetch(`${this.workerUrl}/reset`, { method: "POST", headers });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
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
