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
import { createWorkerBots, createWorkerExecuteNode } from "../agents/worker-bot.js";
import { getFirstTaskNeedingApproval, createApprovalNode, createHumanApprovalNode } from "../agents/approval.js";
import type { ApprovalProvider } from "../agents/approval.js";
import { UniversalOpenClawAdapter } from "../interfaces/worker-adapter.js";
import { logger, isDebugMode } from "./logger.js";
import { createSprintPlanningNode } from "../agents/planning.js";
import { createRFCNode } from "../agents/rfc.js";
import { createSystemDesignNode } from "../agents/system-design.js";
import { createMemoryRetrievalNode } from "../agents/memory-retrieval.js";
import type { VectorMemory } from "./knowledge-base.js";
import { getCanvasTelemetry } from "./canvas-telemetry.js";

function log(msg: string): void {
  if (isDebugMode()) {
    logger.agent(msg);
  }
}

function generateMidSprintSummary(state: GraphState): string {
  const taskQueue = state.task_queue ?? [];
  const totalTasks = (state.total_tasks as number) ?? taskQueue.length;
  
  const completedTasks = taskQueue.filter((t) => 
    t.status === "completed" || t.status === "waiting_for_human"
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
  private sessionStartTime: number = 0;
  private sessionTimeoutMs: number = 0;
  private sessionMaxRuns: number = 0;

  constructor(options: {
    team?: BotDefinition[];
    teamTemplateId?: string;
    workerUrls?: Record<string, string>;
    approvalProvider?: ApprovalProvider | null;
    workspacePath?: string;
    autoApprove?: boolean;
    vectorMemory?: VectorMemory;
  } = {}) {
    const { team, teamTemplateId = "game_dev", workerUrls = {}, approvalProvider = null, workspacePath, autoApprove = false, vectorMemory } = options;
    this.team = team ?? buildTeamFromTemplate(teamTemplateId);
    this.workerBots = createWorkerBots(this.team, workerUrls, workspacePath);
    const sharedLlmAdapter =
      Object.values(this.workerBots)[0]?.adapter ??
      new UniversalOpenClawAdapter({
        workerUrl: CONFIG.openclawWorkerUrl,
        authToken: CONFIG.openclawToken,
      });
    this.coordinator = new CoordinatorAgent({ llmAdapter: sharedLlmAdapter, workspacePath });

    const workerNode = createWorkerExecuteNode(this.workerBots, this.team);
    const approvalNode = createApprovalNode(approvalProvider);
    const humanApprovalNode = createHumanApprovalNode(autoApprove);
    const sprintPlanningNode = createSprintPlanningNode(workspacePath ?? "", sharedLlmAdapter);
    const systemDesignNode = createSystemDesignNode(workspacePath ?? "", sharedLlmAdapter);
    const rfcNode = createRFCNode(workspacePath ?? "", this.team, sharedLlmAdapter);
    const memoryRetrievalNode = vectorMemory 
      ? createMemoryRetrievalNode(vectorMemory)
      : createMemoryRetrievalNode({} as VectorMemory);

    const wrapWithTelemetry = (
      nodeName: string,
      fn: (s: GraphState) => Promise<Partial<GraphState>>
    ): ((s: GraphState) => Promise<Partial<GraphState>>) => {
      return async (s: GraphState): Promise<Partial<GraphState>> => {
        try {
          const telemetry = getCanvasTelemetry();
          telemetry.sendNodeActive(nodeName);
        } catch {
          // Non-critical, ignore telemetry errors
        }
        return fn(s);
      };
    };

    const telemetryWorkerNode = wrapWithTelemetry("worker_execute", workerNode);
    const telemetryApprovalNode = wrapWithTelemetry("approval", approvalNode);
    const telemetryHumanApprovalNode = wrapWithTelemetry("human_approval", humanApprovalNode);
    const telemetrySprintPlanningNode = wrapWithTelemetry("sprint_planning", sprintPlanningNode);
    const telemetrySystemDesignNode = wrapWithTelemetry("system_design", systemDesignNode);
    const telemetryRfcNode = wrapWithTelemetry("rfc_phase", rfcNode);
    const telemetryMemoryRetrievalNode = wrapWithTelemetry("memory_retrieval", memoryRetrievalNode);
    const telemetryCoordinatorNode = wrapWithTelemetry("coordinator", (s) => this.coordinator.coordinateNode(s));

    const workflow = new StateGraph(GameStateAnnotation)
      .addNode("memory_retrieval", telemetryMemoryRetrievalNode)
      .addNode("sprint_planning", telemetrySprintPlanningNode)
      .addNode("system_design", telemetrySystemDesignNode)
      .addNode("rfc_phase", telemetryRfcNode)
      .addNode("coordinator", telemetryCoordinatorNode)
      .addNode("approval", telemetryApprovalNode)
      .addNode("worker_execute", telemetryWorkerNode)
      .addNode("human_approval", telemetryHumanApprovalNode)
      .addNode("increment_cycle", (s): Partial<GraphState> => {
        const taskQueue = s.task_queue ?? [];
        const totalTasks = (s.total_tasks as number) ?? taskQueue.length;
        const completedTasks = taskQueue.filter((t) => 
          t.status === "completed" || t.status === "waiting_for_human"
        ).length;
        const alreadyReported = s.mid_sprint_reported ?? false;
        
        const updates: Partial<GraphState> = {
          cycle_count: (s.cycle_count ?? 0) + 1,
          completed_tasks: completedTasks,
          __node__: "increment_cycle",
        };
        
        if (totalTasks > 0 && !alreadyReported && (completedTasks / totalTasks) >= 0.5) {
          const summary = generateMidSprintSummary(s);
          const currentMessages = [...(s.messages ?? [])];
          currentMessages.push(summary);
          updates.messages = currentMessages;
          updates.mid_sprint_reported = true;
        }
        
        return updates;
      })
      .addEdge(START, "memory_retrieval")
      .addEdge("memory_retrieval", "sprint_planning")
      .addEdge("sprint_planning", "system_design")
      .addEdge("system_design", "rfc_phase")
      .addEdge("rfc_phase", "coordinator")
      .addConditionalEdges(
        "coordinator",
        (s) => {
          const taskQueue = s.task_queue ?? [];
          const pending = taskQueue.filter((t) => t.status === "pending");
          if (pending.length === 0) return "__end__";
          const needsApproval = getFirstTaskNeedingApproval(s) !== null;
          return needsApproval ? "approval" : "worker_execute";
        },
        { approval: "approval", worker_execute: "worker_execute", __end__: END }
      )
      .addConditionalEdges(
        "approval",
        (s) => {
          const resp = s.approval_response as { action?: string } | null;
          return resp?.action === "feedback" ? "coordinator" : "worker_execute";
        },
        { coordinator: "coordinator", worker_execute: "worker_execute" }
      )
      .addEdge("worker_execute", "human_approval")
      .addEdge("human_approval", "increment_cycle")
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
            t.status === "pending" || t.status === "reviewing" || t.status === "needs_rework" || t.status === "in_progress" || t.status === "waiting_for_human" || t.status === "rfc_pending"
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

    return base as unknown as GraphState;
  }

  async run(options: {
    userGoal?: string | null;
    initialTasks?: Array<{ assigned_to?: string; description?: string; priority?: string }>;
    ancestralLessons?: string[];
    projectContext?: string;
    maxRuns?: number;
    timeoutMinutes?: number;
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
    projectContext?: string;
    maxRuns?: number;
    timeoutMinutes?: number;
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
  workspacePath?: string;
  autoApprove?: boolean;
  vectorMemory?: VectorMemory;
} = {}): TeamOrchestration {
  return new TeamOrchestration(options);
}
