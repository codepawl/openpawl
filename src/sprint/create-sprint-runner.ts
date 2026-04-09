/**
 * Factory that creates a SprintRunner subclass wired to the real LLM
 * via callLLMMultiTurn. Keeps SprintRunner itself testable (no LLM dep).
 */
import { SprintRunner } from "./sprint-runner.js";
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
        systemPrompt += `\n\nTools:\n${toolList}\n\nWorking directory: ${process.cwd()}\nUse tools directly. Never ask the user to paste code or run commands.`;
      }

      const response = await callLLMMultiTurn({
        systemPrompt,
        userMessage: runOpts.prompt,
        nativeTools: hasTools ? nativeTools : undefined,
        handleTool: async (name, args) => {
          if (!toolExecutor) return "Tool execution not available";

          this.emit("sprint:agent:tool", { agent: agentName, tool: name, args });

          const result = await toolExecutor.execute(name, args, {
            agentId: agentName,
            sessionId: "sprint",
            workingDirectory: process.cwd(),
            abortSignal: runOpts.signal,
          });

          if (result.isOk()) {
            return result.value.summary;
          }
          return `Error: ${result.error.type} — ${result.error.toolName}`;
        },
        onChunk: (token) => {
          this.emit("sprint:agent:token", { agent: agentName, token });
        },
        signal: runOpts.signal,
        maxTurns: 10,
      });

      return response.text;
    }
  })(agents);
}
