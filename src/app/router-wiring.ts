/**
 * Wire PromptRouter and SessionManager events to TUI display.
 */

import { formatTokenPair, getAgentColorFn, agentDisplayName } from "./agent-display.js";
import { defaultTheme } from "../tui/themes/default.js";
import { RouterEvent, SessionEvent } from "../router/event-types.js";
import { ThinkingIndicator } from "../tui/components/thinking-indicator.js";
import { ToolCallTokenFilter } from "../tui/text/tool-call-filter.js";
import type { AppLayout } from "./layout.js";
import type { PromptRouter } from "../router/prompt-router.js";
import type { SessionManager } from "../session/session-manager.js";

export interface RouterEventWiring {
  cleanup: () => void;
  /** Cancel the current in-flight dispatch. Returns true if something was cancelled. */
  cancelStreaming: () => boolean;
  /** Whether an agent is currently streaming tokens. */
  isStreaming: () => boolean;
}

export function wireRouterEvents(
  router: PromptRouter,
  layout: AppLayout,
  onAssistantResponse?: (agentId: string, content: string) => void,
  onPlanReady?: () => void,
  onQueueDrain?: () => void,
  onTokensUsed?: (input: number, output: number) => void,
): RouterEventWiring {
  let streamingForAgent: string | null = null;
  let streamedContent = "";
  let tokenFilter: ToolCallTokenFilter | null = null;
  let sessionInputTokens = 0;
  let sessionOutputTokens = 0;
  let activeSessionId: string | null = null;
  const thinking = new ThinkingIndicator();
  let thinkingMsgAdded = false;

  thinking.onUpdate = (text) => {
    if (thinkingMsgAdded) {
      layout.messages.replaceLast(text);
      layout.tui.requestRender();
    }
  };

  const onAgentStart = (sessionId: string, agentId: string) => {
    activeSessionId = sessionId;
    streamingForAgent = agentId;
    streamedContent = "";
    layout.messages.clearToolCalls();
    tokenFilter = new ToolCallTokenFilter((filtered) => {
      layout.messages.appendToLast(filtered);
      layout.tui.requestRender();
    });

    if (thinkingMsgAdded) {
      thinking.stop();
      layout.messages.replaceLast("");
      thinkingMsgAdded = false;
    }

    thinking.start();
    layout.messages.addMessage({
      role: "agent",
      agentName: agentDisplayName(agentId),
      agentColor: getAgentColorFn(agentId),
      content: thinking.getCurrentText(),
      timestamp: new Date(),
    });
    thinkingMsgAdded = true;

    layout.statusBar.updateSegment(3, `${agentDisplayName(agentId)} thinking... ${defaultTheme.dim("(Esc to cancel)")}`, defaultTheme.accent);
    layout.tui.requestRender();
  };

  const onAgentToken = (_sessionId: string, agentId: string, token: string) => {
    if (thinking.isVisible()) {
      thinking.stop();
      thinkingMsgAdded = false;
      layout.messages.replaceLast("");
      layout.statusBar.updateSegment(3, `${agentDisplayName(agentId)} working... ${defaultTheme.dim("(Esc)")}`, defaultTheme.accent);
    }
    if (streamingForAgent !== agentId || !layout.messages.isLastAgentMessage()) {
      streamingForAgent = agentId;
      layout.messages.addMessage({
        role: "agent",
        agentName: agentDisplayName(agentId),
        agentColor: getAgentColorFn(agentId),
        content: "",
        timestamp: new Date(),
      });
    }

    streamedContent += token;

    if (tokenFilter) {
      tokenFilter.feed(token);
    } else {
      layout.messages.appendToLast(token);
      layout.tui.requestRender();
    }
  };

  let toolSpinnerInterval: ReturnType<typeof setInterval> | null = null;

  const startToolSpinner = () => {
    if (toolSpinnerInterval) return;
    toolSpinnerInterval = setInterval(() => {
      if (layout.messages.hasRunningToolCalls()) {
        layout.messages.advanceToolSpinners();
        layout.tui.requestRender();
      }
    }, 80);
  };

  const stopToolSpinner = () => {
    if (toolSpinnerInterval) {
      clearInterval(toolSpinnerInterval);
      toolSpinnerInterval = null;
    }
  };

  const onAgentTool = (_sessionId: string, _agentId: string, toolName: string, status: string, details?: { executionId?: string; inputSummary?: string; duration?: number; outputSummary?: string; success?: boolean; diff?: import("../utils/diff.js").DiffResult }) => {
    const execId = details?.executionId ?? `fallback_${Date.now()}`;

    if (status === "running") {
      layout.messages.startToolCall(execId, toolName, details?.inputSummary ?? toolName, _agentId);
      startToolSpinner();
    } else if (status === "completed" || status === "failed") {
      layout.messages.completeToolCall(execId, status === "completed", details?.outputSummary ?? "", details?.duration ?? 0, details?.diff);
    }

    layout.tui.requestRender();
  };

  const onAgentDone = (_sessionId: string, agentId: string, result?: { response?: string }) => {
    const responseText = result?.response || streamedContent;
    if (responseText && agentId !== "system") {
      onAssistantResponse?.(agentId, responseText);
    }
    activeSessionId = null;
    streamingForAgent = null;
    streamedContent = "";
    tokenFilter?.flush();
    tokenFilter = null;
    thinking.stop();
    thinkingMsgAdded = false;
    stopToolSpinner();
    layout.messages.bakeToolCalls();
    layout.statusBar.updateSegment(3, "idle", defaultTheme.dim);
    layout.tui.requestRender();

    if (responseText && onPlanReady) {
      onPlanReady();
    }

    onQueueDrain?.();
  };

  const onDispatchError = (_sessionId: string, error: { type: string; cause?: string }) => {
    if (!activeSessionId && error.cause?.includes("aborted")) return;

    activeSessionId = null;
    streamingForAgent = null;
    tokenFilter?.flush();
    tokenFilter = null;
    thinking.stop();
    thinkingMsgAdded = false;
    stopToolSpinner();
    layout.messages.clearToolCalls();
    layout.messages.addMessage({
      role: "error",
      content: `Dispatch error: ${error.type}`,
      timestamp: new Date(),
    });
    layout.statusBar.updateSegment(3, "idle", defaultTheme.dim);
    layout.tui.requestRender();
  };

  const onDispatchDone = (_sessionId: string, result: { totalInputTokens: number; totalOutputTokens: number }) => {
    sessionInputTokens += result.totalInputTokens;
    sessionOutputTokens += result.totalOutputTokens;
    const display = formatTokenPair(sessionInputTokens, sessionOutputTokens);
    layout.statusBar.updateSegment(3, display, null);
    layout.tui.requestRender();
    onTokensUsed?.(result.totalInputTokens, result.totalOutputTokens);
  };

  const cancelStreaming = (): boolean => {
    if (!activeSessionId) return false;
    const sid = activeSessionId;

    router.abort(sid);

    if (streamingForAgent) {
      tokenFilter?.flush();
      layout.messages.appendToLast(`\n\n${defaultTheme.dim("\u238b Cancelled")}`);
    }

    activeSessionId = null;
    streamingForAgent = null;
    streamedContent = "";
    tokenFilter = null;
    thinking.stop();
    thinkingMsgAdded = false;
    stopToolSpinner();
    layout.messages.bakeToolCalls();
    layout.statusBar.updateSegment(3, "idle", defaultTheme.dim);
    layout.tui.requestRender();

    return true;
  };

  router.on(RouterEvent.AgentStart, onAgentStart);
  router.on(RouterEvent.AgentToken, onAgentToken);
  router.on(RouterEvent.AgentTool, onAgentTool);
  router.on(RouterEvent.AgentDone, onAgentDone);
  router.on(RouterEvent.Done, onDispatchDone);
  router.on(RouterEvent.Error, onDispatchError);

  return {
    cleanup: () => {
      stopToolSpinner();
      router.off(RouterEvent.AgentStart, onAgentStart);
      router.off(RouterEvent.AgentToken, onAgentToken);
      router.off(RouterEvent.AgentTool, onAgentTool);
      router.off(RouterEvent.AgentDone, onAgentDone);
      router.off(RouterEvent.Done, onDispatchDone);
      router.off(RouterEvent.Error, onDispatchError);
    },
    cancelStreaming,
    isStreaming: () => streamingForAgent !== null,
  };
}

// ---------------------------------------------------------------------------
// Wire SessionManager events → status bar updates
// ---------------------------------------------------------------------------

export function wireSessionEvents(
  sessionMgr: SessionManager,
  layout: AppLayout,
): () => void {
  const onTokensUpdated = (_sessionId: string, tokens: { input?: number; output?: number }) => {
    const display = formatTokenPair(tokens.input ?? 0, tokens.output ?? 0);
    layout.statusBar.updateSegment(3, display, null);
    layout.tui.requestRender();
  };

  const onMessageAdded = () => {
    layout.tui.requestRender();
  };

  sessionMgr.on(SessionEvent.CostUpdated, onTokensUpdated);
  sessionMgr.on(SessionEvent.MessageAdded, onMessageAdded);

  return () => {
    sessionMgr.off(SessionEvent.CostUpdated, onTokensUpdated);
    sessionMgr.off(SessionEvent.MessageAdded, onMessageAdded);
  };
}
