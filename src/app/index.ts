/**
 * OpenPawl TUI application entry point.
 * Launched when user runs `openpawl` with no subcommand.
 *
 * Wires the existing TUI framework (src/tui/) to:
 *   - SessionManager (src/session/) for persistent session state
 *   - PromptRouter (src/router/) for intent classification + agent dispatch
 */

import { createLayout } from "./layout.js";
import {
  CommandRegistry,
  parseInput,
  createBuiltinCommands,
  type Terminal,
} from "../tui/index.js";
import { registerAllCommands } from "./commands/index.js";
import { SessionManager as TuiSessionManager } from "./session.js";
import { createAutocompleteProvider } from "./autocomplete.js";
import { resolveFileRef } from "./file-ref.js";
import { executeShell } from "./shell.js";
import { detectConfig, showConfigWarning } from "./config-check.js";
import { setLoggerMuted } from "../core/logger.js";
import { defaultTheme, ctp } from "../tui/themes/default.js";
import { ModeSystem } from "../tui/keybindings/mode-system.js";
import { LeaderKeyHandler } from "../tui/keybindings/leader-key.js";
import { CommandPalette, type PaletteSource } from "../tui/keybindings/command-palette.js";
import { KeybindingHelp, buildHelpSections } from "../tui/keybindings/keybinding-help.js";

import type { AppLayout } from "./layout.js";

// Session + Router imports (lazy to keep startup fast)
import type { SessionManager } from "../session/session-manager.js";
import type { Session } from "../session/session.js";
import type { PromptRouter } from "../router/prompt-router.js";

// ---------------------------------------------------------------------------
// Agent color helper — maps agent IDs to theme.agentColors deterministically
// ---------------------------------------------------------------------------

const AGENT_COLOR_MAP: Record<string, number> = {
  coder: 0,
  reviewer: 1,
  planner: 4,
  tester: 3,
  debugger: 2,
  researcher: 5,
  assistant: 7,
};

function getAgentColorFn(agentId: string): (s: string) => string {
  const colors = defaultTheme.agentColors;
  const idx = AGENT_COLOR_MAP[agentId];
  if (idx !== undefined) return colors[idx % colors.length]!;
  // Hash-based fallback for custom agents
  let hash = 0;
  for (let i = 0; i < agentId.length; i++) {
    hash = ((hash << 5) - hash + agentId.charCodeAt(i)) | 0;
  }
  return colors[Math.abs(hash) % colors.length]!;
}

function agentDisplayName(agentId: string): string {
  const names: Record<string, string> = {
    coder: "Coder",
    reviewer: "Reviewer",
    planner: "Planner",
    tester: "Tester",
    debugger: "Debugger",
    researcher: "Researcher",
    assistant: "Assistant",
    system: "System",
  };
  return names[agentId] ?? agentId;
}

// ---------------------------------------------------------------------------
// Wire PromptRouter dispatch events → TUI message display
// ---------------------------------------------------------------------------

