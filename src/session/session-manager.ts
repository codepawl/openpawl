/**
 * Session Manager — the singleton orchestrator for all session operations.
 * Only entry point for session CRUD; nothing else touches SessionStore directly.
 *
 * Hooks into process SIGINT/SIGTERM to checkpoint active sessions on shutdown.
 */

import { EventEmitter } from "node:events";
import { Result, ok, err } from "neverthrow";
import type {
  SessionStatus,
  SessionMessage,
  SessionError,
  SessionListItem,
  ToolConfirmation,
  ToolExecution,
} from "./session-state.js";
import { createEmptySession } from "./session-state.js";
import { Session } from "./session.js";
import { SessionStore } from "./session-store.js";
import { SessionRecovery } from "./session-recovery.js";

// ---------------------------------------------------------------------------
// Typed events
// ---------------------------------------------------------------------------

export interface SessionManagerEvents {
  "session:created": (sessionId: string) => void;
  "session:resumed": (sessionId: string) => void;
  "session:archived": (sessionId: string) => void;
  "session:idle": (sessionId: string) => void;
  "session:recovered": (sessionId: string) => void;
  "message:added": (sessionId: string, message: SessionMessage) => void;
  "tool:requested": (sessionId: string, confirmation: ToolConfirmation) => void;
  "tool:completed": (sessionId: string, execution: ToolExecution) => void;
  "cost:updated": (sessionId: string, cost: { input: number; output: number; usd: number }) => void;
  "checkpoint:saved": (sessionId: string) => void;
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface SessionManagerConfig {
  sessionsDir?: string;
  idleTimeoutMinutes?: number;
  checkpointIntervalMs?: number;
  maxActiveSessions?: number;
  autoArchiveDays?: number;
}

const DEFAULTS = {
  idleTimeoutMinutes: 30,
  checkpointIntervalMs: 30_000,
  maxActiveSessions: 1,
  autoArchiveDays: 30,
} as const;

// ---------------------------------------------------------------------------
// Manager
// ---------------------------------------------------------------------------

export class SessionManager extends EventEmitter {
  private activeSessions = new Map<string, Session>();
  private store: SessionStore;
  private recovery: SessionRecovery;
  private config: Required<Omit<SessionManagerConfig, "sessionsDir">>;
  private checkpointInterval: ReturnType<typeof setInterval> | null = null;
  private idleTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private shutdownHooked = false;

  constructor(config?: SessionManagerConfig) {
    super();
    this.store = new SessionStore(config?.sessionsDir);
    this.recovery = new SessionRecovery(this.store);
    this.config = {
      idleTimeoutMinutes: config?.idleTimeoutMinutes ?? DEFAULTS.idleTimeoutMinutes,
      checkpointIntervalMs: config?.checkpointIntervalMs ?? DEFAULTS.checkpointIntervalMs,
      maxActiveSessions: config?.maxActiveSessions ?? DEFAULTS.maxActiveSessions,
      autoArchiveDays: config?.autoArchiveDays ?? DEFAULTS.autoArchiveDays,
    };
  }

  // ========================= LIFECYCLE =====================================

  async initialize(): Promise<Result<void, SessionError>> {
    try {
      // Run crash recovery (best-effort)
      const { recovered } = await this.recovery.recoverAll();
      for (const id of recovered) {
        this.emit("session:recovered", id);
      }

      // Start periodic checkpoint
      this.checkpointInterval = setInterval(
        () => void this.runCheckpointCycle(),
        this.config.checkpointIntervalMs,
      );
      // Don't let the timer keep the process alive
      if (this.checkpointInterval.unref) {
        this.checkpointInterval.unref();
      }

      // Hook process shutdown signals
      this.hookShutdown();

      return ok(undefined);
    } catch (e) {
      return err({ type: "io_failed", cause: String(e) });
    }
  }

  async shutdown(): Promise<void> {
    // Stop checkpoint timer
    if (this.checkpointInterval) {
      clearInterval(this.checkpointInterval);
      this.checkpointInterval = null;
    }

    // Clear idle timers
    for (const timer of this.idleTimers.values()) {
      clearTimeout(timer);
    }
    this.idleTimers.clear();

    // Quick-save all dirty sessions in parallel (skip index update + checkpoint)
    const saves: Promise<void>[] = [];
    for (const [, session] of this.activeSessions) {
      if (session.isDirty()) {
        saves.push(this.store.quickSave(session).then(() => {}).catch(() => {}));
      }
    }
    await Promise.allSettled(saves);

    this.activeSessions.clear();
  }

  // ========================= SESSION OPERATIONS ============================

  async create(workingDirectory?: string): Promise<Result<Session, SessionError>> {
    // Archive current active session
    const current = this.getActive();
    if (current) {
      await this.archive(current.id);
    }

    const state = createEmptySession(workingDirectory ?? process.cwd());
    const session = new Session(state);

    this.activeSessions.set(session.id, session);
    this.resetIdleTimer(session.id);

    // Persist initial state
    const saveResult = await this.store.save(session);
    if (saveResult.isErr()) return err(saveResult.error);

    this.emit("session:created", session.id);
    return ok(session);
  }

