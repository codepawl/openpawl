/**
 * `openpawl model` — Manage model configuration.
 *
 * Subcommands:
 *   (none)        Interactive dashboard
 *   list          Show available models
 *   get           Show current model config
 *   set <model>   Set global default model
 *   set --agent <role> <model>  Set per-agent model
 *   reset         Clear all overrides
 *   refresh       Re-fetch models from all configured providers
 */

import pc from "picocolors";
import { ICONS } from "../tui/constants/icons.js";
import { cancel, isCancel, note, select, text } from "@clack/prompts";
import { clampSelectOptions } from "../utils/searchable-select.js";
import { logger } from "../core/logger.js";
import {
  getModelConfig,
  listAvailableModels,
  resolveModelForAgent,
} from "../core/model-config.js";
import {
  getActiveProviderName,
  getActiveModel,
} from "../core/provider-config.js";
import {
  persistDefaultModel,
  persistAgentModel,
  resetAllModelOverrides,
} from "../core/model-operations.js";

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
  logger.warn(pc.yellow("Note: openpawl model is moving into openpawl config"));
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

  if (sub === "refresh") {
    await runModelRefresh(args.slice(1));
    return;
  }

  logger.error(`Unknown subcommand: model ${sub}`);
  logger.error("Usage: openpawl model | model list | model get | model set <model> | model set --agent <role> <model> | model reset | model refresh");
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
    options: clampSelectOptions([
      { value: "set-default", label: "Set default model" },
      { value: "set-agent", label: "Set model for a specific agent" },
      { value: "list", label: "List available models" },
      { value: "reset", label: "Reset all overrides" },
      { value: "exit", label: "Exit" },
    ]),
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
        maxItems: 12,
        options: clampSelectOptions([
          ...models.map((m) => ({ value: m, label: m })),
          { value: "__custom__", label: pc.dim("Enter custom model ID...") },
        ]),
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
      options: clampSelectOptions(KNOWN_AGENT_ROLES.map((r) => ({
        value: r,
        label: `${r} ${pc.dim(`(current: ${resolveModelForAgent(r) || "default"})`)}`,
      }))),
    });
    if (isCancel(role)) { cancel("Cancelled."); return; }

    const models = await listAvailableModels();
    let model: string;
    if (models.length > 0) {
      const picked = await select({
        message: `Select model for ${role as string}:`,
        options: clampSelectOptions([
          { value: "__default__", label: pc.dim("Use default model") },
          ...models.map((m) => ({ value: m, label: m })),
          { value: "__custom__", label: pc.dim("Enter custom model ID...") },
        ]),
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
    logger.warn("No models discovered. Check your provider configuration with `openpawl setup`.");
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

  console.log(pc.bold("\nActive Configuration:\n"));
  console.log(`  Provider: ${getActiveProviderName() || pc.dim("(none)")}`);
  console.log(`  Model:    ${getActiveModel() || pc.dim("(gateway decides)")}`);

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
  // openpawl model set --agent <role> <model>
  const agentIdx = args.indexOf("--agent");
  if (agentIdx !== -1) {
    const role = args[agentIdx + 1];
    const model = args[agentIdx + 2];
    if (!role || !model) {
      logger.error("Usage: openpawl model set --agent <role> <model>");
      process.exit(1);
    }
    persistAgentModel(role, model);
    logger.success(`${role} model set to: ${model}`);
    return;
  }

  // openpawl model set <model>
  const model = args[0];
  if (!model) {
    logger.error("Usage: openpawl model set <model>");
    process.exit(1);
  }
  persistDefaultModel(model);
  logger.success(`Default model set to: ${model}`);
}

function runModelReset(): void {
  resetAllModelOverrides();
  logger.success("All model overrides cleared.");
}

async function runModelRefresh(args: string[]): Promise<void> {
  const { fetchModelsForProvider } = await import("../providers/model-fetcher.js");
  const { clearCache, setCachedModels } = await import("../providers/model-cache.js");
  const { listProviders } = await import("../core/provider-config.js");

  const providerFilter = args.includes("--provider") ? args[args.indexOf("--provider") + 1] : undefined;

  const providers = listProviders();

  if (providers.length === 0) {
    logger.warn("No providers configured. Run `openpawl setup` first.");
    return;
  }

  const targets = providerFilter
    ? providers.filter((p) => p.type === providerFilter)
    : providers;

  if (targets.length === 0) {
    logger.error(`Provider "${providerFilter}" not found in config.`);
    return;
  }

  // Clear relevant caches
  if (providerFilter) {
    await clearCache(providerFilter);
  } else {
    await clearCache();
  }

  logger.plain("\nRefreshing models...\n");

  for (const entry of targets) {
    const result = await fetchModelsForProvider(
      entry.type,
      entry.apiKey ?? "",
      entry.baseURL,
    );

    if (result.source === "live" && result.models.length > 0) {
      const ids = result.models.map((m) => m.id);
      await setCachedModels(entry.type, ids);
      const count = result.models.length;
      const suffix = count > 50 ? ` (showing top 50)` : "";
      logger.plain(`  ${pc.green(ICONS.success)} ${entry.type.padEnd(16)} ${count} models fetched${suffix}`);
    } else if (result.source === "fallback" && !result.error) {
      logger.plain(`  ${pc.dim("-")} ${entry.type.padEnd(16)} ${pc.dim("Skipped (cloud credentials)")}`);
    } else {
      logger.plain(`  ${pc.red(ICONS.error)} ${entry.type.padEnd(16)} ${pc.dim(result.error ?? "No models found")}`);
    }
  }

  logger.plain("");
}
