/**
 * Interactive model management sub-menu for `teamclaw config`.
 */

import {
  cancel,
  isCancel,
  note,
  select,
  text,
  confirm,
  spinner,
} from "@clack/prompts";
import pc from "picocolors";
import {
  persistDefaultModel,
  persistAgentModel,
  resetAllModelOverrides,
  persistFallbackChain,
  persistAlias,
  removeAlias as removePersistedAlias,
  persistAllowlist,
  getModelSummary,
  resolveModelForAgent,
  type ModelSummary,
} from "../../core/model-operations.js";
import { listAvailableModels } from "../../core/model-config.js";

const KNOWN_AGENT_ROLES = [
  "coordinator",
  "planner",
  "architect",
  "rfc",
  "analyst",
  "retrospective",
  "worker",
];

function handleCancel<T>(v: T): T {
  if (isCancel(v)) {
    cancel("Cancelled.");
    process.exit(0);
  }
  return v;
}

async function pickModel(
  message: string,
  available: string[],
  allowDefault?: boolean,
): Promise<string | null> {
  const options = [];
  if (allowDefault) {
    options.push({ value: "__default__", label: pc.dim("Use default model") });
  }
  for (const m of available) {
    options.push({ value: m, label: m });
  }
  options.push({ value: "__custom__", label: pc.dim("Enter custom model ID...") });

  const picked = handleCancel(await select({ message, options })) as string;

  if (picked === "__default__") return null;
  if (picked === "__custom__") {
    const custom = handleCancel(
      await text({ message: "Enter model ID:", placeholder: "provider/model-name" }),
    ) as string;
    return custom.trim() || null;
  }
  return picked;
}

async function setDefaultModelMenu(summary: ModelSummary): Promise<void> {
  const model = await pickModel(
    `Set Default Model (current: ${summary.defaultModel || pc.dim("gateway decides")})`,
    summary.availableModels,
  );
  if (model) {
    persistDefaultModel(model);
    note(`Default model set to: ${model}`, "Updated");
  }
}

async function setAgentModelMenu(summary: ModelSummary): Promise<void> {
  const role = handleCancel(
    await select({
      message: "Select agent role:",
      options: KNOWN_AGENT_ROLES.map((r) => ({
        value: r,
        label: `${r} ${pc.dim(`(current: ${resolveModelForAgent(r) || "default"})`)}`,
      })),
    }),
  ) as string;

  const model = await pickModel(
    `Select model for ${role}:`,
    summary.availableModels,
    true,
  );

  persistAgentModel(role, model ?? "");
  if (model) {
    note(`${role} model set to: ${model}`, "Updated");
  } else {
    note(`${role} will now use the default model.`, "Updated");
  }
}

async function editFallbackChainMenu(summary: ModelSummary): Promise<void> {
  const current = summary.fallbackChain;
  note(
    current.length > 0
      ? `Current chain: ${current.join(" -> ")}`
      : "No fallback chain configured.",
    "Fallback Chain",
  );

  const action = handleCancel(
    await select({
      message: "Fallback chain action:",
      options: [
        { value: "add", label: "Add model to chain" },
        { value: "remove", label: "Remove model from chain" },
        { value: "clear", label: "Clear entire chain" },
        { value: "back", label: "Back" },
      ],
    }),
  ) as string;

  if (action === "back") return;

  if (action === "clear") {
    persistFallbackChain([]);
    note("Fallback chain cleared.", "Updated");
    return;
  }

  if (action === "add") {
    const model = await pickModel("Add model to fallback chain:", summary.availableModels);
    if (model) {
      const updated = [...current, model];
      persistFallbackChain(updated);
      note(`Chain: ${updated.join(" -> ")}`, "Updated");
    }
    return;
  }

  if (action === "remove" && current.length > 0) {
    const toRemove = handleCancel(
      await select({
        message: "Remove which model?",
        options: current.map((m, i) => ({ value: String(i), label: m })),
      }),
    ) as string;
    const idx = Number(toRemove);
    if (Number.isInteger(idx) && idx >= 0 && idx < current.length) {
      const updated = current.filter((_, i) => i !== idx);
      persistFallbackChain(updated);
      note(
        updated.length > 0 ? `Chain: ${updated.join(" -> ")}` : "Chain is now empty.",
        "Updated",
      );
    }
  }
}

