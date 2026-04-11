/**
 * OpenPawl TUI application entry point.
 * Launched when user runs `openpawl` with no subcommand.
 *
 * Wires the existing TUI framework (src/tui/) to:
 *   - SessionManager (src/session/) for persistent session state
 *   - PromptRouter (src/router/) for intent classification + agent dispatch
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * STARTUP PERFORMANCE (2026-04-10)
 * Enable instrumentation: OPENPAWL_DEBUG_STARTUP=1 openpawl
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Tiered provider validation:
 *   Tier 1 (startup): Instant config check — sync file read, 0.1ms, no network
 *   Tier 2 (background): Provider healthCheck() ping — 100ms after first paint
 *   Tier 3 (implicit): Real validation on first LLM call — errors surface in chat
 *
 * Time-to-prompt: ~16ms (down from ~4500ms before tiered approach).
 * Connection state machine drives status bar: no_key → ready → connecting → connected
 *
 * Remaining bottlenecks (not yet addressed):
 * - Eager module graph import: ~300-570ms in cli.ts (bun module resolution)
 * - Proxy re-exec: ~500ms when HTTP_PROXY is set (spawnSync re-launch)
 *
 * ═══════════════════════════════════════════════════════════════════════════
 */

// ── Startup timing instrumentation ──────────────────────────────────────────
// Enable with: OPENPAWL_DEBUG_STARTUP=1 openpawl
// Prints timing table to stderr. Remove this block when done profiling.
const DEBUG_STARTUP = !!process.env.OPENPAWL_DEBUG_STARTUP;
const _startupT0 = performance.now();
const _startupMarks: { label: string; ts: number }[] = [];
function _mark(label: string): void {
  if (!DEBUG_STARTUP) return;
  _startupMarks.push({ label, ts: performance.now() });
}
function _printStartupTimings(): void {
  if (!DEBUG_STARTUP || _startupMarks.length === 0) return;
  process.stderr.write("\n┌─────────────────────────────────────────────────────────────────┐\n");
  process.stderr.write("│  STARTUP TIMING REPORT                                          │\n");
  process.stderr.write("├──────────┬──────────┬──────────────────────────────────────────┤\n");
  process.stderr.write("│ delta ms │ total ms │ checkpoint                               │\n");
  process.stderr.write("├──────────┼──────────┼──────────────────────────────────────────┤\n");
  let prev = _startupT0;
  for (const m of _startupMarks) {
    const delta = (m.ts - prev).toFixed(1).padStart(8);
    const total = (m.ts - _startupT0).toFixed(1).padStart(8);
    const label = m.label.padEnd(40);
    process.stderr.write(`│ ${delta} │ ${total} │ ${label}│\n`);
    prev = m.ts;
  }
  const uptimeMs = (process.uptime() * 1000).toFixed(1);
  process.stderr.write("├──────────┴──────────┴──────────────────────────────────────────┤\n");
  process.stderr.write(`│  process.uptime: ${uptimeMs}ms`.padEnd(66) + "│\n");
  process.stderr.write("└─────────────────────────────────────────────────────────────────┘\n\n");
}
_mark("app/index.ts module loaded (eager imports)");

import { VERSION } from "../version.js";
import { createLayout } from "./layout.js";
import {
  CommandRegistry,
  parseInput,
  createBuiltinCommands,
  type Terminal,
} from "../tui/index.js";
import { registerAllCommands } from "./commands/index.js";
import { createAutocompleteProvider } from "./autocomplete.js";
import { resolveFileRef } from "./file-ref.js";
import { executeShell } from "./shell.js";
import { type ConfigState, checkConfigInstant, detectConfig, pingProvider, showConfigWarning } from "./config-check.js";
import { setConnectionState, getConnectionState, onConnectionChange, getStatusDisplay, type ConnectionStatus } from "../core/connection-state.js";
import { DOT_SYMBOL } from "../tui/components/status-indicator.js";
import { ICONS } from "../tui/constants/icons.js";
import { formatTokens } from "../utils/formatters.js";
import { setLoggerMuted, logger, isDebugMode } from "../core/logger.js";
import { defaultTheme } from "../tui/themes/default.js";
import { bold } from "../tui/core/ansi.js";
import { visibleWidth } from "../tui/utils/text-width.js";
import { separator } from "../tui/primitives/separator.js";
import { findClosest } from "../utils/fuzzy.js";
import { ModeSystem, type OperatingMode } from "../tui/keybindings/mode-system.js";
import { RouterEvent, ToolEvent, SessionEvent } from "../router/event-types.js";
import { LeaderKeyHandler } from "../tui/keybindings/leader-key.js";
import { CommandPalette, type PaletteSource } from "../tui/keybindings/command-palette.js";
import { KeybindingHelp, buildHelpSections } from "../tui/keybindings/keybinding-help.js";
import { ThinkingIndicator } from "../tui/components/thinking-indicator.js";
import { ToolCallTokenFilter } from "../tui/text/tool-call-filter.js";

import type { AppLayout } from "./layout.js";

// Session + Router imports (lazy to keep startup fast)
import type { SessionManager } from "../session/session-manager.js";
import type { Session } from "../session/session.js";
import type { PromptRouter } from "../router/prompt-router.js";

// ---------------------------------------------------------------------------
// Token count formatter
// ---------------------------------------------------------------------------

function formatTokenPair(input: number, output: number): string {
  if (input === 0 && output === 0) return "";
  return `${defaultTheme.info(`${formatTokens(input)}${ICONS.arrowUp}`)} ${defaultTheme.warning(`${formatTokens(output)}${ICONS.arrowDown}`)}`;
}

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
// Tool permission prompt formatter
// ---------------------------------------------------------------------------

/** Map of tool names to their primary argument key (the one to display prominently). */
const TOOL_PRIMARY_ARG: Record<string, string> = {
  shell_exec: "command",
  file_read: "path",
  file_write: "path",
  file_edit: "file_path",
  file_list: "path",
  git_ops: "command",
  execute_code: "code",
  web_search: "query",
  web_fetch: "url",
};

/** Risk indicator icon + color for each risk level. */
function riskIndicator(riskLevel: string): { icon: string; color: (s: string) => string } {
  switch (riskLevel) {
    case "dangerous":
    case "destructive":
      return { icon: ICONS.warning, color: defaultTheme.warning };
    case "moderate":
      return { icon: "\u270e", color: defaultTheme.info };
    default:
      return { icon: ICONS.success, color: defaultTheme.success };
  }
}

/** Build the styled action buttons string. */
function permissionButtons(): string {
  const y = defaultTheme.success(`[${bold("Y")}]es`);
  const n = defaultTheme.error(`[${bold("N")}]o`);
  const a = defaultTheme.warning(`[${bold("!")}]Always`);
  return `${y}    ${n}    ${a}`;
}

/** Format the tool permission prompt as flush-left text with risk icon. */
function formatToolPermissionPrompt(toolName: string, input: unknown, riskLevel: string): string {
  const risk = riskIndicator(riskLevel);
  const inputObj = typeof input === "object" && input !== null
    ? input as Record<string, unknown> : null;

  // Extract primary argument for clean display
  const primaryKey = TOOL_PRIMARY_ARG[toolName];
  const primaryValue = primaryKey && inputObj ? String(inputObj[primaryKey] ?? "") : "";

  const lines: string[] = [];
  lines.push(`${risk.color(risk.icon)} ${bold(toolName)}`);

  if (primaryValue) {
    const display = primaryValue.length > 120
      ? primaryValue.slice(0, 117) + "..."
      : primaryValue;
    lines.push(`  ${defaultTheme.secondary(display)}`);
  }

  // Show remaining args (excluding primary and metadata like timeout)
  const HIDDEN_ARGS = new Set([primaryKey, "timeout", "signal", "cwd", "env"].filter(Boolean));
  if (inputObj) {
    const extras = Object.entries(inputObj)
      .filter(([k]) => !HIDDEN_ARGS.has(k))
      .filter(([, v]) => v !== undefined && v !== null && v !== "");
    if (extras.length > 0) {
      const extraStr = extras.map(([k, v]) => {
        const val = typeof v === "string" ? v : JSON.stringify(v);
        const short = val.length > 60 ? val.slice(0, 57) + "..." : val;
        return `${k}: ${short}`;
      }).join("  ");
      lines.push(`  ${defaultTheme.dim(extraStr)}`);
    }
  } else if (!primaryValue && input !== undefined) {
    lines.push(`  ${defaultTheme.dim(String(input).slice(0, 120))}`);
  }

  lines.push(`  ${permissionButtons()}`);
  return lines.join("\n");
}

