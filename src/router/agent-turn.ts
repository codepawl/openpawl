/**
 * runAgentTurn — shared multi-turn tool loop used by both the solo
 * `createLLMAgentRunner` path and the crew `runSubagent` path.
 *
 * Extracted from llm-agent-runner.ts in support of spec §5.6 (subagent
 * invocation contract). The helper handles the parts every caller needs:
 *
 *   - drive `callLLMMultiTurn` with a pre-built system prompt
 *   - wrap `executeTool` with doom-loop detection, injection scanning,
 *     large-output summarization, and telemetry
 *   - track every tool call into a {@link ToolCallSummary} list
 *   - emit `onToolCall` lifecycle events (running / completed / failed /
 *     blocked) with structured details
 *
 * Behavior decisions kept consistent with the legacy solo path so
 * regressions are unlikely:
 *   - Critical injection alerts replace the result with a `[BLOCKED ...]`
 *     stub before it reaches the LLM.
 *   - Outputs longer than 4000 chars are summarized via
 *     `ToolOutputHandler` if one is supplied.
 *   - Doom-loop "warn" still runs the tool, then appends the verdict
 *     hint to the result for the LLM.
 *   - `onContextUpdate` fires from the optional `beforeTurn` snapshot.
 */

import { compact } from "../context/compaction.js";
import type { ContextTracker } from "../context/context-tracker.js";
import type { DoomLoopDetector } from "../context/doom-loop-detector.js";
import type { ToolOutputHandler } from "../context/tool-output-handler.js";
import type { ContextLevel } from "../context/types.js";
import { callLLMMultiTurn, type Message, type ToolDef } from "../engine/llm.js";
import type { NativeToolDefinition } from "../providers/stream-types.js";
import type { DiffResult } from "../utils/diff.js";
import type { ToolCallSummary } from "./router-types.js";
import type { ToolCallDetails } from "./llm-agent-runner.js";

import { InjectionDetector } from "../security/injection-detector.js";
import { formatInputSummary } from "../utils/formatters.js";

export type ToolExecResult =
  | string
  | {
      text: string;
      diff?: DiffResult;
      success?: boolean;
      exitCode?: number;
      stderrHead?: string;
    };

export type ToolExecutor = (
  name: string,
  args: Record<string, unknown>,
) => Promise<ToolExecResult>;

export interface RunAgentTurnArgs {
  agentId: string;
  systemPrompt: string;
  userMessage: string;
  priorMessages?: Message[];
  toolDefs?: ToolDef[];
  nativeToolDefs?: NativeToolDefinition[];
  executeTool?: ToolExecutor;
  /** Optional pre-flight gate. Returning a string short-circuits the call and that string becomes the tool result. */
  preToolHook?: (
    name: string,
    args: Record<string, unknown>,
  ) => string | null | Promise<string | null>;
  doomLoopDetector?: DoomLoopDetector;
  toolOutputHandler?: ToolOutputHandler;
  injectionDetector?: InjectionDetector;
  contextTracker?: ContextTracker;
  onToken?: (agentId: string, token: string) => void;
  onToolCall?: (
    agentId: string,
    toolName: string,
    status: string,
    details?: ToolCallDetails,
  ) => void;
  onContextUpdate?: (utilization: number, level: ContextLevel) => void;
  model?: string;
  maxTurns?: number;
  temperature?: number;
  signal?: AbortSignal;
  /** Caller tag forwarded to engine profiling. */
  source?: string;
}

export interface RunAgentTurnResult {
  text: string;
  toolCalls: ToolCallSummary[];
  usage: { input: number; output: number };
}

const DEFAULT_MAX_TURNS = 10;
const LARGE_OUTPUT_BYTES = 4000;
const OUTPUT_SUMMARY_PREVIEW = 200;

/**
 * Run one full multi-turn agent invocation. Caller has already assembled
 * `systemPrompt` (project context, memory hints, tool list, etc.) and
 * has selected the `executeTool` implementation appropriate for the
 * caller's trust boundary (raw tool registry for solo, gated + locked
 * wrapper for crew).
 */
