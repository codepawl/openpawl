/**
 * Background initialization of SessionManager + PromptRouter after TUI starts.
 */

import { mark, printStartupTimings } from "./startup.js";
import { formatToolPermissionPrompt, formatToolPermissionResolved } from "./tool-permission.js";
import { wireRouterEvents, wireSessionEvents, type RouterEventWiring } from "./router-wiring.js";
import { registerSessionCommands } from "./session-helpers.js";
import { createAutocompleteProvider } from "./autocomplete.js";
import { ICONS } from "../tui/constants/icons.js";
import { defaultTheme } from "../tui/themes/default.js";
import { RouterEvent, ToolEvent } from "../router/event-types.js";
import { type ConfigState } from "./config-check.js";
import type { AppLayout } from "./layout.js";
import type { LaunchOptions } from "./index.js";
import type { SessionManager } from "../session/session-manager.js";
import type { Session } from "../session/session.js";
import type { PromptRouter } from "../router/prompt-router.js";
import type { CommandRegistry } from "../tui/index.js";
import type { AppModeSystem } from "../tui/keybindings/app-mode.js";

export interface AppContext {
  sessionMgr: SessionManager | null;
  router: PromptRouter | null;
  chatSession: Session | null;
  cleanupRouter: RouterEventWiring | null;
  cleanupSession: (() => void) | null;
  doomLoopDetector: { reset: () => void } | null;
  toolOutputHandler: { cleanup: () => Promise<void> } | null;
  configState: ConfigState | null;
  appModeSystem: AppModeSystem | null;
  memoryCleanup: (() => void) | null;
  onQueueDrain: (() => void) | null;
}

