import { useEffect, useRef } from "react";
import { useWsStore, type OpenClawLogEntry } from "./store";
import { getApiBase } from "../utils/api";

function getEventsUrl(): string {
  const base = getApiBase();
  return `${base}/api/events`;
}

export function WebSocketProvider({ children }: { children: React.ReactNode }) {
  const esRef = useRef<EventSource | null>(null);
  const mountedRef = useRef(true);

  const setConnectionStatus = useWsStore((s) => s.setConnectionStatus);
  const setFromNodeEvent = useWsStore((s) => s.setFromNodeEvent);
  const setConfig = useWsStore((s) => s.setConfig);
  const setLastError = useWsStore((s) => s.setLastError);
  const pushAlert = useWsStore((s) => s.pushAlert);
  const setPendingApproval = useWsStore((s) => s.setPendingApproval);
  const setActiveNode = useWsStore((s) => s.setActiveNode);
  const addCompletedNode = useWsStore((s) => s.addCompletedNode);
  const addTokenUsage = useWsStore((s) => s.addTokenUsage);
  const setModel = useWsStore((s) => s.setModel);
  const pushNodeEvent = useWsStore((s) => s.pushNodeEvent);
  const setGenerationProgress = useWsStore((s) => s.setGenerationProgress);
  const setCycleProgress = useWsStore((s) => s.setCycleProgress);
  const setModelConfig = useWsStore((s) => s.setModelConfig);
  const setReasoning = useWsStore((s) => s.setReasoning);
  const pushOpenClawLog = useWsStore((s) => s.pushOpenClawLog);
  const appendStreamChunk = useWsStore((s) => s.appendStreamChunk);
  const setServerStartTs = useWsStore((s) => s.setServerStartTs);
  const setGatewayAvailable = useWsStore((s) => s.setGatewayAvailable);

  useEffect(() => {
    mountedRef.current = true;

    const url = getEventsUrl();
    setConnectionStatus("connecting");
    const es = new EventSource(url);
    esRef.current = es;

    es.onopen = () => {
      if (!mountedRef.current) return;
      setConnectionStatus("open");
      setLastError(null);
    };

    es.onmessage = (event) => {
      try {
        const payload = JSON.parse(event.data) as Record<string, unknown>;
        const type = payload.type as string | undefined;
        if (type === "state_sync" && payload.state && typeof payload.state === "object") {
          const state = payload.state as Record<string, unknown>;
          setFromNodeEvent({
            task_queue: state.taskQueue as Record<string, unknown>[] | undefined,
            bot_stats: state.botStats as Record<string, Record<string, unknown>> | undefined,
            cycle: state.cycle as number | undefined,
          });
          if (typeof state.activeNode === "string") {
            setActiveNode(state.activeNode);
          }
          if (state.generationProgress) {
            setGenerationProgress(state.generationProgress as {
              generation: number; maxGenerations: number; lessonsCount: number;
              startedAt: number; outcome: string | null; finalState: Record<string, unknown> | null;
            });
          }
          if (state.cycleProgress) {
            setCycleProgress(state.cycleProgress as {
              cycle: number; maxCycles: number; startedAt: number;
            });
          }
          if (state.pendingApproval) {
            setPendingApproval(state.pendingApproval as Record<string, unknown>);
          }
          if (typeof state.gatewayAvailable === "boolean") {
            setGatewayAvailable(state.gatewayAvailable as boolean);
          }
        } else if (type === "node_event" && payload.state && typeof payload.state === "object") {
          const state = payload.state as Record<string, unknown>;
          setFromNodeEvent({
            task_queue: state.task_queue as Record<string, unknown>[] | undefined,
            bot_stats: state.bot_stats as Record<string, Record<string, unknown>> | undefined,
            cycle: state.cycle as number | undefined,
          });
          const node = payload.node as string | undefined;
          const data = (payload.data ?? {}) as Record<string, unknown>;
          const timestamp = (payload.timestamp ?? "") as string;
          if (node) {
            pushNodeEvent({ node, data, timestamp, receivedAt: Date.now() });
          }
        } else if (type === "init" && payload.config) {
          setConfig(payload.config as Record<string, unknown>);
          if (typeof payload.server_start_ts === "number") {
            setServerStartTs(payload.server_start_ts);
          }
        } else if (type === "config_updated" && payload.config) {
          setConfig(payload.config as Record<string, unknown>);
        } else if (type === "error" && typeof payload.message === "string") {
          setLastError(payload.message);
        } else if (type === "task_queue_updated" && payload.task_queue) {
          setFromNodeEvent({
            task_queue: payload.task_queue as Record<string, unknown>[],
          });
        } else if (type === "timeout_alert") {
          const taskId = payload.task_id as string | undefined;
          if (payload.task_queue) {
            setFromNodeEvent({
              task_queue: payload.task_queue as Record<string, unknown>[],
            });
          }
          if (taskId) {
            setLastError(`Task ${taskId} exceeded its timebox.`);
            const prefs = useWsStore.getState().notificationPrefs;
            if (prefs.enabled && prefs.types.timeout) {
              pushAlert({
                id: `timeout-${Date.now()}`,
                type: "timeout",
                message: `Task ${taskId} exceeded its timebox.`,
                details: payload as Record<string, unknown>,
                created_at: new Date().toISOString(),
                read: false,
              });
            }
          }
        } else if (type === "approval_request" && payload.pending) {
          const pending = payload.pending as Record<string, unknown>;
          setPendingApproval(pending);
          const prefs = useWsStore.getState().notificationPrefs;
          if (prefs.enabled && prefs.types.approval_request) {
            pushAlert({
              id: `approval-${Date.now()}`,
              type: "approval_request",
              message: "Approval required for a task.",
              details: pending,
              created_at: new Date().toISOString(),
              read: false,
            });
          }
        } else if (type === "partial_approval_request" && payload.tasks) {
          const { setPendingTaskApprovals } = useWsStore.getState();
          setPendingTaskApprovals(payload.tasks as Record<string, unknown>[]);
          const prefs = useWsStore.getState().notificationPrefs;
          if (prefs.enabled && prefs.types.approval_request) {
            const taskCount = (payload.tasks as unknown[]).length;
            pushAlert({
              id: `partial-approval-${Date.now()}`,
              type: "approval_request",
              message: `${taskCount} task(s) ready for review.`,
              details: payload as Record<string, unknown>,
              created_at: new Date().toISOString(),
              read: false,
            });
          }
        } else if (type === "partial_approval_resolved" && payload.task_id) {
          const { resolveTaskApproval } = useWsStore.getState();
          resolveTaskApproval(payload.task_id as string);
        } else if (type === "preview_request" && payload.preview) {
          const { setPendingPreview } = useWsStore.getState();
          setPendingPreview(payload.preview as Record<string, unknown>);
        } else if (type === "preview_resolved") {
          const { clearPendingPreview } = useWsStore.getState();
          clearPendingPreview();
        } else if (type === "WAITING_FOR_HUMAN" && payload.task_id) {
          const taskId = payload.task_id as string;
          const message = (payload.message as string) || "Task requires human approval";
          setPendingApproval({
            task_id: taskId,
            description: message,
            waiting: true,
          });
          const prefs = useWsStore.getState().notificationPrefs;
          if (prefs.enabled && prefs.types.approval_request) {
            pushAlert({
              id: `waiting-${Date.now()}`,
              type: "approval_request",
              message: message,
              details: { task_id: taskId },
              created_at: new Date().toISOString(),
              read: false,
            });
          }
        } else if (type === "hallucination_warning") {
          const prefs = useWsStore.getState().notificationPrefs;
          if (prefs.enabled && prefs.types.hallucination_warning) {
            pushAlert({
              id: `hallucination-${Date.now()}`,
              type: "hallucination_warning",
              message:
                (payload.message as string) ||
                "Potential hallucination detected in model output.",
              details: payload as Record<string, unknown>,
              created_at: new Date().toISOString(),
              read: false,
            });
          }
        } else if (type === "system_error") {
          const msg = (payload.message as string) || "A system error occurred.";
          setLastError(msg);
          const prefs = useWsStore.getState().notificationPrefs;
          if (prefs.enabled && prefs.types.system_error) {
            pushAlert({
              id: `system-${Date.now()}`,
              type: "system_error",
              message: msg,
              details: payload as Record<string, unknown>,
              created_at: new Date().toISOString(),
              read: false,
            });
          }
        } else if (type === "provision_error") {
          const msg = (payload.error as string) || "OpenClaw Gateway not available.";
          setLastError(msg);
          const prefs = useWsStore.getState().notificationPrefs;
          if (prefs.enabled && prefs.types.system_error) {
            pushAlert({
              id: `provision-${Date.now()}`,
              type: "system_error",
              message: msg,
              details: payload as Record<string, unknown>,
              created_at: new Date().toISOString(),
              read: false,
            });
          }
        } else if (type === "session_complete") {
          setGenerationProgress(null);
          setCycleProgress(null);
          setActiveNode(null);
        } else if (type === "generation_start") {
          setGenerationProgress({
            generation: (payload.generation as number) ?? 1,
            maxGenerations: (payload.max_generations as number) ?? (payload.maxGenerations as number) ?? 1,
            lessonsCount: (payload.lessons_count as number) ?? (payload.lessonsCount as number) ?? 0,
            startedAt: Date.now(),
            outcome: null,
            finalState: null,
          });
        } else if (type === "generation_end") {
          const current = useWsStore.getState().generationProgress;
          if (current) {
            setGenerationProgress({
              ...current,
              outcome: (payload.outcome as string) ?? "unknown",
              finalState: (payload.final_state as Record<string, unknown>) ?? (payload.finalState as Record<string, unknown>) ?? null,
            });
          }
        } else if (type === "cycle_start") {
          setCycleProgress({
            cycle: (payload.cycle as number) ?? 1,
            maxCycles: (payload.max_cycles as number) ?? (payload.maxCycles as number) ?? 1,
            startedAt: Date.now(),
          });
        } else if (type === "telemetry" && payload.payload) {
          const telemetryPayload = payload.payload as Record<string, unknown>;
          if (telemetryPayload.event === "NODE_ACTIVE") {
            const nodeName = telemetryPayload.node as string;
            if (nodeName === "completed") {
              addCompletedNode("completed");
              setActiveNode(null);
            } else if (nodeName) {
              if (nodeName !== "increment_cycle") {
                setActiveNode(nodeName);
              }
            }
          } else if (telemetryPayload.event === "TOKEN_USAGE") {
            const input = (telemetryPayload.input_tokens as number) || 0;
            const output = (telemetryPayload.output_tokens as number) || 0;
            const cached = (telemetryPayload.cached_input_tokens as number) || 0;
            const model = (telemetryPayload.model as string) || "gpt-4o-mini";
            if (input > 0 || output > 0 || cached > 0) {
              addTokenUsage(input, output, cached);
            }
            setModel(model);
          } else if (telemetryPayload.event === "REASONING") {
            const taskId = (telemetryPayload.task_id as string) || "";
            const botId = (telemetryPayload.bot_id as string) || "";
            const reasoning = (telemetryPayload.reasoning as string) || "";
            if (taskId && reasoning) {
              setReasoning(taskId, botId, reasoning);
            }
          } else if (telemetryPayload.event === "STREAM_CHUNK") {
            const botId = (telemetryPayload.bot_id as string) || "";
            const chunk = (telemetryPayload.chunk as string) || "";
            if (botId && chunk) {
              appendStreamChunk(botId, chunk);
            }
          }
        } else if (type === "model_updated" || type === "model_state") {
          setModelConfig({
            defaultModel: (payload.default_model as string) ?? "",
            agentModels: (payload.agent_models as Record<string, string>) ?? {},
            fallbackChain: (payload.fallback_chain as string[]) ?? [],
            availableModels: (payload.available_models as string[]) ?? [],
            aliases: (payload.aliases as Record<string, string>) ?? {},
            allowlist: (payload.allowlist as string[]) ?? [],
          });
        } else if (type === "openclaw_log" && payload.entry) {
          pushOpenClawLog(payload.entry as OpenClawLogEntry);
        } else if (type === "session_cancelled") {
          setGenerationProgress(null);
          setCycleProgress(null);
          setActiveNode(null);
        }
      } catch {
        // ignore parse errors
      }
    };

    es.onerror = () => {
      if (!mountedRef.current) return;
      // EventSource auto-reconnects; just update status
      setConnectionStatus("reconnecting");
    };

    return () => {
      mountedRef.current = false;
      if (esRef.current) {
        esRef.current.close();
        esRef.current = null;
      }
    };
  }, [
    setConnectionStatus,
    setFromNodeEvent,
    setConfig,
    setLastError,
    pushAlert,
    setPendingApproval,
    setActiveNode,
    addCompletedNode,
    addTokenUsage,
    setModel,
    pushNodeEvent,
    setGenerationProgress,
    setCycleProgress,
    setModelConfig,
    setReasoning,
    pushOpenClawLog,
    appendStreamChunk,
    setServerStartTs,
    setGatewayAvailable,
  ]);

  return <>{children}</>;
}
