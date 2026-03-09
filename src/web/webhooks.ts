/**
 * Webhook notifications for TaskClaw.
 * Fires on task completion and cycle end; supports Discord, Slack, Telegram.
 */

import { CONFIG } from "../core/config.js";
import { logger } from "../core/logger.js";

export interface TaskCompletePayload {
  task_id: string;
  success: boolean;
  output?: string;
  quality_score?: number;
  assigned_to?: string;
  description?: string;
  bot_id?: string;
}

export interface CycleEndPayload {
  cycle: number;
  max_cycles: number;
  tasks_completed: number;
  tasks_failed: number;
}

async function postWebhook(
  url: string,
  payload: Record<string, unknown>
): Promise<void> {
  if (!url?.trim()) return;
  const body = JSON.stringify(payload);
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (CONFIG.webhookSecret?.trim()) {
    headers["X-Webhook-Signature"] = CONFIG.webhookSecret;
  }
  try {
    const res = await fetch(url, {
      method: "POST",
      headers,
      body,
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) {
      logger.warn(`Webhook POST ${url} failed: ${res.status}`);
    }
  } catch (err) {
    logger.warn(`Webhook ${url}: ${err}`);
  }
}

export async function fireTaskCompleteWebhook(
  payload: TaskCompletePayload
): Promise<void> {
  const url = CONFIG.webhookOnTaskComplete?.trim();
  if (!url) return;
  await postWebhook(url, {
    event: "task_complete",
    ...payload,
    timestamp: new Date().toISOString(),
  });
}

export async function fireCycleEndWebhook(
  payload: CycleEndPayload
): Promise<void> {
  const url = CONFIG.webhookOnCycleEnd?.trim();
  if (!url) return;
  await postWebhook(url, {
    event: "cycle_end",
    ...payload,
    timestamp: new Date().toISOString(),
  });
}
