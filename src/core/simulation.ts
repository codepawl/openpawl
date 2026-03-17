/**
 * Team Orchestration - LangGraph workflow for OpenClaw bot teams.
 */

import { randomUUID } from "node:crypto";
import { StateGraph, START, END } from "@langchain/langgraph";
import { MemorySaver } from "@langchain/langgraph-checkpoint";
import type { GraphState } from "./graph-state.js";
import { GameStateAnnotation } from "./graph-state.js";
import { CONFIG } from "./config.js";
import {
  initializeGameState,
  initializeTeamState,
} from "./state.js";
import { buildTeamFromTemplate } from "./team-templates.js";
import type { BotDefinition } from "./bot-definitions.js";
import { CoordinatorAgent } from "../agents/coordinator.js";
import { createWorkerBots, createTaskDispatcher, createWorkerTaskNode, createWorkerCollectNode } from "../agents/worker-bot.js";
import { getFirstTaskNeedingApproval, createApprovalNode } from "../agents/approval.js";
import type { ApprovalProvider } from "../agents/approval.js";
import { createPartialApprovalNode } from "../agents/partial-approval.js";
import type { PerTaskApprovalProvider } from "../agents/partial-approval.js";
import { UniversalOpenClawAdapter } from "../adapters/worker-adapter.js";
import { resolveModelForAgent } from "./model-config.js";
import { logger, isDebugMode } from "./logger.js";
import { createSprintPlanningNode } from "../agents/planning.js";
import { createRFCNode } from "../agents/rfc.js";
import { createSystemDesignNode } from "../agents/system-design.js";
import { createMemoryRetrievalNode } from "../agents/memory-retrieval.js";
import type { VectorMemory } from "./knowledge-base.js";
import { SuccessPatternStore } from "../memory/success/store.js";
import { GlobalMemoryManager } from "../memory/global/store.js";
import { ProfileStore } from "../agents/profiles/store.js";
import type { AgentProfile } from "../agents/profiles/types.js";
import type { TeamComposition } from "../agents/composition/types.js";
import { withCompositionGate } from "../agents/composition/wiring.js";
import { getCanvasTelemetry } from "./canvas-telemetry.js";
import { getActiveRecorder, wrapWithRecording, wrapSyncWithRecording } from "../replay/recorder.js";
import { AgentRegistryStore, createCustomWorkerBots } from "../agents/registry/index.js";
import { createPreviewNode } from "../graph/nodes/preview.js";
import { createConfidenceRouterNode } from "../graph/nodes/confidence-router.js";
import type { PreviewProvider } from "../graph/preview/types.js";
import type { CostConfig } from "../graph/preview/estimator.js";

function log(msg: string): void {
  if (isDebugMode()) {
    logger.agent(msg);
  }
}

function generateMidSprintSummary(state: GraphState): string {
  const taskQueue = state.task_queue ?? [];
  const totalTasks = (state.total_tasks as number) ?? taskQueue.length;
  
  const completedTasks = taskQueue.filter((t) =>
    t.status === "completed" || t.status === "waiting_for_human" || t.status === "auto_approved_pending"
  );
  const remainingTasks = taskQueue.filter((t) =>
    t.status === "pending" || t.status === "reviewing" || t.status === "needs_rework" || t.status === "rfc_pending"
  );
  
  const completedList = completedTasks.map((t) => `- ${t.task_id}: ${(t.description as string)?.slice(0, 50) ?? "..."}`).join("\n");
  const remainingCount = remainingTasks.length;
  
  const botStats = state.bot_stats ?? {};
  let reworksTriggered = 0;
  for (const stats of Object.values(botStats)) {
    reworksTriggered += (stats.reworks_triggered as number) ?? 0;
  }
  
  const qualityScore = (state.last_quality_score as number) ?? 0;
  let vibe: string;
  if (qualityScore >= 80 && reworksTriggered === 0) {
    vibe = "🚀 On track — high quality, no blockers";
  } else if (qualityScore >= 60 || reworksTriggered <= 2) {
    vibe = "⚠️ Progressing — minor issues, manageable";
  } else {
    vibe = "🛑 At risk — consider re-evaluating scope";
  }
  
  return `📊 MID-SPRINT SUMMARY (50% milestone)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
✅ Tasks Completed (${completedTasks.length}/${totalTasks}):
${completedList || "- (none yet)"}

📋 Tasks Remaining: ${remainingCount}

💡 Project Vibe: ${vibe}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`;
}