async function manageAliasesMenu(summary: ModelSummary): Promise<void> {
  const aliases = summary.aliases;
  const entries = Object.entries(aliases);

  note(
    entries.length > 0
      ? entries.map(([a, m]) => `  ${a} -> ${m}`).join("\n")
      : "No aliases configured.",
    "Model Aliases",
  );

  const action = handleCancel(
    await select({
      message: "Alias action:",
      options: [
        { value: "add", label: "Add alias" },
        ...(entries.length > 0 ? [{ value: "remove", label: "Remove alias" }] : []),
        { value: "back", label: "Back" },
      ],
    }),
  ) as string;

  if (action === "back") return;

  if (action === "add") {
    const alias = handleCancel(
      await text({ message: "Alias name:", placeholder: "fast" }),
    ) as string;
    if (!alias.trim()) return;
    const model = await pickModel(`Target model for "${alias.trim()}":`, summary.availableModels);
    if (model) {
      persistAlias(alias.trim(), model);
      note(`Alias "${alias.trim()}" -> ${model}`, "Updated");
    }
    return;
  }

  if (action === "remove" && entries.length > 0) {
    const toRemove = handleCancel(
      await select({
        message: "Remove which alias?",
        options: entries.map(([a, m]) => ({ value: a, label: `${a} -> ${m}` })),
      }),
    ) as string;
    removePersistedAlias(toRemove);
    note(`Alias "${toRemove}" removed.`, "Updated");
  }
}

async function configureAllowlistMenu(summary: ModelSummary): Promise<void> {
  const current = summary.allowlist;
  note(
    current.length > 0
      ? `Allowed models:\n${current.map((m) => `  ${m}`).join("\n")}`
      : "No allowlist configured (all models allowed).",
    "Model Allowlist",
  );

  const action = handleCancel(
    await select({
      message: "Allowlist action:",
      options: [
        { value: "add", label: "Add model to allowlist" },
        ...(current.length > 0 ? [{ value: "remove", label: "Remove model from allowlist" }] : []),
        { value: "clear", label: "Clear allowlist (allow all)" },
        { value: "back", label: "Back" },
      ],
    }),
  ) as string;

  if (action === "back") return;

  if (action === "clear") {
    persistAllowlist([]);
    note("Allowlist cleared. All models are now allowed.", "Updated");
    return;
  }

  if (action === "add") {
    const model = await pickModel("Add model to allowlist:", summary.availableModels);
    if (model) {
      const updated = [...new Set([...current, model])];
      persistAllowlist(updated);
      note(`Allowlist: ${updated.join(", ")}`, "Updated");
    }
    return;
  }

  if (action === "remove" && current.length > 0) {
    const toRemove = handleCancel(
      await select({
        message: "Remove which model?",
        options: current.map((m) => ({ value: m, label: m })),
      }),
    ) as string;
    const updated = current.filter((m) => m !== toRemove);
    persistAllowlist(updated);
    note(
      updated.length > 0 ? `Allowlist: ${updated.join(", ")}` : "Allowlist cleared.",
      "Updated",
    );
  }
}

function viewResolutionSummary(summary: ModelSummary): void {
  const lines = KNOWN_AGENT_ROLES.map((role) => {
    const resolved = resolveModelForAgent(role);
    return `  ${role}: ${resolved || pc.dim("(gateway decides)")}`;
  });
  note(
    [
      `Default: ${summary.defaultModel || pc.dim("(gateway decides)")}`,
      "",
      pc.bold("Per-role resolution:"),
      ...lines,
    ].join("\n"),
    "Model Resolution Summary",
  );
}

export async function modelManagementMenu(): Promise<void> {
  let back = false;
  while (!back) {
    const s = spinner();
    s.start("Loading model configuration...");
    const summary = await getModelSummary();
    s.stop("Model configuration loaded.");

    const choice = handleCancel(
      await select({
        message: "Model Management",
        options: [
          { value: "default", label: `Set Default Model (${summary.defaultModel || "not set"})` },
          { value: "agent", label: "Set Per-Agent Model" },
          { value: "fallback", label: `Edit Fallback Chain (${summary.fallbackChain.length} models)` },
          { value: "aliases", label: `Manage Aliases (${Object.keys(summary.aliases).length} defined)` },
          { value: "allowlist", label: `Configure Allowlist (${summary.allowlist.length > 0 ? summary.allowlist.length + " models" : "off"})` },
          { value: "summary", label: "View Resolution Summary" },
          { value: "reset", label: pc.red("Reset All Overrides") },
          { value: "back", label: "Back to Main Menu" },
        ],
      }),
    ) as string;

    if (choice === "back") { back = true; continue; }
    if (choice === "default") { await setDefaultModelMenu(summary); continue; }
    if (choice === "agent") { await setAgentModelMenu(summary); continue; }
    if (choice === "fallback") { await editFallbackChainMenu(summary); continue; }
    if (choice === "aliases") { await manageAliasesMenu(summary); continue; }
    if (choice === "allowlist") { await configureAllowlistMenu(summary); continue; }
    if (choice === "summary") { viewResolutionSummary(summary); continue; }
    if (choice === "reset") {
      const doReset = handleCancel(
        await confirm({ message: "Clear all model overrides?", initialValue: false }),
      ) as boolean;
      if (doReset) {
        resetAllModelOverrides();
        note("All model overrides cleared.", "Reset");
      }
    }
  }
}
