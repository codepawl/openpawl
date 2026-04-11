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
import { compressContext, estimateTokens } from "../context/compressor.js";
import type { ChatMessage, NativeToolDefinition } from "../providers/stream-types.js";
import { profileStart, profileMeasure, isProfilingEnabled } from "../telemetry/profiler.js";

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
  /** Hook called before each LLM turn. Can mutate messages (e.g., for context compaction). */
  beforeTurn?: (messages: Message[], turn: number) => Promise<void>;
}

const NO_TOOLS_INSTRUCTION = "\n\nYou have no tools available. Do not emit tool calls, function calls, or XML tool blocks. Write all output as plain text or code blocks.";

// ── Single-turn call ───────────────────────────────────

/**
 * Single LLM call. Streams text via onChunk callback.
 * Uses the existing ProviderManager for provider fallback.
 */
export async function callLLM(
  prompt: string,
  options?: LLMCallOptions,
): Promise<LLMResponse> {
  const mgr = await getGlobalProviderManager();
  const model = options?.model ?? resolveModelForAgent("agent");

  // callLLM never has tools — always inject no-tools instruction
  const effectiveSystemPrompt = (options?.systemPrompt ?? "") + NO_TOOLS_INSTRUCTION;

  const chunks: string[] = [];
  let usage = { input: 0, output: 0 };

  const finishTotal = profileStart("llm_call_total", "callLLM");
  let finishTTFC: (() => void) | null = isProfilingEnabled() ? profileStart("llm_call_ttfc", "callLLM") : null;

  for await (const chunk of mgr.stream(prompt, {
    model: model || undefined,
    temperature: options?.temperature,
    systemPrompt: effectiveSystemPrompt,
    signal: options?.signal,
  })) {
    if (chunk.content) {
      if (finishTTFC) { finishTTFC(); finishTTFC = null; }
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
  finishTotal();

  const text = chunks.join("");
  // Estimate tokens if provider didn't return usage (e.g. ollama streaming)
  if (usage.input === 0 && usage.output === 0 && text.length > 0) {
    usage = {
      input: Math.ceil((prompt.length + (effectiveSystemPrompt?.length ?? 0)) / 4),
      output: Math.ceil(text.length / 4),
    };
  }

  return {
    text,
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
  options?: LLMCallOptions & { tools?: ToolDef[]; nativeTools?: NativeToolDefinition[]; maxContextTokens?: number },
): Promise<LLMResponse> {
  // Compress context if exceeding 70% of context window
  let workMessages = messages;
  const maxCtx = options?.maxContextTokens ?? 128_000;
  if (estimateTokens(workMessages) > maxCtx * 0.7 && workMessages.length > 6) {
    const result = await compressContext(
      workMessages,
      maxCtx,
      6,
      0.7,
      async (text) => {
        const resp = await callLLM(
          `Summarize this conversation concisely, preserving key decisions, code changes, file paths, and action items:\n\n${text}`,
          { ...options, onChunk: undefined, signal: undefined },
        );
        return resp.text;
      },
    );
    workMessages = result.messages;
  }

  const mgr = await getGlobalProviderManager();
  const model = options?.model ?? resolveModelForAgent("agent");

  // Convert internal Message[] to provider ChatMessage[]
  const chatMessages: ChatMessage[] = workMessages.map((m) => ({
    role: m.role,
    content: m.content,
    toolCalls: m.toolCalls?.map((tc) => ({
      id: tc.id,
      name: tc.name,
      arguments: JSON.stringify(tc.input),
    })),
    toolCallId: m.toolCallId,
  }));

  // When no tools are available, tell the LLM not to hallucinate tool calls
  const hasAnyTools = (options?.tools?.length ?? 0) > 0 || (options?.nativeTools?.length ?? 0) > 0;
  const effectiveSystemPrompt = !hasAnyTools
    ? (options?.systemPrompt ?? "") + NO_TOOLS_INSTRUCTION
    : options?.systemPrompt;

  // Stream with native messages + tools
  const nativeToolCount = options?.nativeTools?.length ?? 0;
  if (nativeToolCount > 0) {
    try {
      const fs = await import("node:fs");
      fs.writeFileSync("/tmp/openpawl-tools-debug.json", JSON.stringify({
        nativeToolCount,
        toolNames: options!.nativeTools!.map(t => t.function.name),
        messageCount: chatMessages.length,
        messageRoles: chatMessages.map(m => m.role),
      }, null, 2));
    } catch { /* ignore */ }
  }

  const chunks: string[] = [];
  let usage = { input: 0, output: 0 };
  let nativeToolCalls: Array<{ id: string; name: string; arguments: string }> | undefined;

  const finishTotal = profileStart("llm_call_total", "callLLMWithMessages", { messageCount: chatMessages.length });
  let finishTTFC: (() => void) | null = isProfilingEnabled() ? profileStart("llm_call_ttfc", "callLLMWithMessages") : null;

  for await (const chunk of mgr.stream("", {
    model: model || undefined,
    temperature: options?.temperature,
    systemPrompt: effectiveSystemPrompt,
    signal: options?.signal,
    messages: chatMessages,
    tools: options?.nativeTools,
  })) {
    if (chunk.content) {
      if (finishTTFC) { finishTTFC(); finishTTFC = null; }
      chunks.push(chunk.content);
      options?.onChunk?.(chunk.content);
    }
    if (chunk.toolCalls) {
      nativeToolCalls = chunk.toolCalls;
    }
    if (chunk.done && chunk.usage) {
      usage = {
        input: chunk.usage.promptTokens,
        output: chunk.usage.completionTokens,
      };
    }
  }
  finishTotal();

  const text = chunks.join("");

  // Estimate tokens if provider didn't return usage (e.g. ollama streaming)
  if (usage.input === 0 && usage.output === 0 && (text.length > 0 || chatMessages.length > 0)) {
    let inputChars = (effectiveSystemPrompt?.length ?? 0);
    for (const m of chatMessages) inputChars += (m.content?.length ?? 0);
    usage = {
      input: Math.ceil(inputChars / 4),
      output: Math.ceil(text.length / 4),
    };
  }

  // Prefer native tool calls from provider, fallback to text parsing
  let toolCalls: ToolCall[] = [];
  if (nativeToolCalls?.length) {
    toolCalls = nativeToolCalls.map((tc) => ({
      id: tc.id,
      name: tc.name,
      input: JSON.parse(tc.arguments || "{}"),
    }));
  } else if (text && hasAnyTools) {
    toolCalls = parseToolCalls(text);
  }

  return { text, toolCalls, usage };
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
  /** Native tool definitions (OpenAI function-calling format). Preferred over text-based tools. */
  nativeTools?: NativeToolDefinition[];
  handleTool: (name: string, args: Record<string, unknown>) => Promise<string>;
  onChunk?: (text: string) => void;
  onToolCall?: (name: string, args: Record<string, unknown>) => void;
  onToolResult?: (name: string, result: string) => void;
  signal?: AbortSignal;
  maxTurns?: number;
  temperature?: number;
  /** Prior conversation messages to include before the current user message. */
  priorMessages?: Message[];
  /** Hook called before each LLM turn. Can mutate messages (e.g., for context compaction). */
  beforeTurn?: (messages: Message[], turn: number) => Promise<void>;
}): Promise<LLMResponse> {
  const maxTurns = opts.maxTurns ?? 20;
  const messages: Message[] = [
    ...(opts.priorMessages ?? []),
    { role: "user", content: opts.userMessage },
  ];

  const totalUsage = { input: 0, output: 0 };
  const allToolCalls: ToolCall[] = [];

  for (let turn = 0; turn < maxTurns; turn++) {
    if (opts.signal?.aborted) {
      return { text: "", toolCalls: allToolCalls, usage: totalUsage };
    }

    // Allow callers to mutate messages before each turn (e.g., context compaction)
    if (opts.beforeTurn) {
      await opts.beforeTurn(messages, turn);
    }

    // Built-in compression: when no external beforeTurn hook is managing context,
    // compress old tool results if estimated tokens exceed threshold.
    // Uses a shallow copy — original messages array stays intact for tool loop state.
    let messagesForLLM = messages;
    if (!opts.beforeTurn && turn > 0 && estimateTokenCount(messages) > COMPRESS_TOKEN_THRESHOLD) {
      messagesForLLM = compressToolResults(messages, COMPRESS_KEEP_LAST);
    }

    const response = await callLLMWithMessages(messagesForLLM, {
      model: opts.model,
      systemPrompt: opts.systemPrompt,
      tools: opts.tools,
      nativeTools: opts.nativeTools,
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

    // Execute tool calls — run in parallel when multiple are returned
    // in a single LLM response (the model decided they're independent)
    const toolCalls = response.toolCalls;
    if (toolCalls.length === 1) {
      // Single tool call — run directly
      const tc = toolCalls[0]!;
      opts.onToolCall?.(tc.name, tc.input);
      const result = await profileMeasure("tool_execution", tc.name, () => opts.handleTool(tc.name, tc.input), toolMeta(tc.name, tc.input));
      opts.onToolResult?.(tc.name, result);
      messages.push({ role: "tool", content: result, toolCallId: tc.id });
    } else {
      // Multiple tool calls — execute in parallel, preserve order in messages
      for (const tc of toolCalls) opts.onToolCall?.(tc.name, tc.input);

      const results = await Promise.all(
        toolCalls.map((tc) =>
          profileMeasure("tool_execution", tc.name, () => opts.handleTool(tc.name, tc.input), toolMeta(tc.name, tc.input)),
        ),
      );

      for (let i = 0; i < toolCalls.length; i++) {
        const tc = toolCalls[i]!;
        opts.onToolResult?.(tc.name, results[i]!);
        messages.push({ role: "tool", content: results[i]!, toolCallId: tc.id });
      }
    }
  }

  // Hit max turns — return last response
  return {
    text: messages[messages.length - 1]?.content ?? "",
    toolCalls: allToolCalls,
    usage: totalUsage,
  };
}

// ── Multi-turn context compression ───────────────────────

/** Default token threshold before compressing old tool results. */
const COMPRESS_TOKEN_THRESHOLD = 30_000;
/** Number of recent messages to keep uncompressed. */
const COMPRESS_KEEP_LAST = 6;

/** Rough token estimate: ~4 chars per token. */
function estimateTokenCount(messages: Message[]): number {
  let chars = 0;
  for (const m of messages) chars += m.content.length;
  return Math.ceil(chars / 4);
}

/**
 * Rule-based compression of old tool results. Returns a new array where
 * tool messages older than the last `keepLast` have their content summarized.
 * The original messages array is NOT mutated.
 */
function compressToolResults(messages: Message[], keepLast: number): Message[] {
  const cutoff = messages.length - keepLast;
  if (cutoff <= 0) return messages;

  return messages.map((msg, i) => {
    if (i >= cutoff) return msg;
    if (msg.role !== "tool") return msg;
    if (msg.content.length <= 200) return msg;

    return { ...msg, content: summarizeToolResult(msg.content) };
  });
}

/** Compress a tool result to head + tail with omission note. */
function summarizeToolResult(content: string): string {
  const lines = content.split("\n");
  if (lines.length <= 8) {
    // Few lines but long — truncate by chars
    if (content.length <= 500) return content;
    return content.slice(0, 300) + `\n[...${content.length - 300} chars omitted...]`;
  }
  const head = lines.slice(0, 3).join("\n");
  const tail = lines.slice(-2).join("\n");
  return `${head}\n[...${lines.length - 5} lines omitted...]\n${tail}`;
}

// ── Helpers ───────────────────────────────────────────────

const REDACT_RE = /password|token|secret|key/i;

/** Build profiler metadata for tool calls, redacting sensitive shell commands. */
function toolMeta(name: string, input: Record<string, unknown>): Record<string, unknown> | undefined {
  if (name !== "shell_exec") return undefined;
  const raw = typeof input.command === "string" ? input.command : "";
  if (!raw) return undefined;
  const cmd = REDACT_RE.test(raw) ? "[REDACTED]" : raw.length > 200 ? raw.slice(0, 200) + "..." : raw;
  return { cmd };
}

// ── Internal helpers ───────────────────────────────────

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
