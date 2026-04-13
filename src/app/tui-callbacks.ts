/**
 * TUI event callbacks — system messages, flash notifications, prompt navigation,
 * collapse toggle, crash handler, and cleanup.
 */

import { ICONS } from "../tui/constants/icons.js";
import { defaultTheme } from "../tui/themes/default.js";
import { setLoggerMuted } from "../core/logger.js";
import type { AppLayout } from "./layout.js";
import type { AppContext } from "./init-session-router.js";
import type { AppModeSystem } from "../tui/keybindings/app-mode.js";

export function setupTuiCallbacks(
  layout: AppLayout,
  ctx: AppContext,
  appModeSystem: AppModeSystem,
  updateModeDisplay: () => void,
): { flashTimer: { ref: ReturnType<typeof setTimeout> | null } } {
  layout.tui.onSystemMessage = (msg: string) => {
    layout.messages.addMessage({ role: "system", content: msg, timestamp: new Date() });
    layout.tui.requestRender();
  };

  layout.tui.onModeAction = (_modeAction: string) => {
    appModeSystem.cycleNext();
    updateModeDisplay();
    const info = appModeSystem.getModeInfo();
    layout.tui.onFlashMessage?.(`${info.icon} ${info.displayName} mode`);
  };

  const flashState = { ref: null as ReturnType<typeof setTimeout> | null };
  const defaultRightText = defaultTheme.dim("/help");
  layout.tui.onFlashMessage = (msg: string) => {
    if (flashState.ref) clearTimeout(flashState.ref);
    layout.statusBar.setRightText(defaultTheme.success(`${ICONS.success} ${msg}`));
    layout.tui.requestRender();
    flashState.ref = setTimeout(() => {
      layout.statusBar.setRightText(defaultRightText);
      layout.tui.requestRender();
      flashState.ref = null;
    }, 1500);
  };

  // Prompt navigation
  let currentPromptNavIndex = -1;
  layout.tui.onScrollToPrompt = (direction) => {
    const boundaries = layout.messages.getPromptBoundaries();
    if (boundaries.length === 0) return null;
    if (direction === "prev") {
      if (currentPromptNavIndex <= 0) currentPromptNavIndex = 0;
      else currentPromptNavIndex--;
    } else {
      if (currentPromptNavIndex < 0) return null;
      currentPromptNavIndex++;
      if (currentPromptNavIndex >= boundaries.length) {
        currentPromptNavIndex = -1;
        layout.divider.setLabel(null);
        return 0;
      }
    }
    const b = boundaries[currentPromptNavIndex];
    if (!b) return null;
    layout.divider.setLabel(`prompt ${currentPromptNavIndex + 1}/${boundaries.length}`);
    return b.lineIndex;
  };

  layout.tui.onToggleCollapse = () => {
    const boundaries = layout.messages.getPromptBoundaries();
    if (boundaries.length === 0) return false;
    const idx = currentPromptNavIndex >= 0 && currentPromptNavIndex < boundaries.length
      ? boundaries[currentPromptNavIndex]!.messageIndex
      : boundaries[boundaries.length - 1]!.messageIndex;
    return layout.messages.toggleCollapse(idx + 1);
  };

  layout.tui.onScrollPositionChanged = (scrollOffset) => {
    if (scrollOffset === 0) {
      layout.divider.setLabel(null);
      currentPromptNavIndex = -1;
    }
  };

  return { flashTimer: flashState };
}

export function setupCrashAndCleanup(
  layout: AppLayout,
  ctx: AppContext,
  flashTimer: { ref: ReturnType<typeof setTimeout> | null },
  welcomeResizeHandler: () => void,
): void {
  // Install crash handler
  void (async () => {
    try {
      const { CrashHandler } = await import("../recovery/crash-handler.js");
      const crashHandler = new CrashHandler(async () => {
        if (ctx.sessionMgr) await ctx.sessionMgr.shutdown();
        layout.tui.stop();
      });
      crashHandler.install();
    } catch {
      // Recovery module not available
    }
  })();

  // Terminal restore safety net
  let terminalRestored = false;
  process.on("exit", () => {
    if (terminalRestored) return;
    terminalRestored = true;
    try {
      process.stdout.write("\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1006l");
      process.stdout.write("\x1b[?25h");
      process.stdout.write("\x1b[?2004l");
      process.stdout.write("\x1b[0m");
      process.stdout.write("\x1b[?1049l");
      if (process.stdin.isTTY) process.stdin.setRawMode(false);
    } catch { /* best effort */ }
  });

  let shuttingDown = false;
  const cleanup = async () => {
    if (shuttingDown) { process.exit(0); }
    shuttingDown = true;

    if (flashTimer.ref) clearTimeout(flashTimer.ref);
    process.stdout.off("resize", welcomeResizeHandler);
    layout.tui.stop();
    terminalRestored = true;
    setLoggerMuted(false);

    const forceExit = setTimeout(() => process.exit(0), 2000);
    forceExit.unref();

    try {
      await ctx.sessionMgr?.shutdown();
    } catch { /* best-effort */ }

    try {
      await Promise.allSettled([
        Promise.resolve(ctx.cleanupRouter?.cleanup()),
        Promise.resolve(ctx.cleanupSession?.()),
        Promise.resolve(ctx.memoryCleanup?.()),
        ctx.router?.shutdown().catch(() => {}),
        ctx.toolOutputHandler?.cleanup().catch(() => {}),
      ]);
    } catch { /* ignore */ }

    try {
      const { isProfilingEnabled, generateReport } = await import("../telemetry/profiler.js");
      if (isProfilingEnabled()) {
        const { writeFileSync, mkdirSync } = await import("node:fs");
        const { join } = await import("node:path");
        const { homedir } = await import("node:os");
        const dir = join(homedir(), ".openpawl");
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, "profile-report.md"), generateReport());
      }
    } catch { /* best effort */ }

    clearTimeout(forceExit);
    try {
      process.stdin.setRawMode?.(false);
      process.stdin.pause();
      process.stdin.unref();
    } catch { /* */ }
    process.exit(0);
  };
  layout.tui.onExit = () => void cleanup();
}