function wireRouterEvents(
  router: PromptRouter,
  layout: AppLayout,
): () => void {
  let streamingForAgent: string | null = null;

  const onAgentStart = (_sessionId: string, agentId: string) => {
    streamingForAgent = agentId;
    // Create the initial empty message for this agent — tokens will be appended to it
    layout.messages.addMessage({
      role: "agent",
      agentName: agentDisplayName(agentId),
      agentColor: getAgentColorFn(agentId),
      content: "",
      timestamp: new Date(),
    });
    layout.statusBar.updateSegment(3, `${agentDisplayName(agentId)} working...`, ctp.teal);
    layout.tui.requestRender();
  };

  const onAgentToken = (_sessionId: string, agentId: string, token: string) => {
    if (streamingForAgent !== agentId) {
      // New agent started streaming — add a labeled message
      streamingForAgent = agentId;
      layout.messages.addMessage({
        role: "agent",
        agentName: agentDisplayName(agentId),
        agentColor: getAgentColorFn(agentId),
        content: "",
        timestamp: new Date(),
      });
    }

    layout.messages.appendToLast(token);
    layout.tui.requestRender();
  };

  const onAgentTool = (_sessionId: string, agentId: string, toolName: string, status: string) => {
    const symbolFn = status === "completed" ? ctp.green
      : status === "failed" ? ctp.red
        : ctp.teal;
    const symbol = status === "completed" ? defaultTheme.symbols.success
      : status === "failed" ? defaultTheme.symbols.error
        : defaultTheme.symbols.pending;
    layout.messages.addMessage({
      role: "tool",
      content: `${symbolFn(symbol)} ${toolName} (${status})`,
      agentName: agentDisplayName(agentId),
      timestamp: new Date(),
    });
    layout.tui.requestRender();
  };

  const onAgentDone = (_sessionId: string, _agentId: string) => {
    streamingForAgent = null;
    layout.statusBar.updateSegment(3, "idle", ctp.overlay0);
    layout.tui.requestRender();
  };

  const onDispatchError = (_sessionId: string, error: { type: string }) => {
    streamingForAgent = null;
    layout.messages.addMessage({
      role: "error",
      content: `Dispatch error: ${error.type}`,
      timestamp: new Date(),
    });
    layout.statusBar.updateSegment(3, "idle", ctp.overlay0);
    layout.tui.requestRender();
  };

  router.on("dispatch:agent:start", onAgentStart);
  router.on("dispatch:agent:token", onAgentToken);
  router.on("dispatch:agent:tool", onAgentTool);
  router.on("dispatch:agent:done", onAgentDone);
  router.on("dispatch:error", onDispatchError);

  // Return cleanup function
  return () => {
    router.off("dispatch:agent:start", onAgentStart);
    router.off("dispatch:agent:token", onAgentToken);
    router.off("dispatch:agent:tool", onAgentTool);
    router.off("dispatch:agent:done", onAgentDone);
    router.off("dispatch:error", onDispatchError);
  };
}

// ---------------------------------------------------------------------------
// Wire SessionManager events → status bar updates
// ---------------------------------------------------------------------------

function wireSessionEvents(
  sessionMgr: SessionManager,
  layout: AppLayout,
): () => void {
  const onCostUpdated = (_sessionId: string, cost: { usd: number }) => {
    // Yellow when cost > $0.50, overlay0 otherwise
    const costColor = cost.usd > 0.50 ? ctp.yellow : ctp.overlay0;
    layout.statusBar.updateSegment(4, `$${cost.usd.toFixed(2)}`, costColor);
    layout.tui.requestRender();
  };

  const onMessageAdded = () => {
    // Auto-render when new messages arrive from external sources
    layout.tui.requestRender();
  };

  sessionMgr.on("cost:updated", onCostUpdated);
  sessionMgr.on("message:added", onMessageAdded);

  return () => {
    sessionMgr.off("cost:updated", onCostUpdated);
    sessionMgr.off("message:added", onMessageAdded);
  };
}

// ---------------------------------------------------------------------------
// Handle user input via PromptRouter (replaces old isWorkGoal / handleChat)
// ---------------------------------------------------------------------------

async function handleWithRouter(
  text: string,
  session: Session,
  router: PromptRouter,
  layout: AppLayout,
  ctx: { addMessage: (role: string, content: string) => void },
): Promise<void> {
  layout.statusBar.updateSegment(3, "routing...", ctp.teal);
  layout.tui.requestRender();

  const result = await router.route(session.id, text);

  if (result.isErr()) {
    ctx.addMessage("error", `Error: ${result.error.type}`);
    layout.statusBar.updateSegment(3, "idle", ctp.overlay0);
    layout.tui.requestRender();
    return;
  }

  const dispatch = result.value;

  // Display results — only for system messages and results that weren't streamed.
  // When tokens were streamed via dispatch:agent:token events, the message already
  // exists in the TUI. We skip non-system results that have token usage (indicating
  // they came from the real LLM and were streamed).
  for (const agentResult of dispatch.agentResults) {
    if (!agentResult.response) continue;

    if (agentResult.agentId === "system") {
      ctx.addMessage("system", agentResult.response);
    } else if (agentResult.inputTokens === 0 && agentResult.outputTokens === 0) {
      // No token usage = placeholder/non-LLM result, display it
      layout.messages.addMessage({
        role: "agent",
        agentName: agentDisplayName(agentResult.agentId),
        agentColor: getAgentColorFn(agentResult.agentId),
        content: agentResult.response,
        timestamp: new Date(),
      });
      layout.tui.requestRender();
    }
    // else: response was already streamed token-by-token via dispatch:agent:token
  }

  layout.statusBar.updateSegment(3, "idle", ctp.overlay0);

  // Update cost display
  const cost = session.cost;
  layout.statusBar.updateSegment(4, `$${cost.usd.toFixed(2)}`, ctp.green);
  layout.tui.requestRender();
}

