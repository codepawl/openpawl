/**
 * Session persistence layer.
 * Sessions stored as JSON files on disk with atomic writes.
 * LanceDB used for search/indexing only, not primary storage.
 *
 * Layout:
 *   ~/.openpawl/chat-sessions/
 *   ├── <session-id>/
 *   │   ├── state.json
 *   │   ├── checkpoint.json
 *   │   └── snapshots/
 *   └── index.json
 */

import { mkdir, readFile, writeFile, rename, rm, copyFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { Result, ok, err } from "neverthrow";
import type { SessionStatus, SessionState, SessionError, SessionListItem } from "./session-state.js";
import { shortId } from "./session-state.js";
import { Session } from "./session.js";
import { serialize, deserialize } from "./session-serializer.js";

const MAX_TOOL_OUTPUT_BYTES = 10_240; // 10 KB
const TRUNCATED_HEAD = 5_120;
const TRUNCATED_TAIL = 1_024;

export class SessionStore {
  private basePath: string;

  constructor(basePath?: string) {
    this.basePath = basePath ?? path.join(os.homedir(), ".openpawl", "chat-sessions");
  }

  // ========================= CRUD ==========================================

  async save(session: Session): Promise<Result<void, SessionError>> {
    try {
      const sessionDir = this.sessionDir(session.id);
      await mkdir(sessionDir, { recursive: true, mode: 0o700 });

      const data = serialize(session);
      await this.atomicWrite(path.join(sessionDir, "state.json"), data);
      await this.updateIndex(session);
      session.markClean();
      return ok(undefined);
    } catch (e) {
      return err({ type: "io_failed", cause: String(e) });
    }
  }

  /** Fast save for shutdown — writes state.json only, skips index update. */
  async quickSave(session: Session): Promise<Result<void, SessionError>> {
    try {
      const sessionDir = this.sessionDir(session.id);
      await mkdir(sessionDir, { recursive: true, mode: 0o700 });
      const data = serialize(session);
      await this.atomicWrite(path.join(sessionDir, "state.json"), data);
      session.markClean();
      return ok(undefined);
    } catch (e) {
      return err({ type: "io_failed", cause: String(e) });
    }
  }

  async load(sessionId: string): Promise<Result<Session, SessionError>> {
    const stateFile = path.join(this.sessionDir(sessionId), "state.json");
    const checkpointFile = path.join(this.sessionDir(sessionId), "checkpoint.json");

    // Try state.json first
    const stateResult = await this.loadFile(stateFile);
    if (stateResult.isOk()) return stateResult;

    // Fallback to checkpoint.json
    const cpResult = await this.loadFile(checkpointFile);
    if (cpResult.isOk()) return cpResult;

    return err({ type: "not_found", id: sessionId });
  }

  async delete(sessionId: string): Promise<Result<void, SessionError>> {
    try {
      const sessionDir = this.sessionDir(sessionId);
      if (existsSync(sessionDir)) {
        await rm(sessionDir, { recursive: true, force: true });
      }
      await this.removeFromIndex(sessionId);
      return ok(undefined);
    } catch (e) {
      return err({ type: "io_failed", cause: String(e) });
    }
  }

  async exists(sessionId: string): Promise<boolean> {
    return existsSync(path.join(this.sessionDir(sessionId), "state.json"));
  }

  // ========================= LISTING =======================================

  async list(options?: {
    status?: SessionStatus;
    limit?: number;
    offset?: number;
    sortBy?: "updatedAt" | "createdAt";
    sortOrder?: "asc" | "desc";
  }): Promise<Result<SessionListItem[], SessionError>> {
    try {
      let items = await this.readIndex();

      if (options?.status) {
        items = items.filter((i) => i.status === options.status);
      }

      const sortBy = options?.sortBy ?? "updatedAt";
      const sortOrder = options?.sortOrder ?? "desc";
      items.sort((a, b) => {
        const cmp = a[sortBy].localeCompare(b[sortBy]);
        return sortOrder === "desc" ? -cmp : cmp;
      });

      const offset = options?.offset ?? 0;
      const limit = options?.limit ?? items.length;
      items = items.slice(offset, offset + limit);

      return ok(items);
    } catch (e) {
      return err({ type: "io_failed", cause: String(e) });
    }
  }

  async listByWorkspace(workspacePath: string): Promise<Result<SessionListItem[], SessionError>> {
    const result = await this.list({ sortBy: "updatedAt", sortOrder: "desc" });
    if (result.isErr()) return result;
    return ok(result.value.filter(
      (item) => item.workingDirectory === workspacePath && item.status !== "archived",
    ));
  }

  // ========================= CHECKPOINT ====================================

  async saveCheckpoint(session: Session): Promise<Result<void, SessionError>> {
    try {
      const sessionDir = this.sessionDir(session.id);
      await mkdir(sessionDir, { recursive: true, mode: 0o700 });

      const data = serialize(session);
      await this.atomicWrite(path.join(sessionDir, "checkpoint.json"), data);
      return ok(undefined);
    } catch (e) {
      return err({ type: "io_failed", cause: String(e) });
    }
  }

  async loadCheckpoint(sessionId: string): Promise<Result<Session, SessionError>> {
    const cpFile = path.join(this.sessionDir(sessionId), "checkpoint.json");
    return this.loadFile(cpFile);
  }

  // ========================= SNAPSHOTS =====================================

  async saveFileSnapshot(
    sessionId: string,
    filePath: string,
  ): Promise<Result<string, SessionError>> {
    try {
      const snapshotDir = path.join(this.sessionDir(sessionId), "snapshots");
      await mkdir(snapshotDir, { recursive: true, mode: 0o700 });

      const ext = path.extname(filePath);
      const snapshotName = `${shortId(8)}${ext}.snap`;
      const snapshotPath = path.join(snapshotDir, snapshotName);

      await copyFile(filePath, snapshotPath);
      await this.setFilePermissions(snapshotPath);
      return ok(snapshotPath);
    } catch (e) {
      return err({ type: "io_failed", cause: String(e) });
    }
  }

  async restoreFileSnapshot(
    _sessionId: string,
    snapshotPath: string,
    targetPath: string,
  ): Promise<Result<void, SessionError>> {
    try {
      await mkdir(path.dirname(targetPath), { recursive: true });
      await copyFile(snapshotPath, targetPath);
      return ok(undefined);
    } catch (e) {
      return err({ type: "io_failed", cause: String(e) });
    }
  }

  // ========================= CLEANUP =======================================

  async archiveOlderThan(days: number): Promise<Result<number, SessionError>> {
    try {
      const cutoff = new Date(Date.now() - days * 86_400_000).toISOString();
      const items = await this.readIndex();
      let count = 0;

      for (const item of items) {
        if (
          item.updatedAt < cutoff &&
          item.status !== "archived"
        ) {
          const loadResult = await this.load(item.id);
          if (loadResult.isOk()) {
            const session = loadResult.value;
            session.setStatus("archived");
            await this.save(session);
            count++;
          }
        }
      }

      return ok(count);
    } catch (e) {
      return err({ type: "io_failed", cause: String(e) });
    }
  }

  async purgeArchived(): Promise<Result<number, SessionError>> {
    try {
      const items = await this.readIndex();
      let count = 0;

      for (const item of items) {
        if (item.status === "archived") {
          await this.delete(item.id);
          count++;
        }
      }

      return ok(count);
    } catch (e) {
      return err({ type: "io_failed", cause: String(e) });
    }
  }

  // ========================= INTERNAL ======================================

  private sessionDir(sessionId: string): string {
    return path.join(this.basePath, sessionId);
  }

  private async atomicWrite(filePath: string, data: string): Promise<void> {
    const tmpPath = filePath + ".tmp";
    await writeFile(tmpPath, data, { encoding: "utf-8", mode: 0o600 });
    await rename(tmpPath, filePath);
  }

  private async setFilePermissions(filePath: string): Promise<void> {
    // Best-effort — may fail on Windows
    try {
      const { chmod } = await import("node:fs/promises");
      await chmod(filePath, 0o600);
    } catch {
      // ignore
    }
  }

  private async loadFile(filePath: string): Promise<Result<Session, SessionError>> {
    try {
      const raw = await readFile(filePath, "utf-8");
      const result = deserialize(raw);
      if (result.isErr()) return err(result.error);
      return ok(new Session(result.value));
    } catch {
      return err({ type: "not_found", id: filePath });
    }
  }

  private async readIndex(): Promise<SessionListItem[]> {
    const indexFile = path.join(this.basePath, "index.json");
    try {
      const raw = await readFile(indexFile, "utf-8");
      return JSON.parse(raw) as SessionListItem[];
    } catch {
      return [];
    }
  }

  private async writeIndex(items: SessionListItem[]): Promise<void> {
    await mkdir(this.basePath, { recursive: true, mode: 0o700 });
    const indexFile = path.join(this.basePath, "index.json");
    await this.atomicWrite(indexFile, JSON.stringify(items, null, 2));
  }

  private async updateIndex(session: Session): Promise<void> {
    const items = await this.readIndex();
    const state = session.getState();
    const entry: SessionListItem = {
      id: state.id,
      title: state.title,
      updatedAt: state.updatedAt,
      createdAt: state.createdAt,
      status: state.status,
      messageCount: state.messageCount,
      workingDirectory: state.workingDirectory,
      preview: this.extractPreview(state),
    };

    const idx = items.findIndex((i) => i.id === entry.id);
    if (idx >= 0) {
      items[idx] = entry;
    } else {
      items.push(entry);
    }

    await this.writeIndex(items);
  }

  private extractPreview(state: SessionState): string {
    const firstUser = state.messages.find((m) => m.role === "user");
    if (!firstUser) return "";
    return firstUser.content.replace(/\s+/g, " ").trim().slice(0, 80);
  }

  private async removeFromIndex(sessionId: string): Promise<void> {
    const items = await this.readIndex();
    const filtered = items.filter((i) => i.id !== sessionId);
    await this.writeIndex(filtered);
  }
}

/**
 * Truncate tool output if > 10KB.
 * Returns first 5KB + truncation marker + last 1KB.
 */
export function truncateToolOutput(output: unknown): unknown {
  if (typeof output !== "string") return output;
  if (output.length <= MAX_TOOL_OUTPUT_BYTES) return output;

  const head = output.slice(0, TRUNCATED_HEAD);
  const tail = output.slice(-TRUNCATED_TAIL);
  return `${head}\n\n[... truncated ${output.length - TRUNCATED_HEAD - TRUNCATED_TAIL} bytes ...]\n\n${tail}`;
}
