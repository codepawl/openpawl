/**
 * Decision context injection — formats past decisions for inclusion in agent prompts.
 */

import type { Decision } from "./types.js";

/**
 * Inject relevant past decisions into a prompt string.
 * Caps at 3 decisions to avoid prompt bloat.
 * Does not mutate the original prompt.
 */
export function withDecisionContext(prompt: string, decisions: Decision[]): string {
  if (decisions.length === 0) return prompt;

  const relevant = decisions
    .filter((d) => d.status === "active")
    .slice(0, 3);

  if (relevant.length === 0) return prompt;

  const lines = relevant.map((d) => {
    const confLabel = d.confidence >= 0.8 ? "high" : d.confidence >= 0.5 ? "medium" : "low";
    return [
      `- ${d.decision} (${d.recommendedBy}, ${confLabel} confidence)`,
      `  Reasoning: "${d.reasoning}"`,
    ].join("\n");
  });

  const block = `\n\n## Past Decisions Relevant to This Goal\n${lines.join("\n")}\n\nHonor these decisions unless the goal explicitly requires reconsidering them.`;

  return prompt + block;
}
