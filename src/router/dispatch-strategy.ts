/**
 * Dispatch strategy — executes RouteDecisions by dispatching to agents.
 * Orchestrates single/sequential/parallel/orchestrated/clarify flows.
 *
 * Note: Actual LLM agent execution is placeholder/mocked in v1.
 * Real wiring to providers happens in a later task.
 */

import { EventEmitter } from "node:events";
import { Result, ok, err } from "neverthrow";
import { buildIdentityPrefix } from "./agent-registry.js";
import { profileStart } from "../telemetry/profiler.js";
import { debugLog, isDebugEnabled, truncateStr, TRUNCATION } from "../debug/logger.js";
import type {
  RouteDecision,
  DispatchResult,
  AgentResult,
  AgentAssignment,
  RouterError,
} from "./router-types.js";
import { AgentRegistry } from "./agent-registry.js";
import { RouterEvent } from "./event-types.js";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface DispatcherEvents {
  "dispatch:start": (sessionId: string, decision: RouteDecision) => void;
  "dispatch:agent:start": (sessionId: string, agentId: string) => void;
  "dispatch:agent:token": (sessionId: string, agentId: string, token: string) => void;
  "dispatch:agent:tool": (sessionId: string, agentId: string, toolName: string, status: string, details?: Record<string, unknown>) => void;
  "dispatch:agent:done": (sessionId: string, agentId: string, result: AgentResult) => void;
  "dispatch:done": (sessionId: string, result: DispatchResult) => void;
  "dispatch:error": (sessionId: string, error: RouterError) => void;
  "dispatch:abort": (sessionId: string) => void;
}

/**
 * Interface for running a single agent. Abstracted to allow
 * placeholder/mock implementation in v1, real wiring later.
 */
export interface AgentRunner {
  run(
    agentId: string,
    prompt: string,
    tools: string[],
    context: {
      systemPrompt: string;
      sessionHistory?: Array<{ role: string; content: string }>;
      model?: string;
    },
    signal?: AbortSignal,
  ): Promise<AgentResult>;
}


// ─── Dispatcher ──────────────────────────────────────────────────────────────

export class Dispatcher extends EventEmitter {
  private abortControllers = new Map<string, AbortController>();
  private currentSessionId = "";
  private currentSessionHistory: Array<{ role: string; content: string }> = [];

  constructor(
    private registry: AgentRegistry,
    private agentRunner: AgentRunner,
  ) {
    super();
  }

  /** Expose the emitter so the LLM runner can emit token events during streaming. */
  emitToken(agentId: string, token: string): void {
    this.emit(RouterEvent.AgentToken, this.currentSessionId, agentId, token);
  }

  async dispatch(
    sessionId: string,
    prompt: string,
    decision: RouteDecision,
    sessionHistory?: Array<{ role: string; content: string }>,
  ): Promise<Result<DispatchResult, RouterError>> {
    this.currentSessionId = sessionId;
    this.currentSessionHistory = sessionHistory ?? [];
    this.emit(RouterEvent.Start, sessionId, decision);

    const finishPipeline = profileStart("total_pipeline", `dispatch_${decision.strategy}`, { agents: decision.agents });
    const controller = new AbortController();
    this.abortControllers.set(sessionId, controller);

    try {
      let result: DispatchResult;

      switch (decision.strategy) {
        case "single":
          result = await this.dispatchSingle(sessionId, prompt, decision, controller.signal);
          break;
        case "sequential":
          result = await this.dispatchSequential(sessionId, prompt, decision, controller.signal);
          break;
        case "parallel":
          result = await this.dispatchParallel(sessionId, prompt, decision, controller.signal);
          break;
        case "orchestrated":
          result = await this.dispatchOrchestrated(sessionId, prompt, decision, controller.signal);
          break;
        case "collab":
          result = await this.dispatchCollab(sessionId, prompt, decision, controller.signal);
          break;
        case "clarify":
          result = await this.dispatchClarify(sessionId, prompt);
          break;
        default:
          return err({ type: "dispatch_failed", agentId: "unknown", cause: `Unknown strategy: ${decision.strategy}` });
      }

      finishPipeline();
      this.emit(RouterEvent.Done, sessionId, result);
      return ok(result);
    } catch (e) {
      finishPipeline();
      const error: RouterError = {
        type: "dispatch_failed",
        agentId: "unknown",
        cause: e instanceof Error ? e.message : String(e),
      };
      this.emit(RouterEvent.Error, sessionId, error);
      return err(error);
    } finally {
      this.abortControllers.delete(sessionId);
    }
  }

