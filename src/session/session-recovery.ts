/**
 * Crash recovery for sessions.
 * Detects sessions left in active/idle state by a crashed process,
 * then recovers them from state or checkpoint files.
 */

import { Result, ok, err } from "neverthrow";
import type { SessionError, SessionListItem } from "./session-state.js";
import { Session } from "./session.js";
import { SessionStore } from "./session-store.js";

export class SessionRecovery {
  private processStartTime: string;

  constructor(private store: SessionStore) {
    this.processStartTime = new Date().toISOString();
  }

  /**
   * Find sessions that were active/idle when the process died.
   * These have status active|idle but lastCheckpointAt is before process start.
   */
  async detectCrashedSessions(): Promise<SessionListItem[]> {
    const listResult = await this.store.list();
    if (listResult.isErr()) return [];

    return listResult.value.filter(
      (item) =>
        (item.status === "active" || item.status === "idle") &&
        item.updatedAt < this.processStartTime,
    );
  }

  /**
   * Recover a single crashed session.
   * 1. Load state.json (falls back to checkpoint.json)
   * 2. Cancel pending tool confirmations
   * 3. Save recovered state
   */
  async recover(sessionId: string): Promise<Result<Session, SessionError>> {
    // Load from store (already tries checkpoint fallback)
    const loadResult = await this.store.load(sessionId);
    if (loadResult.isErr()) {
      return err({ type: "recovery_failed", cause: `Failed to load session ${sessionId}: ${loadResult.error.type}` });
    }

    const session = loadResult.value;
    session.setStatus("recovering");

    // Cancel pending tool confirmations
    const state = session.getState();
    for (const conf of [...state.pendingConfirmations]) {
      session.resolveToolConfirmation(conf.executionId, false);
    }

    session.setStatus("active");
    session.markCheckpoint();

    const saveResult = await this.store.save(session);
    if (saveResult.isErr()) {
      return err({ type: "recovery_failed", cause: `Failed to save recovered session: ${saveResult.error.type}` });
    }

    return ok(session);
  }

  /**
   * Run full recovery on startup. Best-effort — never blocks startup.
   */
  async recoverAll(): Promise<{ recovered: string[]; failed: string[] }> {
    const crashed = await this.detectCrashedSessions();
    const recovered: string[] = [];
    const failed: string[] = [];

    for (const item of crashed) {
      const result = await this.recover(item.id);
      if (result.isOk()) {
        recovered.push(item.id);
      } else {
        failed.push(item.id);
        // Mark as crashed so it doesn't get re-detected
        const loadResult = await this.store.load(item.id);
        if (loadResult.isOk()) {
          loadResult.value.setStatus("crashed");
          await this.store.save(loadResult.value);
        }
      }
    }

    return { recovered, failed };
  }
}
