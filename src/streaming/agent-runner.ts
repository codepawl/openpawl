/**
 * AgentRunner — runs a single agent: LLM streaming + tool call loop.
 * Emits StreamEvents for each token, tool call, and completion.
 */

import { EventEmitter } from "node:events";
import { Result, ok, err } from "neverthrow";
import type { AgentRunResult, StreamEvent, LLMMessage, StreamError, ToolCallRecord } from "./types.js";
import type { ContextBuilder } from "./context-builder.js";
import { ToolCallHandler } from "./tool-call-handler.js";
import type { TokenTracker } from "./cost-tracker.js";
import type { AgentDefinition } from "../router/router-types.js";
import type { ResolvedToolSet, ToolExecutionContext } from "../tools/types.js";
import type { Session } from "../session/session.js";
import type { ContextTracker } from "../context/context-tracker.js";
import type { ContextLevel } from "../context/types.js";
import { compact } from "../context/compaction.js";

const MAX_TOOL_LOOP_ITERATIONS = 10;

/** Interface for the LLM provider streaming call. */
export interface LLMStreamProvider {
  stream(prompt: string, options?: {
    model?: string;
    systemPrompt?: string;
    signal?: AbortSignal;
  }): AsyncGenerator<{ content: string; done: boolean; usage?: { promptTokens: number; completionTokens: number } }>;
}

export class AgentRunner extends EventEmitter {
  constructor(
    private llmProvider: LLMStreamProvider,
    private contextBuilder: ContextBuilder,
    private toolCallHandler: ToolCallHandler,
    private tokenTracker: TokenTracker,
    private contextTracker?: ContextTracker,
    private onContextUpdate?: (utilization: number, level: ContextLevel) => void,
  ) {
    super();
  }

