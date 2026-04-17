/**
 * LLM Agent Runner — bridges Dispatcher's AgentRunner interface to the real LLM.
 * Uses callLLMMultiTurn for tool loop: LLM can call tools, get results, continue.
 * Streams tokens in real-time via onToken callback.
 */
import type { AgentRunner } from "./dispatch-strategy.js";
import type { AgentResult, ToolCallSummary } from "./router-types.js";
import { callLLM, callLLMMultiTurn, type ToolDef, type Message } from "../engine/llm.js";
import { InjectionDetector } from "../security/injection-detector.js";
import type { DoomLoopDetector } from "../context/doom-loop-detector.js";
import type { ToolOutputHandler } from "../context/tool-output-handler.js";
import type { ContextTracker } from "../context/context-tracker.js";
import type { ContextLevel } from "../context/types.js";
import { compact } from "../context/compaction.js";
import { getProjectContext } from "../context/project-context.js";
import { debugLog, isDebugEnabled, truncateStr, TRUNCATION } from "../debug/logger.js";

export interface ToolCallDetails {
  executionId: string;
  inputSummary?: string;
  duration?: number;
  outputSummary?: string;
  success?: boolean;
  diff?: import("../utils/diff.js").DiffResult;
  /** Shell exit code for shell_exec (and tools that wrap it). */
  exitCode?: number;
  /** First ~200 chars of stderr for shell_exec. */
  stderrHead?: string;
}

export interface LLMAgentRunnerOptions {
  onToken?: (agentId: string, token: string) => void;
  onToolCall?: (agentId: string, toolName: string, status: string, details?: ToolCallDetails) => void;
  /** Get tool schemas for an agent's tool list (text-based fallback). */
  getToolSchemas?: (toolNames: string[]) => ToolDef[];
  /** Get native tool definitions for API function calling. */
  getNativeTools?: (toolNames: string[]) => import("../providers/stream-types.js").NativeToolDefinition[];
  /**
   * Execute a tool and return the result as a string, optionally with
   * structured metadata. `text` is what goes to the LLM; the other
   * fields are internal telemetry used by downstream consumers
   * (sprint validator, classifier).
   */
  executeTool?: (toolName: string, args: Record<string, unknown>) => Promise<
    | string
    | {
        text: string;
        diff?: import("../utils/diff.js").DiffResult;
        success?: boolean;
        exitCode?: number;
        stderrHead?: string;
      }
  >;
  /** Doom-loop detector — prevents repeated identical tool calls. */
  doomLoopDetector?: DoomLoopDetector;
  /** Tool output handler — summarizes large outputs and offloads to scratch files. */
  toolOutputHandler?: ToolOutputHandler;
  /** Context tracker — monitors token utilization and triggers compaction. */
  contextTracker?: ContextTracker;
  /** Called when context level changes (for status bar updates). */
  onContextUpdate?: (utilization: number, level: ContextLevel) => void;
  /** Optional memory context to inject into system prompts (retrieved from success patterns, decisions, etc.). */
  getMemoryContext?: (prompt: string) => Promise<string | null>;
}

/**
 * Creates an AgentRunner backed by the real LLM provider.
 * When tools are available, uses callLLMMultiTurn for the tool loop.
 * When no tools, uses callLLM for simple streaming.
 */
