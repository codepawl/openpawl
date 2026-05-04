/**
 * LLM Agent Runner — bridges Dispatcher's AgentRunner interface to the real LLM.
 * Builds a system prompt (project context, optional memory hints, tool list)
 * and delegates the multi-turn tool loop to {@link runAgentTurn}.
 */
import type { AgentRunner } from "./dispatch-strategy.js";
import type { AgentResult } from "./router-types.js";
import { type ToolDef } from "../engine/llm.js";
import { InjectionDetector } from "../security/injection-detector.js";
import type { DoomLoopDetector } from "../context/doom-loop-detector.js";
import type { ToolOutputHandler } from "../context/tool-output-handler.js";
import type { ContextTracker } from "../context/context-tracker.js";
import type { ContextLevel } from "../context/types.js";
import { getProjectContext } from "../context/project-context.js";
import { debugLog, isDebugEnabled, truncateStr, TRUNCATION } from "../debug/logger.js";
import { runAgentTurn, type ToolExecutor } from "./agent-turn.js";

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
  executeTool?: ToolExecutor;
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
 * When tools are available, uses {@link runAgentTurn} for the tool loop.
 * When no tools, uses runAgentTurn in single-turn mode (no handleTool).
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

      const hasTools = (toolDefs.length > 0 || nativeToolDefs.length > 0) && !!executeTool;
      if (hasTools) {
        const toolList = toolDefs.map((t) => `- ${t.name}: ${t.description}`).join("\n");
        systemPrompt += `\n\nTools:\n${toolList}\n\nWorking directory: ${process.cwd()}\nUse tools directly. Never ask the user to paste code or run commands — do it yourself.\nWhen you need multiple independent operations (reading files, listing directories, writing files that don't depend on each other), request them all in a single response.`;
      }

      const priorMessages = (context.sessionHistory ?? [])
        .filter(m => m.role === "user" || m.role === "assistant")
        .map(m => ({ role: m.role as "user" | "assistant", content: m.content }));

      if (isDebugEnabled()) {
        debugLog("info", "llm", "llm:agent_call", {
          data: {
            agentId,
            model: context.model,
            hasTools,
            toolCount: nativeToolDefs.length || toolDefs.length,
            systemPrompt: truncateStr(systemPrompt, TRUNCATION.systemPrompt),
            systemPromptLength: systemPrompt.length,
            userMessage: truncateStr(prompt, TRUNCATION.userMessage),
            userMessageLength: prompt.length,
            priorMessageCount: priorMessages.length,
          },
        });
      }

      try {
        const result = await runAgentTurn({
          agentId,
          systemPrompt,
          userMessage: prompt,
          priorMessages,
          toolDefs: hasTools ? toolDefs : undefined,
          nativeToolDefs: hasTools ? nativeToolDefs : undefined,
          executeTool: hasTools ? executeTool : undefined,
          doomLoopDetector,
          toolOutputHandler,
          injectionDetector,
          contextTracker,
          onToken,
          onToolCall,
          onContextUpdate,
          model: context.model,
          maxTurns: 10,
          signal,
        });
        return makeResult(agentId, true, result.text, undefined, result.usage, result.toolCalls);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return makeResult(agentId, false, "", msg);
      }
    },
  };
}

import type { ToolCallSummary } from "./router-types.js";

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
