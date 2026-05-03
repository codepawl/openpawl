/**
 * Typed event enums for all event systems.
 * Use these instead of string literals in .emit(), .on(), and .off() calls.
 */

// ── Router / Dispatch events ────────────────────────────────────────────────

export enum RouterEvent {
  Start = "dispatch:start",
  AgentStart = "dispatch:agent:start",
  AgentToken = "dispatch:agent:token",
  AgentTool = "dispatch:agent:tool",
  AgentDone = "dispatch:agent:done",
  Done = "dispatch:done",
  Error = "dispatch:error",
  Abort = "dispatch:abort",
  Decision = "router:decision",
  CommandClear = "command:clear",
  CommandCompact = "command:compact",
  CommandModel = "command:model",
  CommandExport = "command:export",
}

/** Dispatch event names only (subset forwarded from Dispatcher → PromptRouter). */
export const DISPATCH_EVENTS = [
  RouterEvent.Start,
  RouterEvent.AgentStart,
  RouterEvent.AgentToken,
  RouterEvent.AgentTool,
  RouterEvent.AgentDone,
  RouterEvent.Done,
  RouterEvent.Error,
  RouterEvent.Abort,
] as const;

// ── Tool events ─────────────────────────────────────────────────────────────

export enum ToolEvent {
  Start = "tool:start",
  Done = "tool:done",
  Error = "tool:error",
  ConfirmationNeeded = "tool:confirmation_needed",
  Aborted = "tool:aborted",
  Registered = "tool:registered",
  Unregistered = "tool:unregistered",
}

// ── Session events ──────────────────────────────────────────────────────────

export enum SessionEvent {
  Created = "session:created",
  Resumed = "session:resumed",
  Archived = "session:archived",
  Idle = "session:idle",
  Recovered = "session:recovered",
  MessageAdded = "message:added",
  ToolRequested = "tool:requested",
  ToolCompleted = "tool:completed",
  CostUpdated = "cost:updated",
  CheckpointSaved = "checkpoint:saved",
}
