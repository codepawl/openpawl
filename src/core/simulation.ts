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
import { getFirstTaskNeedingApproval, createApprovalNode } from "../agents/approval.js";
import type { ApprovalProvider } from "../agents/approval.js";
import { UniversalOpenClawAdapter } from "../interfaces/worker-adapter.js";
import { logger } from "./logger.js";

function log(msg: string): void {
  if (CONFIG.verboseLogging) {
    logger.agent(msg);
  }
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

  constructor(options: {
    team?: BotDefinition[];
    teamTemplateId?: string;
    workerUrls?: Record<string, string>;
    approvalProvider?: ApprovalProvider | null;
    workspacePath?: string;
  } = {}) {
    const { team, teamTemplateId = "game_dev", workerUrls = {}, approvalProvider = null, workspacePath } = options;
    this.team = team ?? buildTeamFromTemplate(teamTemplateId);
    this.workerBots = createWorkerBots(this.team, workerUrls, workspacePath);
    const sharedLlmAdapter =
      Object.values(this.workerBots)[0]?.adapter ??
      new UniversalOpenClawAdapter({
        workerUrl: CONFIG.openclawWorkerUrl,
        authToken: CONFIG.openclawToken,
      });
    this.coordinator = new CoordinatorAgent({ llmAdapter: sharedLlmAdapter, workspacePath });

    const workerNode = createWorkerExecuteNode(this.workerBots);
    const approvalNode = createApprovalNode(approvalProvider);

    const workflow = new StateGraph(GameStateAnnotation)
      .addNode("coordinator", (s) => this.coordinator.coordinateNode(s))
      .addNode("approval", approvalNode)
      .addNode("worker_execute", workerNode)
      .addNode("increment_cycle", (s): Partial<GraphState> => ({
        cycle_count: (s.cycle_count ?? 0) + 1,
        __node__: "increment_cycle",
      }))
      .addEdge(START, "coordinator")
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
      .addEdge("worker_execute", "increment_cycle")
      .addConditionalEdges(
        "increment_cycle",
        (s) => {
          const cycle = s.cycle_count ?? 0;
          if (cycle >= CONFIG.maxCycles) return "__end__";
          const taskQueue = s.task_queue ?? [];
          const pending = taskQueue.filter((t) => t.status === "pending");
          if (pending.length > 0 || s.user_goal) return "continue";
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
  } = {}): GraphState {
    const lessons = options.ancestralLessons ?? [];
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

    return base as unknown as GraphState;
  }

  async run(options: {
    userGoal?: string | null;
    initialTasks?: Array<{ assigned_to?: string; description?: string; priority?: string }>;
    ancestralLessons?: string[];
  } = {}): Promise<GraphState> {
    const state = this.getInitialState(options);
    const config = { configurable: { thread_id: randomUUID() } };
    const result = await this.graph.invoke(state, config);
    return result as GraphState;
  }

  async *stream(options: {
    userGoal?: string | null;
    initialTasks?: Array<{ assigned_to?: string; description?: string; priority?: string }>;
  } = {}): AsyncGenerator<Record<string, GraphState>> {
    const state = this.getInitialState(options);
    const config = { streamMode: "values" as const, configurable: { thread_id: randomUUID() } };
    for await (const chunk of await this.graph.stream(state, config)) {
      yield chunk as Record<string, GraphState>;
    }
  }
}

export function createTeamOrchestration(options: {
  team?: BotDefinition[];
  teamTemplateId?: string;
  workerUrls?: Record<string, string>;
  approvalProvider?: ApprovalProvider | null;
  workspacePath?: string;
} = {}): TeamOrchestration {
  return new TeamOrchestration(options);
}
