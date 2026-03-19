/**
 * Coordinator Agent - Goal decomposition and task routing.
 */

import type { GraphState } from "../core/graph-state.js";
import { getRoleTemplate } from "../core/bot-definitions.js";
import { CONFIG } from "../core/config.js";
import { logger, isDebugMode } from "../core/logger.js";
import { parseLlmJson } from "../utils/jsonExtractor.js";
import type { WorkerAdapter } from "../adapters/worker-adapter.js";
import { UniversalWorkerAdapter } from "../adapters/worker-adapter.js";
import { resolveModelForAgent } from "../core/model-config.js";
import { coordinatorEvents } from "../core/coordinator-events.js";
import { compressIfLarge } from "../token-opt/payload-compressor.js";

function log(msg: string): void {
  if (isDebugMode()) {
    logger.agent(msg);
  }
}

export class CoordinatorAgent {
  private taskCounter = 0;
  private readonly llmAdapter: WorkerAdapter;
  private readonly workspacePath: string;
  private static readonly DECOMPOSITION_TIMEOUT_MS = CONFIG.llmTimeoutMs || 120_000;

  constructor(options: { llmAdapter?: WorkerAdapter; workspacePath?: string } = {}) {
    this.llmAdapter =
      options.llmAdapter ??
      new UniversalWorkerAdapter({
        model: resolveModelForAgent("coordinator"),
        botId: "coordinator",
      });
    this.workspacePath = options.workspacePath ?? process.cwd();
    log(`🎯 Coordinator Agent initialized (workspace: ${this.workspacePath})`);
  }

  private nextTaskId(): string {
    this.taskCounter += 1;
    return `TASK-${String(this.taskCounter).padStart(3, "0")}`;
  }

  private async decomposeGoalWithLlm(
    goal: string,
    team: Record<string, unknown>[],
    ancestralLessons: string[] = [],
    projectContext: string = "",
    preferencesContext: string = "",
    signal?: AbortSignal
  ): Promise<Array<{ description: string; assigned_to: string; worker_tier: "light" | "heavy"; complexity: "LOW" | "MEDIUM" | "HIGH" | "ARCHITECTURE"; dependencies?: number[] }>> {
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

    const projectContextBlock = projectContext
        ? `\n${projectContext}`
        : "";

    const compressedPreferences = preferencesContext
        ? compressIfLarge(preferencesContext, 1500).text
        : "";
    const preferencesBlock = compressedPreferences
        ? `\n\n## User Preferences (from past projects - MUST ADHERE TO THESE):\n${compressedPreferences}\n\nIMPORTANT: Follow these preferences exactly when decomposing the goal and assigning tasks.`
        : "";

    const prompt = `You are a team coordinator. Break this goal into 3-6 concrete subtasks.
RETURN ONLY RAW JSON — no preamble. Start with '[' and end with ']'.
Assign each subtask to ONE team member. Create at least one task per roster role.
${lessonsBlock}${projectContextBlock}${preferencesBlock}

Goal: ${goal}

Team (${team.length} bots):
${rosterLines.join("\n")}

${roleSummary.join("\n")}

Output a JSON array. Each element: {"description": string, "assigned_to": bot id, "worker_tier": "light"|"heavy", "complexity": "LOW"|"MEDIUM"|"HIGH"|"ARCHITECTURE", "dependencies": number[]}.
"dependencies" is 0-based indices of tasks in this array that must finish first. Empty [] = no dependencies.
Use "heavy" only for browser/GUI tasks. Use "HIGH"/"ARCHITECTURE" for significant design work.
Array MUST have >= ${Math.max(3, team.length)} tasks covering all roles. No other keys, no explanations.`;

    coordinatorEvents.emit("progress", {
      step: "preparing",
      detail: `Analyzing goal for ${team.length} team members, ${ancestralLessons.length} lessons loaded`,
      timestamp: Date.now(),
    });

    try {
      const messages = [
        { role: "system", content: "You are a team coordinator. Return ONLY raw JSON." },
        { role: "user", content: prompt },
      ];
      const raw = await Promise.race([
        this.llmAdapter.complete(messages, { signal }),
        new Promise<never>((_, reject) =>
          setTimeout(
            () => reject(new Error("❌ Decomposition timed out - Check Gateway logs")),
            CoordinatorAgent.DECOMPOSITION_TIMEOUT_MS,
          ),
        ),
      ]);
      coordinatorEvents.emit("progress", {
        step: "parsing",
        detail: "Parsing LLM response...",
        timestamp: Date.now(),
      });
      if (!raw.trim()) {
        throw new Error("Coordinator decomposition returned empty output");
      }
      const items = parseLlmJson<
        Array<{ description?: string; assigned_to?: string; worker_tier?: string; complexity?: string; dependencies?: number[] }> | {
          description?: string;
          assigned_to?: string;
          worker_tier?: string;
          complexity?: string;
          dependencies?: number[];
        }
      >(raw);
      const list = Array.isArray(items) ? items : [items];
      const parsed: Array<{ description: string; assigned_to: string; worker_tier: "light" | "heavy"; complexity: "LOW" | "MEDIUM" | "HIGH" | "ARCHITECTURE"; dependencies?: number[] }> = list.map((item) => {
        const rawTier = typeof item.worker_tier === "string" ? item.worker_tier.trim().toLowerCase() : "";
        const tier: "light" | "heavy" = rawTier === "heavy" ? "heavy" : "light";
        if (rawTier !== "" && rawTier !== "light" && rawTier !== "heavy") {
          log(`Invalid worker_tier "${item.worker_tier}" for task, defaulting to "light"`);
        }
        const rawComplexity = typeof item.complexity === "string" ? item.complexity.trim().toUpperCase() : "MEDIUM";
        const validComplexities = ["LOW", "MEDIUM", "HIGH", "ARCHITECTURE"];
        const complexity: "LOW" | "MEDIUM" | "HIGH" | "ARCHITECTURE" = validComplexities.includes(rawComplexity)
          ? (rawComplexity as "LOW" | "MEDIUM" | "HIGH" | "ARCHITECTURE")
          : "MEDIUM";
        const rawDeps = Array.isArray(item.dependencies) ? item.dependencies.filter((d): d is number => typeof d === "number") : [];
        return {
          description: String(item.description ?? ""),
          assigned_to: String(item.assigned_to ?? team[0]?.id ?? "bot_0"),
          worker_tier: tier,
          complexity,
          dependencies: rawDeps,
        };
      });
      coordinatorEvents.emit("progress", {
        step: "assigning",
        detail: `Validated ${parsed.length} tasks, backfilling assignments...`,
        timestamp: Date.now(),
      });
      const minTasks = team.length > 1 ? Math.max(3, team.length) : 1;
      const out: Array<{ description: string; assigned_to: string; worker_tier: "light" | "heavy"; complexity: "LOW" | "MEDIUM" | "HIGH" | "ARCHITECTURE"; dependencies?: number[] }> =
        parsed.filter((x) => x.description.trim().length > 0);
      const covered = new Set(out.map((x) => x.assigned_to));
      for (const bot of team) {
        const botId = String(bot.id ?? "").trim();
        if (!botId || covered.has(botId)) continue;
        out.push({
          description: `Create a role-specific deliverable for "${goal.slice(0, 120)}"`,
          assigned_to: botId,
          worker_tier: "light",
          complexity: "MEDIUM",
        });
        covered.add(botId);
      }
      while (out.length < minTasks) {
        const idx = out.length % Math.max(team.length, 1);
        const botId = String(team[idx]?.id ?? team[0]?.id ?? "bot_0");
        out.push({
          description: `Implement concrete subtask ${out.length + 1} for "${goal.slice(0, 100)}"`,
          assigned_to: botId,
          worker_tier: "light",
          complexity: "MEDIUM",
        });
      }
      return out;
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      const extra = isDebugMode()
        ? ` goalChars=${goal.length} teamSize=${team.length} lessons=${ancestralLessons.length} timeoutMs=${CONFIG.llmTimeoutMs}`
        : "";
      log(`❌ LLM decomposition failed: ${errMsg}.${extra}`);
      throw new Error(`Coordinator failed to decompose goal: ${errMsg}`);
    }
  }

