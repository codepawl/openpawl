/**
 * ChatGPT Plus/Pro subscription OAuth provider.
 * Uses OpenAI SDK with OAuth access tokens instead of API keys.
 */

import OpenAI from "openai";
import type { StreamChunk, StreamOptions } from "./stream-types.js";
import type { StreamProvider } from "./provider.js";
import { ProviderError } from "./types.js";
import { logger } from "../core/logger.js";

const DEFAULT_MODEL = "gpt-5.3-codex";
const REFRESH_BUFFER_MS = 5 * 60 * 1000;

export interface ChatGPTOAuthConfig {
  oauthToken?: string;
  refreshToken?: string;
  tokenExpiry?: number;
  model?: string;
}

export class ChatGPTOAuthProvider implements StreamProvider {
  readonly name = "chatgpt";
  private client: OpenAI | null = null;
  private oauthToken: string | null;
  private refreshToken: string | null;
  private tokenExpiry: number;
  private readonly model: string;
  private available = true;

  constructor(config: ChatGPTOAuthConfig) {
    this.oauthToken = config.oauthToken ?? null;
    this.refreshToken = config.refreshToken ?? null;
    this.tokenExpiry = config.tokenExpiry ?? 0;
    this.model = config.model ?? DEFAULT_MODEL;
  }

  private getClient(): OpenAI {
    if (!this.oauthToken) {
      throw new ProviderError({
        provider: "chatgpt",
        code: "CHATGPT_OAUTH_REQUIRED",
        message: "No ChatGPT OAuth token. Run: teamclaw providers add chatgpt",
        isFallbackTrigger: true,
      });
    }
    if (!this.client || this.client.apiKey !== this.oauthToken) {
      this.client = new OpenAI({ apiKey: this.oauthToken, baseURL: "https://api.openai.com/v1" });
    }
    return this.client;
  }

  async *stream(prompt: string, options?: StreamOptions): AsyncGenerator<StreamChunk, void, undefined> {
    const client = this.getClient();
    const model = options?.model ?? this.model;

    const messages: OpenAI.ChatCompletionMessageParam[] = [];
    if (options?.systemPrompt) messages.push({ role: "system", content: options.systemPrompt });
    messages.push({ role: "user", content: prompt });

    logger.debug(`[chatgpt] streaming with model=${model}`);

    try {
      const stream = await client.chat.completions.create(
        { model, messages, temperature: options?.temperature, stream: true, stream_options: { include_usage: true } },
        { signal: options?.signal },
      );

      let usage: { promptTokens: number; completionTokens: number } | undefined;

      for await (const chunk of stream) {
        const delta = chunk.choices[0]?.delta;
        if (delta?.content) yield { content: delta.content, done: false };
        if (chunk.usage) {
          usage = { promptTokens: chunk.usage.prompt_tokens, completionTokens: chunk.usage.completion_tokens };
        }
      }

      yield { content: "", done: true, usage };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const isAuth = message.includes("401") || message.includes("invalid_api_key");
      const isRateLimit = message.includes("429") || message.includes("rate_limit");

      throw new ProviderError({
        provider: "chatgpt",
        code: isAuth ? "CHATGPT_TOKEN_EXPIRED" : isRateLimit ? "RATE_LIMITED" : "STREAM_FAILED",
        message: `ChatGPT API error: ${message}`,
        statusCode: isAuth ? 401 : isRateLimit ? 429 : undefined,
        isFallbackTrigger: isAuth || isRateLimit,
        cause: err,
      });
    }
  }

  async healthCheck(): Promise<boolean> {
    if (!this.oauthToken) return false;
    try {
      const client = this.getClient();
      await client.models.list();
      return true;
    } catch {
      return false;
    }
  }

  isAvailable(): boolean { return this.oauthToken != null && this.available; }
  setAvailable(available: boolean): void { this.available = available; }
}
