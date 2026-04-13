/**
 * OpenPawl TUI application entry point.
 * Launched when user runs `openpawl` with no subcommand.
 *
 * Wires the existing TUI framework (src/tui/) to:
 *   - SessionManager (src/session/) for persistent session state
 *   - PromptRouter (src/router/) for intent classification + agent dispatch
 *
 * Tiered provider validation:
 *   Tier 1 (startup): Instant config check — sync file read, 0.1ms, no network
 *   Tier 2 (background): Provider healthCheck() ping — 100ms after first paint
 *   Tier 3 (implicit): Real validation on first LLM call — errors surface in chat
 */

import { mark, printStartupTimings } from "./startup.js";
import { buildWelcomeContent } from "./welcome.js";
import { initSessionRouter, type AppContext } from "./init-session-router.js";
import { setupInputHandler, type PromptQueueState } from "./input-handler.js";
import { setupKeybindings } from "./keybindings-setup.js";
import { setupConfigAndProviders, startTier2HealthPing } from "./config-wiring.js";
import { setupTuiCallbacks, setupCrashAndCleanup } from "./tui-callbacks.js";
import { createLayout } from "./layout.js";
import {
  CommandRegistry,
  parseInput,
  createBuiltinCommands,
  type Terminal,
} from "../tui/index.js";
import { registerAllCommands } from "./commands/index.js";
import { createAutocompleteProvider } from "./autocomplete.js";
import { setLoggerMuted, logger, isDebugMode } from "../core/logger.js";
import { defaultTheme } from "../tui/themes/default.js";
import { ICONS } from "../tui/constants/icons.js";
import { AppModeSystem } from "../tui/keybindings/app-mode.js";

export interface LaunchOptions {
  /** Custom terminal for testing (VirtualTerminal). */
  terminal?: Terminal;
  /** Custom sessions directory for testing. */
  sessionsDir?: string;
}

/**
 * Launch the interactive TUI.
 * Blocks until the user exits (Ctrl+C, /quit, Ctrl+D).
 */