  async run(options: {
    session: Session;
    sessionId: string;
    agentId: string;
    agentDefinition: AgentDefinition;
    prompt: string;
    tools: ResolvedToolSet;
    abortSignal?: AbortSignal;
    additionalContext?: string;
  }): Promise<Result<AgentRunResult, StreamError>> {
    const {
      session, sessionId, agentId, agentDefinition, prompt,
      tools, abortSignal, additionalContext,
    } = options;

    const startTime = Date.now();
    const allToolCalls: ToolCallRecord[] = [];
    let totalInput = 0;
    let totalOutput = 0;
    let accumulatedContent = "";
    let iteration = 0;

    // Emit agent start
    this.emitStreamEvent({
      type: "agent:start",
      sessionId,
      agentId,
      agentName: agentDefinition.name,
      task: prompt.slice(0, 200),
      timestamp: Date.now(),
    });

    // Build initial context
    const contextResult = this.contextBuilder.build({
      session,
      agentId,
      agentSystemPrompt: agentDefinition.systemPrompt,
      prompt,
      tools: [...tools.tools.keys()],
      additionalContext,
    });

    if (contextResult.isErr()) {
      return this.emitError(sessionId, agentId, contextResult.error);
    }

    // Messages accumulate across tool loop iterations
    const messages = [...contextResult.value.messages];
    const model = agentDefinition.modelTier === "primary"
      ? undefined // Let provider use default
      : undefined; // Model routing handled by ProviderManager

    // Tool-call loop
    while (iteration < MAX_TOOL_LOOP_ITERATIONS) {
      iteration++;

      if (abortSignal?.aborted) {
        return this.makeAbortResult(sessionId, agentId, accumulatedContent, allToolCalls, totalInput, totalOutput, startTime);
      }

      // Context compaction check before each LLM call
      if (this.contextTracker) {
        const snapshot = this.contextTracker.snapshot(messages);
        this.onContextUpdate?.(snapshot.utilizationPercent, snapshot.level);
        if (this.contextTracker.shouldCompact(snapshot)) {
          await compact(messages, snapshot.level);
        }
      }

      // Serialize messages into a single prompt for the provider
      const serializedPrompt = serializeMessages(messages);
      const systemPrompt = messages.find((m) => m.role === "system")?.content ?? "";

      // Stream from LLM
      let turnContent = "";
      let turnUsage = { input: 0, output: 0 };

      try {
        const stream = this.llmProvider.stream(serializedPrompt, {
          model,
          systemPrompt,
          signal: abortSignal,
        });

        for await (const chunk of stream) {
          if (abortSignal?.aborted) break;

          if (chunk.content) {
            turnContent += chunk.content;
            // Emit EVERY token immediately (rule #1: zero buffering)
            this.emitStreamEvent({
              type: "agent:token",
              sessionId,
              agentId,
              token: chunk.content,
              timestamp: Date.now(),
            });
          }

          if (chunk.done && chunk.usage) {
            turnUsage = { input: chunk.usage.promptTokens, output: chunk.usage.completionTokens };
          }
        }
      } catch (e) {
        if (abortSignal?.aborted) {
          return this.makeAbortResult(sessionId, agentId, accumulatedContent + turnContent, allToolCalls, totalInput, totalOutput, startTime);
        }
        return this.emitError(sessionId, agentId, {
          type: "provider_error",
          provider: "unknown",
          cause: String(e),
        });
      }

      // Estimate tokens if provider didn't report
      if (turnUsage.input === 0) {
        turnUsage.input = Math.ceil(serializedPrompt.length / 4);
        turnUsage.output = Math.ceil(turnContent.length / 4);
      }

      totalInput += turnUsage.input;
      totalOutput += turnUsage.output;

      // Track cost
      this.tokenTracker.recordUsage(sessionId, agentId, "default", model ?? "default", turnUsage.input, turnUsage.output);

      // Check for tool calls in the response
      const toolCalls = this.toolCallHandler.parseToolCalls(turnContent);

      if (toolCalls.length === 0) {
        // No tool calls → agent is done
        accumulatedContent += this.toolCallHandler.stripToolCalls(turnContent);
        break;
      }

      // Has tool calls → execute them
      const cleanContent = this.toolCallHandler.stripToolCalls(turnContent);
      if (cleanContent) accumulatedContent += cleanContent + "\n";

      // Add assistant message with tool calls to context
      messages.push({ role: "assistant", content: turnContent });

      // Execute tools
      const toolContext: ToolExecutionContext = {
        agentId,
        sessionId,
        workingDirectory: session.getState().workingDirectory,
        abortSignal,
      };

      const toolResults = await this.toolCallHandler.handleToolCalls(toolCalls, toolContext, sessionId);
      if (toolResults.isErr()) {
        return this.emitError(sessionId, agentId, toolResults.error);
      }

      // Add tool results to messages for next iteration
      for (const result of toolResults.value) {
        messages.push(result.responseMessage);
        allToolCalls.push(...this.toolCallHandler.toRecords([result]));
      }

      // Continue loop → LLM will see tool results and respond
    }

    // Check if we hit the tool loop limit
    if (iteration >= MAX_TOOL_LOOP_ITERATIONS) {
      accumulatedContent += "\n[Reached tool call limit. Stopping.]";
    }

    const duration = Date.now() - startTime;

    const result: AgentRunResult = {
      agentId,
      success: true,
      content: accumulatedContent.trim(),
      toolCalls: allToolCalls,
      inputTokens: totalInput,
      outputTokens: totalOutput,
      duration,
    };

    this.emitStreamEvent({
      type: "agent:done",
      sessionId,
      agentId,
      finalContent: result.content,
      toolCallCount: allToolCalls.length,
      inputTokens: totalInput,
      outputTokens: totalOutput,
      duration,
      timestamp: Date.now(),
    });

    return ok(result);
  }

  private emitStreamEvent(event: StreamEvent): void {
    this.emit(event.type, event);
    this.emit("stream:event", event);
  }

  private emitError(
    sessionId: string,
    agentId: string,
    error: StreamError,
  ): Result<AgentRunResult, StreamError> {
    this.emitStreamEvent({
      type: "agent:error",
      sessionId,
      agentId,
      error: error.type,
      recoverable: true,
      timestamp: Date.now(),
    });
    return err(error);
  }

  private makeAbortResult(
    sessionId: string,
    agentId: string,
    content: string,
    toolCalls: ToolCallRecord[],
    input: number,
    output: number,
    startTime: number,
  ): Result<AgentRunResult, StreamError> {
    this.emitStreamEvent({
      type: "agent:error",
      sessionId,
      agentId,
      error: "aborted",
      recoverable: true,
      timestamp: Date.now(),
    });

    return ok({
      agentId,
      success: false,
      content: content + "\n[aborted]",
      toolCalls,
      inputTokens: input,
      outputTokens: output,
      duration: Date.now() - startTime,
      error: "Aborted by user",
    });
  }
}

/**
 * Serialize LLM messages into a single prompt string.
 * Skips the system message (passed separately via systemPrompt option).
 */
function serializeMessages(messages: LLMMessage[]): string {
  return messages
    .filter((m) => m.role !== "system")
    .map((m) => {
      const prefix = m.role === "user" ? "Human" : m.role === "assistant" ? "Assistant" : "Tool";
      return `${prefix}: ${m.content}`;
    })
    .join("\n\n");
}
