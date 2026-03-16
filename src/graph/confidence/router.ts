/**
 * Routing decision logic for confidence scores.
 */

import type { ConfidenceThresholds, RoutingDecision } from "./types.js";
import { DEFAULT_CONFIDENCE_THRESHOLDS } from "./types.js";

/**
 * Determine routing based on confidence score and thresholds.
 */
export function getRoutingDecision(
  score: number,
  thresholds: ConfidenceThresholds = DEFAULT_CONFIDENCE_THRESHOLDS,
): RoutingDecision {
  if (score >= thresholds.autoApprove) return "auto_approved";
  if (score >= thresholds.reviewRequired) return "qa_review";
  if (score >= thresholds.reworkRequired) return "rework";
  return "escalated";
}

/**
 * Map a routing decision to the appropriate task status string.
 */
export function mapRoutingToStatus(
  decision: RoutingDecision,
  hasReviewer: boolean,
): string {
  switch (decision) {
    case "auto_approved":
      return "waiting_for_human";
    case "qa_review":
      return hasReviewer ? "reviewing" : "waiting_for_human";
    case "rework":
      return "needs_rework";
    case "escalated":
      return "waiting_for_human";
  }
}