export function createLLMAgentRunner(opts: LLMAgentRunnerOptions = {}): AgentRunner {
  const {
    onToken, onToolCall, getToolSchemas, getNativeTools, executeTool,
    doomLoopDetector, toolOutputHandler, contextTracker, onContextUpdate,
    getMemoryContext,
  } = opts;
  const injectionDetector = new InjectionDetector();

  return {
    async run(
      agentId: string,
      prompt: string,
      tools: string[],
      context: {
        systemPrompt: string;
        sessionHistory?: Array<{ role: string; content: string }>;
        model?: string;
      },
      signal?: AbortSignal,
    ): Promise<AgentResult> {
      if (signal?.aborted) {
        return makeResult(agentId, false, "", "Aborted");
      }

      // Get tool schemas if available
      const toolDefs = (tools.length > 0 && getToolSchemas) ? getToolSchemas(tools) : [];
      const nativeToolDefs = (tools.length > 0 && getNativeTools) ? getNativeTools(tools) : [];
      const hasTools = (toolDefs.length > 0 || nativeToolDefs.length > 0) && executeTool;

      // Enhance system prompt with project context, tool info, and working directory
      let systemPrompt = context.systemPrompt;

      // Inject project context (CLAUDE.md / README.md + detected project type)
      const projectContext = getProjectContext(process.cwd());
      if (projectContext) {
        systemPrompt += projectContext;
      }

      // Inject memory context (success patterns, decisions) if available
      if (getMemoryContext) {
        try {
          const memCtx = await getMemoryContext(prompt);
          if (memCtx) {
            systemPrompt += `\n\n${memCtx}`;
            if (isDebugEnabled()) {
              debugLog("info", "llm", "llm:memory_context", {
                data: {
                  agentId,
                  memoryContextPreview: truncateStr(memCtx, 300),
                  memoryContextLength: memCtx.length,
                },
              });
            }
          }
        } catch {
          // Memory retrieval failure is non-fatal
        }
      }

      if (hasTools) {
        const toolList = toolDefs.map((t) => `- ${t.name}: ${t.description}`).join("\n");
        systemPrompt += `\n\nTools:\n${toolList}\n\nWorking directory: ${process.cwd()}\nUse tools directly. Never ask the user to paste code or run commands — do it yourself.\nWhen you need multiple independent operations (reading files, listing directories, writing files that don't depend on each other), request them all in a single response.`;
      }

      try {
        const allToolCalls: ToolCallSummary[] = [];
        let toolCallCounter = 0;

        // Build prior messages from session history (user/assistant only)
        const priorMessages: Message[] = (context.sessionHistory ?? [])
          .filter(m => m.role === "user" || m.role === "assistant")
          .map(m => ({ role: m.role as "user" | "assistant", content: m.content }));

        // Debug: log agent call params
          if (isDebugEnabled()) {
            debugLog("info", "llm", "llm:agent_call", {
              data: {
                agentId,
                model: context.model,
                hasTools: !!hasTools,
                toolCount: nativeToolDefs.length || toolDefs.length,
                systemPrompt: truncateStr(systemPrompt, TRUNCATION.systemPrompt),
                systemPromptLength: systemPrompt.length,
                userMessage: truncateStr(prompt, TRUNCATION.userMessage),
                userMessageLength: prompt.length,
                priorMessageCount: priorMessages.length,
              },
            });
          }

          if (hasTools) {
          // Multi-turn with tool loop
          const response = await callLLMMultiTurn({
            model: context.model,
            systemPrompt,
            userMessage: prompt,
            priorMessages,
            tools: toolDefs,
            nativeTools: nativeToolDefs,
            handleTool: async (name, args) => {
              const execId = `tc_${++toolCallCounter}`;
              const inputSummary = formatInputSummary(name, args);
              const startTime = Date.now();

              // Doom-loop detection: check before executing
              if (doomLoopDetector) {
                const verdict = doomLoopDetector.track(agentId, name, args);
                if (verdict.action === "block") {
                  onToolCall?.(agentId, name, "blocked", { executionId: execId, inputSummary });
                  allToolCalls.push({ tool: name, input: JSON.stringify(args), output: verdict.message, duration: 0, success: false });
                  return verdict.message;
                }
                // Warn verdict: we'll append the hint after getting the result
                if (verdict.action === "warn") {
                  onToolCall?.(agentId, name, "running", { executionId: execId, inputSummary });
                  try {
                    const rawResult = await executeTool!(name, args);
                    let result: string;
                    let diff: import("../utils/diff.js").DiffResult | undefined;
                    let callSuccess = true;
                    let exitCode: number | undefined;
                    let stderrHead: string | undefined;
                    if (typeof rawResult === "object" && rawResult !== null) {
                      result = rawResult.text;
                      diff = rawResult.diff;
                      if (typeof rawResult.success === "boolean") callSuccess = rawResult.success;
                      exitCode = rawResult.exitCode;
                      stderrHead = rawResult.stderrHead;
                    } else {
                      result = rawResult;
                    }
                    const alerts = injectionDetector.detect(result, "tool_output");
                    if (alerts.some((a) => a.severity === "critical")) {
                      result = "[BLOCKED: suspicious content detected in tool output]";
                    }
                    if (toolOutputHandler && result.length > 4000) {
                      const summarized = await toolOutputHandler.processToolOutput(name, result);
                      result = summarized.content;
                    }
                    const duration = Date.now() - startTime;
                    onToolCall?.(agentId, name, callSuccess ? "completed" : "failed", { executionId: execId, duration, outputSummary: result.slice(0, 200), success: callSuccess, diff, exitCode, stderrHead });
                    allToolCalls.push({ tool: name, input: JSON.stringify(args), output: result.slice(0, 200), duration, success: callSuccess, exitCode, stderrHead });
                    return result + "\n\n" + verdict.message;
                  } catch (e) {
                    const duration = Date.now() - startTime;
                    const errMsg = e instanceof Error ? e.message : String(e);
                    onToolCall?.(agentId, name, "failed", { executionId: execId, duration, outputSummary: errMsg, success: false });
                    allToolCalls.push({ tool: name, input: JSON.stringify(args), output: errMsg, duration, success: false });
                    return `Error: ${errMsg}`;
                  }
                }
              }

              onToolCall?.(agentId, name, "running", { executionId: execId, inputSummary });
              try {
                const rawResult = await executeTool!(name, args);
                let result: string;
                let diff: import("../utils/diff.js").DiffResult | undefined;
                let callSuccess = true;
                let exitCode: number | undefined;
                let stderrHead: string | undefined;
                if (typeof rawResult === "object" && rawResult !== null) {
                  result = rawResult.text;
                  diff = rawResult.diff;
                  if (typeof rawResult.success === "boolean") callSuccess = rawResult.success;
                  exitCode = rawResult.exitCode;
                  stderrHead = rawResult.stderrHead;
                } else {
                  result = rawResult;
                }

                // Scan tool output for injection attempts before sending to LLM
                const alerts = injectionDetector.detect(result, "tool_output");
                if (alerts.some((a) => a.severity === "critical")) {
                  result = "[BLOCKED: suspicious content detected in tool output]";
                }

                // Summarize large tool outputs
                if (toolOutputHandler && result.length > 4000) {
                  const summarized = await toolOutputHandler.processToolOutput(name, result);
                  result = summarized.content;
                }

                const duration = Date.now() - startTime;
                onToolCall?.(agentId, name, callSuccess ? "completed" : "failed", { executionId: execId, duration, outputSummary: result.slice(0, 200), success: callSuccess, diff, exitCode, stderrHead });
                allToolCalls.push({ tool: name, input: JSON.stringify(args), output: result.slice(0, 200), duration, success: callSuccess, exitCode, stderrHead });
                return result;
              } catch (e) {
                const duration = Date.now() - startTime;
                const msg = e instanceof Error ? e.message : String(e);
                onToolCall?.(agentId, name, "failed", { executionId: execId, duration, outputSummary: msg, success: false });
                allToolCalls.push({ tool: name, input: JSON.stringify(args), output: msg, duration, success: false });
                return `Error: ${msg}`;
              }
            },
            // Context compaction before each LLM turn
            beforeTurn: contextTracker ? async (messages: Message[]) => {
              const snapshot = contextTracker.snapshot(messages);
              onContextUpdate?.(snapshot.utilizationPercent, snapshot.level);
              if (contextTracker.shouldCompact(snapshot)) {
                await compact(messages, snapshot.level);
              }
            } : undefined,
            onChunk: (token) => onToken?.(agentId, token),
            // Tool status is already emitted by handleTool above — don't duplicate
            onToolCall: undefined,
            onToolResult: undefined,
            signal,
            maxTurns: 10,
          });

          return makeResult(agentId, true, response.text, undefined, response.usage, allToolCalls);
        }

        // Simple single-turn (no tools) — use multi-turn if history exists
        if (priorMessages.length > 0) {
          const response = await callLLMMultiTurn({
            model: context.model,
            systemPrompt,
            userMessage: prompt,
            priorMessages,
            handleTool: async () => "",
            onChunk: (token) => onToken?.(agentId, token),
            signal,
            maxTurns: 1,
          });
          return makeResult(agentId, true, response.text, undefined, response.usage);
        }

        const response = await callLLM(prompt, {
          model: context.model,
          systemPrompt,
          signal,
          onChunk: (token) => onToken?.(agentId, token),
        });

        return makeResult(agentId, true, response.text, undefined, response.usage);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return makeResult(agentId, false, "", msg);
      }
    },
  };
}

// Re-export from shared formatters
import { formatInputSummary } from "../utils/formatters.js";

function makeResult(
  agentId: string,
  success: boolean,
  response: string,
  error?: string,
  usage?: { input: number; output: number },
  toolCalls?: ToolCallSummary[],
): AgentResult {
  return {
    agentId,
    success,
    response,
    toolCalls: toolCalls ?? [],
    duration: 0,
    inputTokens: usage?.input ?? 0,
    outputTokens: usage?.output ?? 0,
    error,
  };
}
