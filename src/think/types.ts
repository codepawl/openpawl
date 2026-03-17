/**
 * Types for the think (rubber duck) mode.
 */

import type { Decision } from "../journal/types.js";
import type { AgentProfile } from "../agents/profiles/types.js";

export interface ThinkRecommendation {
  choice: string;
  confidence: number;
  reasoning: string;
  tradeoffs: {
    pros: string[];
    cons: string[];
  };
}

export interface ThinkRound {
  question: string;
  techLeadPerspective: string;
  rfcAuthorPerspective: string;
  recommendation: ThinkRecommendation;
}

export interface ThinkContext {
  relevantDecisions: Decision[];
  relevantPatterns: string[];
  agentProfiles: {
    techLead: AgentProfile | null;
    rfcAuthor: AgentProfile | null;
  };
}

export interface ThinkSession {
  id: string;
  question: string;
  context: ThinkContext;
  rounds: ThinkRound[];
  recommendation: ThinkRecommendation | null;
  savedToJournal: boolean;
  createdAt: number;
}

export interface ThinkHistoryEntry {
  sessionId: string;
  question: string;
  recommendation: string;
  confidence: number;
  savedToJournal: boolean;
  followUpCount: number;
  createdAt: number;
}

/** SSE events streamed to the dashboard. */
export type ThinkEvent =
  | { event: "context_loaded"; data: { relevantDecisions: number } }
  | { event: "tech_lead_start"; data: Record<string, never> }
  | { event: "tech_lead_chunk"; data: { content: string } }
  | { event: "tech_lead_done"; data: { perspective: string } }
  | { event: "rfc_author_start"; data: Record<string, never> }
  | { event: "rfc_author_chunk"; data: { content: string } }
  | { event: "rfc_author_done"; data: { perspective: string } }
  | { event: "recommendation"; data: { recommendation: ThinkRecommendation } }
  | { event: "error"; data: { stage: string; message: string } }
  | { event: "done"; data: Record<string, never> };
