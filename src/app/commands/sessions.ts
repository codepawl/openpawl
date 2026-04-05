/**
 * /sessions command — list recent TUI sessions.
 */
import type { SlashCommand } from "../../tui/index.js";
import { SessionManager } from "../session.js";

export function createSessionsCommand(): SlashCommand {
  return {
    name: "sessions",
    description: "List recent sessions",
    async execute(_args, ctx) {
      const recent = SessionManager.getRecent(10);

      if (recent.length === 0) {
        ctx.addMessage("system", "No previous sessions found.");
        return;
      }

      const maxIdLen = Math.max(...recent.map((s) => s.sessionId.length));
      const lines = recent.map((s) => {
        const date = new Date(s.startedAt).toLocaleString();
        return `  ${s.sessionId.padEnd(maxIdLen + 2)}${date}  (${s.messageCount} messages)`;
      });

      ctx.addMessage("system", `Recent sessions:\n\n${lines.join("\n")}`);
    },
  };
}
