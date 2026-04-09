/**
 * /sprint slash command — autonomous multi-agent sprint mode.
 *
 * Subcommands:
 *   /sprint <goal>   — start a new sprint
 *   /sprint stop     — stop the current sprint
 *   /sprint status   — show progress
 *   /sprint plan     — show task list
 *   /sprint resume   — resume a paused sprint
 */
import type { SlashCommand } from "../../tui/slash/registry.js";
import type { AppLayout } from "../layout.js";
import type { AgentRegistry } from "../../router/agent-registry.js";
import type { ToolRegistry } from "../../tools/registry.js";
import type { ToolExecutor } from "../../tools/executor.js";
import type { SprintRunner } from "../../sprint/sprint-runner.js";
import type { SprintTask, SprintResult, SprintState } from "../../sprint/types.js";
import { createSprintRunner } from "../../sprint/create-sprint-runner.js";
import { renderPanel, panelSection } from "../../tui/components/panel.js";
import { ctp } from "../../tui/themes/default.js";

export interface SprintCommandDeps {
  agents: AgentRegistry;
  toolRegistry?: ToolRegistry;
  toolExecutor?: ToolExecutor;
  layout: AppLayout;
}

let activeRunner: SprintRunner | null = null;

/** Capitalize first letter of an agent id for display. */
function agentDisplayName(id: string): string {
  return id.charAt(0).toUpperCase() + id.slice(1);
}

/** Status icon for a task. */
function taskIcon(status: SprintTask["status"]): string {
  switch (status) {
    case "completed": return "+";
    case "failed": return "x";
    case "incomplete": return "?";
    case "in_progress": return ">";
    default: return " ";
  }
}

/** Format a task list with status icons. */
function formatTaskList(tasks: SprintTask[]): string {
  return tasks
    .map((t, i) => {
      const icon = taskIcon(t.status);
      const agent = t.assignedAgent ? ` [${t.assignedAgent}]` : "";
      return `  ${icon} ${i + 1}. ${t.description}${agent}`;
    })
    .join("\n");
}

/** Format a duration in ms to a human-readable string. */
function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const secs = Math.round(ms / 1000);
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  const remSecs = secs % 60;
  return `${mins}m ${remSecs}s`;
}

/** Get terminal-aware panel options so panels use full available width. */
function sprintPanelOpts(title: string): { title: string; termWidth: number; maxWidth: number } {
  const termWidth = process.stdout.columns ?? 120;
  return { title, termWidth, maxWidth: Math.max(40, termWidth - 4) };
}

/** Build a summary panel for a finished sprint. */
function buildSummaryPanel(result: SprintResult): string {
  const lines = [
    ...panelSection("Result"),
    `  Goal:      ${result.goal}`,
    `  Completed: ${result.completedTasks} / ${result.tasks.length}`,
    `  Failed:    ${result.failedTasks}`,
    `  Duration:  ${formatDuration(result.duration)}`,
    "",
    ...panelSection("Tasks"),
    formatTaskList(result.tasks),
  ];
  return renderPanel(sprintPanelOpts("Sprint Complete"), lines).join("\n");
}

/** Build a status panel from current sprint state. */
function buildStatusPanel(state: SprintState): string {
  const total = state.tasks.length;
  const progress = total > 0
    ? `${state.completedTasks}/${total} (${Math.round((state.completedTasks / total) * 100)}%)`
    : "no tasks";
  const lines = [
    ...panelSection("Sprint Status"),
    `  Goal:     ${state.goal}`,
    `  Phase:    ${state.phase}`,
    `  Progress: ${progress}`,
    `  Failed:   ${state.failedTasks}`,
  ];
  if (state.phase === "executing" || state.phase === "paused") {
    const current = state.tasks[state.currentTaskIndex];
    if (current) {
      lines.push(`  Current:  ${current.description}`);
      if (current.assignedAgent) {
        lines.push(`  Agent:    ${agentDisplayName(current.assignedAgent)}`);
      }
    }
  }
  return renderPanel(sprintPanelOpts("Sprint"), lines).join("\n");
}

