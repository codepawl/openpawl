/**
 * AWS Bedrock provider — IAM credentials + SigV4 signing.
 * Supports Anthropic Claude and Meta Llama models on Bedrock.
 */

import type { StreamChunk, StreamOptions } from "./stream-types.js";
import type { StreamProvider } from "./provider.js";
import { ProviderError } from "./types.js";
import { logger } from "../core/logger.js";

const DEFAULT_MODEL = "anthropic.claude-sonnet-4-6-v1:0";
const DEFAULT_REGION = "us-east-1";

export interface BedrockProviderConfig {
  accessKeyId?: string;
  secretAccessKey?: string;
  sessionToken?: string;
  region?: string;
  model?: string;
}

export class BedrockProvider implements StreamProvider {
  readonly name = "bedrock";
  private readonly accessKeyId: string | null;
  private readonly secretAccessKey: string | null;
  private readonly sessionToken: string | undefined;
  private readonly region: string;
  private readonly model: string;
  private available = true;
  private lastSuccessAt = 0;

  constructor(config: BedrockProviderConfig) {
    this.accessKeyId = config.accessKeyId ?? process.env.AWS_ACCESS_KEY_ID ?? null;
    this.secretAccessKey = config.secretAccessKey ?? process.env.AWS_SECRET_ACCESS_KEY ?? null;
    this.sessionToken = config.sessionToken ?? process.env.AWS_SESSION_TOKEN;
    this.region = config.region ?? process.env.AWS_REGION ?? DEFAULT_REGION;
    this.model = config.model ?? DEFAULT_MODEL;
  }

  private async getClient() {
    const { BedrockRuntimeClient } = await import("@aws-sdk/client-bedrock-runtime");
    const clientConfig: Record<string, unknown> = { region: this.region };
    if (this.accessKeyId && this.secretAccessKey) {
      clientConfig.credentials = {
        accessKeyId: this.accessKeyId,
        secretAccessKey: this.secretAccessKey,
        ...(this.sessionToken ? { sessionToken: this.sessionToken } : {}),
      };
    }
    return new BedrockRuntimeClient(clientConfig);
  }

  async *stream(prompt: string, options?: StreamOptions): AsyncGenerator<StreamChunk, void, undefined> {
    const model = options?.model ?? this.model;
    logger.debug(`[bedrock] streaming with model=${model} region=${this.region}`);

    const { InvokeModelWithResponseStreamCommand } = await import("@aws-sdk/client-bedrock-runtime");
    const client = await this.getClient();
    const isAnthropicModel = model.startsWith("anthropic.");

    const body = isAnthropicModel
      ? JSON.stringify({
          anthropic_version: "bedrock-2023-05-31",
          max_tokens: 4096,
          messages: [{ role: "user", content: prompt }],
          ...(options?.systemPrompt ? { system: options.systemPrompt } : {}),
          ...(options?.temperature != null ? { temperature: options.temperature } : {}),
        })
      : JSON.stringify({
          prompt: options?.systemPrompt ? `${options.systemPrompt}\n\n${prompt}` : prompt,
          max_gen_len: 4096,
          ...(options?.temperature != null ? { temperature: options.temperature } : {}),
        });

    try {
      const command = new InvokeModelWithResponseStreamCommand({
        modelId: model,
        contentType: "application/json",
        accept: "application/json",
        body: new TextEncoder().encode(body),
      });

      const response = await client.send(command);
      const decoder = new TextDecoder();

      if (response.body) {
        for await (const event of response.body) {
          if (event.chunk?.bytes) {
            const parsed = JSON.parse(decoder.decode(event.chunk.bytes)) as Record<string, unknown>;
            if (isAnthropicModel) {
              if (parsed.type === "content_block_delta") {
                const delta = parsed.delta as { text?: string };
                if (delta?.text) yield { content: delta.text, done: false };
              } else if (parsed.type === "message_stop") {
                yield { content: "", done: true };
              }
            } else {
              const generation = (parsed as { generation?: string }).generation;
              if (generation) yield { content: generation, done: false };
            }
          }
        }
      }
      yield { content: "", done: true };
      this.lastSuccessAt = Date.now();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const isAuth = message.includes("credentials") || message.includes("403") || message.includes("401");
      throw new ProviderError({
        provider: "bedrock",
        code: isAuth ? "BEDROCK_INVALID_CREDS" : "STREAM_FAILED",
        message: `Bedrock API error: ${message}`,
        isFallbackTrigger: isAuth,
        cause: err,
      });
    }
  }

  async healthCheck(): Promise<boolean> {
    if (!this.accessKeyId || !this.secretAccessKey) return false;
    if (this.lastSuccessAt > 0 && Date.now() - this.lastSuccessAt < 5 * 60 * 1000) return true;
    return true;
  }

  isAvailable(): boolean {
    return this.accessKeyId != null && this.secretAccessKey != null && this.available;
  }

  setAvailable(available: boolean): void {
    this.available = available;
  }
}