  async resume(sessionId: string): Promise<Result<Session, SessionError>> {
    // Archive current active session
    const current = this.getActive();
    if (current && current.id !== sessionId) {
      await this.archive(current.id);
    }

    const loadResult = await this.store.load(sessionId);
    if (loadResult.isErr()) return err(loadResult.error);

    const session = loadResult.value;
    session.setStatus("active");

    this.activeSessions.set(session.id, session);
    this.resetIdleTimer(session.id);

    const saveResult = await this.store.save(session);
    if (saveResult.isErr()) return err(saveResult.error);

    this.emit("session:resumed", session.id);
    return ok(session);
  }

  async resumeLatest(): Promise<Result<Session | null, SessionError>> {
    const listResult = await this.store.list({
      sortBy: "updatedAt",
      sortOrder: "desc",
      limit: 1,
    });
    if (listResult.isErr()) return err(listResult.error);

    const items = listResult.value;
    if (items.length === 0) return ok(null);

    const latest = items[0]!;
    if (latest.status === "archived" || latest.status === "crashed") {
      return ok(null);
    }

    return this.resume(latest.id);
  }

  async archive(sessionId: string): Promise<Result<void, SessionError>> {
    const session = this.activeSessions.get(sessionId);
    if (session) {
      session.setStatus("archived");
      session.markCheckpoint();
      await this.store.save(session);
      await this.store.saveCheckpoint(session);
      this.activeSessions.delete(sessionId);
      this.clearIdleTimer(sessionId);
      this.emit("session:archived", sessionId);
      return ok(undefined);
    }

    // Not in memory — load, update, save
    const loadResult = await this.store.load(sessionId);
    if (loadResult.isErr()) return err(loadResult.error);

    const loaded = loadResult.value;
    loaded.setStatus("archived");
    const saveResult = await this.store.save(loaded);
    if (saveResult.isErr()) return err(saveResult.error);

    this.emit("session:archived", sessionId);
    return ok(undefined);
  }

  getStore(): import("./session-store.js").SessionStore {
    return this.store;
  }

  getActive(): Session | null {
    for (const session of this.activeSessions.values()) {
      if (session.status === "active" || session.status === "idle") {
        return session;
      }
    }
    return null;
  }

  async list(options?: {
    status?: SessionStatus;
    limit?: number;
    sortBy?: "updatedAt" | "createdAt";
  }): Promise<Result<SessionListItem[], SessionError>> {
    return this.store.list(options);
  }

  async listByWorkspace(workspacePath: string): Promise<Result<SessionListItem[], SessionError>> {
    return this.store.listByWorkspace(workspacePath);
  }

  async delete(sessionId: string): Promise<Result<void, SessionError>> {
    this.activeSessions.delete(sessionId);
    this.clearIdleTimer(sessionId);
    return this.store.delete(sessionId);
  }

  // ========================= MESSAGE OPERATIONS ============================

  async addUserMessage(
    sessionId: string,
    content: string,
  ): Promise<Result<SessionMessage, SessionError>> {
    const session = this.activeSessions.get(sessionId);
    if (!session) return err({ type: "not_found", id: sessionId });

    const message = session.addMessage({ role: "user", content });
    this.resetIdleTimer(sessionId);
    this.emit("message:added", sessionId, message);
    return ok(message);
  }

  async addAssistantMessage(
    sessionId: string,
    content: string,
    agentId: string,
  ): Promise<Result<SessionMessage, SessionError>> {
    const session = this.activeSessions.get(sessionId);
    if (!session) return err({ type: "not_found", id: sessionId });

    const message = session.addMessage({ role: "assistant", content, agentId });
    this.resetIdleTimer(sessionId);
    this.emit("message:added", sessionId, message);
    return ok(message);
  }

  // ========================= INTERNAL ======================================

  private async runCheckpointCycle(): Promise<void> {
    for (const [id, session] of this.activeSessions) {
      if (session.isDirty()) {
        session.markCheckpoint();
        await this.store.save(session);
        await this.store.saveCheckpoint(session);
        session.markClean();
        this.emit("checkpoint:saved", id);
      }
    }
  }

  private resetIdleTimer(sessionId: string): void {
    this.clearIdleTimer(sessionId);

    const timer = setTimeout(() => {
      const session = this.activeSessions.get(sessionId);
      if (session && session.status === "active") {
        session.setStatus("idle");
        this.emit("session:idle", sessionId);
      }
    }, this.config.idleTimeoutMinutes * 60_000);

    // Don't keep the process alive for idle timers
    if (timer.unref) timer.unref();

    this.idleTimers.set(sessionId, timer);
  }

  private clearIdleTimer(sessionId: string): void {
    const existing = this.idleTimers.get(sessionId);
    if (existing) {
      clearTimeout(existing);
      this.idleTimers.delete(sessionId);
    }
  }

  private hookShutdown(): void {
    if (this.shutdownHooked) return;
    this.shutdownHooked = true;

    // SIGINT is handled by the TUI layer (app/index.ts cleanup function).
    // Only hook SIGTERM as a fallback for non-interactive shutdown.
    process.once("SIGTERM", () => {
      void this.shutdown();
    });
  }

  /**
   * Generate a title from the first user message.
   * Uses first 50 chars as fallback (no LLM call in v1).
   * Fire-and-forget — does not block.
   */
  async generateTitle(firstMessage: string): Promise<string> {
    // v1: simple truncation. Future: use cheapest LLM for 3-6 word summary.
    const cleaned = firstMessage.replace(/\n/g, " ").trim();
    return cleaned.length > 50 ? cleaned.slice(0, 50) + "..." : cleaned;
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createSessionManager(
  config?: SessionManagerConfig,
): SessionManager {
  return new SessionManager(config);
}
