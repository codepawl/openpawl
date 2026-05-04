/**
 * Re-anchor prompt builder for drift halt per spec §5.5.
 *
 * When `checkDriftAtPhaseBoundary` returns `decision: "halt"`, the
 * runner builds a structured re-anchor prompt that surfaces:
 *   1. The original goal verbatim (so the user can compare).
 *   2. The top 3 drifting decisions identified by the supervisor.
 *   3. Three options: continue / abort / edit_goal.
 *
 * Headless mode (this PR's only consumer) prints the markdown to
 * stderr and exits non-zero. The TUI binding to `/continue`,
 * `/abort`, and `/edit_goal` slash commands lives in Prompt 9.
 */

import type { DriftingDecision } from "./drift-supervisor.js";

export const REANCHOR_OPTIONS = ["continue", "abort", "edit_goal"] as const;
export type ReanchorOption = (typeof REANCHOR_OPTIONS)[number];

export interface BuildReanchorPromptArgs {
  original_goal: string;
  drifting_decisions: DriftingDecision[];
  current_phase: { id: string; name: string };
  drift_score: number;
}

export interface ReanchorPrompt {
  markdown: string;
  options: readonly ReanchorOption[];
}

function renderDrifting(decisions: DriftingDecision[]): string {
  if (decisions.length === 0) {
    return "_(no drifting decisions surfaced from recent phase summaries)_";
  }
  return decisions
    .slice(0, 3)
    .map((d, i) => {
      const pct = Math.round(d.drift_distance * 100);
      return `${i + 1}. **${d.description}** _(decided in ${d.decided_in_phase_id}, drift distance ${pct}%)_`;
    })
    .join("\n");
}

export function buildReanchorPrompt(
  args: BuildReanchorPromptArgs,
): ReanchorPrompt {
  const pct = Math.round(args.drift_score * 100);
  const markdown = `# Drift halt — re-anchor required

The crew has drifted ${pct}% from the original goal at the boundary of
phase **${args.current_phase.name}** (\`${args.current_phase.id}\`).
The discussion meeting just produced a synthesis whose proposed next
phase shares too little with what you originally asked for.

## Original goal

> ${args.original_goal.split("\n").join("\n> ")}

## Top drifting decisions

${renderDrifting(args.drifting_decisions)}

## What happens next

Choose one of:

- \`continue\` — proceed with the proposed next phase anyway. Drift will be
  flagged in subsequent meetings but the run continues.
- \`abort\` — stop the crew here. Already-committed work stays on disk.
  Run \`openpawl resume <session>\` to come back later.
- \`edit_goal\` — revise the goal. The planner re-plans the remaining
  phases against the new goal; completed phases stay as-is.
`;
  return { markdown, options: REANCHOR_OPTIONS };
}