export async function launchTUI(opts?: LaunchOptions): Promise<void> {
  mark("launchTUI() entered");
  setLoggerMuted(true);

  const layout = createLayout(opts?.terminal);
  mark("layout created (TUI components)");
  const registry = new CommandRegistry();

  const ctx: AppContext = {
    sessionMgr: null,
    router: null,
    chatSession: null,
    cleanupRouter: null,
    cleanupSession: null,
    doomLoopDetector: null,
    toolOutputHandler: null,
    configState: null,
    appModeSystem: null,
    memoryCleanup: null,
    onQueueDrain: null,
  };

  // Register commands
  for (const cmd of createBuiltinCommands(() => registry)) {
    registry.register(cmd);
  }
  registerAllCommands(registry);
  mark("commands registered");

  // Load saved theme
  {
    const { readGlobalConfig } = await import("../core/global-config.js");
    const { getThemeEngine } = await import("../tui/themes/theme-engine.js");
    mark("theme engine imported");
    const cfg = readGlobalConfig();
    mark("global config read (file I/O)");
    if (cfg?.uiTheme) {
      getThemeEngine().switchTheme(cfg.uiTheme);
    }
    mark("theme applied");
  }
  if (isDebugMode()) {
    logger.debug(`registry has ${registry.getAll().map((c: { name: string }) => c.name).join(", ")}`);
  }

  layout.editor.setAutocompleteProvider(
    createAutocompleteProvider(registry, process.cwd()),
  );

  // ── Mode system ─────────────────────────────────────────────────
  const appModeSystem = new AppModeSystem();
  ctx.appModeSystem = appModeSystem;
  const updateModeDisplay = () => {
    const info = appModeSystem.getModeInfo();
    layout.statusBar.updateSegment(2, `${info.icon} ${info.shortName}`, info.color);
    layout.tui.requestRender();
  };

  {
    const { createModeCommand } = await import("./commands/mode.js");
    registry.register(createModeCommand({
      getMode: () => appModeSystem.getMode(),
      setMode: (mode) => appModeSystem.setMode(mode),
      updateDisplay: updateModeDisplay,
    }));

    const { createPlanCommand } = await import("./commands/plan.js");
    registry.register(createPlanCommand({
      flashMessage: (msg: string) => layout.tui.onFlashMessage?.(msg),
    }));
  }

  // ── Input handler + queue ────────────────────────────────────────
  const state: PromptQueueState = { queue: [], agentBusy: false, welcomeMessageActive: false };
  setupInputHandler(layout, registry, ctx, state, appModeSystem, updateModeDisplay);

  // ── Welcome message ──────────────────────────────────────────────
  const addWelcomeMessage = () => {
    layout.messages.addMessage({
      role: "system",
      content: buildWelcomeContent(),
      timestamp: new Date(),
    });
    state.welcomeMessageActive = true;

    void (async () => {
      try {
        const { collectBriefingData, renderBriefing } = await import("../briefing/index.js");
        const data = await collectBriefingData();
        if (data.lastSession) {
          const briefing = renderBriefing(data);
          layout.messages.addMessage({ role: "system", content: briefing, timestamp: new Date() });
          layout.tui.requestRender();
        }
      } catch {
        // Briefing is non-critical
      }
    })();
  };

  const welcomeResizeHandler = () => {
    if (state.welcomeMessageActive && layout.messages.getMessageCount() === 1) {
      layout.messages.replaceLast(buildWelcomeContent());
      layout.tui.requestRender();
    }
  };
  process.stdout.on("resize", welcomeResizeHandler);

  // ── Config, providers, wizard ────────────────────────────────────
  const configResult = await setupConfigAndProviders(layout, ctx, opts, registry, addWelcomeMessage);

  // ── Keybindings, palette, shortcuts ──────────────────────────────
  setupKeybindings(layout, registry, appModeSystem, updateModeDisplay, ctx);

  // /copy command
  registry.register({
    name: "copy",
    description: "Copy last agent response to clipboard",
    async execute(_args, msgCtx) {
      const ok = await layout.messages.copyLastResponse();
      if (ok) {
        msgCtx.addMessage("system", defaultTheme.success(`${ICONS.success} Copied to clipboard`));
      } else {
        msgCtx.addMessage("system", "No agent response to copy.");
      }
    },
  });

  // ── TUI callbacks + cleanup ──────────────────────────────────────
  const { flashTimer } = setupTuiCallbacks(layout, ctx, appModeSystem, updateModeDisplay);
  setupCrashAndCleanup(layout, ctx, flashTimer, welcomeResizeHandler);

  // ── Start TUI ────────────────────────────────────────────────────
  mark("tui.start() — first paint");
  layout.tui.start();
  mark("TUI running, prompt visible");
  printStartupTimings();

  // ── Tier 2: Background health ping ───────────────────────────────
  startTier2HealthPing(
    configResult.instantConfig,
    ctx,
    layout,
    configResult.refreshProviderConfig,
    configResult.getProviderActiveModel,
  );

  // ── Initialize SessionManager + PromptRouter in background ───────
  initSessionRouter(ctx, opts, layout, registry).catch(() => {});

  // Block until exit
  await new Promise<void>((resolve) => {
    const origExit = layout.tui.onExit;
    layout.tui.onExit = () => {
      origExit?.();
      resolve();
    };
  });
}

// ---------------------------------------------------------------------------
// Non-interactive print mode
// ---------------------------------------------------------------------------

export async function runPrintMode(prompt: string): Promise<void> {
  const parsed = parseInput(prompt);

  if (parsed.type === "command" && parsed.name === "status") {
    const { getGlobalProviderManager } = await import("../providers/provider-factory.js");
    const pm = await getGlobalProviderManager();
    for (const p of pm.getProviders()) {
      const ok = await p.healthCheck().catch(() => false);
      console.log(`${p.name}: ${p.isAvailable() ? "available" : "unavailable"} health=${ok ? "ok" : "fail"}`);
    }
    return;
  }

  console.log("Usage: openpawl -p <prompt>");
  console.log('  openpawl -p "/status"');
}
