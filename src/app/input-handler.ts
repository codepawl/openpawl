/**
 * Editor submit handler, prompt queue, and abort logic.
 */

import { handleWithRouter, handleChatFallback } from "./prompt-handler.js";
import { resolveFileRef } from "./file-ref.js";
import { executeShell } from "./shell.js";
import { ICONS } from "../tui/constants/icons.js";
import { parseInput, type CommandRegistry } from "../tui/index.js";
import { getConnectionState } from "../core/connection-state.js";
import { findClosest } from "../utils/fuzzy.js";
import type { AppLayout } from "./layout.js";
import type { AppContext } from "./init-session-router.js";
import type { AppModeSystem } from "../tui/keybindings/app-mode.js";

export interface PromptQueueState {
  queue: { text: string; fullPrompt: string; attachedFiles?: string[] }[];
  agentBusy: boolean;
  welcomeMessageActive: boolean;
}

function createMsgCtx(
  layout: AppLayout,
  ctx: AppContext,
) {
  return {
    addMessage: (role: string, content: string) => {
      layout.messages.addMessage({
        role: role as "system" | "user" | "error" | "assistant" | "agent" | "tool",
        content,
        timestamp: new Date(),
      });
      if (ctx.chatSession && role !== "error") {
        ctx.chatSession.addMessage({
          role: role as "user" | "assistant" | "system" | "tool",
          content,
          metadata: role === "system" ? { transient: true } : undefined,
        });
      }
      layout.tui.requestRender();
    },
    clearMessages: () => {
      layout.messages.clear();
      ctx.chatSession?.clearMessages();
    },
    requestRender: () => layout.tui.requestRender(),
    exit: () => { layout.tui.stop(); },
    tui: layout.tui,
  };
}

