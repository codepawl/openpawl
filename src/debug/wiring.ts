/**
 * Debug logger wiring — attaches event listeners to router, sprint, and tool systems.
 * Each function returns a cleanup callback that removes all listeners.
 * No-op when OPENPAWL_DEBUG is not set.
 */

import { debugLog, isDebugEnabled, truncateStr, TRUNCATION } from "./logger.js";
import { RouterEvent, SprintEvent, ToolEvent, SessionEvent } from "../router/event-types.js";
import type { EventEmitter } from "node:events";
import { platform, release, arch } from "node:os";

// ── Helpers ────────────────────────────────────────────────────────────

function noop(): void {}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Listener = (...args: any[]) => void;

function attach(
  emitter: EventEmitter,
  event: string,
  handler: Listener,
): () => void {
  emitter.on(event, handler);
  return () => emitter.off(event, handler);
}

// ── Router wiring ──────────────────────────────────────────────────────

/**
 * Wire debug logging to a PromptRouter (or Dispatcher).
 * Listens to: Start, AgentStart, AgentDone, AgentTool, Done, Error, Decision.
 */
export function wireDebugToRouter(router: EventEmitter): () => void {
  if (!isDebugEnabled()) return noop;

  const agentStartTimes = new Map<string, number>();
  const cleanups: Array<() => void> = [];

  cleanups.push(
    attach(router, RouterEvent.Start, (sessionId: string, decision: unknown) => {
      const d = decision as Record<string, unknown>;
      debugLog("info", "router", "dispatch:start", {
        data: {
          sessionId,
          strategy: d.strategy,
          agentCount: Array.isArray(d.agents) ? d.agents.length : 0,
        },
      });
    }),
  );

  cleanups.push(
    attach(router, RouterEvent.AgentStart, (sessionId: string, agentId: string) => {
      agentStartTimes.set(agentId, Date.now());
      debugLog("info", "router", "dispatch:agent:start", {
        data: { sessionId, agentId },
      });
    }),
  );

  cleanups.push(
    attach(
      router,
      RouterEvent.AgentDone,
      (sessionId: string, agentId: string, result: unknown) => {
        const start = agentStartTimes.get(agentId);
        const duration = start ? Date.now() - start : undefined;
        agentStartTimes.delete(agentId);

        const r = result as Record<string, unknown>;
        debugLog("info", "router", "dispatch:agent:done", {
          data: {
            sessionId,
            agentId,
            outputTokens: r.outputTokens,
            inputTokens: r.inputTokens,
            hasError: !!r.error,
          },
          duration,
        });
      },
    ),
  );

  cleanups.push(
    attach(
      router,
      RouterEvent.AgentTool,
      (_sessionId: string, agentId: string, toolName: string, status: string) => {
        debugLog("debug", "router", "dispatch:agent:tool", {
          data: { agentId, toolName, status },
        });
      },
    ),
  );

  cleanups.push(
    attach(router, RouterEvent.Done, (sessionId: string) => {
      debugLog("info", "router", "dispatch:done", {
        data: { sessionId },
      });
    }),
  );

  cleanups.push(
    attach(router, RouterEvent.Error, (_sessionId: string, error: unknown) => {
      const msg =
        error instanceof Error
          ? error.message
          : typeof error === "string"
            ? error
            : JSON.stringify(error);
      debugLog("error", "router", "dispatch:error", {
        error: msg,
      });
    }),
  );

  cleanups.push(
    attach(router, RouterEvent.Decision, (_sessionId: string, decision: unknown) => {
      const d = decision as Record<string, unknown>;
      debugLog("debug", "router", "router:decision", {
        data: {
          strategy: d.strategy,
          requiresConfirmation: d.requiresConfirmation,
          agentCount: Array.isArray(d.agents) ? d.agents.length : 0,
        },
      });
    }),
  );

  return () => {
    for (const cleanup of cleanups) cleanup();
    agentStartTimes.clear();
  };
}

// ── Tool executor wiring ───────────────────────────────────────────────

/**
 * Wire debug logging to a ToolExecutor.
 * Listens to: Start, Done, Error.
 */
