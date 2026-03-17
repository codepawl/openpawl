/**
 * Confidence Router Node — sits between worker_task and worker_collect.
 * Parses confidence from raw output, determines routing, and overrides task status.
 * Pass-through when confidence scoring is disabled or no confidence block is present.
 */

import type { GraphState } from "../../core/graph-state.js";
import type { BotDefinition } from "../../core/bot-definitions.js";
import type { ConfidenceThresholds } from "../confidence/types.js";
import { DEFAULT_CONFIDENCE_THRESHOLDS } from "../confidence/types.js";
import { parseConfidence } from "../confidence/parser.js";
import { getRoutingDecision, mapRoutingToStatus } from "../confidence/router.js";
import { logger, isDebugMode } from "../../core/logger.js";
import { detectPushback } from "../../personality/pushback.js";
import { CONFIG } from "../../core/config.js";

function log(msg: string): void {
  if (isDebugMode()) {
    logger.agent(msg);
  }
}

export interface ConfidenceRouterOptions {
  thresholds?: Partial<ConfidenceThresholds>;
  team?: BotDefinition[];
}

export function createConfidenceRouterNode(
  options: ConfidenceRouterOptions = {},
): (state: GraphState) => Partial<GraphState> {
  const thresholds: ConfidenceThresholds = {
    ...DEFAULT_CONFIDENCE_THRESHOLDS,
    ...options.thresholds,
  };
  const hasReviewer = options.team
    ? options.team.some((b) => b.role_id === "qa_reviewer")
    : false;
  const makerBotId = options.team
    ? options.team.find((b) => b.role_id === "software_engineer")?.id ?? null
    : null;

  return (state: GraphState): Partial<GraphState> => {
    const taskItem = state._send_task;

    if (!taskItem) {
      return { __node__: "confidence_router" };
    }

    const taskId = (taskItem.task_id as string) ?? "?";
    const currentStatus = (taskItem.status as string) ?? "pending";
    const result = taskItem.result as Record<string, unknown> | null;
    const retryCount = (taskItem.retry_count as number) ?? 0;
    const maxRetries = (taskItem.max_retries as number) ?? 2;

    // No result or no output — pass-through
    if (!result || typeof result.output !== "string") {
      return { __node__: "confidence_router" };
    }

    const rawOutput = result.output as string;
    const { confidence, cleanedOutput } = parseConfidence(rawOutput);

    // If no confidence block was in the output (default score 0.5 with "No confidence block provided"),
    // treat as pass-through — don't override routing
    if (confidence.reasoning === "No confidence block provided") {
      return { __node__: "confidence_router" };
    }

    // Personality pushback: reduce confidence score based on trigger severity
    if (CONFIG.personalityEnabled && CONFIG.personalityPushbackEnabled) {
      const assignedTo = (taskItem.assigned_to as string) ?? "";
      const assignedRole = options.team
        ? options.team.find((b) => b.id === assignedTo)?.role_id ?? ""
        : "";
      if (assignedRole) {
        const pushback = detectPushback(rawOutput, assignedRole);
        if (pushback.triggered) {
          if (pushback.severity === "block") {
            confidence.score = Math.max(0, confidence.score - 0.2);
          } else if (pushback.severity === "warn") {
            confidence.score = Math.max(0, confidence.score - 0.1);
          }
          log(`[confidence_router] pushback: ${pushback.severity} — ${pushback.response}`);
        }
      }
    }

    log(`[confidence_router] ${taskId}: score=${confidence.score.toFixed(2)}, flags=[${confidence.flags.join(",")}]`);

    // Determine routing
    let routingDecision = getRoutingDecision(confidence.score, thresholds);

    // Special handling for QA reviews: use QA confidence to decide outcome
    if (currentStatus === "reviewing") {
      if (confidence.score >= thresholds.autoApprove) {
        routingDecision = "auto_approved";
      } else {
        routingDecision = "rework";
      }
    }

    // Enforce max rework cycles: escalate if retries exhausted
    if (routingDecision === "rework" && retryCount >= maxRetries) {
      log(`[confidence_router] ${taskId}: max retries (${maxRetries}) reached, escalating`);
      routingDecision = "escalated";
    }

    // Map routing to task status
    const newStatus = mapRoutingToStatus(routingDecision, hasReviewer);

    // Build updated task
    const updatedTask: Record<string, unknown> = {
      ...taskItem,
      status: newStatus,
      result: {
        ...result,
        output: cleanedOutput,
        confidence: {
          score: confidence.score,
          reasoning: confidence.reasoning,
          flags: confidence.flags,
        },
        routing_decision: routingDecision,
      },
    };

    // If rework, assign back to maker
    if (routingDecision === "rework" && makerBotId) {
      updatedTask.assigned_to = makerBotId;
    }

    // Build confidence history entry
    const historyEntry = {
      task_id: taskId,
      score: confidence.score,
      reasoning: confidence.reasoning,
      flags: confidence.flags,
      routing_decision: routingDecision,
      status_before: currentStatus,
      status_after: newStatus,
      timestamp: new Date().toISOString(),
    };

    log(`[confidence_router] ${taskId}: ${currentStatus} → ${newStatus} (${routingDecision})`);

    return {
      task_queue: [updatedTask],
      confidence_history: [historyEntry],
      __node__: "confidence_router",
    };
  };
}
