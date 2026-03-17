/**
 * CLI clarity command — standalone goal clarity check without starting a sprint.
 */

import pc from "picocolors";
import { logger } from "../core/logger.js";
import { analyzeClarity } from "../clarity/analyzer.js";
import { generateQuestions } from "../clarity/questioner.js";
import { rewriteGoal } from "../clarity/rewriter.js";
import type { ClarityResult } from "../clarity/types.js";

function renderClarityResult(result: ClarityResult): void {
  if (result.isClear) {
    logger.plain(pc.green("✓ Goal is clear."));
    logger.plain(pc.dim(`Clarity score: ${result.score.toFixed(2)}`));
    return;
  }

  const icon = result.score < 0.5 ? "🚨" : "🔍";
  const label = result.score < 0.5 ? "Goal needs clarification" : "Goal could be clearer";

  logger.plain(`\n${icon} ${pc.yellow(label)} (score: ${result.score.toFixed(2)})`);

  logger.plain(pc.dim("┌─────────────────────────────────────────────────────────────┐"));
  for (const issue of result.issues) {
    const badge = issue.severity === "blocking"
      ? pc.red("[blocking]")
      : pc.yellow("[advisory]");
    logger.plain(`│ ${badge} ${issue.type}`);
    logger.plain(`│   Fragment: "${issue.fragment}"`);
    logger.plain(`│   ${issue.question}`);
    logger.plain(`│`);
  }
  logger.plain(pc.dim("└─────────────────────────────────────────────────────────────┘"));

  if (result.suggestions.length > 0) {
    logger.plain("");
    logger.plain(pc.bold("Suggestions for a clearer goal:"));
    for (const suggestion of result.suggestions) {
      logger.plain(`  → ${suggestion}`);
    }
  }
}

async function runInteractiveClarification(goal: string, result: ClarityResult): Promise<void> {
  const questions = generateQuestions(result.issues);
  if (questions.length === 0) return;

  const { text: clackText, isCancel: clackIsCancel } = await import("@clack/prompts");

  const answers: Array<{ issue: typeof questions[0]["issue"]; answer: string }> = [];
  for (const q of questions) {
    const answer = await clackText({
      message: q.question,
      placeholder: q.placeholder,
    });

    if (clackIsCancel(answer)) {
      logger.plain(pc.dim("Clarification cancelled."));
      return;
    }

    answers.push({ issue: q.issue, answer: String(answer).trim() });
  }

  const clarifiedGoal = rewriteGoal(goal, answers);
  logger.plain("");
  logger.plain(pc.bold("Clarified goal:"));
  logger.plain(pc.green(`"${clarifiedGoal}"`));

  // Re-check the clarified goal
  const recheck = analyzeClarity(clarifiedGoal);
  if (recheck.isClear) {
    logger.plain(pc.green(`✓ Goal is clear (score: ${recheck.score.toFixed(2)}).`));
  } else {
    logger.plain(pc.yellow(`Score improved: ${result.score.toFixed(2)} → ${recheck.score.toFixed(2)}`));
  }
}

export async function runClarityCommand(args: string[]): Promise<void> {
  if (args.length === 0 || args[0] === "--help" || args[0] === "-h") {
    logger.plain([
      pc.bold("teamclaw clarity") + " — Check goal clarity",
      "",
      "Usage:",
      '  teamclaw clarity "Improve the API"           Check goal clarity',
      '  teamclaw clarity "Improve the API" --fix     Interactive clarification',
    ].join("\n"));
    return;
  }

  const fix = args.includes("--fix");
  const goal = args.filter((a) => a !== "--fix").join(" ").trim();

  if (!goal) {
    logger.error("Please provide a goal to check.");
    return;
  }

  const result = analyzeClarity(goal);
  renderClarityResult(result);

  if (fix && !result.isClear) {
    await runInteractiveClarification(goal, result);
  }
}
