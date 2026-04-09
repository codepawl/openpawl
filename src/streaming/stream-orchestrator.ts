/**
 * StreamOrchestrator — coordinates agents based on RouteDecision strategy.
 * Main entry point called by the Dispatcher.
 */

import { EventEmitter } from "node:events";
import { Result, ok, err } from "neverthrow";
import type {
  StreamEvent,
  StreamCompleteEvent,
  AgentRunResult,
  StreamError,
} from "./types.js";
import type { AgentRunner } from "./agent-runner.js";
import type { AgentRegistry } from "../router/agent-registry.js";
import type { ToolRegistry } from "../tools/registry.js";
import type { SessionManager } from "../session/session-manager.js";
import type { TokenTracker } from "./cost-tracker.js";
import { StreamAbortManager } from "./abort-controller.js";
import type { RouteDecision, AgentAssignment } from "../router/router-types.js";
import type { ToolPermissionConfig } from "../tools/types.js";

export class StreamOrchestrator extends EventEmitter {
  private abortManager = new StreamAbortManager();

  constructor(
    private agentRunner: AgentRunner,
    private agentRegistry: AgentRegistry,
    private toolRegistry: ToolRegistry,
    private sessionManager: SessionManager,
    private tokenTracker: TokenTracker,
  ) {
    super();

    // Forward all agent runner events
    agentRunner.on("stream:event", (event: StreamEvent) => {
      this.emit(event.type, event);
      this.emit("stream:event", event);
    });
  }

  async execute(
    sessionId: string,
    prompt: string,
    decision: RouteDecision,
    permissionConfig: ToolPermissionConfig,
  ): Promise<Result<StreamCompleteEvent, StreamError>> {
    const startTime = Date.now();
    this.abortManager.createForSession(sessionId);

    try {
      let results: AgentRunResult[];

      switch (decision.strategy) {
        case "single":
          results = await this.executeSingle(sessionId, prompt, decision, permissionConfig);
          break;
        case "sequential":
          results = await this.executeSequential(sessionId, prompt, decision, permissionConfig);
          break;
        case "parallel":
          results = await this.executeParallel(sessionId, prompt, decision, permissionConfig);
          break;
        case "orchestrated":
          results = await this.executeOrchestrated(sessionId, prompt, decision, permissionConfig);
          break;
        case "clarify":
          results = await this.executeClarify(sessionId, prompt);
          break;
        default:
          return err({ type: "serialization_error", cause: `Unknown strategy: ${decision.strategy}` });
      }

      const event: StreamCompleteEvent = {
        type: "stream:complete",
        sessionId,
        agentResults: results,
        totalDuration: Date.now() - startTime,
        timestamp: Date.now(),
      };

      this.emit("stream:complete", event);
      return ok(event);
    } finally {
      this.abortManager.cleanup(sessionId);
    }
  }

  abort(sessionId: string): void {
    this.abortManager.abortSession(sessionId);
  }

  // ── Strategy Implementations ──────────────────────────────────────────

  private async executeSingle(
    sessionId: string,
    prompt: string,
    decision: RouteDecision,
    permConfig: ToolPermissionConfig,
  ): Promise<AgentRunResult[]> {
    const assignment = decision.agents[0];
    if (!assignment) return [];

    const result = await this.runAssignment(sessionId, prompt, assignment, permConfig);
    return [result];
  }

  private async executeSequential(
    sessionId: string,
    prompt: string,
    decision: RouteDecision,
    permConfig: ToolPermissionConfig,
  ): Promise<AgentRunResult[]> {
    const sorted = [...decision.agents].sort((a, b) => a.priority - b.priority);
    const results: AgentRunResult[] = [];
    let previousOutput = prompt;

    for (const assignment of sorted) {
      if (this.abortManager.isAborted(sessionId)) break;

      const taskPrompt = assignment.task || previousOutput;
      const result = await this.runAssignment(
        sessionId,
        taskPrompt,
        assignment,
        permConfig,
        results.length > 0 ? results[results.length - 1]!.content : undefined,
      );
      results.push(result);

      if (!result.success) break;
      previousOutput = result.content;
    }

    return results;
  }

  private async executeParallel(
    sessionId: string,
    prompt: string,
    decision: RouteDecision,
    permConfig: ToolPermissionConfig,
  ): Promise<AgentRunResult[]> {
    const promises = decision.agents.map((assignment) =>
      this.runAssignment(sessionId, assignment.task || prompt, assignment, permConfig)
        .catch((e): AgentRunResult => ({
          agentId: assignment.agentId,
          success: false,
          content: "",
          toolCalls: [],
          inputTokens: 0,
          outputTokens: 0,
                    duration: 0,
          error: String(e),
        })),
    );

    return Promise.all(promises);
  }

  private async executeOrchestrated(
    sessionId: string,
    prompt: string,
    decision: RouteDecision,
    permConfig: ToolPermissionConfig,
  ): Promise<AgentRunResult[]> {
    // Run planner first
    const plannerAssignment = decision.agents[0];
    if (!plannerAssignment) return [];

    const planResult = await this.runAssignment(sessionId, prompt, plannerAssignment, permConfig);
    return [planResult]; // v1: just the planner's output
  }

  private async executeClarify(
    sessionId: string,
    _prompt: string,
  ): Promise<AgentRunResult[]> {
    const content = "I'm not sure I understand. Could you rephrase or provide more details?";

    this.emit("stream:event", {
      type: "agent:token",
      sessionId,
      agentId: "system",
      token: content,
      timestamp: Date.now(),
    } satisfies StreamEvent);

    return [{
      agentId: "system",
      success: true,
      content,
      toolCalls: [],
      inputTokens: 0,
      outputTokens: 0,
            duration: 0,
    }];
  }

  // ── Helper ────────────────────────────────────────────────────────────

  private async runAssignment(
    sessionId: string,
    prompt: string,
    assignment: AgentAssignment,
    permConfig: ToolPermissionConfig,
    additionalContext?: string,
  ): Promise<AgentRunResult> {
    const agent = this.agentRegistry.get(assignment.agentId);
    if (!agent) {
      return {
        agentId: assignment.agentId,
        success: false,
        content: "",
        toolCalls: [],
        inputTokens: 0,
        outputTokens: 0,
                duration: 0,
        error: `Agent "${assignment.agentId}" not found`,
      };
    }

    const toolSet = this.toolRegistry.resolveForAgent(
      assignment.agentId,
      assignment.tools,
      permConfig,
    );

    const abortController = this.abortManager.createForAgent(sessionId, assignment.agentId);

    // Get session
    const active = this.sessionManager.getActive();
    if (!active) {
      return {
        agentId: assignment.agentId,
        success: false,
        content: "",
        toolCalls: [],
        inputTokens: 0,
        outputTokens: 0,
                duration: 0,
        error: "No active session",
      };
    }

    const result = await this.agentRunner.run({
      session: active,
      sessionId,
      agentId: assignment.agentId,
      agentDefinition: agent,
      prompt,
      tools: toolSet,
      abortSignal: abortController.signal,
      additionalContext,
    });

    if (result.isOk()) {
      // Add assistant message to session
      active.addMessage({
        role: "assistant",
        content: result.value.content,
        agentId: assignment.agentId,
      });
      return result.value;
    }

    return {
      agentId: assignment.agentId,
      success: false,
      content: "",
      toolCalls: [],
      inputTokens: 0,
      outputTokens: 0,
            duration: 0,
      error: result.error.type,
    };
  }
}