/** Format a resolved permission prompt (after user presses Y/N/!). */
function formatToolPermissionResolved(toolName: string, riskLevel: string, result: string, resultColor: (s: string) => string): string {
  const risk = riskIndicator(riskLevel);
  return `${risk.color(risk.icon)} ${bold(toolName)}  ${resultColor(result)}`;
}

// ---------------------------------------------------------------------------
// Wire PromptRouter dispatch events → TUI message display
// ---------------------------------------------------------------------------

function wireRouterEvents(
  router: PromptRouter,
  layout: AppLayout,
  onAssistantResponse?: (agentId: string, content: string) => void,
  onPlanReady?: () => void,
  onQueueDrain?: () => void,
  onTokensUsed?: (input: number, output: number) => void,
): () => void {
  let streamingForAgent: string | null = null;
  let streamedContent = "";
  let tokenFilter: ToolCallTokenFilter | null = null;
  let sessionInputTokens = 0;
  let sessionOutputTokens = 0;
  const thinking = new ThinkingIndicator();
  let thinkingMsgAdded = false;

  // Thinking indicator updates the last message content
  thinking.onUpdate = (text) => {
    if (thinkingMsgAdded) {
      // Replace last message content with current thinking frame
      layout.messages.replaceLast(text);
      layout.tui.requestRender();
    }
  };

  const onAgentStart = (_sessionId: string, agentId: string) => {
    streamingForAgent = agentId;
    streamedContent = "";
    layout.messages.clearToolCalls();
    tokenFilter = new ToolCallTokenFilter((filtered) => {
      layout.messages.appendToLast(filtered);
      layout.tui.requestRender();
    });

    // If a previous thinking message is still showing, clear its stale text
    // before starting a new one (prevents duplicate indicators during parallel dispatch)
    if (thinkingMsgAdded) {
      thinking.stop();
      layout.messages.replaceLast("");
      thinkingMsgAdded = false;
    }

    // Add agent message immediately (badge visible from the start)
    // Thinking indicator text becomes the message content — renders inside tree
    thinking.start();
    layout.messages.addMessage({
      role: "agent",
      agentName: agentDisplayName(agentId),
      agentColor: getAgentColorFn(agentId),
      content: thinking.getCurrentText(),
      timestamp: new Date(),
    });
    thinkingMsgAdded = true;

    layout.statusBar.updateSegment(3, `${agentDisplayName(agentId)} thinking...`, defaultTheme.accent);
    layout.tui.requestRender();
  };

  const onAgentToken = (_sessionId: string, agentId: string, token: string) => {
    // Stop thinking indicator on first token — clear thinking text from agent message
    if (thinking.isVisible()) {
      thinking.stop();
      thinkingMsgAdded = false;
      // Clear the thinking text — streaming content will replace it
      layout.messages.replaceLast("");
      layout.statusBar.updateSegment(3, `${agentDisplayName(agentId)} working...`, defaultTheme.accent);
    }
    if (streamingForAgent !== agentId || !layout.messages.isLastAgentMessage()) {
      // New agent started streaming, or last message is no longer the agent's
      // (e.g., a permission prompt was inserted mid-stream)
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

  const onAgentTool = (_sessionId: string, _agentId: string, toolName: string, status: string, details?: { executionId?: string; inputSummary?: string; duration?: number; outputSummary?: string; success?: boolean }) => {
    const execId = details?.executionId ?? `fallback_${Date.now()}`;

    if (status === "running") {
      layout.messages.startToolCall(execId, toolName, details?.inputSummary ?? toolName, _agentId);
      startToolSpinner();
    } else if (status === "completed" || status === "failed") {
      layout.messages.completeToolCall(execId, status === "completed", details?.outputSummary ?? "", details?.duration ?? 0);
    }

    layout.tui.requestRender();
  };

  const onAgentDone = (_sessionId: string, agentId: string, result?: { response?: string }) => {
    // Save assistant response to session
    const responseText = result?.response || streamedContent;
    if (responseText && agentId !== "system") {
      onAssistantResponse?.(agentId, responseText);
    }
    streamingForAgent = null;
    streamedContent = "";
    tokenFilter?.flush();
    tokenFilter = null;
    thinking.stop();
    thinkingMsgAdded = false;
    stopToolSpinner();
    // Bake completed tool calls into chat history, then clear the live views
    layout.messages.bakeToolCalls();
    layout.statusBar.updateSegment(3, "idle", defaultTheme.dim);
    layout.tui.requestRender();

    // If in plan mode and agent just responded, show execute confirmation
    if (responseText && onPlanReady) {
      onPlanReady();
    }

    // Drain prompt queue if messages are waiting
    onQueueDrain?.();
  };

  const onDispatchError = (_sessionId: string, error: { type: string }) => {
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

  // Update token counter in status bar after each dispatch completes (accumulates per session)
  const onDispatchDone = (_sessionId: string, result: { totalInputTokens: number; totalOutputTokens: number }) => {
    sessionInputTokens += result.totalInputTokens;
    sessionOutputTokens += result.totalOutputTokens;
    const display = formatTokenPair(sessionInputTokens, sessionOutputTokens);
    layout.statusBar.updateSegment(4, display, null);
    layout.tui.requestRender();
    onTokensUsed?.(result.totalInputTokens, result.totalOutputTokens);
  };

  router.on(RouterEvent.AgentStart, onAgentStart);
  router.on(RouterEvent.AgentToken, onAgentToken);
  router.on(RouterEvent.AgentTool, onAgentTool);
  router.on(RouterEvent.AgentDone, onAgentDone);
  router.on(RouterEvent.Done, onDispatchDone);
  router.on(RouterEvent.Error, onDispatchError);

  // Return cleanup function
  return () => {
    stopToolSpinner();
    router.off(RouterEvent.AgentStart, onAgentStart);
    router.off(RouterEvent.AgentToken, onAgentToken);
    router.off(RouterEvent.AgentTool, onAgentTool);
    router.off(RouterEvent.AgentDone, onAgentDone);
    router.off(RouterEvent.Done, onDispatchDone);
    router.off(RouterEvent.Error, onDispatchError);
  };
}

// ---------------------------------------------------------------------------
// Wire SessionManager events → status bar updates
// ---------------------------------------------------------------------------

function wireSessionEvents(
  sessionMgr: SessionManager,
  layout: AppLayout,
): () => void {
  const onTokensUpdated = (_sessionId: string, tokens: { input?: number; output?: number }) => {
    const display = formatTokenPair(tokens.input ?? 0, tokens.output ?? 0);
    layout.statusBar.updateSegment(4, display, null);
    layout.tui.requestRender();
  };

  const onMessageAdded = () => {
    // Auto-render when new messages arrive from external sources
    layout.tui.requestRender();
  };

  sessionMgr.on(SessionEvent.CostUpdated, onTokensUpdated);
  sessionMgr.on(SessionEvent.MessageAdded, onMessageAdded);

  return () => {
    sessionMgr.off(SessionEvent.CostUpdated, onTokensUpdated);
    sessionMgr.off(SessionEvent.MessageAdded, onMessageAdded);
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
  // Check for ambiguous prompts that need clarification before routing
  try {
    const { ClarificationDetector } = await import("../conversation/clarification.js");
    const detector = new ClarificationDetector();
    const clarification = detector.detect(text, {});
    if (clarification?.severity === "ask") {
      ctx.addMessage("system", defaultTheme.warning(`\u2753 ${clarification.questions[0]}`));
      layout.statusBar.updateSegment(3, "idle", defaultTheme.dim);
      layout.tui.requestRender();
      return;
    }
  } catch {
    // Clarification module not available — proceed without it
  }

  layout.statusBar.updateSegment(3, "routing...", defaultTheme.accent);
  layout.tui.requestRender();

  const result = await router.route(session.id, text);

  if (result.isErr()) {
    ctx.addMessage("error", `Error: ${result.error.type}`);
    layout.statusBar.updateSegment(3, "idle", defaultTheme.dim);
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

  layout.statusBar.updateSegment(3, "idle", defaultTheme.dim);
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
  layout.statusBar.updateSegment(3, "thinking...", defaultTheme.accent);
  layout.tui.requestRender();

  try {
    const { callLLM } = await import("../engine/llm.js");
    layout.messages.addMessage({ role: "assistant", content: "", timestamp: new Date() });

    const { buildIdentityPrefix } = await import("../router/agent-registry.js");
    await callLLM(text, {
      systemPrompt: buildIdentityPrefix("Assistant") +
        "\n\nYou are running in a terminal. Use markdown formatting when helpful.",
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

    // Tier 3: update connection state on LLM call failure (force — real error)
    const connState = getConnectionState();
    if (opError.code === "AUTH_FAILED") {
      setConnectionState({ ...connState, status: "auth_failed" }, { force: true });
    } else if (opError.code === "NETWORK_ERROR") {
      setConnectionState({ ...connState, status: "offline" }, { force: true });
    } else if (opError.code !== "RATE_LIMITED" && opError.code !== "CONTEXT_LENGTH_EXCEEDED") {
      setConnectionState({ ...connState, status: "error" }, { force: true });
    }

    const lines: string[] = [`${ICONS.error} ${opError.userMessage}`];
    if (opError.quickFixes.length > 0) {
      lines.push("");
      for (const fix of opError.quickFixes) {
        if (fix.command) lines.push(`  ${fix.command.padEnd(35)} ${fix.description}`);
        else lines.push(`  ${ICONS.bullet} ${fix.description}`);
      }
    }
    lines.push("");
    lines.push("  Type /error for technical details");
    ctx.addMessage("error", lines.join("\n"));
  } finally {
    layout.statusBar.updateSegment(3, "idle", defaultTheme.dim);
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
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

/**
 * Launch the interactive TUI.
 * Blocks until the user exits (Ctrl+C, /quit, Ctrl+D).
 */
export async function launchTUI(opts?: LaunchOptions): Promise<void> {
  _mark("launchTUI() entered");
  // Suppress logger during TUI — all messages go through layout
  setLoggerMuted(true);

  const layout = createLayout(opts?.terminal);
  _mark("layout created (TUI components)");
  const registry = new CommandRegistry();

  // ── Shared mutable refs for async-initialized session/router ────────
  // These are populated by initSessionRouter() after the TUI starts.
  // The onSubmit handler checks them on each invocation.
  const ctx = {
    sessionMgr: null as SessionManager | null,
    router: null as PromptRouter | null,
    chatSession: null as Session | null,
    cleanupRouter: null as (() => void) | null,
    cleanupSession: null as (() => void) | null,
    doomLoopDetector: null as { reset: () => void } | null,
    toolOutputHandler: null as { cleanup: () => Promise<void> } | null,
    configState: null as ConfigState | null,
    modeSystem: null as ModeSystem | null,
    onQueueDrain: null as (() => void) | null,
  };

  // Register built-in commands (/help, /clear, /quit)
  for (const cmd of createBuiltinCommands(() => registry)) {
    registry.register(cmd);
  }

  // Register app commands (/status, /settings, /model, /mode, /cost, etc.)
  registerAllCommands(registry);
  _mark("commands registered");

  // Load saved theme from config
  {
    const { readGlobalConfig } = await import("../core/global-config.js");
    const { getThemeEngine } = await import("../tui/themes/theme-engine.js");
    _mark("theme engine imported");
    const cfg = readGlobalConfig();
    _mark("global config read (file I/O)");
    if (cfg?.uiTheme) {
      getThemeEngine().switchTheme(cfg.uiTheme);
    }
    _mark("theme applied");
  }
  if (isDebugMode()) {
    logger.debug(`registry has ${registry.getAll().map((c: { name: string }) => c.name).join(", ")}`);
  }

  // Set up autocomplete (updated later when router is ready)
  layout.editor.setAutocompleteProvider(
    createAutocompleteProvider(registry, process.cwd()),
  );

  // Prompt queue — queue messages while agent is busy
  const promptQueue: { text: string; fullPrompt: string; attachedFiles?: string[] }[] = [];
  let agentBusy = false;

  // Handle editor submit — text + optional attached files
  layout.editor.onSubmit = async (text: string, attachedFiles?: string[]) => {
    welcomeMessageActive = false;
    layout.editor.pushHistory(text);
    const parsed = parseInput(text);

    const msgCtx = {
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
      exit: () => {
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
          // Auto-name session from sprint goal
          if (parsed.name === "sprint" && parsed.args.trim() && ctx.chatSession) {
            const title = ctx.chatSession.getState().title;
            if (title === "Untitled session" || title === "New session") {
              const { generateSessionName } = await import("../session/session-name.js");
              ctx.chatSession.setTitle(generateSessionName(parsed.args));
            }
          }
          await result.command.execute(result.args, msgCtx);
        } else if (ctx.router && ctx.chatSession) {
          // Fall through to PromptRouter for its slash commands (/agents, /compact, etc.)
          const slashResult = await ctx.router.handleSlashCommand(ctx.chatSession.id, `/${parsed.name} ${parsed.args}`);
          if (slashResult) {
            msgCtx.addMessage("system", slashResult);
          } else {
            const allCmds = registry.getAll().map((c) => c.name);
            const suggestion = findClosest(parsed.name, allCmds);
            if (suggestion) {
              msgCtx.addMessage("error", `Unknown command: /${parsed.name}. Did you mean /${suggestion}?`);
            } else {
              msgCtx.addMessage("error", `Unknown command: /${parsed.name}. Type /help for commands.`);
            }
          }
        } else {
          const allCmds = registry.getAll().map((c) => c.name);
          const suggestion = findClosest(parsed.name, allCmds);
          if (suggestion) {
            msgCtx.addMessage("error", `Unknown command: /${parsed.name}. Did you mean /${suggestion}?`);
          } else {
            msgCtx.addMessage("error", `Unknown command: /${parsed.name}. Type /help for commands.`);
          }
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
        // Reset doom-loop detector on new user message (new intent)
        ctx.doomLoopDetector?.reset();

        // Resolve attached files into context
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

        // If agent is busy, queue the message
        if (agentBusy) {
          promptQueue.push({ text, fullPrompt, attachedFiles });
          layout.messages.addMessage({
            role: "user",
            content: text,
            timestamp: new Date(),
            pending: true,
          });
          layout.divider.setLabel(`\u23f3 ${promptQueue.length} queued`);
          layout.tui.requestRender();
          break;
        }

        // Show user message
        if (attachedFiles && attachedFiles.length > 0) {
          const tags = attachedFiles.map((f) => `[@${f.split("/").pop()}]`).join(" ");
          msgCtx.addMessage("user", `${tags} ${text}`);
        } else {
          msgCtx.addMessage("user", text);
        }

        // Auto-name session from first user message
        if (ctx.chatSession?.getState().title === "Untitled session" || ctx.chatSession?.getState().title === "New session") {
          const { generateSessionName } = await import("../session/session-name.js");
          const name = generateSessionName(text);
          if (name !== "Untitled session") ctx.chatSession.setTitle(name);
        }

        // Guard: don't attempt LLM calls when no provider is configured
        {
          const connState = getConnectionState();
          if (connState.status === "no_key") {
            if (!ctx.configState?.hasProvider) {
              msgCtx.addMessage("system", `${ICONS.warning} No provider configured. Run /setup to set up your AI provider.`);
            } else {
              msgCtx.addMessage("system", `${ICONS.warning} No API key found. Run /settings to configure your provider.`);
            }
            break;
          }
          if (connState.status === "auth_failed" && !ctx.router) {
            msgCtx.addMessage("system", `${ICONS.warning} API key invalid. Run /settings to update your credentials.`);
            break;
          }
          // "ready", "connecting", "connected", "offline" — all allow sending
          // The fallback handler or router will surface real errors from the LLM call
        }

        // Route through PromptRouter if available, else fallback
        agentBusy = true;
        try {
          if (ctx.router && ctx.chatSession) {
            await handleWithRouter(fullPrompt, ctx.chatSession, ctx.router, layout, msgCtx);
          } else {
            await handleChatFallback(fullPrompt, layout, msgCtx);
          }
        } finally {
          agentBusy = false;
        }
        break;
      }
    }
  };

  // Process next queued prompt (called from onAgentDone via wireRouterEvents)
  const processNextFromQueue = async () => {
    if (promptQueue.length === 0) {
      layout.divider.setLabel(null);
      layout.tui.requestRender();
      return;
    }
    const next = promptQueue.shift()!;
    layout.divider.setLabel(
      promptQueue.length > 0 ? `\u23f3 ${promptQueue.length} queued` : null,
    );
    // Mark the pending bubble as active
    layout.messages.markNextPendingAsActive();
    layout.tui.requestRender();

    // Add to session if not already there (pending messages weren't saved)
    if (ctx.chatSession) {
      ctx.chatSession.addMessage({ role: "user", content: next.text });
    }

    const queueMsgCtx = {
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
      clearMessages: () => { layout.messages.clear(); ctx.chatSession?.clearMessages(); },
      requestRender: () => layout.tui.requestRender(),
      exit: () => { layout.tui.stop(); },
      tui: layout.tui,
    };

    agentBusy = true;
    try {
      if (ctx.router && ctx.chatSession) {
        await handleWithRouter(next.fullPrompt, ctx.chatSession, ctx.router, layout, queueMsgCtx);
      } else {
        await handleChatFallback(next.fullPrompt, layout, queueMsgCtx);
      }
    } finally {
      agentBusy = false;
    }
  };

  // Wire queue drain to ctx so initSessionRouter can pass it to wireRouterEvents
  ctx.onQueueDrain = () => void processNextFromQueue();

  // TUI abort handler — clear queue on Esc/Ctrl+C if messages are queued
  layout.tui.onAbort = () => {
    if (promptQueue.length > 0) {
      layout.messages.removePendingMessages();
      promptQueue.length = 0;
      layout.divider.setLabel(null);
      layout.tui.requestRender();
      return true;
    }
    return false;
  };

  // Welcome message

  /** Build the welcome banner content, freshly computed for current terminal width. */
  const buildWelcomeContent = (): string => {
    const termWidth = process.stdout.columns ?? 80;
    const lines: string[] = [];

    const title = `OpenPawl v${VERSION}`;
    const titlePad = Math.max(0, Math.floor((termWidth - title.length) / 2));
    lines.push("");
    lines.push(" ".repeat(titlePad) + bold(defaultTheme.primary(title)));

    const tagline = "Your AI team, one prompt away.";
    const tagPad = Math.max(0, Math.floor((termWidth - tagline.length) / 2));
    lines.push(defaultTheme.dim(" ".repeat(tagPad) + tagline));
    lines.push("");

    // Command table — two sections stacked vertically, centered as a block
    const cmdPad = 12; // align descriptions after longest command
    const allItems: ([string, string] | null)[] = [
      [defaultTheme.info("/help"), "Show commands"],
      [defaultTheme.info("/settings"), "Configure provider"],
      [defaultTheme.info("/agents"), "List agents"],
      [defaultTheme.warning("!command"), "Run shell command"],
      [defaultTheme.info("@file"), "Reference a file"],
      null, // blank line separator
      [defaultTheme.info("@coder"), "Coder"],
      [defaultTheme.info("@reviewer"), "Reviewer"],
      [defaultTheme.info("@planner"), "Planner"],
      [defaultTheme.info("@tester"), "Tester"],
      [defaultTheme.info("@debugger"), "Debugger"],
    ];

    const tableLines: string[] = [];
    for (const item of allItems) {
      if (!item) { tableLines.push(""); continue; }
      const [cmd, desc] = item;
      const cmdVis = visibleWidth(cmd);
      const gap = " ".repeat(Math.max(2, cmdPad - cmdVis));
      tableLines.push(`${cmd}${gap}${defaultTheme.dim(desc)}`);
    }

    // Center the table block
    const maxTableWidth = tableLines.reduce((max, l) => Math.max(max, visibleWidth(l)), 0);
    const tablePad = " ".repeat(Math.max(0, Math.floor((termWidth - maxTableWidth) / 2)));
    for (const row of tableLines) {
      lines.push(tablePad + row);
    }

    // Tip line — centered
    lines.push("");
    const tip = "Use /sessions to view previous conversations.";
    const tipPad = Math.max(0, Math.floor((termWidth - tip.length) / 2));
    lines.push(" ".repeat(tipPad) + defaultTheme.dim(tip));
    lines.push("");

    return lines.join("\n");
  };

  let welcomeMessageActive = false;

  const addWelcomeMessage = () => {
    layout.messages.addMessage({
      role: "system",
      content: buildWelcomeContent(),
      timestamp: new Date(),
    });
    welcomeMessageActive = true;
  };

  // Re-render welcome banner on terminal resize (recomputes centering)
  const welcomeResizeHandler = () => {
    if (welcomeMessageActive && layout.messages.getMessageCount() === 1) {
      layout.messages.replaceLast(buildWelcomeContent());
      layout.tui.requestRender();
    }
  };
  process.stdout.on("resize", welcomeResizeHandler);

  // Status bar segments: provider | connection | mode | state | cost
  layout.statusBar.setSegments([
    { text: "no provider", color: defaultTheme.secondary },
    { text: `${DOT_SYMBOL.empty} not configured`, color: defaultTheme.error },
    { text: `${ICONS.diamond} default`, color: defaultTheme.primary },
    { text: "idle", color: defaultTheme.dim },
    { text: "", color: defaultTheme.dim },
  ]);
  layout.statusBar.setRightText(defaultTheme.dim("/help"));

  // ── Workspace config overlay ──────────────────────────────────────
  _mark("workspace detection start");
  {
    const { isWorkspaceInitialized, readWorkspaceConfig, getWorkspaceInfo } = await import("../core/workspace.js");
    if (isWorkspaceInitialized()) {
      const wsConfig = readWorkspaceConfig();
      if (wsConfig) {
        const { setWorkspaceOverlay } = await import("../core/global-config.js");
        setWorkspaceOverlay(wsConfig as Record<string, unknown>);
      }
      const info = getWorkspaceInfo();
      layout.statusBar.setRightText(defaultTheme.dim(`\ud83d\udcc1 ${info.projectName}  /help`));
    }
  }

  _mark("workspace detection done");

  // ── Tier 1: Instant config check (no network, no async) ──────────
  _mark("tier1 config check start");
  const instantConfig = checkConfigInstant();

  // Initialize unified provider config (reads global config + env vars)
  const { initProviderConfig, refreshProviderConfig, getActiveModel: getProviderActiveModel } = await import("../core/provider-config.js");
  initProviderConfig();
  _mark("tier1 config check done");

  // Set initial connection state and status bar
  if (instantConfig.hasProvider && instantConfig.hasKey) {
    setConnectionState({ status: "ready", providerName: instantConfig.providerName });
  } else if (instantConfig.hasProvider && !instantConfig.hasKey) {
    setConnectionState({ status: "no_key", providerName: instantConfig.providerName });
  } else {
    setConnectionState({ status: "no_key", providerName: "" });
  }

  // Wire connection state changes to status bar
  const colorMap = {
    green: defaultTheme.success,
    red: defaultTheme.error,
    yellow: defaultTheme.warning,
    blue: defaultTheme.info,
    dim: defaultTheme.dim,
  };
  const updateStatusFromConnection = (state: { status: ConnectionStatus; providerName: string }) => {
    const display = getStatusDisplay(state.status);
    if (state.providerName) {
      // Include active model in the provider segment
      const model = getProviderActiveModel();
      const modelShort = model && model.length > 20 ? model.slice(0, 18) + "\u2026" : model;
      const providerDisplay = model
        ? `${state.providerName} ${ICONS.diamond} ${modelShort}`
        : state.providerName;
      layout.statusBar.updateSegment(0, providerDisplay, defaultTheme.secondary);
    }
    layout.statusBar.updateSegment(1, display.text, colorMap[display.colorKey]);
    layout.tui.requestRender();
  };
  onConnectionChange(updateStatusFromConnection);
  // Apply initial state to status bar
  updateStatusFromConnection(getConnectionState());

  // ── Sync status bar when provider/model changes in settings ──────────
  {
    const { onProviderConfigChange } = await import("../core/provider-config.js");
    const { resetGlobalProviderManager } = await import("../providers/provider-factory.js");
    onProviderConfigChange((event) => {
      // Reset cached provider chain so next LLM call uses new provider
      resetGlobalProviderManager();
      // Update status bar: segment 0 = "provider ◆ model"
      const modelShort = event.model.length > 20 ? event.model.slice(0, 18) + "\u2026" : event.model;
      const providerDisplay = event.model
        ? `${event.provider} ${ICONS.diamond} ${modelShort}`
        : event.provider || "no provider";
      layout.statusBar.updateSegment(0, providerDisplay, defaultTheme.secondary);
      layout.tui.requestRender();
    });
  }

  // Set minimal configState for guards (will be fully populated by tier 2)
  ctx.configState = {
    hasProvider: instantConfig.hasProvider,
    providerName: instantConfig.providerName,
    isConnected: false,
    error: instantConfig.hasProvider && !instantConfig.hasKey ? "No API key" : null,
  };

  // ── Provider registry: background refresh + status bar sync ──────────
  let initialHealthCheckDone = false;
  {
    const { getProviderRegistry } = await import("../providers/provider-registry.js");
    const providerRegistry = getProviderRegistry();

    // Non-blocking background discovery (populates model lists, checks health)
    providerRegistry.refreshAll().catch(() => {});

    // When registry state changes (provider save, refresh, wizard), re-sync status bar.
    // Skip re-check if already connected — avoids stale background checks
    // overwriting a good state. Only re-verify when NOT already connected
    // (e.g., after user changes provider in settings).
    providerRegistry.on("models:refreshed", async () => {
      if (!initialHealthCheckDone) return;
      const current = getConnectionState();
      if (current.status === "connected") return;
      try {
        const { resetGlobalProviderManager } = await import("../providers/provider-factory.js");
        resetGlobalProviderManager();
        const { status, error } = await pingProvider(5000);
        const providerName = current.providerName || instantConfig.providerName;
        setConnectionState({ status, providerName });
        ctx.configState = {
          hasProvider: true,
          providerName,
          isConnected: status === "connected",
          error: error ?? null,
        };
      } catch { /* swallow */ }
    });
  }

  if (!instantConfig.hasProvider) {
    // Hide chat UI during first-run setup — only wizard + status bar visible
    layout.editor.hidden = true;
    layout.divider.hidden = true;
    layout.messages.hidden = true;

    const { SetupWizardView } = await import("./interactive/setup-wizard-view.js");
    const wizard = new SetupWizardView(layout.tui, async () => {
      // Restore chat UI after wizard completes
      layout.editor.hidden = false;
      layout.divider.hidden = false;
      layout.messages.hidden = false;
      addWelcomeMessage();

      // Reset cached provider manager so detectConfig reads fresh config
      const { resetGlobalProviderManager } = await import("../providers/provider-factory.js");
      resetGlobalProviderManager();

      setConnectionState({ status: "connecting", providerName: "" });
      const newState = await detectConfig();
      ctx.configState = newState;
      if (newState.hasProvider) {
        const status: ConnectionStatus = newState.isConnected ? "connected" : "offline";
        setConnectionState({ status, providerName: newState.providerName });

        if (newState.isConnected) {
          // Re-resolve provider config after wizard wrote new config
          refreshProviderConfig();
          const { getActiveProviderState } = await import("../providers/active-state.js");
          getActiveProviderState().setActive(newState.providerName, getProviderActiveModel() || "auto", { autoDetected: true });
        }
      }
      initialHealthCheckDone = true;

      // Refresh provider registry so model lists and state sync
      const { getProviderRegistry } = await import("../providers/provider-registry.js");
      getProviderRegistry().refreshAll().catch(() => {});

      // Re-initialize session router so TUI can talk to the LLM
      await initSessionRouter(ctx, opts, layout, registry).catch(() => {});

      layout.tui.requestRender();
    });
    wizard.activate();
  } else {
    addWelcomeMessage();
    // Config warnings shown after deferred health check completes (see below)
  }

  // ── Mode system ─────────────────────────────────────────────────
  const modeSystem = new ModeSystem();
  ctx.modeSystem = modeSystem;
  const updateModeDisplay = () => {
    const info = modeSystem.getModeInfo();
    // Auto-accept mode uses yellow (visual warning), others use mauve
    const modeColor = info.mode === "auto-accept" ? defaultTheme.warning : defaultTheme.primary;
    layout.statusBar.updateSegment(2, `${info.icon} ${info.shortName}`, modeColor);
    layout.tui.requestRender();
  };

  // ── Register /plan (needs modeSystem) ───────────────────────────
  {
    const { createPlanCommand } = await import("./commands/plan.js");
    const planDeps = {
      modeSystem,
      updateModeDisplay,
      flashMessage: (msg: string) => layout.tui.onFlashMessage?.(msg),
    };
    registry.register(createPlanCommand(planDeps));
  }

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
        updateModeDisplay();
        const info = modeSystem.getModeInfo();
        layout.tui.onFlashMessage?.(`${info.icon} ${info.displayName} mode`);
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

  // /copy command — copy last response to clipboard
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

  // TUI callbacks
  layout.tui.onSystemMessage = (msg: string) => {
    layout.messages.addMessage({ role: "system", content: msg, timestamp: new Date() });
    layout.tui.requestRender();
  };

  // Mode action from TUI keybindings (Alt+0..4 direct mode, or mode.cycle)
  layout.tui.onModeAction = (modeAction: string) => {
    if (modeAction === "cycle") {
      modeSystem.cycleNext();
    } else {
      // Direct mode shortcuts: "auto" → "auto-accept", etc.
      const modeMap: Record<string, OperatingMode> = {
        auto: "auto-accept",
        ask: "default",
        build: "auto-accept",
        brainstorm: "default",
        loopHell: "auto-accept",
      };
      const resolved = modeMap[modeAction];
      if (resolved) modeSystem.setMode(resolved);
    }
    updateModeDisplay();
    const info = modeSystem.getModeInfo();
    layout.tui.onFlashMessage?.(`${info.icon} ${info.displayName} mode`);
  };

  // Brief flash notification (e.g., "Copied!") — shows in status bar, auto-clears
  let flashTimer: ReturnType<typeof setTimeout> | null = null;
  const defaultRightText = defaultTheme.dim("/help");
  layout.tui.onFlashMessage = (msg: string) => {
    if (flashTimer) clearTimeout(flashTimer);
    layout.statusBar.setRightText(defaultTheme.success(`${ICONS.success} ${msg}`));
    layout.tui.requestRender();
    flashTimer = setTimeout(() => {
      layout.statusBar.setRightText(defaultRightText);
      layout.tui.requestRender();
      flashTimer = null;
    }, 1500);
  };

  // Prompt navigation — jump between user prompts with Ctrl+Up/Down
  let currentPromptNavIndex = -1; // -1 = at bottom (latest)
  layout.tui.onScrollToPrompt = (direction) => {
    const boundaries = layout.messages.getPromptBoundaries();
    if (boundaries.length === 0) return null;
    if (direction === "prev") {
      if (currentPromptNavIndex <= 0) currentPromptNavIndex = 0;
      else currentPromptNavIndex--;
    } else {
      if (currentPromptNavIndex < 0) return null; // already at bottom
      currentPromptNavIndex++;
      if (currentPromptNavIndex >= boundaries.length) {
        currentPromptNavIndex = -1;
        layout.divider.setLabel(null);
        return 0; // scroll to bottom
      }
    }
    const b = boundaries[currentPromptNavIndex];
    if (!b) return null;
    layout.divider.setLabel(`prompt ${currentPromptNavIndex + 1}/${boundaries.length}`);
    return b.lineIndex;
  };

  // Collapse toggle — toggle the message currently in view
  layout.tui.onToggleCollapse = () => {
    const boundaries = layout.messages.getPromptBoundaries();
    if (boundaries.length === 0) return false;
    // Toggle the message at current nav position (or the last one)
    const idx = currentPromptNavIndex >= 0 && currentPromptNavIndex < boundaries.length
      ? boundaries[currentPromptNavIndex]!.messageIndex
      : boundaries[boundaries.length - 1]!.messageIndex;
    // Toggle the assistant response after this user prompt (idx + 1)
    return layout.messages.toggleCollapse(idx + 1);
  };

  // Update breadcrumb when scroll position changes
  layout.tui.onScrollPositionChanged = (scrollOffset) => {
    if (scrollOffset === 0) {
      layout.divider.setLabel(null);
      currentPromptNavIndex = -1;
    }
  };

  // Install crash handler for clean shutdown on uncaught errors
  try {
    const { CrashHandler } = await import("../recovery/crash-handler.js");
    const crashHandler = new CrashHandler(async () => {
      if (ctx.sessionMgr) await ctx.sessionMgr.shutdown();
      layout.tui.stop();
    });
    crashHandler.install();
  } catch {
    // Recovery module not available — continue without crash handler
  }

  // Safety net: if process exits without going through cleanup, restore terminal
  let terminalRestored = false;
  process.on("exit", () => {
    if (terminalRestored) return;
    terminalRestored = true;
    try {
      process.stdout.write("\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1006l"); // mouse off
      process.stdout.write("\x1b[?25h");   // cursor on
      process.stdout.write("\x1b[?2004l"); // bracketed paste off
      process.stdout.write("\x1b[0m");     // reset attrs
      process.stdout.write("\x1b[?1049l"); // exit alt screen
      if (process.stdin.isTTY) process.stdin.setRawMode(false);
    } catch { /* best effort */ }
  });

  let shuttingDown = false;
  const cleanup = async () => {
    if (shuttingDown) {
      // Second exit attempt → force kill immediately
      process.exit(0);
    }
    shuttingDown = true;

    // IMMEDIATELY restore terminal — don't wait for async cleanup
    if (flashTimer) clearTimeout(flashTimer);
    process.stdout.off("resize", welcomeResizeHandler);
    layout.tui.stop();
    terminalRestored = true;
    setLoggerMuted(false);

    // Force exit after 2s no matter what
    const forceExit = setTimeout(() => process.exit(0), 2000);
    forceExit.unref();

    // Save sessions FIRST so index.json has correct updatedAt
    // (must complete before other cleanup to avoid wrong-session-on-resume)
    try {
      await ctx.sessionMgr?.shutdown();
    } catch { /* best-effort */ }

    // Remaining cleanup in parallel
    try {
      await Promise.allSettled([
        Promise.resolve(ctx.cleanupRouter?.()),
        Promise.resolve(ctx.cleanupSession?.()),
        ctx.router?.shutdown().catch(() => {}),
        ctx.toolOutputHandler?.cleanup().catch(() => {}),
      ]);
    } catch { /* ignore */ }

    // Write profiling report if enabled
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
    // Ensure stdin doesn't keep process alive
    try {
      process.stdin.setRawMode?.(false);
      process.stdin.pause();
      process.stdin.unref();
    } catch { /* */ }
    process.exit(0);
  };
  layout.tui.onExit = () => void cleanup();

  // Start the TUI
  _mark("tui.start() — first paint");
  layout.tui.start();
  _mark("TUI running, prompt visible");
  _printStartupTimings();

  // ── Tier 2: Background health ping (after first paint) ──────────────
  if (instantConfig.hasProvider && instantConfig.hasKey) {
    // Animated spinner while connecting
    const spinFrames = defaultTheme.symbols.spinner;
    let spinIdx = 0;
    let spinnerRunning = true;
    const connectSpinner = setInterval(() => {
      if (!spinnerRunning) return;
      spinIdx = (spinIdx + 1) % spinFrames.length;
      setConnectionState({ status: "connecting", providerName: instantConfig.providerName });
    }, 100);

    // Delay slightly to let TUI render first frame
    setTimeout(() => {
      _mark("tier2 health ping start");
      pingProvider(5000).then(({ status, error }) => {
        clearInterval(connectSpinner);
        spinnerRunning = false;
        initialHealthCheckDone = true;
        _mark("tier2 health ping done");

        setConnectionState({ status, providerName: instantConfig.providerName });

        // Update configState for guards
        ctx.configState = {
          hasProvider: true,
          providerName: instantConfig.providerName,
          isConnected: status === "connected",
          error: error ?? null,
        };

        if (status === "connected") {
          // Sync provider config → ActiveProviderState
          refreshProviderConfig();
          import("../providers/active-state.js").then(({ getActiveProviderState }) => {
            getActiveProviderState().setActive(instantConfig.providerName, getProviderActiveModel() || "auto", { autoDetected: true });
          });
        } else if (status === "auth_failed") {
          showConfigWarning({
            hasProvider: true,
            providerName: instantConfig.providerName,
            isConnected: false,
            error: error ?? "API key invalid",
          }, layout);
        }
      }).catch(() => {
        clearInterval(connectSpinner);
        spinnerRunning = false;
        initialHealthCheckDone = true;
        setConnectionState({ status: "error", providerName: instantConfig.providerName });
      });
    }, 100);
  } else {
    initialHealthCheckDone = true;
  }

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

// ---------------------------------------------------------------------------
// Session helpers
// ---------------------------------------------------------------------------

function showPlanConfirmation(
  ctx: {
    chatSession: Session | null;
    modeSystem: import("../tui/keybindings/mode-system.js").ModeSystem | null;
    router: PromptRouter | null;
  },
  layout: AppLayout,
): void {
  const session = ctx.chatSession;
  if (!session) return;

  // Find last assistant message as the plan — must be substantial (200+ chars)
  const messages = session.messages;
  const lastAssistant = [...messages].reverse().find((m) => m.role === "assistant");
  if (!lastAssistant?.content || lastAssistant.content.length < 200) return;

  // Build confirmation UI
  const termW = process.stdout.columns ?? 80;
  const lines = [
    "",
    separator({ width: Math.min(40, termW - 8), label: "Plan ready", padding: 4 }),
    `    Execute this plan? ${defaultTheme.success("[Y]es")}  ${defaultTheme.muted("[N]o (keep planning)")}  ${defaultTheme.muted("[E]dit (refine)")}`,
    "",
  ];
  layout.tui.setInteractiveView(lines);

  const handler = {
    handleKey(event: import("../tui/core/input.js").KeyEvent): boolean {
      const dismiss = () => {
        layout.tui.popKeyHandler();
        layout.tui.clearInteractiveView();
      };

      if (event.type === "char" && (event.char === "y" || event.char === "Y")) {
        dismiss();
        const planText = lastAssistant.content;
        ctx.modeSystem?.setMode("default");

        // Inject plan as transient system message (sent to LLM but not rendered in chat)
        if (session) {
          session.addMessage({
            role: "system",
            content: `Execute this plan step by step. Use all available tools.\n\n---\n${planText}\n---`,
            metadata: { transient: true },
          });
        }

        // Show brief status in chat
        layout.messages.addMessage({
          role: "system",
          content: defaultTheme.success(`${ICONS.planMode} Executing plan...`),
          timestamp: new Date(),
        });
        layout.tui.requestRender();

        // Route execution prompt to the agent
        if (ctx.router && session) {
          setTimeout(() => {
            void handleWithRouter(
              "Execute this plan step by step.",
              session,
              ctx.router!,
              layout,
              { addMessage: (role: string, content: string) => {
                layout.messages.addMessage({ role: role as "system" | "error", content, timestamp: new Date() });
                layout.tui.requestRender();
              }},
            );
          }, 0);
        }
        return true;
      }

      if (event.type === "char" && (event.char === "n" || event.char === "N" || event.char === "e" || event.char === "E")) {
        dismiss();
        return true;
      }

      if (event.type === "escape") {
        dismiss();
        return true;
      }

      return true;
    },
  };
  layout.tui.pushKeyHandler(handler);
}

function replaySessionHistory(session: Session | null, layout: AppLayout): void {
  if (!session) return;
  const history = session.buildContextMessages();

  // Annotate orphaned user messages (session ended before response)
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

  // Scroll to bottom and paint so history is visible immediately
  layout.tui.scrollToBottom();
  layout.tui.requestRender();
}

async function showSessionPicker(
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
          // Delete all sessions except the active one
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

function registerSessionCommands(
  registry: import("../tui/index.js").CommandRegistry,
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
        // Save current, create new
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

      // Default: show picker (for /sessions, /session list, /session switch, /session)
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

/** Initialize SessionManager + PromptRouter after TUI has started. */
async function initSessionRouter(
  ctx: {
    sessionMgr: SessionManager | null;
    router: PromptRouter | null;
    chatSession: Session | null;
    cleanupRouter: (() => void) | null;
    cleanupSession: (() => void) | null;
    doomLoopDetector: { reset: () => void } | null;
    toolOutputHandler: { cleanup: () => Promise<void> } | null;
    configState: ConfigState | null;
    modeSystem: ModeSystem | null;
    onQueueDrain: (() => void) | null;
  },
  opts: LaunchOptions | undefined,
  layout: AppLayout,
  registry: CommandRegistry,
): Promise<void> {
  _mark("[bg] initSessionRouter start");
  const { createSessionManager } = await import("../session/index.js");
  const { PromptRouter: RouterClass } = await import("../router/index.js");
  const { createLLMAgentRunner } = await import("../router/llm-agent-runner.js");
  _mark("[bg] session/router/runner imports done");

  ctx.sessionMgr = createSessionManager({
    sessionsDir: opts?.sessionsDir,
  });
  await ctx.sessionMgr.initialize();
  _mark("[bg] session manager initialized");

  // Create LLM-backed agent runner with token streaming and tool support.
  const tokenEmitter = { emit: (_agentId: string, _token: string) => {} };
  const toolEmitter = { emit: (_agentId: string, _tool: string, _status: string, _details?: Record<string, unknown>) => {} };

  // Lazy-load tool registry and executor for tool support
  let toolRegistry: import("../tools/registry.js").ToolRegistry | null = null;
  let toolExecutor: import("../tools/executor.js").ToolExecutor | null = null;

  try {
    _mark("[bg] tool registry import start");
    const { ToolRegistry } = await import("../tools/registry.js");
    const { ToolExecutor } = await import("../tools/executor.js");
    const { PermissionResolver } = await import("../tools/permissions.js");
    const { registerBuiltInTools } = await import("../tools/built-in/index.js");

    const reg = new ToolRegistry();
    registerBuiltInTools(reg);
    toolRegistry = reg;
    toolExecutor = new ToolExecutor(reg, new PermissionResolver());

    // Wire tool confirmation: show inline prompt for dangerous tools
    toolExecutor.on(ToolEvent.ConfirmationNeeded, ({ toolName, input, riskLevel, approve, reject }: {
      toolName: string; input: unknown; riskLevel: string; category: string;
      approve: (always?: boolean) => void; reject: () => void;
    }) => {
      const prompt = formatToolPermissionPrompt(toolName, input, riskLevel);
      layout.messages.addMessage({
        role: "system",
        content: prompt,
        timestamp: new Date(),
        tag: "tool-approval",
      });
      layout.tui.requestRender();

      const resolve = (result: string, color: (s: string) => string, action: () => void) => {
        layout.tui.popKeyHandler();
        layout.messages.replaceLast(
          formatToolPermissionResolved(toolName, riskLevel, result, color),
        );
        layout.tui.requestRender();
        action();
      };

      layout.tui.pushKeyHandler({
        handleKey: (event) => {
          if (event.type === "char" && !event.ctrl) {
            const ch = event.char.toLowerCase();
            if (ch === "y") { resolve(`${ICONS.success} Approved`, defaultTheme.success, () => approve()); return true; }
            if (ch === "n") { resolve(`${ICONS.error} Denied`, defaultTheme.error, () => reject()); return true; }
            if (ch === "!") { resolve(`${ICONS.success} Always approved for session`, defaultTheme.success, () => approve(true)); return true; }
          }
          if (event.type === "escape") { resolve(`${ICONS.error} Denied`, defaultTheme.error, () => reject()); return true; }
          return true;
        },
      });
    });

    // Wire ToolExecutor lifecycle events to status bar
    toolExecutor.on(ToolEvent.Start, (_id: string, toolName: string) => {
      // Remove resolved approval message — live tool view now shows spinner
      layout.messages.removeLastByTag("tool-approval");
      layout.statusBar.updateSegment(3, `${toolName}...`, defaultTheme.accent);
      layout.tui.requestRender();
    });
    toolExecutor.on(ToolEvent.Done, (_id: string, toolName: string) => {
      layout.statusBar.updateSegment(3, `${toolName} done`, defaultTheme.success);
      layout.tui.requestRender();
    });
    toolExecutor.on(ToolEvent.Error, (_id: string, toolName: string) => {
      layout.statusBar.updateSegment(3, `${toolName} failed`, defaultTheme.error);
      layout.tui.requestRender();
    });
  } catch {
    // Tools not available — run without tools
  }

  // ── UndoManager — snapshot files before destructive tool calls ──
  let undoManager: import("../conversation/undo-manager.js").UndoManager | null = null;
  try {
    const { UndoManager } = await import("../conversation/undo-manager.js");
    const { join } = await import("node:path");
    const { tmpdir } = await import("node:os");
    undoManager = new UndoManager(join(tmpdir(), "openpawl-undo"));
  } catch {
    // UndoManager not available
  }

  // ── Context management modules ──────────────────────────────────
  const { DoomLoopDetector } = await import("../context/doom-loop-detector.js");
  const { ToolOutputHandler } = await import("../context/tool-output-handler.js");
  const { ContextTracker } = await import("../context/context-tracker.js");

  const doomLoopDetector = new DoomLoopDetector();
  const toolOutputHandler = new ToolOutputHandler(process.cwd());
  const contextTracker = new ContextTracker(200_000); // Default 200k, updated when model is known

  // Store refs for cleanup and doom-loop reset
  ctx.doomLoopDetector = doomLoopDetector;
  ctx.toolOutputHandler = toolOutputHandler;

  // Register /compact command now that we have context tracker
  const { createCompactCommand } = await import("./commands/compact.js");
  registry.register(createCompactCommand({
    contextTracker,
    getMessages: () => {
      const session = ctx.chatSession;
      if (!session) return [];
      return session.messages.map((m) => ({
        role: m.role,
        content: m.content,
        toolCallId: m.toolCallId,
        metadata: m.metadata,
      }));
    },
  }));

  const PLAN_ONLY_TOOLS = new Set(["file_read", "file_list", "web_search", "web_fetch"]);
  const filterToolsForMode = (toolNames: string[], appCtx: typeof ctx): string[] => {
    return appCtx.modeSystem?.getMode() === "plan-only"
      ? [...toolNames].filter((t) => PLAN_ONLY_TOOLS.has(t))
      : toolNames;
  };

  const agentRunner = createLLMAgentRunner({
    onToken: (agentId, token) => tokenEmitter.emit(agentId, token),
    onToolCall: (agentId, toolName, status, details) => toolEmitter.emit(agentId, toolName, status, details as Record<string, unknown> | undefined),
    getToolSchemas: toolRegistry
      ? (toolNames) => {
          const filtered = filterToolsForMode(toolNames, ctx);
          return toolRegistry!.exportForLLM(filtered);
        }
      : undefined,
    getNativeTools: toolRegistry
      ? (toolNames) => {
          const filtered = filterToolsForMode(toolNames, ctx);
          return toolRegistry!.exportForAPI(filtered);
        }
      : undefined,
    executeTool: toolExecutor
      ? async (toolName, args) => {
          // Snapshot files before destructive tools (for /undo)
          if ((toolName === "file_write" || toolName === "file_edit") && undoManager && typeof args === "object" && args !== null) {
            const filePath = (args as Record<string, unknown>).path ?? (args as Record<string, unknown>).file_path;
            if (typeof filePath === "string") {
              await undoManager.snapshot(filePath, "agent").catch(() => {});
            }
          }

          const result = await toolExecutor!.execute(toolName, args, {
            sessionId: ctx.chatSession?.id ?? "",
            agentId: "agent",
            workingDirectory: process.cwd(),
          });
          if (result.isOk()) {
            return result.value.fullOutput || JSON.stringify(result.value.data) || result.value.summary;
          }
          const cause = "cause" in result.error ? `: ${result.error.cause}` : "";
          throw new Error(`${result.error.type}${cause}`);
        }
      : undefined,
    doomLoopDetector,
    toolOutputHandler,
    contextTracker,
    onContextUpdate: (utilization, level) => {
      layout.statusBar.updateSegment(3,
        level === "normal" ? "idle" : `ctx: ${utilization}%`,
        level === "emergency" || level === "critical" ? defaultTheme.error
          : level === "high" || level === "warning" ? defaultTheme.warning
          : defaultTheme.dim,
      );
      layout.tui.requestRender();
    },
  });

  _mark("[bg] tool registry + executor ready");
  ctx.router = new RouterClass({}, ctx.sessionMgr, null, agentRunner);
  await ctx.router.initialize();
  _mark("[bg] router initialized");

  // Load workspace-local agents (.openpawl/agents/) if workspace exists
  {
    const { isWorkspaceInitialized, getWorkspacePath } = await import("../core/workspace.js");
    if (isWorkspaceInitialized()) {
      const wsAgentsDir = getWorkspacePath() + "/agents";
      await ctx.router.getRegistry().loadUserAgents(wsAgentsDir);
    }
  }

  // Now that the router exists, wire the emitters to it.
  tokenEmitter.emit = (agentId: string, token: string) => {
    ctx.router?.emit(RouterEvent.AgentToken, ctx.chatSession?.id ?? "", agentId, token);
  };
  toolEmitter.emit = (agentId: string, toolName: string, status: string, details?: Record<string, unknown>) => {
    ctx.router?.emit(RouterEvent.AgentTool, ctx.chatSession?.id ?? "", agentId, toolName, status, details);
  };


  // ── Wire LatencyTracker — TTFT + tokens/sec metrics ────────────
  try {
    const { LatencyTracker } = await import("../performance/latency-tracker.js");
    const latencyTracker = new LatencyTracker();
    let activeRequestTracker: ReturnType<typeof latencyTracker.startRequest> | null = null;

    ctx.router.on(RouterEvent.AgentStart, (sessionId: string, agentId: string) => {
      activeRequestTracker = latencyTracker.startRequest(sessionId, agentId);
      activeRequestTracker.markSubmitted();
      activeRequestTracker.markRequestSent();
    });

    // First token → record TTFT
    ctx.router.on(RouterEvent.AgentToken, () => {
      if (activeRequestTracker) {
        activeRequestTracker.markFirstToken();
      }
    });

    ctx.router.on(RouterEvent.AgentDone, (sessionId: string, _agentId: string, result: { outputTokens?: number }) => {
      if (activeRequestTracker) {
        activeRequestTracker.markComplete(result.outputTokens ?? 0);
        latencyTracker.recordMetrics(sessionId, activeRequestTracker.getMetrics());
        activeRequestTracker = null;
      }
    });
  } catch {
    // LatencyTracker not available
  }

  // ── Wire ErrorPresenter — friendly error messages ──────────────
  try {
    const { ErrorPresenter } = await import("../recovery/error-presenter.js");
    const errorPresenter = new ErrorPresenter();

    ctx.router.on(RouterEvent.Error, (_sessionId: string, error: unknown) => {
      const presented = errorPresenter.present(error);
      const lines = errorPresenter.formatForChat(presented);
      layout.messages.addMessage({
        role: "error",
        content: lines.join("\n"),
        timestamp: new Date(),
      });
      layout.tui.requestRender();
    });
  } catch {
    // ErrorPresenter not available
  }

  // Always start fresh — user resumes via /sessions when needed
  {
    const createResult = await ctx.sessionMgr.create(process.cwd());
    ctx.chatSession = createResult.isOk() ? createResult.value : null;
  }
  _mark("[bg] session created");

  // Wire events
  ctx.cleanupRouter = wireRouterEvents(ctx.router, layout, (agentId, content) => {
    if (ctx.chatSession) {
      ctx.chatSession.addMessage({ role: "assistant", content, agentId });
    }
  }, () => {
    // Plan-ready callback: show execute confirmation when agent finishes in plan mode
    if (ctx.modeSystem?.getMode() !== "plan-only") return;
    showPlanConfirmation(ctx, layout);
  }, () => {
    // Queue drain callback: process next queued prompt
    ctx.onQueueDrain?.();
  }, (input, output) => {
    // Track token usage in session state for persistence
    ctx.chatSession?.addTokenUsage("default", input, output);
  });
  ctx.cleanupSession = wireSessionEvents(ctx.sessionMgr, layout);

  // Register /sprint command
  {
    const { createSprintCommand } = await import("./commands/sprint.js");
    registry.register(createSprintCommand({
      agents: ctx.router.getRegistry(),
      toolRegistry: toolRegistry ?? undefined,
      toolExecutor: toolExecutor ?? undefined,
      layout,
    }));
  }

  // Register router-powered commands
  if (ctx.chatSession) {
    registerRouterCommands(registry, ctx.router, ctx.chatSession, layout);
  }

  // Register session management commands
  registerSessionCommands(registry, ctx, layout);

  // Update autocomplete to include @agent mentions
  layout.editor.setAutocompleteProvider(
    createAutocompleteProvider(registry, process.cwd(), ctx.router),
  );
  _mark("[bg] initSessionRouter complete");
  _printStartupTimings(); // second print with bg marks included
}

// ---------------------------------------------------------------------------
// Register router-powered slash commands into TUI command registry
// ---------------------------------------------------------------------------

function registerRouterCommands(
  registry: CommandRegistry,
  router: PromptRouter,
  _session: Session,
  _layout: AppLayout,
): void {
  registry.register({
    name: "agents",
    description: "List available agents",
    async execute(_args, ctx) {
      const { renderPanel, panelSection } = await import("../tui/components/panel.js");
      const { labelValue } = await import("../tui/primitives/columns.js");
      const { getAgentColor } = await import("../tui/primitives/badge.js");
      const agents = router.getRegistry().getAll();
      const contentLines = [...panelSection("Built-in")];
      for (const a of agents) {
        const colorFn = getAgentColor(a.id);
        contentLines.push(labelValue("@" + a.id, a.description, { labelWidth: 16, labelColor: colorFn, valueColor: defaultTheme.muted, gap: 1 }));
      }
      contentLines.push("");
      contentLines.push(defaultTheme.dim("Use @agent in your prompt to route directly."));
      const panel = renderPanel({ title: "Agents", footer: "Press any key to close" }, contentLines);
      ctx.addMessage("system", panel.join("\n"));
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
