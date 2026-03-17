/**
 * Prompt builders for think mode agents.
 */

import type { Decision } from "../journal/types.js";
import type { ThinkRound } from "./types.js";
import { withPersonality } from "../personality/injector.js";
import { isPersonalityEnabled } from "../core/config.js";

function formatDecisionContext(decisions: Decision[]): string {
  if (decisions.length === 0) return "No relevant past decisions.";
  return decisions
    .map((d) => {
      const date = new Date(d.capturedAt).toISOString().slice(0, 10);
      return `- "${d.decision}" (${date}, ${d.recommendedBy}, confidence ${d.confidence.toFixed(2)})\n  Reasoning: ${d.reasoning}`;
    })
    .join("\n");
}

export function buildTechLeadPrompt(
  question: string,
  decisions: Decision[],
): string {
  const prompt = `You are TeamClaw's Tech Lead. Your role is to give a pragmatic, implementation-focused perspective on this question.

Past decisions relevant to this question:
${formatDecisionContext(decisions)}

Question: ${question}

Give your perspective in 3-5 sentences. Focus on practical implementation concerns, complexity, and consistency with existing decisions. Be direct and opinionated.
End with your recommended choice in one sentence.`;
  if (!isPersonalityEnabled("tech-lead")) return prompt;
  return withPersonality(prompt, "tech-lead");
}

export function buildRfcAuthorPrompt(
  question: string,
  decisions: Decision[],
): string {
  const prompt = `You are TeamClaw's RFC Author. Your role is to consider longer-term architectural implications and edge cases.

Past decisions relevant to this question:
${formatDecisionContext(decisions)}

Question: ${question}

Give your perspective in 3-5 sentences. Focus on future flexibility, architectural consistency, and risks. Be direct and opinionated.
End with your recommended choice in one sentence.`;
  if (!isPersonalityEnabled("rfc-author")) return prompt;
  return withPersonality(prompt, "rfc-author");
}

export function buildCoordinatorPrompt(
  techLeadPerspective: string,
  rfcAuthorPerspective: string,
): string {
  const prompt = `You are TeamClaw's Coordinator. Two experts have weighed in:

Tech Lead: ${techLeadPerspective}

RFC Author: ${rfcAuthorPerspective}

Synthesize their views into:
- A clear recommendation (one choice)
- A confidence score (0-1)
- Reasoning (2-3 sentences)
- Tradeoffs: 2-3 pros, 2-3 cons

Return ONLY valid JSON, no markdown fences:
{
  "choice": "...",
  "confidence": 0.0,
  "reasoning": "...",
  "tradeoffs": { "pros": ["..."], "cons": ["..."] }
}`;
  if (!isPersonalityEnabled("coordinator")) return prompt;
  return withPersonality(prompt, "coordinator");
}

export function buildFollowUpContext(previousRounds: ThinkRound[]): string {
  if (previousRounds.length === 0) return "";
  const summary = previousRounds
    .map((r, i) => {
      return `Round ${i + 1}: "${r.question}"
  Tech Lead: ${r.techLeadPerspective}
  RFC Author: ${r.rfcAuthorPerspective}
  Recommendation: ${r.recommendation.choice} (confidence ${r.recommendation.confidence.toFixed(2)})`;
    })
    .join("\n\n");
  return `Previous discussion:\n${summary}\n\n`;
}
