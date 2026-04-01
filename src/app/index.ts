/**
 * TeamClaw TUI application entry point.
 * Launched when user runs `teamclaw` with no subcommand.
 */

import { createLayout } from "./layout.js";
import {
  CommandRegistry,
  parseInput,
  createBuiltinCommands,
} from "../tui/index.js";
import { registerAllCommands } from "./commands/index.js";
import { SessionManager } from "./session.js";
import { createAutocompleteProvider } from "./autocomplete.js";
import { resolveFileRef } from "./file-ref.js";
import { executeShell } from "./shell.js";

/**
 * Launch the interactive TUI.
 * Blocks until the user exits (Ctrl+C, /quit, Ctrl+D).
 */
export async function launchTUI(): Promise<void> {
  const layout = createLayout();
  const registry = new CommandRegistry();
  const session = new SessionManager();

  // Register built-in commands (/help, /clear, /quit)
  for (const cmd of createBuiltinCommands(() => registry)) {
    registry.register(cmd);
  }

  // Register TeamClaw-specific commands
  registerAllCommands(registry, layout, session);

  // Set up autocomplete
  layout.editor.setAutocompleteProvider(
    createAutocompleteProvider(registry, process.cwd()),
  );

  // Handle editor submit
  layout.editor.onSubmit = async (text: string) => {
    layout.editor.pushHistory(text);
    const parsed = parseInput(text);

    const ctx = {
      addMessage: (role: string, content: string) => {
        layout.messages.addMessage({
          role: role as "system" | "user" | "error" | "assistant" | "agent" | "tool",
          content,
          timestamp: new Date(),
        });
        session.append({ role, content });
        layout.tui.requestRender();
      },
      requestRender: () => layout.tui.requestRender(),
      exit: () => {
        session.close();
        layout.tui.stop();
      },
    };

    switch (parsed.type) {
      case "command": {
        const result = registry.lookup(`/${parsed.name} ${parsed.args}`);
        if (result) {
          await result.command.execute(result.args, ctx);
        } else {
          ctx.addMessage("error", `Unknown command: /${parsed.name}. Type /help for commands.`);
        }
        break;
      }

      case "shell": {
        ctx.addMessage("system", `$ ${parsed.command}`);
        layout.messages.addMessage({ role: "tool", content: "", timestamp: new Date() });
        await executeShell(parsed.command, (chunk) => {
          layout.messages.appendToLast(chunk);
          layout.tui.requestRender();
        });
        break;
      }

      case "file_ref": {
        const file = resolveFileRef(parsed.path, process.cwd());
        if ("error" in file) {
          ctx.addMessage("error", file.error);
        } else {
          ctx.addMessage("system", `📎 ${file.path}\n\`\`\`${file.language}\n${file.content}\n\`\`\``);
        }
        break;
      }

      case "message": {
        ctx.addMessage("user", text);
        ctx.addMessage("system", "Use /work <goal> to start, or /help for commands.");
        break;
      }
    }
  };

  // Welcome message
  let versionStr = "0.0.1";
  try {
    const { createRequire } = await import("node:module");
    const require = createRequire(import.meta.url);
    const pkg = require("../../package.json") as { version: string };
    versionStr = pkg.version;
  } catch {
    // Use default version
  }
  layout.messages.addMessage({
    role: "system",
    content: `TeamClaw v${versionStr} | Type /work <goal> to start, /help for commands.`,
    timestamp: new Date(),
  });
  layout.statusBar.setLeft("TeamClaw", "Ready");
  layout.statusBar.setRight("/help for commands");

  // Graceful shutdown on any exit
  const cleanup = () => {
    session.close();
    layout.tui.stop();
  };
  layout.tui.onExit = cleanup;

  // Start the TUI
  layout.tui.start();

  // Block until exit
  await new Promise<void>((resolve) => {
    const origExit = layout.tui.onExit;
    layout.tui.onExit = () => {
      origExit?.();
      resolve();
    };
  });
}
