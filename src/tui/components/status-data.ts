/**
 * Reactive data model for status bar state.
 * Aggregates info from multiple event sources.
 */

import { EventEmitter } from "node:events";

export interface StatusBarState {
  sessionId: string | null;
  sessionTitle: string;
  sessionStatus: "active" | "idle" | "streaming" | "recovering";
  model: string;
  provider: string;
  modelDisplay: string;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCostUSD: number;
  costDisplay: string;
  activeAgents: AgentStatus[];
  lastAgentId: string | null;
  isStreaming: boolean;
  streamingAgentId: string | null;
  streamingDuration: number;
  messageCount: number;
  showHints: boolean;
  contextualHints: KeybindingHint[];
  contextUtilization: number;
  contextLevel: "normal" | "warning" | "high" | "critical" | "emergency";
}

export interface AgentStatus {
  agentId: string;
  agentName: string;
  status: "running" | "waiting_tool" | "done" | "error";
  startedAt: number;
}

export interface KeybindingHint {
  key: string;
  action: string;
  available: boolean;
}

const DEFAULT_STATE: StatusBarState = {
  sessionId: null,
  sessionTitle: "",
  sessionStatus: "active",
  model: "",
  provider: "",
  modelDisplay: "",
  totalInputTokens: 0,
  totalOutputTokens: 0,
  totalCostUSD: 0,
  costDisplay: "",
  activeAgents: [],
  lastAgentId: null,
  isStreaming: false,
  streamingAgentId: null,
  streamingDuration: 0,
  messageCount: 0,
  showHints: true,
  contextualHints: [],
  contextUtilization: 0,
  contextLevel: "normal",
};

export class StatusDataStore extends EventEmitter {
  private state: StatusBarState;
  private streamingTimer: ReturnType<typeof setInterval> | null = null;
  private changeCallbacks: Array<() => void> = [];

  constructor(initial?: Partial<StatusBarState>) {
    super();
    this.state = { ...DEFAULT_STATE, ...initial };
    this.updateHints();
  }

  getState(): Readonly<StatusBarState> {
    return this.state;
  }

  onChange(callback: () => void): () => void {
    this.changeCallbacks.push(callback);
    return () => {
      this.changeCallbacks = this.changeCallbacks.filter((c) => c !== callback);
    };
  }

  // ── Event handlers ──────────────────────────────────────────────────

  handleSessionCreated(sessionId: string, title: string, model: string, provider: string): void {
    this.state.sessionId = sessionId;
    this.state.sessionTitle = title;
    this.state.model = model;
    this.state.provider = provider;
    this.state.modelDisplay = formatModelDisplay(model, provider);
    this.state.sessionStatus = "active";
    this.notifyChange();
  }

  handleSessionResumed(sessionId: string, title: string, model: string, provider: string): void {
    this.handleSessionCreated(sessionId, title, model, provider);
  }

  handleSessionIdle(): void {
    this.state.sessionStatus = "idle";
    this.notifyChange();
  }

  handleCostUpdate(input: number, output: number, _costUSD: number): void {
    this.state.totalInputTokens = input;
    this.state.totalOutputTokens = output;
    this.state.totalCostUSD = 0;
    const total = input + output;
    this.state.costDisplay = total > 0 ? `tokens: ${formatTokens(total)}` : "";
    this.notifyChange();
  }

  handleAgentStart(agentId: string, agentName: string): void {
    this.state.activeAgents.push({ agentId, agentName, status: "running", startedAt: Date.now() });
    this.state.lastAgentId = agentId;
    this.updateHints();
    this.notifyChange();
  }

  handleAgentDone(agentId: string): void {
    this.state.activeAgents = this.state.activeAgents.filter((a) => a.agentId !== agentId);
    this.updateHints();
    this.notifyChange();
  }

  handleAgentError(agentId: string): void {
    const agent = this.state.activeAgents.find((a) => a.agentId === agentId);
    if (agent) agent.status = "error";
    this.notifyChange();
  }

  handleStreamingStart(): void {
    this.state.isStreaming = true;
    this.state.sessionStatus = "streaming";
    this.startStreamingTimer();
    this.updateHints();
    this.notifyChange();
  }

  handleStreamingDone(): void {
    this.state.isStreaming = false;
    this.state.sessionStatus = "active";
    this.state.streamingDuration = 0;
    this.state.activeAgents = [];
    this.stopStreamingTimer();
    this.updateHints();
    this.notifyChange();
  }

  handleCheckpointSaved(): void {
    // No visual change needed for v1
  }

  handleCompressionApplied(): void {
    // Could show indicator, skip for v1
  }

  handleMessageCountUpdate(count: number): void {
    this.state.messageCount = count;
    this.notifyChange();
  }

  handleModelSwitch(model: string, provider: string): void {
    this.state.model = model;
    this.state.provider = provider;
    this.state.modelDisplay = formatModelDisplay(model, provider);
    this.notifyChange();
  }

  handleContextUpdate(utilization: number, level: StatusBarState["contextLevel"]): void {
    this.state.contextUtilization = utilization;
    this.state.contextLevel = level;
    this.notifyChange();
  }

  updateHints(): void {
    if (this.state.isStreaming) {
      this.state.contextualHints = [
        { key: "Esc", action: "abort", available: true },
      ];
    } else {
      this.state.contextualHints = [
        { key: "Ctrl+N", action: "new", available: true },
        { key: "Ctrl+K", action: "clear", available: true },
        { key: "/", action: "commands", available: true },
        { key: "?", action: "help", available: true },
      ];
    }
  }

  startTimers(): void {
    // Timer started by handleStreamingStart when needed
  }

  stopTimers(): void {
    this.stopStreamingTimer();
  }

  // ── Internal ────────────────────────────────────────────────────────

  private startStreamingTimer(): void {
    this.stopStreamingTimer();
    const start = Date.now();
    this.streamingTimer = setInterval(() => {
      this.state.streamingDuration = Date.now() - start;
      this.notifyChange();
    }, 1000);
    if (this.streamingTimer.unref) this.streamingTimer.unref();
  }

  private stopStreamingTimer(): void {
    if (this.streamingTimer) {
      clearInterval(this.streamingTimer);
      this.streamingTimer = null;
    }
  }

  private notifyChange(): void {
    for (const cb of this.changeCallbacks) {
      cb();
    }
    this.emit("change");
  }
}

// ── Formatting helpers ────────────────────────────────────────────────────

function formatModelDisplay(model: string, provider: string): string {
  if (!model) return provider || "no model";
  const short = model.replace(/^claude-/, "").replace(/-\d{4,}.*$/, "");
  return provider ? `${short} via ${provider}` : short;
}

/** @deprecated Dollar cost display removed. Use formatTokens instead. */
export function formatCost(_usd: number): string {
  return "";
}

export function formatTokens(count: number): string {
  if (count < 1000) return String(count);
  if (count < 10_000) return `${(count / 1000).toFixed(1)}k`;
  if (count < 1_000_000) return `${Math.round(count / 1000)}k`;
  return `${(count / 1_000_000).toFixed(1)}M`;
}