export function wireDebugToToolExecutor(executor: EventEmitter): () => void {
  if (!isDebugEnabled()) return noop;

  const toolStartTimes = new Map<string, number>();
  const cleanups: Array<() => void> = [];

  cleanups.push(
    attach(
      executor,
      ToolEvent.Start,
      (executionId: string, toolName: string, agentId: string) => {
        toolStartTimes.set(executionId, Date.now());
        debugLog("debug", "tool", "tool:start", {
          data: { executionId, toolName, agentId },
        });
      },
    ),
  );

  cleanups.push(
    attach(
      executor,
      ToolEvent.Done,
      (executionId: string, toolName: string, output: unknown) => {
        const start = toolStartTimes.get(executionId);
        const duration = start ? Date.now() - start : undefined;
        toolStartTimes.delete(executionId);

        const o = output as Record<string, unknown>;
        debugLog("info", "tool", "tool:done", {
          data: {
            executionId,
            toolName,
            success: o.success,
            summaryLength: typeof o.summary === "string" ? o.summary.length : 0,
            filesModified: o.filesModified,
          },
          duration,
        });
      },
    ),
  );

  cleanups.push(
    attach(
      executor,
      ToolEvent.Error,
      (executionId: string, toolName: string, error: unknown) => {
        const start = toolStartTimes.get(executionId);
        const duration = start ? Date.now() - start : undefined;
        toolStartTimes.delete(executionId);

        const msg =
          error instanceof Error
            ? error.message
            : typeof error === "object" && error !== null
              ? (error as Record<string, unknown>).type as string
              : String(error);
        debugLog("error", "tool", "tool:error", {
          data: { executionId, toolName },
          duration,
          error: msg,
        });
      },
    ),
  );

  return () => {
    for (const cleanup of cleanups) cleanup();
    toolStartTimes.clear();
  };
}

// ── Sprint runner wiring ───────────────────────────────────────────────

/**
 * Wire debug logging to a SprintRunner.
 * Listens to all sprint lifecycle events.
 */
export function wireDebugToSprintRunner(runner: EventEmitter): () => void {
  if (!isDebugEnabled()) return noop;

  const taskStartTimes = new Map<string, number>();
  const cleanups: Array<() => void> = [];

  cleanups.push(
    attach(runner, SprintEvent.Start, (payload: { goal: string }) => {
      debugLog("info", "sprint", "sprint:start", {
        data: { goal: truncateStr(payload.goal, TRUNCATION.goalText) },
      });
    }),
  );

  cleanups.push(
    attach(
      runner,
      SprintEvent.Composition,
      (payload: { entries: Array<{ role: string; included: boolean }>; estimatedTasks: number }) => {
        debugLog("info", "sprint", "sprint:composition", {
          data: {
            estimatedTasks: payload.estimatedTasks,
            includedRoles: payload.entries
              .filter((e) => e.included)
              .map((e) => e.role),
            excludedRoles: payload.entries
              .filter((e) => !e.included)
              .map((e) => e.role),
          },
        });
      },
    ),
  );

  cleanups.push(
    attach(runner, SprintEvent.Planning, () => {
      debugLog("info", "sprint", "sprint:planning", {});
    }),
  );

  cleanups.push(
    attach(runner, SprintEvent.Plan, (payload: { tasks: Array<{ id: string; description: string; assignedAgent?: string }> }) => {
      debugLog("info", "sprint", "sprint:plan", {
        data: {
          taskCount: payload.tasks.length,
          tasks: payload.tasks.map((t) => ({
            id: t.id,
            description: truncateStr(t.description, 100),
            agent: t.assignedAgent,
          })),
        },
      });
    }),
  );

  cleanups.push(
    attach(
      runner,
      SprintEvent.RoundStart,
      (payload: { round: number; tasks: unknown[] }) => {
        debugLog("info", "sprint", "sprint:round:start", {
          data: { round: payload.round, taskCount: payload.tasks.length },
        });
      },
    ),
  );

  cleanups.push(
    attach(
      runner,
      SprintEvent.RoundComplete,
      (payload: { round: number; duration: number }) => {
        debugLog("info", "sprint", "sprint:round:complete", {
          data: { round: payload.round },
          duration: payload.duration,
        });
      },
    ),
  );

  cleanups.push(
    attach(
      runner,
      SprintEvent.TaskStart,
      (payload: { task: { id: string; description: string }; agentName: string }) => {
        taskStartTimes.set(payload.task.id, Date.now());
        debugLog("info", "sprint", "sprint:task:start", {
          data: {
            taskId: payload.task.id,
            agent: payload.agentName,
            description: truncateStr(payload.task.description, 100),
          },
        });
      },
    ),
  );

  cleanups.push(
    attach(
      runner,
      SprintEvent.TaskComplete,
      (payload: { task: { id: string; status: string; error?: string } }) => {
        const start = taskStartTimes.get(payload.task.id);
        const duration = start ? Date.now() - start : undefined;
        taskStartTimes.delete(payload.task.id);
        debugLog("info", "sprint", "sprint:task:complete", {
          data: {
            taskId: payload.task.id,
            status: payload.task.status,
          },
          duration,
          error: payload.task.error,
        });
      },
    ),
  );

  cleanups.push(
    attach(
      runner,
      SprintEvent.AgentTool,
      (payload: { agentName: string; toolName: string; status: string }) => {
        debugLog("debug", "sprint", "sprint:agent:tool", {
          data: {
            agentName: payload.agentName,
            toolName: payload.toolName,
            status: payload.status,
          },
        });
      },
    ),
  );

  cleanups.push(
    attach(runner, SprintEvent.Error, (payload: { error: Error }) => {
      debugLog("error", "sprint", "sprint:error", {
        error: payload.error.message,
      });
    }),
  );

  cleanups.push(
    attach(runner, SprintEvent.Warning, (payload: { warning: string; type?: string }) => {
      debugLog("warn", "sprint", "sprint:warning", {
        data: { type: payload.type },
        error: payload.warning,
      });
    }),
  );

  cleanups.push(
    attach(runner, SprintEvent.Done, (payload: { result: Record<string, unknown> }) => {
      const r = payload.result;
      debugLog("info", "sprint", "sprint:done", {
        data: {
          completedTasks: r.completedTasks,
          failedTasks: r.failedTasks,
          totalTasks: Array.isArray(r.tasks) ? r.tasks.length : 0,
        },
        duration: typeof r.duration === "number" ? r.duration : undefined,
      });
    }),
  );

  cleanups.push(
    attach(
      runner,
      SprintEvent.NeedsClarification,
      (payload: { questions: string[] }) => {
        debugLog("warn", "sprint", "sprint:needs_clarification", {
          data: { questions: payload.questions },
        });
      },
    ),
  );

  cleanups.push(
    attach(runner, SprintEvent.Paused, () => {
      debugLog("info", "sprint", "sprint:paused", {});
    }),
  );

  cleanups.push(
    attach(runner, SprintEvent.Resumed, () => {
      debugLog("info", "sprint", "sprint:resumed", {});
    }),
  );

  return () => {
    for (const cleanup of cleanups) cleanup();
    taskStartTimes.clear();
  };
}

