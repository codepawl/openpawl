/**
 * CLI command registry — single source of truth for all commands.
 * Generates help text, validates commands, and powers fuzzy matching.
 */
import { createRequire } from "node:module";
import pc from "picocolors";

export type CommandCategory =
  | "getting-started"
  | "daily"
  | "memory"
  | "team"
  | "history"
  | "utilities";

export interface CommandDef {
  name: string;
  aliases?: string[];
  description: string;
  category: CommandCategory;
  /** Dynamic import path and exported function name */
  handler: { module: string; fn: string };
  options?: { flag: string; description: string }[];
  examples?: string[];
  /** Commands with complex dispatch (web subcommands, config subcommands) use custom handler */
  customDispatch?: boolean;
}

const CATEGORY_LABELS: Record<CommandCategory, string> = {
  "getting-started": "GETTING STARTED",
  daily: "DAILY WORKFLOW",
  memory: "MEMORY & DECISIONS",
  team: "TEAM & PROVIDERS",
  history: "HISTORY & ANALYSIS",
  utilities: "UTILITIES",
};

const CATEGORY_ORDER: CommandCategory[] = [
  "getting-started",
  "daily",
  "memory",
  "team",
  "history",
  "utilities",
];

// ─── Command Definitions ───────────────────────────────────────────────────

export const CLI_COMMANDS: CommandDef[] = [
  // Getting Started
  {
    name: "setup",
    aliases: ["init"],
    description: "Configure OpenPawl for the first time",
    category: "getting-started",
    handler: { module: "./onboard/index.js", fn: "handleFirstRun" },
    customDispatch: true,
  },
  {
    name: "check",
    description: "Verify your setup is working",
    category: "getting-started",
    handler: { module: "./check.js", fn: "runCheck" },
  },
  {
    name: "demo",
    description: "See OpenPawl in action (no API key needed)",
    category: "getting-started",
    handler: { module: "./commands/demo.js", fn: "runDemo" },
  },

  // Daily Workflow
  {
    name: "standup",
    description: "See what was done, blocked, and next",
    category: "daily",
    handler: { module: "./commands/standup.js", fn: "runStandupCommand" },
  },
  {
    name: "think",
    description: "Debate a question with your AI team",
    category: "daily",
    handler: { module: "./commands/think.js", fn: "runThinkCommand" },
  },
  {
    name: "clarity",
    description: "Check goal clarity before sprinting",
    category: "daily",
    handler: { module: "./commands/clarity.js", fn: "runClarityCommand" },
  },
  {
    name: "chat",
    description: "Interactive chat mode",
    category: "daily",
    handler: { module: "./commands/chat.js", fn: "runChatCommand" },
  },

  // Memory & Decisions
  {
    name: "journal",
    description: "Search and manage architectural decisions",
    category: "memory",
    handler: { module: "./commands/journal.js", fn: "runJournalCommand" },
  },
  {
    name: "drift",
    description: "Check if a goal conflicts with past decisions",
    category: "memory",
    handler: { module: "./commands/drift.js", fn: "runDriftCommand" },
  },
  {
    name: "lessons",
    description: "Export what your team has learned",
    category: "memory",
    handler: { module: "./commands/lessons-export.js", fn: "runLessonsExport" },
  },
  {
    name: "handoff",
    description: "Generate CONTEXT.md handoff file",
    category: "memory",
    handler: { module: "./commands/handoff.js", fn: "runHandoffCommand" },
  },

  // Team & Providers
  {
    name: "templates",
    aliases: ["template"],
    description: "Browse and install team templates",
    category: "team",
    handler: { module: "./commands/templates.js", fn: "runTemplatesCommand" },
  },
  {
    name: "model",
    aliases: ["models"],
    description: "Manage AI models per agent",
    category: "team",
    handler: { module: "./commands/model.js", fn: "runModelCommand" },
  },
  {
    name: "providers",
    description: "Configure and test AI providers",
    category: "team",
    handler: { module: "./commands/providers.js", fn: "runProvidersCommand" },
  },
  {
    name: "agent",
    description: "Add custom agents",
    category: "team",
    handler: { module: "./commands/agent.js", fn: "runAgentCommand" },
  },
  {
    name: "settings",
    description: "View and change settings",
    category: "team",
    handler: { module: "./commands/settings.js", fn: "runSettings" },
  },
  {
    name: "config",
    description: "Manage configuration",
    category: "team",
    handler: { module: "./commands/config.js", fn: "runConfigDashboard" },
    customDispatch: true,
  },

  // History & Analysis
  {
    name: "replay",
    description: "Replay past sessions",
    category: "history",
    handler: { module: "./commands/replay.js", fn: "runReplayCommand" },
  },
  {
    name: "audit",
    description: "Export decision logs",
    category: "history",
    handler: { module: "./commands/audit.js", fn: "runAuditCommand" },
  },
  {
    name: "heatmap",
    description: "Agent performance visualization",
    category: "history",
    handler: { module: "./commands/heatmap.js", fn: "runHeatmapCommand" },
  },
  {
    name: "forecast",
    description: "Estimate run cost before execution",
    category: "history",
    handler: { module: "./commands/forecast.js", fn: "runForecastCommand" },
  },
  {
    name: "diff",
    description: "Compare runs",
    category: "history",
    handler: { module: "./commands/diff.js", fn: "runDiffCommand" },
  },
  {
    name: "score",
    description: "Your vibe coding collaboration score",
    category: "history",
    handler: { module: "./commands/score.js", fn: "runScoreCommand" },
  },
  {
    name: "sessions",
    aliases: ["session"],
    description: "Manage chat sessions",
    category: "history",
    handler: { module: "./commands/sessions.js", fn: "runSessionsCommand" },
  },

  // Utilities
  {
    name: "memory",
    description: "Global memory: health, promote, export",
    category: "utilities",
    handler: { module: "./commands/memory.js", fn: "runMemoryCommand" },
  },
  {
    name: "cache",
    description: "Response cache management",
    category: "utilities",
    handler: { module: "./commands/cache.js", fn: "runCacheCommand" },
  },
  {
    name: "logs",
    description: "View session and gateway logs",
    category: "utilities",
    handler: { module: "./commands/logs.js", fn: "runLogs" },
  },
  {
    name: "profile",
    description: "Agent performance profiles",
    category: "utilities",
    handler: { module: "./commands/profile.js", fn: "runProfileCommand" },
  },
  {
    name: "clean",
    description: "Remove session data",
    category: "utilities",
    handler: { module: "./commands/clean.js", fn: "runClean" },
  },
  {
    name: "update",
    description: "Self-update OpenPawl",
    category: "utilities",
    handler: { module: "./commands/update.js", fn: "runUpdateCommand" },
  },
  {
    name: "uninstall",
    description: "Remove OpenPawl data and config",
    category: "utilities",
    handler: { module: "./commands/uninstall.js", fn: "runUninstall" },
  },
];

