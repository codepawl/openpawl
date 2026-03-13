/**
 * `teamclaw model` — Manage model configuration.
 *
 * Subcommands:
 *   (none)        Interactive dashboard
 *   list          Show available models
 *   get           Show current model config
 *   set <model>   Set global default model
 *   set --agent <role> <model>  Set per-agent model
 *   reset         Clear all overrides
 */

import pc from "picocolors";
import { cancel, isCancel, note, select, text } from "@clack/prompts";
import { logger } from "../core/logger.js";
import {
  getModelConfig,
  listAvailableModels,
  resolveModelForAgent,
  setAgentModel,
  setDefaultModel,
  resetAgentModels,
  setConfigAgentModels,
  clearModelConfigCache,
} from "../core/model-config.js";
import { setOpenClawModel } from "../core/config.js";
import {
  readGlobalConfig,
  writeGlobalConfig,
  type TeamClawGlobalConfig,
  buildDefaultGlobalConfig,
} from "../core/global-config.js";

const KNOWN_AGENT_ROLES = [
  "coordinator",
  "planner",
  "architect",
  "rfc",
  "analyst",
  "retrospective",
  "worker",
];

export async function runModelCommand(args: string[]): Promise<void> {
  const sub = args[0];

  if (!sub) {
    await runModelDashboard();
    return;
  }

  if (sub === "list") {
    await runModelList();
    return;
  }

  if (sub === "get") {
    runModelGet();
    return;
  }

  if (sub === "set") {
    await runModelSet(args.slice(1));
    return;
  }

  if (sub === "reset") {
    runModelReset();
    return;
  }

  logger.error(`Unknown subcommand: model ${sub}`);
  logger.error("Usage: teamclaw model | model list | model get | model set <model> | model set --agent <role> <model> | model reset");
  process.exit(1);
}

async function runModelDashboard(): Promise<void> {
  const config = getModelConfig();

  note(
    [
      `Default model: ${config.defaultModel || pc.dim("(gateway decides)")}`,
      "",
      pc.bold("Per-agent models:"),
      ...Object.entries(config.agentModels).length > 0
        ? Object.entries(config.agentModels).map(([role, model]) => `  ${role}: ${model}`)
        : [pc.dim("  (none configured)")],
      "",
      `Fallback chain: ${config.fallbackChain.length > 0 ? config.fallbackChain.join(" → ") : pc.dim("(none)")}`,
    ].join("\n"),
    "Current Model Configuration",
  );

  const action = await select({
    message: "What would you like to do?",
    options: [
      { value: "set-default", label: "Set default model" },
      { value: "set-agent", label: "Set model for a specific agent" },
      { value: "list", label: "List available models" },
      { value: "reset", label: "Reset all overrides" },
      { value: "exit", label: "Exit" },
    ],
  });

  if (isCancel(action)) {
    cancel("Cancelled.");
    return;
  }

  if (action === "set-default") {
    const models = await listAvailableModels();
    let model: string;
    if (models.length > 0) {
      const picked = await select({
        message: "Select a model:",
        options: [
          ...models.map((m) => ({ value: m, label: m })),
          { value: "__custom__", label: pc.dim("Enter custom model ID...") },
        ],
      });
      if (isCancel(picked)) { cancel("Cancelled."); return; }
      if (picked === "__custom__") {
        const custom = await text({ message: "Enter model ID:", placeholder: "provider/model-name" });
        if (isCancel(custom)) { cancel("Cancelled."); return; }
        model = (custom as string).trim();
      } else {
        model = picked as string;
      }
    } else {
      const custom = await text({ message: "Enter model ID:", placeholder: "provider/model-name" });
      if (isCancel(custom)) { cancel("Cancelled."); return; }
      model = (custom as string).trim();
    }
    if (model) {
      persistDefaultModel(model);
      logger.success(`Default model set to: ${model}`);
    }
    return;
  }

  if (action === "set-agent") {
    const role = await select({
      message: "Select agent role:",
      options: KNOWN_AGENT_ROLES.map((r) => ({
        value: r,
        label: `${r} ${pc.dim(`(current: ${resolveModelForAgent(r) || "default"})`)}`,
      })),
    });
    if (isCancel(role)) { cancel("Cancelled."); return; }

    const models = await listAvailableModels();
    let model: string;
    if (models.length > 0) {
      const picked = await select({
        message: `Select model for ${role as string}:`,
        options: [
          { value: "__default__", label: pc.dim("Use default model") },
          ...models.map((m) => ({ value: m, label: m })),
          { value: "__custom__", label: pc.dim("Enter custom model ID...") },
        ],
      });
      if (isCancel(picked)) { cancel("Cancelled."); return; }
      if (picked === "__default__") {
        persistAgentModel(role as string, "");
        logger.success(`${role as string} will now use the default model.`);
        return;
      }
      if (picked === "__custom__") {
        const custom = await text({ message: "Enter model ID:", placeholder: "provider/model-name" });
        if (isCancel(custom)) { cancel("Cancelled."); return; }
        model = (custom as string).trim();
      } else {
        model = picked as string;
      }
    } else {
      const custom = await text({ message: "Enter model ID:", placeholder: "provider/model-name" });
      if (isCancel(custom)) { cancel("Cancelled."); return; }
      model = (custom as string).trim();
    }
    if (model) {
      persistAgentModel(role as string, model);
      logger.success(`${role as string} model set to: ${model}`);
    }
    return;
  }

  if (action === "list") {
    await runModelList();
    return;
  }

  if (action === "reset") {
    runModelReset();
    return;
  }
}

