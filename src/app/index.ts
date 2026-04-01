/**
 * TeamClaw TUI application entry point.
 * Launched when user runs `teamclaw` with no subcommand.
 */

import { createLayout } from "./layout.js";
import {
  CommandRegistry,
  parseInput,
  createBuiltinCommands,
  type Terminal,
} from "../tui/index.js";
import { registerAllCommands } from "./commands/index.js";
import { SessionManager } from "./session.js";
import { createAutocompleteProvider } from "./autocomplete.js";
import { resolveFileRef } from "./file-ref.js";
import { executeShell } from "./shell.js";

import type { AppLayout } from "./layout.js";

/**
 * Handle natural language input — route to the work pipeline.
 * This is the primary interaction: user types goals/questions, agent works on them.
 */
async function handleNaturalInput(
  text: string,
  layout: AppLayout,
  ctx: { addMessage: (role: string, content: string) => void },
): Promise<void> {
  const { workerEvents } = await import("../core/worker-events.js");

  let streamingActive = false;
  const onChunk = (data: { botId: string; chunk: string }) => {
    if (!streamingActive) {
      layout.messages.addMessage({ role: "assistant", content: "", timestamp: new Date() });
      streamingActive = true;
    }
    layout.messages.appendToLast(data.chunk);
    layout.tui.requestRender();
  };
  const onReasoning = (data: { botId: string; reasoning: string }) => {
    const preview = data.reasoning.slice(0, 200).replace(/\n/g, " ");
    layout.messages.addMessage({
      role: "agent",
      agentName: data.botId,
      content: `thinking: ${preview}${data.reasoning.length > 200 ? "..." : ""}`,
      timestamp: new Date(),
    });
    layout.tui.requestRender();
  };

  workerEvents.on("stream-chunk", onChunk);
  workerEvents.on("reasoning", onReasoning);

  layout.statusBar.setLeft("TeamClaw", "Working...");
  layout.tui.requestRender();

  try {
    const { runWork } = await import("../work-runner.js");
    await runWork({ goal: text.trim(), noWeb: true, args: [] });
    streamingActive = false;
    ctx.addMessage("system", "Done.");
  } catch (err) {
    streamingActive = false;
    const msg = err instanceof Error ? err.message : String(err);
    if (err instanceof Error && err.name === "UserCancelError") {
      ctx.addMessage("system", "Cancelled.");
    } else {
      ctx.addMessage("error", `Failed: ${msg}`);
    }
  } finally {
    workerEvents.off("stream-chunk", onChunk);
    workerEvents.off("reasoning", onReasoning);
    layout.statusBar.setLeft("TeamClaw", "Ready");
    layout.tui.requestRender();
  }
}

export interface LaunchOptions {
  /** Custom terminal for testing (VirtualTerminal). */
  terminal?: Terminal;
  /** Custom sessions directory for testing. */
  sessionsDir?: string;
  /** Resume the most recent TUI session. */
  resume?: boolean;
}

/**
 * Launch the interactive TUI.
 * Blocks until the user exits (Ctrl+C, /quit, Ctrl+D).
 */
export async function launchTUI(opts?: LaunchOptions): Promise<void> {
  const layout = createLayout(opts?.terminal);
  const registry = new CommandRegistry();
  const session = new SessionManager(opts?.sessionsDir);

  // Register built-in commands (/help, /clear, /quit)
  for (const cmd of createBuiltinCommands(() => registry)) {
    registry.register(cmd);
  }

  // Register control commands (natural language goes to agent pipeline)
  registerAllCommands(registry, session);

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
        // Natural language → send to agent pipeline
        ctx.addMessage("user", text);
        await handleNaturalInput(text, layout, ctx);
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
    content: `TeamClaw v${versionStr} — just type what you want to build. /help for commands.`,
    timestamp: new Date(),
  });
  layout.statusBar.setLeft("TeamClaw", "Ready");
  layout.statusBar.setRight("/help");

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

/**
 * Non-interactive print mode.
 * Runs a command and outputs the result to stdout, then exits.
 */
export async function runPrintMode(prompt: string): Promise<void> {
  const parsed = parseInput(prompt);

  if (parsed.type === "command" && parsed.name === "work") {
    // Reuse existing CLI work command
    const { runWork } = await import("../work-runner.js");
    await runWork({ goal: parsed.args.trim(), noWeb: true, args: [] });
    return;
  }

  if (parsed.type === "command" && parsed.name === "status") {
    const { getGlobalProviderManager } = await import("../providers/provider-factory.js");
    const pm = getGlobalProviderManager();
    for (const p of pm.getProviders()) {
      const ok = await p.healthCheck().catch(() => false);
      console.log(`${p.name}: ${p.isAvailable() ? "available" : "unavailable"} health=${ok ? "ok" : "fail"}`);
    }
    return;
  }

  // Default: treat as a work goal
  if (prompt.trim()) {
    const { runWork } = await import("../work-runner.js");
    await runWork({ goal: prompt.trim(), noWeb: true, args: [] });
    return;
  }

  console.log("Usage: teamclaw -p <prompt>");
  console.log('  teamclaw -p "/work build auth"');
  console.log('  teamclaw -p "build auth"');
}
