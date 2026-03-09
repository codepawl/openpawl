/**
 * Coordinator Agent - Goal decomposition and task routing.
 */

import type { GraphState } from "../core/graph-state.js";
import { getRoleTemplate } from "../core/bot-definitions.js";
import { CONFIG } from "../core/config.js";
import { generate } from "../core/llm-client.js";
import { getSessionTemperature } from "../core/config.js";
import { pushSessionWarning } from "../core/session-warnings.js";
import { logger } from "../core/logger.js";
import { parseLlmJson } from "../utils/jsonExtractor.js";

function log(msg: string): void {
  if (CONFIG.verboseLogging) {
    logger.agent(msg);
  }
}

export class CoordinatorAgent {
  private taskCounter = 0;

  constructor() {
    log("🎯 Coordinator Agent initialized");
  }

  private nextTaskId(): string {
    this.taskCounter += 1;
    return `TASK-${String(this.taskCounter).padStart(3, "0")}`;
  }

  private async decomposeGoalWithLlm(
    goal: string,
    team: Record<string, unknown>[],
    ancestralLessons: string[] = []
  ): Promise<Array<{ description: string; assigned_to: string; worker_tier: "light" | "heavy" }>> {
    const roleSummary: string[] = [];
    const rosterAgg = new Map<string, { count: number; descriptions: Set<string> }>();

    for (const bot of team) {
      const bid = (bot?.id as string) ?? "?";
      const rid = (bot?.role_id as string) ?? "?";
      const name = (bot?.name as string) ?? bid;
      const template = getRoleTemplate(rid);
      const skills = template?.task_types ?? [];

      const traits = (bot?.traits as Record<string, unknown> | undefined) ?? undefined;
      const roleLabelRaw = (traits?.role_label as string | undefined)?.trim();
      const roleDescRaw = (traits?.role_description as string | undefined)?.trim();
      const roleLabel = roleLabelRaw || template?.name || rid;
      const roleDesc = roleDescRaw || "";

      const cur = rosterAgg.get(roleLabel) ?? { count: 0, descriptions: new Set<string>() };
      cur.count += 1;
      if (roleDesc) cur.descriptions.add(roleDesc);
      rosterAgg.set(roleLabel, cur);

      roleSummary.push(`- ${name} (id=${bid}): role=${roleLabel}, skills=${skills.join(", ")}`);
    }

    const rosterLines =
      rosterAgg.size > 0
        ? Array.from(rosterAgg.entries()).map(([role, v]) => {
            const desc =
              v.descriptions.size > 0 ? ` — ${Array.from(v.descriptions).join(" / ")}` : "";
            return `- ${role} x${v.count}${desc}`;
          })
        : [];

    const lessonsBlock =
      ancestralLessons.length > 0
        ? `

Standard Operating Procedures (lessons from prior runs — apply these):
${ancestralLessons.map((l, i) => `  ${i + 1}. ${l}`).join("\n")}
`
        : "";

    const prompt = `You are a team coordinator. Break this goal into 3-6 concrete subtasks.
Assign each subtask to ONE team member based on their role and skills.

You are confined to a strict workspace directory. Treat this workspace as your root directory.
Do not attempt to read or write files outside of it.
${lessonsBlock}

Goal: ${goal}

You are managing a team of ${team.length} bots.
Your roster:
${rosterLines.join("\n")}

Team:
${roleSummary.join("\n")}

Output a JSON array. Each element MUST be an object with exactly three keys:
- "description" (string): the task description
- "assigned_to" (string): bot id (e.g. bot_0, bot_1)
- "worker_tier" (string): MUST be either "light" or "heavy". Use "heavy" only when the task explicitly requires UI automation, browser control, or complex GUI interaction; otherwise use "light".

You must include worker_tier for every task. No other keys. No explanations, only the JSON array.

Example:
[{"description": "Implement login API", "assigned_to": "bot_0", "worker_tier": "light"}, {"description": "Open browser and click Login button", "assigned_to": "bot_1", "worker_tier": "heavy"}]`;

    try {
      const raw = await generate(prompt, { temperature: getSessionTemperature() });
      const items = parseLlmJson<
        Array<{ description?: string; assigned_to?: string; worker_tier?: string }> | {
          description?: string;
          assigned_to?: string;
          worker_tier?: string;
        }
      >(raw);
      const list = Array.isArray(items) ? items : [items];
      return list.map((item) => {
        const rawTier = typeof item.worker_tier === "string" ? item.worker_tier.trim().toLowerCase() : "";
        const tier = rawTier === "heavy" ? "heavy" : "light";
        if (rawTier !== "" && rawTier !== "light" && rawTier !== "heavy") {
          log(`Invalid worker_tier "${item.worker_tier}" for task, defaulting to "light"`);
        }
        return {
          description: String(item.description ?? ""),
          assigned_to: String(item.assigned_to ?? team[0]?.id ?? "bot_0"),
          worker_tier: tier,
        };
      });
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      pushSessionWarning(`LLM decomposition failed (${errMsg}). Used fallback: single task from goal.`);
      const extra =
        CONFIG.verboseLogging
          ? ` goalChars=${goal.length} teamSize=${team.length} lessons=${ancestralLessons.length} timeoutMs=${CONFIG.llmTimeoutMs}`
          : "";
      log(`⚠️ LLM decomposition failed: ${errMsg}.${extra} Using fallback.`);
      return [
        {
          description: goal.slice(0, 200),
          assigned_to: (team[0]?.id as string) ?? "bot_0",
          worker_tier: "light" as const,
        },
      ];
    }
  }