// ─── Lookup ────────────────────────────────────────────────────────────────

/** Find a command by name or alias. */
export function findCommand(name: string): CommandDef | undefined {
  const lower = name.toLowerCase();
  return CLI_COMMANDS.find(
    (c) => c.name === lower || c.aliases?.includes(lower),
  );
}

/** Get all command names + aliases for fuzzy matching. */
export function getAllCommandNames(): string[] {
  const names: string[] = [];
  for (const cmd of CLI_COMMANDS) {
    names.push(cmd.name);
    if (cmd.aliases) names.push(...cmd.aliases);
  }
  return names;
}

// ─── Help Generation ───────────────────────────────────────────────────────

export function generateHelp(): string {
  const require = createRequire(import.meta.url);
  const { version } = require("../../package.json") as { version: string };

  const section = (s: string) => pc.bold(pc.yellow(s));
  const cmd = (c: string) => pc.green(c);
  const desc = (d: string) => pc.dim(d);
  const exCmd = (c: string) => pc.cyan(c);
  const pad = (s: string, w = 15) => s + " ".repeat(Math.max(1, w - s.length));

  const lines: string[] = [
    "",
    pc.bold(pc.cyan("OpenPawl")) + " — Your AI team for shipping goals" + "  " + pc.dim(`v${version}`),
    "",
    section("USAGE"),
    "  openpawl <command> [options]",
    "",
  ];

  // Group commands by category
  const grouped = new Map<CommandCategory, CommandDef[]>();
  for (const c of CLI_COMMANDS) {
    const list = grouped.get(c.category) ?? [];
    list.push(c);
    grouped.set(c.category, list);
  }

  for (const cat of CATEGORY_ORDER) {
    const cmds = grouped.get(cat);
    if (!cmds || cmds.length === 0) continue;
    lines.push(section(CATEGORY_LABELS[cat]));
    for (const c of cmds) {
      lines.push("  " + cmd(pad(c.name)) + desc(c.description));
    }
    lines.push("");
  }

  lines.push(section("OPTIONS"));
  lines.push("  " + cmd(pad("--help, -h")) + desc("Show this help"));
  lines.push("  " + cmd(pad("--version")) + desc("Show version"));
  lines.push("  " + cmd(pad("--mock-llm")) + desc("Use mock responses (testing)"));
  lines.push("");
  lines.push(section("EXAMPLES"));
  lines.push("  " + exCmd("openpawl setup") + "                          " + desc("Get started"));
  lines.push("  " + exCmd("openpawl chat") + "                           " + desc("Start a conversation"));
  lines.push("  " + exCmd("openpawl check") + "                          " + desc("Verify setup"));
  lines.push("");
  lines.push(desc("Run openpawl <command> --help for details on any command."));
  lines.push("");

  return lines.join("\n");
}

/** Generate per-command help text. */
export function generateCommandHelp(cmd: CommandDef): string {
  const lines: string[] = [
    "",
    pc.bold(`openpawl ${cmd.name}`) + " — " + cmd.description,
    "",
  ];

  if (cmd.aliases && cmd.aliases.length > 0) {
    lines.push(pc.dim(`Aliases: ${cmd.aliases.join(", ")}`));
    lines.push("");
  }

  if (cmd.options && cmd.options.length > 0) {
    lines.push(pc.bold(pc.yellow("OPTIONS")));
    for (const opt of cmd.options) {
      lines.push(`  ${pc.green(opt.flag.padEnd(25))} ${pc.dim(opt.description)}`);
    }
    lines.push("");
  }

  if (cmd.examples && cmd.examples.length > 0) {
    lines.push(pc.bold(pc.yellow("EXAMPLES")));
    for (const ex of cmd.examples) {
      lines.push(`  ${pc.cyan(ex)}`);
    }
    lines.push("");
  }

  return lines.join("\n");
}