export class TeamOrchestration {
  readonly team: BotDefinition[];
  readonly workerBots: Record<string, import("../agents/worker-bot.js").WorkerBot>;
  readonly coordinator: CoordinatorAgent;
  readonly graph: import("@langchain/langgraph").CompiledStateGraph<
    GraphState,
    Partial<GraphState>,
    string
  >;
  readonly profileStore: ProfileStore;
  private sessionStartTime: number = 0;
  private sessionTimeoutMs: number = 0;
  private sessionMaxRuns: number = 0;

  /** Configure session limits without starting a run/stream. */
  configureSession(opts: { maxRuns?: number; timeoutMinutes?: number }): void {
    this.sessionStartTime = Date.now();
    this.sessionTimeoutMs = (opts.timeoutMinutes ?? 0) * 60 * 1000;
    this.sessionMaxRuns = opts.maxRuns ?? 0;
  }

  private teamComposition: TeamComposition | undefined;

  constructor(options: {
    team?: BotDefinition[];
    teamTemplateId?: string;
    workerUrls?: Record<string, string>;
    approvalProvider?: ApprovalProvider | null;
    partialApprovalProvider?: PerTaskApprovalProvider | null;
    previewProvider?: PreviewProvider | null;
    workspacePath?: string;
    autoApprove?: boolean;
    vectorMemory?: VectorMemory;
    signal?: AbortSignal;
    costConfig?: Partial<CostConfig>;
    teamComposition?: TeamComposition;
  } = {}) {
    const { team, teamTemplateId = "game_dev", workerUrls = {}, approvalProvider = null, partialApprovalProvider = null, previewProvider = null, workspacePath, autoApprove = false, vectorMemory, signal, costConfig, teamComposition } = options;
    this.teamComposition = teamComposition;
    this.team = team ?? buildTeamFromTemplate(teamTemplateId);
    this.workerBots = createWorkerBots(this.team, workerUrls, workspacePath);
    const sharedLlmAdapter =
      Object.values(this.workerBots)[0]?.adapter ??
      new UniversalOpenClawAdapter({
        workerUrl: CONFIG.openclawWorkerUrl,
        authToken: CONFIG.openclawToken,
        model: resolveModelForAgent("coordinator"),
        botId: "coordinator",
      });
    this.coordinator = new CoordinatorAgent({ llmAdapter: sharedLlmAdapter, workspacePath });

    // Wire success pattern store into memory retrieval if LanceDB is available
    let successStore: SuccessPatternStore | null = null;
    const vmDb = vectorMemory?.getDb?.();
    const vmEmbedder = vectorMemory?.getEmbedder?.();
    if (vmDb && vmEmbedder) {
      successStore = new SuccessPatternStore(vmDb, vmEmbedder);
      void successStore.init().catch(() => { successStore = null; });
    }

    // Initialize global memory manager for cross-session knowledge
    let globalManager: GlobalMemoryManager | null = null;
    if (vmEmbedder) {
      try {
        globalManager = new GlobalMemoryManager();
        void globalManager.init(vmEmbedder).catch(() => { globalManager = null; });
      } catch {
        globalManager = null;
      }
    }

    // Initialize profile store for agent performance tracking
    this.profileStore = new ProfileStore();
    const loadedProfiles: AgentProfile[] = [];
    const globalDb = globalManager?.getDb() ?? null;
    if (globalDb) {
      void this.profileStore.init(globalDb).then(async () => {
        try {
          const profiles = await this.profileStore.getAll();
          loadedProfiles.push(...profiles);
          if (loadedProfiles.length > 0) {
            log(`Loaded ${loadedProfiles.length} agent profile(s)`);
          }
        } catch {
          // non-critical
        }
      }).catch(() => { /* non-critical */ });
    }

    // Load custom agents from registry and merge into worker bots + team
    try {
      const registryStore = new AgentRegistryStore();
      const customAgentDefs = registryStore.loadAllSync();
      if (customAgentDefs.length > 0) {
        const { bots, botDefs } = createCustomWorkerBots(customAgentDefs, workspacePath ?? "");
        Object.assign(this.workerBots, bots);
        this.team.push(...botDefs);
        log(`Loaded ${customAgentDefs.length} custom agent(s): ${botDefs.map((b) => b.role_id).join(", ")}`);
      }
    } catch {
      // Non-critical — custom agents failing to load shouldn't break the session
    }

    const taskDispatcher = createTaskDispatcher(this.workerBots, this.team, loadedProfiles);
    const workerTaskNode = createWorkerTaskNode(this.workerBots, this.team);
    const collectNode = createWorkerCollectNode();
    const approvalNode = createApprovalNode(approvalProvider);
    const partialApprovalNode = createPartialApprovalNode({
      autoApprove,
      approvalProvider: partialApprovalProvider,
    });
    const sprintPlanningNode = createSprintPlanningNode(workspacePath ?? "", sharedLlmAdapter, signal, loadedProfiles);
    const systemDesignNode = createSystemDesignNode(workspacePath ?? "", sharedLlmAdapter, signal);
    const rfcNode = createRFCNode(workspacePath ?? "", this.team, sharedLlmAdapter, signal);

    const memoryRetrievalNode = vectorMemory
      ? createMemoryRetrievalNode(vectorMemory, 5, 2, successStore, vmEmbedder, globalManager)
      : createMemoryRetrievalNode({} as VectorMemory);

    const wrapWithTelemetry = (
      nodeName: string,
      fn: (s: GraphState) => Promise<Partial<GraphState>>
    ): ((s: GraphState) => Promise<Partial<GraphState>>) => {
      let wrapped = fn;
      // Wrap with recording if a recorder is active
      const recorder = getActiveRecorder();
      if (recorder) {
        wrapped = wrapWithRecording(recorder, nodeName, wrapped);
      }
      return async (s: GraphState): Promise<Partial<GraphState>> => {
        try {
          const telemetry = getCanvasTelemetry();
          telemetry.sendNodeActive(nodeName);
        } catch {
          // Non-critical, ignore telemetry errors
        }
        return wrapped(s);
      };
    };

    const telemetryWorkerTaskNode = wrapWithTelemetry("worker_task", workerTaskNode);
    const telemetryCollectNode = wrapWithTelemetry("worker_collect", async (s) => collectNode(s));
    const telemetryApprovalNode = wrapWithTelemetry("approval", approvalNode);
    const telemetryPartialApprovalNode = wrapWithTelemetry("partial_approval", partialApprovalNode);
    const gatedSprintPlanning = withCompositionGate("sprint_planning", "sprint_planning", sprintPlanningNode);
    const gatedSystemDesign = withCompositionGate("system_design", "system_design", systemDesignNode);
    const gatedRfc = withCompositionGate("rfc_phase", "rfc_phase", rfcNode);
    const telemetrySprintPlanningNode = wrapWithTelemetry("sprint_planning", gatedSprintPlanning);
    const telemetrySystemDesignNode = wrapWithTelemetry("system_design", gatedSystemDesign);
    const telemetryRfcNode = wrapWithTelemetry("rfc_phase", gatedRfc);
    const telemetryMemoryRetrievalNode = wrapWithTelemetry("memory_retrieval", memoryRetrievalNode);
    const telemetryCoordinatorNode = wrapWithTelemetry("coordinator", (s) => this.coordinator.coordinateNode(s, signal));
    const previewNode = createPreviewNode({ previewProvider, costConfig });
    const telemetryPreviewNode = wrapWithTelemetry("preview_gate", previewNode);
    const confidenceRouterNode = createConfidenceRouterNode({
      thresholds: CONFIG.confidenceScoringEnabled ? CONFIG.confidenceThresholds : undefined,
      team: this.team,
    });
    const telemetryConfidenceRouterNode = wrapWithTelemetry("confidence_router", async (s) => confidenceRouterNode(s));

    const workflow = new StateGraph(GameStateAnnotation)
      .addNode("memory_retrieval", telemetryMemoryRetrievalNode)
      .addNode("sprint_planning", telemetrySprintPlanningNode)
      .addNode("system_design", telemetrySystemDesignNode)
      .addNode("rfc_phase", telemetryRfcNode)
      .addNode("coordinator", telemetryCoordinatorNode)
      .addNode("preview_gate", telemetryPreviewNode)
      .addNode("approval", telemetryApprovalNode)
      .addNode("worker_task", telemetryWorkerTaskNode)
      .addNode("confidence_router", telemetryConfidenceRouterNode)
      .addNode("worker_collect", telemetryCollectNode)
      .addNode("partial_approval", telemetryPartialApprovalNode)
      .addNode("increment_cycle", (() => {
        const incrementFn = (s: GraphState): Partial<GraphState> => {
          const taskQueue = s.task_queue ?? [];
          const totalTasks = (s.total_tasks as number) ?? taskQueue.length;
          const completedTasks = taskQueue.filter((t) =>
            t.status === "completed" || t.status === "waiting_for_human" || t.status === "auto_approved_pending"
          ).length;
          const alreadyReported = s.mid_sprint_reported ?? false;

          const updates: Partial<GraphState> = {
            cycle_count: (s.cycle_count ?? 0) + 1,
            completed_tasks: completedTasks,
            __node__: "increment_cycle",
          };

          if (totalTasks > 0 && !alreadyReported && (completedTasks / totalTasks) >= 0.5) {
            const summary = generateMidSprintSummary(s);
              updates.messages = [summary];
            updates.mid_sprint_reported = true;
          }

          return updates;
        };
        const recorder = getActiveRecorder();
        return recorder ? wrapSyncWithRecording(recorder, "increment_cycle", incrementFn) : incrementFn;
      })())
      .addEdge(START, "memory_retrieval")
      .addEdge("memory_retrieval", "sprint_planning")
      .addEdge("sprint_planning", "system_design")
      .addEdge("system_design", "rfc_phase")
      .addEdge("rfc_phase", "coordinator")
      .addEdge("coordinator", "preview_gate")
      .addConditionalEdges(
        "preview_gate",
        (s) => {
          if (s.aborted) return "__end__";
          const taskQueue = s.task_queue ?? [];
          const pending = taskQueue.filter((t) => t.status === "pending");
          if (pending.length === 0) return "__end__";
          const needsApproval = getFirstTaskNeedingApproval(s) !== null;
          if (needsApproval) return "approval";
          return taskDispatcher(s);
        },
        { approval: "approval", worker_collect: "worker_collect", worker_task: "worker_task", __end__: END }
      )
      .addConditionalEdges(
        "approval",
        (s) => {
          const resp = s.approval_response as { action?: string } | null;
          if (resp?.action === "feedback") return "coordinator";
          return taskDispatcher(s);
        },
        { coordinator: "coordinator", worker_collect: "worker_collect", worker_task: "worker_task" }
      )
      .addEdge("worker_task", "confidence_router")
      .addEdge("confidence_router", "worker_collect")
      .addConditionalEdges(
        "worker_collect",
        (s) => {
          const tq = s.task_queue ?? [];
          const tIds = new Set<string>();
          for (const t of tq) {
            const st = t.status as string;
            if (st === "completed" || st === "failed" || st === "waiting_for_human" || st === "auto_approved_pending" || st === "escalated") {
              tIds.add(t.task_id as string);
            }
          }

          const hasReady = tq.some((t) => {
            const st = t.status as string;
            if (st === "reviewing" || st === "needs_rework") return true;
            if (st !== "pending") return false;
            const deps = (t.dependencies as string[]) ?? [];
            return deps.every((depId) => tIds.has(depId));
          });

          if (hasReady) {
            return taskDispatcher(s);
          }
          return "partial_approval";
        },
        { partial_approval: "partial_approval", worker_collect: "worker_collect", worker_task: "worker_task" }
      )
      .addConditionalEdges(
        "partial_approval",
        (s) => {
          const tq = s.task_queue ?? [];
          const hasRework = tq.some((t) => {
            const st = t.status as string;
            return st === "needs_rework";
          });
          if (hasRework) return taskDispatcher(s);
          return "increment_cycle";
        },
        { increment_cycle: "increment_cycle", worker_collect: "worker_collect", worker_task: "worker_task" }
      )
      .addConditionalEdges(
        "increment_cycle",
        (s) => {
          const cycle = s.cycle_count ?? 0;
          
          if (this.sessionTimeoutMs > 0) {
            const elapsed = Date.now() - this.sessionStartTime;
            if (elapsed >= this.sessionTimeoutMs) {
              log(`Session timeout reached: ${elapsed}ms >= ${this.sessionTimeoutMs}ms`);
              try {
                const telemetry = getCanvasTelemetry();
                telemetry.sendSessionTimeout("timeout", elapsed);
              } catch {
                // Non-critical
              }
              return "__end__";
            }
          }
          
          const effectiveMaxCycles = this.sessionMaxRuns > 0 
            ? Math.min(this.sessionMaxRuns, CONFIG.maxCycles)
            : CONFIG.maxCycles;
          
          if (cycle >= effectiveMaxCycles) {
            log(`Max runs reached: ${cycle} >= ${effectiveMaxCycles}`);
            try {
              const telemetry = getCanvasTelemetry();
              telemetry.sendSessionTimeout("max_runs", Date.now() - this.sessionStartTime);
            } catch {
              // Non-critical
            }
            return "__end__";
          }
          
          const taskQueue = s.task_queue ?? [];
          const active = taskQueue.filter((t) =>
            t.status === "pending" || t.status === "reviewing" || t.status === "needs_rework" || t.status === "in_progress" || t.status === "auto_approved_pending" || t.status === "rfc_pending"
          );
          if (active.length > 0 || s.user_goal) return "continue";
          return "__end__";
        },
        { continue: "coordinator", __end__: END }
      );

    this.graph = workflow.compile({
      checkpointer: new MemorySaver(),
    }) as TeamOrchestration["graph"];
    log(`Team orchestration ready with ${this.team.length} workers`);
  }

