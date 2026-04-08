import { describe, it, expect } from "bun:test";
import { Session } from "../../src/session/session.js";
import type { SessionState } from "../../src/session/session-state.js";

function makeSession(id = "test"): Session {
  const state: SessionState = {
    id,
    title: "Test Session",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    status: "active",
    messages: [],
    messageCount: 0,
    activeAgents: [],
    agentStates: {},
    toolExecutions: [],
    pendingConfirmations: [],
    workingDirectory: "/tmp",
    trackedFiles: [],
    modifiedFiles: [],
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalCostUSD: 0,
    providerBreakdown: {},
    compressionCheckpoint: 0,
    compressedSummary: null,
  };
  return new Session(state);
}

describe("Conversation memory", () => {
  describe("Session message accumulation", () => {
    it("accumulates messages across multiple turns", () => {
      const session = makeSession();

      session.addMessage({ role: "user", content: "check my readme" });
      session.addMessage({ role: "assistant", content: "I'll read your README..." });
      session.addMessage({ role: "user", content: "can you remember what I asked?" });

      const messages = session.messages;
      expect(messages).toHaveLength(3);
      expect(messages[0]!.role).toBe("user");
      expect(messages[0]!.content).toBe("check my readme");
      expect(messages[1]!.role).toBe("assistant");
      expect(messages[2]!.role).toBe("user");
      expect(messages[2]!.content).toBe("can you remember what I asked?");
    });

    it("preserves message order", () => {
      const session = makeSession();

      session.addMessage({ role: "user", content: "first" });
      session.addMessage({ role: "assistant", content: "response to first" });
      session.addMessage({ role: "user", content: "second" });
      session.addMessage({ role: "assistant", content: "response to second" });
      session.addMessage({ role: "user", content: "third" });

      const messages = session.messages;
      expect(messages.map(m => m.content)).toEqual([
        "first", "response to first",
        "second", "response to second",
        "third",
      ]);
    });

    it("stores agentId on assistant messages", () => {
      const session = makeSession();

      session.addMessage({ role: "assistant", content: "hello", agentId: "researcher" });

      expect(session.messages[0]!.agentId).toBe("researcher");
    });
  });

  describe("buildContextMessages", () => {
    it("returns all messages when no compression", () => {
      const session = makeSession();

      session.addMessage({ role: "user", content: "msg1" });
      session.addMessage({ role: "assistant", content: "reply1" });
      session.addMessage({ role: "user", content: "msg2" });

      const context = session.buildContextMessages();
      expect(context).toHaveLength(3);
      expect(context[0]!.content).toBe("msg1");
      expect(context[2]!.content).toBe("msg2");
    });

    it("filters correctly for LLM dispatch (only user/assistant)", () => {
      const session = makeSession();

      session.addMessage({ role: "system", content: "internal note" });
      session.addMessage({ role: "user", content: "hello" });
      session.addMessage({ role: "assistant", content: "hi" });
      session.addMessage({ role: "tool", content: "tool output" });
      session.addMessage({ role: "user", content: "next" });

      // Simulate what prompt-router + llm-agent-runner do:
      const context = session.buildContextMessages();
      const sessionHistory = context
        .filter(m => m.role !== "system")
        .map(m => ({ role: m.role, content: m.content }));
      const forLLM = sessionHistory
        .filter(m => m.role === "user" || m.role === "assistant");

      expect(forLLM).toHaveLength(3);
      expect(forLLM[0]!.role).toBe("user");
      expect(forLLM[0]!.content).toBe("hello");
      expect(forLLM[1]!.role).toBe("assistant");
      expect(forLLM[2]!.role).toBe("user");
      expect(forLLM[2]!.content).toBe("next");
    });

    it("single-turn with history uses multi-turn (prior messages as separate turns)", () => {
      const session = makeSession();

      session.addMessage({ role: "user", content: "first question" });
      session.addMessage({ role: "assistant", content: "first answer" });

      // Simulate building priorMessages for callLLMMultiTurn
      const context = session.buildContextMessages();
      const priorMessages = context
        .filter(m => m.role === "user" || m.role === "assistant")
        .map(m => ({ role: m.role, content: m.content }));

      // Verify they are separate message objects, not concatenated text
      expect(priorMessages).toHaveLength(2);
      expect(priorMessages[0]).toEqual({ role: "user", content: "first question" });
      expect(priorMessages[1]).toEqual({ role: "assistant", content: "first answer" });

      // When passed to callLLMMultiTurn, they become:
      // [...priorMessages, { role: "user", content: currentPrompt }]
      const finalMessages = [
        ...priorMessages,
        { role: "user", content: "second question" },
      ];
      expect(finalMessages).toHaveLength(3);
      expect(finalMessages[0]!.role).toBe("user");
      expect(finalMessages[1]!.role).toBe("assistant");
      expect(finalMessages[2]!.role).toBe("user");
      expect(finalMessages[2]!.content).toBe("second question");
    });
  });

  describe("Session persistence", () => {
    it("session state includes messages for serialization", () => {
      const session = makeSession();

      session.addMessage({ role: "user", content: "hello" });
      session.addMessage({ role: "assistant", content: "hi there" });

      const state = session.getState();
      expect(state.messages).toHaveLength(2);
      expect(state.messageCount).toBe(2);
    });

    it("messages have timestamps and ids", () => {
      const session = makeSession();

      const msg = session.addMessage({ role: "user", content: "test" });

      expect(msg.id).toBeTruthy();
      expect(msg.timestamp).toBeTruthy();
    });
  });
});
