import { describe, it, expect } from "vitest";
import { serialize, deserialize } from "../../src/session/session-serializer.js";
import { Session } from "../../src/session/session.js";
import { createEmptySession } from "../../src/session/session-state.js";

describe("SessionSerializer", () => {
  it("serialize produces valid JSON with version field", () => {
    const state = createEmptySession("/tmp/test");
    const session = new Session(state);
    const raw = serialize(session);

    const parsed = JSON.parse(raw);
    expect(parsed.version).toBe(1);
    expect(parsed.state.id).toBe(state.id);
    expect(parsed.state.messages).toEqual([]);
  });

  it("deserialize returns ok for valid input", () => {
    const state = createEmptySession("/tmp/test");
    const session = new Session(state);
    const raw = serialize(session);

    const result = deserialize(raw);
    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value.id).toBe(state.id);
      expect(result.value.workingDirectory).toBe("/tmp/test");
    }
  });

  it("deserialize returns err for invalid JSON", () => {
    const result = deserialize("not json {{{");
    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error.type).toBe("serialization_failed");
    }
  });

  it("deserialize returns err for missing required fields", () => {
    const result = deserialize(JSON.stringify({ version: 1, state: { messages: [] } }));
    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error.type).toBe("serialization_failed");
      expect(result.error.cause).toContain("id");
    }
  });

  it("deserialize handles unknown fields gracefully (preserves them)", () => {
    const state = createEmptySession("/tmp/test");
    const raw = JSON.stringify({
      version: 1,
      state: { ...state, customField: "preserved", anotherField: 42 },
    });

    const result = deserialize(raw);
    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      const value = result.value as Record<string, unknown>;
      expect(value.customField).toBe("preserved");
      expect(value.anotherField).toBe(42);
    }
  });

  it("deserialize defaults missing optional fields", () => {
    const raw = JSON.stringify({
      version: 1,
      state: {
        id: "test-id",
        createdAt: "2026-01-01T00:00:00.000Z",
        messages: [],
      },
    });

    const result = deserialize(raw);
    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value.title).toBe("New session");
      expect(result.value.status).toBe("active");
      expect(result.value.messageCount).toBe(0);
      expect(result.value.activeAgents).toEqual([]);
      expect(result.value.totalInputTokens).toBe(0);
      expect(result.value.totalCostUSD).toBe(0);
      expect(result.value.compressedSummary).toBeNull();
      expect(result.value.checkpointVersion).toBe(0);
    }
  });

  it("round-trip preserves session with messages", () => {
    const state = createEmptySession("/tmp/test");
    const session = new Session(state);
    session.addMessage({ role: "user", content: "hello" });
    session.addMessage({ role: "assistant", content: "hi there", agentId: "agent-1" });
    session.addTokenUsage("anthropic", 100, 50, 0.01);

    const raw = serialize(session);
    const result = deserialize(raw);
    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value.messages).toHaveLength(2);
      expect(result.value.messages[0]!.content).toBe("hello");
      expect(result.value.messages[1]!.agentId).toBe("agent-1");
      expect(result.value.totalInputTokens).toBe(100);
      expect(result.value.totalCostUSD).toBe(0.01);
    }
  });
});
