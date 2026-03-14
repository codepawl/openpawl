/**
 * Node event parsing and bot action generation for the web UI.
 */

export function parseNodeEvent(
  nodeName: string,
  state: Record<string, unknown>
): Record<string, unknown> {
  const botStats = (state.bot_stats ?? {}) as Record<string, Record<string, unknown>>;
  const totalDone = Object.values(botStats).reduce(
    (s, x) => s + ((x?.tasks_completed as number) ?? 0),
    0
  );
  const totalFailed = Object.values(botStats).reduce(
    (s, x) => s + ((x?.tasks_failed as number) ?? 0),
    0
  );
  const snapshot = {
    cycle: state.cycle_count ?? 0,
    tasks_completed: totalDone,
    tasks_failed: totalFailed,
    last_quality_score: state.last_quality_score ?? 0,
    agent_messages: state.agent_messages ?? [],
    task_queue: state.task_queue ?? [],
    bot_stats: state.bot_stats ?? {},
  };

  let data: Record<string, unknown> = { message: `${nodeName} executed` };

  if (nodeName === "coordinator") {
    const taskQueue = (state.task_queue ?? []) as Record<string, unknown>[];
    const pending = taskQueue.filter((t) => t.status === "pending").length;
    data = {
      message: `Coordinator processed, ${pending} tasks pending`,
      pending_count: pending,
    };
  } else if (nodeName === "worker_execute") {
    const taskQueue = (state.task_queue ?? []) as Record<string, unknown>[];
    const lastTask =
      [...taskQueue].reverse().find((t) =>
        ["completed", "failed"].includes((t.status as string) ?? "")
      ) ?? {};
    const result = (lastTask.result ?? {}) as Record<string, unknown>;
    data = {
      task_id: lastTask.task_id ?? "",
      success: result.success ?? false,
      quality_score: result.quality_score ?? 0,
      assigned_to: lastTask.assigned_to ?? "",
      output: result.output ?? "",
      description: lastTask.description ?? "",
      message: result.success ? "✅ Task completed" : "❌ Task completed",
    };
  } else if (nodeName === "approval") {
    const pending = state.approval_pending as Record<string, unknown> | null;
    const resp = state.approval_response as Record<string, unknown> | null;
    data = {
      message: resp?.action ? `Approval: ${resp.action}` : "Awaiting approval",
      approval_pending: pending,
      approval_response: resp,
    };
  } else if (nodeName === "increment_cycle") {
    data = {
      cycle: state.cycle_count ?? 0,
      message: `Cycle ${state.cycle_count ?? 0} completed`,
    };
  }

  const botActions = getBotActions(nodeName, data);
  return {
    node: nodeName,
    data,
    state: snapshot,
    bot_actions: botActions,
    timestamp: new Date().toTimeString().slice(0, 8),
  };
}

export function getBotActions(nodeName: string, data: Record<string, unknown>): unknown[] {
  if (nodeName === "coordinator") {
    return [{ bot: "ceo", action: "walk_to", target: "meeting_table", then: "thinking" }];
  }
  if (nodeName === "worker_execute") {
    const success = data.success ?? false;
    const actions: unknown[] = [
      { bot: "sparki", action: "walk_to", target: "desk", then: "working" },
      { bot: "ceo", action: "idle", floor: 3 },
    ];
    if (success) {
      actions.push({ bot: "sparki", action: "celebrate", delay: 1.5 });
    } else {
      actions.push({ bot: "sparki", action: "react", emotion: "worried", delay: 1.5 });
    }
    return actions;
  }
  if (nodeName === "approval") {
    return [{ bot: "ceo", action: "wait", target: "approval" }];
  }
  if (nodeName === "increment_cycle") {
    return [
      { bot: "ceo", action: "return_to_office" },
      { bot: "sparki", action: "idle", floor: 2 },
    ];
  }
  return [];
}

export function buildWsValidationError(
  detail: string,
  issues: unknown = null,
): { type: "system"; payload: Record<string, unknown> } {
  return {
    type: "system",
    payload: {
      error: true,
      code: "INVALID_WS_PAYLOAD",
      message: detail,
      issues,
      timestamp: new Date().toISOString(),
    },
  };
}

export function normalizeIncomingWsMessage(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;

  const raw = value as Record<string, unknown>;
  const eventType = typeof raw.type === "string" ? raw.type : "";
  const alreadyEnvelope =
    ["telemetry", "terminal_out", "worker_status", "system"].includes(eventType) &&
    Object.prototype.hasOwnProperty.call(raw, "payload");
  if (alreadyEnvelope) return value;

  if (typeof raw.command === "string") {
    return {
      type: "system",
      payload: raw,
    };
  }

  if (raw.type === "UPDATE_TASK") {
    return {
      type: "worker_status",
      payload: raw,
    };
  }

  return value;
}
