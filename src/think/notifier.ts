/**
 * Notification delivery for completed async think jobs.
 * Reuses deliverWebhook() from webhook/delivery.ts.
 */

import type { AsyncThinkJob } from "./async-types.js";
import { AsyncThinkJobStore } from "./job-store.js";
import { ICONS } from "../tui/constants/icons.js";

interface SlackBlock {
  type: string;
  text?: { type: string; text: string; emoji?: boolean };
  elements?: Array<{ type: string; text: string }>;
}

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max - 3) + "..." : s;
}

export function formatSlackThinkResult(job: AsyncThinkJob): Record<string, unknown> {
  const rec = job.result?.recommendation;
  const durationMs = (job.completedAt ?? 0) - (job.startedAt ?? job.createdAt);
  const durationSec = Math.round(durationMs / 1000);

  const blocks: SlackBlock[] = [
    {
      type: "header",
      text: {
        type: "plain_text",
        text: "OpenPawl finished thinking",
        emoji: true,
      },
    },
    {
      type: "context",
      elements: [
        { type: "mrkdwn", text: `Job: \`${job.id}\` | Duration: ${durationSec}s` },
      ],
    },
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*${truncate(job.question, 200)}*`,
      },
    },
  ];

  if (rec) {
    const confidence = `${Math.round(rec.confidence * 100)}%`;
    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*Recommendation:* ${rec.choice}\n*Confidence:* ${confidence}\n${truncate(rec.reasoning, 300)}`,
      },
    });

    const pros = rec.tradeoffs.pros.map((p) => `${ICONS.success} ${truncate(p, 80)}`).join("\n");
    const cons = rec.tradeoffs.cons.map((c) => `${ICONS.error} ${truncate(c, 80)}`).join("\n");
    if (pros || cons) {
      blocks.push({
        type: "section",
        text: {
          type: "mrkdwn",
          text: `${pros ? pros + "\n" : ""}${cons}`,
        },
      });
    }
  }

  return { blocks };
}

export function buildThinkWebhookPayload(job: AsyncThinkJob): Record<string, unknown> {
  const rec = job.result?.recommendation;
  return {
    event: "think_complete",
    jobId: job.id,
    question: job.question,
    recommendation: rec?.choice ?? null,
    confidence: rec?.confidence ?? null,
    completedAt: job.completedAt,
    durationMs: (job.completedAt ?? 0) - (job.startedAt ?? job.createdAt),
  };
}

export async function notifyCompletion(job: AsyncThinkJob): Promise<void> {
  const { readGlobalConfigWithDefaults } = await import("../core/global-config.js");
  const config = readGlobalConfigWithDefaults();

  const url = config.webhookApproval?.url;
  const secret = config.webhookApproval?.secret;
  if (!url || !secret) return;

  const provider = config.webhookApproval?.provider ?? "generic";
  const payload =
    provider === "slack"
      ? formatSlackThinkResult(job)
      : buildThinkWebhookPayload(job);

  const retryAttempts = config.webhookApproval?.retryAttempts ?? 3;
  const { deliverWebhook } = await import("../webhook/delivery.js");
  await deliverWebhook(url, secret, payload, retryAttempts);

  // Mark notification sent
  const store = new AsyncThinkJobStore();
  const current = store.get(job.id);
  if (current) {
    current.notificationSent = true;
    store.save(current);
  }
}
