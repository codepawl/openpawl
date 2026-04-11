/**
 * Prompt Router — main entry point for user prompts.
 * Ties together: mention parsing → intent classification → route resolution → dispatch.
 */

import { EventEmitter } from "node:events";
import { Result, ok, err } from "neverthrow";
import os from "node:os";
import path from "node:path";
import { ContextTracker } from "../context/context-tracker.js";
import { compact, type CompactableMessage } from "../context/compaction.js";
import type { ContextLevel } from "../context/types.js";
import type {
  PromptIntent,
  RouteDecision,
  DispatchResult,
  RouterError,
} from "./router-types.js";
import { AgentRegistry } from "./agent-registry.js";
import { IntentClassifier } from "./intent-classifier.js";
import type { ClassifierLLM } from "./intent-classifier.js";
import { AgentResolver } from "./agent-resolver.js";
import { Dispatcher } from "./dispatch-strategy.js";
import type { AgentRunner } from "./dispatch-strategy.js";
import { RouterEvent, DISPATCH_EVENTS } from "./event-types.js";
import { parseMentions } from "./mention-parser.js";
import type { SessionManager } from "../session/index.js";

// ─── Config ──────────────────────────────────────────────────────────────────

export interface PromptRouterConfig {
  classificationModel?: string;
  skipClassificationPatterns?: string[];
  defaultAgent?: string;
  maxParallelAgents?: number;
  confirmationThresholdUSD?: number;
  autoFollowUp?: boolean;
  showRoutingDecision?: boolean;
  customAgentsDir?: string;
  contextTracker?: ContextTracker;
}

const ROUTER_DEFAULTS = {
  defaultAgent: "assistant",
  maxParallelAgents: 3,
  confirmationThresholdUSD: 0.5,
  autoFollowUp: true,
  showRoutingDecision: false,
} as const;

// ─── Slash Commands ──────────────────────────────────────────────────────────

type SlashHandler = (sessionId: string, args: string) => Promise<Result<string, RouterError>>;

// ─── Router ──────────────────────────────────────────────────────────────────

export class PromptRouter extends EventEmitter {
  private registry: AgentRegistry;
  private classifier: IntentClassifier;
  private resolver: AgentResolver;
  private dispatcher: Dispatcher;
  private config: Required<Omit<PromptRouterConfig, "classificationModel" | "skipClassificationPatterns" | "customAgentsDir" | "contextTracker">> & {
    customAgentsDir: string;
  };
  private sessionManager: SessionManager;
  private contextTracker: ContextTracker | null;
  private lastAgentBySession = new Map<string, string>();
  private pendingConfirmation = new Map<string, RouteDecision>();
  private slashCommands: Map<string, SlashHandler>;

