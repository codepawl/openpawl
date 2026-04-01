import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock the provider manager before importing the module under test
const mockStream = vi.fn();
vi.mock("@/providers/provider-factory.js", () => ({
  getGlobalProviderManager: () => ({
    stream: mockStream,
  }),
}));
vi.mock("@/core/model-config.js", () => ({
  resolveModelForAgent: () => "claude-sonnet-4-20250514",
}));

const { callLLM, callLLMWithMessages, callLLMMultiTurn } = await import(
  "@/engine/llm.js"
);

function makeChunks(text: string, done = true) {
  return (async function* () {
    yield { content: text, done, usage: done ? { promptTokens: 10, completionTokens: 20 } : undefined };
    if (!done) {
      yield { content: "", done: true, usage: { promptTokens: 10, completionTokens: 20 } };
    }
  })();
}

describe("callLLM", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("streams text and returns response", async () => {
    mockStream.mockReturnValue(makeChunks("Hello world"));

    const chunks: string[] = [];
    const result = await callLLM("Hi", {
      onChunk: (c: string) => chunks.push(c),
    });

    expect(result.text).toBe("Hello world");
    expect(result.toolCalls).toEqual([]);
    expect(result.usage).toEqual({ input: 10, output: 20 });
    expect(chunks).toEqual(["Hello world"]);
  });

  it("passes model and systemPrompt to provider", async () => {
    mockStream.mockReturnValue(makeChunks("ok"));

    await callLLM("test", {
      model: "gpt-4o",
      systemPrompt: "You are helpful",
      temperature: 0.5,
    });

    expect(mockStream).toHaveBeenCalledWith("test", expect.objectContaining({
      model: "gpt-4o",
      systemPrompt: "You are helpful",
      temperature: 0.5,
    }));
  });
});

describe("callLLMWithMessages", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("serializes messages into prompt", async () => {
    mockStream.mockReturnValue(makeChunks("The answer is 42"));

    const result = await callLLMWithMessages([
      { role: "user", content: "What is 6*7?" },
    ]);

    expect(result.text).toBe("The answer is 42");
    expect(mockStream).toHaveBeenCalledWith(
      expect.stringContaining("What is 6*7?"),
      expect.any(Object),
    );
  });

  it("parses tool calls from response", async () => {
    const responseWithTool = '```tool_call\n{"name": "read", "input": {"path": "src/foo.ts"}}\n```';
    mockStream.mockReturnValue(makeChunks(responseWithTool));

    const result = await callLLMWithMessages([
      { role: "user", content: "Read foo.ts" },
    ], { tools: [{ name: "read", description: "Read a file", parameters: { path: { type: "string" } } }] });

    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0].name).toBe("read");
    expect(result.toolCalls[0].input).toEqual({ path: "src/foo.ts" });
  });

  it("returns empty toolCalls when response has no tool blocks", async () => {
    mockStream.mockReturnValue(makeChunks("Just text, no tools"));

    const result = await callLLMWithMessages([
      { role: "user", content: "Hello" },
    ]);

    expect(result.toolCalls).toEqual([]);
  });
});

describe("callLLMMultiTurn", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("completes in single turn when no tool calls", async () => {
    mockStream.mockReturnValue(makeChunks("Done."));

    const result = await callLLMMultiTurn({
      userMessage: "What time is it?",
      handleTool: vi.fn(),
    });

    expect(result.text).toBe("Done.");
    expect(result.toolCalls).toEqual([]);
  });

  it("loops through tool calls until model is done", async () => {
    // Turn 1: model calls a tool
    mockStream.mockReturnValueOnce(
      makeChunks('Let me check.\n```tool_call\n{"name": "read", "input": {"path": "a.ts"}}\n```'),
    );
    // Turn 2: model responds with final answer
    mockStream.mockReturnValueOnce(
      makeChunks("The file contains a function."),
    );

    const handleTool = vi.fn().mockResolvedValue("function foo() {}");
    const onToolCall = vi.fn();
    const onToolResult = vi.fn();

    const result = await callLLMMultiTurn({
      userMessage: "What is in a.ts?",
      tools: [{ name: "read", description: "Read a file", parameters: {} }],
      handleTool,
      onToolCall,
      onToolResult,
    });

    expect(result.text).toBe("The file contains a function.");
    expect(result.toolCalls).toHaveLength(1);
    expect(handleTool).toHaveBeenCalledWith("read", { path: "a.ts" });
    expect(onToolCall).toHaveBeenCalledWith("read", { path: "a.ts" });
    expect(onToolResult).toHaveBeenCalledWith("read", "function foo() {}");
    expect(result.usage.input).toBe(20); // 10 + 10
    expect(result.usage.output).toBe(40); // 20 + 20
  });

  it("stops after maxTurns", async () => {
    // Always return tool calls
    mockStream.mockImplementation(() =>
      makeChunks('```tool_call\n{"name": "read", "input": {}}\n```'),
    );

    const result = await callLLMMultiTurn({
      userMessage: "infinite loop",
      handleTool: vi.fn().mockResolvedValue("result"),
      maxTurns: 3,
    });

    // Should have made 3 tool calls (one per turn)
    expect(result.toolCalls).toHaveLength(3);
  });

  it("respects abort signal", async () => {
    const controller = new AbortController();
    controller.abort();

    const result = await callLLMMultiTurn({
      userMessage: "test",
      handleTool: vi.fn(),
      signal: controller.signal,
    });

    expect(result.text).toBe("");
    expect(mockStream).not.toHaveBeenCalled();
  });
});
