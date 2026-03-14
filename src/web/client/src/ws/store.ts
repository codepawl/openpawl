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

export type AlertType = "approval_request" | "hallucination_warning" | "system_error" | "timeout";

export interface AlertItem {
  id: string;
  type: AlertType;
  message: string;
  details?: Record<string, unknown>;
  created_at: string;
  read: boolean;
}

export interface NotificationPreferences {
  enabled: boolean;
  types: Record<AlertType, boolean>;
}

const DEFAULT_NOTIF_PREFS: NotificationPreferences = {
  enabled: true,
  types: { approval_request: true, hallucination_warning: true, system_error: true, timeout: true },
};

function loadNotifPrefs(): NotificationPreferences {
  try {
    const raw = localStorage.getItem("teamclaw_notif_prefs");
    if (raw) return JSON.parse(raw) as NotificationPreferences;
  } catch {}
  return { ...DEFAULT_NOTIF_PREFS, types: { ...DEFAULT_NOTIF_PREFS.types } };
}

function saveNotifPrefs(prefs: NotificationPreferences): void {
  try { localStorage.setItem("teamclaw_notif_prefs", JSON.stringify(prefs)); } catch {}
}

export interface ModelConfigState {
  defaultModel: string;
  agentModels: Record<string, string>;
  fallbackChain: string[];
  availableModels: string[];
  aliases: Record<string, string>;
  allowlist: string[];
}

export interface TokenUsage {
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCachedInputTokens: number;
  lastUpdate: number;
  model: string;
}

export interface NodeEventEntry {
  node: string;
  data: Record<string, unknown>;
  timestamp: string;
  receivedAt: number;
}

export interface GenerationProgress {
  generation: number;
  maxGenerations: number;
  lessonsCount: number;
  startedAt: number;
  outcome: string | null;
  finalState: Record<string, unknown> | null;
}

export interface CycleProgress {
  cycle: number;
  maxCycles: number;
  startedAt: number;
}

export interface ReasoningEntry {
  botId: string;
  text: string;
  timestamp: number;
}

export interface OpenClawLogEntry {
  id: string;
  level: "info" | "success" | "warn" | "error";
  source: string;
  action: string;
  model: string;
  botId: string;
  message: string;
  meta?: Record<string, unknown>;
  timestamp: number;
}

export type OpenClawLogFilter = "all" | "info" | "success" | "warn" | "error";

