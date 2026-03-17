/**
 * Types for the decision journal.
 */

export interface Decision {
  id: string;
  sessionId: string;
  runIndex: number;
  capturedAt: number;
  topic: string;
  decision: string;
  reasoning: string;
  recommendedBy: string;
  confidence: number;
  taskId: string;
  goalContext: string;
  tags: string[];
  embedding: number[];
  supersededBy?: string;
  status: "active" | "superseded" | "reconsidered";
}

export interface SupersessionAlert {
  oldDecision: Decision;
  newDecision: Decision;
  detectedAt: number;
}

export interface DecisionSearchResult {
  decision: Decision;
  relevance: number;
}