  constructor(
    config: PromptRouterConfig,
    sessionManager: SessionManager,
    classifierLLM: ClassifierLLM | null | undefined,
    agentRunner: AgentRunner,
  ) {
    super();
    this.sessionManager = sessionManager;
    this.contextTracker = config.contextTracker ?? null;

    this.config = {
      defaultAgent: config.defaultAgent ?? ROUTER_DEFAULTS.defaultAgent,
      maxParallelAgents: config.maxParallelAgents ?? ROUTER_DEFAULTS.maxParallelAgents,
      confirmationThresholdUSD: config.confirmationThresholdUSD ?? ROUTER_DEFAULTS.confirmationThresholdUSD,
      autoFollowUp: config.autoFollowUp ?? ROUTER_DEFAULTS.autoFollowUp,
      showRoutingDecision: config.showRoutingDecision ?? ROUTER_DEFAULTS.showRoutingDecision,
      customAgentsDir: config.customAgentsDir ?? path.join(os.homedir(), ".openpawl", "agents"),
    };

    this.registry = new AgentRegistry();
    this.classifier = new IntentClassifier(classifierLLM ?? null, this.registry.getAll());
    this.resolver = new AgentResolver(this.registry);
    this.dispatcher = new Dispatcher(this.registry, agentRunner);

    // Forward dispatcher events
    for (const event of DISPATCH_EVENTS) {
      this.dispatcher.on(event, (...args: unknown[]) => {
        this.emit(event, ...args);
      });
    }

    // Build slash command map
    this.slashCommands = new Map<string, SlashHandler>([
      ["help", (sid) => this.handleHelp(sid)],
      ["agents", (sid) => this.handleAgentsList(sid)],
      ["cost", (sid) => this.handleCost(sid)],
      ["status", (sid) => this.handleStatus(sid)],
      ["clear", (sid) => this.handleClear(sid)],
      ["compact", (sid, a) => this.handleCompact(sid, a)],
      ["model", (sid, a) => this.handleModel(sid, a)],
      ["agent", (sid, a) => this.handleSetAgent(sid, a)],
      ["export", (sid, a) => this.handleExport(sid, a)],
      ["config", (sid) => this.handleConfig(sid)],
      ["undo", (sid) => this.handleUndo(sid)],
    ]);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // MAIN ENTRY POINT
  // ═══════════════════════════════════════════════════════════════════════════

  async route(
    sessionId: string,
    prompt: string,
  ): Promise<Result<DispatchResult, RouterError>> {
    // 1. Check for pending confirmation
    const pendingDecision = this.pendingConfirmation.get(sessionId);
    if (pendingDecision) {
      return this.handleConfirmationResponse(sessionId, prompt, pendingDecision);
    }

    // 2. Check slash command
    const slashHandled = await this.handleSlashCommand(sessionId, prompt);
    if (slashHandled) {
      return ok({
        strategy: "single",
        agentResults: [{
          agentId: "system",
          success: true,
          response: slashHandled,
          toolCalls: [],
          duration: 0,
          inputTokens: 0,
          outputTokens: 0,
        }],
        totalDuration: 0,
        totalInputTokens: 0,
        totalOutputTokens: 0,
      });
    }

    // 3. Parse mentions
    const mentions = parseMentions(prompt, this.registry.getIds());

    // 4. Classify intent
    let intent: PromptIntent;
    if (mentions.hasExplicitRouting) {
      // Skip classification for explicit routing
      intent = {
        category: "code_write", // doesn't matter, mentions override
        confidence: 1.0,
        complexity: "simple",
        requiresTools: [],
        suggestedAgents: mentions.mentions.map((m) => m.agentId),
        reasoning: "Explicit @mention routing",
      };
    } else {
      const session = this.sessionManager.getActive();
      const classResult = await this.classifier.classify(mentions.cleanedPrompt, {
        workingDirectory: session?.getState().workingDirectory,
        trackedFiles: session?.getState().trackedFiles,
      });
      if (classResult.isErr()) return err(classResult.error);
      intent = classResult.value;
    }

    // 5. Resolve route
    const resolveResult = this.resolver.resolve(intent, mentions, {
      lastAgentId: this.lastAgentBySession.get(sessionId),
    });
    if (resolveResult.isErr()) return err(resolveResult.error);
    const decision = resolveResult.value;

    // 6. Show routing decision if debug mode
    if (this.config.showRoutingDecision) {
      this.emit(RouterEvent.Decision, sessionId, decision, intent);
    }

    // 7. Confirmation gate
    if (decision.requiresConfirmation) {
      this.pendingConfirmation.set(sessionId, decision);
      const agentNames = decision.agents.map((a) => a.role).join(", ");
      const costStr = "";
      return ok({
        strategy: "single",
        agentResults: [{
          agentId: "system",
          success: true,
          response: `This task will use [${agentNames}] with ${decision.strategy} strategy${costStr}. Proceed? [Y/n]`,
          toolCalls: [],
          duration: 0,
          inputTokens: 0,
          outputTokens: 0,
        }],
        totalDuration: 0,
        totalInputTokens: 0,
        totalOutputTokens: 0,
      });
    }

    // 8. Build session history for context
    const activeSession = this.sessionManager.getActive();
    const sessionHistory = activeSession
      ? activeSession.buildContextMessages()
          .filter(m => m.role !== "system")
          .map(m => ({ role: m.role, content: m.content }))
      : [];

    // 9. Dispatch
    const dispatchResult = await this.dispatcher.dispatch(sessionId, mentions.cleanedPrompt, decision, sessionHistory);

    // 10. Track last agent for conversation continuity
    if (dispatchResult.isOk()) {
      const results = dispatchResult.value.agentResults;
      const lastAgent = results[results.length - 1];
      if (lastAgent && lastAgent.agentId !== "system") {
        this.lastAgentBySession.set(sessionId, lastAgent.agentId);
      }
    }

    return dispatchResult;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // SLASH COMMANDS
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Handle slash command. Returns response string if handled, null if not a slash command.
   */
  async handleSlashCommand(sessionId: string, prompt: string): Promise<string | null> {
    const trimmed = prompt.trim();
    if (!trimmed.startsWith("/")) return null;

    const spaceIdx = trimmed.indexOf(" ");
    const command = (spaceIdx >= 0 ? trimmed.slice(1, spaceIdx) : trimmed.slice(1)).toLowerCase();
    const args = spaceIdx >= 0 ? trimmed.slice(spaceIdx + 1).trim() : "";

    const handler = this.slashCommands.get(command);
    if (!handler) return null; // Unknown slash command → pass through

    const result = await handler(sessionId, args);
    if (result.isOk()) return result.value;
    return `Error: ${result.error.type}`;
  }

  // ─── Slash Command Handlers ────────────────────────────────────────────────

  private async handleHelp(_sessionId: string): Promise<Result<string, RouterError>> {
    const lines = [
      "Available commands:",
      "  /help            Show this help message",
      "  /agents          List available agents",
      "  /model [name]    Show or switch current model",
      "  /agent <id>      Set default agent for this session",
      "  /cost            Show session token usage",
      "  /status          Show active agents, model, token usage",
      "  /clear           Clear chat display",
      "  /compact         Force context compression",
      "  /export [path]   Export conversation to markdown",
      "  /config          Show current config",
      "  /undo            Revert last file modification",
      "",
      "Agent mentions:",
      "  @coder           Route to Coder agent",
      "  @reviewer        Route to Code Reviewer",
      "  @planner         Route to Planner",
      "  @tester          Route to Tester",
      "  @debugger        Route to Debugger",
      "  @researcher      Route to Researcher",
      "",
      "Example: @coder write a login form",
    ];
    return ok(lines.join("\n"));
  }

  private async handleAgentsList(_sessionId: string): Promise<Result<string, RouterError>> {
    const agents = this.registry.getAll();
    const termWidth = process.stdout.columns ?? 80;
    const nameCol = 15;
    const tierCol = 10;
    const descCol = Math.max(20, termWidth - nameCol - tierCol - 6); // 6 = padding/margins
    const lines = ["Available agents:", ""];
    for (const a of agents) {
      const tier = `[${a.modelTier}]`.padEnd(tierCol);
      const desc = a.description.length > descCol
        ? a.description.slice(0, descCol - 1) + "…"
        : a.description;
      lines.push(`  ${a.id.padEnd(nameCol)} ${tier} ${desc}`);
    }
    return ok(lines.join("\n"));
  }

  private async handleCost(_sessionId: string): Promise<Result<string, RouterError>> {
    const session = this.sessionManager.getActive();
    if (!session) return ok("No active session.");
    const { input, output } = session.tokens;
    const breakdown = session.getState().providerBreakdown;
    const total = input + output;
    const fmt = (n: number) => n < 1000 ? String(n) : n < 10_000 ? `${(n / 1000).toFixed(1)}k` : n < 1_000_000 ? `${Math.round(n / 1000)}k` : `${(n / 1_000_000).toFixed(1)}M`;
    const lines = [
      `Session tokens: ${fmt(total)}`,
      `  Input:  ${input.toLocaleString()}`,
      `  Output: ${output.toLocaleString()}`,
    ];
    for (const [provider, data] of Object.entries(breakdown)) {
      lines.push(`  ${provider}: ${fmt(data.tokens)}`);
    }
    return ok(lines.join("\n"));
  }

  private async handleStatus(_sessionId: string): Promise<Result<string, RouterError>> {
    const session = this.sessionManager.getActive();
    if (!session) return ok("No active session.");
    const state = session.getState();
    const lines = [
      `Session: ${state.id}`,
      `Title: ${state.title}`,
      `Status: ${state.status}`,
      `Messages: ${state.messageCount}`,
      `Active agents: ${state.activeAgents.join(", ") || "none"}`,
      `Tokens: ${state.totalInputTokens.toLocaleString()} in / ${state.totalOutputTokens.toLocaleString()} out`,
    ];
    return ok(lines.join("\n"));
  }

  private async handleClear(_sessionId: string): Promise<Result<string, RouterError>> {
    // The TUI layer will handle actual screen clearing
    this.emit(RouterEvent.CommandClear);
    return ok("Display cleared.");
  }

  private async handleCompact(_sessionId: string, args: string): Promise<Result<string, RouterError>> {
    const session = this.sessionManager.getActive();
    if (!session) return ok("No active session.");

    const messages = session.buildContextMessages();
    const tracker = this.contextTracker ?? new ContextTracker(128_000);
    const before = tracker.snapshot(messages);

    const levelUp: Record<ContextLevel, ContextLevel> = {
      normal: "high", warning: "high", high: "critical",
      critical: "emergency", emergency: "emergency",
    };
    const targetLevel = (args.includes("--force") || args.includes("--full"))
      ? "emergency" as ContextLevel
      : levelUp[before.level];

    const result = await compact(messages as CompactableMessage[], targetLevel);

    if (!result) {
      return ok(`Context: ${before.estimatedTokens.toLocaleString()} tokens (${before.utilizationPercent}% — ${before.level}). No compaction needed.`);
    }

    this.emit(RouterEvent.CommandCompact);
    return ok([
      `Compacted: ${result.strategy}`,
      `  Before: ${result.beforeTokens.toLocaleString()} tokens`,
      `  After:  ${result.afterTokens.toLocaleString()} tokens`,
      `  Saved:  ${(result.beforeTokens - result.afterTokens).toLocaleString()} tokens`,
      `  Messages affected: ${result.messagesAffected}`,
    ].join("\n"));
  }

  private async handleModel(_sessionId: string, args: string): Promise<Result<string, RouterError>> {
    if (!args) {
      return ok("Current model: (use provider default)\nUsage: /model <model-name>");
    }
    // Model switching would integrate with resolveModelForAgent
    this.emit(RouterEvent.CommandModel, args);
    return ok(`Model switched to: ${args}`);
  }

  private async handleSetAgent(sessionId: string, args: string): Promise<Result<string, RouterError>> {
    if (!args) return ok("Usage: /agent <agent-id>");
    if (!this.registry.has(args)) {
      return ok(`Unknown agent: ${args}. Use /agents to see available agents.`);
    }
    this.lastAgentBySession.set(sessionId, args);
    return ok(`Default agent set to: ${args}`);
  }

  private async handleExport(_sessionId: string, args: string): Promise<Result<string, RouterError>> {
    const exportPath = args || "session-export.md";
    this.emit(RouterEvent.CommandExport, exportPath);
    return ok(`Session export requested: ${exportPath}`);
  }

  private async handleConfig(_sessionId: string): Promise<Result<string, RouterError>> {
    const lines = [
      "Router config:",
      `  Default agent: ${this.config.defaultAgent}`,
      `  Max parallel agents: ${this.config.maxParallelAgents}`,
      `  Confirmation threshold: $${this.config.confirmationThresholdUSD}`,
      `  Auto follow-up: ${this.config.autoFollowUp}`,
      `  Show routing: ${this.config.showRoutingDecision}`,
    ];
    return ok(lines.join("\n"));
  }

  private async handleUndo(_sessionId: string): Promise<Result<string, RouterError>> {
    try {
      const { UndoManager } = await import("../conversation/undo-manager.js");
      const { join } = await import("node:path");
      const { tmpdir } = await import("node:os");
      const undoMgr = new UndoManager(join(tmpdir(), "openpawl-undo"));
      const result = await undoMgr.undo();
      if (result.isOk()) {
        return ok(`Undo: restored ${result.value.filePath}`);
      }
      return ok(`Undo: ${result.error.cause}`);
    } catch {
      return ok("Nothing to undo.");
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // CONFIRMATION
  // ═══════════════════════════════════════════════════════════════════════════

  private async handleConfirmationResponse(
    sessionId: string,
    prompt: string,
    decision: RouteDecision,
  ): Promise<Result<DispatchResult, RouterError>> {
    this.pendingConfirmation.delete(sessionId);

    const lower = prompt.trim().toLowerCase();
    if (lower === "y" || lower === "yes" || lower === "ok" || lower === "") {
      return this.dispatcher.dispatch(sessionId, prompt, decision);
    }

    return err({ type: "confirmation_rejected", message: "Operation cancelled by user." });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // ACCESS & LIFECYCLE
  // ═══════════════════════════════════════════════════════════════════════════

  getRegistry(): AgentRegistry {
    return this.registry;
  }

  async initialize(): Promise<void> {
    await this.registry.loadUserAgents(this.config.customAgentsDir);
  }

  async shutdown(): Promise<void> {
    this.lastAgentBySession.clear();
    this.pendingConfirmation.clear();
  }
}
