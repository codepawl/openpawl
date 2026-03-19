/**
 * Google Vertex AI provider — service account auth via gcloud CLI.
 */

import type { StreamChunk, StreamOptions } from "./stream-types.js";
import type { StreamProvider } from "./provider.js";
import { ProviderError } from "./types.js";
import { logger } from "../core/logger.js";
import { execSync } from "node:child_process";

const DEFAULT_MODEL = "gemini-3-pro";

export interface VertexProviderConfig {
  serviceAccountPath?: string;
  projectId?: string;
  region?: string;
  model?: string;
}

export class VertexProvider implements StreamProvider {
  readonly name = "vertex";
  private readonly projectId: string | null;
  private readonly region: string;
  private readonly model: string;
  private readonly serviceAccountPath: string | null;
  private available = true;
  private accessToken: string | null = null;
  private tokenExpiry = 0;

  constructor(config: VertexProviderConfig) {
    this.serviceAccountPath = config.serviceAccountPath ?? process.env.GOOGLE_APPLICATION_CREDENTIALS ?? null;
    this.projectId = config.projectId ?? process.env.GOOGLE_CLOUD_PROJECT ?? null;
    this.region = config.region ?? "us-central1";
    this.model = config.model ?? DEFAULT_MODEL;
  }

  private getAccessToken(): string {
    if (this.accessToken && Date.now() < this.tokenExpiry) return this.accessToken;

    try {
      const token = execSync("gcloud auth print-access-token", {
        encoding: "utf-8",
        timeout: 10_000,
        env: {
          ...process.env,
          ...(this.serviceAccountPath ? { GOOGLE_APPLICATION_CREDENTIALS: this.serviceAccountPath } : {}),
        },
      }).trim();

      this.accessToken = token;
      this.tokenExpiry = Date.now() + 55 * 60 * 1000;
      return token;
    } catch {
      throw new ProviderError({
        provider: "vertex",
        code: "AUTHENTICATION_FAILED",
        message: "Could not get GCP access token. Ensure gcloud CLI is installed and authenticated.",
        isFallbackTrigger: true,
      });
    }
  }

  async *stream(prompt: string, options?: StreamOptions): AsyncGenerator<StreamChunk, void, undefined> {
    const model = options?.model ?? this.model;
    const token = this.getAccessToken();
    logger.debug(`[vertex] streaming with model=${model}`);

    const baseUrl = `https://${this.region}-aiplatform.googleapis.com/v1/projects/${this.projectId}/locations/${this.region}/publishers/google/models/${model}:streamGenerateContent`;

    const res = await fetch(baseUrl, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: prompt }] }],
        ...(options?.systemPrompt ? { systemInstruction: { parts: [{ text: options.systemPrompt }] } } : {}),
        generationConfig: {
          ...(options?.temperature != null ? { temperature: options.temperature } : {}),
          maxOutputTokens: 4096,
        },
      }),
      signal: options?.signal,
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new ProviderError({
        provider: "vertex",
        code: res.status === 401 || res.status === 403 ? "AUTHENTICATION_FAILED" : "STREAM_FAILED",
        message: `Vertex AI error: ${res.status} ${text.slice(0, 200)}`,
        statusCode: res.status,
        isFallbackTrigger: true,
        cause: new Error(text),
      });
    }

    const body = await res.json() as Array<{ candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> }>;
    for (const chunk of body) {
      const text = chunk.candidates?.[0]?.content?.parts?.[0]?.text;
      if (text) yield { content: text, done: false };
    }
    yield { content: "", done: true };
  }

  async healthCheck(): Promise<boolean> {
    if (!this.projectId) return false;
    try {
      this.getAccessToken();
      return true;
    } catch {
      return false;
    }
  }

  isAvailable(): boolean {
    return this.projectId != null && this.available;
  }

  setAvailable(available: boolean): void {
    this.available = available;
  }
}