  abort(sessionId: string): void {
    const controller = this.abortControllers.get(sessionId);
    if (controller) {
      controller.abort();
      this.emit(RouterEvent.Abort, sessionId);
    }
  }

  // ─── Strategy Implementations ────────────────────────────────────────────

  private async dispatchSingle(
    sessionId: string,
    prompt: string,
    decision: RouteDecision,
    signal: AbortSignal,
  ): Promise<DispatchResult> {
    const assignment = decision.agents[0];
    if (!assignment) {
      return emptyResult("single");
    }

    const result = await this.runAgent(sessionId, assignment, prompt, signal);

    return {
      strategy: "single",
      agentResults: [result],
      ...aggregateCosts([result]),
    };
  }

  private async dispatchSequential(
    sessionId: string,
    prompt: string,
    decision: RouteDecision,
    signal: AbortSignal,
  ): Promise<DispatchResult> {
    const sorted = [...decision.agents].sort((a, b) => a.priority - b.priority);
    const results: AgentResult[] = [];
    let previousOutput = prompt;

    for (const assignment of sorted) {
      if (signal.aborted) break;

      // Each agent gets the previous agent's output as context
      const taskPrompt = assignment.task || previousOutput;
      const result = await this.runAgent(sessionId, assignment, taskPrompt, signal);
      results.push(result);

      if (!result.success) break; // Stop chain on failure
      previousOutput = result.response;
    }

    return {
      strategy: "sequential",
      agentResults: results,
      ...aggregateCosts(results),
    };
  }

  private async dispatchParallel(
    sessionId: string,
    prompt: string,
    decision: RouteDecision,
    signal: AbortSignal,
  ): Promise<DispatchResult> {
    const promises = decision.agents.map((assignment) =>
      this.runAgent(sessionId, assignment, assignment.task || prompt, signal)
        .catch((e): AgentResult => makeFailedResult(assignment.agentId, String(e))),
    );

    const results = await Promise.all(promises);

    return {
      strategy: "parallel",
      agentResults: results,
      ...aggregateCosts(results),
    };
  }

  private async dispatchOrchestrated(
    sessionId: string,
    prompt: string,
    decision: RouteDecision,
    signal: AbortSignal,
  ): Promise<DispatchResult> {
    // Step 1: Run planner to decompose task
    const plannerAssignment = decision.agents[0];
    if (!plannerAssignment) return emptyResult("orchestrated");

    const planResult = await this.runAgent(sessionId, plannerAssignment, prompt, signal);
    const results: AgentResult[] = [planResult];

    // In v1 (placeholder), just return the planner's result.
    // Real orchestration (decompose → dispatch sub-tasks) wired later.

    return {
      strategy: "orchestrated",
      agentResults: results,
      ...aggregateCosts(results),
    };
  }

  private async dispatchClarify(
    _sessionId: string,
    _prompt: string,
  ): Promise<DispatchResult> {
    const clarification = `I'm not sure I understand. Could you rephrase or provide more details about what you'd like me to do?`;

    const result: AgentResult = {
      agentId: "system",
      success: true,
      response: clarification,
      toolCalls: [],
      duration: 0,
      inputTokens: 0,
      outputTokens: 0,
    };

    return {
      strategy: "clarify",
      agentResults: [result],
      ...aggregateCosts([result]),
    };
  }