// ---------------------------------------------------------------------------
// Fallback: direct LLM chat (used when router is not available)
// ---------------------------------------------------------------------------

async function handleChatFallback(
  text: string,
  layout: AppLayout,
  ctx: { addMessage: (role: string, content: string) => void },
): Promise<void> {
  layout.statusBar.updateSegment(3, "thinking...", ctp.teal);
  layout.tui.requestRender();

  try {
    const { callLLM } = await import("../engine/llm.js");
    layout.messages.addMessage({ role: "assistant", content: "", timestamp: new Date() });

    await callLLM(text, {
      systemPrompt: "You are OpenPawl, a helpful AI assistant running in a terminal. " +
        "Respond naturally and concisely. Use markdown formatting when helpful.",
      onChunk: (chunk: string) => {
        layout.messages.appendToLast(chunk);
        layout.tui.requestRender();
      },
    });
  } catch (err) {
    const { translateError } = await import("../engine/errors.js");
    const { setLastError } = await import("./commands/error.js");
    const opError = translateError(err);
    setLastError(opError);

    const lines: string[] = [`\u2717 ${opError.userMessage}`];
    if (opError.quickFixes.length > 0) {
      lines.push("");
      for (const fix of opError.quickFixes) {
        if (fix.command) lines.push(`  ${fix.command.padEnd(35)} ${fix.description}`);
        else lines.push(`  \u2022 ${fix.description}`);
      }
    }
    lines.push("");
    lines.push("  Type /error for technical details");
    ctx.addMessage("error", lines.join("\n"));
  } finally {
    layout.statusBar.updateSegment(3, "idle", ctp.overlay0);
    layout.tui.requestRender();
  }
}

// ---------------------------------------------------------------------------
// Launch options
// ---------------------------------------------------------------------------

export interface LaunchOptions {
  /** Custom terminal for testing (VirtualTerminal). */
  terminal?: Terminal;
  /** Custom sessions directory for testing. */
  sessionsDir?: string;
  /** Resume the most recent TUI session. */
  resume?: boolean;
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

/**
 * Launch the interactive TUI.
 * Blocks until the user exits (Ctrl+C, /quit, Ctrl+D).
 */
export async function launchTUI(opts?: LaunchOptions): Promise<void> {
  // Suppress logger during TUI — all messages go through layout
  setLoggerMuted(true);

  const layout = createLayout(opts?.terminal);
  const registry = new CommandRegistry();
  const tuiSession = new TuiSessionManager(opts?.sessionsDir);

  // ── Shared mutable refs for async-initialized session/router ────────
  // These are populated by initSessionRouter() after the TUI starts.
  // The onSubmit handler checks them on each invocation.
  const ctx = {
    sessionMgr: null as SessionManager | null,
    router: null as PromptRouter | null,
    chatSession: null as Session | null,
    cleanupRouter: null as (() => void) | null,
    cleanupSession: null as (() => void) | null,
  };

  // Register built-in commands (/help, /clear, /quit)
  for (const cmd of createBuiltinCommands(() => registry)) {
    registry.register(cmd);
  }

  // Register app commands (/status, /settings, /model, /mode, /cost, etc.)
  registerAllCommands(registry, tuiSession);

  // Set up autocomplete (updated later when router is ready)
  layout.editor.setAutocompleteProvider(
    createAutocompleteProvider(registry, process.cwd()),
  );

  // Handle editor submit
  layout.editor.onSubmit = async (text: string) => {
    layout.editor.pushHistory(text);
    const parsed = parseInput(text);

    const msgCtx = {
      addMessage: (role: string, content: string) => {
        layout.messages.addMessage({
          role: role as "system" | "user" | "error" | "assistant" | "agent" | "tool",
          content,
          timestamp: new Date(),
        });
        tuiSession.append({ role, content });
        if (ctx.chatSession) {
          ctx.chatSession.addMessage({ role: role as "user" | "assistant" | "system" | "tool", content });
        }
        layout.tui.requestRender();
      },
      requestRender: () => layout.tui.requestRender(),
      exit: () => {
        tuiSession.close();
        layout.tui.stop();
      },
      tui: layout.tui,
    };

    switch (parsed.type) {
      case "command": {
        if (!parsed.name) {
          msgCtx.addMessage("error", "Type a command name after /. Try /help for a list.");
          break;
        }
        // Check TUI registry first (has /help, /status, /settings, etc.)
        const result = registry.lookup(`/${parsed.name} ${parsed.args}`);
        if (result) {
          await result.command.execute(result.args, msgCtx);
        } else if (ctx.router && ctx.chatSession) {
          // Fall through to PromptRouter for its slash commands (/agents, /compact, etc.)
          const slashResult = await ctx.router.handleSlashCommand(ctx.chatSession.id, `/${parsed.name} ${parsed.args}`);
          if (slashResult) {
            msgCtx.addMessage("system", slashResult);
          } else {
            msgCtx.addMessage("error", `Unknown command: /${parsed.name}. Type /help for commands.`);
          }
        } else {
          msgCtx.addMessage("error", `Unknown command: /${parsed.name}. Type /help for commands.`);
        }
        break;
      }

      case "shell": {
        msgCtx.addMessage("system", `$ ${parsed.command}`);
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
          msgCtx.addMessage("error", file.error);
        } else {
          msgCtx.addMessage("system", `📎 ${file.path}\n\`\`\`${file.language}\n${file.content}\n\`\`\``);
        }
        break;
      }

      case "message": {
        msgCtx.addMessage("user", text);

        // Route through PromptRouter if available, else fallback
        if (ctx.router && ctx.chatSession) {
          await handleWithRouter(text, ctx.chatSession, ctx.router, layout, msgCtx);
        } else {
          await handleChatFallback(text, layout, msgCtx);
        }
        break;
      }
    }
  };

