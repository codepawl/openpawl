/**
 * Vector Knowledge Base - RAG via embedded LanceDB with local embedding endpoint.
 * Falls back to JSON file when LanceDB is unavailable or disabled.
 */

import * as lancedb from "@lancedb/lancedb";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { CONFIG, type MemoryBackend } from "./config.js";
import { logger, isDebugMode } from "./logger.js";

const LESSONS_TABLE = "lessons";
const PROJECT_MEMORIES_TABLE = "project_memories";
const RETRO_ACTIONS_TABLE = "retro_actions";
const EMBEDDING_MODEL = "nomic-embed-text";
const DEFAULT_EMBEDDING_BASE = "http://localhost:11434";

class HttpEmbeddingFunction {
  private readonly baseUrl: string;
  private readonly model: string;
  private readonly token: string;

  constructor(baseUrl: string, model: string, token: string) {
    this.baseUrl = baseUrl;
    this.model = model;
    this.token = token;
  }

  async generate(texts: string[]): Promise<number[][]> {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (this.token) {
      headers.Authorization = `Bearer ${this.token}`;
    }
    const payload = { model: this.model, input: texts };

    const cleanBase = this.baseUrl.replace(/\/+$/, "");
    const openAiBase = cleanBase.endsWith("/v1") ? cleanBase : `${cleanBase}/v1`;
    const candidateEndpoints = [`${openAiBase}/embeddings`, `${cleanBase}/api/embeddings`];

    let lastError = "";
    for (const endpoint of candidateEndpoints) {
      const res = await fetch(endpoint, {
        method: "POST",
        headers,
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        const detail = await res.text().catch(() => "");
        lastError = `(${res.status}) ${detail || res.statusText}`;
        continue;
      }
      const json = (await res.json()) as { embeddings?: number[][]; data?: Array<{ embedding?: number[] }> };
      if (Array.isArray(json.embeddings)) {
        return json.embeddings;
      }
      if (Array.isArray(json.data)) {
        return json.data.map((item) => item.embedding ?? []).filter((v) => Array.isArray(v));
      }
      lastError = "unexpected payload shape";
    }

    throw new Error(`Embedding endpoint failed: ${lastError}`);
  }
}

function log(msg: string): void {
  if (isDebugMode()) {
    logger.info(msg);
  }
}

export interface VectorMemoryStats {
  enabled: boolean;
  backend: MemoryBackend;
  persistDirectory?: string;
  lessonsCount?: number;
  embeddingModel?: string;
  fallbackFile?: string;
}

export class VectorMemory {
  readonly persistDirectory: string;
  enabled = false;
  readonly backend: MemoryBackend;
  private db: lancedb.Connection | null = null;
  private lessonsTable: lancedb.Table | null = null;
  private retroActionsTable: lancedb.Table | null = null;
  private projectMemoriesTable: lancedb.Table | null = null;
  private embedder: HttpEmbeddingFunction | null = null;
  private fallbackPath: string;

  constructor(persistDirectory = "data/vector_store", backend: MemoryBackend = CONFIG.memoryBackend) {
    this.persistDirectory = persistDirectory;
    this.backend = backend;
    this.fallbackPath = path.join(persistDirectory, "lessons_fallback.json");
  }

  async init(): Promise<void> {
    if (this.backend === "local_json") {
      this.enabled = false;
      await this._ensureFallbackDir();
      log("Vector Memory initialized in local_json mode.");
      return;
    }

    try {
      const embeddingBase =
        process.env["EMBEDDING_BASE_URL"] ??
        process.env["OPENCLAW_WORKER_URL"] ??
        DEFAULT_EMBEDDING_BASE;
      this.embedder = new HttpEmbeddingFunction(
        embeddingBase,
        EMBEDDING_MODEL,
        process.env["OPENCLAW_TOKEN"] ?? "",
      );
      const lanceUri = process.env["LANCEDB_URI"]?.trim() || path.join(this.persistDirectory, "lancedb");
      await mkdir(lanceUri, { recursive: true });
      this.db = await lancedb.connect(lanceUri);
      const tableNames = await this.db.tableNames();
      if (tableNames.includes(LESSONS_TABLE)) {
        this.lessonsTable = await this.db.openTable(LESSONS_TABLE);
      }
      if (tableNames.includes(PROJECT_MEMORIES_TABLE)) {
        this.projectMemoriesTable = await this.db.openTable(PROJECT_MEMORIES_TABLE);
      }
      if (tableNames.includes(RETRO_ACTIONS_TABLE)) {
        this.retroActionsTable = await this.db.openTable(RETRO_ACTIONS_TABLE);
      }

      this.enabled = true;
      log(`✅ Vector Memory (LanceDB) initialized at ${lanceUri}`);
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      this.enabled = false;
      this.db = null;
      this.lessonsTable = null;
      this.embedder = null;
      await this._ensureFallbackDir();
      log(
        `⚠️ LanceDB unavailable (${detail}). Vector Memory initialized (Mode: Local JSON Fallback).`,
      );
    }
  }