  private async dispatchCollab(
    sessionId: string,
    originalPrompt: string,
    decision: RouteDecision,
    signal: AbortSignal,
  ): Promise<DispatchResult> {
    const sorted = [...decision.agents].sort((a, b) => a.priority - b.priority);
    const results: AgentResult[] = [];
    const priorOutputs: { role: string; response: string }[] = [];

    // Debug: log collab chain definition
    if (isDebugEnabled()) {
      debugLog("info", "router", "collab:chain_start", {
        data: {
          agentOrder: sorted.map((a) => a.agentId),
          stepCount: sorted.length,
        },
      });
    }

    for (const assignment of sorted) {
      if (signal.aborted) break;

      // Each agent gets the original prompt plus all prior agents' output
      const contextParts = [originalPrompt];
      for (const prior of priorOutputs) {
        contextParts.push(`\n\n[${prior.role} output]:\n${prior.response}`);
      }
      const taskPrompt = contextParts.join("");

      // Debug: log collab step input
      if (isDebugEnabled()) {
        const lastPrior = priorOutputs[priorOutputs.length - 1];
        debugLog("info", "router", "collab:step_start", {
          data: {
            agentId: assignment.agentId,
            role: assignment.role,
            inputLength: taskPrompt.length,
            priorOutputPreview: lastPrior
              ? truncateStr(lastPrior.response, TRUNCATION.contextPassing)
              : undefined,
            contextChainLength: priorOutputs.length,
          },
        });
      }

      const stepStart = Date.now();
      const result = await this.runAgent(sessionId, assignment, taskPrompt, signal);
      results.push(result);

      // Debug: log collab step output
      if (isDebugEnabled()) {
        debugLog("info", "router", "collab:step_done", {
          data: {
            agentId: assignment.agentId,
            success: result.success,
            outputPreview: result.response
              ? truncateStr(result.response, TRUNCATION.contextPassing)
              : undefined,
            outputLength: result.response?.length ?? 0,
          },
          duration: Date.now() - stepStart,
        });
      }

      if (!result.success) break;
      priorOutputs.push({ role: assignment.role, response: result.response });
    }

    return {
      strategy: "collab",
      agentResults: results,
      ...aggregateCosts(results),
    };
  }

  // ─── Agent Execution ─────────────────────────────────────────────────────

  private async runAgent(
    sessionId: string,
    assignment: AgentAssignment,
    prompt: string,
    signal: AbortSignal,
  ): Promise<AgentResult> {
    const agent = this.registry.get(assignment.agentId);
    if (!agent) {
      return makeFailedResult(assignment.agentId, `Agent "${assignment.agentId}" not found`);
    }

    this.emit(RouterEvent.AgentStart, sessionId, assignment.agentId);

    // Build full system prompt: identity prefix + agent-specific instructions
    const identity = buildIdentityPrefix(agent.name, assignment.model);
    const fullSystemPrompt = identity + "\n\n" + agent.systemPrompt;

    const startTime = Date.now();
    const result = await this.agentRunner.run(
      assignment.agentId,
      prompt,
      assignment.tools,
      {
        systemPrompt: fullSystemPrompt,
        sessionHistory: this.currentSessionHistory,
        model: assignment.model,
      },
      signal,
    );
    result.duration = Date.now() - startTime;

    this.emit(RouterEvent.AgentDone, sessionId, assignment.agentId, result);
    return result;
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeFailedResult(agentId: string, error: string): AgentResult {
  return {
    agentId,
    success: false,
    response: "",
    toolCalls: [],
    duration: 0,
    inputTokens: 0,
    outputTokens: 0,
    error,
  };
}

function aggregateCosts(results: AgentResult[]): {
  totalDuration: number;
  totalInputTokens: number;
  totalOutputTokens: number;
} {
  let totalDuration = 0;
  let totalInputTokens = 0;
  let totalOutputTokens = 0;

  for (const r of results) {
    totalDuration += r.duration;
    totalInputTokens += r.inputTokens;
    totalOutputTokens += r.outputTokens;
  }

  return { totalDuration, totalInputTokens, totalOutputTokens };
}

function emptyResult(strategy: DispatchResult["strategy"]): DispatchResult {
  return {
    strategy,
    agentResults: [],
    totalDuration: 0,
    totalInputTokens: 0,
    totalOutputTokens: 0,
  };
}
