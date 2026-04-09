/**
 * /workspace command — manage workspace-local configuration.
 *
 * Subcommands:
 *   /workspace           — show workspace status
 *   /workspace init      — create .openpawl/ in cwd
 *   /workspace config    — show workspace config
 *   /workspace config <key> <value> — set workspace-local config
 *   /workspace rules     — show rules.md content
 */
import type { SlashCommand } from "../../tui/index.js";
import {
  getWorkspaceInfo,
  isWorkspaceInitialized,
  initWorkspace,
  readWorkspaceConfig,
  writeWorkspaceConfig,
  getWorkspaceRules,
} from "../../core/workspace.js";

export function createWorkspaceCommand(): SlashCommand {
  return {
    name: "workspace",
    aliases: ["ws"],
    description: "Manage workspace-local configuration",
    args: "[init | config [key] [value] | rules]",
    async execute(args, ctx) {
      const parts = args.trim().split(/\s+/);
      const sub = parts[0];

      // /workspace — show status
      if (!sub) {
        showStatus(ctx);
        return;
      }

      // /workspace init
      if (sub === "init") {
        const wsPath = initWorkspace();
        // Apply overlay so config takes effect immediately
        const { setWorkspaceOverlay } = await import("../../core/global-config.js");
        const wsConfig = readWorkspaceConfig();
        if (wsConfig) {
          setWorkspaceOverlay(wsConfig as Record<string, unknown>);
        }
        ctx.addMessage("system", [
          "\u2713 Workspace initialized",
          "",
          `  ${wsPath}/`,
          "  \u251c\u2500\u2500 config.json   \u2500 workspace config overrides",
          "  \u251c\u2500\u2500 rules.md      \u2500 agent instructions for this project",
          "  \u251c\u2500\u2500 agents/       \u2500 custom agent definitions",
          "  \u2514\u2500\u2500 scratch/      \u2500 tool scratch files (gitignored)",
        ].join("\n"));
        return;
      }

      // /workspace config [key] [value]
      if (sub === "config") {
        if (!isWorkspaceInitialized()) {
          ctx.addMessage("system", "No workspace. Run `/workspace init` first.");
          return;
        }

        const key = parts[1];
        const value = parts.slice(2).join(" ");

        // No key → show all workspace config
        if (!key) {
          const config = readWorkspaceConfig();
          if (!config || Object.keys(config).length <= 1) {
            ctx.addMessage("system", "Workspace config is empty. Set values with `/workspace config <key> <value>`.");
            return;
          }
          const lines = ["\u2699 Workspace Config\n"];
          for (const [k, v] of Object.entries(config)) {
            if (k === "version") continue;
            lines.push(`  ${k.padEnd(20)} ${typeof v === "string" ? v : JSON.stringify(v)}`);
          }
          ctx.addMessage("system", lines.join("\n"));
          return;
        }

        // Key only → show value
        if (!value) {
          const config = readWorkspaceConfig() ?? {};
          const v = config[key];
          if (v === undefined) {
            ctx.addMessage("system", `${key} is not set in workspace config.`);
          } else {
            ctx.addMessage("system", `${key} = ${typeof v === "string" ? v : JSON.stringify(v)} (workspace)`);
          }
          return;
        }

        // Key + value → set
        const config = readWorkspaceConfig() ?? { version: 1 };
        // Try to parse as JSON for non-string values
        let parsed: unknown = value;
        if (value === "true") parsed = true;
        else if (value === "false") parsed = false;
        else if (/^\d+$/.test(value)) parsed = Number(value);

        config[key] = parsed;
        writeWorkspaceConfig(config);

        // Update overlay so change takes effect immediately
        const { setWorkspaceOverlay } = await import("../../core/global-config.js");
        setWorkspaceOverlay(config as Record<string, unknown>);

        ctx.addMessage("system", `\u2713 ${key} = ${value} (workspace)`);
        return;
      }

      // /workspace rules
      if (sub === "rules") {
        if (!isWorkspaceInitialized()) {
          ctx.addMessage("system", "No workspace. Run `/workspace init` first.");
          return;
        }
        const rules = getWorkspaceRules();
        if (!rules || !rules.trim()) {
          ctx.addMessage("system", "rules.md is empty. Edit `.openpawl/rules.md` to add project-specific agent instructions.");
          return;
        }
        ctx.addMessage("system", `## .openpawl/rules.md\n\n${rules}`);
        return;
      }

      ctx.addMessage("system", "Usage: /workspace [init | config [key] [value] | rules]");
    },
  };
}

function showStatus(ctx: { addMessage: (role: string, content: string) => void }): void {
  const info = getWorkspaceInfo();
  if (!info.initialized) {
    ctx.addMessage("system", [
      "No workspace initialized in this directory.",
      "",
      `  Project: ${info.projectName}`,
      `  Path:    ${info.cwd}`,
      "",
      "Run `/workspace init` to create `.openpawl/` for workspace-local config.",
    ].join("\n"));
    return;
  }

  const config = readWorkspaceConfig() ?? {};
  const configKeys = Object.keys(config).filter((k) => k !== "version").length;
  const rules = getWorkspaceRules();
  const hasRules = rules ? rules.split("\n").some((l) => !l.startsWith("#") && l.trim()) : false;

  ctx.addMessage("system", [
    `\u2713 Workspace: ${info.projectName}`,
    "",
    `  Path:    ${info.path}`,
    `  Config:  ${configKeys > 0 ? `${configKeys} override(s)` : "empty"}`,
    `  Rules:   ${hasRules ? "configured" : "empty"}`,
  ].join("\n"));
}
