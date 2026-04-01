/**
 * /model command — show or change current model.
 */
import type { SlashCommand } from "../../tui/index.js";

export function createModelCommand(): SlashCommand {
  return {
    name: "model",
    aliases: ["m"],
    description: "Show or change current model",
    args: "[model-name]",
    async execute(args, ctx) {
      const { getModelConfig } = await import("../../core/model-config.js");

      if (!args.trim()) {
        const config = getModelConfig();
        const lines = [
          `**Current model:** ${config.defaultModel || "(not set — provider default)"}`,
        ];
        if (Object.keys(config.agentModels).length > 0) {
          lines.push("", "**Per-agent models:**");
          for (const [role, model] of Object.entries(config.agentModels)) {
            lines.push(`  ${role}: ${model}`);
          }
        }
        if (config.fallbackChain.length > 0) {
          lines.push("", `**Fallback chain:** ${config.fallbackChain.join(" → ")}`);
        }
        ctx.addMessage("system", lines.join("\n"));
        return;
      }

      // Set model
      const { setConfigValue } = await import("../../core/configManager.js");
      const result = setConfigValue("model", args.trim());
      if ("error" in result) {
        ctx.addMessage("error", result.error);
      } else {
        ctx.addMessage("system", `Model set to: ${args.trim()}`);
      }
    },
  };
}
