import Anthropic from "@anthropic-ai/sdk";
import type { StreamChunk, StreamOptions } from "./stream-types.js";
import type { StreamProvider } from "./provider.js";
import { ProviderError } from "./types.js";
import { logger } from "../core/logger.js";
import { recordPromptCacheHit, recordPromptCacheCreation } from "../token-opt/stats.js";
import { readGlobalConfig } from "../core/global-config.js";

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
  private readonly promptCachingEnabled: boolean;

  constructor(config: AnthropicProviderConfig) {
    this.apiKey = process.env.ANTHROPIC_API_KEY ?? config.apiKey ?? null;
    this.model = config.model ?? DEFAULT_MODEL;
    this.promptCachingEnabled = readGlobalConfig()?.tokenOptimization?.promptCaching ?? true;
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

    // Build messages: use native messages if provided, otherwise from prompt
    const messages: Anthropic.MessageParam[] = options?.messages
      ? options.messages
          .filter((m) => m.role !== "system")
          .map((m) => this.mapToAnthropicMessage(m))
      : [{ role: "user" as const, content: prompt }];

    const params: Anthropic.MessageCreateParams = {
      model: options?.model ?? this.model,
      max_tokens: 4096,
      messages,
    };

    // System prompt
    if (options?.systemPrompt) {
      if (this.promptCachingEnabled) {
        params.system = [
          { type: "text" as const, text: options.systemPrompt, cache_control: { type: "ephemeral" as const } },
        ];
      } else {
        params.system = [{ type: "text" as const, text: options.systemPrompt }];
      }
    }

    // Native tools (Anthropic format)
    if (options?.tools?.length) {
      params.tools = options.tools.map((t) => ({
        name: t.function.name,
        description: t.function.description,
        input_schema: t.function.parameters as Anthropic.Tool.InputSchema,
      }));
    }

    logger.debug(`[anthropic] streaming with model=${params.model}, tools=${options?.tools?.length ?? 0}`);

    try {
      const stream = client.messages.stream(params);
      const pendingToolCalls: Array<{ id: string; name: string; arguments: string }> = [];
      let currentToolInput = "";
      let currentToolId = "";
      let currentToolName = "";

      for await (const event of stream) {
        if (event.type === "content_block_start") {
          if (event.content_block.type === "tool_use") {
            currentToolId = event.content_block.id;
            currentToolName = event.content_block.name;
            currentToolInput = "";
          }
        } else if (event.type === "content_block_delta") {
          if (event.delta.type === "text_delta") {
            yield { content: event.delta.text, done: false };
          } else if (event.delta.type === "input_json_delta") {
            currentToolInput += event.delta.partial_json;
          }
        } else if (event.type === "content_block_stop") {
          if (currentToolId) {
            pendingToolCalls.push({
              id: currentToolId,
              name: currentToolName,
              arguments: currentToolInput,
            });
            currentToolId = "";
            currentToolName = "";
            currentToolInput = "";
          }
        } else if (event.type === "message_stop") {
          let usage: StreamChunk["usage"];
          try {
            const msg = await stream.finalMessage();
            if (msg?.usage) {
              const u = msg.usage as unknown as Record<string, number>;
              const cacheRead = u.cache_read_input_tokens ?? 0;
              const cacheCreation = u.cache_creation_input_tokens ?? 0;
              usage = {
                promptTokens: msg.usage.input_tokens,
                completionTokens: msg.usage.output_tokens,
                ...(cacheRead > 0 ? { cacheReadTokens: cacheRead } : {}),
                ...(cacheCreation > 0 ? { cacheCreationTokens: cacheCreation } : {}),
              };
              if (cacheRead > 0) recordPromptCacheHit(cacheRead);
              if (cacheCreation > 0) recordPromptCacheCreation(cacheCreation);
            }
          } catch { /* usage stats unavailable */ }

          const toolCalls = pendingToolCalls.length > 0 ? [...pendingToolCalls] : undefined;
          const finishReason = toolCalls ? "tool_calls" : "stop";
          yield { content: "", done: true, usage, toolCalls, finishReason };
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

  /** Map internal ChatMessage to Anthropic's message format. */
  private mapToAnthropicMessage(m: import("./stream-types.js").ChatMessage): Anthropic.MessageParam {
    if (m.role === "assistant" && m.toolCalls?.length) {
      const content: Anthropic.ContentBlockParam[] = [];
      if (m.content) content.push({ type: "text", text: m.content });
      for (const tc of m.toolCalls) {
        content.push({
          type: "tool_use",
          id: tc.id,
          name: tc.name,
          input: JSON.parse(tc.arguments || "{}"),
        });
      }
      return { role: "assistant", content };
    }
    if (m.role === "tool") {
      return {
        role: "user",
        content: [{
          type: "tool_result",
          tool_use_id: m.toolCallId ?? "",
          content: m.content ?? "",
        }],
      };
    }
    return { role: m.role as "user" | "assistant", content: m.content ?? "" };
  }

  async healthCheck(): Promise<boolean> {
    if (!this.apiKey) return false;
    if (this.lastSuccessAt > 0 && Date.now() - this.lastSuccessAt < HEALTH_WINDOW_MS) return true;
    try {
      const client = this.getClient();
      await client.models.list({ limit: 1 });
      return true;
    } catch {
      return false;
    }
  }

  isAvailable(): boolean {
    return this.apiKey != null && this.available;
  }

  setAvailable(available: boolean): void {
    this.available = available;
  }
}
