/**
 * Post-Mortem Analyst - Learns from failures and extracts lessons.
 */

import type { GraphState } from "../core/graph-state.js";
import { CONFIG } from "../core/config.js";
import type { VectorMemory } from "../core/knowledge-base.js";
import { logger } from "../core/logger.js";

function log(msg: string): void {
  if (CONFIG.verboseLogging) {
    logger.agent(msg);
  }
}

export class PostMortemAnalyst {
  constructor(private readonly vectorMemory: VectorMemory | null = null) {
    log(
      vectorMemory
        ? "🕵️ Post-Mortem Analyst initialized with Vector Memory"
        : "🕵️ Post-Mortem Analyst initialized (no Vector Memory)"
    );
  }

  async analyzeFailure(state: GraphState): Promise<string> {
    log("🔍 Analyzing team failure...");

    const botStats = state.bot_stats ?? {};
    let tasksCompleted: number;
    let tasksFailed: number;
    const deathReason = (state.death_reason ?? "Unknown") as string;
    const cyclesSurvived = (state.cycle_count ?? 0) as number;

    if (Object.keys(botStats).length > 0) {
      tasksCompleted = Object.values(botStats).reduce(
        (sum, s) => sum + ((s?.tasks_completed as number) ?? 0),
        0
      );
      tasksFailed = Object.values(botStats).reduce(
        (sum, s) => sum + ((s?.tasks_failed as number) ?? 0),
        0
      );
    } else {
      tasksCompleted = 0;
      tasksFailed = 0;
    }

    const recentEvents = (state.messages ?? []).slice(-10) as string[];
    const context = this.buildAnalysisContext({
      cyclesSurvived,
      tasksCompleted,
      tasksFailed,
      deathReason,
      recentEvents,
    });

    let lesson: string;
    try {
      lesson = await this.generateLessonWithLlm(context);
    } catch (err) {
      log(`⚠️ LLM analysis failed: ${err}. Using heuristic.`);
      lesson = this.generateHeuristicLesson(state);
    }

    log(`📚 Lesson extracted: "${lesson}"`);

    if (this.vectorMemory) {
      await this.vectorMemory.addLesson(lesson, {
        generation_id: state.generation_id,
        cycle_count: cyclesSurvived,
        tasks_completed: tasksCompleted,
        tasks_failed: tasksFailed,
        death_reason: deathReason,
      });
    }

    return lesson;
  }

  private buildAnalysisContext(params: {
    cyclesSurvived: number;
    tasksCompleted: number;
    tasksFailed: number;
    deathReason: string;
    recentEvents: string[];
  }): string {
    const { cyclesSurvived, tasksCompleted, tasksFailed, deathReason, recentEvents } = params;
    const total = tasksCompleted + tasksFailed;
    const successRate = total > 0 ? (tasksCompleted / total) * 100 : 0;

    return `TEAM FAILURE ANALYSIS

Cycles: ${cyclesSurvived}

Performance:
- Tasks Completed: ${tasksCompleted}
- Tasks Failed: ${tasksFailed}
- Success Rate: ${successRate.toFixed(1)}%

Cause of Death:
${deathReason}

Recent Events:
${recentEvents.slice(-5).map((e) => `- ${e}`).join("\n")}
`;
  }

  private async generateLessonWithLlm(context: string): Promise<string> {
    const { generate } = await import("../core/llm-client.js");
    const prompt = `You are a team analyst examining why a project/team failed.

${context}

Analyze this failure and extract ONE actionable lesson for future companies.

Your lesson must be:
1. Concise (maximum 15 words)
2. Specific and actionable
3. Directly related to the failure cause
4. Phrased as a rule or guideline

Examples of GOOD lessons:
- "Assign tasks to bots with matching role skills"
- "Require quality score above 70 before shipping"
- "Break complex goals into smaller subtasks"

Examples of BAD lessons:
- "Be more careful with money" (too vague)
- "The company should have implemented better financial controls" (too long)

Generate ONLY the lesson text (max 15 words), nothing else:`;
    let lesson = (await generate(prompt, { temperature: 0.3 })).trim().replace(/^["']|["']$/g, "");
    const words = lesson.split(/\s+/);
    if (words.length > 15) {
      lesson = words.slice(0, 15).join(" ");
      log("⚠️ Lesson truncated to 15 words");
    }
    return lesson;
  }

  private generateHeuristicLesson(state: GraphState): string {
    const botStats = state.bot_stats ?? {};
    let tasksCompleted: number;
    let tasksFailed: number;
    if (Object.keys(botStats).length > 0) {
      tasksCompleted = Object.values(botStats).reduce(
        (sum, s) => sum + ((s?.tasks_completed as number) ?? 0),
        0
      );
      tasksFailed = Object.values(botStats).reduce(
        (sum, s) => sum + ((s?.tasks_failed as number) ?? 0),
        0
      );
    } else {
      tasksCompleted = 0;
      tasksFailed = 0;
    }
    if (tasksFailed > tasksCompleted) {
      return "Assign tasks to bots with matching role skills";
    }
    return "Break complex goals into smaller subtasks";
  }

  generatePostMortemReport(state: GraphState, lesson: string): string {
    const botStats = state.bot_stats ?? {};
    let tasksCompleted: number;
    let tasksFailed: number;
    if (Object.keys(botStats).length > 0) {
      tasksCompleted = Object.values(botStats).reduce(
        (sum, s) => sum + ((s?.tasks_completed as number) ?? 0),
        0
      );
      tasksFailed = Object.values(botStats).reduce(
        (sum, s) => sum + ((s?.tasks_failed as number) ?? 0),
        0
      );
    } else {
      tasksCompleted = 0;
      tasksFailed = 0;
    }
    const total = tasksCompleted + tasksFailed;
    const successRate = total > 0 ? (tasksCompleted / total) * 100 : 0;

    return `
╔════════════════════════════════════════════════════════════════╗
║                    POST-MORTEM ANALYSIS                        ║
╚════════════════════════════════════════════════════════════════╝

Generation: ${state.generation_id ?? "Unknown"}
Cycles: ${state.cycle_count ?? 0}

Operational Metrics:
  Tasks Completed: ${tasksCompleted}
  Tasks Failed: ${tasksFailed}
  Success Rate: ${successRate.toFixed(1)}%
  Final Quality: ${state.last_quality_score ?? 0}/100

Cause of Failure:
  ${state.death_reason ?? "Unknown"}

📚 LESSON FOR FUTURE GENERATIONS:
  "${lesson}"

╚════════════════════════════════════════════════════════════════╝
`;
  }
}
