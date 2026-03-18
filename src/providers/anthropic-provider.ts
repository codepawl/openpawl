import Anthropic from "@anthropic-ai/sdk";
import type { StreamChunk, StreamOptions } from "../client/types.js";
import type { StreamProvider } from "./provider.js";
import { ProviderError } from "./types.js";
import { logger } from "../core/logger.js";

const DEFAULT_MODEL = "claude-sonnet-4-6";
const HEALTH_WINDOW_MS = 5 * 60 * 1000;

export interface AnthropicProviderConfig {
  apiKey?: string;
  model?: string;
}

export class AnthropicProvider implements StreamProvider {
  readonly name = "anthropic";
  private client: Anthropic | null = null;
  private readonly model: string;
  private readonly apiKey: string | null;
  private available = true;
  private lastSuccessAt = 0;

  constructor(config: AnthropicProviderConfig) {
    this.apiKey = process.env.ANTHROPIC_API_KEY ?? config.apiKey ?? null;
    this.model = config.model ?? DEFAULT_MODEL;
  }

  private getClient(): Anthropic {
    if (!this.client) {
      if (!this.apiKey) {
        throw new ProviderError({
          provider: "anthropic",
          code: "NOT_CONFIGURED",
          message: "No Anthropic API key configured",
          isFallbackTrigger: false,
        });
      }
      this.client = new Anthropic({ apiKey: this.apiKey });
    }
    return this.client;
  }

  async *stream(prompt: string, options?: StreamOptions): AsyncGenerator<StreamChunk, void, undefined> {
    const client = this.getClient();
    const params: Anthropic.MessageCreateParams = {
      model: options?.model ?? this.model,
      max_tokens: 4096,
      messages: [{ role: "user", content: prompt }],
    };
    if (options?.systemPrompt) {
      params.system = options.systemPrompt;
    }

    logger.debug(`[anthropic] streaming with model=${params.model}`);

    try {
      const stream = client.messages.stream(params);
      for await (const event of stream) {
        if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
          yield { content: event.delta.text, done: false };
        } else if (event.type === "message_stop") {
          let usage: { promptTokens: number; completionTokens: number } | undefined;
          try {
            const msg = await stream.finalMessage();
            if (msg?.usage) {
              usage = { promptTokens: msg.usage.input_tokens, completionTokens: msg.usage.output_tokens };
            }
          } catch {
            // Usage stats unavailable
          }
          yield { content: "", done: true, usage };
          this.lastSuccessAt = Date.now();
        }
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const isRateLimit = message.includes("rate_limit") || message.includes("429");
      throw new ProviderError({
        provider: "anthropic",
        code: isRateLimit ? "RATE_LIMITED" : "STREAM_FAILED",
        message: `Anthropic API error: ${message}`,
        statusCode: isRateLimit ? 429 : undefined,
        isFallbackTrigger: false,
        cause: err,
      });
    }
  }

  async healthCheck(): Promise<boolean> {
    if (!this.apiKey) return false;
    if (this.lastSuccessAt > 0 && Date.now() - this.lastSuccessAt < HEALTH_WINDOW_MS) return true;
    return true;
  }

  isAvailable(): boolean {
    return this.apiKey != null && this.available;
  }

  setAvailable(available: boolean): void {
    this.available = available;
  }
}
