import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../src/core/logger.js", () => ({
  logger: { debug: vi.fn(), warn: vi.fn(), info: vi.fn(), error: vi.fn() },
}));

vi.mock("@aws-sdk/client-bedrock-runtime", () => ({
  BedrockRuntimeClient: vi.fn().mockImplementation(() => ({
    send: vi.fn().mockResolvedValue({
      body: {
        [Symbol.asyncIterator]: async function* () {
          const encoder = new TextEncoder();
          yield { chunk: { bytes: encoder.encode(JSON.stringify({ type: "content_block_delta", delta: { type: "text_delta", text: "Hello" } })) } };
          yield { chunk: { bytes: encoder.encode(JSON.stringify({ type: "message_stop" })) } };
        },
      },
    }),
  })),
  InvokeModelWithResponseStreamCommand: vi.fn(),
}));

import { BedrockProvider } from "../../src/providers/bedrock-provider.js";

describe("BedrockProvider", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllEnvs();
  });

  it("constructs with explicit credentials", () => {
    const provider = new BedrockProvider({
      accessKeyId: "AKIATEST",
      secretAccessKey: "secret",
      region: "us-east-1",
      model: "anthropic.claude-sonnet-4-6-v1:0",
    });
    expect(provider.name).toBe("bedrock");
    expect(provider.isAvailable()).toBe(true);
  });

  it("constructs from env vars", () => {
    vi.stubEnv("AWS_ACCESS_KEY_ID", "AKIATEST");
    vi.stubEnv("AWS_SECRET_ACCESS_KEY", "secret");
    vi.stubEnv("AWS_REGION", "us-west-2");
    const provider = new BedrockProvider({});
    expect(provider.isAvailable()).toBe(true);
  });

  it("is unavailable without credentials", () => {
    const provider = new BedrockProvider({});
    expect(provider.isAvailable()).toBe(false);
  });

  it("health check returns false without credentials", async () => {
    const provider = new BedrockProvider({});
    expect(await provider.healthCheck()).toBe(false);
  });

  it("setAvailable toggles availability", () => {
    const provider = new BedrockProvider({
      accessKeyId: "AKIATEST",
      secretAccessKey: "secret",
    });
    expect(provider.isAvailable()).toBe(true);
    provider.setAvailable(false);
    expect(provider.isAvailable()).toBe(false);
    provider.setAvailable(true);
    expect(provider.isAvailable()).toBe(true);
  });

  it("streams anthropic model response", async () => {
    const provider = new BedrockProvider({
      accessKeyId: "AKIATEST",
      secretAccessKey: "secret",
    });
    const chunks: string[] = [];
    for await (const chunk of provider.stream("Hello")) {
      chunks.push(chunk.content);
    }
    expect(chunks).toContain("Hello");
  });
});
