/**
 * Session management helpers — history replay, session picker, session commands.
 */

import { agentDisplayName } from "./agent-display.js";
import { formatTokens } from "../utils/formatters.js";
import type { AppLayout } from "./layout.js";
import type { SessionManager } from "../session/session-manager.js";
import type { Session } from "../session/session.js";
import type { CommandRegistry } from "../tui/index.js";

export function replaySessionHistory(session: Session | null, layout: AppLayout): void {
  if (!session) return;
  const history = session.buildContextMessages();

  const lastNonTool = history.filter(m => m.role !== "tool").at(-1);
  if (lastNonTool?.role === "user") {
    history.push({
      id: "orphan-marker",
      role: "system",
      content: "[Unanswered — session ended before response]",
      timestamp: new Date().toISOString(),
    });
  }

  for (const msg of history) {
    if (msg.role === "tool") continue;
    if (msg.metadata?.transient) continue;
    layout.messages.addMessage({
      role: msg.role === "assistant" ? "agent" : msg.role,
      content: msg.content.replace(/^\n+/, ""),
      agentName: msg.agentId ? agentDisplayName(msg.agentId) : undefined,
      timestamp: new Date(msg.timestamp),
    });
  }

  layout.tui.scrollToBottom();
  layout.tui.requestRender();
}

export async function showSessionPicker(
  sessions: import("../session/session-state.js").SessionListItem[],
  sessionMgr: SessionManager,
  layout: AppLayout,
  activeSessionId?: string,
): Promise<Session | null> {
  const { SessionPickerView } = await import("./interactive/session-picker-view.js");

  return new Promise<Session | null>((resolve) => {
    const view = new SessionPickerView(layout.tui, sessions, async (result) => {
      switch (result.action) {
        case "resume": {
          const r = await sessionMgr.resume(result.sessionId!);
          resolve(r.isOk() ? r.value : null);
          break;
        }
        case "new": {
          const r = await sessionMgr.create(process.cwd());
          resolve(r.isOk() ? r.value : null);
          break;
        }
        case "delete": {
          await sessionMgr.delete(result.sessionId!);
          const listResult = await sessionMgr.listByWorkspace(process.cwd());
          const remaining = listResult.isOk() ? listResult.value : [];
          if (remaining.length === 0) {
            const r = await sessionMgr.create(process.cwd());
            resolve(r.isOk() ? r.value : null);
          } else if (remaining.length === 1) {
            const r = await sessionMgr.resume(remaining[0]!.id);
            resolve(r.isOk() ? r.value : null);
          } else {
            resolve(await showSessionPicker(remaining, sessionMgr, layout, activeSessionId));
          }
          break;
        }
        case "clear-all": {
          for (const s of sessions) {
            if (s.id !== activeSessionId) {
              await sessionMgr.delete(s.id);
            }
          }
          const listResult = await sessionMgr.listByWorkspace(process.cwd());
          const remaining = listResult.isOk() ? listResult.value : [];
          if (remaining.length === 0) {
            const r = await sessionMgr.create(process.cwd());
            resolve(r.isOk() ? r.value : null);
          } else if (remaining.length === 1) {
            const r = await sessionMgr.resume(remaining[0]!.id);
            resolve(r.isOk() ? r.value : null);
          } else {
            resolve(await showSessionPicker(remaining, sessionMgr, layout, activeSessionId));
          }
          break;
        }
        case "cancel": {
          if (sessions.length > 0) {
            const r = await sessionMgr.resume(sessions[0]!.id);
            resolve(r.isOk() ? r.value : null);
          } else {
            const r = await sessionMgr.create(process.cwd());
            resolve(r.isOk() ? r.value : null);
          }
          break;
        }
      }
    }, () => {}, activeSessionId);
    view.activate();
  });
}

export function registerSessionCommands(
  registry: CommandRegistry,
  ctx: { sessionMgr: SessionManager | null; chatSession: Session | null },
  layout: AppLayout,
): void {
  registry.register({
    name: "sessions",
    aliases: ["session"],
    description: "Session management (list, new, rename, info, switch)",
    async execute(args, msgCtx) {
      const sub = args.trim().split(/\s+/)[0] || "";
      const subArg = args.trim().slice(sub.length).trim();

      if (sub === "new") {
        if (ctx.chatSession?.isDirty() && ctx.sessionMgr) {
          await ctx.sessionMgr.getStore().quickSave(ctx.chatSession);
        }
        if (ctx.sessionMgr) {
          const r = await ctx.sessionMgr.create(process.cwd());
          if (r.isOk()) {
            ctx.chatSession = r.value;
            layout.messages.clear();
            layout.tui.requestRender();
            msgCtx.addMessage("system", "New session created.");
          }
        }
        return;
      }

      if (sub === "rename" && subArg) {
        if (ctx.chatSession) {
          ctx.chatSession.setTitle(subArg.slice(0, 60));
          msgCtx.addMessage("system", `Session renamed to: ${subArg.slice(0, 60)}`);
        }
        return;
      }

      if (sub === "info") {
        if (ctx.chatSession) {
          const state = ctx.chatSession.getState();
          const lines = [
            `**Session:** ${state.id}`,
            `**Title:** ${state.title}`,
            `**Messages:** ${state.messageCount}`,
            `**Tokens:** ${formatTokens(state.totalInputTokens + state.totalOutputTokens)}`,
            `**Created:** ${state.createdAt}`,
            `**Updated:** ${state.updatedAt}`,
            `**Workspace:** ${state.workingDirectory}`,
          ];
          msgCtx.addMessage("system", lines.join("\n"));
        }
        return;
      }

      if (sub === "delete" && subArg) {
        if (ctx.sessionMgr) {
          if (ctx.chatSession?.id === subArg) {
            msgCtx.addMessage("error", "Cannot delete the active session. Switch first.");
            return;
          }
          await ctx.sessionMgr.delete(subArg);
          msgCtx.addMessage("system", `Session ${subArg} deleted.`);
        }
        return;
      }

      // Default: show picker
      if (!ctx.sessionMgr) return;
      const listResult = await ctx.sessionMgr.listByWorkspace(process.cwd());
      const sessions = listResult.isOk() ? listResult.value : [];
      if (sessions.length === 0) {
        msgCtx.addMessage("system", "No other sessions for this workspace.");
        return;
      }

      const picked = await showSessionPicker(sessions, ctx.sessionMgr, layout, ctx.chatSession?.id);
      if (picked && picked.id !== ctx.chatSession?.id) {
        ctx.chatSession = picked;
        layout.messages.clear();
        replaySessionHistory(picked, layout);
        layout.tui.requestRender();
      }
    },
  });
}
