/**
 * Versioned serialization for session state.
 * Handles forward/backward compatibility via version field.
 */

import { Result, ok, err } from "neverthrow";
import type { SessionState, SessionError } from "./session-state.js";
import { Session } from "./session.js";

const CURRENT_VERSION = 1;

interface SerializedSession {
  version: number;
  state: SessionState;
}

export function serialize(session: Session): string {
  const payload: SerializedSession = {
    version: CURRENT_VERSION,
    state: session.toJSON(),
  };
  return JSON.stringify(payload);
}

export function deserialize(raw: string): Result<SessionState, SessionError> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    return err({
      type: "serialization_failed",
      cause: `Invalid JSON: ${e instanceof Error ? e.message : String(e)}`,
    });
  }

  if (!parsed || typeof parsed !== "object") {
    return err({
      type: "serialization_failed",
      cause: "Expected an object at top level",
    });
  }

  const obj = parsed as Record<string, unknown>;

  if (typeof obj.version !== "number") {
    return err({
      type: "serialization_failed",
      cause: "Missing or invalid 'version' field",
    });
  }

  // Future: if obj.version < CURRENT_VERSION → run migrations
  // For now, only version 1 exists.

  const state = obj.state as Record<string, unknown> | undefined;
  if (!state || typeof state !== "object") {
    return err({
      type: "serialization_failed",
      cause: "Missing 'state' field",
    });
  }

  // Validate required fields
  if (typeof state.id !== "string") {
    return err({ type: "serialization_failed", cause: "Missing state.id" });
  }
  if (typeof state.createdAt !== "string") {
    return err({ type: "serialization_failed", cause: "Missing state.createdAt" });
  }
  if (!Array.isArray(state.messages)) {
    return err({ type: "serialization_failed", cause: "Missing state.messages array" });
  }

  // Apply defaults for optional fields that may be missing (backward compat)
  const defaults: Partial<SessionState> = {
    title: "New session",
    updatedAt: state.createdAt as string,
    status: "active",
    messageCount: (state.messages as unknown[]).length,
    activeAgents: [],
    agentStates: {},
    toolExecutions: [],
    pendingConfirmations: [],
    workingDirectory: ".",
    trackedFiles: [],
    modifiedFiles: [],
    totalInputTokens: 0,
    totalOutputTokens: 0,
    providerBreakdown: {},
    compressionCheckpoint: 0,
    compressedSummary: null,
    lastCheckpointAt: state.createdAt as string,
    checkpointVersion: 0,
  };

  // Merge: keep everything from state (including unknown fields), fill missing with defaults
  const merged = { ...defaults, ...state } as SessionState;

  return ok(merged);
}