export async function runAgentTurn(
  args: RunAgentTurnArgs,
): Promise<RunAgentTurnResult> {
  const {
    agentId,
    systemPrompt,
    userMessage,
    priorMessages,
    toolDefs,
    nativeToolDefs,
    executeTool,
    preToolHook,
    doomLoopDetector,
    toolOutputHandler,
    contextTracker,
    onToken,
    onToolCall,
    onContextUpdate,
    model,
    maxTurns,
    temperature,
    signal,
    source,
  } = args;

  const injectionDetector = args.injectionDetector ?? new InjectionDetector();
  const allToolCalls: ToolCallSummary[] = [];
  let toolCallCounter = 0;

  const hasTools =
    !!executeTool &&
    ((toolDefs && toolDefs.length > 0) || (nativeToolDefs && nativeToolDefs.length > 0));

  if (!hasTools) {
    const response = await callLLMMultiTurn({
      model,
      systemPrompt,
      userMessage,
      priorMessages,
      handleTool: async () => "",
      onChunk: (token) => onToken?.(agentId, token),
      signal,
      maxTurns: 1,
      source,
    });
    return {
      text: response.text,
      toolCalls: [],
      usage: response.usage,
    };
  }

  const handleToolWithTelemetry = async (
    name: string,
    rawArgs: Record<string, unknown>,
  ): Promise<string> => {
    const execId = `tc_${++toolCallCounter}`;
    const inputSummary = formatInputSummary(name, rawArgs);
    const startTime = Date.now();

    if (preToolHook) {
      const overrideResult = await preToolHook(name, rawArgs);
      if (overrideResult !== null) {
        const duration = Date.now() - startTime;
        onToolCall?.(agentId, name, "blocked", {
          executionId: execId,
          inputSummary,
          duration,
          outputSummary: overrideResult.slice(0, OUTPUT_SUMMARY_PREVIEW),
          success: false,
        });
        allToolCalls.push({
          tool: name,
          input: JSON.stringify(rawArgs),
          output: overrideResult.slice(0, OUTPUT_SUMMARY_PREVIEW),
          duration,
          success: false,
        });
        return overrideResult;
      }
    }

    if (doomLoopDetector) {
      const verdict = doomLoopDetector.track(agentId, name, rawArgs);
      if (verdict.action === "block") {
        onToolCall?.(agentId, name, "blocked", { executionId: execId, inputSummary });
        allToolCalls.push({
          tool: name,
          input: JSON.stringify(rawArgs),
          output: verdict.message,
          duration: 0,
          success: false,
        });
        return verdict.message;
      }
      if (verdict.action === "warn") {
        onToolCall?.(agentId, name, "running", { executionId: execId, inputSummary });
        try {
          const result = await runAndPostProcess(name, rawArgs);
          const duration = Date.now() - startTime;
          onToolCall?.(agentId, name, result.success ? "completed" : "failed", {
            executionId: execId,
            duration,
            outputSummary: result.text.slice(0, OUTPUT_SUMMARY_PREVIEW),
            success: result.success,
            diff: result.diff,
            exitCode: result.exitCode,
            stderrHead: result.stderrHead,
          });
          allToolCalls.push({
            tool: name,
            input: JSON.stringify(rawArgs),
            output: result.text.slice(0, OUTPUT_SUMMARY_PREVIEW),
            duration,
            success: result.success,
            exitCode: result.exitCode,
            stderrHead: result.stderrHead,
          });
          return result.text + "\n\n" + verdict.message;
        } catch (e) {
          const duration = Date.now() - startTime;
          const errMsg = e instanceof Error ? e.message : String(e);
          onToolCall?.(agentId, name, "failed", {
            executionId: execId,
            duration,
            outputSummary: errMsg,
            success: false,
          });
          allToolCalls.push({
            tool: name,
            input: JSON.stringify(rawArgs),
            output: errMsg,
            duration,
            success: false,
          });
          return `Error: ${errMsg}`;
        }
      }
    }

    onToolCall?.(agentId, name, "running", { executionId: execId, inputSummary });
    try {
      const result = await runAndPostProcess(name, rawArgs);
      const duration = Date.now() - startTime;
      onToolCall?.(agentId, name, result.success ? "completed" : "failed", {
        executionId: execId,
        duration,
        outputSummary: result.text.slice(0, OUTPUT_SUMMARY_PREVIEW),
        success: result.success,
        diff: result.diff,
        exitCode: result.exitCode,
        stderrHead: result.stderrHead,
      });
      allToolCalls.push({
        tool: name,
        input: JSON.stringify(rawArgs),
        output: result.text.slice(0, OUTPUT_SUMMARY_PREVIEW),
        duration,
        success: result.success,
        exitCode: result.exitCode,
        stderrHead: result.stderrHead,
      });
      return result.text;
    } catch (e) {
      const duration = Date.now() - startTime;
      const msg = e instanceof Error ? e.message : String(e);
      onToolCall?.(agentId, name, "failed", {
        executionId: execId,
        duration,
        outputSummary: msg,
        success: false,
      });
      allToolCalls.push({
        tool: name,
        input: JSON.stringify(rawArgs),
        output: msg,
        duration,
        success: false,
      });
      return `Error: ${msg}`;
    }
  };

  async function runAndPostProcess(
    name: string,
    rawArgs: Record<string, unknown>,
  ): Promise<{
    text: string;
    diff?: DiffResult;
    success: boolean;
    exitCode?: number;
    stderrHead?: string;
  }> {
    const raw = await executeTool!(name, rawArgs);
    let text: string;
    let diff: DiffResult | undefined;
    let success = true;
    let exitCode: number | undefined;
    let stderrHead: string | undefined;
    if (typeof raw === "object" && raw !== null) {
      text = raw.text;
      diff = raw.diff;
      if (typeof raw.success === "boolean") success = raw.success;
      exitCode = raw.exitCode;
      stderrHead = raw.stderrHead;
    } else {
      text = raw;
    }
    const alerts = injectionDetector.detect(text, "tool_output");
    if (alerts.some((a) => a.severity === "critical")) {
      text = "[BLOCKED: suspicious content detected in tool output]";
    }
    if (toolOutputHandler && text.length > LARGE_OUTPUT_BYTES) {
      const summarized = await toolOutputHandler.processToolOutput(name, text);
      text = summarized.content;
    }
    return { text, diff, success, exitCode, stderrHead };
  }

  const response = await callLLMMultiTurn({
    model,
    systemPrompt,
    userMessage,
    priorMessages,
    tools: toolDefs,
    nativeTools: nativeToolDefs,
    handleTool: handleToolWithTelemetry,
    beforeTurn: contextTracker
      ? async (messages: Message[]) => {
          const snapshot = contextTracker.snapshot(messages);
          onContextUpdate?.(snapshot.utilizationPercent, snapshot.level);
          if (contextTracker.shouldCompact(snapshot)) {
            await compact(messages, snapshot.level);
          }
        }
      : undefined,
    onChunk: (token) => onToken?.(agentId, token),
    onToolCall: undefined,
    onToolResult: undefined,
    signal,
    maxTurns: maxTurns ?? DEFAULT_MAX_TURNS,
    temperature,
    source,
  });

  return {
    text: response.text,
    toolCalls: allToolCalls,
    usage: response.usage,
  };
}
