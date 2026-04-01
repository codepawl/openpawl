/**
 * Register all TeamClaw TUI slash commands.
 */
import type { CommandRegistry } from "../../tui/index.js";
import type { AppLayout } from "../layout.js";
import type { SessionManager } from "../session.js";
import { createStatusCommand } from "./status.js";
import { createConfigCommand } from "./config.js";
import { createModelCommand } from "./model.js";
import { createJournalCommand } from "./journal.js";
import { createCostCommand } from "./cost.js";
import { createSessionsCommand } from "./sessions.js";
import { createWorkCommand } from "./work.js";

export function registerAllCommands(
  registry: CommandRegistry,
  layout: AppLayout,
  session: SessionManager,
): void {
  registry.register(createWorkCommand(layout));
  registry.register(createStatusCommand());
  registry.register(createConfigCommand());
  registry.register(createModelCommand());
  registry.register(createJournalCommand());
  registry.register(createCostCommand(session));
  registry.register(createSessionsCommand());
}
