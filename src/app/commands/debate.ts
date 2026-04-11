/**
 * /debate command — multi-perspective analysis with consensus synthesis.
 */
import type { SlashCommand, CommandContext } from "../../tui/index.js";
import { defaultTheme } from "../../tui/themes/default.js";
import { ICONS } from "../../tui/constants/icons.js";

export function createDebateCommand(): SlashCommand {
  return {
    name: "debate",
    description: "Multi-perspective debate on a question",
    args: "<question>",
    async execute(args: string, ctx: CommandContext) {
      const question = args.trim();
      if (!question) {
        ctx.addMessage("system", "Usage: /debate <your question>");
        return;
      }

      ctx.addMessage("system", defaultTheme.muted(`Debating: ${question}`));
      ctx.requestRender();

      try {
        const { runDebate } = await import("../../debate/runner.js");

        const result = await runDebate(question, {
          onEvent(event) {
            if (event.stage === "perspectives" && event.perspectiveId && event.content) {
              // Streaming — handled below when result is ready
            }
            if (event.stage === "synthesizing" && !event.content) {
              ctx.addMessage("system", defaultTheme.muted("Synthesizing consensus..."));
              ctx.requestRender();
            }
          },
        });

        // Render each perspective
        for (const p of result.perspectives) {
          const header = defaultTheme.info(`┌ ${p.name} (${p.description}) ┐`);
          ctx.addMessage("system", `${header}\n${p.response}`);
        }

        // Render consensus
        const consensusLines: string[] = [defaultTheme.warning("── Consensus ──")];
        for (const point of result.consensus) {
          const icon = point.type === "agreement" ? ICONS.success : point.type === "disagreement" ? ICONS.bolt : "💡";
          const label = point.type.charAt(0).toUpperCase() + point.type.slice(1);
          consensusLines.push(`${icon} ${label}: ${point.summary}`);
        }
        consensusLines.push("");
        consensusLines.push(
          defaultTheme.success(`Recommendation (${Math.round(result.recommendation.confidence * 100)}% confidence):`),
        );
        consensusLines.push(result.recommendation.summary);
        consensusLines.push("");
        consensusLines.push(defaultTheme.dim(result.recommendation.reasoning));

        ctx.addMessage("system", consensusLines.join("\n"));
        ctx.requestRender();
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        ctx.addMessage("error", `Debate failed: ${msg}`);
        ctx.requestRender();
      }
    },
  };
}