  // TUI abort handler
  layout.tui.onAbort = () => false;

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
    content: [
      ctp.mauve(`\u2726  O P E N P A W L`) + "  " + ctp.overlay1(`v${versionStr}`),
      "",
      ctp.subtext0("Terminal-native AI workspace. Just type what you want to build."),
      "",
      `  ${ctp.blue("/help")}       Show commands       ${ctp.blue("@coder")}     Route to Coder`,
      `  ${ctp.blue("/settings")}   Configure provider  ${ctp.blue("@reviewer")}  Route to Reviewer`,
      `  ${ctp.blue("/agents")}     List agents         ${ctp.blue("@planner")}   Route to Planner`,
      `  ${ctp.peach("!command")}    Run shell command   ${ctp.blue("@tester")}    Route to Tester`,
      `  ${ctp.blue("@file")}       Reference a file    ${ctp.blue("@debugger")}  Route to Debugger`,
      "",
      ctp.surface1("\u2500".repeat(60)),
    ].join("\n"),
    timestamp: new Date(),
  });

  // Status bar segments: provider | connection | mode | state | cost
  layout.statusBar.setSegments([
    { text: "no provider", color: ctp.subtext1 },
    { text: "\u25cb not configured", color: ctp.red },
    { text: "\u25c6 DEF", color: ctp.mauve },
    { text: "idle", color: ctp.overlay0 },
    { text: "$0.00", color: ctp.overlay0 },
  ]);
  layout.statusBar.setRightText(ctp.overlay0("/help"));

  const configState = await detectConfig();
  if (configState.hasProvider) {
    layout.statusBar.updateSegment(0, configState.providerName, ctp.subtext1);
    if (configState.isConnected) {
      layout.statusBar.updateSegment(1, "\u25cf connected", ctp.green);
    } else {
      layout.statusBar.updateSegment(1, "\u25cb disconnected", ctp.red);
    }
  }
  showConfigWarning(configState, layout);

  // ── Mode system ─────────────────────────────────────────────────
  const modeSystem = new ModeSystem();
  const updateModeDisplay = () => {
    const info = modeSystem.getModeInfo();
    // Auto-accept mode uses yellow (visual warning), others use mauve
    const modeColor = info.mode === "auto-accept" ? ctp.yellow : ctp.mauve;
    layout.statusBar.updateSegment(2, `${info.icon} ${info.shortName}`, modeColor);
    layout.tui.requestRender();
  };

  // ── Leader key ─────────────────────────────────────────────────
  const leaderKey = new LeaderKeyHandler();
  leaderKey.onFeedback = (msg) => {
    layout.messages.addMessage({ role: "system", content: msg, timestamp: new Date() });
    layout.tui.requestRender();
  };

  const makeLeaderCtx = () => ({
    addMessage: (r: string, c: string) => {
      layout.messages.addMessage({ role: r as "system", content: c, timestamp: new Date() });
      layout.tui.requestRender();
    },
    requestRender: () => layout.tui.requestRender(),
    exit: () => {},
    tui: layout.tui,
  });

  leaderKey.register("m", "model:list", () => {
    const result = registry.lookup("/model ");
    if (result) void result.command.execute("", makeLeaderCtx());
  }, "Model picker");
  leaderKey.register("s", "status:view", () => {
    const result = registry.lookup("/status ");
    if (result) void result.command.execute("", makeLeaderCtx());
  }, "Status view");
  leaderKey.register("k", "cost:show", () => {
    const result = registry.lookup("/cost ");
    if (result) void result.command.execute("", makeLeaderCtx());
  }, "Cost breakdown");
  leaderKey.register("h", "help:show", () => {
    const sections = buildHelpSections(leaderKey.getBindings(), leaderKey.getLeaderCombo());
    kbHelp.show(sections);
    layout.tui.setInteractiveView(kbHelp.render(layout.tui.getTerminal().columns));
  }, "Keyboard help");

  // ── Command palette ────────────────────────────────────────────
  const palette = new CommandPalette();
  const commandSource: PaletteSource = {
    name: "Commands",
    icon: "/",
    getItems: () => {
      const allCmds = registry.getAll?.() ?? [];
      return allCmds.map((cmd) => ({
        id: `cmd:${cmd.name}`,
        label: `/${cmd.name}`,
        description: cmd.description ?? "",
        category: "Commands",
        icon: "/",
        action: async () => {
          const result = registry.lookup(`/${cmd.name} `);
          if (result) await result.command.execute("", makeLeaderCtx());
        },
        score: 0,
      }));
    },
  };
  palette.addSource(commandSource);
  leaderKey.onPalette = () => {
    palette.show();
    layout.tui.setInteractiveView(palette.render(layout.tui.getTerminal().columns));
  };

  // ── Keybinding help ────────────────────────────────────────────
  const kbHelp = new KeybindingHelp();

  // ── Wire keyboard shortcuts via TUI action handlers ─────────────
  // We do NOT use pushKeyHandler permanently — that would cause nav.select
  // (mapped to Enter) to be consumed by the TUI instead of reaching the editor.
  // Instead, we hook into the TUI's onSystemMessage for mode.cycle and
  // use onKey interception for leader key, Ctrl+P, Alt+P.

  // Helper to show palette overlay
  const showPalette = () => {
    palette.show();
    layout.tui.pushKeyHandler({
      handleKey: (event) => {
        palette.handleKey(event);
        if (!palette.isVisible()) {
          layout.tui.clearInteractiveView();
          layout.tui.popKeyHandler();
        } else {
          layout.tui.setInteractiveView(palette.render(layout.tui.getTerminal().columns));
        }
        return true;
      },
    });
    layout.tui.setInteractiveView(palette.render(layout.tui.getTerminal().columns));
  };

  // Helper to show help overlay
  const showHelp = () => {
    const sections = buildHelpSections(leaderKey.getBindings(), leaderKey.getLeaderCombo());
    kbHelp.show(sections);
    layout.tui.pushKeyHandler({
      handleKey: (event) => {
        kbHelp.handleKey(event);
        if (!kbHelp.isVisible()) {
          layout.tui.clearInteractiveView();
          layout.tui.popKeyHandler();
        } else {
          layout.tui.setInteractiveView(kbHelp.render(layout.tui.getTerminal().columns));
        }
        return true;
      },
    });
    layout.tui.setInteractiveView(kbHelp.render(layout.tui.getTerminal().columns));
  };

  // Wire leader palette callback
  leaderKey.onPalette = showPalette;
  // Update leader 'h' binding to use showHelp
  leaderKey.register("h", "help:show", showHelp, "Keyboard help");

  // Intercept keyboard events at the editor level via onChange
  // The editor calls onChange after each keystroke — we use this to detect leader key
  const origOnChange = layout.editor.onChange;
  layout.editor.onChange = (text: string) => {
    origOnChange?.(text);
    // No-op — leader key and shortcuts are handled below
  };

  // Override the editor's onKey to intercept shortcuts before normal editing
  const origEditorOnKey = layout.editor.onKey.bind(layout.editor);
  layout.editor.onKey = (event) => {
    // Build combo string
    let combo = "";
    if (event.type === "char") {
      const parts: string[] = [];
      if (event.ctrl) parts.push("ctrl");
      if (event.alt) parts.push("alt");
      parts.push(event.char.toLowerCase());
      combo = parts.join("+");
    } else if (event.type === "tab") {
      combo = ("shift" in event && event.shift) ? "shift+tab" : "tab";
    } else if (event.type === "escape") {
      combo = "escape";
    }

    if (combo) {
      // Leader key handling
      if (leaderKey.isAwaitingSecondKey()) {
        const result = leaderKey.handleKey(combo);
        if (result.consumed) {
          layout.statusBar.setRightText("/help");
          layout.tui.requestRender();
          return true;
        }
      }
      if (combo === leaderKey.getLeaderCombo()) {
        const result = leaderKey.handleKey(combo);
        if (result.consumed) {
          if ("waiting" in result && result.waiting) {
            layout.statusBar.setRightText(`${leaderKey.getLeaderCombo()} —`);
          }
          layout.tui.requestRender();
          return true;
        }
      }

      // Shift+Tab → mode cycle (only when not in autocomplete)
      if (combo === "shift+tab" && !layout.editor.isAutocompleteActive()) {
        modeSystem.cycleNext();
        const info = modeSystem.getModeInfo();
        updateModeDisplay();
        layout.messages.addMessage({
          role: "system",
          content: `Mode: ${info.displayName}. ${info.description}`,
          timestamp: new Date(),
        });
        return true;
      }

      // Ctrl+P → command palette
      if (combo === "ctrl+p") {
        showPalette();
        return true;
      }

      // Alt+P → model picker
      if (combo === "alt+p") {
        const result = registry.lookup("/model ");
        if (result) void result.command.execute("", makeLeaderCtx());
        return true;
      }
    }

    // Fall through to normal editor handling
    return origEditorOnKey(event);
  };

  // Register /keys and /keybindings commands
  registry.register({
    name: "keys",
    description: "Show keyboard shortcuts",
    async execute(_args, msgCtx) {
      if (msgCtx.tui) {
        showHelp();
      } else {
        const sections = buildHelpSections(leaderKey.getBindings(), leaderKey.getLeaderCombo());
        for (const section of sections) {
          const lines = [`${section.icon} ${section.title}`];
          for (const e of section.entries) lines.push(`  ${e.key.padEnd(20)} ${e.description}`);
          msgCtx.addMessage("system", lines.join("\n"));
        }
      }
    },
  });

  registry.register({
    name: "keybindings",
    description: "Create/open keybindings config",
    async execute(_args, msgCtx) {
      const { createDefaultConfig, getConfigPath } = await import("../tui/keybindings/keybinding-config.js");
      createDefaultConfig();
      msgCtx.addMessage("system", `Keybinding config: ${getConfigPath()}\nEdit this file to customize keyboard shortcuts.`);
    },
  });

  // TUI callbacks
  layout.tui.onSystemMessage = (msg: string) => {
    layout.messages.addMessage({ role: "system", content: msg, timestamp: new Date() });
    layout.tui.requestRender();
  };

  const cleanup = async () => {
    ctx.cleanupRouter?.();
    ctx.cleanupSession?.();
    tuiSession.close();
    if (ctx.router) await ctx.router.shutdown();
    if (ctx.sessionMgr) await ctx.sessionMgr.shutdown();
    layout.tui.stop();
    setLoggerMuted(false);
  };
  layout.tui.onExit = () => void cleanup();

  // Start the TUI
  layout.tui.start();

  // ── Initialize SessionManager + PromptRouter in background ──────────
  // This happens after tui.start() so the TUI is responsive immediately.
  // The onSubmit handler uses ctx.router/ctx.chatSession which are null
  // until this completes (fallback mode handles that gracefully).
  initSessionRouter(ctx, opts, layout, registry).catch(() => {
    // Initialization failed — TUI continues in fallback mode
  });

  // Block until exit
  await new Promise<void>((resolve) => {
    const origExit = layout.tui.onExit;
    layout.tui.onExit = () => {
      origExit?.();
      resolve();
    };
  });
}