  getInitialState(options: {
    userGoal?: string | null;
    initialTasks?: Array<{ assigned_to?: string; description?: string; priority?: string }>;
    ancestralLessons?: string[];
    projectContext?: string;
    skipPreview?: boolean;
  } = {}): GraphState {
    const lessons = options.ancestralLessons ?? [];
    const projectContext = options.projectContext ?? "";
    const base = initializeGameState(1, lessons) as Record<string, unknown>;
    const teamData = this.team.map((b) => ({
      id: b.id,
      name: b.name,
      role_id: b.role_id,
      traits: b.traits,
      worker_url: b.worker_url,
    }));
    const teamFields = initializeTeamState(teamData, options.userGoal ?? null);
    Object.assign(base, teamFields);

    if (options.initialTasks?.length) {
      const q = (base.task_queue as Record<string, unknown>[]) ?? [];
      for (let i = 0; i < options.initialTasks.length; i++) {
        const t = options.initialTasks[i];
        q.push({
          task_id: `TASK-M${String(i).padStart(3, "0")}`,
          assigned_to: t.assigned_to ?? this.team[0]?.id ?? "bot_0",
          status: "pending",
          description: t.description ?? "",
          priority: t.priority ?? "MEDIUM",
          worker_tier: "light",
          result: null,
        });
      }
      base.task_queue = q;
    }

    (base.messages as string[]).push("Work session started");
    if (options.userGoal) base.user_goal = options.userGoal;
    if (projectContext) base.project_context = projectContext;
    if (options.skipPreview) base.skip_preview = true;
    if (this.teamComposition) base.teamComposition = this.teamComposition as unknown as Record<string, unknown>;

    return base as unknown as GraphState;
  }

