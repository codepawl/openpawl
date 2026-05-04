/**
 * WriteLockManager — session-scoped, reentrant write locks for crew agents.
 *
 * Lock keys are conventionally namespaced:
 *   - `file:<absPath>`        guards a single file from concurrent writers
 *   - `artifact:<sessionId>`  serializes ArtifactStore writes for a session
 *
 * Semantics:
 *   - acquire blocks until the lock is granted or the timeout elapses.
 *   - tryAcquire never blocks; returns granted or denied with holder info.
 *   - release must come from the current holder; lock is handed off to the
 *     head of the wait queue, otherwise the lock entry is dropped.
 *   - Same-agent re-acquire is a no-op (reentrant). A single matching
 *     release returns the lock to the next waiter.
 *
 * The crew subagent runner (Prompt 5) is responsible for releasing all
 * locks held by an agent at turn end.
 */

import { debugLog } from "../debug/logger.js";

export const DEFAULT_LOCK_TIMEOUT_MS = 30_000;

export interface WriteLockGranted {
  granted: true;
  key: string;
  agent_id: string;
}

export interface WriteLockDenied {
  granted: false;
  key: string;
  agent_id: string;
  holder_agent: string;
  queued_count: number;
}

export type WriteLockResult = WriteLockGranted | WriteLockDenied;

export class WriteLockTimeoutError extends Error {
  constructor(
    public readonly key: string,
    public readonly agentId: string,
    public readonly timeoutMs: number,
    public readonly holderAgent: string,
  ) {
    super(
      `write lock '${key}' for agent '${agentId}' timed out after ${timeoutMs}ms (held by '${holderAgent}')`,
    );
    this.name = "WriteLockTimeoutError";
  }
}

export class WriteLockReleaseError extends Error {
  constructor(
    public readonly key: string,
    public readonly agentId: string,
    public readonly holderAgent: string,
  ) {
    super(
      `write lock '${key}' release attempted by '${agentId}' but held by '${holderAgent}'`,
    );
    this.name = "WriteLockReleaseError";
  }
}

interface QueueEntry {
  agent_id: string;
  resolve: () => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface LockState {
  holder: string;
  queue: QueueEntry[];
}

export class WriteLockManager {
  private locks = new Map<string, LockState>();

  acquire(
    key: string,
    agentId: string,
    timeoutMs: number = DEFAULT_LOCK_TIMEOUT_MS,
  ): Promise<void> {
    const state = this.locks.get(key);
    if (!state) {
      this.locks.set(key, { holder: agentId, queue: [] });
      debugLog("info", "crew", "write_lock_acquired", {
        data: { key, agent_id: agentId, queued_count: 0 },
      });
      return Promise.resolve();
    }
    if (state.holder === agentId) {
      return Promise.resolve();
    }
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        const idx = state.queue.findIndex((e) => e.timer === timer);
        if (idx !== -1) state.queue.splice(idx, 1);
        debugLog("warn", "crew", "write_lock_timeout", {
          data: {
            key,
            agent_id: agentId,
            holder: state.holder,
            timeout_ms: timeoutMs,
          },
        });
        reject(new WriteLockTimeoutError(key, agentId, timeoutMs, state.holder));
      }, timeoutMs);
      if (typeof timer.unref === "function") timer.unref();
      state.queue.push({ agent_id: agentId, resolve, reject, timer });
      debugLog("debug", "crew", "write_lock_queued", {
        data: {
          key,
          agent_id: agentId,
          holder: state.holder,
          queued_count: state.queue.length,
        },
      });
    });
  }

  tryAcquire(key: string, agentId: string): WriteLockResult {
    const state = this.locks.get(key);
    if (!state) {
      this.locks.set(key, { holder: agentId, queue: [] });
      debugLog("info", "crew", "write_lock_acquired", {
        data: { key, agent_id: agentId, queued_count: 0 },
      });
      return { granted: true, key, agent_id: agentId };
    }
    if (state.holder === agentId) {
      return { granted: true, key, agent_id: agentId };
    }
    debugLog("info", "crew", "write_lock_denied", {
      data: {
        key,
        agent_id: agentId,
        holder: state.holder,
        queued_count: state.queue.length,
      },
    });
    return {
      granted: false,
      key,
      agent_id: agentId,
      holder_agent: state.holder,
      queued_count: state.queue.length,
    };
  }

  release(key: string, agentId: string): void {
    const state = this.locks.get(key);
    if (!state) return;
    if (state.holder !== agentId) {
      throw new WriteLockReleaseError(key, agentId, state.holder);
    }
    debugLog("info", "crew", "write_lock_released", {
      data: { key, agent_id: agentId, queued_count: state.queue.length },
    });
    const next = state.queue.shift();
    if (!next) {
      this.locks.delete(key);
      return;
    }
    clearTimeout(next.timer);
    state.holder = next.agent_id;
    debugLog("info", "crew", "write_lock_acquired", {
      data: {
        key,
        agent_id: next.agent_id,
        queued_count: state.queue.length,
        handed_off: true,
      },
    });
    next.resolve();
  }

  isHeld(key: string): boolean {
    return this.locks.has(key);
  }

  holderOf(key: string): string | null {
    return this.locks.get(key)?.holder ?? null;
  }

  queueDepth(key: string): number {
    return this.locks.get(key)?.queue.length ?? 0;
  }

  /** Release every lock currently held by `agentId`. Used at agent turn end. */
  releaseAllFor(agentId: string): string[] {
    const released: string[] = [];
    for (const key of Array.from(this.locks.keys())) {
      const state = this.locks.get(key);
      if (state && state.holder === agentId) {
        this.release(key, agentId);
        released.push(key);
      }
    }
    return released;
  }
}
