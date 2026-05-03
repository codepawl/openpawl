/**
 * Leader key, command palette, keyboard shortcut wiring, and inline key commands.
 */

import { LeaderKeyHandler } from "../tui/keybindings/leader-key.js";
import { CommandPalette, type PaletteSource } from "../tui/keybindings/command-palette.js";
import { KeybindingHelp, buildHelpSections } from "../tui/keybindings/keybinding-help.js";
import type { AppLayout } from "./layout.js";
import type { CommandRegistry } from "../tui/index.js";
import type { AppModeSystem } from "../tui/keybindings/app-mode.js";
import type { AppContext } from "./init-session-router.js";

export function setupKeybindings(
  layout: AppLayout,
  registry: CommandRegistry,
  appModeSystem: AppModeSystem,
  updateModeDisplay: () => void,
  ctx: AppContext,
): void {
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
    clearMessages: () => {
      layout.messages.clear();
      ctx.chatSession?.clearMessages();
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

  const kbHelp = new KeybindingHelp();

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

  leaderKey.onPalette = showPalette;
  leaderKey.register("h", "help:show", showHelp, "Keyboard help");

  // Wire keyboard shortcuts via editor onKey
  const origEditorOnKey = layout.editor.onKey.bind(layout.editor);
  layout.editor.onKey = (event) => {
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

      if (combo === "shift+tab" && !layout.editor.isAutocompleteActive()) {
        appModeSystem.cycleNext();
        updateModeDisplay();
        const info = appModeSystem.getModeInfo();
        layout.tui.onFlashMessage?.(`${info.icon} ${info.displayName} mode`);
        return true;
      }

      if (combo === "ctrl+p") { showPalette(); return true; }
      if (combo === "alt+p") {
        const result = registry.lookup("/model ");
        if (result) void result.command.execute("", makeLeaderCtx());
        return true;
      }
    }

    return origEditorOnKey(event);
  };

  // Register inline commands
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
    name: "mode",
    description: "Switch mode (solo/crew) or cycle to next",
    async execute(args, msgCtx) {
      const target = args.trim().toLowerCase();
      if (target === "solo" || target === "crew") {
        appModeSystem.setMode(target);
      } else {
        appModeSystem.cycleNext();
      }
      updateModeDisplay();
      const info = appModeSystem.getModeInfo();
      msgCtx.addMessage("system", `${info.icon} Switched to ${info.displayName} mode`);
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

  // Wire Ctrl+, (app.settings) to open the /settings command
  layout.tui.onOpenSettings = () => {
    const result = registry.lookup("/settings ");
    if (result) void result.command.execute("", makeLeaderCtx());
  };
}
