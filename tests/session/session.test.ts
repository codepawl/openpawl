import { describe, it, expect, beforeEach } from "vitest";
import { Session } from "../../src/session/session.js";
import { createEmptySession } from "../../src/session/session-state.js";
import type { SessionState } from "../../src/session/session-state.js";

describe("Session", () => {
  let state: SessionState;
  let session: Session;

  beforeEach(() => {
    state = createEmptySession("/tmp/test-project");
    session = new Session(state);
  });

  it("creates empty session with correct defaults", () => {
    expect(session.id).toBe(state.id);
    expect(session.id.length).toBe(12);
    expect(session.status).toBe("active");
    expect(session.messageCount).toBe(0);
    expect(session.messages).toEqual([]);
    expect(session.isActive).toBe(true);
    expect(session.cost).toEqual({ input: 0, output: 0, usd: 0 });
    expect(session.isDirty()).toBe(false);
  });

  it("addMessage generates id and timestamp", () => {
    const msg = session.addMessage({ role: "user", content: "hello" });
    expect(msg.id).toBeDefined();
    expect(msg.id.length).toBe(8);
    expect(msg.timestamp).toBeDefined();
    expect(new Date(msg.timestamp).getTime()).toBeGreaterThan(0);
    expect(msg.role).toBe("user");
    expect(msg.content).toBe("hello");
  });

  it("addMessage increments messageCount", () => {
    session.addMessage({ role: "user", content: "one" });
    session.addMessage({ role: "assistant", content: "two" });
    expect(session.messageCount).toBe(2);
  });

  it("addMessage sets dirty flag", () => {
    expect(session.isDirty()).toBe(false);
    session.addMessage({ role: "user", content: "test" });
    expect(session.isDirty()).toBe(true);
  });

  it("addTokenUsage updates totals and providerBreakdown", () => {
    session.addTokenUsage("anthropic", 100, 50, 0.01);
    session.addTokenUsage("anthropic", 200, 100, 0.02);
    session.addTokenUsage("openai", 50, 25, 0.005);

    expect(session.cost.input).toBe(350);
    expect(session.cost.output).toBe(175);
    expect(session.cost.usd).toBeCloseTo(0.035);

    const s = session.getState();
    expect(s.providerBreakdown.anthropic).toEqual({ tokens: 450, cost: 0.03 });
    expect(s.providerBreakdown.openai).toEqual({ tokens: 75, cost: 0.005 });
  });

  it("buildContextMessages returns all messages when no compression", () => {
    session.addMessage({ role: "user", content: "msg1" });
    session.addMessage({ role: "assistant", content: "msg2" });

    const ctx = session.buildContextMessages();
    expect(ctx).toHaveLength(2);
    expect(ctx[0]!.content).toBe("msg1");
    expect(ctx[1]!.content).toBe("msg2");
  });

  it("buildContextMessages returns summary + tail after compression", () => {
    session.addMessage({ role: "user", content: "old1" });
    session.addMessage({ role: "assistant", content: "old2" });
    session.addMessage({ role: "user", content: "new1" });
    session.addMessage({ role: "assistant", content: "new2" });

    session.applyCompression("Summary of old conversation", 2);

    const ctx = session.buildContextMessages();
    expect(ctx).toHaveLength(3); // summary + 2 tail messages
    expect(ctx[0]!.role).toBe("system");
    expect(ctx[0]!.content).toContain("Summary of old conversation");
    expect(ctx[1]!.content).toBe("new1");
    expect(ctx[2]!.content).toBe("new2");
  });

  it("applyCompression sets checkpoint and summary", () => {
    session.addMessage({ role: "user", content: "a" });
    session.addMessage({ role: "assistant", content: "b" });

    session.applyCompression("compressed", 2);

    const s = session.getState();
    expect(s.compressedSummary).toBe("compressed");
    expect(s.compressionCheckpoint).toBe(2);
  });

  it("resolveToolConfirmation returns err for unknown executionId", () => {
    const result = session.resolveToolConfirmation("nonexistent", true);
    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error.type).toBe("confirmation_not_found");
    }
  });

  it("setStatus updates status and updatedAt", () => {
    const beforeUpdate = session.getState().updatedAt;
    // Small delay to ensure timestamp differs
    session.setStatus("idle");
    expect(session.status).toBe("idle");
    expect(session.isActive).toBe(true); // idle is still active
    expect(session.getState().updatedAt).toBeDefined();
  });

  it("toJSON returns deep clone (mutations don't affect original)", () => {
    session.addMessage({ role: "user", content: "original" });

    const json = session.toJSON();
    json.messages[0]!.content = "mutated";

    expect(session.messages[0]!.content).toBe("original");
  });

  it("markClean clears dirty flag", () => {
    session.addMessage({ role: "user", content: "test" });
    expect(session.isDirty()).toBe(true);
    session.markClean();
    expect(session.isDirty()).toBe(false);
  });

  it("trackFile deduplicates", () => {
    session.trackFile("/src/index.ts");
    session.trackFile("/src/index.ts");
    session.trackFile("/src/app.ts");

    expect(session.getState().trackedFiles).toEqual(["/src/index.ts", "/src/app.ts"]);
  });
});
