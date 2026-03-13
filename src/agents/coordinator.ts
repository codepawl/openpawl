/**
 * Coordinator Agent - Goal decomposition and task routing.
 */

import type { GraphState } from "../core/graph-state.js";
import { getRoleTemplate } from "../core/bot-definitions.js";
import { CONFIG } from "../core/config.js";
import { logger, isDebugMode } from "../core/logger.js";
import { parseLlmJson } from "../utils/jsonExtractor.js";
import type { WorkerAdapter } from "../interfaces/worker-adapter.js";
import { UniversalOpenClawAdapter } from "../interfaces/worker-adapter.js";
import { resolveModelForAgent } from "../core/model-config.js";

function log(msg: string): void {
  if (isDebugMode()) {
    logger.agent(msg);
  }
}

export class CoordinatorAgent {
  private taskCounter = 0;
  private readonly llmAdapter: WorkerAdapter;
  private readonly workspacePath: string;
  private static readonly DECOMPOSITION_TIMEOUT_MS = 30_000;

  constructor(options: { llmAdapter?: WorkerAdapter; workspacePath?: string } = {}) {
    this.llmAdapter =
      options.llmAdapter ??
      new UniversalOpenClawAdapter({
        workerUrl: CONFIG.openclawWorkerUrl,
        authToken: CONFIG.openclawToken,
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
    preferencesContext: string = ""
  ): Promise<Array<{ description: string; assigned_to: string; worker_tier: "light" | "heavy"; complexity: "LOW" | "MEDIUM" | "HIGH" | "ARCHITECTURE" }>> {
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

    const preferencesBlock = preferencesContext
        ? `\n\n## User Preferences (from past projects - MUST ADHERE TO THESE):\n${preferencesContext}\n\nIMPORTANT: Follow these preferences exactly when decomposing the goal and assigning tasks.`
        : "";

    const prompt = `You are a team coordinator. Break this goal into 3-6 concrete subtasks.
RETURN ONLY RAW JSON. DO NOT INCLUDE PREAMBLE OR EXPLANATIONS. START WITH '{' OR '[' AND END WITH '}' OR ']'.
Assign each subtask to ONE team member based on their role and skills.
You MUST decompose the goal into multiple smaller, actionable tasks.
You MUST create at least one specific task for EACH role provided in the roster.
Do not output a single monolithic task.

You are working in a strictly defined workspace. Treat this workspace as your root directory.
WORKSPACE PATH: ${this.workspacePath}
IMPORTANT: Do NOT create arbitrary subdirectories unless explicitly specified in the task.
Output files directly to the root of the provided workspace path unless the task explicitly requires a specific structure (like 'assets/' or 'src/components/').
All file operations (read, write, create, edit) MUST be performed within this directory.
Do not attempt to read or write files outside of it.

📋 SPRINT PLANNING: The team has already defined the Sprint Goal and Definition of Success in DOCS/PLANNING.md.
📝 RFC PROCESS: Complex tasks (marked HIGH or ARCHITECTURE complexity) require RFC approval before execution.
📖 AGENTS.md: Read DOCS/AGENTS.md for team rules, culture (blame-free), and communication standards.
${lessonsBlock}${projectContextBlock}${preferencesBlock}

Goal: ${goal}

You are managing a team of ${team.length} bots.
Your roster:
${rosterLines.join("\n")}

Team:
${roleSummary.join("\n")}

Output a JSON array. Each element MUST be an object with exactly these four keys:
- "description" (string): the task description
- "assigned_to" (string): bot id (e.g. bot_0, bot_1)
- "worker_tier" (string): MUST be either "light" or "heavy". Use "heavy" only when the task explicitly requires UI automation, browser control, or complex GUI interaction; otherwise use "light".
- "complexity" (string): MUST be "LOW", "MEDIUM", "HIGH", or "ARCHITECTURE". Use "HIGH" or "ARCHITECTURE" for tasks involving new architecture, multiple components, or significant design decisions. Simpler tasks should be "LOW" or "MEDIUM".

You must include worker_tier and complexity for every task. No other keys. No explanations, only the JSON array.
The array MUST contain at least ${Math.max(3, team.length)} tasks and cover all roster roles.
You are managing a roster of specific roles. You MUST output an array of MULTIPLE tasks.
You MUST create at least one distinct task for EACH role in the roster that is relevant to the goal.
It is strictly FORBIDDEN to output only 1 task if the roster has more than 1 bot.

Example:
[{"description": "Implement login API", "assigned_to": "bot_0", "worker_tier": "light", "complexity": "LOW"}, {"description": "Design and implement authentication architecture", "assigned_to": "bot_0", "worker_tier": "light", "complexity": "ARCHITECTURE"}, {"description": "Open browser and click Login button", "assigned_to": "bot_1", "worker_tier": "heavy", "complexity": "MEDIUM"}]`;

    try {
      const llmTaskId = `COORD-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
      const llmResult = await Promise.race([
        this.llmAdapter.executeTask({
          task_id: llmTaskId,
          description: prompt,
          priority: "HIGH",
          estimated_cost: 0,
        }),
        new Promise<never>((_, reject) =>
          setTimeout(
            () => reject(new Error("❌ Decomposition timed out - Check Gateway logs")),
            CoordinatorAgent.DECOMPOSITION_TIMEOUT_MS,
          ),
        ),
      ]);
      if (!llmResult.success) {
        throw new Error(String(llmResult.output ?? "Coordinator decomposition failed"));
      }
      const raw = String(llmResult.output ?? "").trim();
      if (!raw) {
        throw new Error("Coordinator decomposition returned empty output");
      }
      const items = parseLlmJson<
        Array<{ description?: string; assigned_to?: string; worker_tier?: string; complexity?: string }> | {
          description?: string;
          assigned_to?: string;
          worker_tier?: string;
          complexity?: string;
        }
      >(raw);
      const list = Array.isArray(items) ? items : [items];
      const parsed: Array<{ description: string; assigned_to: string; worker_tier: "light" | "heavy"; complexity: "LOW" | "MEDIUM" | "HIGH" | "ARCHITECTURE" }> = list.map((item) => {
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
        return {
          description: String(item.description ?? ""),
          assigned_to: String(item.assigned_to ?? team[0]?.id ?? "bot_0"),
          worker_tier: tier,
          complexity,
        };
      });
      const minTasks = team.length > 1 ? Math.max(3, team.length) : 1;
      const out: Array<{ description: string; assigned_to: string; worker_tier: "light" | "heavy"; complexity: "LOW" | "MEDIUM" | "HIGH" | "ARCHITECTURE" }> =
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

  async coordinateNode(state: GraphState): Promise<Partial<GraphState>> {
    const team = state.team ?? [];
    const userGoal = state.user_goal;
    const projectContext = (state.project_context as string) ?? "";
    const taskQueue = [...(state.task_queue ?? [])];
    const preferencesContext = (state.preferences_context as string) ?? "";

    if (userGoal) {
      const lessons = (state.ancestral_lessons ?? []) as string[];
      const decomposed = await this.decomposeGoalWithLlm(userGoal, team, lessons, projectContext, preferencesContext);
      for (const item of decomposed) {
        taskQueue.push({
          task_id: this.nextTaskId(),
          assigned_to: item.assigned_to,
          status: "pending",
          description: item.description,
          priority: "MEDIUM",
          worker_tier: item.worker_tier,
          complexity: item.complexity,
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
        total_tasks: decomposed.length,
        messages: [`🎯 Coordinator: Decomposed goal into ${decomposed.length} tasks (check DOCS/PLANNING.md & DOCS/RFC.md)`],
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
