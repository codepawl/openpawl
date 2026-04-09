/**
 * Shared streaming types used by all providers, cache interceptor, and proxy.
 * Extracted from client/types.ts so downstream code doesn't pull in client types.
 */

/** Message in the conversation history, used for multi-turn with native tool calling. */
export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  /** Tool calls the assistant wants to make (role: "assistant" only). */
  toolCalls?: Array<{ id: string; name: string; arguments: string }>;
  /** ID of the tool call this message is a result for (role: "tool" only). */
  toolCallId?: string;
}

/** Native tool definition in OpenAI function-calling format. */
export interface NativeToolDefinition {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export interface StreamOptions {
  /** Model to use for the completion */
  model?: string;
  /** Temperature (0-2) */
  temperature?: number;
  /** System prompt prepended to the conversation */
  systemPrompt?: string;
  /** AbortSignal to cancel the stream mid-flight */
  signal?: AbortSignal;
  /** Full conversation messages (multi-turn). If provided, prompt is ignored. */
  messages?: ChatMessage[];
  /** Native tool definitions for function calling. */
  tools?: NativeToolDefinition[];
}

export interface StreamChunk {
  /** Incremental text content from the model */
  content: string;
  /** True when this is the final chunk (stream finished) */
  done: boolean;
  /** Token usage stats, present only on the final chunk when reported */
  usage?: {
    promptTokens: number;
    completionTokens: number;
    /** Anthropic prompt caching: tokens read from cache (90% cheaper) */
    cacheReadTokens?: number;
    /** Anthropic prompt caching: tokens written to cache (1.25x cost) */
    cacheCreationTokens?: number;
  };
  /** Completed tool calls from native function calling (final chunk only). */
  toolCalls?: Array<{ id: string; name: string; arguments: string }>;
  /** Model's finish reason: "stop", "tool_calls", "length", etc. */
  finishReason?: string;
}
