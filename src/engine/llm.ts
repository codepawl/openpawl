/**
 * Engine LLM adapter — bridges the mode execution interface with
 * the existing provider layer. Keeps all provider logic untouched.
 *
 * Two entry points:
 *   - callLLM()       — single-turn: prompt in, streamed text out
 *   - callLLMMultiTurn() — multi-turn with tool calls, loops until agent stops
 */

import { getGlobalProviderManager } from "../providers/provider-factory.js";
import { resolveModelForAgent } from "../core/model-config.js";

// ── Types ──────────────────────────────────────────────

export interface Message {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  toolCalls?: ToolCall[];
  toolCallId?: string;
}

export interface ToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface ToolDef {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface LLMCallOptions {
  model?: string;
  provider?: string;
  systemPrompt?: string;
  temperature?: number;
  signal?: AbortSignal;
  onChunk?: (text: string) => void;
}

export interface LLMResponse {
  text: string;
  toolCalls: ToolCall[];
  usage: { input: number; output: number };
}

export interface LLMMultiTurnOptions extends LLMCallOptions {
  tools?: ToolDef[];
  onToolCall?: (name: string, args: Record<string, unknown>) => void;
  onToolResult?: (name: string, result: string) => void;
  maxTurns?: number;
}

// ── Single-turn call ───────────────────────────────────

/**
 * Single LLM call. Streams text via onChunk callback.
 * Uses the existing ProviderManager for provider fallback.
 */
export async function callLLM(
  prompt: string,
  options?: LLMCallOptions,
): Promise<LLMResponse> {
  const mgr = getGlobalProviderManager();
  const model = options?.model ?? resolveModelForAgent("agent");

  const chunks: string[] = [];
  let usage = { input: 0, output: 0 };

  for await (const chunk of mgr.stream(prompt, {
    model: model || undefined,
    temperature: options?.temperature,
    systemPrompt: options?.systemPrompt,
    signal: options?.signal,
  })) {
    if (chunk.content) {
      chunks.push(chunk.content);
      options?.onChunk?.(chunk.content);
    }
    if (chunk.done && chunk.usage) {
      usage = {
        input: chunk.usage.promptTokens,
        output: chunk.usage.completionTokens,
      };
    }
  }

  return {
    text: chunks.join(""),
    toolCalls: [],
    usage,
  };
}

// ── Multi-turn with messages ───────────────────────────

/**
 * Send a full messages array (multi-turn context) to the LLM.
 * The provider layer is prompt-based, so we serialize messages
 * into a structured prompt format the model can follow.
 *
 * For tool use: tools are described in the system prompt and
 * the model returns tool calls as structured text blocks that
 * we parse. This keeps us on the existing provider layer.
 */
export async function callLLMWithMessages(
  messages: Message[],
  options?: LLMCallOptions & { tools?: ToolDef[] },
): Promise<LLMResponse> {
  const prompt = serializeMessages(messages);
  const systemParts: string[] = [];

  if (options?.systemPrompt) {
    systemParts.push(options.systemPrompt);
  }

  if (options?.tools && options.tools.length > 0) {
    systemParts.push(formatToolsPrompt(options.tools));
  }

  const response = await callLLM(prompt, {
    ...options,
    systemPrompt: systemParts.join("\n\n"),
  });

  // Parse tool calls from the response text
  const toolCalls = parseToolCalls(response.text);

  return { ...response, toolCalls };
}

/**
 * Multi-turn conversation loop. Calls the LLM, parses tool calls,
 * runs them via the provided handler, and continues until
 * the model stops calling tools or maxTurns is reached.
 */
export async function callLLMMultiTurn(opts: {
  model?: string;
  systemPrompt?: string;
  userMessage: string;
  tools?: ToolDef[];
  handleTool: (name: string, args: Record<string, unknown>) => Promise<string>;
  onChunk?: (text: string) => void;
  onToolCall?: (name: string, args: Record<string, unknown>) => void;
  onToolResult?: (name: string, result: string) => void;
  signal?: AbortSignal;
  maxTurns?: number;
  temperature?: number;
}): Promise<LLMResponse> {
  const maxTurns = opts.maxTurns ?? 20;
  const messages: Message[] = [
    { role: "user", content: opts.userMessage },
  ];

  const totalUsage = { input: 0, output: 0 };
  const allToolCalls: ToolCall[] = [];

  for (let turn = 0; turn < maxTurns; turn++) {
    if (opts.signal?.aborted) {
      return { text: "", toolCalls: allToolCalls, usage: totalUsage };
    }

    const response = await callLLMWithMessages(messages, {
      model: opts.model,
      systemPrompt: opts.systemPrompt,
      tools: opts.tools,
      onChunk: opts.onChunk,
      signal: opts.signal,
      temperature: opts.temperature,
    });

    totalUsage.input += response.usage.input;
    totalUsage.output += response.usage.output;

    if (response.toolCalls.length === 0) {
      // No tool calls → model is done
      return {
        text: response.text,
        toolCalls: allToolCalls,
        usage: totalUsage,
      };
    }

    // Add assistant message with tool calls
    messages.push({
      role: "assistant",
      content: response.text,
      toolCalls: response.toolCalls,
    });
    allToolCalls.push(...response.toolCalls);

    // Run each tool call
    for (const tc of response.toolCalls) {
      opts.onToolCall?.(tc.name, tc.input);

      const result = await opts.handleTool(tc.name, tc.input);
      opts.onToolResult?.(tc.name, result);

      messages.push({
        role: "tool",
        content: result,
        toolCallId: tc.id,
      });
    }
  }

  // Hit max turns — return last response
  return {
    text: messages[messages.length - 1]?.content ?? "",
    toolCalls: allToolCalls,
    usage: totalUsage,
  };
}

// ── Internal helpers ───────────────────────────────────

/**
 * Serialize a messages array into a single prompt string.
 * Models understand this format from training on chat transcripts.
 */
function serializeMessages(messages: Message[]): string {
  return messages
    .filter(m => m.role !== "system") // system is passed separately
    .map(m => {
      if (m.role === "tool") {
        return `[Tool Result${m.toolCallId ? ` (${m.toolCallId})` : ""}]\n${m.content}`;
      }
      const prefix = m.role === "user" ? "User" : "Assistant";
      return `${prefix}: ${m.content}`;
    })
    .join("\n\n");
}

/**
 * Format tool definitions into a system prompt section.
 */
function formatToolsPrompt(tools: ToolDef[]): string {
  const toolDescriptions = tools.map(t => {
    const params = JSON.stringify(t.parameters, null, 2);
    return `### ${t.name}\n${t.description}\nParameters:\n\`\`\`json\n${params}\n\`\`\``;
  }).join("\n\n");

  return `## Available Tools

You have access to the following tools. To use a tool, respond with a tool_call block:

\`\`\`tool_call
{"name": "tool_name", "input": {"param": "value"}}
\`\`\`

You can make multiple tool calls in a single response. After each tool call, you will receive the result and can continue.

When you are done and have no more tool calls to make, respond with your final answer as plain text (no tool_call blocks).

${toolDescriptions}`;
}

/**
 * Parse tool_call blocks from model response text.
 * Supports multiple formats:
 *   1. ```tool_call\n{"name": "...", "input": {...}}\n```
 *   2. ```json\n{"name": "tool_call", "input": {...}}\n```
 *   3. Raw JSON objects with "name" field matching known tools
 *   4. Ollama-style: {"name": "...", "parameters": {...}}
 */
function parseToolCalls(text: string): ToolCall[] {
  const calls: ToolCall[] = [];
  let callIndex = 0;

  // Pattern 1: ```tool_call\n{...}\n```
  for (const m of text.matchAll(/```(?:tool_call|json)\s*\n([\s\S]*?)```/g)) {
    const parsed = tryParseToolJson(m[1]!.trim());
    if (parsed) {
      calls.push({ id: `call_${Date.now()}_${callIndex++}`, ...parsed });
    }
  }

  // Pattern 2: standalone JSON objects with "name" field (Ollama output)
  // Only try this if no fenced blocks found
  if (calls.length === 0) {
    for (const m of text.matchAll(/\{[^{}]*"name"\s*:\s*"[^"]+?"[^{}]*\}/g)) {
      const parsed = tryParseToolJson(m[0]);
      if (parsed) {
        calls.push({ id: `call_${Date.now()}_${callIndex++}`, ...parsed });
      }
    }
  }

  return calls;
}

function tryParseToolJson(text: string): { name: string; input: Record<string, unknown> } | null {
  try {
    const parsed = JSON.parse(text);
    if (typeof parsed.name === "string" && parsed.name.length > 0) {
      // Support both "input" and "parameters"/"arguments" keys
      const input = parsed.input ?? parsed.parameters ?? parsed.arguments ?? {};
      return { name: parsed.name, input: typeof input === "object" ? input : {} };
    }
  } catch {
    // Not valid JSON
  }
  return null;
}
