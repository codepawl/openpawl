/**
 * Think mode executor — calls ProxyService.stream() sequentially for
 * Tech Lead, RFC Author, and Coordinator perspectives.
 */

import { ProxyService, createProxyService } from "../proxy/ProxyService.js";
import type { ThinkContext, ThinkRound, ThinkRecommendation } from "./types.js";
import {
  buildTechLeadPrompt,
  buildRfcAuthorPrompt,
  buildCoordinatorPrompt,
  buildFollowUpContext,
} from "./prompts.js";
import { parseLlmJson } from "../utils/jsonExtractor.js";
import { logger } from "../core/logger.js";

const INCONCLUSIVE: ThinkRecommendation = {
  choice: "Inconclusive",
  confidence: 0,
  reasoning: "Could not complete analysis — one or more agent calls failed.",
  tradeoffs: { pros: [], cons: [] },
};

export interface ExecuteOptions {
  previousRounds?: ThinkRound[];
  onChunk?: (stage: "tech_lead" | "rfc_author" | "coordinator", content: string) => void;
}

function getProxy(): ProxyService {
  return createProxyService();
}

async function collectStream(
  proxy: ProxyService,
  prompt: string,
  stage: "tech_lead" | "rfc_author" | "coordinator",
  onChunk?: ExecuteOptions["onChunk"],
): Promise<string> {
  let result = "";
  for await (const chunk of proxy.stream(prompt)) {
    result += chunk.content;
    onChunk?.(stage, chunk.content);
  }
  return result.trim();
}

export async function executeThinkRound(
  question: string,
  context: ThinkContext,
  options?: ExecuteOptions,
): Promise<ThinkRound> {
  const proxy = getProxy();
  const followUpPrefix = buildFollowUpContext(options?.previousRounds ?? []);
  const fullQuestion = followUpPrefix ? `${followUpPrefix}Follow-up question: ${question}` : question;

  // 1. Tech Lead
  let techLeadPerspective = "";
  try {
    const prompt = buildTechLeadPrompt(fullQuestion, context.relevantDecisions);
    techLeadPerspective = await collectStream(proxy, prompt, "tech_lead", options?.onChunk);
  } catch {
    // Partial failure — continue with empty perspective
  }

  // 2. RFC Author
  let rfcAuthorPerspective = "";
  try {
    const prompt = buildRfcAuthorPrompt(fullQuestion, context.relevantDecisions);
    rfcAuthorPerspective = await collectStream(proxy, prompt, "rfc_author", options?.onChunk);
  } catch {
    // Partial failure — continue with what we have
  }

  // 3. Coordinator synthesis
  if (!techLeadPerspective && !rfcAuthorPerspective) {
    return { question, techLeadPerspective, rfcAuthorPerspective, recommendation: INCONCLUSIVE };
  }

  let recommendation: ThinkRecommendation;
  let raw = "";
  try {
    const prompt = buildCoordinatorPrompt(
      techLeadPerspective || "(Tech Lead was unavailable)",
      rfcAuthorPerspective || "(RFC Author was unavailable)",
    );
    raw = await collectStream(proxy, prompt, "coordinator", options?.onChunk);
    recommendation = parseLlmJson<ThinkRecommendation>(raw);

    // Validate required fields
    if (typeof recommendation.choice !== "string" || typeof recommendation.confidence !== "number") {
      throw new Error("Missing required fields in recommendation");
    }
    // Clamp confidence to 0-1
    recommendation.confidence = Math.max(0, Math.min(1, recommendation.confidence));
    // Ensure tradeoffs arrays exist
    recommendation.tradeoffs = recommendation.tradeoffs ?? { pros: [], cons: [] };
    recommendation.tradeoffs.pros = recommendation.tradeoffs.pros ?? [];
    recommendation.tradeoffs.cons = recommendation.tradeoffs.cons ?? [];
  } catch {
    recommendation = extractFallbackRecommendation(raw);
  }

  return { question, techLeadPerspective, rfcAuthorPerspective, recommendation };
}

/**
 * Extract a usable recommendation from raw text when JSON parsing fails.
 * Never returns "Inconclusive" — always produces something useful.
 */
export function extractFallbackRecommendation(raw: string): ThinkRecommendation {
  logger.warn("Coordinator JSON parse failed, using text fallback");
  logger.debug(`Raw coordinator response: ${raw.slice(0, 500)}`);

  const text = (raw ?? "").trim();
  if (!text) {
    return {
      choice: "Analysis complete — see reasoning for details",
      confidence: 0.7,
      reasoning: "The coordinator produced an empty response.",
      tradeoffs: { pros: ["See full analysis"], cons: [] },
    };
  }

  // Try to extract a choice from "Recommendation: ..." pattern
  let choice: string;
  const recMatch = text.match(/[Rr]ecommendation:\s*(.+?)(?:\.|$)/m);
  if (recMatch) {
    choice = recMatch[1]!.trim();
  } else {
    // Use first sentence of the response
    const firstSentence = text.match(/^(.+?[.!?])\s/);
    choice = firstSentence ? firstSentence[1]!.trim() : text.slice(0, 120).trim();
  }

  // Cap choice length
  if (choice.length > 150) choice = choice.slice(0, 147) + "...";

  return {
    choice,
    confidence: 0.7,
    reasoning: text.slice(0, 300),
    tradeoffs: { pros: ["See full analysis"], cons: [] },
  };
}