async function runModelList(): Promise<void> {
  const models = await listAvailableModels();
  if (models.length === 0) {
    logger.warn("No models discovered. Ensure OpenClaw is running or check ~/.openclaw/openclaw.json");
    return;
  }

  const currentDefault = resolveModelForAgent("default");
  console.log(pc.bold("\nAvailable models:\n"));
  for (const m of models) {
    const marker = m === currentDefault ? pc.green(" ← default") : "";
    console.log(`  ${m}${marker}`);
  }
  console.log();
}

function runModelGet(): void {
  const config = getModelConfig();
  console.log(pc.bold("\nModel Configuration:\n"));
  console.log(`  Default: ${config.defaultModel || pc.dim("(gateway decides)")}`);

  if (Object.keys(config.agentModels).length > 0) {
    console.log(pc.bold("\n  Per-agent models:"));
    for (const [role, model] of Object.entries(config.agentModels)) {
      console.log(`    ${role}: ${model}`);
    }
  }

  if (config.fallbackChain.length > 0) {
    console.log(`\n  Fallback chain: ${config.fallbackChain.join(" → ")}`);
  }

  console.log(pc.bold("\n  Resolved models per role:"));
  for (const role of KNOWN_AGENT_ROLES) {
    const resolved = resolveModelForAgent(role);
    console.log(`    ${role}: ${resolved || pc.dim("(gateway decides)")}`);
  }
  console.log();
}

async function runModelSet(args: string[]): Promise<void> {
  // teamclaw model set --agent <role> <model>
  const agentIdx = args.indexOf("--agent");
  if (agentIdx !== -1) {
    const role = args[agentIdx + 1];
    const model = args[agentIdx + 2];
    if (!role || !model) {
      logger.error("Usage: teamclaw model set --agent <role> <model>");
      process.exit(1);
    }
    persistAgentModel(role, model);
    logger.success(`${role} model set to: ${model}`);
    return;
  }

  // teamclaw model set <model>
  const model = args[0];
  if (!model) {
    logger.error("Usage: teamclaw model set <model>");
    process.exit(1);
  }
  persistDefaultModel(model);
  logger.success(`Default model set to: ${model}`);
}

function runModelReset(): void {
  resetAgentModels();

  // Clear persisted agent models from global config
  const existing = readGlobalConfig() ?? buildDefaultGlobalConfig();
  if (existing.agentModels && Object.keys(existing.agentModels).length > 0) {
    const updated = { ...existing };
    delete updated.agentModels;
    writeGlobalConfig(updated);
  }

  clearModelConfigCache();
  logger.success("All model overrides cleared.");
}

function persistDefaultModel(model: string): void {
  // Update runtime
  setDefaultModel(model);
  setOpenClawModel(model);

  // Persist to global config
  const existing = readGlobalConfig() ?? buildDefaultGlobalConfig();
  const updated: TeamClawGlobalConfig = { ...existing, model };
  writeGlobalConfig(updated);
}

function persistAgentModel(role: string, model: string): void {
  const normalizedRole = role.trim().toLowerCase();

  // Update runtime
  setAgentModel(normalizedRole, model);

  // Persist to global config
  const existing = readGlobalConfig() ?? buildDefaultGlobalConfig();
  const agentModels = { ...(existing.agentModels ?? {}) };

  if (model.trim()) {
    agentModels[normalizedRole] = model.trim();
  } else {
    delete agentModels[normalizedRole];
  }

  const updated: TeamClawGlobalConfig = {
    ...existing,
    agentModels: Object.keys(agentModels).length > 0 ? agentModels : undefined,
  };
  writeGlobalConfig(updated);

  // Refresh config cache
  setConfigAgentModels(agentModels);
}
