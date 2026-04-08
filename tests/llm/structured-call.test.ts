import { describe, it, expect, vi, beforeEach } from "vitest";
import { z } from "zod";

/* ------------------------------------------------------------------ */
/*  Hoisted mocks                                                     */
/* ------------------------------------------------------------------ */

const mocks = vi.hoisted(() => {
  const mockCreate = vi.fn().mockResolvedValue({ name: "Alice", age: 30 });
  const mockClient = {
    chat: {
      completions: {
        create: mockCreate,
      },
    },
  };
  const mockCreateInstructorClient = vi.fn().mockReturnValue(mockClient);

  return {
    mockCreate,
    mockClient,
    mockCreateInstructorClient,
  };
});

vi.mock("@/llm/instructor-client.js", () => ({
  createInstructorClient: mocks.mockCreateInstructorClient,
}));

import { structuredCall } from "@/llm/structured-call.js";

/* ------------------------------------------------------------------ */
/*  Helpers                                                           */
/* ------------------------------------------------------------------ */

const testSchema = z.object({
  name: z.string(),
  age: z.number(),
});

const baseParams = {
  provider: { type: "anthropic" as const, apiKey: "test-key" },
  model: "claude-sonnet-4-6",
  messages: [{ role: "user" as const, content: "Extract name and age from: Alice is 30" }],
  schema: testSchema,
  schemaName: "PersonInfo",
};

/* ------------------------------------------------------------------ */
/*  Tests                                                             */
/* ------------------------------------------------------------------ */

describe("structuredCall", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("passes schema and messages to instructor client", async () => {
    await structuredCall(baseParams);

    expect(mocks.mockCreateInstructorClient).toHaveBeenCalledWith(baseParams.provider);
    expect(mocks.mockCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        model: "claude-sonnet-4-6",
        messages: [{ role: "user", content: "Extract name and age from: Alice is 30" }],
        response_model: { schema: testSchema, name: "PersonInfo" },
      }),
    );
  });

  it("prepends system prompt when provided", async () => {
    await structuredCall({
      ...baseParams,
      systemPrompt: "You are a data extractor.",
    });

    const callArgs = mocks.mockCreate.mock.calls[0]![0];
    expect(callArgs.messages[0]).toEqual({ role: "system", content: "You are a data extractor." });
    expect(callArgs.messages[1]).toEqual({ role: "user", content: "Extract name and age from: Alice is 30" });
  });

  it("uses max_retries for schema validation failures", async () => {
    await structuredCall({
      ...baseParams,
      maxRetries: 5,
    });

    const callArgs = mocks.mockCreate.mock.calls[0]![0];
    expect(callArgs.max_retries).toBe(5);
  });

  it("defaults max_retries to 3", async () => {
    await structuredCall(baseParams);

    const callArgs = mocks.mockCreate.mock.calls[0]![0];
    expect(callArgs.max_retries).toBe(3);
  });
});
