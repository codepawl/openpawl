/**
 * Sprint Planning Node - Creates Sprint Goal and Definition of Success.
 */

import type { GraphState } from "../core/graph-state.js";
import type { WorkerAdapter } from "../adapters/worker-adapter.js";
import { CONFIG } from "../core/config.js";
import { logger, isDebugMode } from "../core/logger.js";
import { parseLlmJson } from "../utils/jsonExtractor.js";
import { UniversalWorkerAdapter } from "../adapters/worker-adapter.js";
import { resolveModelForAgent } from "../core/model-config.js";
import { ensureWorkspaceDir, writeTextFile } from "../core/workspace-fs.js";
import { getCanvasTelemetry } from "../core/canvas-telemetry.js";
import type { AgentProfile } from "./profiles/types.js";
import { formatProfilesForPrompt } from "./profiles/prompt.js";
import { withDecisionContext } from "../journal/prompt.js";
import { compressIfLarge } from "../token-opt/payload-compressor.js";

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
  private readonly profiles: AgentProfile[];
  private static readonly PLANNING_TIMEOUT_MS = CONFIG.llmTimeoutMs || 120_000;

  constructor(options: { llmAdapter?: WorkerAdapter; workspacePath?: string; profiles?: AgentProfile[] } = {}) {
    this.llmAdapter =
      options.llmAdapter ??
      new UniversalWorkerAdapter({
        model: resolveModelForAgent("planner"),
        botId: "planner",
      });
    this.workspacePath = options.workspacePath ?? process.cwd();
    this.profiles = options.profiles ?? [];
    log(`📋 SprintPlanningNode initialized (workspace: ${this.workspacePath})`);
  }

  async createSprintPlan(state: GraphState, signal?: AbortSignal): Promise<Partial<GraphState>> {
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

    const memoriesContext = state.retrieved_memories || "";

    try {
      const sprintPlan = await this.generateSprintPlanWithLlm(
        userGoal,
        team,
        ancestralLessons,
        signal,
        memoriesContext,
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
    lessons: string[],
    signal?: AbortSignal,
    memoriesContext?: string,
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

    const memoryBlock = memoriesContext
      ? `\n\n${compressIfLarge(memoriesContext).text}`
      : "";
    const profileBlock = formatProfilesForPrompt(this.profiles);

    // Load relevant past decisions for context injection
    let pastDecisions: import("../journal/types.js").Decision[] = [];
    try {
      const { DecisionStore } = await import("../journal/store.js");
      const lancedb = await import("@lancedb/lancedb");
      const os = await import("node:os");
      const path = await import("node:path");
      const dbPath = path.join(os.homedir(), ".teamclaw", "memory", "global.db");
      const db = await lancedb.connect(dbPath);
      const decStore = new DecisionStore();
      await decStore.init(db);
      const recent = await decStore.getRecentDecisions(30);
      pastDecisions = recent.filter((d) => d.status === "active").slice(0, 3);
    } catch {
      // Non-critical — decisions unavailable
    }

    let prompt = `You are a Scrum Master conducting Sprint Planning.

## Sprint Goal
${goal}

## Team Roster
${teamLines}
${lessonsBlock}${memoryBlock}${profileBlock ? `\n\n${profileBlock}` : ""}

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

    // Inject past decisions into prompt
    if (pastDecisions.length > 0) {
      prompt = withDecisionContext(prompt, pastDecisions);
    }

    const messages = [
      { role: "user", content: prompt },
    ];
    const raw = await Promise.race([
      this.llmAdapter.complete(messages, { signal }),
      new Promise<never>((_, reject) =>
        setTimeout(
          () => reject(new Error("Sprint planning timed out")),
          SprintPlanningNode.PLANNING_TIMEOUT_MS
        )
      ),
    ]);

    if (!raw.trim()) {
      throw new Error("Sprint planning returned empty output");
    }

    const parsed = parseLlmJson<Record<string, unknown>>(raw);
    if (!parsed || typeof parsed !== "object") {
      throw new Error(`Invalid sprint plan format from LLM: ${raw.slice(0, 300)}`);
    }

    // Normalize keys — LLMs often use snake_case or other variants
    const sprintGoal = String(
      parsed.sprintGoal ?? parsed.sprint_goal ?? parsed.goal ?? ""
    ).trim();
    const rawDoS =
      parsed.definitionOfSuccess ?? parsed.definition_of_success ?? parsed.success_criteria ?? parsed.criteria ?? [];
    const definitionOfSuccess: string[] = Array.isArray(rawDoS)
      ? rawDoS.map((x: unknown) => String(x))
      : typeof rawDoS === "string"
        ? rawDoS.split(/\n|;/).map((s: string) => s.trim()).filter(Boolean)
        : [];
    const rawAssignments =
      parsed.teamAssignments ?? parsed.team_assignments ?? parsed.assignments ?? [];
    const teamAssignments: Array<{ role: string; bot: string; focus: string }> =
      Array.isArray(rawAssignments)
        ? rawAssignments.map((a: Record<string, unknown>) => ({
            role: String(a.role ?? ""),
            bot: String(a.bot ?? a.bot_id ?? ""),
            focus: String(a.focus ?? a.focus_area ?? ""),
          }))
        : [];

    if (!sprintGoal) {
      log(`Sprint plan parse failed. Raw keys: ${Object.keys(parsed).join(", ")}. Raw: ${raw.slice(0, 300)}`);
      throw new Error(`Invalid sprint plan format from LLM (missing goal). Keys: ${Object.keys(parsed).join(", ")}`);
    }

    // Provide sensible defaults if DoS is empty
    if (definitionOfSuccess.length === 0) {
      definitionOfSuccess.push("All assigned tasks completed successfully");
    }

    return { sprintGoal, definitionOfSuccess, teamAssignments };
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
  llmAdapter?: WorkerAdapter,
  signal?: AbortSignal,
  profiles?: AgentProfile[],
): (state: GraphState) => Promise<Partial<GraphState>> {
  const node = new SprintPlanningNode({ llmAdapter, workspacePath, profiles });
  return (state: GraphState) => node.createSprintPlan(state, signal);
}
