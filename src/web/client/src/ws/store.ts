import { create } from "zustand";

export type ConnectionStatus = "connecting" | "open" | "closed" | "reconnecting" | "error";

type TerminalDataCallback = (data: string) => void;
const terminalSubscribers: Set<TerminalDataCallback> = new Set();

export function subscribeToTerminalOutput(callback: TerminalDataCallback): () => void {
  terminalSubscribers.add(callback);
  return () => terminalSubscribers.delete(callback);
}

export function pushTerminalOutput(data: string): void {
  terminalSubscribers.forEach((cb) => cb(data));
}

export interface NodeEventState {
  task_queue?: Record<string, unknown>[];
  bot_stats?: Record<string, Record<string, unknown>>;
  cycle?: number;
}

export type AlertType = "approval_request" | "hallucination_warning" | "system_error";

export interface AlertItem {
  id: string;
  type: AlertType;
  message: string;
  details?: Record<string, unknown>;
  created_at: string;
}

export interface TokenUsage {
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCachedInputTokens: number;
  lastUpdate: number;
  model: string;
}

interface WsStore {
  connectionStatus: ConnectionStatus;
  task_queue: Record<string, unknown>[];
  bot_stats: Record<string, Record<string, unknown>>;
  cycle_count: number;
  config: Record<string, unknown> | null;
  lastError: string | null;
  alerts: AlertItem[];
  pendingApproval: Record<string, unknown> | null;
  activeNode: string | null;
  completedNodes: string[];
  tokenUsage: TokenUsage;
  sendMessage: (payload: object) => void;
  setConnectionStatus: (status: ConnectionStatus) => void;
  setFromNodeEvent: (state: NodeEventState) => void;
  setConfig: (config: Record<string, unknown> | null) => void;
  setLastError: (message: string | null) => void;
  setSendMessage: (fn: (payload: object) => void) => void;
  pushAlert: (alert: AlertItem) => void;
  removeAlert: (id: string) => void;
  clearAlerts: () => void;
  setPendingApproval: (pending: Record<string, unknown> | null) => void;
  setActiveNode: (node: string | null) => void;
  addCompletedNode: (node: string) => void;
  resetNodeState: () => void;
  addTokenUsage: (input: number, output: number, cached: number) => void;
  setModel: (model: string) => void;
}

function noopSendMessage(_payload: object): void {}

export const useWsStore = create<WsStore>((set) => ({
  connectionStatus: "connecting",
  task_queue: [],
  bot_stats: {},
  cycle_count: 0,
  config: null,
  lastError: null,
  alerts: [],
  pendingApproval: null,
  activeNode: null,
  completedNodes: [],
  tokenUsage: { totalInputTokens: 0, totalOutputTokens: 0, totalCachedInputTokens: 0, lastUpdate: 0, model: "gpt-4o-mini" },
  sendMessage: noopSendMessage,
  setConnectionStatus: (status) => set({ connectionStatus: status }),
  setFromNodeEvent: (state) =>
    set((prev) => ({
      task_queue: state.task_queue ?? prev.task_queue,
      bot_stats: state.bot_stats ?? prev.bot_stats,
      cycle_count: state.cycle ?? prev.cycle_count,
    })),
  setConfig: (config) => set({ config }),
  setLastError: (message) => set({ lastError: message }),
  setSendMessage: (fn) => set({ sendMessage: fn }),
  pushAlert: (alert) =>
    set((prev) => {
      const next = [...prev.alerts, alert];
      // Keep only the most recent 50 alerts to avoid unbounded growth.
      return { alerts: next.slice(-50) };
    }),
  removeAlert: (id) =>
    set((prev) => ({
      alerts: prev.alerts.filter((a) => a.id !== id),
    })),
  clearAlerts: () => set({ alerts: [] }),
  setPendingApproval: (pending) => set({ pendingApproval: pending }),
  setActiveNode: (node) => set({ activeNode: node }),
  addCompletedNode: (node) =>
    set((prev) => ({
      completedNodes: prev.completedNodes.includes(node)
        ? prev.completedNodes
        : [...prev.completedNodes, node],
    })),
  resetNodeState: () => set({ activeNode: null, completedNodes: [] }),
  addTokenUsage: (input, output, cached) =>
    set((prev) => ({
      tokenUsage: {
        totalInputTokens: prev.tokenUsage.totalInputTokens + input,
        totalOutputTokens: prev.tokenUsage.totalOutputTokens + output,
        totalCachedInputTokens: prev.tokenUsage.totalCachedInputTokens + cached,
        lastUpdate: Date.now(),
        model: prev.tokenUsage.model,
      },
    })),
  setModel: (model) =>
    set((prev) => ({
      tokenUsage: {
        ...prev.tokenUsage,
        model,
      },
    })),
}));
