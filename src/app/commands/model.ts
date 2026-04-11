/**
 * /model command — show or change current model.
 * No args → interactive model picker (shows only available models).
 * With args → set model with fuzzy matching + validation.
 */
import type { SlashCommand } from "../../tui/index.js";
import { ModelView } from "../interactive/model-view.js";
import { DOT_SYMBOL } from "../../tui/components/status-indicator.js";
import { ICONS } from "../../tui/constants/icons.js";

export function createModelCommand(): SlashCommand {
  return {
    name: "model",
    aliases: ["m"],
    description: "Show or change current model",
    args: "[model-name]",
    async execute(args, ctx) {
      const { getModelConfig } = await import("../../core/model-config.js");
      const sub = args.trim().toLowerCase();

      // /model refresh → invalidate cache
      if (sub === "refresh") {
        const { invalidateModelCache } = await import("../../providers/model-discovery.js");
        invalidateModelCache();
        ctx.addMessage("system", `${ICONS.success} Model cache cleared. Next /model will re-discover.`);
        return;
      }

      if (!args.trim()) {
        // Interactive mode
        if (ctx.tui) {
          const config = getModelConfig();
          const current = config.defaultModel || "";
          const view = new ModelView(
            ctx.tui,
            current,
            async (model) => {
              const { setActiveModel } = await import("../../core/provider-config.js");
              setActiveModel(model);
              ctx.addMessage("system", `${ICONS.success} Switched to ${model}`);
            },
            () => { /* closed */ },
          );
          view.activate();
          return;
        }

        // Fallback: show discovered models as static list
        const { discoverModels, getCurrentModel } = await import("../../providers/model-discovery.js");
        const result = await discoverModels();
        const current = getCurrentModel();
        const lines: string[] = [`${ICONS.bolt} Models`, ""];

        // Available models grouped by provider
        const available = result.models.filter((m) => m.status === "available");
        if (available.length > 0) {
          lines.push(`  ${DOT_SYMBOL.filled} Available:`);
          let lastProvider = "";
          for (const m of available) {
            if (m.provider !== lastProvider) {
              lines.push(`    ${m.provider}`);
              lastProvider = m.provider;
            }
            const isCurrent = m.model === current ? "  \u2190 current" : "";
            lines.push(`      ${m.displayName}${isCurrent}`);
          }
        }

        // Not configured
        const notConfigured = result.providers.filter((p) => p.status === "not_configured" || p.modelCount === 0);
        if (notConfigured.length > 0) {
          lines.push("");
          lines.push(`  ${DOT_SYMBOL.empty} Not configured:`);
          for (const p of notConfigured) {
            lines.push(`    ${p.name}  /settings to add`);
          }
        }

        lines.push("");
        lines.push("  /model <name> to switch  \u00b7  /model refresh to re-discover");
        ctx.addMessage("system", lines.join("\n"));
        return;
      }

      // Set model with fuzzy matching + validation
      const modelName = args.trim();
      const { discoverModels, findModel } = await import("../../providers/model-discovery.js");
      const result = await discoverModels();
      const match = findModel(modelName, result.models);

      if (!match) {
        const available = result.models.filter((m) => m.status === "available").map((m) => m.model);
        if (available.length === 0) {
          ctx.addMessage("error", `Model '${modelName}' not found. No models available — run /settings to configure a provider.`);
        } else {
          ctx.addMessage("error", `Model '${modelName}' not found.\nAvailable: ${available.slice(0, 5).join(", ")}${available.length > 5 ? ` (+${available.length - 5} more)` : ""}`);
        }
        return;
      }

      if (match.status === "not_configured") {
        ctx.addMessage("error", `Provider '${match.provider}' is not configured.\nRun: /settings to add ${match.provider} credentials.`);
        return;
      }

      if (match.status === "offline") {
        ctx.addMessage("error", `Provider '${match.provider}' is not reachable. Check your connection.`);
        return;
      }

      // Write through unified provider config (syncs globalConfig + ActiveProviderState)
      const { setActiveModel } = await import("../../core/provider-config.js");
      setActiveModel(match.model);

      const via = match.provider !== modelName ? ` via ${match.provider}` : "";
      ctx.addMessage("system", `${ICONS.success} Switched to ${match.model}${via}`);
    },
  };
}
