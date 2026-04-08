import { describe, it, expect } from "bun:test";
import { compact, type CompactableMessage } from "../../src/context/compaction.js";
import { estimateMessageTokens } from "../../src/context/context-tracker.js";

/** Helper: create N user/assistant exchange pairs. */
function makeExchanges(n: number, contentLength = 20): CompactableMessage[] {
  const messages: CompactableMessage[] = [];
  for (let i = 0; i < n; i++) {
    messages.push({ role: "user", content: `User message ${i} ${"x".repeat(contentLength)}` });
    messages.push({ role: "assistant", content: `Assistant reply ${i} ${"y".repeat(contentLength)}` });
  }
  return messages;
}

/** Helper: create a tool result message. */
function toolMsg(content: string, toolName = "file_read"): CompactableMessage {
  return { role: "tool", content, metadata: { toolName } };
}

describe("compact()", () => {
  it("returns null for 'normal' level", async () => {
    const messages = makeExchanges(3);
    const result = await compact(messages, "normal");
    expect(result).toBeNull();
  });

  it("returns null for 'warning' level", async () => {
    const messages = makeExchanges(3);
    const result = await compact(messages, "warning");
    expect(result).toBeNull();
  });
});

describe("tool result masking (high)", () => {
  it("replaces old tool result content with placeholder", async () => {
    // 15 exchanges + tool results scattered in the old part
    const messages: CompactableMessage[] = [];
    // Old section: 12 exchanges with tool results
    for (let i = 0; i < 12; i++) {
      messages.push({ role: "user", content: `Question ${i}` });
      messages.push(toolMsg("A".repeat(200), "shell_exec"));
      messages.push({ role: "assistant", content: `Answer ${i}` });
    }
    // Recent section: 2 more exchanges
    for (let i = 12; i < 14; i++) {
      messages.push({ role: "user", content: `Question ${i}` });
      messages.push(toolMsg("B".repeat(200), "file_read"));
      messages.push({ role: "assistant", content: `Answer ${i}` });
    }

    const beforeTokens = estimateMessageTokens(messages);
    const result = await compact(messages, "high", { keepLastExchanges: 10 });

    expect(result).not.toBeNull();
    expect(result!.strategy).toBe("tool_mask");
    expect(result!.afterTokens).toBeLessThan(beforeTokens);

    // Old tool results should be masked
    const maskedTools = messages.filter(
      m => m.role === "tool" && m.content.includes("truncated"),
    );
    expect(maskedTools.length).toBeGreaterThan(0);

    // Masked messages should include tool name
    for (const m of maskedTools) {
      expect(m.content).toContain("shell_exec");
    }
  });

  it("does not mask short tool results (< 100 chars)", async () => {
    const messages: CompactableMessage[] = [
      ...makeExchanges(12),
      { role: "user", content: "old question" },
      toolMsg("short result", "grep"),  // < 100 chars
      { role: "assistant", content: "old answer" },
      ...makeExchanges(2), // recent
    ];

    // Insert the short tool msg before the recent exchanges
    // Actually let's restructure to ensure 10+ exchanges after the tool msg
    const msgs: CompactableMessage[] = [];
    msgs.push({ role: "user", content: "old" });
    msgs.push(toolMsg("short", "grep")); // < 100 chars
    msgs.push({ role: "assistant", content: "old reply" });
    for (let i = 0; i < 11; i++) {
      msgs.push({ role: "user", content: `recent ${i}` });
      msgs.push({ role: "assistant", content: `reply ${i}` });
    }

    await compact(msgs, "high", { keepLastExchanges: 10 });

    // The short tool result should NOT be masked
    const toolResult = msgs.find(m => m.role === "tool");
    expect(toolResult!.content).toBe("short");
  });

  it("preserves tool messages within last N exchanges", async () => {
    const msgs: CompactableMessage[] = [];
    for (let i = 0; i < 5; i++) {
      msgs.push({ role: "user", content: `q ${i}` });
      msgs.push(toolMsg("A".repeat(200), "file_read"));
      msgs.push({ role: "assistant", content: `a ${i}` });
    }

    await compact(msgs, "high", { keepLastExchanges: 10 });

    // All within last 10 exchanges — none should be masked
    const masked = msgs.filter(m => m.role === "tool" && m.content.includes("truncated"));
    expect(masked).toHaveLength(0);
  });
});

