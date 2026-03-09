/**
 * Vector Knowledge Base - RAG via ChromaDB with local embedding endpoint.
 * Falls back to JSON file when Chroma server is unavailable.
 */

import { ChromaClient } from "chromadb";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { CONFIG } from "./config.js";
import { logger } from "./logger.js";

const LESSONS_COLLECTION = "lessons";
const EMBEDDING_MODEL = "nomic-embed-text";
const DEFAULT_EMBEDDING_BASE = "http://localhost:11434";

class HttpEmbeddingFunction {
  private readonly baseUrl: string;
  private readonly model: string;
  private readonly token: string;

  constructor(opts: { baseUrl: string; model: string; token?: string }) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, "");
    this.model = opts.model;
    this.token = (opts.token ?? "").trim();
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
  if (CONFIG.verboseLogging) {
    logger.info(msg);
  }
}

export interface VectorMemoryStats {
  enabled: boolean;
  persistDirectory?: string;
  lessonsCount?: number;
  embeddingModel?: string;
  fallbackFile?: string;
}

export class VectorMemory {
  readonly persistDirectory: string;
  enabled = false;
  private client: ChromaClient | null = null;
  private lessonsCollection: Awaited<ReturnType<ChromaClient["getOrCreateCollection"]>> | null = null;
  private fallbackPath: string;

  constructor(persistDirectory = "data/vector_store") {
    this.persistDirectory = persistDirectory;
    this.fallbackPath = path.join(persistDirectory, "lessons_fallback.json");
  }

  async init(): Promise<void> {
    const chromaHost = process.env.CHROMADB_HOST ?? "localhost";
    const chromaPort =
      process.env.CHROMADB_PORT ?? (process.env.CHROMADB_HOST ? "8000" : "8020");
    const path = `http://${chromaHost}:${chromaPort}`;

    try {
      const embeddingBase =
        process.env["EMBEDDING_BASE_URL"] ??
        process.env["OPENCLAW_WORKER_URL"] ??
        DEFAULT_EMBEDDING_BASE;
      const embedder = new HttpEmbeddingFunction({
        baseUrl: embeddingBase,
        model: EMBEDDING_MODEL,
        token: process.env["OPENCLAW_TOKEN"],
      });

      this.client = new ChromaClient({ path });
      this.lessonsCollection = await this.client.getOrCreateCollection({
        name: LESSONS_COLLECTION,
        embeddingFunction: embedder,
        metadata: { description: "Lessons learned from team failures" },
      });

      this.enabled = true;
      log(`✅ Vector Memory initialized at ${path}`);
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      this.enabled = false;
      await this._ensureFallbackDir();
      log(
        `⚠️ ChromaDB unavailable (${detail}). Vector Memory initialized (Mode: Local JSON Fallback).`,
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
    if (this.enabled && this.lessonsCollection) {
      try {
        const id = `lesson_${Date.now()}`;
        const meta = { ...metadata, type: "lesson", timestamp: Date.now() / 1000 };
        await this.lessonsCollection.add({
          ids: [id],
          documents: [text],
          metadatas: [meta as Record<string, string | number | boolean>],
        });
        log(`📚 Stored lesson: "${text.slice(0, 50)}..."`);
        return true;
      } catch (err) {
        log(`❌ Failed to store lesson: ${err}`);
        return await this._fallbackAddLesson(text);
      }
    }
    return await this._fallbackAddLesson(text);
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
    if (this.enabled && this.lessonsCollection) {
      try {
        const count = await this.lessonsCollection.count();
        if (count === 0) return [];
        const results = await this.lessonsCollection.query({
          queryTexts: [query],
          nResults: Math.min(nResults, count),
        });
        const docs = results.documents?.[0];
        return (docs?.filter(Boolean) ?? []) as string[];
      } catch (err) {
        log(`❌ Retrieval failed: ${err}`);
      }
    }
    return await this._fallbackGetLessons();
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
    const fromChroma = this.enabled && this.lessonsCollection
      ? await this._getAllLessonsFromChroma()
      : [];
    const fromFallback = await this._fallbackGetLessons();
    const seen = new Set<string>();
    const merged: string[] = [];
    for (const l of [...fromFallback, ...fromChroma]) {
      if (l && !seen.has(l)) {
        seen.add(l);
        merged.push(l);
      }
    }
    return merged;
  }

  private async _getAllLessonsFromChroma(): Promise<string[]> {
    if (!this.lessonsCollection) return [];
    try {
      const result = await this.lessonsCollection.get();
      return (result.documents ?? []).filter(Boolean) as string[];
    } catch {
      return [];
    }
  }

  getStats(): VectorMemoryStats {
    if (!this.enabled) {
      return { enabled: false, fallbackFile: this.fallbackPath };
    }
    return {
      enabled: true,
      persistDirectory: this.persistDirectory,
      embeddingModel: EMBEDDING_MODEL,
      fallbackFile: this.fallbackPath,
    };
  }
}
