/**
 * Register OpenPawl TUI slash commands.
 *
 * Only CONTROL actions are slash commands. Natural language input
 * (goals, questions) goes directly to the agent pipeline.
 */
import type { CommandRegistry } from "../../tui/index.js";
import { createStatusCommand } from "./status.js";
import { createSettingsCommand } from "./settings.js";
import { createModelCommand } from "./model.js";
import { createModeCommand } from "./mode.js";
import { createHotkeysCommand } from "./hotkeys.js";
import { createErrorCommand } from "./error.js";
import { createCompactCommand, type CompactCommandDeps } from "./compact.js";
import { createSetupCommand } from "./setup.js";
import { createDebateCommand } from "./debate.js";
import { createResearchCommand } from "./research.js";
import { createDevCommand } from "./dev.js";
import { createWorkspaceCommand } from "./workspace.js";
export { createPlanCommand, type PlanCommandDeps } from "./plan.js";

export function registerAllCommands(
  registry: CommandRegistry,
  compactDeps?: CompactCommandDeps,
): void {
  registry.register(createStatusCommand());
  registry.register(createSettingsCommand());
  registry.register(createModelCommand());
  registry.register(createModeCommand());
  registry.register(createHotkeysCommand());
  registry.register(createErrorCommand());
  registry.register(createSetupCommand());
  registry.register(createDebateCommand());
  registry.register(createResearchCommand());
  registry.register(createDevCommand());
  registry.register(createWorkspaceCommand());
  // /plan and /execute registered later in app/index.ts after modeSystem is created
  if (compactDeps) {
    registry.register(createCompactCommand(compactDeps));
  }
}
