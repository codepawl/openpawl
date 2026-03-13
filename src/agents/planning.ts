/**
 * Sprint Planning Node - Creates Sprint Goal and Definition of Success.
 */

import type { GraphState } from "../core/graph-state.js";
import type { WorkerAdapter } from "../interfaces/worker-adapter.js";
import { CONFIG } from "../core/config.js";
import { logger, isDebugMode } from "../core/logger.js";
import { parseLlmJson } from "../utils/jsonExtractor.js";
import { UniversalOpenClawAdapter } from "../interfaces/worker-adapter.js";
import { ensureWorkspaceDir, writeTextFile } from "../core/workspace-fs.js";
import { getCanvasTelemetry } from "../core/canvas-telemetry.js";

function log(msg: string): void {
  if (isDebugMode()) {
    logger.agent(msg);
  }
}

interface SprintPlan {
  sprintGoal: string;
  definitionOfSuccess: string[];
  teamAssignments: Array<{ role: string; bot: string; focus: string }>;
}

export class SprintPlanningNode {
  private readonly llmAdapter: WorkerAdapter;
  private readonly workspacePath: string;
  private static readonly PLANNING_TIMEOUT_MS = 45_000;

  constructor(options: { llmAdapter?: WorkerAdapter; workspacePath?: string } = {}) {
    this.llmAdapter =
      options.llmAdapter ??
      new UniversalOpenClawAdapter({
        workerUrl: CONFIG.openclawWorkerUrl,
        authToken: CONFIG.openclawToken,
      });
    this.workspacePath = options.workspacePath ?? process.cwd();
    log(`📋 SprintPlanningNode initialized (workspace: ${this.workspacePath})`);
  }

  async createSprintPlan(state: GraphState): Promise<Partial<GraphState>> {
    const userGoal = state.user_goal;
    const team = state.team ?? [];
    const ancestralLessons = (state.ancestral_lessons ?? []) as string[];

    if (!userGoal) {
      return {
        last_action: "No user goal provided for planning",
        __node__: "sprint_planning",
      };
    }

    log(`📋 Creating sprint plan for goal: ${userGoal.slice(0, 50)}...`);

    try {
      const sprintPlan = await this.generateSprintPlanWithLlm(
        userGoal,
        team,
        ancestralLessons
      );

      await this.writePlanningDocument(sprintPlan, userGoal);

      const planningDoc = this.formatPlanningDocument(sprintPlan, userGoal);

      const updatedTaskQueue = (state.task_queue ?? []).map((task) => ({
        ...task,
        status: "planning",
      }));

      // Send telemetry event
      try {
        const telemetry = getCanvasTelemetry();
        telemetry.sendPlanningComplete(userGoal, updatedTaskQueue.length);
      } catch {
        // Non-critical, ignore
      }

      return {
        planning_document: planningDoc,
        task_queue: updatedTaskQueue,
        messages: ["📋 Sprint planning complete. See DOCS/PLANNING.md"],
        last_action: "Sprint planning completed",
        __node__: "sprint_planning",
      };
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      log(`❌ Sprint planning failed: ${errMsg}`);
      throw new Error(`Sprint planning failed: ${errMsg}`);
    }
  }

  private async generateSprintPlanWithLlm(
    goal: string,
    team: Record<string, unknown>[],
    lessons: string[]
  ): Promise<SprintPlan> {
    const teamLines = team
      .map(
        (b) =>
          `- ${(b.name as string) ?? b.id} (${(b.role_id as string) ?? "unknown"})`
      )
      .join("\n");

    const lessonsBlock =
      lessons.length > 0
        ? `\n\n## Lessons from Prior Runs:\n${lessons.map((l, i) => `${i + 1}. ${l}`).join("\n")}`
        : "";

    const prompt = `You are a Scrum Master conducting Sprint Planning.

## Sprint Goal
${goal}

## Team Roster
${teamLines}
${lessonsBlock}

## Your Task
Create a Sprint Plan with:
1. **Sprint Goal** (1-2 sentences): What we aim to achieve this sprint
2. **Definition of Success** (3-6 items): Measurable criteria for sprint completion
3. **Team Assignments**: Which bot handles what focus area

Output ONLY a JSON object with this exact structure:
{
  "sprintGoal": "string",
  "definitionOfSuccess": ["string", "string", ...],
  "teamAssignments": [{"role": "string", "bot": "string", "focus": "string"}, ...]
}

Example:
{
  "sprintGoal": "Build a playable 2D platformer with 3 levels",
  "definitionOfSuccess": [
    "Game launches without errors",
    "Player can move and jump",
    "At least 3 playable levels",
    "All levels are completable"
  ],
  "teamAssignments": [
    {"role": "software_engineer", "bot": "bot_0", "focus": "Core game mechanics"},
    {"role": "qa_reviewer", "bot": "bot_1", "focus": "Testing and quality"}
  ]
}`;

    const llmTaskId = `PLAN-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
    const llmResult = await Promise.race([
      this.llmAdapter.executeTask({
        task_id: llmTaskId,
        description: prompt,
        priority: "HIGH",
        estimated_cost: 0,
      }),
      new Promise<never>((_, reject) =>
        setTimeout(
          () => reject(new Error("Sprint planning timed out")),
          SprintPlanningNode.PLANNING_TIMEOUT_MS
        )
      ),
    ]);

    if (!llmResult.success) {
      throw new Error(String(llmResult.output ?? "Planning failed"));
    }

    const raw = String(llmResult.output ?? "").trim();
    if (!raw) {
      throw new Error("Sprint planning returned empty output");
    }

    const parsed = parseLlmJson<SprintPlan>(raw);
    if (!parsed || !parsed.sprintGoal || !parsed.definitionOfSuccess) {
      throw new Error("Invalid sprint plan format from LLM");
    }

    return parsed;
  }

  private formatPlanningDocument(plan: SprintPlan, goal: string): string {
    const timestamp = new Date().toISOString().replace("T", " ").slice(0, 19);
    
    const dosItems = plan.definitionOfSuccess
      .map((item) => `- [ ] **${item}**`)
      .join("\n");

    const assignmentTable = plan.teamAssignments
      .map(
        (a) => `| ${a.role} | ${a.bot} | ${a.focus} |`
      )
      .join("\n");

    return `# 🏃 Sprint Planning

**Sprint Goal:** ${plan.sprintGoal}

---

## ✅ Definition of Success

${dosItems}

---

## 👥 Team Assignment

| Role | Bot | Focus Area |
|------|-----|------------|
${assignmentTable}

---

## 📌 Original Goal

> ${goal}

---

*Generated: ${timestamp}*
*Workspace: ${this.workspacePath}*`;
  }

  private async writePlanningDocument(
    plan: SprintPlan,
    goal: string
  ): Promise<void> {
    const docsContent = this.formatPlanningDocument(plan, goal);

    await ensureWorkspaceDir(this.workspacePath);
    await writeTextFile("DOCS/PLANNING.md", docsContent, {
      workspaceDir: this.workspacePath,
      mkdirp: true,
    });

    log(`✅ Wrote DOCS/PLANNING.md`);
  }
}

export function createSprintPlanningNode(
  workspacePath: string,
  llmAdapter?: WorkerAdapter
): (state: GraphState) => Promise<Partial<GraphState>> {
  const node = new SprintPlanningNode({ llmAdapter, workspacePath });
  return (state: GraphState) => node.createSprintPlan(state);
}