export interface StreamingTextEntry {
  botId: string;
  text: string;
  timestamp: number;
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
  nodeEventHistory: NodeEventEntry[];
  generationProgress: GenerationProgress | null;
  cycleProgress: CycleProgress | null;
  tokenUsage: TokenUsage;
  modelConfig: ModelConfigState | null;
  notificationPrefs: NotificationPreferences;
  reasoning: Record<string, ReasoningEntry>;
  streamingText: Record<string, StreamingTextEntry>;
  openclawLogs: OpenClawLogEntry[];
  openclawLogFilter: OpenClawLogFilter;
  serverStartTs: number | null;
  serverRestarted: boolean;
  sendMessage: (payload: object) => void;
  setConnectionStatus: (status: ConnectionStatus) => void;
  setFromNodeEvent: (state: NodeEventState) => void;
  setConfig: (config: Record<string, unknown> | null) => void;
  setLastError: (message: string | null) => void;
  setSendMessage: (fn: (payload: object) => void) => void;
  pushAlert: (alert: AlertItem) => void;
  removeAlert: (id: string) => void;
  clearAlerts: () => void;
  markRead: (id: string) => void;
  markAllRead: () => void;
  setNotificationPrefs: (prefs: Partial<NotificationPreferences>) => void;
  toggleNotificationType: (type: AlertType) => void;
  setPendingApproval: (pending: Record<string, unknown> | null) => void;
  setActiveNode: (node: string | null) => void;
  addCompletedNode: (node: string) => void;
  pushNodeEvent: (entry: NodeEventEntry) => void;
  setGenerationProgress: (progress: GenerationProgress | null) => void;
  setCycleProgress: (progress: CycleProgress | null) => void;
  resetNodeState: () => void;
  addTokenUsage: (input: number, output: number, cached: number) => void;
  setModel: (model: string) => void;
  setModelConfig: (config: ModelConfigState | null) => void;
  setReasoning: (taskId: string, botId: string, text: string) => void;
  appendStreamChunk: (botId: string, chunk: string) => void;
  clearStreamingText: (botId: string) => void;
  pushOpenClawLog: (entry: OpenClawLogEntry) => void;
  setOpenClawLogFilter: (filter: OpenClawLogFilter) => void;
  clearOpenClawLogs: () => void;
  setServerStartTs: (ts: number) => void;
  dismissServerRestart: () => void;
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
  notificationPrefs: loadNotifPrefs(),
  pendingApproval: null,
  activeNode: null,
  completedNodes: [],
  nodeEventHistory: [],
  generationProgress: null,
  cycleProgress: null,
  modelConfig: null,
  reasoning: {},
  streamingText: {},
  openclawLogs: [],
  openclawLogFilter: "all",
  serverStartTs: null,
  serverRestarted: false,
  tokenUsage: { totalInputTokens: 0, totalOutputTokens: 0, totalCachedInputTokens: 0, lastUpdate: 0, model: "gpt-4o-mini" },
  sendMessage: noopSendMessage,
  setConnectionStatus: (status) => set({ connectionStatus: status }),
  setFromNodeEvent: (state) =>
    set((prev) => {
      let nextQueue = state.task_queue ?? prev.task_queue;
      // Stable sort by task_id so cards don't jump around when the queue is replaced
      if (state.task_queue) {
        nextQueue = [...state.task_queue].sort((a, b) => {
          const idA = (a.task_id as string) ?? "";
          const idB = (b.task_id as string) ?? "";
          return idA.localeCompare(idB);
        });
      }
      return {
        task_queue: nextQueue,
        bot_stats: state.bot_stats ?? prev.bot_stats,
        cycle_count: state.cycle ?? prev.cycle_count,
      };
    }),
  setConfig: (config) => set({ config }),
  setLastError: (message) => set({ lastError: message }),
  setSendMessage: (fn) => set({ sendMessage: fn }),
  pushAlert: (alert) =>
    set((prev) => {
      // Dedup: skip if last alert matches type+message within 5s
      const last = prev.alerts[prev.alerts.length - 1];
      if (last && last.type === alert.type && last.message === alert.message) {
        const elapsed = Date.now() - new Date(last.created_at).getTime();
        if (elapsed < 5000) return prev;
      }
      const next = [...prev.alerts, { ...alert, read: false }];
      // Cap at 30 — evict oldest read first, then oldest unread
      if (next.length > 30) {
        const readIdx = next.findIndex((a) => a.read);
        if (readIdx !== -1) next.splice(readIdx, 1);
        else next.shift();
      }
      return { alerts: next };
    }),
  removeAlert: (id) =>
    set((prev) => ({
      alerts: prev.alerts.filter((a) => a.id !== id),
    })),
  clearAlerts: () => set({ alerts: [] }),
  markRead: (id) =>
    set((prev) => ({
      alerts: prev.alerts.map((a) => (a.id === id ? { ...a, read: true } : a)),
    })),
  markAllRead: () =>
    set((prev) => ({
      alerts: prev.alerts.map((a) => (a.read ? a : { ...a, read: true })),
    })),
  setNotificationPrefs: (prefs) =>
    set((prev) => {
      const next = { ...prev.notificationPrefs, ...prefs };
      saveNotifPrefs(next);
      return { notificationPrefs: next };
    }),
  toggleNotificationType: (type) =>
    set((prev) => {
      const next = {
        ...prev.notificationPrefs,
        types: { ...prev.notificationPrefs.types, [type]: !prev.notificationPrefs.types[type] },
      };
      saveNotifPrefs(next);
      return { notificationPrefs: next };
    }),
  setPendingApproval: (pending) => set({ pendingApproval: pending }),
  setActiveNode: (node) => set({ activeNode: node }),
  addCompletedNode: (node) =>
    set((prev) => ({
      completedNodes: prev.completedNodes.includes(node)
        ? prev.completedNodes
        : [...prev.completedNodes, node],
    })),
  pushNodeEvent: (entry) =>
    set((prev) => ({
      nodeEventHistory: [...prev.nodeEventHistory, entry].slice(-100),
    })),
  setGenerationProgress: (progress) => set({ generationProgress: progress }),
  setCycleProgress: (progress) => set({ cycleProgress: progress }),
  resetNodeState: () => set({ activeNode: null, completedNodes: [], nodeEventHistory: [], generationProgress: null, cycleProgress: null }),
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
  setModelConfig: (config) => set({ modelConfig: config }),
  setReasoning: (taskId, botId, text) =>
    set((prev) => ({
      reasoning: {
        ...prev.reasoning,
        [taskId]: { botId, text, timestamp: Date.now() },
      },
    })),
  appendStreamChunk: (botId, chunk) =>
    set((prev) => {
      const existing = prev.streamingText[botId];
      const text = (existing?.text ?? "") + chunk;
      return {
        streamingText: {
          ...prev.streamingText,
          [botId]: { botId, text, timestamp: Date.now() },
        },
      };
    }),
  clearStreamingText: (botId) =>
    set((prev) => {
      const next = { ...prev.streamingText };
      delete next[botId];
      return { streamingText: next };
    }),
  pushOpenClawLog: (entry) =>
    set((prev) => ({
      openclawLogs: [...prev.openclawLogs, entry].slice(-200),
    })),
  setOpenClawLogFilter: (filter) => set({ openclawLogFilter: filter }),
  clearOpenClawLogs: () => set({ openclawLogs: [] }),
  setServerStartTs: (ts) =>
    set((prev) => {
      if (prev.serverStartTs === null) {
        return { serverStartTs: ts };
      }
      if (prev.serverStartTs !== ts) {
        return { serverStartTs: ts, serverRestarted: true };
      }
      return prev;
    }),
  dismissServerRestart: () => set({ serverRestarted: false }),
}));