  async coordinateNode(state: GraphState, signal?: AbortSignal): Promise<Partial<GraphState>> {
    const team = state.team ?? [];
    const userGoal = state.user_goal;
    const projectContext = (state.project_context as string) ?? "";
    const taskQueue = [...(state.task_queue ?? [])];
    const preferencesContext = (state.preferences_context as string) ?? "";

    const complexityMap: Record<string, { priority: string; urgency: number; importance: number }> = {
      ARCHITECTURE: { priority: "HIGH", urgency: 9, importance: 9 },
      HIGH:         { priority: "HIGH", urgency: 8, importance: 7 },
      MEDIUM:       { priority: "MEDIUM", urgency: 5, importance: 6 },
      LOW:          { priority: "LOW", urgency: 3, importance: 4 },
    };

    if (userGoal) {
      const lessons = (state.ancestral_lessons ?? []) as string[];
      const decomposed = await this.decomposeGoalWithLlm(userGoal, team, lessons, projectContext, preferencesContext, signal);
      for (const item of decomposed) {
        const derived = complexityMap[item.complexity] ?? complexityMap.MEDIUM;
        taskQueue.push({
          task_id: this.nextTaskId(),
          assigned_to: item.assigned_to,
          status: "pending",
          description: item.description,
          priority: derived.priority,
          worker_tier: item.worker_tier,
          complexity: item.complexity,
          result: null,
          urgency: derived.urgency,
          importance: derived.importance,
          timebox_minutes: 25,
          in_progress_at: null,
        });
      }
      // Resolve dependency indices to task_ids
      const newTaskStart = taskQueue.length - decomposed.length;
      for (let i = 0; i < decomposed.length; i++) {
        const task = taskQueue[newTaskStart + i];
        const rawDeps = decomposed[i].dependencies ?? [];
        const resolved: string[] = [];
        for (const depIdx of rawDeps) {
          if (depIdx >= 0 && depIdx < decomposed.length && depIdx !== i) {
            const depTask = taskQueue[newTaskStart + depIdx];
            resolved.push(depTask.task_id as string);
          }
        }
        task.dependencies = resolved;
      }

      coordinatorEvents.emit("progress", {
        step: "complete",
        detail: `Decomposed into ${decomposed.length} tasks`,
        timestamp: Date.now(),
      });
      log(`🎯 Coordinator enqueued ${decomposed.length} tasks`);
      return {
        user_goal: null,
        task_queue: taskQueue,
        total_tasks: decomposed.length,
        messages: [`🎯 Coordinator: Decomposed goal into ${decomposed.length} tasks (check DOCS/PLANNING.md & DOCS/RFC.md)`],
        last_action: "Coordinator processed",
        __node__: "coordinator",
      };
    }

    if (taskQueue.length > 0) {
      coordinatorEvents.emit("progress", {
        step: "reprioritizing",
        detail: `Re-scoring ${taskQueue.length} tasks by urgency/importance`,
        timestamp: Date.now(),
      });
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
