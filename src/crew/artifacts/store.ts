/**
 * ArtifactStore — typed, lock-gated, JSONL-persisted artifact storage.
 *
 * - Reads are universal and never blocked by the write lock.
 * - Writes acquire `artifact:<sessionId>` on the supplied WriteLockManager.
 * - Persistence is an append-only JSONL file at
 *     `<homeDir>/.openpawl/sessions/<sessionId>/artifacts.jsonl`.
 *   Replay on construction validates each line and silently skips malformed
 *   entries (debug-logged) so a partially flushed line cannot block startup.
 * - `reader()` returns a narrowed view with read/list only — that is what
 *   the subagent runner (Prompt 5) hands to agent code.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { debugLog } from "../../debug/logger.js";
import { WriteLockManager } from "../write-lock.js";
import {
  ArtifactSchema,
  type Artifact,
  type ArtifactId,
  type ArtifactKind,
} from "./types.js";

export const ARTIFACT_LOCK_PREFIX = "artifact:";

export interface ArtifactStoreOptions {
  sessionId: string;
  lockManager: WriteLockManager;
  homeDir?: string;
}

export interface ArtifactListFilter {
  kind?: ArtifactKind;
  phase_id?: string | null;
}

export interface ArtifactStoreReader {
  read(id: ArtifactId): Artifact | null;
  list(filter?: ArtifactListFilter): Artifact[];
}

export interface ArtifactWriteOk {
  written: true;
  id: ArtifactId;
}

export type ArtifactWriteRejectReason =
  | "lock_denied"
  | "no_such_predecessor"
  | "validation_failed"
  | "duplicate_id";

export interface ArtifactWriteRejected {
  written: false;
  reason: ArtifactWriteRejectReason;
  message: string;
  holder_agent?: string;
  queued_count?: number;
}

export type ArtifactWriteResult = ArtifactWriteOk | ArtifactWriteRejected;

function sessionsDir(homeDir: string, sessionId: string): string {
  return path.join(homeDir, ".openpawl", "sessions", sessionId);
}

export function artifactJsonlPath(
  sessionId: string,
  homeDir: string = os.homedir(),
): string {
  return path.join(sessionsDir(homeDir, sessionId), "artifacts.jsonl");
}

export class ArtifactStore implements ArtifactStoreReader {
  private artifacts = new Map<ArtifactId, Artifact>();
  private readonly lockKey: string;
  private readonly jsonlPath: string;

  constructor(private readonly opts: ArtifactStoreOptions) {
    this.lockKey = `${ARTIFACT_LOCK_PREFIX}${opts.sessionId}`;
    const homeDir = opts.homeDir ?? os.homedir();
    const dir = sessionsDir(homeDir, opts.sessionId);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    this.jsonlPath = path.join(dir, "artifacts.jsonl");
    if (existsSync(this.jsonlPath)) this.replay();
  }

  /** Replay JSONL into the in-memory map. Malformed lines are skipped. */
  private replay(): void {
    const raw = readFileSync(this.jsonlPath, "utf-8");
    let kept = 0;
    let skipped = 0;
    for (const line of raw.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const parsed = ArtifactSchema.parse(JSON.parse(trimmed));
        this.artifacts.set(parsed.id, parsed);
        kept += 1;
      } catch (err) {
        skipped += 1;
        debugLog("warn", "crew", "artifact_replay_skipped", {
          data: { line_preview: trimmed.slice(0, 120) },
          error: String(err),
        });
      }
    }
    debugLog("info", "crew", "artifact_store_replay", {
      data: {
        session_id: this.opts.sessionId,
        kept,
        skipped,
        path: this.jsonlPath,
      },
    });
  }

  reader(): ArtifactStoreReader {
    return {
      read: (id) => this.read(id),
      list: (filter) => this.list(filter),
    };
  }

  read(id: ArtifactId): Artifact | null {
    return this.artifacts.get(id) ?? null;
  }

  list(filter?: ArtifactListFilter): Artifact[] {
    const all = Array.from(this.artifacts.values());
    if (!filter) return all;
    return all.filter((a) => {
      if (filter.kind && a.kind !== filter.kind) return false;
      if (filter.phase_id !== undefined && a.phase_id !== filter.phase_id) return false;
      return true;
    });
  }

  /**
   * Write a new artifact. Acquires `artifact:<sessionId>` non-blockingly via
   * tryAcquire — if another agent already holds the lock the write is
   * rejected with a structured reason so the caller can decide whether to
   * back off or queue elsewhere.
   */
  write(artifact: Artifact, agentId: string): ArtifactWriteResult {
    const validation = ArtifactSchema.safeParse(artifact);
    if (!validation.success) {
      return {
        written: false,
        reason: "validation_failed",
        message: validation.error.issues
          .map((i) => `${i.path.join(".")}: ${i.message}`)
          .join("; "),
      };
    }
    const validated = validation.data;

    if (this.artifacts.has(validated.id)) {
      return {
        written: false,
        reason: "duplicate_id",
        message: `artifact id '${validated.id}' already exists`,
      };
    }

    const lock = this.opts.lockManager.tryAcquire(this.lockKey, agentId);
    if (!lock.granted) {
      debugLog("info", "crew", "artifact_write_denied", {
        data: {
          id: validated.id,
          kind: validated.kind,
          agent_id: agentId,
          holder: lock.holder_agent,
          queued_count: lock.queued_count,
        },
      });
      return {
        written: false,
        reason: "lock_denied",
        message: `artifact lock held by '${lock.holder_agent}'`,
        holder_agent: lock.holder_agent,
        queued_count: lock.queued_count,
      };
    }

    try {
      this.artifacts.set(validated.id, validated);
      appendFileSync(this.jsonlPath, JSON.stringify(validated) + "\n");
      debugLog("info", "crew", "artifact_written", {
        data: {
          id: validated.id,
          kind: validated.kind,
          author_agent: validated.author_agent,
          phase_id: validated.phase_id,
          supersedes: validated.supersedes,
        },
      });
      return { written: true, id: validated.id };
    } finally {
      this.opts.lockManager.release(this.lockKey, agentId);
    }
  }

  /**
   * Replace an older artifact. The new artifact's `supersedes` field is set
   * to `oldId` regardless of input. The old artifact is left in place — the
   * supersession chain is reconstructable from the JSONL.
   */
  supersede(
    oldId: ArtifactId,
    newArtifact: Artifact,
    agentId: string,
  ): ArtifactWriteResult {
    if (!this.artifacts.has(oldId)) {
      return {
        written: false,
        reason: "no_such_predecessor",
        message: `cannot supersede unknown artifact '${oldId}'`,
      };
    }
    const augmented: Artifact = { ...newArtifact, supersedes: oldId };
    return this.write(augmented, agentId);
  }

  /** Path to the JSONL file. Test/diagnostics only. */
  jsonlFilePath(): string {
    return this.jsonlPath;
  }
}