describe("pruning (critical)", () => {
  it("removes old tool messages", async () => {
    const msgs: CompactableMessage[] = [
      { role: "system", content: "You are a helpful assistant." },
    ];
    // Old exchanges with tools
    for (let i = 0; i < 12; i++) {
      msgs.push({ role: "user", content: `q${i}` });
      msgs.push(toolMsg("tool output " + "z".repeat(100)));
      msgs.push({ role: "assistant", content: `a${i}` });
    }
    // Recent exchanges
    for (let i = 12; i < 14; i++) {
      msgs.push({ role: "user", content: `q${i}` });
      msgs.push({ role: "assistant", content: `a${i}` });
    }

    const beforeCount = msgs.length;
    const result = await compact(msgs, "critical", { keepLastExchanges: 10 });

    expect(result).not.toBeNull();
    expect(result!.strategy).toBe("prune");
    expect(msgs.length).toBeLessThan(beforeCount);

    // System prompt at index 0 preserved
    expect(msgs[0]!.role).toBe("system");
    expect(msgs[0]!.content).toBe("You are a helpful assistant.");
  });

  it("keeps system prompt at index 0", async () => {
    const msgs: CompactableMessage[] = [
      { role: "system", content: "System prompt" },
      ...makeExchanges(15),
    ];

    await compact(msgs, "critical", { keepLastExchanges: 10 });

    expect(msgs[0]!.role).toBe("system");
    expect(msgs[0]!.content).toBe("System prompt");
  });

  it("truncates long user messages to 200 chars", async () => {
    const longContent = "x".repeat(600);
    const msgs: CompactableMessage[] = [
      { role: "user", content: longContent },
      { role: "assistant", content: "reply" },
      ...makeExchanges(11), // ensure the first exchange is outside last 10
    ];

    await compact(msgs, "critical", { keepLastExchanges: 10 });

    // The first user message should be truncated
    const firstUser = msgs.find(m => m.role === "user" && m.content.includes("[...truncated]"));
    expect(firstUser).toBeTruthy();
    expect(firstUser!.content.length).toBeLessThanOrEqual(220); // 200 + "[...truncated]"
  });

  it("truncates long assistant messages to 500 chars", async () => {
    const longContent = "y".repeat(1200);
    const msgs: CompactableMessage[] = [
      { role: "user", content: "question" },
      { role: "assistant", content: longContent },
      ...makeExchanges(11),
    ];

    await compact(msgs, "critical", { keepLastExchanges: 10 });

    const firstAssistant = msgs.find(m => m.role === "assistant" && m.content.includes("[...truncated]"));
    expect(firstAssistant).toBeTruthy();
    expect(firstAssistant!.content.length).toBeLessThanOrEqual(520); // 500 + "[...truncated]"
  });

  it("does not truncate short messages", async () => {
    const msgs: CompactableMessage[] = [
      { role: "user", content: "short question" },
      { role: "assistant", content: "short answer" },
      ...makeExchanges(11),
    ];

    await compact(msgs, "critical", { keepLastExchanges: 10 });

    // Short messages should be preserved
    const firstUser = msgs.find(m => m.content === "short question");
    expect(firstUser).toBeTruthy();
  });

  it("removes non-first system messages", async () => {
    const msgs: CompactableMessage[] = [
      { role: "system", content: "Original prompt" },
      { role: "user", content: "q1" },
      { role: "system", content: "Internal note" }, // should be removed
      { role: "assistant", content: "a1" },
      ...makeExchanges(11),
    ];

    await compact(msgs, "critical", { keepLastExchanges: 10 });

    const systemMsgs = msgs.filter(m => m.role === "system");
    expect(systemMsgs).toHaveLength(1);
    expect(systemMsgs[0]!.content).toBe("Original prompt");
  });
});

describe("LLM summarization (emergency)", () => {
  it("falls back to pruning when no callLLM provided", async () => {
    const msgs: CompactableMessage[] = makeExchanges(15);
    const result = await compact(msgs, "emergency");

    expect(result).not.toBeNull();
    expect(result!.strategy).toBe("prune"); // fallback
  });

  it("summarizes history when callLLM is provided", async () => {
    const msgs: CompactableMessage[] = makeExchanges(15);
    const originalLength = msgs.length;

    const result = await compact(msgs, "emergency", {
      callLLM: async (_prompt: string) => "Summary of conversation: discussed testing strategies.",
      emergencyKeepLast: 5,
    });

    expect(result).not.toBeNull();
    expect(result!.strategy).toBe("llm_summarize");
    expect(result!.messagesAffected).toBeGreaterThan(0);

    // First message should be the summary
    expect(msgs[0]!.role).toBe("system");
    expect(msgs[0]!.content).toContain("[Conversation Summary]");
    expect(msgs[0]!.content).toContain("discussed testing strategies");

    // Should be much shorter than original
    expect(msgs.length).toBeLessThan(originalLength);
  });

  it("keeps last N exchanges verbatim after summary", async () => {
    const msgs: CompactableMessage[] = makeExchanges(10);
    // Last exchange is "User message 9" / "Assistant reply 9"

    await compact(msgs, "emergency", {
      callLLM: async () => "Summary",
      emergencyKeepLast: 3,
    });

    // Should have: 1 summary + 3 user + 3 assistant = 7 messages
    // (3 exchanges = 6 messages + 1 summary)
    expect(msgs.length).toBe(7);

    // Last messages should be from the original tail
    const lastMsg = msgs[msgs.length - 1]!;
    expect(lastMsg.content).toContain("Assistant reply 9");
  });
});

describe("edge cases", () => {
  it("does not compact when fewer exchanges than keepLast", async () => {
    const msgs: CompactableMessage[] = makeExchanges(3);
    const beforeLength = msgs.length;

    const result = await compact(msgs, "high", { keepLastExchanges: 10 });

    expect(result).not.toBeNull();
    // No messages affected because cutoff is 0
    expect(result!.messagesAffected).toBe(0);
    expect(msgs.length).toBe(beforeLength);
  });

  it("each strategy reduces token count when there is content to compact", async () => {
    // Build a large message set with tool results
    const msgs: CompactableMessage[] = [];
    for (let i = 0; i < 20; i++) {
      msgs.push({ role: "user", content: `Question ${i} ${"q".repeat(100)}` });
      msgs.push(toolMsg("T".repeat(500), "shell_exec"));
      msgs.push({ role: "assistant", content: `Answer ${i} ${"a".repeat(100)}` });
    }

    const copy1 = structuredClone(msgs);
    const r1 = await compact(copy1, "high", { keepLastExchanges: 5 });
    expect(r1!.afterTokens).toBeLessThan(r1!.beforeTokens);

    const copy2 = structuredClone(msgs);
    const r2 = await compact(copy2, "critical", { keepLastExchanges: 5 });
    expect(r2!.afterTokens).toBeLessThan(r2!.beforeTokens);
  });
});