export function setupInputHandler(
  layout: AppLayout,
  registry: CommandRegistry,
  ctx: AppContext,
  state: PromptQueueState,
  _appModeSystem: AppModeSystem,
  _updateModeDisplay: () => void,
): void {
  layout.editor.onSubmit = async (text: string, attachedFiles?: string[]) => {
    state.welcomeMessageActive = false;
    layout.editor.pushHistory(text);
    const parsed = parseInput(text);
    const msgCtx = createMsgCtx(layout, ctx);

    switch (parsed.type) {
      case "command": {
        if (!parsed.name) {
          msgCtx.addMessage("error", "Type a command name after /. Try /help for a list.");
          break;
        }
        const result = registry.lookup(`/${parsed.name} ${parsed.args}`);
        if (result) {
          await result.command.execute(result.args, msgCtx);
        } else if (ctx.router && ctx.chatSession) {
          const slashResult = await ctx.router.handleSlashCommand(ctx.chatSession.id, `/${parsed.name} ${parsed.args}`);
          if (slashResult) {
            msgCtx.addMessage("system", slashResult);
          } else {
            const allCmds = registry.getAll().map((c) => c.name);
            const suggestion = findClosest(parsed.name, allCmds);
            msgCtx.addMessage("error", suggestion
              ? `Unknown command: /${parsed.name}. Did you mean /${suggestion}?`
              : `Unknown command: /${parsed.name}. Type /help for commands.`);
          }
        } else {
          const allCmds = registry.getAll().map((c) => c.name);
          const suggestion = findClosest(parsed.name, allCmds);
          msgCtx.addMessage("error", suggestion
            ? `Unknown command: /${parsed.name}. Did you mean /${suggestion}?`
            : `Unknown command: /${parsed.name}. Type /help for commands.`);
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
        ctx.doomLoopDetector?.reset();

        let fullPrompt = text;
        if (attachedFiles && attachedFiles.length > 0) {
          const { readFileSync, existsSync } = await import("node:fs");
          const { resolve } = await import("node:path");
          const fileSections: string[] = [];
          for (const filePath of attachedFiles) {
            const resolved = resolve(process.cwd(), filePath);
            if (existsSync(resolved)) {
              try {
                const content = readFileSync(resolved, "utf-8");
                fileSections.push(`<file path="${filePath}">\n${content}\n</file>`);
              } catch {
                fileSections.push(`<file path="${filePath}">[Could not read file]</file>`);
              }
            }
          }
          if (fileSections.length > 0) {
            fullPrompt = fileSections.join("\n\n") + "\n\n" + text;
          }
        }

        if (state.agentBusy) {
          state.queue.push({ text, fullPrompt, attachedFiles });
          layout.messages.addMessage({
            role: "user",
            content: text,
            timestamp: new Date(),
            pending: true,
          });
          layout.divider.setLabel(`\u23f3 ${state.queue.length} queued`);
          layout.tui.requestRender();
          break;
        }

        if (attachedFiles && attachedFiles.length > 0) {
          const tags = attachedFiles.map((f) => `[@${f.split("/").pop()}]`).join(" ");
          msgCtx.addMessage("user", `${tags} ${text}`);
        } else {
          msgCtx.addMessage("user", text);
        }

        if (ctx.chatSession?.getState().title === "Untitled session" || ctx.chatSession?.getState().title === "New session") {
          const { generateSessionName } = await import("../session/session-name.js");
          const name = generateSessionName(text);
          if (name !== "Untitled session") ctx.chatSession.setTitle(name);
        }

        {
          const connState = getConnectionState();
          if (connState.status === "no_key") {
            if (!ctx.configState?.hasProvider) {
              msgCtx.addMessage("system", `${ICONS.warning} No provider configured. Run /settings to set up your AI provider.`);
            } else {
              msgCtx.addMessage("system", `${ICONS.warning} No API key found. Run /settings to configure your provider.`);
            }
            break;
          }
          if (connState.status === "auth_failed" && !ctx.router) {
            msgCtx.addMessage("system", `${ICONS.warning} API key invalid. Run /settings to update your credentials.`);
            break;
          }
        }

        state.agentBusy = true;
        try {
          if (ctx.router && ctx.chatSession) {
            await handleWithRouter(fullPrompt, ctx.chatSession, ctx.router, layout, msgCtx, ctx.appModeSystem);
          } else {
            await handleChatFallback(fullPrompt, layout, msgCtx);
          }
        } finally {
          state.agentBusy = false;
        }
        break;
      }
    }
  };

  // Process next queued prompt
  const processNextFromQueue = async () => {
    if (state.queue.length === 0) {
      layout.divider.setLabel(null);
      layout.tui.requestRender();
      return;
    }
    const next = state.queue.shift()!;
    layout.divider.setLabel(
      state.queue.length > 0 ? `\u23f3 ${state.queue.length} queued` : null,
    );
    layout.messages.markNextPendingAsActive();
    layout.tui.requestRender();

    if (ctx.chatSession) {
      ctx.chatSession.addMessage({ role: "user", content: next.text });
    }

    const queueMsgCtx = createMsgCtx(layout, ctx);

    state.agentBusy = true;
    try {
      if (ctx.router && ctx.chatSession) {
        await handleWithRouter(next.fullPrompt, ctx.chatSession, ctx.router, layout, queueMsgCtx, ctx.appModeSystem);
      } else {
        await handleChatFallback(next.fullPrompt, layout, queueMsgCtx);
      }
    } finally {
      state.agentBusy = false;
    }
  };

  ctx.onQueueDrain = () => void processNextFromQueue();

  // TUI abort handler
  layout.tui.onAbort = () => {
    if (ctx.cleanupRouter?.isStreaming()) {
      ctx.cleanupRouter.cancelStreaming();
      state.agentBusy = false;
      layout.tui.onFlashMessage?.("Cancelled");
      return true;
    }
    if (state.queue.length > 0) {
      layout.messages.removePendingMessages();
      state.queue.length = 0;
      layout.divider.setLabel(null);
      layout.tui.requestRender();
      return true;
    }
    return false;
  };
}
