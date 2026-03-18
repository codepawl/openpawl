import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

vi.mock("../src/core/logger.js", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), plain: vi.fn(), success: vi.fn() },
}));

// Mock Anthropic SDK
vi.mock("@anthropic-ai/sdk", () => {
  const mockStream = {
    async *[Symbol.asyncIterator]() {
      yield { type: "content_block_delta", delta: { type: "text_delta", text: "Hello" } };
      yield { type: "content_block_delta", delta: { type: "text_delta", text: " world" } };
      yield { type: "message_stop" };
    },
    finalMessage: {
      usage: { input_tokens: 10, output_tokens: 5 },
    },
  };

  return {
    default: class Anthropic {
      messages = {
        stream: vi.fn().mockReturnValue(mockStream),
      };
    },
  };
});

import { AnthropicProvider } from "../src/providers/anthropic-provider.js";
import type { StreamChunk } from "../src/client/types.js";

async function collectChunks(gen: AsyncGenerator<StreamChunk, void, undefined>): Promise<StreamChunk[]> {
  const result: StreamChunk[] = [];
  for await (const chunk of gen) result.push(chunk);
  return result;
}

describe("AnthropicProvider", () => {
  const originalEnv = process.env.ANTHROPIC_API_KEY;

  afterEach(() => {
    if (originalEnv !== undefined) {
      process.env.ANTHROPIC_API_KEY = originalEnv;
    } else {
      delete process.env.ANTHROPIC_API_KEY;
    }
  });

  it("isAvailable returns false when no key configured", () => {
    delete process.env.ANTHROPIC_API_KEY;
    const provider = new AnthropicProvider({});
    expect(provider.isAvailable()).toBe(false);
  });

  it("ANTHROPIC_API_KEY env var takes precedence over config", () => {
    process.env.ANTHROPIC_API_KEY = "sk-env-key";
    const provider = new AnthropicProvider({ apiKey: "sk-config-key" });
    expect(provider.isAvailable()).toBe(true);
  });

  it("isAvailable returns true when config key is set", () => {
    delete process.env.ANTHROPIC_API_KEY;
    const provider = new AnthropicProvider({ apiKey: "sk-ant-test" });
    expect(provider.isAvailable()).toBe(true);
  });

  it("maps prompt to Anthropic messages format", async () => {
    process.env.ANTHROPIC_API_KEY = "sk-test";
    const provider = new AnthropicProvider({});
    const chunks = await collectChunks(provider.stream("Hello"));
    expect(chunks.length).toBeGreaterThanOrEqual(2);
    expect(chunks[0]!.content).toBe("Hello");
    expect(chunks[0]!.done).toBe(false);
    expect(chunks[1]!.content).toBe(" world");
    expect(chunks[1]!.done).toBe(false);
  });

  it("yields done chunk with usage stats", async () => {
    process.env.ANTHROPIC_API_KEY = "sk-test";
    const provider = new AnthropicProvider({});
    const chunks = await collectChunks(provider.stream("Hello"));
    const lastChunk = chunks[chunks.length - 1]!;
    expect(lastChunk.done).toBe(true);
    expect(lastChunk.content).toBe("");
    expect(lastChunk.usage).toEqual({ promptTokens: 10, completionTokens: 5 });
  });

  it("healthCheck returns true when key present and last success recent", async () => {
    process.env.ANTHROPIC_API_KEY = "sk-test";
    const provider = new AnthropicProvider({});
    await collectChunks(provider.stream("test"));
    const healthy = await provider.healthCheck();
    expect(healthy).toBe(true);
  });
});
