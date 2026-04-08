/**
 * Pre-execution confirmation for risky operations.
 */

import type { ConfirmationRequest } from "./types.js";
import type { RouteDecision } from "../router/router-types.js";

export class ConfirmationGate {
  private costThreshold: number;

  constructor(costThreshold = 0.50) {
    this.costThreshold = costThreshold;
  }

  shouldConfirm(
    decision: RouteDecision,
    context: {
      estimatedCost: number;
      fileCount: number;
      hasDestructive: boolean;
      isMultiAgent: boolean;
    },
  ): ConfirmationRequest | null {
    // Multi-agent with 3+ agents
    if (context.isMultiAgent && decision.agents.length >= 3) {
      const agentNames = decision.agents.map((a) => a.role).join(", ");
      return {
        message: `This will use ${decision.agents.length} agents (${agentNames}). Proceed?`,
        details: decision.agents.map((a) => `${a.role}: ${a.task || "assigned"}`),
        estimatedCost: "",
        risk: "moderate",
      };
    }

    // Destructive with many files
    if (context.hasDestructive && context.fileCount > 3) {
      return {
        message: `This will modify ${context.fileCount} files. Proceed?`,
        details: [`${context.fileCount} files will be modified or deleted`],
        estimatedCost: "",
        risk: "high",
      };
    }

    return null;
  }
}
