/**
 * Outbound webhook POST with HMAC signing and retry.
 */

import { computeHmacSignature, type TokenManager } from "./tokens.js";
import type {
  WebhookApprovalConfig,
  ApprovalWebhookPayload,
} from "./types.js";

/** Inline type — was from the deleted agents/partial-approval module. */
interface PartialApprovalTask {
  task_id: string;
  description: string;
  assigned_to: string;
  confidence_score: number;
  rework_count: number;
}

export interface DeliveryResult {
  ok: boolean;
  statusCode?: number;
  error?: string;
  attempts: number;
}

export async function deliverWebhook(
  url: string,
  secret: string,
  payload: Record<string, unknown>,
  retryAttempts: number,
): Promise<DeliveryResult> {
  const body = JSON.stringify(payload);
  const signature = `sha256=${computeHmacSignature(secret, body)}`;

  for (let attempt = 1; attempt <= retryAttempts; attempt++) {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Webhook-Signature": signature,
        },
        body,
        signal: AbortSignal.timeout(10_000),
      });

      if (res.ok) {
        return { ok: true, statusCode: res.status, attempts: attempt };
      }

      if (res.status >= 400 && res.status < 500) {
        return { ok: false, statusCode: res.status, error: `HTTP ${res.status}`, attempts: attempt };
      }

      // Server error — retry
    } catch (err) {
      if (attempt === retryAttempts) {
        return { ok: false, error: String(err), attempts: attempt };
      }
    }

    // Exponential backoff: 1s, 2s, 4s...
    await new Promise((r) => setTimeout(r, 1000 * Math.pow(2, attempt - 1)));
  }

  return { ok: false, error: "Max retries exhausted", attempts: retryAttempts };
}

export function buildApprovalPayload(
  config: WebhookApprovalConfig,
  task: PartialApprovalTask,
  tokenManager: TokenManager,
): ApprovalWebhookPayload {
  const expiresAt = Date.now() + config.timeoutSeconds * 1000;

  const makeToken = (action: "approve" | "reject" | "escalate") =>
    tokenManager.sign({
      taskId: task.task_id,
      action,
      sessionId: config.sessionId,
      expiresAt,
    });

  const resultPreview = task.description.slice(0, 500);

  return {
    event: "approval_request",
    sessionId: config.sessionId,
    taskId: task.task_id,
    task: {
      description: task.description,
      assignedTo: task.assigned_to,
      confidence: task.confidence_score,
      resultPreview,
      reworkCount: task.rework_count,
    },
    callbackUrl: `${config.callbackBaseUrl}/webhook/approval`,
    expiresAt,
    approveToken: makeToken("approve"),
    rejectToken: makeToken("reject"),
    escalateToken: makeToken("escalate"),
  };
}

export async function deliverApprovalRequest(
  config: WebhookApprovalConfig,
  task: PartialApprovalTask,
  tokenManager: TokenManager,
): Promise<{ payload: ApprovalWebhookPayload; result: DeliveryResult }> {
  const payload = buildApprovalPayload(config, task, tokenManager);
  const result = await deliverWebhook(
    config.url,
    config.secret,
    payload as unknown as Record<string, unknown>,
    config.retryAttempts,
  );
  return { payload, result };
}

export async function deliverTimeoutNotification(
  config: WebhookApprovalConfig,
  taskId: string,
): Promise<DeliveryResult> {
  return deliverWebhook(
    config.url,
    config.secret,
    {
      event: "approval_timeout",
      sessionId: config.sessionId,
      taskId,
      timestamp: new Date().toISOString(),
    },
    1, // single attempt for timeout notifications
  );
}
