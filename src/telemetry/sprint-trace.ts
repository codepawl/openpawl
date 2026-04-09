import { getLangfuse } from "./langfuse.js";
import type { Langfuse } from "langfuse";

export class SprintTrace {
  private trace: ReturnType<Langfuse["trace"]> | null = null;

  constructor(
    private readonly sprintId: string,
    private readonly goal: string,
    private readonly userId?: string,
  ) {
    const lf = getLangfuse();
    if (!lf) return;

    this.trace = lf.trace({
      id: sprintId,
      name: "openpawl-sprint",
      input: { goal },
      userId,
      tags: ["sprint"],
    });
  }

  agentSpan(agentRole: string, taskId: string) {
    return this.trace?.span({
      name: `agent:${agentRole}`,
      input: { taskId, agentRole },
      metadata: { taskId },
    }) ?? null;
  }

  end(output: {
    success: boolean;
    tasksCompleted: number;
    totalTokens?: number;
    durationMs: number;
  }) {
    this.trace?.update({
      output,
      tags: output.success ? ["sprint", "success"] : ["sprint", "failed"],
    });
  }
}
