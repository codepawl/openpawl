/**
 * /compact slash command — show context usage and trigger compaction.
 */
import type { SlashCommand } from "../../tui/slash/registry.js";
import type { ContextTracker } from "../../context/context-tracker.js";
import type { CompactableMessage } from "../../context/compaction.js";
import { compact } from "../../context/compaction.js";
import { renderPanel, panelSection } from "../../tui/components/panel.js";

export interface CompactCommandDeps {
  contextTracker: ContextTracker;
  getMessages: () => CompactableMessage[];
  callLLM?: (prompt: string) => Promise<string>;
}

export function createCompactCommand(deps: CompactCommandDeps): SlashCommand {
  return {
    name: "compact",
    aliases: ["ctx"],
    description: "Show context usage and compact if needed",
    args: "[--force]",
    async execute(args: string, ctx) {
      const messages = deps.getMessages();
      const snapshot = deps.contextTracker.snapshot(messages);

      const forceEmergency = args.includes("--force") || args.includes("--full");

      if (!forceEmergency && snapshot.level === "normal") {
        const lines = [
          "",
          `  Tokens:  ~${snapshot.estimatedTokens.toLocaleString()} / ${snapshot.maxTokens.toLocaleString()}`,
          `  Usage:   ${snapshot.utilizationPercent}%`,
          `  Level:   ${snapshot.level}`,
          "",
          "  Context is healthy. No compaction needed.",
          "  Use /compact --force to compact anyway.",
        ];
        const panel = renderPanel({ title: "Context" }, lines);
        ctx.addMessage("system", panel.join("\n"));
        return;
      }

      const beforeTokens = snapshot.estimatedTokens;
      const level = forceEmergency ? "emergency" as const : snapshot.level;

      const result = await compact(messages, level, {
        callLLM: deps.callLLM,
        keepLastExchanges: level === "emergency" ? 5 : 10,
        emergencyKeepLast: 5,
        force: forceEmergency,
      });

      const afterSnapshot = deps.contextTracker.snapshot(messages);

      const lines = [
        ...panelSection("Compaction Applied"),
        `  Strategy:  ${result?.strategy ?? "none"}`,
        `  Before:    ~${beforeTokens.toLocaleString()} tokens (${snapshot.utilizationPercent}%)`,
        `  After:     ~${afterSnapshot.estimatedTokens.toLocaleString()} tokens (${afterSnapshot.utilizationPercent}%)`,
        `  Freed:     ~${(beforeTokens - afterSnapshot.estimatedTokens).toLocaleString()} tokens`,
        `  Messages:  ${result?.messagesAffected ?? 0} affected`,
      ];
      const panel = renderPanel({ title: "Context Compacted" }, lines);
      ctx.addMessage("system", panel.join("\n"));
    },
  };
}
