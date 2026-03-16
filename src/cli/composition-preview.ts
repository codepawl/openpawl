/**
 * CLI composition preview — shows active/excluded agents and lets the user
 * approve, edit, or switch to manual mode before the graph starts.
 */

import { select, multiselect, isCancel } from "@clack/prompts";
import pc from "picocolors";
import { logger } from "../core/logger.js";
import type {
  TeamComposition,
  CompositionOverride,
  AnyAgentRole,
  ActiveAgent,
  ExcludedAgent,
} from "../agents/composition/types.js";
import { REQUIRED_AGENTS } from "../agents/composition/types.js";

/**
 * Render a table of active and excluded agents to the terminal.
 */
export function renderCompositionTable(composition: TeamComposition): void {
  logger.plain("");
  logger.plain(pc.bold("  Autonomous Team Composition"));
  logger.plain(pc.dim(`  Confidence: ${(composition.overallConfidence * 100).toFixed(0)}%`));
  logger.plain("");

  logger.plain(pc.green("  Active Agents:"));
  for (const agent of composition.activeAgents) {
    const conf = `${(agent.confidence * 100).toFixed(0)}%`;
    const required = (REQUIRED_AGENTS as readonly string[]).includes(agent.role) ? pc.dim(" (required)") : "";
    logger.plain(`    ${pc.green("+")} ${agent.role}${required} — ${agent.reason} ${pc.dim(`[${conf}]`)}`);
  }

  if (composition.excludedAgents.length > 0) {
    logger.plain("");
    logger.plain(pc.yellow("  Excluded Agents:"));
    for (const agent of composition.excludedAgents) {
      logger.plain(`    ${pc.yellow("-")} ${agent.role} — ${agent.reason}`);
    }
  }
  logger.plain("");
}

export type CompositionAction = {
  action: "approve" | "edit" | "manual";
  overrides?: CompositionOverride[];
};

/**
 * Prompt the user to approve, edit agents, or switch to manual mode.
 */
export async function promptCompositionAction(
  composition: TeamComposition,
): Promise<CompositionAction> {
  const action = await select({
    message: "Team composition",
    options: [
      { value: "approve", label: "Approve — use this composition" },
      { value: "edit", label: "Edit — toggle agents on/off" },
      { value: "manual", label: "Switch to manual — activate all agents" },
    ],
  });

  if (isCancel(action) || action === "manual") {
    return { action: "manual" };
  }

  if (action === "approve") {
    return { action: "approve" };
  }

  // Edit mode — let user toggle excluded agents on and active optional agents off
  const overrides = await promptEditAgents(composition);
  return { action: "edit", overrides };
}

async function promptEditAgents(
  composition: TeamComposition,
): Promise<CompositionOverride[]> {
  const toggleOptions: Array<{ value: string; label: string; hint?: string }> = [];

  // Show excluded agents that could be included
  for (const agent of composition.excludedAgents) {
    toggleOptions.push({
      value: `include:${agent.role}`,
      label: `Include ${agent.role}`,
      hint: agent.reason,
    });
  }

  // Show active optional agents that could be excluded
  for (const agent of composition.activeAgents) {
    if ((REQUIRED_AGENTS as readonly string[]).includes(agent.role)) continue;
    toggleOptions.push({
      value: `exclude:${agent.role}`,
      label: `Exclude ${agent.role}`,
      hint: agent.reason,
    });
  }

  if (toggleOptions.length === 0) {
    logger.plain(pc.dim("  No optional agents to toggle."));
    return [];
  }

  const selected = await multiselect({
    message: "Select agents to toggle:",
    options: toggleOptions,
    required: false,
  });

  if (isCancel(selected)) return [];

  const overrides: CompositionOverride[] = [];
  for (const val of selected as string[]) {
    const [actionStr, role] = val.split(":");
    if (actionStr === "include" || actionStr === "exclude") {
      overrides.push({ role: role as AnyAgentRole, action: actionStr });
    }
  }

  return overrides;
}

/**
 * Apply overrides to a composition, moving agents between active/excluded.
 * Required agents cannot be excluded.
 */
export function applyOverrides(
  composition: TeamComposition,
  overrides: CompositionOverride[],
): TeamComposition {
  const active = new Map<AnyAgentRole, ActiveAgent>(
    composition.activeAgents.map((a) => [a.role, a]),
  );
  const excluded = new Map<AnyAgentRole, ExcludedAgent>(
    composition.excludedAgents.map((a) => [a.role, a]),
  );

  for (const override of overrides) {
    // Never exclude required agents
    if (override.action === "exclude" && (REQUIRED_AGENTS as readonly string[]).includes(override.role)) {
      continue;
    }

    if (override.action === "include") {
      const ex = excluded.get(override.role);
      if (ex) {
        excluded.delete(override.role);
        active.set(override.role, {
          role: override.role,
          reason: "Manually included",
          confidence: 0.5,
        });
      }
    } else if (override.action === "exclude") {
      const act = active.get(override.role);
      if (act) {
        active.delete(override.role);
        excluded.set(override.role, {
          role: override.role,
          reason: "Manually excluded",
        });
      }
    }
  }

  const activeAgents = Array.from(active.values());
  const excludedAgents = Array.from(excluded.values());
  const overallConfidence =
    activeAgents.length > 0
      ? Math.round(
          (activeAgents.reduce((s, a) => s + a.confidence, 0) / activeAgents.length) * 100,
        ) / 100
      : 0;

  return {
    ...composition,
    activeAgents,
    excludedAgents,
    overallConfidence,
  };
}
