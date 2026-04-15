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
import { defaultTheme } from "../../tui/themes/default.js";
import { formatDuration } from "../../utils/formatters.js";
import { SprintEvent } from "../../router/event-types.js";
import { ICONS } from "../../tui/constants/icons.js";

export interface SprintCommandDeps {
  agents: AgentRegistry;
  toolRegistry?: ToolRegistry;
  toolExecutor?: ToolExecutor;
  layout: AppLayout;
}

let activeRunner: SprintRunner | null = null;
let sessionLessons: string[] = [];

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

      // Wire debug logging to sprint runner
      if (process.env.OPENPAWL_DEBUG) {
        import("../../debug/wiring.js").then(({ wireDebugToSprintRunner }) => {
          wireDebugToSprintRunner(runner);
        }).catch(() => {});
      }

      // ── Wire sprint events to TUI ────────────────────────────────

      runner.on(SprintEvent.Start, ({ goal: g }: { goal: string }) => {
        ctx.addMessage("system", `**Sprint started:** ${g}`);
        ctx.requestRender();

        // Check for drift against past decisions (non-blocking)
        void (async () => {
          try {
            const { detectDrift } = await import("../../drift/index.js");
            const lancedb = await import("@lancedb/lancedb");
            const { join } = await import("node:path");
            const { homedir } = await import("node:os");
            const dbPath = join(homedir(), ".openpawl", "memory", "global.db");
            const { DecisionStore } = await import("../../journal/index.js");
            const db = await lancedb.connect(dbPath);
            const store = new DecisionStore();
            await store.init(db);
            const decisions = await store.getAll();
            if (decisions.length > 0) {
              const result = detectDrift(g, decisions);
              if (result.conflicts.length > 0) {
                const warnings = result.conflicts.map((c) =>
                  `${ICONS.warning} Drift: "${c.decision.decision}" — ${c.explanation}`
                );
                ctx.addMessage("system", `**Drift warnings (${result.severity}):**\n${warnings.join("\n")}`);
                ctx.requestRender();
              }
            }
          } catch {
            // Drift detection is non-critical (DB may not exist yet)
          }
        })();
      });

      runner.on(SprintEvent.Composition, ({ entries }: { entries: Array<{ role: string; task: string; included: boolean; reason: string }> }) => {
        const lines = entries.map((e) => {
          const icon = e.included ? ICONS.success : ICONS.error;
          return `${icon} **${e.role}** — ${e.reason}`;
        });
        ctx.addMessage("system", `**Team composition (autonomous):**\n${lines.join("\n")}`);
        ctx.requestRender();
      });

      runner.on(SprintEvent.NeedsClarification, ({ questions }: { questions: string[] }) => {
        const lines = questions.map((q) => `? ${q}`);
        ctx.addMessage("system", `**Goal needs clarification:**\n${lines.join("\n")}\n\nProvide a more specific goal with \`/sprint <goal>\`.`);
        layout.statusBar.updateSegment(3, "Needs clarification", defaultTheme.warning);
        ctx.requestRender();
      });

      runner.on(SprintEvent.Planning, () => {
        layout.messages.addMessage({
          role: "agent",
          agentName: agentDisplayName("planner"),
          content: "Analyzing goal and generating task plan...",
          timestamp: new Date(),
        });
        layout.statusBar.updateSegment(3, "Planning sprint...", defaultTheme.accent);
        ctx.requestRender();
      });

      runner.on(SprintEvent.Plan, ({ tasks }: { tasks: SprintTask[] }) => {
        const lines = [
          ...panelSection("Task Plan"),
          formatTaskList(tasks),
        ];
        ctx.addMessage("system", renderPanel(sprintPanelOpts(`Sprint \u2014 ${tasks.length} tasks`), lines).join("\n"));
        layout.statusBar.updateSegment(3, "Executing tasks...", defaultTheme.accent);
        ctx.requestRender();
      });

      runner.on(SprintEvent.TaskStart, ({ task, agentName }: { task: SprintTask; agentName: string }) => {
        layout.messages.addMessage({
          role: "agent",
          agentName: agentDisplayName(agentName),
          content: `Working on: ${task.description}`,
          timestamp: new Date(),
        });
        ctx.requestRender();
      });

      runner.on(SprintEvent.AgentToken, ({ token }: { agentName: string; token: string }) => {
        layout.messages.appendToLast(token);
        ctx.requestRender();
      });

      runner.on(SprintEvent.AgentTool, (data: {
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

      runner.on(SprintEvent.TaskComplete, ({ task }: { task: SprintTask }) => {
        const icon = task.status === "completed" ? "+" : "x";
        const statusText = task.status === "completed" ? "completed" : `failed: ${task.error ?? "unknown"}`;
        ctx.addMessage("system", `${icon} Task "${task.description}" ${statusText}`);
        ctx.requestRender();

        // Extract decisions from completed agent output (non-blocking)
        if (task.result && task.assignedAgent) {
          void (async () => {
            try {
              const { extractDecisions, DecisionStore } = await import("../../journal/index.js");
              const decisions = extractDecisions({
                agentRole: task.assignedAgent!,
                agentOutput: task.result!,
                taskId: task.id,
                sessionId: `sprint-${Date.now()}`,
                runIndex: 0,
                goalContext: goal,
              });
              if (decisions.length > 0) {
                const lancedb = await import("@lancedb/lancedb");
                const { join } = await import("node:path");
                const { homedir } = await import("node:os");
                const dbPath = join(homedir(), ".openpawl", "memory", "global.db");
                const db = await lancedb.connect(dbPath);
                const store = new DecisionStore();
                await store.init(db);
                for (const d of decisions) await store.upsert(d);
              }
            } catch {
              // Decision extraction is non-critical
            }
          })();
        }
      });

      runner.on(SprintEvent.Done, ({ result }: { result: SprintResult }) => {
        ctx.addMessage("system", buildSummaryPanel(result));
        layout.statusBar.updateSegment(3, "idle", defaultTheme.dim);
        ctx.requestRender();

        // Post-mortem analysis if there were failures
        if (result.failedTasks > 0) {
          void (async () => {
            try {
              const { analyzeRunResult } = await import("../../sprint/post-mortem.js");
              const postMortem = analyzeRunResult(result, sessionLessons);
              if (postMortem.failedTasks.length > 0) {
                const lines = [
                  `**Post-Mortem:** ${postMortem.failedTasks.length} task${postMortem.failedTasks.length === 1 ? "" : "s"} failed:`,
                  ...postMortem.failedTasks.map((f) =>
                    `${ICONS.error} "${f.task.slice(0, 60)}" \u2014 ${f.error}\n  Lesson: ${f.suggestedFix}`,
                  ),
                  "",
                  "Run `/sprint` again to apply these lessons.",
                ];
                ctx.addMessage("system", lines.join("\n"));
                ctx.requestRender();
              }
              sessionLessons = [...sessionLessons, ...postMortem.lessons].slice(0, 10);
            } catch {
              // Post-mortem is non-critical
            }
          })();
        } else {
          sessionLessons = [];
        }

        // Auto-generate CONTEXT.md handoff in background
        void (async () => {
          try {
            const { buildHandoffData, renderContextMarkdown } = await import("../../handoff/index.js");
            const { writeFileSync } = await import("node:fs");
            const { join } = await import("node:path");
            const handoff = buildHandoffData({
              sessionId: `sprint-${Date.now()}`,
              projectPath: process.cwd(),
              goal: result.goal,
              taskQueue: result.tasks.map((t) => ({ ...t })),
              nextSprintBacklog: result.tasks.filter((t) => t.status === "failed").map((t) => ({ ...t })),
              promotedThisRun: [],
              agentProfiles: [],
              activeDecisions: [],
              rfcDocument: null,
            });
            const md = renderContextMarkdown(handoff);
            const outPath = join(process.cwd(), "CONTEXT.md");
            writeFileSync(outPath, md);
            ctx.addMessage("system", `${ICONS.success} Handoff saved: CONTEXT.md`);
            ctx.requestRender();
          } catch {
            // Handoff generation is non-critical
          }
        })();
      });

      runner.on(SprintEvent.Error, ({ error, task }: { error: Error; task?: SprintTask }) => {
        const taskInfo = task ? ` (task: ${task.description})` : "";
        ctx.addMessage("error", `Sprint error${taskInfo}: ${error.message}`);
        ctx.requestRender();
      });

      runner.on(SprintEvent.Warning, ({ warning, type }: { warning: string; type: string; taskIndex?: number }) => {
        ctx.addMessage("system", `[${type}] ${warning}`);
        ctx.requestRender();
      });

      runner.on(SprintEvent.Paused, () => {
        ctx.addMessage("system", "Sprint paused. Use `/sprint resume` to continue.");
        ctx.requestRender();
      });

      runner.on(SprintEvent.Resumed, () => {
        ctx.addMessage("system", "Sprint resumed.");
        ctx.requestRender();
      });

      // ── Resolve team context from config ────────────────────────
      const { resolveTeamContext } = await import("../../sprint/team-resolver.js");
      const teamContext = await resolveTeamContext();

      // ── Auto-approve tool calls during sprint ───────────────────
      const sprintAutoApprove = ({ approve }: { approve: (always?: boolean) => void }) => {
        approve();
      };
      deps.toolExecutor?.prependListener(
        "tool:confirmation_needed" as string,
        sprintAutoApprove,
      );

      // ── Run the sprint ───────────────────────────────────────────
      try {
        await runner.run(goal, {
          ...(teamContext ? { teamContext } : {}),
          ...(sessionLessons.length > 0 ? { lessons: sessionLessons } : {}),
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        ctx.addMessage("error", `Sprint failed: ${msg}`);
      } finally {
        // Remove sprint auto-approve — restore interactive confirmation
        deps.toolExecutor?.removeListener(
          "tool:confirmation_needed" as string,
          sprintAutoApprove,
        );
        if (activeRunner === runner) {
          activeRunner = null;
        }
      }
    },
  };
}
