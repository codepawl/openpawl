/**
 * OpenAI-compatible provider — works with OpenAI, OpenRouter, Ollama,
 * DeepSeek, Groq, Gemini, Grok, Mistral, Cerebras, Together, Fireworks,
 * Perplexity, Moonshot, ZAI, MiniMax, Cohere, OpenCode, Azure, LM Studio,
 * and any OpenAI-compatible endpoint.
 */

import OpenAI from "openai";
import type { StreamChunk, StreamOptions } from "./stream-types.js";
import type { StreamProvider } from "./provider.js";
import { ProviderError } from "./types.js";
import { logger } from "../core/logger.js";

export type OpenAIPreset =
  | "openai" | "openrouter" | "ollama" | "deepseek" | "groq" | "custom"
  | "gemini" | "grok" | "mistral" | "cerebras" | "together"
  | "fireworks" | "perplexity" | "moonshot" | "zai" | "minimax"
  | "cohere" | "opencode-zen" | "opencode-go" | "azure" | "lmstudio";

const PRESETS: Record<OpenAIPreset, { baseURL: string; envKey: string; defaultModel: string }> = {
  openai: {
    baseURL: "https://api.openai.com/v1",
    envKey: "OPENAI_API_KEY",
    defaultModel: "gpt-4o",
  },
  openrouter: {
    baseURL: "https://openrouter.ai/api/v1",
    envKey: "OPENROUTER_API_KEY",
    defaultModel: "anthropic/claude-opus-4-6",
  },
  ollama: {
    baseURL: "http://localhost:11434/v1",
    envKey: "",
    defaultModel: "llama3",
  },
  deepseek: {
    baseURL: "https://api.deepseek.com/v1",
    envKey: "DEEPSEEK_API_KEY",
    defaultModel: "deepseek-chat",
  },
  groq: {
    baseURL: "https://api.groq.com/openai/v1",
    envKey: "GROQ_API_KEY",
    defaultModel: "llama-3.3-70b-versatile",
  },
  custom: {
    baseURL: "",
    envKey: "",
    defaultModel: "",
  },
  gemini: { baseURL: "https://generativelanguage.googleapis.com/v1beta/openai/", envKey: "GOOGLE_API_KEY", defaultModel: "gemini-3-flash" },
  grok: { baseURL: "https://api.x.ai/v1", envKey: "XAI_API_KEY", defaultModel: "grok-4" },
  mistral: { baseURL: "https://api.mistral.ai/v1", envKey: "MISTRAL_API_KEY", defaultModel: "codestral" },
  cerebras: { baseURL: "https://api.cerebras.ai/v1", envKey: "CEREBRAS_API_KEY", defaultModel: "qwen3-coder-480b" },
  together: { baseURL: "https://api.together.xyz/v1", envKey: "TOGETHER_API_KEY", defaultModel: "moonshotai/Kimi-K2.5" },
  fireworks: { baseURL: "https://api.fireworks.ai/inference/v1", envKey: "FIREWORKS_API_KEY", defaultModel: "accounts/fireworks/models/deepseek-v3-2" },
  perplexity: { baseURL: "https://api.perplexity.ai", envKey: "PERPLEXITY_API_KEY", defaultModel: "sonar-pro" },
  moonshot: { baseURL: "https://api.moonshot.cn/v1", envKey: "MOONSHOT_API_KEY", defaultModel: "kimi-k2.5-instruct" },
  zai: { baseURL: "https://api.z.ai/api/paas/v4", envKey: "ZAI_API_KEY", defaultModel: "glm-5" },
  minimax: { baseURL: "https://api.minimax.io/v1", envKey: "MINIMAX_API_KEY", defaultModel: "minimax-m2.7" },
  cohere: { baseURL: "https://api.cohere.com/v2", envKey: "COHERE_API_KEY", defaultModel: "command-a-03-2025" },
  "opencode-zen": { baseURL: "https://opencode.ai/zen/v1", envKey: "OPENCODE_API_KEY", defaultModel: "claude-sonnet-4-6" },
  "opencode-go": { baseURL: "https://opencode.ai/zen/go/v1", envKey: "OPENCODE_GO_API_KEY", defaultModel: "kimi-k2.5" },
  azure: { baseURL: "", envKey: "AZURE_OPENAI_API_KEY", defaultModel: "gpt-4o" },
  lmstudio: { baseURL: "http://localhost:1234/v1", envKey: "", defaultModel: "" },
};