export async function initSessionRouter(
  ctx: AppContext,
  opts: LaunchOptions | undefined,
  layout: AppLayout,
  registry: CommandRegistry,
): Promise<void> {
  mark("[bg] initSessionRouter start");
  const { createSessionManager } = await import("../session/index.js");
  const { PromptRouter: RouterClass } = await import("../router/index.js");
  const { createLLMAgentRunner } = await import("../router/llm-agent-runner.js");
  mark("[bg] session/router/runner imports done");

  ctx.sessionMgr = createSessionManager({
    sessionsDir: opts?.sessionsDir,
  });
  await ctx.sessionMgr.initialize();
  mark("[bg] session manager initialized");

  const tokenEmitter = { emit: (_agentId: string, _token: string) => {} };
  const toolEmitter = { emit: (_agentId: string, _tool: string, _status: string, _details?: Record<string, unknown>) => {} };

  let toolRegistry: import("../tools/registry.js").ToolRegistry | null = null;
  let toolExecutor: import("../tools/executor.js").ToolExecutor | null = null;

  try {
    mark("[bg] tool registry import start");
    const { ToolRegistry } = await import("../tools/registry.js");
    const { ToolExecutor } = await import("../tools/executor.js");
    const { PermissionResolver } = await import("../tools/permissions.js");
    const { registerBuiltInTools } = await import("../tools/built-in/index.js");

    const reg = new ToolRegistry();
    registerBuiltInTools(reg);
    toolRegistry = reg;
    toolExecutor = new ToolExecutor(reg, new PermissionResolver());

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

    toolExecutor.on(ToolEvent.Start, (_id: string, toolName: string) => {
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
  const contextTracker = new ContextTracker(200_000);

  ctx.doomLoopDetector = doomLoopDetector;
  ctx.toolOutputHandler = toolOutputHandler;

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

  // ── Memory stack initialization (non-blocking, graceful degradation) ──
  let memoryContext: ((prompt: string) => Promise<string | null>) | undefined;
  let hebbianCleanup: (() => void) | undefined;
  {
    try {
      const { GlobalMemoryManager } = await import("../memory/global/store.js");
      const { HttpEmbeddingFunction } = await import("../core/knowledge-base.js");
      const { DecisionStore } = await import("../journal/store.js");
      const { initHebbianIntegration } = await import("../memory/hebbian-integration.js");

      const embedder = new HttpEmbeddingFunction("http://localhost:11434", "nomic-embed-text", "");
      const globalMem = new GlobalMemoryManager();
      await globalMem.init(embedder);

      const decisionStore = new DecisionStore();
      const db = globalMem.getDb();
      if (db) await decisionStore.init(db);

      const hebbian = initHebbianIntegration();
      if (hebbian.enabled) hebbianCleanup = () => hebbian.cleanup();

      const patternStore = globalMem.getPatternStore();

      memoryContext = async (prompt: string): Promise<string | null> => {
        const parts: string[] = [];

        if (patternStore) {
          try {
            const { retrieveSuccessPatterns } = await import("../memory/success/retriever.js");
            const patterns = await retrieveSuccessPatterns(patternStore, embedder, prompt, { limit: 3 });
            if (patterns.length > 0) {
              const { withSuccessContext } = await import("../memory/success/prompt.js");
              parts.push(withSuccessContext("", patterns));
            }
          } catch {
            // Pattern retrieval failed — skip
          }
        }

        try {
          const decisions = await decisionStore.getAll();
          if (decisions.length > 0) {
            const { withDecisionContext } = await import("../journal/prompt.js");
            parts.push(withDecisionContext("", decisions));
          }
        } catch {
          // Decision retrieval failed — skip
        }

        const combined = parts.join("\n").trim();
        return combined || null;
      };

      if (hebbianCleanup) ctx.memoryCleanup = hebbianCleanup;
      mark("[bg] memory stack initialized");
    } catch {
      mark("[bg] memory stack skipped (init failed)");
    }
  }

  const agentRunner = createLLMAgentRunner({
    onToken: (agentId, token) => tokenEmitter.emit(agentId, token),
    onToolCall: (agentId, toolName, status, details) => toolEmitter.emit(agentId, toolName, status, details as Record<string, unknown> | undefined),
    getToolSchemas: toolRegistry
      ? (toolNames) => {
          return toolRegistry!.exportForLLM(toolNames);
        }
      : undefined,
    getNativeTools: toolRegistry
      ? (toolNames) => {
          return toolRegistry!.exportForAPI(toolNames);
        }
      : undefined,
    executeTool: toolExecutor
      ? async (toolName, args) => {
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
            const text = result.value.fullOutput || JSON.stringify(result.value.data) || result.value.summary;
            const data = result.value.data as Record<string, unknown> | undefined;
            const diff = data?.diff as import("../utils/diff.js").DiffResult | undefined;
            const shell = toolName === "shell_exec" && data
              ? { exitCode: data.exitCode as number | undefined, stderrHead: typeof data.stderr === "string" ? (data.stderr as string).slice(0, 200) : undefined }
              : undefined;
            const success = result.value.success;
            if (diff || shell) {
              return { text, diff, success, exitCode: shell?.exitCode, stderrHead: shell?.stderrHead };
            }
            return text;
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
    getMemoryContext: memoryContext,
  });

  mark("[bg] tool registry + executor ready");
  ctx.router = new RouterClass({}, ctx.sessionMgr, null, agentRunner);
  await ctx.router.initialize();
  mark("[bg] router initialized");

  // Load workspace-local agents
  {
    const { isWorkspaceInitialized, getWorkspacePath } = await import("../core/workspace.js");
    if (isWorkspaceInitialized()) {
      const wsAgentsDir = getWorkspacePath() + "/agents";
      await ctx.router.getRegistry().loadUserAgents(wsAgentsDir);
    }
  }

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

  // ── Wire Debug Logger — structured JSONL debug logs ─────────────
  if (process.env.OPENPAWL_DEBUG) {
    try {
      const { setDebugSessionId } = await import("../debug/logger.js");
      const { wireDebugToRouter, wireDebugToToolExecutor } = await import("../debug/wiring.js");
      setDebugSessionId("tui");
      wireDebugToRouter(ctx.router);
      if (toolExecutor) {
        wireDebugToToolExecutor(toolExecutor);
      }
    } catch {
      // Debug logger not available
    }
  }

  // Try to resume latest session in this workspace, fall back to creating fresh
  {
    const resumeResult = await ctx.sessionMgr.resumeLatest();
    if (resumeResult.isOk() && resumeResult.value) {
      ctx.chatSession = resumeResult.value;
    } else {
      const createResult = await ctx.sessionMgr.create(process.cwd());
      ctx.chatSession = createResult.isOk() ? createResult.value : null;
    }
  }
  mark("[bg] session created");

  // Wire events
  ctx.cleanupRouter = wireRouterEvents(ctx.router, layout, (agentId, content) => {
    if (ctx.chatSession) {
      ctx.chatSession.addMessage({ role: "assistant", content, agentId });
    }
  }, undefined, () => {
    ctx.onQueueDrain?.();
  }, (input, output) => {
    ctx.chatSession?.addTokenUsage("default", input, output);
  });
  ctx.cleanupSession = wireSessionEvents(ctx.sessionMgr, layout);

  // Register router-powered commands
  if (ctx.chatSession) {
    registerRouterCommands(registry, ctx.router);
  }

  registerSessionCommands(registry, ctx, layout);

  layout.editor.setAutocompleteProvider(
    createAutocompleteProvider(registry, process.cwd(), ctx.router),
  );
  mark("[bg] initSessionRouter complete");
  printStartupTimings();
}

// ---------------------------------------------------------------------------
// Register router-powered slash commands into TUI command registry
// ---------------------------------------------------------------------------

function registerRouterCommands(
  registry: CommandRegistry,
  router: PromptRouter,
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
