/**
 * E2E Agent Behavior Tests — real API calls via OpenCode Go.
 * Auto-skips when no API key is configured.
 *
 * Run: OPENCODE_GO_API_KEY=... bun test tests/e2e/agent-behavior.test.ts
 */

import { describe, test, expect, beforeAll } from "bun:test";
import { OpenAICompatibleProvider } from "../../src/providers/openai-compatible-provider.js";
import { ToolRegistry } from "../../src/tools/registry.js";
import { registerBuiltInTools } from "../../src/tools/built-in/index.js";
import { buildIdentityPrefix } from "../../src/router/agent-registry.js";
import type { ChatMessage, NativeToolDefinition, StreamChunk } from "../../src/providers/stream-types.js";

// ── Auto-skip when no API key ─────────────────────────────

const API_KEY = process.env.OPENCODE_GO_API_KEY || process.env.OPENCODE_API_KEY;
const describeE2E = API_KEY ? describe : describe.skip;

// ── Helper ────────────────────────────────────────────────

async function callWithMessages(
  provider: OpenAICompatibleProvider,
  messages: ChatMessage[],
  tools: NativeToolDefinition[],
): Promise<{ text: string; toolCalls: Array<{ id: string; name: string; arguments: string }> }> {
  let text = "";
  let toolCalls: Array<{ id: string; name: string; arguments: string }> = [];

  for await (const chunk of provider.stream("", {
    messages,
    tools: tools.length > 0 ? tools : undefined,
    temperature: 0,
  })) {
    if (chunk.content) text += chunk.content;
    if (chunk.toolCalls) toolCalls = chunk.toolCalls;
  }

  return { text: text.trim(), toolCalls };
}

// ── Tests ─────────────────────────────────────────────────

describeE2E("Agent E2E Behavior (OpenCode Go)", () => {
  let provider: OpenAICompatibleProvider;
  let tools: NativeToolDefinition[];
  let readOnlyTools: NativeToolDefinition[];

  beforeAll(() => {
    provider = new OpenAICompatibleProvider({ preset: "opencode-go" });

    const registry = new ToolRegistry();
    registerBuiltInTools(registry);
    tools = registry.exportForAPI([
      "file_read", "file_list", "file_write", "file_edit",
      "shell_exec", "web_search", "web_fetch",
    ]);
    readOnlyTools = registry.exportForAPI([
      "file_read", "file_list", "web_search", "web_fetch",
    ]);
  });

  test("agent recalls user name from conversation history", async () => {
    const messages: ChatMessage[] = [
      { role: "system", content: buildIdentityPrefix("Assistant") },
      { role: "user", content: "My name is TestUser and I'm building a web app" },
      { role: "assistant", content: "Hello TestUser." },
      { role: "user", content: "What is my name?" },
    ];

    const response = await callWithMessages(provider, messages, []);

    expect(response.text.toLowerCase()).toContain("testuser");
    expect(response.text.length).toBeLessThan(200);
  }, 30_000);

  test("agent calls file_list when asked to list files", async () => {
    const messages: ChatMessage[] = [
      { role: "system", content: buildIdentityPrefix("Coder") },
      { role: "user", content: "List the files in the src/ directory" },
    ];

    const response = await callWithMessages(provider, messages, tools);

    expect(response.toolCalls.length).toBeGreaterThan(0);
    expect(response.toolCalls[0]!.name).toBe("file_list");
  }, 30_000);

  test("agent calls file_read when asked for specific lines", async () => {
    const messages: ChatMessage[] = [
      { role: "system", content: buildIdentityPrefix("Coder") },
      { role: "user", content: "Read lines 1 to 20 of src/cli.ts" },
    ];

    const response = await callWithMessages(provider, messages, tools);

    expect(response.toolCalls.length).toBeGreaterThan(0);
    expect(response.toolCalls[0]!.name).toBe("file_read");
    const args = JSON.parse(response.toolCalls[0]!.arguments);
    expect(args.path).toContain("cli.ts");
  }, 30_000);

  test("agent calls web_search for current information", async () => {
    const messages: ChatMessage[] = [
      { role: "system", content: buildIdentityPrefix("Researcher") },
      { role: "user", content: "Search for the latest Bun release version" },
    ];

    const response = await callWithMessages(provider, messages, tools);

    expect(response.toolCalls.length).toBeGreaterThan(0);
    expect(response.toolCalls.some(tc => tc.name === "web_search")).toBe(true);
  }, 30_000);

  test("agent in plan mode only requests read-only tools", async () => {
    const messages: ChatMessage[] = [
      { role: "system", content: buildIdentityPrefix("Coder") + "\nYou are in PLAN MODE. You only have read-only tools." },
      { role: "user", content: "Create a new file called test.txt with hello world" },
    ];

    const response = await callWithMessages(provider, messages, readOnlyTools);

    // Write tools aren't available, so agent can't call them
    if (response.toolCalls.length > 0) {
      const writeTools = response.toolCalls.filter(tc =>
        ["file_write", "file_edit", "shell_exec"].includes(tc.name),
      );
      expect(writeTools.length).toBe(0);
    }
  }, 30_000);

  test("agent responds tersely without emoji or suggestion bullets", async () => {
    const messages: ChatMessage[] = [
      { role: "system", content: buildIdentityPrefix("Assistant") },
      { role: "user", content: "What is 2 + 2?" },
    ];

    const response = await callWithMessages(provider, messages, []);

    const emojiRegex = /[\u{1F600}-\u{1F64F}\u{1F300}-\u{1F5FF}\u{1F680}-\u{1F6FF}\u{1F1E0}-\u{1F1FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}]/u;
    expect(emojiRegex.test(response.text)).toBe(false);
    expect(response.text).not.toContain("Would you like");
    expect(response.text).not.toContain("want me to");
    expect(response.text.length).toBeLessThan(100);
  }, 30_000);

  test("agent handles nonexistent file gracefully", async () => {
    const messages: ChatMessage[] = [
      { role: "system", content: buildIdentityPrefix("Coder") },
      { role: "user", content: "Read src/nonexistent-file-12345.ts" },
      { role: "assistant", content: "I'll read that file." },
      { role: "user", content: "[Tool result for file_read]: Error: File not found: src/nonexistent-file-12345.ts\n\nPlease respond to the user based on this result." },
    ];

    const response = await callWithMessages(provider, messages, []);

    expect(response.text.toLowerCase()).toMatch(/not found|doesn't exist|does not exist|no such file|cannot find/);
  }, 30_000);

  test("agent incorporates tool result into response", async () => {
    const fakeFileContent = "export function hello() { return 'world'; }";

    const messages: ChatMessage[] = [
      { role: "system", content: buildIdentityPrefix("Coder") },
      { role: "user", content: "What does the hello function return in src/test.ts?" },
      { role: "assistant", content: "I'll read the file." },
      { role: "user", content: `[Tool result for file_read src/test.ts]:\n${fakeFileContent}\n\nBased on this file content, answer my question.` },
    ];

    const response = await callWithMessages(provider, messages, []);

    expect(response.text.toLowerCase()).toContain("world");
  }, 30_000);

}, 60_000);