/** Initialize SessionManager + PromptRouter after TUI has started. */
async function initSessionRouter(
  ctx: {
    sessionMgr: SessionManager | null;
    router: PromptRouter | null;
    chatSession: Session | null;
    cleanupRouter: (() => void) | null;
    cleanupSession: (() => void) | null;
  },
  opts: LaunchOptions | undefined,
  layout: AppLayout,
  registry: CommandRegistry,
): Promise<void> {
  const { createSessionManager } = await import("../session/index.js");
  const { PromptRouter: RouterClass } = await import("../router/index.js");
  const { createLLMAgentRunner } = await import("../router/llm-agent-runner.js");

  ctx.sessionMgr = createSessionManager({
    sessionsDir: opts?.sessionsDir,
  });
  await ctx.sessionMgr.initialize();

  // Create LLM-backed agent runner with token streaming.
  // The onToken callback emits dispatch:agent:token on the router,
  // which wireRouterEvents() picks up for real-time TUI display.
  const tokenEmitter = { emit: (_agentId: string, _token: string) => {} };
  const agentRunner = createLLMAgentRunner((agentId, token) => {
    tokenEmitter.emit(agentId, token);
  });

  ctx.router = new RouterClass({}, ctx.sessionMgr, null, agentRunner);
  await ctx.router.initialize();

  // Now that the router exists, wire the token emitter to it.
  // The router forwards dispatch:agent:token events from the Dispatcher.
  tokenEmitter.emit = (agentId: string, token: string) => {
    ctx.router?.emit("dispatch:agent:token", ctx.chatSession?.id ?? "", agentId, token);
  };

  // Create or resume session
  if (opts?.resume) {
    const latestResult = await ctx.sessionMgr.resumeLatest();
    ctx.chatSession = latestResult.isOk() ? latestResult.value : null;
  }
  if (!ctx.chatSession) {
    const createResult = await ctx.sessionMgr.create(process.cwd());
    if (createResult.isOk()) {
      ctx.chatSession = createResult.value;
    }
  }

  // Wire events
  ctx.cleanupRouter = wireRouterEvents(ctx.router, layout);
  ctx.cleanupSession = wireSessionEvents(ctx.sessionMgr, layout);

  // Register router-powered commands
  if (ctx.chatSession) {
    registerRouterCommands(registry, ctx.router, ctx.chatSession, layout);
  }

  // Update autocomplete to include @agent mentions
  layout.editor.setAutocompleteProvider(
    createAutocompleteProvider(registry, process.cwd(), ctx.router),
  );
}