export function createSprintCommand(deps: SprintCommandDeps): SlashCommand {
  return {
    name: "sprint",
    aliases: ["sp"],
    description: "Autonomous multi-agent sprint mode",
    args: "<goal> | stop | status | plan | resume",
    async execute(args: string, ctx) {
      const sub = args.trim();
      const { layout } = deps;

      // ── /sprint stop ──────────────────────────────────────────────
      if (sub === "stop") {
        if (!activeRunner) {
          ctx.addMessage("system", "No active sprint to stop.");
          return;
        }
        activeRunner.stop();
        activeRunner = null;
        ctx.addMessage("system", "Sprint stopped.");
        return;
      }

      // ── /sprint status ────────────────────────────────────────────
      if (sub === "status") {
        if (!activeRunner) {
          ctx.addMessage("system", "No active sprint. Use `/sprint <goal>` to start one.");
          return;
        }
        const state = activeRunner.getState();
        ctx.addMessage("system", buildStatusPanel(state));
        return;
      }

      // ── /sprint plan ──────────────────────────────────────────────
      if (sub === "plan") {
        if (!activeRunner) {
          ctx.addMessage("system", "No active sprint. Use `/sprint <goal>` to start one.");
          return;
        }
        const state = activeRunner.getState();
        if (state.tasks.length === 0) {
          ctx.addMessage("system", "Sprint has no tasks yet (still planning).");
          return;
        }
        const lines = [
          ...panelSection("Task Plan"),
          formatTaskList(state.tasks),
        ];
        ctx.addMessage("system", renderPanel(sprintPanelOpts("Sprint Plan"), lines).join("\n"));
        return;
      }

      // ── /sprint resume ────────────────────────────────────────────
      if (sub === "resume") {
        if (!activeRunner) {
          ctx.addMessage("system", "No active sprint to resume.");
          return;
        }
        const state = activeRunner.getState();
        if (state.phase !== "paused") {
          ctx.addMessage("system", `Sprint is not paused (current phase: ${state.phase}).`);
          return;
        }
        activeRunner.resume();
        ctx.addMessage("system", "Sprint resumed.");
        return;
      }

      // ── /sprint <goal> — start new sprint ─────────────────────────
      if (!sub) {
        ctx.addMessage("system", "Usage: /sprint <goal>\nSubcommands: stop, status, plan, resume");
        return;
      }

      if (activeRunner) {
        const state = activeRunner.getState();
        if (state.phase === "executing" || state.phase === "planning" || state.phase === "paused") {
          ctx.addMessage("system", "A sprint is already running. Use `/sprint stop` first.");
          return;
        }
      }

      const goal = sub;
      const runner = createSprintRunner({
        agents: deps.agents,
        toolRegistry: deps.toolRegistry,
        toolExecutor: deps.toolExecutor,
      });
      activeRunner = runner;

      // ── Wire sprint events to TUI ────────────────────────────────

      runner.on("sprint:start", ({ goal: g }: { goal: string }) => {
        ctx.addMessage("system", `**Sprint started:** ${g}`);
        ctx.requestRender();
      });

      runner.on("sprint:planning", () => {
        layout.messages.addMessage({
          role: "agent",
          agentName: agentDisplayName("planner"),
          content: "Analyzing goal and generating task plan...",
          timestamp: new Date(),
        });
        layout.statusBar.updateSegment(3, "Planning sprint...", ctp.teal);
        ctx.requestRender();
      });

      runner.on("sprint:plan", ({ tasks }: { tasks: SprintTask[] }) => {
        const lines = [
          ...panelSection("Task Plan"),
          formatTaskList(tasks),
        ];
        ctx.addMessage("system", renderPanel(sprintPanelOpts(`Sprint \u2014 ${tasks.length} tasks`), lines).join("\n"));
        layout.statusBar.updateSegment(3, "Executing tasks...", ctp.teal);
        ctx.requestRender();
      });

      runner.on("sprint:task:start", ({ task, agentName }: { task: SprintTask; agentName: string }) => {
        layout.messages.addMessage({
          role: "agent",
          agentName: agentDisplayName(agentName),
          content: `Working on: ${task.description}`,
          timestamp: new Date(),
        });
        ctx.requestRender();
      });

      runner.on("sprint:agent:token", ({ token }: { agentName: string; token: string }) => {
        layout.messages.appendToLast(token);
        ctx.requestRender();
      });

      runner.on("sprint:agent:tool", (data: {
        agentName: string;
        toolName: string;
        status: string;
        details?: { executionId?: string; inputSummary?: string; duration?: number; outputSummary?: string; success?: boolean };
      }) => {
        const execId = data.details?.executionId ?? `sprint_${Date.now()}`;
        if (data.status === "running") {
          layout.messages.startToolCall(execId, data.toolName, data.details?.inputSummary ?? data.toolName, data.agentName);
        } else if (data.status === "completed" || data.status === "failed") {
          layout.messages.completeToolCall(execId, data.status === "completed", data.details?.outputSummary ?? "", data.details?.duration ?? 0);
        }
        ctx.requestRender();
      });

      runner.on("sprint:task:complete", ({ task }: { task: SprintTask }) => {
        const icon = task.status === "completed" ? "+" : "x";
        const statusText = task.status === "completed" ? "completed" : `failed: ${task.error ?? "unknown"}`;
        ctx.addMessage("system", `${icon} Task "${task.description}" ${statusText}`);
        ctx.requestRender();
      });

      runner.on("sprint:done", ({ result }: { result: SprintResult }) => {
        ctx.addMessage("system", buildSummaryPanel(result));
        layout.statusBar.updateSegment(3, "idle", ctp.overlay0);
        ctx.requestRender();
      });

      runner.on("sprint:error", ({ error, task }: { error: Error; task?: SprintTask }) => {
        const taskInfo = task ? ` (task: ${task.description})` : "";
        ctx.addMessage("error", `Sprint error${taskInfo}: ${error.message}`);
        ctx.requestRender();
      });

      runner.on("sprint:warning", ({ warning, type }: { warning: string; type: string; taskIndex?: number }) => {
        ctx.addMessage("system", `[${type}] ${warning}`);
        ctx.requestRender();
      });

      runner.on("sprint:paused", () => {
        ctx.addMessage("system", "Sprint paused. Use `/sprint resume` to continue.");
        ctx.requestRender();
      });

      runner.on("sprint:resumed", () => {
        ctx.addMessage("system", "Sprint resumed.");
        ctx.requestRender();
      });

      // ── Run the sprint ───────────────────────────────────────────
      try {
        await runner.run(goal);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        ctx.addMessage("error", `Sprint failed: ${msg}`);
      } finally {
        if (activeRunner === runner) {
          activeRunner = null;
        }
      }
    },
  };
}