// ── Session manager wiring ─────────────────────────────────────────────

/**
 * Wire debug logging to a SessionManager.
 * Listens to: Created, Resumed, Archived, CheckpointSaved.
 */
export function wireDebugToSessionManager(mgr: EventEmitter): () => void {
  if (!isDebugEnabled()) return noop;

  const cleanups: Array<() => void> = [];

  cleanups.push(
    attach(mgr, SessionEvent.Created, (sessionId: string) => {
      debugLog("info", "session", "session:created", {
        data: { sessionId },
      });
    }),
  );

  cleanups.push(
    attach(mgr, SessionEvent.Resumed, (sessionId: string) => {
      debugLog("info", "session", "session:resumed", {
        data: { sessionId },
      });
    }),
  );

  cleanups.push(
    attach(mgr, SessionEvent.Archived, (sessionId: string) => {
      debugLog("info", "session", "session:archived", {
        data: { sessionId },
      });
    }),
  );

  cleanups.push(
    attach(mgr, SessionEvent.CheckpointSaved, (sessionId: string) => {
      debugLog("debug", "session", "session:checkpoint", {
        data: { sessionId },
      });
    }),
  );

  return () => {
    for (const cleanup of cleanups) cleanup();
  };
}

// ── Startup config logging ─────────────────────────────────────────────

/**
 * Log startup configuration, environment, and runtime info.
 * Call once at session start.
 */
export function logStartupInfo(config: {
  mode?: string;
  provider?: string;
  model?: string;
  template?: string;
  goal?: string;
  workdir?: string;
  runs?: number;
}): void {
  if (!isDebugEnabled()) return;

  // Environment
  debugLog("info", "session", "startup:env", {
    data: {
      OPENPAWL_DEBUG: process.env.OPENPAWL_DEBUG ?? "unset",
      OPENPAWL_PROFILE: process.env.OPENPAWL_PROFILE ?? "unset",
      NODE_ENV: process.env.NODE_ENV ?? "unset",
    },
  });

  // Runtime
  debugLog("info", "session", "startup:runtime", {
    data: {
      nodeVersion: process.version,
      platform: platform(),
      arch: arch(),
      osRelease: release(),
      termColumns: process.stdout.columns ?? 0,
      termRows: process.stdout.rows ?? 0,
      isTTY: !!process.stdout.isTTY,
    },
  });

  // Config (provider, model, mode, template, etc.)
  debugLog("info", "session", "startup:config", {
    data: {
      mode: config.mode,
      provider: config.provider,
      model: config.model,
      template: config.template,
      goal: config.goal ? truncateStr(config.goal, TRUNCATION.goalText) : undefined,
      workdir: config.workdir,
      runs: config.runs,
    },
  });
}
