/**
 * Register OpenPawl TUI slash commands.
 *
 * Only CONTROL actions are slash commands. Natural language input
 * (goals, questions) goes directly to the agent pipeline.
 */
import type { CommandRegistry } from "../../tui/index.js";
import type { SessionManager } from "../session.js";
import { createStatusCommand } from "./status.js";
import { createSettingsCommand } from "./settings.js";
import { createModelCommand } from "./model.js";
import { createModeCommand } from "./mode.js";
import { createCostCommand } from "./cost.js";
import { createSessionsCommand } from "./sessions.js";
import { createHotkeysCommand } from "./hotkeys.js";
import { createErrorCommand } from "./error.js";
import { createSetupCommand } from "./setup.js";

export function registerAllCommands(
  registry: CommandRegistry,
  session: SessionManager,
): void {
  registry.register(createStatusCommand());
  registry.register(createSettingsCommand());
  registry.register(createModelCommand());
  registry.register(createModeCommand());
  registry.register(createCostCommand(session));
  registry.register(createSessionsCommand());
  registry.register(createHotkeysCommand());
  registry.register(createErrorCommand());
  registry.register(createSetupCommand());
}