  private async _ensureFallbackDir(): Promise<void> {
    try {
      await mkdir(this.persistDirectory, { recursive: true });
    } catch {
      // ignore
    }
  }

  async addLesson(text: string, metadata: Record<string, unknown> = {}): Promise<boolean> {
    if (this.enabled && this.db && this.embedder) {
      try {
        const vector = (await this.embedder.generate([text]))[0] ?? [];
        if (!Array.isArray(vector) || vector.length === 0) {
          throw new Error("empty embedding vector");
        }
        const id = `lesson_${Date.now()}`;
        const row = {
          id,
          text,
          vector,
          metadata_json: JSON.stringify(metadata),
          timestamp: Date.now() / 1000,
          type: "lesson",
        };
        if (!this.lessonsTable) {
          this.lessonsTable = await this.db.createTable(LESSONS_TABLE, [row]);
        } else {
          await this.lessonsTable.add([row]);
        }
        log(`📚 Stored lesson: "${text.slice(0, 50)}..."`);
        return true;
      } catch (err) {
        log(`❌ Failed to store lesson: ${err}`);
        return await this._fallbackAddLesson(text);
      }
    }
    return await this._fallbackAddLesson(text);
  }

  async addRetroActionItem(text: string, metadata: Record<string, unknown> = {}): Promise<boolean> {
    if (this.enabled && this.db && this.embedder) {
      try {
        const vector = (await this.embedder.generate([text]))[0] ?? [];
        if (!Array.isArray(vector) || vector.length === 0) {
          throw new Error("empty embedding vector");
        }
        const id = `retro_${Date.now()}`;
        const row = {
          id,
          text,
          vector,
          metadata_json: JSON.stringify(metadata),
          timestamp: Date.now() / 1000,
          type: "retro_action",
        };
        if (!this.retroActionsTable) {
          this.retroActionsTable = await this.db.createTable(RETRO_ACTIONS_TABLE, [row]);
        } else {
          await this.retroActionsTable.add([row]);
        }
        log(`📋 Stored retro action item: "${text.slice(0, 50)}..."`);
        return true;
      } catch (err) {
        log(`❌ Failed to store retro action item: ${err}`);
        return false;
      }
    }
    return false;
  }

  private async _fallbackAddLesson(text: string): Promise<boolean> {
    try {
      await this._ensureFallbackDir();
      let lessons: string[] = [];
      try {
        const raw = await readFile(this.fallbackPath, "utf-8");
        lessons = JSON.parse(raw) as string[];
      } catch {
        // file missing or invalid
      }
      lessons.push(text);
      await writeFile(this.fallbackPath, JSON.stringify(lessons, null, 2));
      log(`📚 Stored lesson (fallback): "${text.slice(0, 50)}..."`);
      return true;
    } catch (err) {
      log(`❌ Fallback store failed: ${err}`);
      return false;
    }
  }

  async retrieveRelevantLessons(query: string, nResults = 5): Promise<string[]> {
    if (this.enabled && this.lessonsTable && this.embedder) {
      try {
        const count = await this.lessonsTable.countRows();
        if (count === 0) return [];
        const vector = (await this.embedder.generate([query]))[0] ?? [];
        if (!Array.isArray(vector) || vector.length === 0) return [];
        const results = (await this.lessonsTable
          .vectorSearch(vector)
          .limit(Math.min(nResults, count))
          .toArray()) as Array<Record<string, unknown>>;
        return results
          .map((row) => (typeof row["text"] === "string" ? row["text"] : ""))
          .filter((doc): doc is string => doc.length > 0);
      } catch (err) {
        log(`❌ Retrieval failed: ${err}`);
      }
    }
    return await this._fallbackGetLessons();
  }

  async retrieveRelevantRetroActions(
    query: string,
    nResults = 5
  ): Promise<Array<{ text: string; metadata: Record<string, unknown> }>> {
    if (this.enabled && this.retroActionsTable && this.embedder) {
      try {
        const count = await this.retroActionsTable.countRows();
        if (count === 0) return [];
        const vector = (await this.embedder.generate([query]))[0] ?? [];
        if (!Array.isArray(vector) || vector.length === 0) return [];
        const results = (await this.retroActionsTable
          .vectorSearch(vector)
          .limit(Math.min(nResults, count))
          .toArray()) as Array<Record<string, unknown>>;
        return results.map((row) => ({
          text: typeof row["text"] === "string" ? row["text"] : "",
          metadata: typeof row["metadata_json"] === "string"
            ? JSON.parse(row["metadata_json"])
            : {},
        })).filter((item): item is { text: string; metadata: Record<string, unknown> } => item.text.length > 0);
      } catch (err) {
        log(`❌ Retro action retrieval failed: ${err}`);
      }
    }
    return [];
  }

