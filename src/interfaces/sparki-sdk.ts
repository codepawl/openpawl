/**
 * Sparki SDK - Legacy abstraction for AI agent integration.
 * Prefer WorkerAdapter from worker-adapter.ts for new code.
 * MockSparki/RealSparki retained for backward compatibility.
 */

import type { TaskRequest, TaskResult } from "../core/state.js";
import { CONFIG, getSessionTemperature } from "../core/config.js";
import { generate, getEffectiveModel } from "../core/llm-client.js";
import { createWorkerAdapter } from "./worker-adapter.js";
import { logger } from "../core/logger.js";

function log(msg: string): void {
  if (CONFIG.verboseLogging) {
    logger.agent(msg);
  }
}

export interface SparkiInterface {
  executeTask(task: TaskRequest): Promise<TaskResult>;
  getStatus(): Promise<Record<string, unknown>>;
  reset(): Promise<void>;
}

export class MockSparki implements SparkiInterface {
  readonly agentId: string;
  tasksProcessed = 0;
  private llmAvailable = false;

  constructor(agentId = "sparki-001") {
    this.agentId = agentId;
    this.llmAvailable = true;
    log(`🤖 MockSparki '${agentId}' initialized (Sprint 1 Mode)`);
  }

  async executeTask(task: TaskRequest): Promise<TaskResult> {
    log(`🔧 Sparki executing task: ${task.task_id}`);
    this.tasksProcessed += 1;

    let plan: string;
    let quality: number;
    let success: boolean;

    try {
      plan = await this._generatePlanWithLlm(task);
      if (!plan) {
        plan = this._getFallbackPlan(task);
        quality = 0.5;
        success = true;
      } else {
        quality = this._estimateQuality(plan);
        success = quality > 0.3;
      }
    } catch (err) {
      log(`⚠️ LLM unavailable: ${err}. Using fallback.`);
      this.llmAvailable = false;
      plan = this._getFallbackPlan(task);
      quality = 0.5;
      success = true;
    }

    log(`${success ? "✅" : "❌"} Task ${task.task_id} completed (Quality: ${quality.toFixed(2)})`);
    return {
      task_id: task.task_id,
      success,
      output: plan,
      quality_score: quality,
    };
  }

  private async _generatePlanWithLlm(task: TaskRequest): Promise<string> {
    const prompt = `You are a software developer AI agent working in a team.

Task ID: ${task.task_id}
Priority: ${task.priority}
Description: ${task.description}

Generate a concise development plan (3-5 bullet points) explaining how you would implement this.
Focus on technical approach, not actual code. Be specific and practical.

Development Plan:`;
    try {
      return await generate(prompt, { temperature: getSessionTemperature() });
    } catch (err) {
      this.llmAvailable = false;
      throw err;
    }
  }

  private _getFallbackPlan(task: TaskRequest): string {
    return `Development Plan for: ${task.description}

1. Analyze requirements and define scope
2. Design architecture and select appropriate technologies
3. Implement core functionality with unit tests
4. Integrate with existing systems
5. Perform quality assurance and documentation

Status: Ready for implementation (Mock Mode)`;
  }

  private _estimateQuality(plan: string): number {
    if (!plan || plan.length < 50) return 0.2;
    let quality = 0.5;
    if (/[12]\.|-|\*/.test(plan)) quality += 0.2;
    if (plan.length > 200) quality += 0.1;
    if (plan.length > 400) quality += 0.2;
    return Math.min(quality, 1);
  }

  async getStatus(): Promise<Record<string, unknown>> {
    return {
      agent_id: this.agentId,
      type: "MockSparki",
      tasks_processed: this.tasksProcessed,
      llm_available: this.llmAvailable,
      model: this.llmAvailable ? getEffectiveModel() : "fallback",
    };
  }

  async reset(): Promise<void> {
    this.tasksProcessed = 0;
    log(`🔄 Sparki '${this.agentId}' reset`);
  }
}

const MAX_RETRIES = 3;
const DEFAULT_TIMEOUT_MS = 120_000;

export class RealSparki implements SparkiInterface {
  readonly workerUrl: string;
  private readonly authToken: string | null;
  private readonly timeout: number;
  tasksProcessed = 0;

  constructor(
    options: {
      workerUrl?: string;
      authToken?: string | null;
      timeout?: number;
    } = {}
  ) {
    this.workerUrl = (options.workerUrl ?? "http://localhost:8001").replace(/\/$/, "");
    this.authToken = options.authToken ?? null;
    this.timeout = options.timeout ?? DEFAULT_TIMEOUT_MS;
    log(`🤖 RealSparki initialized → ${this.workerUrl}`);
  }

  async executeTask(task: TaskRequest): Promise<TaskResult> {
    const payload = {
      task_id: task.task_id,
      description: task.description,
      priority: task.priority,
      estimated_cost: task.estimated_cost ?? 0,
    };

    let lastErr: Error | null = null;
    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      try {
        const headers: Record<string, string> = { "Content-Type": "application/json" };
        if (this.authToken) headers["Authorization"] = `Bearer ${this.authToken}`;

        const ctrl = new AbortController();
        const timeout = setTimeout(() => ctrl.abort(), this.timeout);

        const res = await fetch(`${this.workerUrl}/execute`, {
          method: "POST",
          headers,
          body: JSON.stringify(payload),
          signal: ctrl.signal,
        });
        clearTimeout(timeout);

        if (!res.ok) {
          throw new Error(`HTTP ${res.status}`);
        }

        const data = (await res.json()) as {
          task_id: string;
          success: boolean;
          output: string;
          quality_score?: number;
        };

        this.tasksProcessed += 1;
        log(`${data.success ? "✅" : "❌"} Worker returned: ${data.task_id}`);
        return {
          task_id: data.task_id,
          success: data.success,
          output: data.output,
          quality_score: data.quality_score ?? 0.5,
        };
      } catch (err) {
        lastErr = err instanceof Error ? err : new Error(String(err));
        log(`⚠️ Worker connection failed (attempt ${attempt}/${MAX_RETRIES}): ${lastErr.message}`);
      }
    }

    log("💀 Worker unreachable after retries");
    return {
      task_id: task.task_id,
      success: false,
      output: `Worker communication failed: ${lastErr}`,
      quality_score: 0,
    };
  }

  async getStatus(): Promise<Record<string, unknown>> {
    try {
      const res = await fetch(`${this.workerUrl}/health`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return (await res.json()) as Record<string, unknown>;
    } catch (err) {
      log(`❌ Worker health check failed: ${err}`);
      return { status: "unreachable", error: String(err) };
    }
  }

  async reset(): Promise<void> {
    try {
      const res = await fetch(`${this.workerUrl}/reset`, { method: "POST" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      this.tasksProcessed = 0;
      log("🔄 Worker state reset");
    } catch (err) {
      log(`❌ Worker reset failed: ${err}`);
    }
  }
}

export function createSparkiForBot(
  bot: { id: string; worker_url?: string | null },
  workerUrls: Record<string, string> = {}
): SparkiInterface {
  return createWorkerAdapter(bot, workerUrls) as unknown as SparkiInterface;
}