  async run(options: {
    userGoal?: string | null;
    initialTasks?: Array<{ assigned_to?: string; description?: string; priority?: string }>;
    ancestralLessons?: string[];
    projectContext?: string;
    maxRuns?: number;
    timeoutMinutes?: number;
    skipPreview?: boolean;
  } = {}): Promise<GraphState> {
    this.sessionStartTime = Date.now();
    this.sessionTimeoutMs = (options.timeoutMinutes ?? 0) * 60 * 1000;
    this.sessionMaxRuns = options.maxRuns ?? 0;
    
    const state = this.getInitialState(options);
    const config = { configurable: { thread_id: randomUUID() } };
    
    let endedDueToTimeout = false;
    let elapsedMs = 0;
    
    try {
      const result = await this.graph.invoke(state, config);
      
      if (this.sessionTimeoutMs > 0) {
        elapsedMs = Date.now() - this.sessionStartTime;
        if (elapsedMs >= this.sessionTimeoutMs) {
          endedDueToTimeout = true;
        }
      }
      
      try {
        const telemetry = getCanvasTelemetry();
        if (endedDueToTimeout) {
          telemetry.sendSessionTimeout("timeout", elapsedMs);
        } else {
          telemetry.sendNodeActive("completed");
        }
      } catch {
        // Non-critical, ignore telemetry errors
      }
      return result as GraphState;
    } catch (err) {
      if (this.sessionTimeoutMs > 0) {
        elapsedMs = Date.now() - this.sessionStartTime;
        if (elapsedMs >= this.sessionTimeoutMs) {
          try {
            const telemetry = getCanvasTelemetry();
            telemetry.sendSessionTimeout("timeout", elapsedMs);
          } catch {
            // Non-critical
          }
        }
      }
      throw err;
    }
  }