  private async _fallbackGetLessons(): Promise<string[]> {
    try {
      const raw = await readFile(this.fallbackPath, "utf-8");
      return JSON.parse(raw) as string[];
    } catch {
      return [];
    }
  }

  async getCumulativeLessons(): Promise<string[]> {
    const fromLanceDb = this.enabled && this.lessonsTable
      ? await this._getAllLessonsFromLanceDb()
      : [];
    const fromFallback = await this._fallbackGetLessons();
    const seen = new Set<string>();
    const merged: string[] = [];
    for (const l of [...fromFallback, ...fromLanceDb]) {
      if (l && !seen.has(l)) {
        seen.add(l);
        merged.push(l);
      }
    }
    return merged;
  }

  async addProjectMemory(
    summary: string,
    metadata: Record<string, unknown> = {}
  ): Promise<boolean> {
    if (this.enabled && this.db && this.embedder) {
      try {
        const vector = (await this.embedder.generate([summary]))[0] ?? [];
        if (!Array.isArray(vector) || vector.length === 0) {
          throw new Error("empty embedding vector");
        }
        const id = `memory_${Date.now()}`;
        const row = {
          id,
          text: summary,
          vector,
          metadata_json: JSON.stringify(metadata),
          timestamp: Date.now() / 1000,
          workspace_path: (metadata.workspace_path as string) ?? "",
        };
        if (!this.projectMemoriesTable) {
          this.projectMemoriesTable = await this.db.createTable(PROJECT_MEMORIES_TABLE, [row]);
        } else {
          await this.projectMemoriesTable.add([row]);
        }
        log(`📚 Stored project memory: "${summary.slice(0, 50)}..."`);
        return true;
      } catch (err) {
        log(`❌ Failed to store project memory: ${err}`);
        return await this._fallbackAddProjectMemory(summary);
      }
    }
    return await this._fallbackAddProjectMemory(summary);
  }

  private async _fallbackAddProjectMemory(summary: string): Promise<boolean> {
    try {
      await this._ensureFallbackDir();
      const fallbackPath = path.join(this.persistDirectory, "project_memories_fallback.json");
      let memories: string[] = [];
      try {
        const raw = await readFile(fallbackPath, "utf-8");
        memories = JSON.parse(raw) as string[];
      } catch {
        // file missing or invalid
      }
      memories.push(summary);
      await writeFile(fallbackPath, JSON.stringify(memories, null, 2));
      log(`📚 Stored project memory (fallback): "${summary.slice(0, 50)}..."`);
      return true;
    } catch (err) {
      log(`❌ Fallback store failed: ${err}`);
      return false;
    }
  }

  async retrieveRelevantMemories(query: string, nResults = 2): Promise<string[]> {
    if (this.enabled && this.projectMemoriesTable && this.embedder) {
      try {
        const count = await this.projectMemoriesTable.countRows();
        if (count === 0) return [];
        const vector = (await this.embedder.generate([query]))[0] ?? [];
        if (!Array.isArray(vector) || vector.length === 0) return [];
        const results = (await this.projectMemoriesTable
          .vectorSearch(vector)
          .limit(Math.min(nResults, count))
          .toArray()) as Array<Record<string, unknown>>;
        return results
          .map((row) => (typeof row["text"] === "string" ? row["text"] : ""))
          .filter((doc): doc is string => doc.length > 0);
      } catch (err) {
        log(`❌ Memory retrieval failed: ${err}`);
      }
    }
    return await this._fallbackGetProjectMemories();
  }

  private async _fallbackGetProjectMemories(): Promise<string[]> {
    try {
      const fallbackPath = path.join(this.persistDirectory, "project_memories_fallback.json");
      const raw = await readFile(fallbackPath, "utf-8");
      return JSON.parse(raw) as string[];
    } catch {
      return [];
    }
  }

  private async _getAllLessonsFromLanceDb(): Promise<string[]> {
    if (!this.lessonsTable) return [];
    try {
      const rows = (await this.lessonsTable.query().select(["text"]).toArray()) as Array<Record<string, unknown>>;
      return rows
        .map((row) => (typeof row["text"] === "string" ? row["text"] : ""))
        .filter((value): value is string => value.length > 0);
    } catch {
      return [];
    }
  }

  getStats(): VectorMemoryStats {
    if (!this.enabled) {
      return { enabled: false, backend: this.backend, fallbackFile: this.fallbackPath };
    }
    return {
      enabled: true,
      backend: this.backend,
      persistDirectory: this.persistDirectory,
      embeddingModel: EMBEDDING_MODEL,
      fallbackFile: this.fallbackPath,
    };
  }
}