// ---------------------------------------------------------------------------
// Register router-powered slash commands into TUI command registry
// ---------------------------------------------------------------------------

function registerRouterCommands(
  registry: CommandRegistry,
  router: PromptRouter,
  session: Session,
  _layout: AppLayout,
): void {
  registry.register({
    name: "agents",
    description: "List available agents",
    async execute(_args, ctx) {
      const agents = router.getRegistry().getAll();
      const lines = ["Available agents:", ""];
      for (const a of agents) {
        const colorFn = getAgentColorFn(a.id);
        const label = colorFn(a.id.padEnd(14));
        lines.push(`  ${label} ${a.description}`);
      }
      lines.push("");
      lines.push("  Use @agent in your prompt to route directly.");
      ctx.addMessage("system", lines.join("\n"));
    },
  });

  registry.register({
    name: "session",
    aliases: ["s"],
    description: "Show current session info",
    async execute(_args, ctx) {
      const state = session.getState();
      const lines = [
        `**Session:** ${state.id}`,
        `**Title:** ${state.title}`,
        `**Status:** ${state.status}`,
        `**Messages:** ${state.messageCount}`,
        `**Cost:** $${state.totalCostUSD.toFixed(4)}`,
        `**Input tokens:** ${state.totalInputTokens.toLocaleString()}`,
        `**Output tokens:** ${state.totalOutputTokens.toLocaleString()}`,
      ];
      ctx.addMessage("system", lines.join("\n"));
    },
  });
}

// ---------------------------------------------------------------------------
// Non-interactive print mode (unchanged)
// ---------------------------------------------------------------------------

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

  console.log("Usage: openpawl -p <prompt>");
  console.log('  openpawl -p "/work build auth"');
  console.log('  openpawl -p "build auth"');
}