  async *stream(options: {
    userGoal?: string | null;
    initialTasks?: Array<{ assigned_to?: string; description?: string; priority?: string }>;
    ancestralLessons?: string[];
    projectContext?: string;
    maxRuns?: number;
    timeoutMinutes?: number;
    skipPreview?: boolean;
  } = {}): AsyncGenerator<Record<string, GraphState>> {
    this.sessionStartTime = Date.now();
    this.sessionTimeoutMs = (options.timeoutMinutes ?? 0) * 60 * 1000;
    this.sessionMaxRuns = options.maxRuns ?? 0;
    
    const state = this.getInitialState(options);
    const config = { streamMode: "values" as const, configurable: { thread_id: randomUUID() } };
    let lastChunk: Record<string, GraphState> | null = null;
    let endedDueToTimeout = false;
    let elapsedMs = 0;
    
    try {
      for await (const chunk of await this.graph.stream(state, config)) {
        lastChunk = chunk as Record<string, GraphState>;
        
        if (this.sessionTimeoutMs > 0) {
          elapsedMs = Date.now() - this.sessionStartTime;
          if (elapsedMs >= this.sessionTimeoutMs) {
            endedDueToTimeout = true;
            break;
          }
        }
        
        yield lastChunk;
      }
    } catch (err) {
      if (this.sessionTimeoutMs > 0) {
        elapsedMs = Date.now() - this.sessionStartTime;
        if (elapsedMs >= this.sessionTimeoutMs) {
          endedDueToTimeout = true;
        }
      }
      throw err;
    }
    
    if (lastChunk) {
      try {
        const telemetry = getCanvasTelemetry();
        if (endedDueToTimeout && this.sessionTimeoutMs > 0) {
          telemetry.sendSessionTimeout("timeout", elapsedMs);
        } else {
          telemetry.sendNodeActive("completed");
        }
      } catch {
        // Non-critical, ignore telemetry errors
      }
    }
  }
}

export function createTeamOrchestration(options: {
  team?: BotDefinition[];
  teamTemplateId?: string;
  workerUrls?: Record<string, string>;
  approvalProvider?: ApprovalProvider | null;
  partialApprovalProvider?: PerTaskApprovalProvider | null;
  previewProvider?: PreviewProvider | null;
  workspacePath?: string;
  autoApprove?: boolean;
  vectorMemory?: VectorMemory;
  signal?: AbortSignal;
  costConfig?: Partial<CostConfig>;
  teamComposition?: TeamComposition;
} = {}): TeamOrchestration {
  return new TeamOrchestration(options);
}
