/**
 * Debug logger wiring — attaches event listeners to router, tool, and session systems.
 * Each function returns a cleanup callback that removes all listeners.
 * No-op when OPENPAWL_DEBUG is not set.
 */

import { debugLog, isDebugEnabled, truncateStr, TRUNCATION } from "./logger.js";
import { RouterEvent, ToolEvent, SessionEvent } from "../router/event-types.js";
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
