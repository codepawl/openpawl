/**
 * Slack Block Kit formatter for approval requests.
 */

import type { ApprovalWebhookPayload, WebhookApprovalConfig } from "./types.js";

/** Inline type — was from the deleted agents/partial-approval module. */
interface PartialApprovalTask {
  task_id: string;
  description: string;
  assigned_to: string;
  confidence_score: number;
  rework_count: number;
}

interface SlackBlock {
  type: string;
  text?: { type: string; text: string; emoji?: boolean };
  elements?: SlackBlock[];
  url?: string;
  style?: string;
  action_id?: string;
}

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max - 3) + "..." : s;
}

function taskSection(task: PartialApprovalTask, payload: ApprovalWebhookPayload): SlackBlock[] {
  const confidence = task.confidence_score !== null
    ? `${Math.round(task.confidence_score * 100)}%`
    : "N/A";

  const reworkLabel = task.rework_count > 0 ? ` | Reworks: ${task.rework_count}` : "";

  return [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*${truncate(task.description, 200)}*\nAgent: \`${task.assigned_to}\` | Confidence: ${confidence}${reworkLabel}`,
      },
    },
    {
      type: "actions",
      elements: [
        {
          type: "button",
          text: { type: "plain_text", text: "Approve", emoji: true },
          style: "primary",
          url: `${payload.callbackUrl.replace("/webhook/approval", "/webhook/approval/respond")}?token=${encodeURIComponent(payload.approveToken)}`,
          action_id: `approve_${payload.taskId}`,
        },
        {
          type: "button",
          text: { type: "plain_text", text: "Reject", emoji: true },
          style: "danger",
          url: `${payload.callbackUrl.replace("/webhook/approval", "/webhook/approval/respond")}?token=${encodeURIComponent(payload.rejectToken)}`,
          action_id: `reject_${payload.taskId}`,
        },
        {
          type: "button",
          text: { type: "plain_text", text: "Escalate", emoji: true },
          url: `${payload.callbackUrl.replace("/webhook/approval", "/webhook/approval/respond")}?token=${encodeURIComponent(payload.escalateToken)}`,
          action_id: `escalate_${payload.taskId}`,
        },
      ],
    },
    { type: "divider" },
  ];
}

export function formatSlackApprovalBatch(
  tasks: PartialApprovalTask[],
  payloads: ApprovalWebhookPayload[],
  config: WebhookApprovalConfig,
): Record<string, unknown> {
  const blocks: SlackBlock[] = [
    {
      type: "header",
      text: {
        type: "plain_text",
        text: `OpenPawl needs approval (${tasks.length} task${tasks.length > 1 ? "s" : ""})`,
        emoji: true,
      },
    },
    {
      type: "context",
      elements: [
        {
          type: "mrkdwn",
          text: `Session: \`${config.sessionId.slice(0, 8)}\` | Expires: <!date^${Math.floor(payloads[0].expiresAt / 1000)}^{time}|${new Date(payloads[0].expiresAt).toISOString()}>`,
        } as unknown as SlackBlock,
      ],
    },
  ];

  for (let i = 0; i < tasks.length; i++) {
    blocks.push(...taskSection(tasks[i], payloads[i]));
  }

  return { blocks };
}