export interface OpenAICompatibleConfig {
  preset: OpenAIPreset;
  apiKey?: string;
  baseURL?: string;
  model?: string;
  /** Display name for logs / stats keys */
  name?: string;
}

export class OpenAICompatibleProvider implements StreamProvider {
  readonly name: string;
  private client: OpenAI | null = null;
  private readonly model: string;
  private readonly apiKey: string | null;
  private readonly baseURL: string;
  private available = true;
  private lastSuccessAt = 0;

  constructor(private readonly config: OpenAICompatibleConfig) {
    const preset = PRESETS[config.preset];
    this.name = config.name ?? config.preset;
    this.baseURL = config.baseURL ?? preset.baseURL;
    this.apiKey = config.apiKey ?? (preset.envKey ? (process.env[preset.envKey] ?? null) : null);
    this.model = config.model ?? preset.defaultModel;

    if (!this.baseURL && config.preset === "custom") {
      throw new Error("Custom provider requires a baseURL");
    }
  }

  private getClient(): OpenAI {
    if (!this.client) {
      this.client = new OpenAI({
        apiKey: this.apiKey ?? "ollama",
        baseURL: this.baseURL,
      });
    }
    return this.client;
  }

  async *stream(prompt: string, options?: StreamOptions): AsyncGenerator<StreamChunk, void, undefined> {
    const client = this.getClient();
    const model = options?.model ?? this.model;

    if (!model) {
      throw new ProviderError({
        provider: this.name,
        code: "NOT_CONFIGURED",
        message: `No model configured for ${this.name}`,
        isFallbackTrigger: false,
      });
    }

    const messages: OpenAI.ChatCompletionMessageParam[] = [];
    if (options?.systemPrompt) {
      messages.push({ role: "system", content: options.systemPrompt });
    }
    messages.push({ role: "user", content: prompt });

    logger.debug(`[${this.name}] streaming with model=${model}`);

    try {
      const stream = await client.chat.completions.create(
        {
          model,
          messages,
          temperature: options?.temperature,
          stream: true,
          stream_options: { include_usage: true },
        },
        { signal: options?.signal },
      );

      let usage: { promptTokens: number; completionTokens: number } | undefined;

      for await (const chunk of stream) {
        const delta = chunk.choices[0]?.delta;
        if (delta?.content) {
          yield { content: delta.content, done: false };
        }
        if (chunk.usage) {
          usage = {
            promptTokens: chunk.usage.prompt_tokens,
            completionTokens: chunk.usage.completion_tokens,
          };
        }
      }

      yield { content: "", done: true, usage };
      this.lastSuccessAt = Date.now();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const isRateLimit = message.includes("rate_limit") || message.includes("429");
      const isConnection = message.includes("ECONNREFUSED") || message.includes("fetch failed");
      throw new ProviderError({
        provider: this.name,
        code: isRateLimit ? "RATE_LIMITED" : isConnection ? "CONNECTION_FAILED" : "STREAM_FAILED",
        message: `${this.name} API error: ${message}`,
        statusCode: isRateLimit ? 429 : undefined,
        isFallbackTrigger: isConnection || isRateLimit,
        cause: err,
      });
    }
  }

  // Providers without a /models listing endpoint
  private static readonly NO_MODELS_ENDPOINT = new Set(["opencode-zen", "opencode-go"]);

  async healthCheck(): Promise<boolean> {
    if (!this.apiKey && this.config.preset !== "ollama" && this.config.preset !== "lmstudio") return false;
    if (this.lastSuccessAt > 0 && Date.now() - this.lastSuccessAt < 5 * 60 * 1000) return true;
    try {
      const client = this.getClient();
      if (OpenAICompatibleProvider.NO_MODELS_ENDPOINT.has(this.config.preset)) {
        // No /models endpoint — use a minimal chat completion instead
        await client.chat.completions.create({
          model: this.model,
          messages: [{ role: "user", content: "hi" }],
          max_tokens: 1,
        });
      } else {
        await client.models.list();
      }
      return true;
    } catch {
      return false;
    }
  }

  isAvailable(): boolean {
    if (this.config.preset === "ollama" || this.config.preset === "lmstudio") return this.available;
    return this.apiKey != null && this.available;
  }

  setAvailable(available: boolean): void {
    this.available = available;
  }
}
