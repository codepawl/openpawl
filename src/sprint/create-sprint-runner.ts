/**
 * Factory that creates a SprintRunner subclass wired to the real LLM
 * via callLLMMultiTurn. Keeps SprintRunner itself testable (no LLM dep).
 */
import { SprintRunner } from "./sprint-runner.js";
import { SprintEvent } from "../router/event-types.js";
import { callLLMMultiTurn } from "../engine/llm.js";
import { getProjectContext } from "../context/project-context.js";
import type { AgentRegistry } from "../router/agent-registry.js";
import type { ToolRegistry } from "../tools/registry.js";
import type { ToolExecutor } from "../tools/executor.js";

export interface CreateSprintRunnerOptions {
  agents: AgentRegistry;
  toolRegistry?: ToolRegistry;
  toolExecutor?: ToolExecutor;
}

export function createSprintRunner(opts: CreateSprintRunnerOptions): SprintRunner {
  const { agents, toolRegistry, toolExecutor } = opts;

  return new (class extends SprintRunner {
    protected override async runAgent(
      agentName: string,
      runOpts: { prompt: string; signal: AbortSignal },
    ): Promise<string> {
      const agent = this.agents.get(agentName);
      if (!agent) {
        throw new Error(`Unknown agent: ${agentName}`);
      }

      // Build system prompt
      let systemPrompt = agent.systemPrompt;
      const projectContext = getProjectContext(process.cwd());
      if (projectContext) {
        systemPrompt += projectContext;
      }

      // Get native tools if registries available
      const nativeTools =
        toolRegistry && agent.defaultTools.length > 0
          ? toolRegistry.exportForAPI(agent.defaultTools)
          : undefined;

      const hasTools = nativeTools && nativeTools.length > 0 && toolExecutor;

      if (hasTools) {
        const toolList = nativeTools
          .map((t) => `- ${t.function.name}: ${t.function.description}`)
          .join("\n");
        systemPrompt += `\n\nTools:\n${toolList}\n\nWorking directory: ${process.cwd()}\nUse tools directly. Never ask the user to paste code or run commands.\nWhen you need multiple independent operations (reading files, listing directories, writing files that don't depend on each other), request them all in a single response.`;
      }

      const response = await callLLMMultiTurn({
        systemPrompt,
        userMessage: runOpts.prompt,
        nativeTools: hasTools ? nativeTools : undefined,
        handleTool: async (name, args) => {
          if (!toolExecutor) return "Tool execution not available";

          const execId = `sprint_tc_${Date.now()}`;
          const inputSummary = `${name}(${JSON.stringify(args).slice(0, 100)})`;
          const startTime = Date.now();

          this.recordToolCall(name);
          this.emit(SprintEvent.AgentTool, {
            agentName,
            toolName: name,
            status: "running",
            details: { executionId: execId, inputSummary },
          });

          const result = await toolExecutor.execute(name, args, {
            agentId: agentName,
            sessionId: "sprint",
            workingDirectory: process.cwd(),
            abortSignal: runOpts.signal,
          });

          const duration = Date.now() - startTime;

          if (result.isOk()) {
            this.emit(SprintEvent.AgentTool, {
              agentName,
              toolName: name,
              status: "completed",
              details: { executionId: execId, duration, outputSummary: result.value.summary.slice(0, 200), success: true },
            });
            return result.value.summary;
          }

          const errMsg = `${result.error.type} — ${result.error.toolName}`;
          this.emit(SprintEvent.AgentTool, {
            agentName,
            toolName: name,
            status: "failed",
            details: { executionId: execId, duration, outputSummary: errMsg, success: false },
          });
          return `Error: ${errMsg}`;
        },
        onChunk: (token) => {
          this.emit(SprintEvent.AgentToken, { agentName, token });
        },
        signal: runOpts.signal,
        maxTurns: 10,
      });

      return response.text;
    }
  })(agents);
}
