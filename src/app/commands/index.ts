/**
 * Register TeamClaw TUI slash commands.
 *
 * Only CONTROL actions are slash commands. Natural language input
 * (goals, questions) goes directly to the agent pipeline.
 */
import type { CommandRegistry } from "../../tui/index.js";
import type { SessionManager } from "../session.js";
import { createStatusCommand } from "./status.js";
import { createConfigCommand } from "./config.js";
import { createModelCommand } from "./model.js";
import { createCostCommand } from "./cost.js";
import { createSessionsCommand } from "./sessions.js";

export function registerAllCommands(
  registry: CommandRegistry,
  session: SessionManager,
): void {
  // Control commands only — natural language handled by prompt-handler
  registry.register(createStatusCommand());
  registry.register(createConfigCommand());
  registry.register(createModelCommand());
  registry.register(createCostCommand(session));
  registry.register(createSessionsCommand());
}