  async coordinateNode(state: GraphState): Promise<Partial<GraphState>> {
    const team = state.team ?? [];
    const userGoal = state.user_goal;
    const taskQueue = [...(state.task_queue ?? [])];

    if (userGoal) {
      const lessons = (state.ancestral_lessons ?? []) as string[];
      const decomposed = await this.decomposeGoalWithLlm(userGoal, team, lessons);
      for (const item of decomposed) {
        taskQueue.push({
          task_id: this.nextTaskId(),
          assigned_to: item.assigned_to,
          status: "pending",
          description: item.description,
          priority: "MEDIUM",
          worker_tier: item.worker_tier,
          result: null,
          urgency: 5,
          importance: 5,
          timebox_minutes: 25,
          in_progress_at: null,
        });
      }
      log(`🎯 Coordinator enqueued ${decomposed.length} tasks`);
      return {
        user_goal: null,
        task_queue: taskQueue,
        messages: [`🎯 Coordinator: Decomposed goal into ${decomposed.length} tasks`],
        last_action: "Coordinator processed",
        __node__: "coordinator",
      };
    }

    if (taskQueue.length > 0) {
      const scoredQueue = taskQueue.map((t) => {
        const rawUrgency = Number(t.urgency);
        const rawImportance = Number(t.importance);
        const urgency = Number.isFinite(rawUrgency)
          ? Math.min(10, Math.max(1, rawUrgency))
          : 5;
        const importance = Number.isFinite(rawImportance)
          ? Math.min(10, Math.max(1, rawImportance))
          : 5;
        const rawTimebox = Number(t.timebox_minutes);
        const timebox_minutes = Number.isFinite(rawTimebox) && rawTimebox >= 1 ? rawTimebox : 25;
        return {
          ...t,
          urgency,
          importance,
          timebox_minutes,
        };
      });
      scoredQueue.sort((a, b) => {
        const scoreA = (a.urgency as number) * 10 + (a.importance as number);
        const scoreB = (b.urgency as number) * 10 + (b.importance as number);
        return scoreB - scoreA;
      });
      return {
        task_queue: scoredQueue,
        last_action: "Coordinator processed",
        __node__: "coordinator",
      };
    }

    return { last_action: "Coordinator processed", __node__: "coordinator" };
  }
}
